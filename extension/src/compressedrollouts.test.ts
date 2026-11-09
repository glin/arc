import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { test, vi } from 'vitest';
import {
  decodeCompressedRollout,
  isCompressedRollout,
  readCompressedFirstRecord,
  zstdFrames,
} from './compressedrollouts.ts';
import { tempDir } from './temproot.ts';

const encode = (zlib as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync;

test('a compressed rollout name ends in the lower-case suffix on every platform', () => {
  assert.equal(isCompressedRollout(path.join('sessions', 'rollout-a.jsonl.zst')), true);
  assert.equal(isCompressedRollout(path.join('sessions', 'rollout-a.JSONL.ZST')), false);
  assert.equal(isCompressedRollout(path.join('sessions', 'rollout-a.jsonl')), false);
  assert.equal(isCompressedRollout(path.join('sessions', 'rollout-a.zst')), false);
});

test.skipIf(!encode)('a corrupt zstd frame decodes as unreadable, not as a missing or changed file', async () => {
  const file = path.join(tempDir('compressed-corrupt'), 'rollout-a.jsonl.zst');
  const corrupt = Buffer.from(encode!(Buffer.from('{"type":"session_meta","payload":{}}\n'.repeat(1000))));
  for (let at = 8; at < corrupt.length - 4; at++) corrupt[at] ^= 0x5a;
  fs.writeFileSync(file, corrupt);
  assert.equal((await decodeCompressedRollout(file)).kind, 'failed');
});

test.skipIf(!encode)('the first record of a compressed rollout decodes alone, within its byte cap', async () => {
  const root = tempDir('compressed-first-record');
  const write = (name: string, bytes: Buffer) => {
    fs.writeFileSync(path.join(root, name), bytes);
    return path.join(root, name);
  };
  const opening = JSON.stringify({ type: 'session_meta', payload: { id: 'a', cwd: 'c:\\repo' } });
  const body = Buffer.from(`${opening}\r\n${'x'.repeat(4 * 1024 * 1024)}\n`);
  const rollout = write('rollout.jsonl.zst', encode!(body));
  assert.equal(await readCompressedFirstRecord(rollout, 1024), opening);
  assert.equal(await readCompressedFirstRecord(rollout, 10), null, 'a record past the cap was read');
  assert.equal(
    await readCompressedFirstRecord(write('one.jsonl.zst', encode!(Buffer.from(opening))), 1024),
    null,
    'an unterminated first record was read',
  );
  assert.equal(await readCompressedFirstRecord(write('empty.jsonl.zst', encode!(Buffer.alloc(0))), 1024), null);
  assert.equal(await readCompressedFirstRecord(write('plain.jsonl.zst', Buffer.from(`${opening}\n`)), 1024), null);
  await assert.rejects(readCompressedFirstRecord(path.join(root, 'missing.jsonl.zst'), 1024), { code: 'ENOENT' });
});

test.skipIf(!encode)('a first-record read that ends before a line break reports a failure', async () => {
  const root = tempDir('compressed-first-cut');
  const whole = Buffer.from(encode!(Buffer.from('{"type":"session_meta","payload":{"id":"a"}}\n'.repeat(200))));
  const file = path.join(root, 'cut.jsonl.zst');
  fs.writeFileSync(file, whole.subarray(0, 12));
  const report: { failed?: boolean } = {};
  assert.equal(await readCompressedFirstRecord(file, 1024, report), null);
  assert.equal(report.failed, true, 'a stream cut before its first line break reported no failure');
  const read: { failed?: boolean } = {};
  fs.writeFileSync(file, whole);
  assert.ok(await readCompressedFirstRecord(file, 1024, read));
  assert.equal(read.failed, undefined, 'a whole first record reported a failure');
});

test('a first-record read with no zstd decoder reports a failure', async () => {
  vi.resetModules();
  vi.doMock('node:zlib', async (load) => ({
    ...(await load<typeof zlib>()),
    createZstdDecompress: undefined,
  }));
  try {
    const { readCompressedFirstRecord: read } = await import('./compressedrollouts.ts');
    const report: { failed?: boolean } = {};
    assert.equal(await read('absent.jsonl.zst', 1024, report), null);
    assert.equal(report.failed, true, 'a read with no decoder reported no failure');
  } finally {
    vi.doUnmock('node:zlib');
    vi.resetModules();
  }
});

test.skipIf(!encode)('a zstd stream is complete only when it ends on a frame boundary', () => {
  const whole = Buffer.concat([encode!(Buffer.from('first\n')), encode!(Buffer.from('second\n'.repeat(1000)))]);
  const read = (bytes: Buffer, step: number) => {
    const frames = zstdFrames();
    for (let at = 0; at < bytes.length; at += step) frames.push(bytes.subarray(at, at + step));
    return frames.complete();
  };
  assert.equal(read(whole, whole.length), true);
  assert.equal(read(whole, 3), true, 'a header split across chunks broke the walk');
  assert.equal(read(whole.subarray(0, whole.length - 1), 7), false, 'a stream cut inside its last frame was complete');
  assert.equal(read(Buffer.alloc(0), 1), false);
  assert.equal(read(Buffer.from('not zstd'), 4), false);
});
