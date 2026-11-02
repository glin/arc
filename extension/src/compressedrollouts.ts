// Compressed Codex rollouts. Codex stores a finished rollout as one zstd stream named `.jsonl.zst`. This module alone
// opens such a file.
import * as fs from 'node:fs';
import type { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

const COMPRESSED_ROLLOUT_SUFFIX = '.jsonl.zst';
const READ_CHUNK = 64 * 1024;

// Codex writes the suffix in lower case. A name in any other case is not a compressed rollout on any platform.
export function isCompressedRollout(file: string): boolean {
  return file.endsWith(COMPRESSED_ROLLOUT_SUFFIX);
}

const zstd: { createZstdDecompress?: () => Transform; constants: typeof zlib.constants } = zlib;

// The zstd decoder of this Node.js, or null when Node.js has none.
export function createZstdDecoder(): Transform | null {
  return zstd.createZstdDecompress ? zstd.createZstdDecompress() : null;
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
  };
}

// Decode the first record of a compressed rollout, and stop the decode there. The answer is null when Node.js has no
// zstd decoder, when the stream does not decode, or when no line ends within `maxBytes` decoded bytes. A body without a
// line break answers its whole text. A file system refusal rejects.
export async function readCompressedFirstRecord(file: string, maxBytes: number): Promise<string | null> {
  const decoder = createZstdDecoder();
  if (!decoder) return null;
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
        line = length ? Buffer.concat(held).toString('utf8') : null;
      },
      { signal: stop.signal },
    );
  } catch (error) {
    if (line !== undefined) return line;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('ZSTD_')) return null;
    throw error;
  }
  return line ?? null;
}
