import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as vm from 'node:vm';
import { buildSync, transformSync } from 'esbuild';
import { callSources, declarationSource, sourceMatch, sourceDoesNotMatch } from '../test/source-contract.ts';
import type { FileHandle } from 'node:fs/promises';
import { UsageReading } from './agentwire';
import { tempDir } from './temproot';
import {
  UsageRecorder,
  usageRecordLines,
  USAGE_PAYLOAD_BYTES,
  USAGE_OVERHEAD_BYTES,
  USAGE_DAY_RAW_BYTES,
  type UsageSlotMetadata,
} from './usagerecord';

const READ_AT = 1_789_120_000_123;

function reading(over: Partial<UsageReading> = {}): UsageReading {
  return {
    plan: 'max',
    limits: [],
    complete: true,
    spend: null,
    creditResetsAtSeconds: null,
    readAt: READ_AT,
    ...over,
  };
}

test('Claude list and named-window readings keep every raw limit field', () => {
  const listed = JSON.parse(
    usageRecordLines(
      'claude',
      reading({
        limits: [
          {
            window: 'weekly_sonnet',
            group: 'weekly',
            scope: 'Sonnet',
            utilization: 0.071,
            resetsAtSeconds: 1_789_200_000,
            status: 'normal',
          },
        ],
      }),
    )[0],
  );
  const named = JSON.parse(
    usageRecordLines(
      'claude',
      reading({
        limits: [
          {
            window: 'five_hour',
            group: 'session',
            scope: '',
            utilization: 0.24,
            resetsAtSeconds: null,
            status: '',
          },
        ],
      }),
    )[0],
  );
  assert.deepEqual(listed, {
    v: 1,
    agent: 'claude',
    readAt: READ_AT,
    complete: true,
    plan: 'max',
    window: 'weekly_sonnet',
    group: 'weekly',
    scope: 'Sonnet',
    utilization: 0.071,
    resetsAt: 1_789_200_000,
    creditResetsAt: null,
    status: 'normal',
  });
  assert.equal(named.window, 'five_hour');
  assert.equal(named.utilization, 0.24);
  assert.equal(named.resetsAt, null);
});

test('a Codex reading writes one line for each reported window', () => {
  const lines = usageRecordLines(
    'codex',
    reading({
      plan: 'pro',
      limits: [
        { window: 'five_hour', group: 'session', scope: '', utilization: 0.03, resetsAtSeconds: 1, status: '' },
        { window: 'seven_day', group: 'weekly', scope: '', utilization: 0.01, resetsAtSeconds: 2, status: '' },
      ],
    }),
  ).map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => [line.agent, line.plan, line.window, line.utilization]),
    [
      ['codex', 'pro', 'five_hour', 0.03],
      ['codex', 'pro', 'seven_day', 0.01],
    ],
  );
});

test('a spend cap rides each window and can form a reading without windows', () => {
  const spend = {
    usedMinor: 1250,
    limitMinor: 5000,
    exponent: 2,
    currency: 'USD',
    utilization: 0.25,
  };
  const withWindow = JSON.parse(
    usageRecordLines(
      'claude',
      reading({
        limits: [
          {
            window: 'five_hour',
            group: 'session',
            scope: '',
            utilization: 0.4,
            resetsAtSeconds: 3,
            status: '',
          },
        ],
        spend,
      }),
    )[0],
  );
  const alone = JSON.parse(usageRecordLines('claude', reading({ spend }))[0]);
  assert.deepEqual(
    [withWindow.spendUsedMinor, withWindow.spendLimitMinor, withWindow.spendCurrency],
    [1250, 5000, 'USD'],
  );
  assert.equal(alone.window, '');
  assert.equal(alone.utilization, null);
  assert.equal(alone.spendUsedMinor, 1250);
  assert.deepEqual(usageRecordLines('claude', reading()), []);
});

test('a credit clock forms a raw reading without a limit or spend cap', () => {
  const lines = usageRecordLines(
    'claude',
    reading({
      complete: false,
      creditResetsAtSeconds: 1_789_200_000,
    }),
  );
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        v: 1,
        agent: 'claude',
        readAt: READ_AT,
        complete: false,
        plan: 'max',
        window: '',
        group: '',
        scope: '',
        utilization: null,
        resetsAt: null,
        creditResetsAt: 1_789_200_000,
        status: '',
      },
    ],
  );
});

function sample(at = READ_AT, utilization = 0.2): UsageReading {
  return reading({
    readAt: at,
    limits: [{ window: 'five_hour', group: 'session', scope: '', utilization, resetsAtSeconds: null, status: '' }],
  });
}

function slotFiles(root: string, at = READ_AT) {
  const day = Math.floor(at / 86_400_000);
  const slot = String(((day % 30) + 30) % 30).padStart(2, '0');
  return {
    day,
    slot,
    data: path.join(root, `${slot}.gz`),
    meta: path.join(root, `${slot}.json`),
    temporary: path.join(root, `${slot}.tmp`),
    lock: path.join(root, `${slot}.lock`),
  };
}

function metadata(root: string, at = READ_AT): UsageSlotMetadata {
  return JSON.parse(fs.readFileSync(slotFiles(root, at).meta, 'utf8'));
}

function physicalBytes(root: string): number {
  return fs.readdirSync(root).reduce((sum, name) => sum + fs.lstatSync(path.join(root, name)).size, 0);
}

async function populated(at = READ_AT) {
  const root = path.join(tempDir('bounded-usage-'), 'bounded-v1');
  const recorder = new UsageRecorder(root, { now: () => at });
  recorder.record('claude', sample(at));
  await recorder.drain();
  assert.ok(fs.existsSync(slotFiles(root, at).meta), 'the first admitted reading was not published');
  return { root, recorder };
}

function filesystemWithHandles(wrap: (handle: FileHandle, file: string) => FileHandle): typeof fs.promises {
  return {
    ...fs.promises,
    open: async (...args: Parameters<typeof fs.promises.open>) =>
      wrap(await fs.promises.open(...args), String(args[0])),
  };
}

test('bounded recording preserves raw fields, duplicates, reversals, and multibyte lines', async () => {
  const root = path.join(tempDir('bounded-usage-'), 'nested', 'bounded-v1');
  const recorder = new UsageRecorder(root, { now: () => READ_AT });
  const inputs = [
    sample(),
    sample(READ_AT - 1, 0.7),
    sample(READ_AT - 2),
    reading({ readAt: READ_AT, creditResetsAtSeconds: 9 }),
    reading({ spend: { usedMinor: 1, limitMinor: 2, exponent: 2, currency: 'USD', utilization: 0.5 } }),
    { ...sample(), plan: 'é日本' },
  ];
  for (const item of inputs) recorder.record('claude', item);
  await recorder.drain();
  const expected = inputs.flatMap((item) => usageRecordLines('claude', item)).join('\n') + '\n';
  const files = slotFiles(root);
  const raw = gunzipSync(fs.readFileSync(files.data));
  assert.equal(raw.toString(), expected);
  assert.equal(metadata(root).raw, Buffer.byteLength(expected));
  assert.equal(metadata(root).compressed, fs.statSync(files.data).size);
  assert.equal(fs.existsSync(files.lock), false);
  assert.ok(physicalBytes(root) <= USAGE_PAYLOAD_BYTES + USAGE_OVERHEAD_BYTES + 18);
});

test('serialization rejects excessive counts and strings before JSON allocation', () => {
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    for (const value of [
      sample(),
      { ...sample(), plan: 'x'.repeat(257) },
      { ...sample(), limits: Array(65).fill(sample().limits[0]) },
    ].slice(1))
      assert.deepEqual(usageRecordLines('claude', value), []);
    assert.equal(stringify.mock.calls.length, 0);
    assert.deepEqual(usageRecordLines('x'.repeat(257), sample()), []);
    assert.deepEqual(usageRecordLines('claude', { ...sample(), readAt: Infinity }), []);
  } finally {
    stringify.mockRestore();
  }
});

test('queued and in-flight raw bytes share one finite allowance and one drain', async () => {
  const root = path.join(tempDir('bounded-usage-'), 'bounded-v1');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batches: Buffer[] = [];
  const recorder = new UsageRecorder(root, {
    now: () => READ_AT,
    compress: async (raw) => {
      batches.push(raw);
      if (batches.length === 1) await hold;
      return gzipSync(raw);
    },
  });
  const value = {
    ...sample(),
    limits: Array.from({ length: 16 }, () => ({ ...sample().limits[0], status: 'x'.repeat(100) })),
  };
  recorder.record('claude', value);
  await vi.waitFor(() => assert.equal(batches.length, 1));
  for (let i = 0; i < 200; i++) recorder.record('claude', value);
  await Promise.resolve();
  assert.equal(batches.length, 1);
  release();
  await recorder.drain();
  assert.ok(batches.length > 1);
  assert.ok(batches.every((raw) => raw.length <= 64 * 1024));
  assert.ok(batches.reduce((sum, raw) => sum + raw.length, 0) <= 256 * 1024);
});

test('compression failures remain isolated and shutdown callbacks start no filesystem work', async () => {
  const root = path.join(tempDir('bounded-usage-'), 'bounded-v1');
  let reject!: (reason: Error) => void;
  const hold = new Promise<Buffer>((_resolve, fail) => {
    reject = fail;
  });
  let started = false;
  const recorder = new UsageRecorder(root, {
    now: () => READ_AT,
    compress: () => {
      started = true;
      return hold;
    },
  });
  recorder.record('claude', sample());
  await vi.waitFor(() => assert.equal(started, true));
  const closed = recorder.dispose();
  recorder.record('claude', sample());
  reject(new Error('compression failed'));
  await closed;
  assert.equal(fs.existsSync(root), false);
  let release!: (raw: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  const second = new UsageRecorder(root, { now: () => READ_AT, compress: () => pending });
  second.record('claude', sample());
  await Promise.resolve();
  const stopped = second.dispose();
  release(gzipSync(Buffer.from('unexpected\n')));
  await stopped;
  assert.equal(fs.existsSync(root), false);
});

for (const paused of [
  'lstat',
  'mkdir',
  'opendir',
  'directory.read',
  'entry-lstat',
  'directory.close',
  'readFile',
  'open',
  'format-write',
  'short-format-write',
]) {
  test(`disposal during unowned ${paused} starts no further filesystem work`, async () => {
    const root = path.join(tempDir('bounded-usage-'), 'bounded-v1');
    if (['directory.read', 'entry-lstat', 'readFile'].includes(paused)) {
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'format'), 'arc-usage-gzip-v1\n');
    }
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const operations: string[] = [];
    let settled = false;
    function observed<T extends object>(target: T, prefix = ''): T {
      return new Proxy(target, {
        get(object, key) {
          const value = Reflect.get(object, key, object);
          if (typeof value !== 'function') return value;
          if (key === Symbol.asyncIterator) return value.bind(object);
          return async (...args: unknown[]) => {
            const formatWrite = prefix === 'handle.' && key === 'write';
            const operation =
              formatWrite && ['format-write', 'short-format-write'].includes(paused)
                ? paused
                : key === 'lstat' && String(args[0]) === path.join(root, 'format')
                  ? 'entry-lstat'
                  : prefix + String(key);
            if (formatWrite && paused === 'short-format-write') args[2] = 1;
            operations.push(operation);
            let result: unknown;
            try {
              result = await Reflect.apply(value, object, args);
              if (prefix === 'handle.' && key === 'close')
                assert.equal(settled, false, 'the handle must close before disposal settles');
            } finally {
              if (operation === paused) {
                started();
                await hold;
              }
            }
            if (key === 'opendir') return observed(result as fs.Dir, 'directory.');
            if (key === 'open') return observed(result as FileHandle, 'handle.');
            return result;
          };
        },
      });
    }
    const recorder = new UsageRecorder(root, { now: () => READ_AT, filesystem: observed(fs.promises) });
    recorder.record('claude', sample());
    await pending;
    const stopped = recorder.dispose().then(() => {
      settled = true;
    });
    const previous = operations.length;
    await Promise.resolve();
    assert.equal(settled, false, 'disposal must await the pending operation');
    release();
    await stopped;
    const cleanup = ['opendir', 'directory.read', 'entry-lstat'].includes(paused)
      ? ['directory.close']
      : ['open', 'format-write', 'short-format-write'].includes(paused)
        ? ['handle.close']
        : [];
    assert.deepEqual(operations.slice(previous), cleanup);
    assert.equal(fs.existsSync(slotFiles(root).lock), false);
  });
}

test('short writes finish only the remaining suffix and account every intermediate byte', async () => {
  const root = path.join(tempDir('bounded-usage-'), 'bounded-v1');
  let maximum = 0;
  const filesystem = filesystemWithHandles(
    (handle, file) =>
      new Proxy(handle, {
        get(target, key) {
          if (key === 'write')
            return async (bytes: Buffer, offset: number, length: number, position: number) => {
              const result = await target.write(bytes, offset, Math.min(length, 7), position);
              maximum = Math.max(maximum, physicalBytes(root));
              const slot = slotFiles(root).slot;
              const overhead = ['json', 'tmp', 'lock'].reduce((sum, suffix) => {
                const p = path.join(root, `${slot}.${suffix}`);
                return sum + (fs.existsSync(p) ? fs.statSync(p).size : 0);
              }, 0);
              assert.ok(overhead <= USAGE_OVERHEAD_BYTES);
              if (file.endsWith('.gz')) assert.ok(fs.statSync(file).size <= USAGE_PAYLOAD_BYTES);
              return result;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  );
  const recorder = new UsageRecorder(root, { now: () => READ_AT, filesystem });
  recorder.record('claude', sample());
  await recorder.drain();
  assert.equal(
    gunzipSync(fs.readFileSync(slotFiles(root).data)).toString(),
    usageRecordLines('claude', sample()).join('\n') + '\n',
  );
  assert.ok(maximum > physicalBytes(root), 'metadata replacement never exposed its charged temporary bytes');
});

for (const failure of [
  'data-write',
  'data-sync',
  'data-close',
  'metadata-write',
  'metadata-sync',
  'metadata-close',
  'metadata-rename',
] as const) {
  test(`${failure} preserves the committed prefix and retains ownership`, async () => {
    const { root } = await populated();
    const prior = metadata(root);
    const files = slotFiles(root);
    const before = fs.readFileSync(files.data);
    const filesystem = filesystemWithHandles(
      (handle, file) =>
        new Proxy(handle, {
          get(target, key) {
            const selected =
              (file === files.data && failure.startsWith('data-')) ||
              (file === files.temporary && failure.startsWith('metadata-'));
            if (selected && key === failure.split('-')[1])
              return async (...args: unknown[]) => {
                if (key === 'write') {
                  await target.write(args[0] as Buffer, args[1] as number, 3, args[3] as number);
                  throw new Error(failure);
                }
                if (key === 'close') {
                  await target.close();
                  throw new Error(failure);
                }
                throw new Error(failure);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    );
    if (failure === 'metadata-rename')
      filesystem.rename = async () => {
        throw new Error(failure);
      };
    const recorder = new UsageRecorder(root, { now: () => READ_AT, filesystem });
    recorder.record('claude', sample(READ_AT, 0.9));
    await recorder.drain();
    assert.deepEqual(metadata(root), prior);
    assert.equal(fs.existsSync(files.lock), true);
    const after = fs.readFileSync(files.data);
    assert.deepEqual(after.subarray(0, prior.compressed), before);
    assert.ok(after.length > before.length);
    assert.ok(physicalBytes(root) <= USAGE_PAYLOAD_BYTES + USAGE_OVERHEAD_BYTES + 18);
    const other = new UsageRecorder(root, { now: () => READ_AT });
    other.record('claude', sample());
    await other.drain();
    assert.deepEqual(fs.readFileSync(files.data), after);
  });
}

for (const paused of ['inspection', 'write']) {
  test(`a pending owned ${paused} stays locked through terminal disposal`, async () => {
    const { root } = await populated();
    const files = slotFiles(root);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing = false;
    const filesystem = filesystemWithHandles(
      (handle, file) =>
        new Proxy(handle, {
          get(target, key) {
            if (paused === 'write' && file === files.data && key === 'write')
              return async (...args: Parameters<FileHandle['write']>) => {
                writing = true;
                await hold;
                return target.write(...args);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    );
    if (paused === 'inspection') {
      filesystem.opendir = async (...args: Parameters<typeof fs.promises.opendir>) => {
        const directory = await fs.promises.opendir(...args);
        if (fs.existsSync(files.lock)) {
          writing = true;
          await hold;
        }
        return directory;
      };
    }
    const recorder = new UsageRecorder(root, { now: () => READ_AT, filesystem });
    recorder.record('claude', sample(READ_AT, 0.8));
    await vi.waitFor(() => assert.equal(writing, true));
    let disposed = false;
    const done = recorder.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    assert.equal(disposed, false);
    assert.equal(fs.existsSync(files.lock), true);
    const other = new UsageRecorder(root, { now: () => READ_AT });
    other.record('claude', sample());
    await other.drain();
    assert.equal(fs.existsSync(files.lock), true);
    release();
    await done;
    assert.equal(disposed, true);
    assert.equal(fs.existsSync(files.lock), false);
  });
}

test('unpublished complete and torn members remain charged and prevent later append', async () => {
  for (const torn of [false, true]) {
    const { root } = await populated();
    const files = slotFiles(root);
    const prior = metadata(root);
    const member = gzipSync(Buffer.from(usageRecordLines('claude', sample(READ_AT, 0.9)).join('\n') + '\n'));
    fs.appendFileSync(files.data, torn ? member.subarray(0, member.length - 5) : member);
    const bytes = fs.readFileSync(files.data);
    const recorder = new UsageRecorder(root, { now: () => READ_AT });
    recorder.record('claude', sample());
    await recorder.drain();
    assert.deepEqual(fs.readFileSync(files.data), bytes);
    assert.deepEqual(metadata(root), prior);
    assert.equal(fs.existsSync(files.lock), true);
  }
});

test('future metadata, clock reversal, stale queued dates, and midnight preserve the right generation', async () => {
  const dayMs = 86_400_000;
  const { root } = await populated();
  const initial = metadata(root);
  const later = READ_AT + 30 * dayMs;
  const current = new UsageRecorder(root, { now: () => later });
  current.record('claude', sample(later));
  await current.drain();
  assert.equal(metadata(root).day, initial.day + 30);
  assert.notEqual(metadata(root).generation, initial.generation);
  const rotated = fs.readFileSync(slotFiles(root).data);
  const backward = new UsageRecorder(root, { now: () => READ_AT });
  backward.record('claude', sample());
  await backward.drain();
  assert.deepEqual(fs.readFileSync(slotFiles(root).data), rotated);
  let now = later;
  let release!: (raw: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  const queued = new UsageRecorder(root, { now: () => now, compress: () => pending });
  queued.record('claude', sample(later));
  await Promise.resolve();
  now += 30 * dayMs;
  release(gzipSync(Buffer.from('stale\n')));
  await queued.drain();
  assert.deepEqual(fs.readFileSync(slotFiles(root).data), rotated);
  const midnight = (Math.floor(READ_AT / dayMs) + 1) * dayMs;
  const boundary = new UsageRecorder(root, { now: () => midnight });
  boundary.record('claude', sample(midnight - 1));
  boundary.record('claude', sample(midnight));
  await boundary.drain();
  assert.equal(metadata(root, midnight).day, Math.floor(midnight / dayMs));
  assert.equal(metadata(root).day, initial.day + 30);
});

test('stale locks, unknown files, linked entries, oversized payloads, and raw caps refuse mutation', async () => {
  for (const problem of ['lock', 'unknown', 'link', 'oversized', 'raw-cap']) {
    const { root } = await populated();
    const files = slotFiles(root);
    if (problem === 'lock') {
      fs.writeFileSync(files.lock, '');
      fs.utimesSync(files.lock, new Date(0), new Date(0));
    }
    if (problem === 'unknown') fs.writeFileSync(path.join(root, 'unknown'), 'preserved');
    if (problem === 'link')
      fs.linkSync(files.data, path.join(root, `${String((Number(files.slot) + 1) % 30).padStart(2, '0')}.gz`));
    if (problem === 'oversized') fs.truncateSync(files.data, USAGE_PAYLOAD_BYTES + 1);
    if (problem === 'raw-cap')
      fs.writeFileSync(files.meta, JSON.stringify({ ...metadata(root), raw: USAGE_DAY_RAW_BYTES }));
    const before = fs.readFileSync(files.data);
    const bytes = physicalBytes(root);
    const recorder = new UsageRecorder(root, { now: () => READ_AT });
    recorder.record('claude', sample());
    await recorder.drain();
    assert.deepEqual(fs.readFileSync(files.data), before);
    assert.equal(physicalBytes(root), bytes);
  }
});

test('new recording leaves legacy evidence untouched beside an old unlocked writer', async () => {
  const parent = tempDir('bounded-legacy-');
  const legacy = path.join(parent, 'readings.jsonl');
  fs.writeFileSync(legacy, 'legacy\n');
  const recorder = new UsageRecorder(path.join(parent, 'bounded-v1'), { now: () => READ_AT });
  recorder.record('claude', sample());
  fs.appendFileSync(legacy, 'old-writer\n');
  await recorder.drain();
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy\nold-writer\n');
});

test('UTC epoch dates and the thirtieth-day boundary retain only expired generations', async () => {
  const { root } = await populated(-1);
  assert.equal(metadata(root, -1).day, -1);
  const epoch = new UsageRecorder(root, { now: () => 0 });
  epoch.record('claude', sample(0));
  await epoch.drain();
  assert.equal(metadata(root, 0).day, 0);
  const before = fs.readFileSync(slotFiles(root, -1).data);
  const lastRetained = new UsageRecorder(root, { now: () => 28 * 86_400_000 });
  lastRetained.record('claude', sample(-1));
  await lastRetained.drain();
  assert.ok(fs.statSync(slotFiles(root, -1).data).size > before.length);
  const firstExpired = new UsageRecorder(root, { now: () => 29 * 86_400_000 });
  firstExpired.record('claude', sample(-1));
  await firstExpired.drain();
  assert.equal(metadata(root, -1).day, -1);
  firstExpired.record('claude', sample(29 * 86_400_000));
  await firstExpired.drain();
  assert.equal(metadata(root, -1).day, 29);
});

test('linked directories and nonregular recognized entries refuse new recording', async () => {
  const parent = tempDir('bounded-links-');
  const target = path.join(parent, 'target');
  fs.mkdirSync(target);
  const linked = path.join(parent, 'bounded-v1');
  fs.symlinkSync(target, linked, 'junction');
  const throughLink = new UsageRecorder(linked, { now: () => READ_AT });
  throughLink.record('claude', sample());
  await throughLink.drain();
  assert.deepEqual(fs.readdirSync(target), []);
  const { root } = await populated();
  fs.mkdirSync(path.join(root, `${String((Number(slotFiles(root).slot) + 1) % 30).padStart(2, '0')}.gz`));
  const before = fs.readFileSync(slotFiles(root).data);
  const unsupported = new UsageRecorder(root, { now: () => READ_AT });
  unsupported.record('claude', sample());
  await unsupported.drain();
  assert.deepEqual(fs.readFileSync(slotFiles(root).data), before);
});

test('terminal extension shutdown closes recorder admission before draining workspace persistence', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  sourceMatch(source, /new UsageRecorder\(path.join\(arcHome\(\), 'usage', USAGE_STORE_DIRECTORY\)\)/);
  assert.ok(callSources(source, 'context.subscriptions.push').some((call) => /void recorder\.dispose\(\)/.test(call)));
  sourceMatch(source, /recorder.record\(agent, reading\)/);
  sourceDoesNotMatch(source, /appendUsageRecord/);
  const shutdown = transformSync(declarationSource(source, 'deactivate'), { loader: 'ts', format: 'cjs' }).code;
  const calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exports: { deactivate?: () => Promise<void> } = {};
  const module = { exports };
  vm.runInNewContext(shutdown, {
    module,
    exports,
    windowChannel: { dispose: () => Promise.resolve() },
    snapshotSetup: { dispose: () => Promise.resolve() },
    usageRecorder: {
      dispose: () => {
        calls.push('closed');
        return held;
      },
    },
    usageWrites: {
      drain: () => {
        calls.push('usage');
        return Promise.resolve();
      },
    },
    sessionSettingsWrites: {
      drain: () => {
        calls.push('settings');
        return Promise.resolve();
      },
    },
  });
  let settled = false;
  const result = module.exports.deactivate!().then(() => {
    settled = true;
  });
  assert.deepEqual(calls, ['closed', 'usage', 'settings']);
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await result;
});

test(
  'independent hosts serialize near-cap writes and keep different slots independent',
  { tags: ['subprocess'], timeout: 20_000 },
  async () => {
    const { root } = await populated();
    const script = path.join(tempDir('bounded-process-'), 'writer.cjs');
    buildSync({
      stdin: {
        contents: `const {UsageRecorder}=require(${JSON.stringify(path.join(__dirname, 'usagerecord.ts'))}); const fs=require('node:fs'); let release; const hold=new Promise(r=>release=r); process.on('message', async (message)=>{ if(message==='release'){release();return;} const {root,at,reading,pause}=message; const filesystem={...fs.promises,open:async(...args)=>{const handle=await fs.promises.open(...args); return new Proxy(handle,{get(target,key){ if(pause&&String(args[0]).endsWith('.gz')&&key==='write') return async(...values)=>{process.send('writing'); await hold; return target.write(...values);}; const value=Reflect.get(target,key,target); return typeof value==='function'?value.bind(target):value;}});}}; const recorder=new UsageRecorder(root,{now:()=>at,filesystem}); recorder.record('claude',reading); await recorder.drain(); process.send('done'); process.disconnect(); }); process.send('ready');`,
        resolveDir: __dirname,
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: script,
    });
    const files = slotFiles(root);
    const member = gzipSync(Buffer.from(usageRecordLines('claude', sample()).join('\n') + '\n'));
    let seed = randomBytes(USAGE_PAYLOAD_BYTES - member.length - 1400);
    let compressed = gzipSync(seed);
    const difference = USAGE_PAYLOAD_BYTES - Math.floor(member.length * 1.5) - compressed.length;
    seed = Buffer.concat([seed, randomBytes(Math.max(0, difference))]).subarray(0, seed.length + difference);
    compressed = gzipSync(seed);
    assert.ok(
      compressed.length + member.length <= USAGE_PAYLOAD_BYTES &&
        compressed.length + 2 * member.length > USAGE_PAYLOAD_BYTES,
    );
    fs.writeFileSync(files.data, compressed);
    fs.writeFileSync(
      files.meta,
      JSON.stringify({
        v: 1,
        day: files.day,
        generation: randomUUID(),
        compressed: compressed.length,
        raw: seed.length,
      }),
    );
    const runPair = async (times: number[], pause = false) => {
      const children = times.map(() => spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
      const states = children.map(() => ({ ready: false, writing: false, done: false }));
      const done = children.map(
        (child, index) =>
          new Promise<void>((resolve, reject) => {
            child.on('message', (message) => {
              if (message === 'ready') states[index].ready = true;
              if (message === 'writing') states[index].writing = true;
              if (message === 'done') states[index].done = true;
            });
            child.once('error', reject);
            child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
          }),
      );
      try {
        await vi.waitFor(() => assert.ok(states.every((state) => state.ready)), { timeout: 10_000 });
        if (pause) {
          children[0].send({ root, at: times[0], reading: sample(times[0]), pause: true });
          await vi.waitFor(() => assert.equal(states[0].writing, true));
          assert.ok(physicalBytes(root) <= USAGE_PAYLOAD_BYTES + USAGE_OVERHEAD_BYTES + 18);
          children[1].send({ root, at: times[1], reading: sample(times[1], 0.9), pause: true });
          await vi.waitFor(() => assert.ok(states[1].done || states[1].writing));
          assert.equal(states[1].writing, false, 'another host entered a slot whose owner is still writing');
          children[0].send('release');
        } else {
          for (let i = 0; i < children.length; i++) children[i].send({ root, at: times[i], reading: sample(times[i]) });
        }
        await Promise.all(done);
      } finally {
        for (const child of children)
          if (child.exitCode === null) {
            if (child.connected) child.send('release');
            child.kill();
          }
        await Promise.allSettled(done);
      }
    };
    await runPair([READ_AT, READ_AT], true);
    assert.equal(metadata(root).compressed, compressed.length + member.length);
    assert.ok(physicalBytes(root) <= USAGE_PAYLOAD_BYTES + USAGE_OVERHEAD_BYTES + 18);
    const full = fs.readFileSync(files.data);
    const clipped = new UsageRecorder(root, { now: () => READ_AT });
    clipped.record('claude', sample());
    await clipped.drain();
    assert.deepEqual(fs.readFileSync(files.data), full, 'the next whole member exceeded the remaining daily quota');
    await runPair([READ_AT + 86_400_000, READ_AT + 2 * 86_400_000]);
    assert.equal(
      metadata(root, READ_AT + 86_400_000).raw,
      Buffer.byteLength(usageRecordLines('claude', sample(READ_AT + 86_400_000)).join('\n') + '\n'),
    );
    assert.ok(metadata(root, READ_AT + 2 * 86_400_000).raw > 0);
  },
);
