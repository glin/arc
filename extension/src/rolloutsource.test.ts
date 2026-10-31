import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import os from 'node:os';
import { threadId } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { tempDir } from './temproot';
import {
  RolloutSources,
  cleanupRolloutDirectories,
  preferPlainRollouts,
  rolloutStem,
  rolloutThreadId,
} from './rolloutsource';

const codec = zlib as typeof zlib & { zstdCompressSync?: (bytes: Buffer) => Buffer };
function fixture(body = 'opening\n' + 'old line\n'.repeat(10000)) {
  const plain = path.join(tempDir('rollout-source-'), 'rollout-2026-10-29-aaaaaaaa-1111-2222-3333-444444444444.jsonl');
  fs.writeFileSync(plain, body);
  const file = plain + '.zst';
  fs.writeFileSync(file, codec.zstdCompressSync!(Buffer.from(body)));
  return { plain, file, body: Buffer.from(body) };
}

test.skipIf(!codec.zstdCompressSync)('the final oversized lease release removes its decoded disk file', async () => {
  const f = fixture('opening\n' + 'x'.repeat(1024 * 1024));
  const root = tempDir('oversized-cache-');
  const temporary = vi.spyOn(os, 'tmpdir').mockReturnValue(root);
  try {
    const sources = new RolloutSources({ budget: 16 });
    const first = sources.open(f.file);
    const directory = path.join(root, fs.readdirSync(root)[0]);
    assert.match(path.basename(directory), new RegExp(`^arc-rollouts-${process.pid}-${threadId}-[A-Za-z0-9]{6}$`));
    const file = path.join(directory, '1');
    const second = sources.open(f.file);
    const release = await sources.prepare(f.file);
    first.close();
    second.close();
    assert.equal(fs.statSync(file).size, f.body.length);
    release();
    assert.equal(fs.existsSync(file), false);
    release();
    const asyncRelease = await sources.prepare(f.file);
    assert.equal(fs.statSync(path.join(directory, '2')).size, f.body.length);
    asyncRelease();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    temporary.mockRestore();
  }
});

test.skipIf(!codec.zstdCompressSync)(
  'decoded source handoff survives readiness callbacks and concurrent leases',
  async () => {
    const f = fixture();
    const root = tempDir('handoff-cache-');
    const temporary = vi.spyOn(os, 'tmpdir').mockReturnValue(root);
    try {
      const sources = new RolloutSources({ budget: 16 });
      sources.onReady(() => sources.open(f.file).close());
      const releases = await Promise.all([sources.prepare(f.file), sources.prepare(f.file)]);
      const directory = path.join(root, fs.readdirSync(root)[0]);
      releases[0]();
      const reader = sources.open(f.file);
      assert.equal(reader.size, f.body.length);
      releases[1]();
      assert.deepEqual(fs.readdirSync(directory), ['1']);
      reader.close();
      assert.deepEqual(fs.readdirSync(directory), []);
    } finally {
      temporary.mockRestore();
    }
  },
);

test.skipIf(!codec.zstdCompressSync)('failed unlinks count toward the disk budget and retry on later reads', () => {
  const first = fixture('a'.repeat(16));
  const second = fixture('b'.repeat(16));
  const root = tempDir('retry-cache-');
  const temporary = vi.spyOn(os, 'tmpdir').mockReturnValue(root);
  const sources = new RolloutSources({ budget: 24 });
  const unlink = fs.unlinkSync;
  let failed: string | undefined;
  let blockAll = false;
  const attempts: string[] = [];
  const remove = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    attempts.push(String(file));
    if (blockAll || file === failed) throw Object.assign(new Error('Busy.'), { code: 'EBUSY' });
    unlink(file);
  });
  try {
    sources.open(first.file).close();
    const directory = path.join(root, fs.readdirSync(root)[0]);
    failed = path.join(directory, '1');
    const held = sources.open(second.file);
    assert.equal(fs.statSync(failed).size, 16);
    assert.equal(fs.statSync(path.join(directory, '2')).size, 16);
    held.close();
    assert.deepEqual(fs.readdirSync(directory), ['1'], 'failed removals must still consume the budget');
    const before = attempts.length;
    sources.open(first.plain).close();
    assert.ok(attempts.length - before <= 8, 'one read retried an unbounded number of failed removals');
    failed = undefined;
    sources.open(first.plain).close();
    assert.deepEqual(fs.readdirSync(directory), []);
    blockAll = true;
    const oversized = new RolloutSources({ budget: 0 });
    for (let index = 0; index < 12; index++) oversized.open(first.file).close();
    const retries = attempts.length;
    oversized.open(first.plain).close();
    assert.equal(attempts.length - retries, 8, 'one operation must retry only eight failed paths');
    const retainedDirectory = path.join(
      root,
      fs.readdirSync(root).find((name) => path.join(root, name) !== directory)!,
    );
    assert.equal(fs.readdirSync(retainedDirectory).length, 12);
    blockAll = false;
    oversized.open(first.plain).close();
    assert.equal(fs.readdirSync(retainedDirectory).length, 4);
    oversized.open(first.plain).close();
    assert.deepEqual(fs.readdirSync(retainedDirectory), []);
  } finally {
    remove.mockRestore();
    temporary.mockRestore();
  }
});

test('temporary recovery admits only exact rollout identities and definitively dead processes', async () => {
  const root = tempDir('recover-cache-');
  const directory = (name: string, child = '1') => {
    const result = path.join(root, name);
    fs.mkdirSync(result);
    fs.writeFileSync(path.join(result, child), 'decoded');
    return result;
  };
  const legacy = directory('arc-rollouts-101-Ab0xyZ');
  const current = directory('arc-rollouts-101-7-Ab0xyZ');
  const live = directory('arc-rollouts-102-7-Ab0xyZ');
  const denied = directory('arc-rollouts-103-Ab0xyZ');
  const uncertain = directory('arc-rollouts-104-Ab0xyZ');
  const malformed = directory('arc-rollouts-0101-Ab0xyZ');
  const suffix = directory('arc-rollouts-101-Ab0xyZ-extra');
  const malformedThread = directory('arc-rollouts-101-07-Ab0xyZ');
  const startup = directory('arc-startup-measure-101-Ab0xyZ');
  const unknown = directory('arc-rollouts-101-Qb0xyZ', 'notes');
  const nested = directory('arc-rollouts-101-Rb0xyZ');
  fs.mkdirSync(path.join(nested, '2'));
  const outside = directory('outside');
  const link = path.join(root, 'arc-rollouts-101-Sb0xyZ');
  fs.symlinkSync(outside, link, 'junction');
  const childLink = directory('arc-rollouts-101-Tb0xyZ');
  fs.symlinkSync(outside, path.join(childLink, '2'), 'junction');
  const kill = vi.fn<(pid: number, signal: 0) => void>((pid, signal) => {
    assert.equal(signal, 0);
    if (pid === 102) return;
    throw Object.assign(new Error('Process status.'), { code: pid === 103 ? 'EPERM' : pid === 104 ? 'EIO' : 'ESRCH' });
  });
  await cleanupRolloutDirectories(undefined, root, kill);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(current), false);
  for (const retained of [
    live,
    denied,
    uncertain,
    malformed,
    malformedThread,
    suffix,
    startup,
    unknown,
    nested,
    outside,
    link,
    childLink,
  ])
    assert.equal(fs.existsSync(retained), true, retained);
  assert.equal(fs.readFileSync(path.join(outside, '1'), 'utf8'), 'decoded');
  assert.equal(fs.existsSync(path.join(nested, '1')), true);
  assert.deepEqual([...new Set(kill.mock.calls.map(([pid]) => pid))].sort(), [101, 102, 103, 104]);
});

test('worker cleanup preserves every other thread, PID, and legacy directory', async () => {
  const root = tempDir('worker-cache-');
  const names = [
    'arc-rollouts-101-7-Ab0xyZ',
    'arc-rollouts-101-70-Ab0xyZ',
    'arc-rollouts-101-8-Ab0xyZ',
    'arc-rollouts-101-Ab0xyZ',
    'arc-rollouts-1010-7-Ab0xyZ',
  ];
  for (const name of names) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, '1'), 'decoded');
  }
  const kill = vi.fn<() => never>(() => {
    throw new Error('A known worker needs no process read.');
  });
  await cleanupRolloutDirectories({ pid: 101, thread: 7 }, root, kill);
  assert.equal(fs.existsSync(path.join(root, names[0])), false);
  for (const name of names.slice(1)) assert.equal(fs.existsSync(path.join(root, name, '1')), true);
  assert.equal(kill.mock.calls.length, 0);
});

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
