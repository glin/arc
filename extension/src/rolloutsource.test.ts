import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { tempDir } from './temproot';
import { RolloutSources, preferPlainRollouts, rolloutStem, rolloutThreadId } from './rolloutsource';

const codec = zlib as typeof zlib & { zstdCompressSync?: (bytes: Buffer) => Buffer };
function fixture(body = 'opening\n' + 'old line\n'.repeat(10000)) {
  const plain = path.join(tempDir('rollout-source-'), 'rollout-2026-10-29-aaaaaaaa-1111-2222-3333-444444444444.jsonl');
  fs.writeFileSync(plain, body);
  const file = plain + '.zst';
  fs.writeFileSync(file, codec.zstdCompressSync!(Buffer.from(body)));
  return { plain, file, body: Buffer.from(body) };
}

test.skipIf(!codec.zstdCompressSync)(
  'compressed byte offsets, tails and backward ranges match the plain source',
  () => {
    const f = fixture();
    const sources = new RolloutSources();
    for (const file of [f.plain, f.file]) {
      const source = sources.open(file);
      try {
        assert.equal(source.identity, file);
        assert.equal(source.size, f.body.length);
        for (const [offset, length] of [
          [0, 8],
          [37, 17],
          [f.body.length - 45, 45],
          [f.body.length - 90, 45],
          [f.body.length + 10, 10],
        ])
          assert.deepEqual(source.read(offset, length), f.body.subarray(offset, offset + length));
      } finally {
        source.close();
      }
    }
    assert.equal(rolloutStem(f.file), rolloutStem(f.plain));
    assert.equal(rolloutThreadId(f.file), 'aaaaaaaa-1111-2222-3333-444444444444');
    assert.deepEqual(
      preferPlainRollouts([f.file, f.plain], (file) => file),
      [f.plain],
    );
  },
);

test.skipIf(!codec.zstdCompressSync)(
  'host readers prepare oversized sources without synchronous decoding',
  async () => {
    const f = fixture();
    const sync = vi.fn<() => Buffer>(() => {
      throw new Error('synchronous decode');
    });
    const sources = new RolloutSources({ budget: 16, zstd: { ...zlib, zstdDecompressSync: sync } as any });
    sources.setLogger(() => {});
    assert.throws(() => sources.open(f.file), { code: 'EAGAIN' });
    const release = await sources.prepare(f.file);
    try {
      const source = sources.open(f.file);
      assert.deepEqual(source.read(0, 8), f.body.subarray(0, 8));
      source.close();
      assert.equal(sync.mock.calls.length, 0);
    } finally {
      release();
    }
  },
);

test.skipIf(!codec.zstdCompressSync)(
  'cache revisions reject same-size replacements with unchanged modification time',
  () => {
    const f = fixture();
    const sources = new RolloutSources();
    fs.utimesSync(f.file, 1000, 1000);
    const before = sources.open(f.file);
    assert.equal(before.read(0, 7).toString(), 'opening');
    before.close();
    const stat = fs.statSync(f.file);
    const replacement = f.file + '.replacement';
    const changed = Buffer.from(f.body);
    changed.write('changed');
    fs.writeFileSync(replacement, codec.zstdCompressSync!(changed));
    assert.equal(fs.statSync(replacement).size, stat.size);
    fs.utimesSync(replacement, stat.atime, stat.mtime);
    fs.renameSync(f.file, f.file + '.old');
    fs.renameSync(replacement, f.file);
    assert.equal(fs.statSync(f.file).mtimeMs, stat.mtimeMs);
    const after = sources.open(f.file);
    try {
      assert.equal(after.read(0, 7).toString(), 'changed');
    } finally {
      after.close();
    }
  },
);

test.skipIf(!codec.zstdCompressSync)(
  'opening reads stop at the first line and corrupt sources remain unreadable',
  async () => {
    const f = fixture();
    let bytes = 0;
    const sources = new RolloutSources({
      openingBytes: (count) => {
        bytes += count;
      },
    });
    assert.equal((await sources.opening(f.file)).toString(), 'opening\n');
    assert.ok(bytes >= 8 && bytes < f.body.length);
    fs.writeFileSync(f.file, 'corrupt');
    assert.throws(() => sources.open(f.file));
    await assert.rejects(sources.opening(f.file));
  },
);

test('a runtime without zstd skips compressed sources and logs the reason once', () => {
  const log = vi.fn<(message: string) => void>();
  const sources = new RolloutSources({ zstd: {}, log });
  assert.equal(sources.supported(), false);
  assert.equal(sources.supported(), false);
  assert.throws(() => sources.open('missing.jsonl.zst'), { code: 'ENOTSUP' });
  assert.equal(log.mock.calls.length, 1);
});

test.skipIf(!codec.zstdCompressSync)(
  'concurrent readers retain disk ranges within the streaming memory bound',
  async () => {
    const fixtures = Array.from({ length: 5 }, (_, index) =>
      fixture(`opening ${index}\n` + 'x'.repeat(2 * 1024 * 1024)),
    );
    let largestChunk = 0;
    let active = 0;
    let peak = 0;
    const decodes: string[] = [];
    const sources = new RolloutSources({
      asyncOnly: true,
      budget: 64 * 1024,
      zstd: {
        createZstdDecompress: (options) => {
          const decoder = (zlib as any).createZstdDecompress(options);
          active++;
          peak = Math.max(peak, active);
          decoder.once('close', () => active--);
          return decoder;
        },
      },
      decodedBytes: (bytes) => {
        largestChunk = Math.max(largestChunk, bytes);
      },
      decodeStarted: (file) => {
        decodes.push(file);
      },
    });
    const releases = await Promise.all(fixtures.map((f) => sources.prepare(f.file)));
    const readers = fixtures.map((f) => sources.open(f.file));
    try {
      assert.equal(decodes.length, fixtures.length);
      assert.equal(peak, 1, 'whole-file decoders must run one at a time');
      assert.equal(active, 0);
      assert.ok(largestChunk <= 64 * 1024, `decoded chunk retained ${largestChunk} bytes`);
      for (let index = 0; index < readers.length; index++) {
        const source = readers[index];
        assert.equal(fs.fstatSync(source.descriptor).isFile(), true);
        assert.equal(fs.fstatSync(source.descriptor).size, fixtures[index].body.length);
        assert.deepEqual(source.read(source.size - 32, 32), fixtures[index].body.subarray(-32));
      }
      const pending: unknown[] = [sources, ...readers];
      const seen = new Set<unknown>();
      let retained = 0;
      while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        if (Buffer.isBuffer(value)) retained += value.byteLength;
        else if (value instanceof Map || value instanceof Set) pending.push(...value.values());
        else pending.push(...Object.values(value));
      }
      assert.ok(retained <= 64 * 1024, `readers retained ${retained} decoded bytes`);
    } finally {
      readers.forEach((source) => source.close());
      releases.forEach((release) => release());
    }
  },
);

test.skipIf(!codec.zstdCompressSync).each(['host', 'parser'] as const)(
  'repeated corrupt archive reads leave no partial temporary files in the %s',
  async (reader) => {
    const f = fixture();
    const bytes = codec.zstdCompressSync!(randomBytes(512 * 1024));
    fs.writeFileSync(f.file, Buffer.concat([bytes, Buffer.from('corrupt trailing frame')]));
    const directories: string[] = [];
    const mkdir = fs.mkdtempSync;
    const spy = vi.spyOn(fs, 'mkdtempSync').mockImplementation((...args: Parameters<typeof mkdir>) => {
      const directory = mkdir(...args);
      directories.push(directory);
      return directory;
    });
    let decoded = 0;
    const sources = new RolloutSources({
      decodedBytes: (bytes) => {
        decoded += bytes;
      },
    });
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (reader === 'host') await assert.rejects(sources.prepare(f.file));
        else assert.throws(() => sources.open(f.file));
        assert.equal(directories.length, 1);
        assert.deepEqual(fs.readdirSync(directories[0]), [], 'failed reads must remove their decoded prefixes');
      }
      if (reader === 'host') assert.ok(decoded > 0, 'the corrupt archive must produce a partial body');
    } finally {
      spy.mockRestore();
    }
  },
);

test.skipIf(!codec.zstdCompressSync)('synchronous CLI and parser openings stop before the body', () => {
  const f = fixture('opening\n' + 'body\n'.repeat(100000));
  const source = new RolloutSources().open(f.file, true);
  try {
    assert.equal(source.read(0, f.body.length).toString(), 'opening\n');
    assert.equal(fs.fstatSync(source.descriptor).size, 8);
  } finally {
    source.close();
  }
});
