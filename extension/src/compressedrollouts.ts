// Compressed Codex rollouts. Codex stores a finished rollout as one zstd stream named `.jsonl.zst`. This module alone
// opens such a file.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { revisionOf } from './filerevision';
import { OversizedRecordReducer } from './oversizedrecord';
import type { BackwardRangeReader, FileRevision, TailRead } from './transcript';

const COMPRESSED_ROLLOUT_SUFFIX = '.jsonl.zst';
const READ_CHUNK = 64 * 1024;

// Codex writes the suffix in lower case. A name in any other case is not a compressed rollout on any platform.
export function isCompressedRollout(file: string): boolean {
  return file.endsWith(COMPRESSED_ROLLOUT_SUFFIX);
}

// The thread id at the end of `rollout-<ISO8601>-<uuid>.jsonl.zst`, the compressed twin of `ROLLOUT_NAME` in `codex.ts`.
export const COMPRESSED_ROLLOUT_NAME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl\.zst$/i;

// A file name that the rollout walk and the watcher list as a compressed rollout. The lowercase suffix test runs before
// the name pattern, so `X.JSONL.ZST` is no compressed rollout on any platform.
export function isCompressedRolloutName(name: string): boolean {
  return isCompressedRollout(name) && COMPRESSED_ROLLOUT_NAME.test(name);
}

const zstd: {
  createZstdDecompress?: (options?: { chunkSize?: number; params?: Record<number, number> }) => Transform;
  constants: typeof zlib.constants & { ZSTD_d_windowLogMax?: number };
} = zlib;

// The zstd decoder of this Node.js, or null when Node.js has none. `windowLog` bounds the decoder window, so a frame
// that needs a larger window fails to decode.
export function createZstdDecoder(windowLog?: number): Transform | null {
  if (!zstd.createZstdDecompress) return null;
  const param = zstd.constants.ZSTD_d_windowLogMax;
  return windowLog === undefined || param === undefined
    ? zstd.createZstdDecompress({ chunkSize: READ_CHUNK })
    : zstd.createZstdDecompress({ chunkSize: READ_CHUNK, params: { [param]: windowLog } });
}

let compressedDecodeAnnounce: (() => Promise<void>) | null = null;

// Set the announcement of each decoder. The worker posts each one to the host and waits for the acknowledgement, so a
// decoder never starts uncounted.
export function announceCompressedDecodes(announce: (() => Promise<void>) | null): void {
  compressedDecodeAnnounce = announce;
}

// A decoder for one rollout, after its announcement. Null when Node.js has no decoder.
async function announcedZstdDecoder(windowLog?: number): Promise<Transform | null> {
  if (!zstd.createZstdDecompress) return null;
  await compressedDecodeAnnounce?.();
  return createZstdDecoder(windowLog);
}

// True when this Node.js can decode a compressed rollout.
export function compressedRolloutsReadable(): boolean {
  return typeof zstd.createZstdDecompress === 'function';
}

// Read the frame and block headers of a zstd stream without decoding it. The Node decoder ends without an error on a
// stream cut off inside a frame, so a decode is complete only when the stream ends on a frame boundary.
export function zstdFrames() {
  const ZSTD_MAGIC = 0xfd2fb528;
  const SKIPPABLE_MAGIC = 0x184d2a50;
  let state: 'magic' | 'skippable' | 'descriptor' | 'header' | 'block' | 'invalid' = 'magic';
  let need = 4;
  let held = Buffer.alloc(0);
  let skip = 0;
  let checksum = 0;
  let frames = 0;
  // True while the last block of the newest frame still owes bytes.
  let ending = false;
  const take = (head: Buffer) => {
    if (state === 'magic') {
      const magic = head.readUInt32LE(0);
      if (magic === ZSTD_MAGIC) [state, need] = ['descriptor', 1];
      else if ((magic & 0xfffffff0) >>> 0 === SKIPPABLE_MAGIC) [state, need] = ['skippable', 4];
      else state = 'invalid';
    } else if (state === 'skippable') {
      [state, need, skip] = ['magic', 4, head.readUInt32LE(0)];
    } else if (state === 'descriptor') {
      const descriptor = head[0];
      const single = (descriptor >> 5) & 1;
      checksum = (descriptor >> 2) & 1 ? 4 : 0;
      const header = (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + [single ? 1 : 0, 2, 4, 8][descriptor >> 6];
      [state, need] = header ? ['header', header] : ['block', 3];
    } else if (state === 'header') {
      [state, need] = ['block', 3];
    } else {
      const block = head[0] | (head[1] << 8) | (head[2] << 16);
      const type = (block >> 1) & 3;
      if (type === 3) {
        state = 'invalid';
        return;
      }
      skip = type === 1 ? 1 : block >>> 3;
      if (block & 1) {
        skip += checksum;
        [state, need] = ['magic', 4];
        frames++;
        ending = skip > 0;
      }
    }
  };
  return {
    push(chunk: Buffer) {
      for (let at = 0; at < chunk.length;) {
        if (state === 'invalid') return;
        if (skip) {
          const step = Math.min(skip, chunk.length - at);
          skip -= step;
          at += step;
          if (!skip) ending = false;
          continue;
        }
        const step = Math.min(need - held.length, chunk.length - at);
        held = Buffer.concat([held, chunk.subarray(at, at + step)]);
        at += step;
        if (held.length === need) {
          const head = held;
          held = Buffer.alloc(0);
          take(head);
        }
      }
    },
    complete: () => state === 'magic' && !held.length && !skip && frames > 0,
    // The frames that ended so far.
    count: () => frames - (ending ? 1 : 0),
  };
}

// Decode the first record of a compressed rollout, and stop the decode there. The answer is null when Node.js has no
// zstd decoder, when the stream does not decode, or when no line ends within `maxBytes` decoded bytes. A body that ends
// before its first line break answers null, because its first record is not complete. `report.failed` marks no decoder,
// a stream that does not decode and a body that ends before its first line break. A file system refusal rejects.
export async function readCompressedFirstRecord(
  file: string,
  maxBytes: number,
  report?: { failed?: boolean },
): Promise<string | null> {
  const decoder = await announcedZstdDecoder();
  if (!decoder) {
    if (report) report.failed = true;
    return null;
  }
  const held: Buffer[] = [];
  let length = 0;
  let line: string | null | undefined;
  const stop = new AbortController();
  try {
    await pipeline(
      fs.createReadStream(file, { highWaterMark: READ_CHUNK }),
      decoder,
      async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) {
          const end = chunk.indexOf(0x0a);
          const part = end < 0 ? chunk : chunk.subarray(0, end);
          held.push(part);
          length += part.length;
          if (end >= 0 || length >= maxBytes) {
            line = end >= 0 && length <= maxBytes ? Buffer.concat(held).toString('utf8').replace(/\r$/, '') : null;
            stop.abort();
            return;
          }
        }
        if (report) report.failed = true;
        line = null;
      },
      { signal: stop.signal },
    );
  } catch (error) {
    if (line !== undefined) return line;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('ZSTD_')) {
      if (report) report.failed = true;
      return null;
    }
    throw error;
  }
  return line ?? null;
}

// The largest body that an open decodes. A larger body does not open.
export const COMPRESSED_BODY_BYTES = 512 * 1024 * 1024;
// A record above this many decoded bytes passes through `OversizedRecordReducer` as it decodes.
export const COMPRESSED_REDUCE_ABOVE = 1024 * 1024;
// A record that stays above this many bytes after reduction is skipped.
export const COMPRESSED_RECORD_BYTES = 16 * 1024 * 1024;
// The decoder window of an open is at most 8 MiB.
const DECODER_WINDOW_LOG = 23;
// The bytes at the start of a skipped record that name its type.
const RECORD_TYPE_BYTES = 512;

// The decoded body of one compressed rollout, held as 64 KiB chunks. `stat` is the physical revision of the
// `.jsonl.zst` file that the decode read, and `hash` is the SHA-256 of its bytes.
export interface CompressedBody {
  file: string;
  hash: string;
  stat: FileRevision;
  chunks: Buffer[];
  length: number;
  // Complete zstd frames in the file. A body is complete only when the file ends on a frame boundary.
  frames: number;
  complete: boolean;
  // Records dropped because they stayed above `COMPRESSED_RECORD_BYTES` after reduction.
  skippedRecords: number;
  // True when a skipped record held token usage, so a total read from this body counts less than the session.
  undercount: boolean;
}

export type CompressedBodyRead =
  | { kind: 'body'; body: CompressedBody }
  // `unsupported`: Node.js has no zstd decoder. `failed`: the file does not decode, or decodes past the cap.
  // `stale`: the file changed during the decode. `missing`: the file cannot be opened.
  | { kind: 'unsupported' | 'failed' | 'stale' | 'missing' | 'cancelled' };

export interface CompressedBodyLimits {
  bodyBytes?: number;
  reduceAbove?: number;
  recordBytes?: number;
  signal?: AbortSignal;
}

// Writes each record straight into the body chunks. A record that passes `reduceAbove` moves out of the chunks into
// the reducer, and the body continues from the record's start.
class BodyBuilder {
  readonly chunks: Buffer[] = [];
  length = 0;
  skippedRecords = 0;
  undercount = false;
  // The body offset where the current record starts, and the decoded bytes it has so far.
  private recordStart = 0;
  private recordBytes = 0;
  private head = Buffer.alloc(0);
  private reducer: OversizedRecordReducer | null = null;
  private skipping = false;

  constructor(
    private readonly reduceAbove: number,
    private readonly recordLimit: number,
  ) {}

  push(chunk: Buffer): void {
    for (let at = 0; at < chunk.length;) {
      const newline = chunk.indexOf(0x0a, at);
      const end = newline < 0 ? chunk.length : newline;
      this.part(chunk.subarray(at, end));
      if (newline < 0) return;
      this.close(true);
      at = newline + 1;
    }
  }

  finish(): void {
    if (this.recordBytes || this.skipping) this.close(false);
  }

  private part(bytes: Buffer): void {
    if (!bytes.length) return;
    if (this.head.length < RECORD_TYPE_BYTES)
      this.head = Buffer.concat([this.head, bytes.subarray(0, RECORD_TYPE_BYTES - this.head.length)]);
    this.recordBytes += bytes.length;
    if (this.skipping) return;
    if (!this.reducer && this.recordBytes > this.reduceAbove) {
      this.reducer = new OversizedRecordReducer();
      for (let at = this.recordStart; at < this.length;) {
        const offset = at % READ_CHUNK;
        const step = Math.min(READ_CHUNK - offset, this.length - at);
        this.reducer.push(this.chunks[Math.floor(at / READ_CHUNK)].subarray(offset, offset + step));
        at += step;
      }
      // The reducer copies what it keeps, so the record's bytes leave the chunks.
      this.length = this.recordStart;
      this.chunks.length = Math.ceil(this.length / READ_CHUNK);
    }
    if (this.reducer) {
      this.reducer.push(bytes);
      if (this.reducer.bytes > this.recordLimit) {
        this.reducer = null;
        this.skipping = true;
      }
    } else this.append(bytes);
  }

  private close(newline: boolean): void {
    if (this.skipping) {
      this.skippedRecords++;
      if (this.head.includes('"token_count"')) this.undercount = true;
    } else {
      if (this.reducer) this.append(this.reducer.finish().bytes);
      if (newline) this.append(NEWLINE);
    }
    this.recordStart = this.length;
    this.recordBytes = 0;
    this.head = Buffer.alloc(0);
    this.reducer = null;
    this.skipping = false;
  }

  private append(bytes: Buffer): void {
    for (let at = 0; at < bytes.length;) {
      const offset = this.length % READ_CHUNK;
      if (offset === 0) this.chunks.push(Buffer.allocUnsafe(READ_CHUNK));
      const step = Math.min(READ_CHUNK - offset, bytes.length - at);
      bytes.copy(this.chunks.at(-1)!, offset, at, at + step);
      at += step;
      this.length += step;
    }
  }
}

const NEWLINE = Buffer.from('\n');

class BodyCapError extends Error {}

// A physical revision. A filesystem read can leave the device and inode out.
type CompressedStat = Pick<FileRevision, 'size' | 'mtimeMs'> & Partial<Pick<FileRevision, 'dev' | 'ino'>>;

export function sameStat(left: CompressedStat | null, right: CompressedStat | null): boolean {
  return (
    !!left &&
    !!right &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

// The physical revision of a file from `fstat`, or null when it cannot be opened.
export function compressedStat(file: string): FileRevision | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    return revisionOf(fs.fstatSync(fd, { bigint: true }));
  } catch {
    return null;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

// The SHA-256 of a file and the revision it hashed, or null when the file cannot be read or changes during the read.
export async function hashCompressedRollout(
  file: string,
  signal?: AbortSignal,
): Promise<{ hash: string; stat: FileRevision } | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, 'r');
    const stat = revisionOf(await handle.stat({ bigint: true }));
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({
      highWaterMark: READ_CHUNK,
      autoClose: false,
      signal,
    })) {
      hash.update(chunk as Buffer);
    }
    if (!sameStat(stat, revisionOf(await handle.stat({ bigint: true })))) return null;
    return { hash: hash.digest('hex'), stat };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export type CompressedStreamRead =
  | { kind: 'decoded'; hash: string; stat: FileRevision; frames: number; complete: boolean }
  | { kind: 'unsupported' | 'failed' | 'stale' | 'missing' | 'cancelled' };

// Decode a compressed rollout and pass each decoded chunk to `consume`. One read of the file feeds the hash, the frame
// count and the decoder. A decode that ends inside a frame answers `complete` false. A consumer that throws
// `BodyCapError` ends the read as `failed`.
export async function streamCompressedRollout(
  file: string,
  consume: (chunk: Buffer) => void | Promise<void>,
  limits: { signal?: AbortSignal } = {},
): Promise<CompressedStreamRead> {
  const decoder = await announcedZstdDecoder(DECODER_WINDOW_LOG);
  if (!decoder) return { kind: 'unsupported' };
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    decoder.destroy();
    return { kind: 'missing' };
  }
  const hash = createHash('sha256');
  const frames = zstdFrames();
  try {
    const stat = revisionOf(await handle.stat({ bigint: true }));
    await pipeline(
      handle.createReadStream({ highWaterMark: READ_CHUNK, autoClose: false }),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          frames.push(chunk);
          yield chunk;
        }
      },
      decoder,
      async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) await consume(chunk);
      },
      { signal: limits.signal ?? new AbortController().signal },
    );
    if (!sameStat(stat, revisionOf(await handle.stat({ bigint: true })))) return { kind: 'stale' };
    return { kind: 'decoded', hash: hash.digest('hex'), stat, frames: frames.count(), complete: frames.complete() };
  } catch (error) {
    if (limits.signal?.aborted) return { kind: 'cancelled' };
    if (error instanceof BodyCapError) return { kind: 'failed' };
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('ZSTD_')) return { kind: 'failed' };
    return { kind: 'missing' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Decode a whole compressed rollout into memory.
export async function decodeCompressedRollout(
  file: string,
  limits: CompressedBodyLimits = {},
): Promise<CompressedBodyRead> {
  const cap = limits.bodyBytes ?? COMPRESSED_BODY_BYTES;
  const builder = new BodyBuilder(
    limits.reduceAbove ?? COMPRESSED_REDUCE_ABOVE,
    limits.recordBytes ?? COMPRESSED_RECORD_BYTES,
  );
  let decoded = 0;
  const read = await streamCompressedRollout(
    file,
    (chunk) => {
      decoded += chunk.length;
      if (decoded > cap) throw new BodyCapError();
      builder.push(chunk);
    },
    limits,
  );
  if (read.kind !== 'decoded') return read;
  builder.finish();
  return {
    kind: 'body',
    body: {
      file,
      hash: read.hash,
      stat: read.stat,
      chunks: builder.chunks,
      length: builder.length,
      frames: read.frames,
      complete: read.complete,
      skippedRecords: builder.skippedRecords,
      undercount: builder.undercount,
    },
  };
}

// Copy `length` bytes at `start` out of a body, or null when the range passes its end.
function bodyRange(body: CompressedBody, start: number, length: number): Buffer | null {
  if (start < 0 || length < 0 || start + length > body.length) return null;
  const out = Buffer.allocUnsafe(length);
  for (let at = 0; at < length;) {
    const offset = (start + at) % READ_CHUNK;
    const step = Math.min(READ_CHUNK - offset, length - at);
    body.chunks[Math.floor((start + at) / READ_CHUNK)].copy(out, at, offset, offset + step);
    at += step;
  }
  return out;
}

// The reads of the opening path over one decoded body. Every read takes `fstat` of the `.jsonl.zst` first. A range
// read answers null once the file no longer matches the file that the body decoded.
export interface CompressedByteSource {
  body: CompressedBody;
  // `dev`, `ino` and `mtimeMs` from `fstat` of the `.jsonl.zst`, and `size` equal to the held body length. The held
  // length equals the decoded length when no record is reduced or skipped.
  revision(file: string): FileRevision | null;
  readRange: BackwardRangeReader;
  // The first record of the body without its line break, or null when no line ends within 1 MiB.
  opening(): string | null;
  // `tailOf` over the body.
  tail(bytes: number, keepCursor?: boolean): TailRead;
}

export function compressedByteSource(body: CompressedBody): CompressedByteSource {
  const decodedRevision = (stat: FileRevision): FileRevision => ({
    ...stat,
    size: body.length,
  });
  const unchanged = (file: string): FileRevision | null => {
    if (file !== body.file) return null;
    const stat = compressedStat(file);
    return stat && sameStat(stat, body.stat) ? stat : null;
  };
  return {
    body,
    revision(file) {
      if (file !== body.file) return null;
      const stat = compressedStat(file);
      return stat && decodedRevision(stat);
    },
    readRange(file, start, length, revision) {
      const stat = unchanged(file);
      if (!stat || !sameStat(decodedRevision(stat), revision)) return null;
      return bodyRange(body, start, length);
    },
    opening() {
      const head = bodyRange(body, 0, Math.min(body.length, COMPRESSED_REDUCE_ABOVE))!;
      const newline = head.indexOf(0x0a);
      return newline < 0 ? null : head.subarray(0, newline).toString('utf8').replace(/\r$/, '');
    },
    tail(bytes, keepCursor = false) {
      const stat = unchanged(body.file);
      if (!stat) return { lines: [], whole: false, readBytes: 0 };
      const start = Math.max(0, body.length - bytes);
      const read = bodyRange(body, start, body.length - start)!;
      const lines = read.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      const firstNewline = read.indexOf(0x0a);
      const fragment = firstNewline < 0 ? read : read.subarray(0, firstNewline);
      return {
        lines,
        whole: start === 0,
        success: sameStat(compressedStat(body.file), body.stat),
        readBytes: read.length,
        offset: start === 0 ? 0 : start + (firstNewline < 0 ? read.length : firstNewline + 1),
        ...(keepCursor && start > 0
          ? {
              cursor: {
                revision: decodedRevision(stat),
                end: start,
                fragment: Buffer.from(fragment),
              },
            }
          : {}),
      };
    },
  };
}
