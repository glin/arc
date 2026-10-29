import os from 'node:os';
import * as zstd from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot';
import {
  DispatchReceipts,
  outsideDispatchStorage,
  safeDispatchPath,
  type DispatchEvent,
  type StandaloneOptions,
} from './dispatchreceipts';
import { HostedDispatch, type SavedDispatchResponse } from './dispatchhost';
import { payloadSha256 } from './sessionwrites';
import { openReadWindow, closeReadWindow } from './readmeter';
import type { NativeEvent } from './agentwire';
import { savedDispatchResponse, SESSION_READ_LIMITS } from './sessionreads';
import { revisionOf, type SessionFile } from './transcript';
import { ClaudeWire } from './claudewire';
import type { DispatchRelationshipAllowance, DispatchRelationshipStep } from './dispatchreceipts';

const origin = 'a'.repeat(24);
const session = 'aaaaaaaa-1111-2222-3333-444444444444';
const turn = 'bbbbbbbb-1111-2222-3333-444444444444';
const ending: Extract<NativeEvent, { kind: 'rootEnd' }> = {
  kind: 'rootEnd',
  provider: 'codex',
  sessionId: session,
  turnId: turn,
  generation: null,
  evidence: {},
  success: true,
};
const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function scratch(prefix: string) {
  const directory = tempDir(prefix);
  homes.push(directory);
  return directory;
}
function fixture(completion: 'manual' | 'wait' = 'manual', alias: string | null = null) {
  const home = scratch('arc-dispatch-');
  const receipts = new DispatchReceipts(home);
  const launch = receipts.reserve({
    origin,
    requester: { provider: 'codex', id: session },
    policy: null,
    promptSha256: payloadSha256('review'),
    completion,
    alias,
  });
  return { home, receipts, launch };
}
function report(receipts: DispatchReceipts, id: string, text = 'Report'): DispatchEvent {
  return receipts.publish(
    id,
    { outcome: 'succeeded', availability: 'available', nativeEnding: ending, askId: null },
    text,
  );
}
function settings(home: string, standalone: Partial<StandaloneOptions> = {}): StandaloneOptions {
  const provider = standalone.provider ?? 'codex';
  return {
    provider,
    command: provider,
    args: [],
    cwd: home,
    model: 'test',
    effort: 'high',
    name: 'test',
    agentRun: false,
    background: false,
    sessionHint: null,
    logAlias: path.join(home, 'live.log'),
    deadlineMs: 10_000,
    ...standalone,
  };
}
function standaloneFixture(standalone: Partial<StandaloneOptions> = {}) {
  const fx = fixture();
  const launch = fx.receipts.reserve({
    ...fx.launch,
    transport: 'standalone',
    standalone: settings(fx.home, standalone),
  });
  return { ...fx, standalone: launch };
}

function relationshipFixture(
  parentProvider: 'claude' | 'codex' = 'codex',
  childProvider: 'claude' | 'codex' = 'codex',
  agentRun = false,
  cwd?: string,
  compressed = false,
) {
  const fx = fixture();
  const launch = fx.receipts.reserve({
    ...fx.launch,
    transport: 'standalone',
    requester: { provider: parentProvider, id: session },
    standalone: settings(fx.home, { provider: childProvider, agentRun, ...(cwd ? { cwd } : {}) }),
  });
  const file = path.join(fx.home, 'native.jsonl' + (compressed ? '.zst' : ''));
  const opening = Buffer.from(JSON.stringify({ sessionId: turn, cwd: cwd ?? fx.home }) + '\n' + 'x'.repeat(2048));
  fs.writeFileSync(file, compressed ? (zstd as any).zstdCompressSync(opening) : opening);
  const stat = fs.statSync(file, { bigint: true });
  const directory = fs.statSync(fx.home, { bigint: true });
  fx.receipts.startup(launch.launchId, {
    file,
    identity: `${stat.dev}:${stat.ino}`,
    ancestor: fx.home,
    directory: `${directory.dev}:${directory.ino}`,
    cwd: fs.realpathSync.native(cwd ?? fx.home),
    bytes: opening.length,
    sha256: payloadSha256(opening.toString()),
  });
  fx.receipts.standaloneSession(launch.launchId, turn);
  const catalog: SessionFile[] = [
    { agent: parentProvider, sessionId: session, file: path.join(fx.home, 'parent.jsonl'), size: 0, mtimeMs: 0 },
    { agent: childProvider, sessionId: turn, file, ...revisionOf(stat) },
  ];
  return { ...fx, launch, catalog, file, opening };
}

function drainRelationships(
  scan: Generator<DispatchRelationshipStep, unknown, DispatchRelationshipAllowance>,
  bytes = 37,
  refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [],
) {
  const references: NonNullable<DispatchRelationshipStep['reference']>[] = [];
  const allowance = { bytes, entries: 1, checks: 1 };
  for (let steps = 0; steps < 100_000; steps++) {
    const next = scan.next(allowance);
    if (next.done) return references;
    assert.ok(next.value.bytes <= bytes && next.value.entries <= 1 && next.value.checks <= 1);
    if (next.value.reference) references.push(next.value.reference);
    if (next.value.refusal) refusals.push(next.value.refusal);
  }
  scan.return(undefined);
  return assert.fail('The bounded receipt scan did not finish.');
}

test.skipIf(!(zstd as any).zstdCompressSync).each([false, true])(
  'compressed child receipts retain delegated relationships after compression=%s',
  (repacked) => {
    const fx = relationshipFixture('codex', 'codex', false, undefined, !repacked);
    const compressed = repacked ? fx.file + '.zst' : fx.file;
    if (repacked) {
      fs.writeFileSync(compressed, (zstd as any).zstdCompressSync(fx.opening));
      fs.unlinkSync(fx.file);
      fx.catalog[1] = { ...fx.catalog[1], file: compressed };
    }
    const references = drainRelationships(fx.receipts.relationships(fx.catalog));
    assert.equal(references.length, 1);
    assert.equal(references[0].file, compressed);
    assert.equal(references[0].parentSessionId, session);
    assert.equal(references[0].owned, true);
  },
);

test.each(['claude', 'codex'] as const)('verified %s receipt links survive removal of launch cwd', (provider) => {
  const cwd = scratch('arc-dispatch-worker-');
  const fx = relationshipFixture('claude', provider, false, cwd);
  const linked = drainRelationships(fx.receipts.relationships(fx.catalog));
  assert.equal(linked.length, 1);
  fx.receipts.checkpointRelationships();
  fs.rmdirSync(cwd);
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), linked);
  const restarted = new DispatchReceipts(fx.home);
  assert.deepEqual(drainRelationships(restarted.relationships(fx.catalog)), linked);
});

test.skipIf(!(zstd as any).zstdCompressSync).each([false, true])(
  'verified child attribution survives compression with launch folder removed=%s',
  (removed) => {
    const cwd = scratch('arc-dispatch-worker-');
    const fx = relationshipFixture('claude', 'codex', false, cwd);
    const linked = drainRelationships(fx.receipts.relationships(fx.catalog));
    assert.equal(linked.length, 1);
    fx.receipts.checkpointRelationships();
    if (removed) fs.rmdirSync(cwd);
    const compressed = fx.file + '.zst';
    fs.writeFileSync(compressed, (zstd as any).zstdCompressSync(fx.opening));
    fs.unlinkSync(fx.file);
    fx.catalog[1] = { ...fx.catalog[1], file: compressed };
    const expected = linked.map((reference) => ({ ...reference, file: compressed }));
    assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), expected);
    assert.deepEqual(drainRelationships(new DispatchReceipts(fx.home).relationships(fx.catalog)), expected);
  },
);

test('concurrent verification publications preserve a retained receipt link during validation', () => {
  const cwd = scratch('arc-dispatch-worker-');
  const fx = relationshipFixture('claude', 'codex', false, cwd);
  const other = new DispatchReceipts(fx.home);
  const linked = drainRelationships(fx.receipts.relationships(fx.catalog));
  assert.equal(linked.length, 1);
  assert.deepEqual(drainRelationships(other.relationships(fx.catalog)), linked);
  const cache = path.join(fx.home, 'cache', 'dispatch-relationships', `${fx.launch.launchId}.json`);
  const scan = new DispatchReceipts(fx.home).relationship(fx.launch.launchId, fx.catalog);
  const write = fs.writeFileSync;
  const rename = fs.renameSync;
  const open = fs.openSync;
  let interleaved = false;
  let sourceOpened = false;
  let publications = 0;
  let timestamp = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => timestamp++);
  vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...args: any[]) => {
    if (String(file) === fx.file) sourceOpened = true;
    return Reflect.apply(open, fs, [file, ...args]);
  }) as typeof fs.openSync);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
    Reflect.apply(write, fs, [file, ...args]);
    if (!interleaved && String(file).startsWith(cache + '.') && String(file).endsWith('.tmp')) {
      interleaved = true;
      other.checkpointRelationships();
    }
  }) as typeof fs.writeFileSync);
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to);
    if (String(to) !== cache || ++publications !== 1) return;
    fs.rmdirSync(cwd);
    for (let steps = 0; steps < 100_000; steps++) {
      if (sourceOpened) break;
      const next = scan.next({ entries: 1, checks: 1, bytes: 37 });
      assert.equal(next.done, false);
    }
    assert.equal(sourceOpened, true);
  });
  syncBuiltinESMExports();
  try {
    fx.receipts.checkpointRelationships();
    other.checkpointRelationships();
    assert.equal(interleaved, true);
    assert.deepEqual(drainRelationships(scan), linked);
    assert.equal(publications, 1);
  } finally {
    scan.return(null);
  }
});

test.each(['claude', 'codex'] as const)(
  'unverified %s receipt links refuse an already missing launch cwd',
  (provider) => {
    const cwd = scratch('arc-dispatch-worker-');
    const fx = relationshipFixture('claude', provider, false, cwd);
    fs.rmdirSync(cwd);
    assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
    fx.receipts.checkpointRelationships();
    assert.deepEqual(drainRelationships(new DispatchReceipts(fx.home).relationships(fx.catalog)), []);
  },
);

test.each(['receipt', 'anchor', 'accepted', 'startup', 'source', 'refused', 'collision', 'redirected-cwd'] as const)(
  'retained receipt links refuse changed %s evidence',
  (mode) => {
    const cwd = scratch('arc-dispatch-worker-');
    const fx = relationshipFixture('claude', 'codex', false, cwd);
    assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 1);
    fx.receipts.checkpointRelationships();
    fs.rmdirSync(cwd);
    const directory = path.join(fx.receipts.root, fx.launch.launchId);
    if (mode === 'receipt') {
      const file = path.join(directory, 'receipt.json');
      const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      receipt.standalone.name = 'different';
      fs.renameSync(file, file + '.old');
      fs.writeFileSync(file, JSON.stringify(receipt));
      const stat = fs.statSync(file, { bigint: true });
      const anchorFile = path.join(fx.receipts.root, `${fx.launch.launchId}.json`);
      const anchor = JSON.parse(fs.readFileSync(anchorFile, 'utf8'));
      anchor.receipt = { dev: String(stat.dev), ino: String(stat.ino) };
      anchor.sha256 = payloadSha256(JSON.stringify(receipt));
      fs.writeFileSync(anchorFile, JSON.stringify(anchor));
    }
    if (mode === 'anchor' || mode === 'accepted' || mode === 'startup') {
      const file = path.join(fx.receipts.root, `${fx.launch.launchId}${mode === 'anchor' ? '' : `.${mode}`}.json`);
      const bytes = fs.readFileSync(file);
      fs.renameSync(file, file + '.old');
      fs.writeFileSync(file, bytes);
    }
    if (mode === 'source') fs.writeFileSync(fx.file, Buffer.alloc(fx.opening.length, 120));
    if (mode === 'refused') fx.receipts.startupRefused(fx.launch.launchId, true);
    if (mode === 'collision') fx.catalog.push({ ...fx.catalog[1], file: fx.file + '.other' });
    if (mode === 'redirected-cwd') fs.symlinkSync(fx.home, cwd, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(drainRelationships(new DispatchReceipts(fx.home).relationships(fx.catalog)), []);
    if (mode === 'redirected-cwd') fs.unlinkSync(cwd);
  },
);

test('retained verification rejects a forged requester even when file revisions appear unchanged', () => {
  const cwd = scratch('arc-dispatch-worker-');
  const fx = relationshipFixture('claude', 'codex', false, cwd);
  assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 1);
  fx.receipts.checkpointRelationships();
  fs.rmdirSync(cwd);
  const receiptFile = path.join(fx.receipts.root, fx.launch.launchId, 'receipt.json');
  const anchorFile = path.join(fx.receipts.root, `${fx.launch.launchId}.json`);
  const revisions = new Map([receiptFile, anchorFile].map((file) => [file, fs.lstatSync(file, { bigint: true })]));
  const forged = 'cccccccc-1111-2222-3333-444444444444';
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.requester.id = forged;
  const text = JSON.stringify(receipt);
  fs.writeFileSync(receiptFile, text);
  const anchor = JSON.parse(fs.readFileSync(anchorFile, 'utf8'));
  anchor.sha256 = payloadSha256(text);
  fs.writeFileSync(anchorFile, JSON.stringify(anchor));
  fx.catalog[0].sessionId = forged;
  const stat = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(
    ((file: fs.PathLike, options: any) => revisions.get(String(file)) ?? stat(file, options)) as typeof fs.lstatSync,
  );
  syncBuiltinESMExports();
  assert.deepEqual(drainRelationships(new DispatchReceipts(fx.home).relationships(fx.catalog)), []);
});

function competingRelationshipFixture(parent: 'claude' | 'codex', child: 'claude' | 'codex') {
  const fx = relationshipFixture(parent, child);
  const other = 'cccccccc-1111-2222-3333-444444444444';
  const competitor = fx.receipts.reserve({ ...fx.launch, requester: { provider: parent, id: other } });
  const { launchId: _launchId, ...startup } = JSON.parse(
    fs.readFileSync(path.join(fx.receipts.root, fx.launch.launchId, 'startup.json'), 'utf8'),
  );
  fx.receipts.startup(competitor.launchId, startup);
  fx.receipts.standaloneSession(competitor.launchId, turn);
  fx.catalog.push({ ...fx.catalog[0], sessionId: other });
  return { ...fx, competitor };
}

test.each(['launch-folder', 'dispatch-root'] as const)(
  'receipt discovery prunes verification entries after removing the %s',
  (removed) => {
    const fx = competingRelationshipFixture('claude', 'codex');
    assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 2);
    fx.receipts.checkpointRelationships();
    const cache = path.join(fx.home, 'cache', 'dispatch-relationships');
    const expired = path.join(cache, `${fx.launch.launchId}.json`);
    const retained = path.join(cache, `${fx.competitor.launchId}.json`);
    const retainedBytes = fs.readFileSync(retained);
    const retainedIdentity = fs.statSync(retained, { bigint: true }).ino;
    const unrelated = path.join(cache, 'unrelated.json');
    fs.writeFileSync(unrelated, 'keep');
    const folder = removed === 'dispatch-root' ? fx.receipts.root : path.join(fx.receipts.root, fx.launch.launchId);
    fs.renameSync(folder, folder + '.removed');
    const unlink = fs.unlinkSync;
    let deletions = 0;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      deletions++;
      unlink(file);
    });
    syncBuiltinESMExports();
    const scan = new DispatchReceipts(fx.home).relationships(fx.catalog);
    let complete = false;
    try {
      for (let steps = 0; steps < 100_000; steps++) {
        const checks = steps % 2;
        const before = deletions;
        const next = scan.next({ entries: 1, checks, bytes: 37 });
        assert.ok(deletions - before <= checks);
        if (next.done) {
          complete = true;
          break;
        }
        assert.ok(next.value.checks <= checks && next.value.entries <= 1 && next.value.bytes <= 37);
      }
      assert.equal(complete, true);
      assert.equal(fs.existsSync(expired), false);
      if (removed === 'dispatch-root') assert.equal(fs.existsSync(retained), false);
      else {
        assert.deepEqual(fs.readFileSync(retained), retainedBytes);
        assert.equal(fs.statSync(retained, { bigint: true }).ino, retainedIdentity);
      }
      assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
      assert.equal(deletions, removed === 'dispatch-root' ? 2 : 1);
    } finally {
      scan.return();
    }
  },
);

test.each(['startup', 'witness', 'bytes'] as const)('receipt refusals retain competing %s evidence', (stage) => {
  for (const parent of ['claude', 'codex'] as const)
    for (const child of ['claude', 'codex'] as const)
      for (const code of ['EACCES', 'EPERM'] as const) {
        const fx = competingRelationshipFixture(parent, child);
        assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 2);
        const startup = path.join(fx.receipts.root, fx.competitor.launchId, 'startup.json');
        const target =
          stage === 'witness' ? path.join(fx.receipts.root, `${fx.competitor.launchId}.startup.json`) : startup;
        const before = fs.readFileSync(startup);
        const failure = Object.assign(new Error('Receipt evidence is unavailable.'), { code });
        const originalOpen = fs.openSync;
        const originalRead = fs.readSync;
        const originalClose = fs.closeSync;
        const opened = new Map<number, string>();
        let denied = false;
        const writers = ['writeFileSync', 'linkSync', 'renameSync', 'mkdirSync', 'unlinkSync'] as const;
        const spies = writers.map((name) =>
          vi.spyOn(fs, name).mockImplementation(() => {
            throw new Error('Receipt reads must not write.');
          }),
        );
        const open = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
          if (stage !== 'bytes' && String(file) === target) {
            denied = true;
            throw failure;
          }
          const fd = Reflect.apply(originalOpen, fs, [file, ...args]);
          opened.set(fd, String(file));
          return fd;
        });
        const read = vi.spyOn(fs, 'readSync').mockImplementation(((fd, ...args) => {
          if (stage === 'bytes' && opened.get(fd) === target) {
            denied = true;
            throw failure;
          }
          return Reflect.apply(originalRead, fs, [fd, ...args]);
        }) as typeof fs.readSync);
        const close = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
          opened.delete(fd);
          originalClose(fd);
        });
        syncBuiltinESMExports();
        try {
          const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
          const references = drainRelationships(fx.receipts.relationships(fx.catalog), 37, refusals);
          assert.equal(denied, true);
          assert.deepEqual(
            references.map((reference) => reference.parentSessionId),
            [session],
          );
          assert.deepEqual(refusals, [{ error: failure, launchId: fx.competitor.launchId }]);
          assert.equal(opened.size, 0);
          assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 1);
          assert.deepEqual(drainRelationships(fx.receipts.relationship(fx.competitor.launchId, fx.catalog)), []);
          assert.equal(opened.size, 0);
        } finally {
          close.mockRestore();
          read.mockRestore();
          open.mockRestore();
          for (const spy of spies) spy.mockRestore();
          syncBuiltinESMExports();
        }
        assert.deepEqual(fs.readFileSync(startup), before);
        assert.equal(fs.existsSync(fx.file), true);
      }
});

test.each(['EACCES', 'EPERM'] as const)(
  'receipt store truncation retains its %s refusal after a qualified claim',
  (code) => {
    for (const parent of ['claude', 'codex'] as const) {
      const fx = competingRelationshipFixture(parent, 'codex');
      assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 2);
      const entries = fs.readdirSync(fx.receipts.root, { withFileTypes: true });
      const first = entries.find((entry) => entry.name === fx.launch.launchId)!;
      const original = fs.opendirSync;
      const failure = Object.assign(new Error('Receipt directory is unavailable.'), { code });
      let attempted = 0;
      let closed = false;
      const open = vi.spyOn(fs, 'opendirSync').mockImplementation((file, ...args) => {
        const directory = Reflect.apply(original, fs, [file, ...args]);
        if (String(file) !== fx.receipts.root) return directory;
        vi.spyOn(directory, 'readSync').mockImplementation(() => {
          if (attempted++ === 0) return first;
          throw failure;
        });
        const close = directory.closeSync.bind(directory);
        vi.spyOn(directory, 'closeSync').mockImplementation(() => {
          closed = true;
          close();
        });
        return directory;
      });
      syncBuiltinESMExports();
      try {
        const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
        const references = drainRelationships(fx.receipts.relationships(fx.catalog), 11, refusals);
        assert.equal(attempted, 2);
        assert.deepEqual(
          references.map((reference) => reference.parentSessionId),
          [session],
        );
        assert.deepEqual(refusals, [{ error: failure, storeOpened: true }]);
        assert.equal(closed, true);
        assert.equal(fs.existsSync(path.join(fx.receipts.root, fx.competitor.launchId, 'startup.json')), true);
      } finally {
        open.mockRestore();
        syncBuiltinESMExports();
      }
    }
  },
);

test('receipt store opening exposes refusal while ordinary readers retain an empty result', () => {
  const fx = relationshipFixture();
  const original = fs.opendirSync;
  const failure = Object.assign(new Error('Receipt storage is unavailable.'), { code: 'EACCES' });
  vi.spyOn(fs, 'opendirSync').mockImplementation((file, ...args) => {
    if (String(file) === fx.receipts.root) throw failure;
    return Reflect.apply(original, fs, [file, ...args]);
  });
  syncBuiltinESMExports();
  const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog), 11, refusals), []);
  assert.deepEqual(refusals, [{ error: failure, storeOpened: false }]);
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
});

test.each(['ENOENT', 'ENOTDIR'] as const)('receipt disappearance stays pending for %s', (code) => {
  const fx = competingRelationshipFixture('claude', 'codex');
  assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 2);
  const target = path.join(fx.receipts.root, fx.competitor.launchId, 'startup.json');
  const held = target + '.held';
  const original = fs.openSync;
  let removed = false;
  vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
    if (String(file) === target && !removed) {
      fs.renameSync(target, held);
      removed = true;
      throw Object.assign(new Error('Receipt evidence disappeared.'), { code });
    }
    return Reflect.apply(original, fs, [file, ...args]);
  });
  syncBuiltinESMExports();
  const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
  const references = drainRelationships(fx.receipts.relationships(fx.catalog), 11, refusals);
  assert.equal(removed, true);
  assert.deepEqual(
    references.map((reference) => reference.parentSessionId),
    [session],
  );
  assert.deepEqual(refusals, []);
  assert.equal(fs.existsSync(held), true);
  assert.equal(fs.existsSync(fx.file), true);
});

test.each(['missing', 'non-directory'] as const)('receipt storage supplies no refusal when %s', (mode) => {
  const fx = competingRelationshipFixture('claude', 'codex');
  assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 2);
  fs.renameSync(fx.receipts.root, fx.receipts.root + '.held');
  if (mode === 'non-directory') fs.writeFileSync(fx.receipts.root, 'unavailable');
  const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog), 11, refusals), []);
  assert.deepEqual(refusals, []);
  assert.equal(fs.existsSync(fx.file), true);
});

test.each(['claude', 'codex'] as const)('receipt relationships retain reader ownership for %s parents', (parent) => {
  for (const child of ['claude', 'codex'] as const) {
    const fx = relationshipFixture(parent, child);
    const writers = ['writeFileSync', 'linkSync', 'renameSync', 'mkdirSync', 'unlinkSync'] as const;
    for (const name of writers)
      vi.spyOn(fs, name).mockImplementation(() => {
        throw new Error('Receipt reads must not write.');
      });
    syncBuiltinESMExports();
    const references = drainRelationships(fx.receipts.relationships(fx.catalog));
    assert.equal(references.length, 1);
    assert.deepEqual(references[0], {
      kind: 'dispatch',
      agent: child,
      parentSessionId: session,
      sessionId: turn,
      file: fx.file,
      toolUseIds: [],
      name: 'test',
      owned: true,
    });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
});

test.each([
  { platform: 'win32', mixed: false, temporary: false, canonical: false, expected: 1 },
  { platform: 'linux', mixed: false, temporary: false, canonical: false, expected: 1 },
  { platform: 'darwin', mixed: false, temporary: false, canonical: false, expected: 1 },
  { platform: 'win32', mixed: true, temporary: false, canonical: false, expected: 1 },
  { platform: 'linux', mixed: true, temporary: false, canonical: false, expected: 0 },
  { platform: 'darwin', mixed: true, temporary: false, canonical: false, expected: 0 },
  { platform: 'win32', mixed: false, temporary: true, canonical: true, expected: 0 },
  { platform: 'linux', mixed: false, temporary: true, canonical: true, expected: 0 },
  { platform: 'darwin', mixed: false, temporary: true, canonical: true, expected: 1 },
  { platform: 'darwin', mixed: false, temporary: true, canonical: false, expected: 0 },
] as const)(
  'receipt reader uses $platform path rules for mixed=$mixed temporary=$temporary canonical=$canonical',
  ({ platform, mixed, temporary, canonical, expected }) => {
    const fx = relationshipFixture();
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const virtualHome =
      platform === 'win32' ? (temporary ? 'C:/tmp/ArcHome' : 'C:/ArcHome') : temporary ? '/tmp/ArcHome' : '/ArcHome';
    const virtualRoot = paths.join(virtualHome, 'dispatch');
    const virtualSource = paths.join(virtualHome, platform === 'win32' && mixed ? 'NATIVE.jsonl' : 'native.jsonl');
    const virtualCwd = paths.join(virtualHome, 'Worktrees', 'WorkerTree');
    const physicalCwd = path.join(
      fx.home,
      ...(platform === 'win32' ? ['worktrees', 'workertree'] : ['Worktrees', 'WorkerTree']),
    );
    fs.mkdirSync(physicalCwd, { recursive: true });
    const receiptFile = path.join(fx.receipts.root, fx.launch.launchId, 'receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    receipt.standalone.cwd = virtualCwd;
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    const anchorFile = path.join(fx.receipts.root, `${fx.launch.launchId}.json`);
    const anchor = JSON.parse(fs.readFileSync(anchorFile, 'utf8'));
    anchor.sha256 = payloadSha256(JSON.stringify(receipt));
    fs.writeFileSync(anchorFile, JSON.stringify(anchor));
    const startupFile = path.join(fx.receipts.root, fx.launch.launchId, 'startup.json');
    const startup = JSON.parse(fs.readFileSync(startupFile, 'utf8'));
    Object.assign(startup, { file: virtualSource, ancestor: virtualHome, cwd: virtualCwd });
    fs.writeFileSync(startupFile, JSON.stringify(startup));
    const witnessFile = path.join(fx.receipts.root, `${fx.launch.launchId}.startup.json`);
    const witness = JSON.parse(fs.readFileSync(witnessFile, 'utf8'));
    witness.sha256 = payloadSha256(JSON.stringify(startup));
    fs.writeFileSync(witnessFile, JSON.stringify(witness));
    const catalog = [
      { ...fx.catalog[0], file: paths.join(virtualHome, 'parent.jsonl') },
      {
        ...fx.catalog[1],
        file: paths.join(virtualHome, mixed && platform !== 'win32' ? 'NATIVE.jsonl' : 'native.jsonl'),
      },
    ];
    const key = (value: string) => {
      const absolute = paths.resolve(value);
      return platform === 'win32' ? absolute.toLowerCase() : absolute;
    };
    const ancestors = new Map<string, string>();
    for (let current = paths.dirname(virtualHome); ; current = paths.dirname(current)) {
      const owned = path.join(fx.home, 'virtual-ancestors', String(ancestors.size));
      fs.mkdirSync(owned, { recursive: true });
      ancestors.set(key(current), owned);
      if (current === paths.dirname(current)) break;
    }
    const unmapped: string[] = [];
    const physicalTargets: string[] = [];
    const sourceOpens: string[] = [];
    const logicalSourceOpens: string[] = [];
    const translate = (file: fs.PathLike) => {
      const value = String(file);
      const relative = paths.relative(key(virtualHome), key(value));
      if (relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative)))
        return path.join(fx.home, ...relative.split(paths.sep));
      const ancestor = ancestors.get(key(value));
      if (ancestor) return ancestor;
      unmapped.push(value);
      throw new Error(`Unmapped filesystem path: ${value}`);
    };
    const stat = fs.lstatSync;
    const open = fs.openSync;
    const openDirectory = fs.opendirSync;
    const temporaryRoot = platform === 'win32' ? paths.normalize('C:/tmp') : '/tmp';
    let aliasChecks = 0;
    let redirectedCwdParent = false;
    vi.spyOn(os, 'homedir').mockReturnValue(platform === 'win32' ? 'C:/Reader' : '/reader');
    vi.spyOn(os, 'tmpdir').mockReturnValue(platform === 'win32' ? 'C:/ConfiguredTemp' : '/configured/temp');
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options: any) => {
      const target = String(file) === temporaryRoot ? fx.home : translate(file);
      physicalTargets.push(target);
      const held = stat(target, options);
      if (redirectedCwdParent && key(String(file)) === key(paths.dirname(virtualCwd)))
        return Object.assign(Object.create(Object.getPrototypeOf(held)), held, { isSymbolicLink: () => true });
      if (String(file) === temporaryRoot) {
        aliasChecks++;
        return Object.assign(Object.create(Object.getPrototypeOf(held)), held, { isSymbolicLink: () => true });
      }
      return held;
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const target = translate(file);
      physicalTargets.push(target);
      const basename = paths.basename(String(file));
      if ((platform === 'win32' ? basename.toLowerCase() : basename) === 'native.jsonl') {
        logicalSourceOpens.push(String(file));
        sourceOpens.push(target);
      }
      return open(target, ...args);
    });
    vi.spyOn(fs, 'opendirSync').mockImplementation(((file: fs.PathLike, options: any) => {
      const target = translate(file);
      physicalTargets.push(target);
      return openDirectory(target, options);
    }) as typeof fs.opendirSync);
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((file) => {
      if (String(file) === '/tmp') {
        aliasChecks++;
        return canonical ? '/private/tmp' : '/redirected/tmp';
      }
      if (key(String(file)) === key(virtualHome)) return virtualHome;
      if (key(String(file)) === key(virtualCwd)) return virtualCwd;
      unmapped.push(String(file));
      throw new Error(`Unmapped real path: ${String(file)}`);
    });
    syncBuiltinESMExports();
    const receipts = new DispatchReceipts(virtualHome, platform);
    assert.equal(receipts.root, virtualRoot);
    const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
    let references: ReturnType<typeof drainRelationships> = [];
    try {
      references = drainRelationships(receipts.relationships(catalog), 31, refusals);
      if (expected) {
        fs.rmdirSync(physicalCwd);
        assert.deepEqual(drainRelationships(receipts.relationships(catalog), 31, refusals), references);
        assert.deepEqual(drainRelationships(new DispatchReceipts(virtualHome, platform).relationships(catalog)), []);
        redirectedCwdParent = true;
        assert.deepEqual(drainRelationships(receipts.relationships(catalog)), []);
        redirectedCwdParent = false;
        fs.rmdirSync(path.dirname(physicalCwd));
        assert.deepEqual(drainRelationships(receipts.relationships(catalog), 31, refusals), references);
      }
    } finally {
      assert.deepEqual(unmapped, []);
      for (const target of physicalTargets) {
        const relative = path.relative(fx.home, target);
        assert.ok(
          target === path.dirname(fx.home) ||
            relative === '' ||
            (!relative.startsWith('..') && !path.isAbsolute(relative)),
          `Receipt fixture accessed an unowned path: ${target}`,
        );
      }
    }
    assert.deepEqual(refusals, []);
    assert.equal(references.length, expected);
    if (expected) {
      assert.equal(references[0].file, catalog[1].file);
      assert.deepEqual([...new Set(sourceOpens)], [fx.file]);
    }
    if (platform === 'win32' && mixed)
      assert.deepEqual([...new Set(logicalSourceOpens)], [paths.join(virtualHome, 'NATIVE.jsonl')]);
    if (temporary) assert.ok(aliasChecks > 0);
  },
);

test('resumable receipt paths refuse redirected ancestors', () => {
  const fx = relationshipFixture();
  const stat = fs.lstatSync;
  let reached = false;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options: any) => {
    const held = stat(file, options);
    if (String(file) !== fx.home) return held;
    reached = true;
    return Object.assign(Object.create(Object.getPrototypeOf(held)), held, { isSymbolicLink: () => true });
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog), 11), []);
  assert.equal(reached, true);
});

test('directory entry charges survive partial launch abandonment', () => {
  const fx = relationshipFixture();
  const openDirectory = fs.opendirSync;
  const read = fs.readSync;
  let entries = 0;
  let bodyReads = 0;
  let directoryClosed = false;
  vi.spyOn(fs, 'opendirSync').mockImplementation((...args) => {
    const directory = Reflect.apply(openDirectory, fs, args);
    const next = directory.readSync.bind(directory);
    const close = directory.closeSync.bind(directory);
    vi.spyOn(directory, 'readSync').mockImplementation(() => {
      entries++;
      return next();
    });
    vi.spyOn(directory, 'closeSync').mockImplementation(() => {
      directoryClosed = true;
      close();
    });
    return directory;
  });
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: [number, NodeJS.ArrayBufferView, number, number, number | null]
  ) => {
    bodyReads++;
    return Reflect.apply(read, fs, args);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  const scan = fx.receipts.relationships(fx.catalog);
  let charged = 0;
  for (let step = 0; step < 10_000; step++) {
    const before = entries;
    const next = scan.next({ entries: 1, bytes: 11, checks: 1 });
    assert.equal(next.done, false);
    if (next.done) break;
    assert.equal(next.value.entries, entries - before);
    charged += next.value.entries;
    if (bodyReads) break;
  }
  assert.ok(entries > 0 && bodyReads > 0);
  assert.equal(charged, entries);
  scan.return();
  assert.equal(directoryClosed, true);
});

test('receipt byte grants bound physical reads and retain partial source validation', () => {
  const fx = relationshipFixture();
  const originalRead = fs.readSync;
  let supplied = 0;
  let returned = 0;
  let entries = 0;
  const openDirectory = fs.opendirSync;
  vi.spyOn(fs, 'opendirSync').mockImplementation((...args) => {
    const directory = Reflect.apply(openDirectory, fs, args);
    const readEntry = directory.readSync.bind(directory);
    vi.spyOn(directory, 'readSync').mockImplementation(() => {
      entries++;
      return readEntry();
    });
    return directory;
  });
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: [number, NodeJS.ArrayBufferView, number, number, number | null]
  ) => {
    assert.ok(typeof args[3] === 'number' && args[3] <= supplied, 'A physical read exceeded the remaining byte grant.');
    const count = Reflect.apply(originalRead, fs, args) as number;
    returned += count;
    return count;
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  const scan = fx.receipts.relationships(fx.catalog);
  const references = [];
  for (let step = 0; step < 100_000; step++) {
    supplied = step % 3 === 0 ? 0 : 13;
    const before = returned;
    const beforeEntries = entries;
    const entryGrant = step % 2;
    const next = scan.next({ bytes: supplied, entries: entryGrant, checks: 1 });
    assert.ok(returned - before <= supplied);
    if (next.done) break;
    assert.equal(next.value.entries, entries - beforeEntries);
    assert.ok(next.value.entries <= entryGrant);
    if (next.value.reference) references.push(next.value.reference);
  }
  assert.equal(references.length, 1);
  assert.ok(returned >= fx.opening.length);
});

test.each(['startup', 'accepted'] as const)(
  'receipt reads refuse missing or replaced %s witnesses without recovery',
  (kind) => {
    const fx = relationshipFixture();
    const witness = path.join(fx.receipts.root, `${fx.launch.launchId}.${kind}.json`);
    const original = fs.readFileSync(witness);
    fs.unlinkSync(witness);
    assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
    assert.equal(fs.existsSync(witness), false);
    fs.writeFileSync(witness, original);
    const binding = path.join(fx.receipts.root, fx.launch.launchId, `${kind}.json`);
    const bytes = fs.readFileSync(binding);
    fs.renameSync(binding, binding + '.old');
    fs.writeFileSync(binding, bytes);
    assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
  },
);

test.each(['source', 'ancestor', 'malformed', 'refused', 'legacy', 'collision'] as const)(
  'receipt relationships refuse invalid %s evidence',
  (failure) => {
    const fx = relationshipFixture();
    if (failure === 'source') {
      fs.renameSync(fx.file, fx.file + '.old');
      fs.writeFileSync(fx.file, fx.opening);
    }
    if (failure === 'ancestor') {
      const old = fx.home + '.old';
      fs.renameSync(fx.home, old);
      homes.push(old);
      fs.mkdirSync(fx.home);
      for (const entry of fs.readdirSync(old)) fs.renameSync(path.join(old, entry), path.join(fx.home, entry));
    }
    if (failure === 'malformed') fs.writeFileSync(path.join(fx.receipts.root, `${fx.launch.launchId}.json`), '{}');
    if (failure === 'refused') fx.receipts.startupRefused(fx.launch.launchId, true);
    if (failure === 'legacy') {
      fs.unlinkSync(path.join(fx.receipts.root, fx.launch.launchId, 'startup.json'));
      fs.unlinkSync(path.join(fx.receipts.root, `${fx.launch.launchId}.startup.json`));
    }
    if (failure === 'collision') fx.catalog.push({ ...fx.catalog[1], file: fx.file + '.other' });
    const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
    assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog), 37, refusals), []);
    assert.deepEqual(refusals, []);
  },
);

test('receipt scans revisit delayed bindings, new store tails and changed scope', () => {
  const delayed = relationshipFixture();
  const deferredLaunch = delayed.receipts.reserve({ ...delayed.launch });
  const { launchId: _deferredId, ...deferredStartup } = JSON.parse(
    fs.readFileSync(path.join(delayed.receipts.root, delayed.launch.launchId, 'startup.json'), 'utf8'),
  );
  delayed.receipts.startup(deferredLaunch.launchId, deferredStartup);
  assert.deepEqual(drainRelationships(delayed.receipts.relationship(deferredLaunch.launchId, delayed.catalog)), []);
  delayed.receipts.standaloneSession(deferredLaunch.launchId, turn);
  assert.equal(drainRelationships(delayed.receipts.relationship(deferredLaunch.launchId, delayed.catalog)).length, 1);
  const fx = relationshipFixture('claude', 'codex', true);
  assert.deepEqual(drainRelationships(fx.receipts.relationships([fx.catalog[0]])), []);
  assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog))[0].owned, false);
  const binding = path.join(fx.receipts.root, fx.launch.launchId, 'accepted.json');
  const original = fs.readFileSync(binding);
  fs.renameSync(binding, binding + '.old');
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
  fs.writeFileSync(binding, original);
  assert.notEqual(fs.statSync(binding, { bigint: true }).ino, fs.statSync(binding + '.old', { bigint: true }).ino);
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
  // Replacement cannot recover an accepted witness. A fresh launch remains discoverable.
  const tail = fx.receipts.reserve({ ...fx.launch });
  const { launchId: _launchId, ...startup } = JSON.parse(
    fs.readFileSync(path.join(fx.receipts.root, fx.launch.launchId, 'startup.json'), 'utf8'),
  );
  fx.receipts.startup(tail.launchId, startup);
  fx.receipts.standaloneSession(tail.launchId, turn);
  assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 1);
});

test('receipt source digests reject stable same-identity rewrites', () => {
  const fx = relationshipFixture();
  const original = fs.readFileSync(fx.file);
  fs.writeFileSync(fx.file, Buffer.alloc(original.length, 120));
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
});

test('publication rechecks changed catalog scope', () => {
  const fx = relationshipFixture();
  let lookups = 0;
  assert.deepEqual(
    drainRelationships(fx.receipts.relationships(() => (++lookups === 1 ? fx.catalog : [fx.catalog[0]]))),
    [],
  );
  assert.equal(drainRelationships(fx.receipts.relationships(fx.catalog)).length, 1);
});

test('the final step of each launch names it and the identities its catalog lookup matched', () => {
  const fx = relationshipFixture('claude', 'codex');
  const ends = (catalog: SessionFile[]) => {
    const steps: DispatchRelationshipStep[] = [];
    const scan = fx.receipts.relationships(catalog);
    for (let next = scan.next(); !next.done; next = scan.next({ bytes: 1 << 20, entries: 1, checks: 1 }))
      if (next.value.launchId === fx.launch.launchId) steps.push(next.value);
    return steps;
  };
  const identities = {
    requester: { agent: 'claude', sessionId: session },
    child: { agent: 'codex', sessionId: turn },
  };
  const [linked] = ends(fx.catalog);
  assert.equal(linked.launchId, fx.launch.launchId);
  assert.deepEqual(linked.identities, identities);
  assert.equal(linked.reference?.sessionId, turn);
  // A lookup that misses still names the identities, so a later catalog can read the launch again.
  const [missed] = ends([fx.catalog[0]]);
  assert.deepEqual(missed.identities, identities);
  assert.equal(missed.reference, undefined);
  fs.rmSync(path.join(fx.receipts.root, `${fx.launch.launchId}.json`));
  const [unread] = ends(fx.catalog);
  assert.equal(unread.launchId, fx.launch.launchId);
  assert.equal(unread.identities, undefined);
});

test('receipt readers recheck early evidence after partial source reads', () => {
  const fx = relationshipFixture();
  const original = fs.readSync;
  const source = fs.statSync(fx.file, { bigint: true });
  let changed = false;
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: [number, NodeJS.ArrayBufferView, number, number, number | null]
  ) => {
    const count = Reflect.apply(original, fs, args) as number;
    if (!changed && fs.fstatSync(args[0], { bigint: true }).ino === source.ino) {
      changed = true;
      fs.writeFileSync(path.join(fx.receipts.root, `${fx.launch.launchId}.accepted.json`), '{}');
    }
    return count;
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
  assert.equal(changed, true);
});

test.each(
  (['claude', 'codex'] as const).flatMap((provider) =>
    (['append', 'siblings', 'rewrite', 'rewrite-growth', 'shrink', 'replace', 'cwd', 'redirect'] as const).map(
      (mode) => ({ provider, mode }),
    ),
  ),
)('receipt reader preserves $provider source evidence for $mode', ({ provider, mode }) => {
  const current = relationshipFixture('codex', provider);
  const sourceStat = fs.statSync(current.file, { bigint: true });
  const read = fs.readSync;
  let touched = false;
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: [number, NodeJS.ArrayBufferView, number, number, number | null]
  ) => {
    const count = Reflect.apply(read, fs, args) as number;
    if (!touched && count > 0 && fs.fstatSync(args[0], { bigint: true }).ino === sourceStat.ino) {
      touched = true;
      if (mode === 'append') fs.appendFileSync(current.file, 'appended');
      if (mode === 'siblings') {
        fs.writeFileSync(path.join(current.receipts.root, 'parallel.lock'), 'lock');
        fs.writeFileSync(path.join(current.receipts.root, current.launch.launchId, 'checkpoint.json'), '{}');
      }
      if (mode === 'rewrite' || mode === 'rewrite-growth') {
        const fd = fs.openSync(current.file, 'r+');
        fs.writeSync(fd, Buffer.from('!'), 0, 1, 0);
        fs.closeSync(fd);
        if (mode === 'rewrite-growth') fs.appendFileSync(current.file, 'growth');
      }
      if (mode === 'shrink') fs.truncateSync(current.file, current.opening.length - 1);
      if (mode === 'replace') {
        fs.renameSync(current.file, current.file + '.old');
        fs.writeFileSync(current.file, current.opening);
      }
      if (mode === 'redirect') {
        fs.renameSync(current.file, current.file + '.old');
        fs.symlinkSync(current.file + '.old', current.file);
      }
    }
    return count;
  }) as typeof fs.readSync);
  if (mode === 'cwd') {
    const realpath = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((file) =>
      String(file) === current.home ? current.home + '.different' : realpath(file),
    );
  }
  syncBuiltinESMExports();
  const references = drainRelationships(current.receipts.relationships(current.catalog), 11);
  assert.equal(references.length, mode === 'siblings' ? 1 : 0, `${provider} ${mode}`);
  if (mode !== 'cwd') assert.equal(touched, true);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

test.each(['changing', 'other-launch', 'later-quiet'] as const)('source deferral permits %s progress', (assertion) => {
  const growing = relationshipFixture();
  const other = relationshipFixture();
  const otherId = 'f1234567-1234-1234-1234-123456789abc';
  const later = growing.receipts.reserve({ ...other.launch });
  const { launchId: _otherLaunch, ...startup } = JSON.parse(
    fs.readFileSync(path.join(other.receipts.root, other.launch.launchId, 'startup.json'), 'utf8'),
  );
  growing.receipts.startup(later.launchId, startup);
  growing.receipts.standaloneSession(later.launchId, otherId);
  const catalog = [...growing.catalog, { ...other.catalog[1], sessionId: otherId }];
  const sourceStat = fs.statSync(growing.file, { bigint: true });
  const originalRead = fs.readSync;
  let appends = 0;
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: [number, NodeJS.ArrayBufferView, number, number, number | null]
  ) => {
    const count = Reflect.apply(originalRead, fs, args) as number;
    if (count > 0 && fs.fstatSync(args[0], { bigint: true }).ino === sourceStat.ino) {
      fs.appendFileSync(growing.file, 'x');
      appends++;
    }
    return count;
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
  const references = drainRelationships(growing.receipts.relationships(catalog), 11, refusals);
  assert.deepEqual(refusals, []);
  assert.ok(appends > 0);
  if (assertion === 'changing')
    assert.equal(
      references.some((reference) => reference.sessionId === turn),
      false,
    );
  if (assertion === 'other-launch')
    assert.equal(
      references.some((reference) => reference.sessionId === otherId),
      true,
    );
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  if (assertion === 'later-quiet')
    assert.equal(drainRelationships(growing.receipts.relationships(catalog), 11).length, 2);
});

test.each(['short', 'throw', 'unqualified'] as const)('requested byte charges survive %s reads', (mode) => {
  const fx = relationshipFixture();
  const originalRead = fs.readSync;
  const readWindow = openReadWindow();
  let requested = 0;
  let returned = 0;
  let attempts = 0;
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: [number, NodeJS.ArrayBufferView, number, number, number | null]
  ) => {
    requested += args[3];
    attempts++;
    if (mode === 'throw') throw new Error('injected read failure');
    const count = Reflect.apply(originalRead, fs, [args[0], args[1], args[2], Math.min(args[3], 1), args[4]]) as number;
    returned += count;
    if (mode === 'unqualified') (args[1] as Buffer).fill(33, args[2], args[2] + count);
    return count;
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  const scan = fx.receipts.relationship(fx.launch.launchId, fx.catalog);
  const references = [];
  let completed = false;
  for (let step = 0; step < 100_000; step++) {
    const before = requested;
    const next = scan.next({ bytes: 13, entries: 1, checks: 1 });
    if (next.done) {
      completed = true;
      break;
    }
    assert.equal(next.value.bytes, requested - before);
    if (next.value.reference) references.push(next.value.reference);
  }
  scan.return(null);
  assert.equal(completed, true);
  assert.ok(attempts > 0);
  assert.ok(requested > returned);
  assert.equal(closeReadWindow(readWindow).bytes, returned);
  assert.equal(references.length, mode === 'short' ? 1 : 0);
});

test('receipt anchor digests reject same-identity receipt edits', () => {
  const fx = relationshipFixture();
  const file = path.join(fx.receipts.root, fx.launch.launchId, 'receipt.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  receipt.standalone.name = 'changed name';
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
});

test('receipt readers reject changed committed digests', () => {
  const fx = relationshipFixture();
  const file = path.join(fx.receipts.root, `${fx.launch.launchId}.accepted.json`);
  const witness = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...witness, sha256: '0'.repeat(64) }));
  assert.deepEqual(drainRelationships(fx.receipts.relationships(fx.catalog)), []);
});

test('opened receipt descriptors enforce the JSON limit before body reads', () => {
  const fx = relationshipFixture();
  const originalOpen = fs.openSync;
  const originalStat = fs.fstatSync;
  const originalRead = fs.readSync;
  const anchor = path.join(fx.receipts.root, `${fx.launch.launchId}.json`);
  let descriptor: number | undefined;
  let oversized = false;
  let bodyReads = 0;
  vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
    const fd = originalOpen(file, ...args);
    if (String(file) === anchor) descriptor = fd;
    return fd;
  });
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options: any) => {
    const stat = originalStat(fd, options);
    if (fd !== descriptor) return stat;
    oversized = true;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      size: BigInt(48 * 1024 + 1),
      isFile: () => true,
    });
  }) as typeof fs.fstatSync);
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: [number, NodeJS.ArrayBufferView, number, number, number | null]
  ) => {
    if (args[0] === descriptor) bodyReads++;
    return Reflect.apply(originalRead, fs, args);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  assert.deepEqual(drainRelationships(fx.receipts.relationship(fx.launch.launchId, fx.catalog), 64 * 1024), []);
  assert.equal(oversized, true);
  assert.equal(bodyReads, 0);
});

test.each(['directory', 'receipt'] as const)(
  'cancellation during %s opening closes the returned resource',
  (resource) => {
    const fx = relationshipFixture();
    const controller = new AbortController();
    const originalDirectory = fs.opendirSync;
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let directoryClosed = false;
    let receiptClosed = false;
    let target: number | undefined;
    vi.spyOn(fs, 'opendirSync').mockImplementation((...args) => {
      const directory = Reflect.apply(originalDirectory, fs, args);
      const close = directory.closeSync.bind(directory);
      vi.spyOn(directory, 'closeSync').mockImplementation(() => {
        directoryClosed = true;
        close();
      });
      if (resource === 'directory') controller.abort();
      return directory;
    });
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const fd = Reflect.apply(originalOpen, fs, args);
      if (resource === 'receipt') {
        target = fd;
        controller.abort();
      }
      return fd;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      if (fd === target) receiptClosed = true;
      originalClose(fd);
    });
    syncBuiltinESMExports();
    const scan = fx.receipts.relationships(fx.catalog, controller.signal);
    const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
    for (let step = 0; step < 10_000 && !controller.signal.aborted; step++) {
      const next = scan.next({ entries: 1, bytes: 11, checks: 1 });
      if (!next.done && next.value.refusal) refusals.push(next.value.refusal);
    }
    assert.deepEqual(refusals, []);
    const closedWhenCanceled = resource === 'directory' ? directoryClosed : receiptClosed;
    scan.return();
    assert.equal(controller.signal.aborted, true);
    assert.equal(closedWhenCanceled, true);
  },
);

test('an already canceled scan performs no bounded filesystem step', () => {
  const fx = relationshipFixture();
  const controller = new AbortController();
  const stat = vi.spyOn(fs, 'lstatSync');
  syncBuiltinESMExports();
  const scan = fx.receipts.relationships(fx.catalog, controller.signal);
  controller.abort();
  const refusals: NonNullable<DispatchRelationshipStep['refusal']>[] = [];
  assert.deepEqual(drainRelationships(scan, 11, refusals), []);
  assert.deepEqual(refusals, []);
  assert.equal(stat.mock.calls.length, 0);
});

test('cancellation at the final catalog lookup suppresses publication', () => {
  const fx = relationshipFixture();
  const controller = new AbortController();
  let lookups = 0;
  const catalog = () => {
    if (++lookups === 2) controller.abort();
    return fx.catalog;
  };
  assert.deepEqual(drainRelationships(fx.receipts.relationships(catalog, controller.signal), 11), []);
  assert.equal(lookups, 2);
});

test.each([false, true])('cancellation closes partial descriptors for native source=%s', (source) => {
  const fx = relationshipFixture();
  const controller = new AbortController();
  const originalOpen = fs.openSync;
  const opened = new Set<number>();
  const closed = new Set<number>();
  let target: number | undefined;
  let partial = false;
  let reads = 0;
  vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
    const fd = Reflect.apply(originalOpen, fs, [file, ...args]);
    opened.add(fd);
    closed.delete(fd);
    if ((String(file) === fx.file) === source) target = fd;
    return fd;
  });
  const originalClose = fs.closeSync;
  const originalRead = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: [number, NodeJS.ArrayBufferView, number, number, number | null]
  ) => {
    reads++;
    const count = Reflect.apply(originalRead, fs, args) as number;
    if (args[0] === target && count > 0) partial = true;
    return count;
  }) as typeof fs.readSync);
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    closed.add(fd);
    originalClose(fd);
  });
  syncBuiltinESMExports();
  const scan = fx.receipts.relationships(fx.catalog, controller.signal);
  for (let steps = 0; steps < 100_000; steps++) {
    scan.next({ bytes: 11, checks: 1, entries: 1 });
    if (partial) break;
  }
  assert.notEqual(target, undefined);
  assert.equal(partial, true);
  const beforeAbort = reads;
  controller.abort();
  const closedAtAbort = closed.has(target!);
  const remaining = drainRelationships(scan, 11);
  const readsAfterAbort = reads;
  scan.return();
  assert.ok(closedAtAbort);
  assert.deepEqual(remaining, []);
  assert.equal(readsAfterAbort, beforeAbort);
  assert.ok([...opened].every((fd) => closed.has(fd)));
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

test.each(['live', 'uncertain', 'dead', 'legacy', 'malformed'] as const)(
  'native release retains exclusive pending witness ownership: %s',
  (mode) => {
    const { receipts, standalone } = standaloneFixture();
    const id = standalone.launchId;
    const file = path.join(receipts.root, id, 'monitor.json');
    const owner = receipts.monitor(id);
    owner.releaseNative();
    const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(pending, { pid: process.pid, token: owner.token, released: true, phase: 'witness-pending' });
    const output = receipts.monitor(id, 'output-monitor');
    assert.throws(() => output.releaseNative(), /no pending session source/);
    assert.throws(() => receipts.monitor(id, 'output-monitor'), /Another process/);
    output.release();
    if (mode === 'legacy') {
      const { phase: _phase, ...legacy } = pending;
      fs.writeFileSync(file, JSON.stringify(legacy));
    }
    if (mode === 'malformed') {
      pending.phase = 'unknown';
      fs.writeFileSync(file, JSON.stringify(pending));
    }
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (mode === 'uncertain') throw Object.assign(new Error('Unavailable.'), { code: 'EPERM' });
      if (mode === 'dead') throw Object.assign(new Error('Gone.'), { code: 'ESRCH' });
      return true;
    });
    if (mode === 'dead' || mode === 'legacy') {
      const next = receipts.monitor(id);
      assert.notEqual(next.token, owner.token);
      assert.throws(() => owner.release(), /owner changed/);
      assert.throws(() => owner.releaseNative(), /owner changed/);
      next.release();
    } else {
      assert.throws(() => receipts.monitor(id), mode === 'malformed' ? /identity is unavailable/ : /Another process/);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), pending);
      if (mode === 'malformed') assert.equal(kill.mock.calls.length, 0);
      owner.release();
      const next = receipts.monitor(id);
      next.release();
    }
  },
);

test('monitor transitions refuse acquisition before and after atomic native and witness release', () => {
  const { receipts, standalone } = standaloneFixture();
  const id = standalone.launchId;
  const file = path.join(receipts.root, id, 'monitor.json');
  const owner = receipts.monitor(id);
  const rename = fs.renameSync;
  let transitions = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (String(destination) !== file) return rename(source, destination);
    assert.throws(() => receipts.monitor(id), /Another process holds this dispatch write/);
    rename(source, destination);
    transitions++;
    assert.throws(() => receipts.monitor(id), /Another process holds this dispatch write/);
  });
  syncBuiltinESMExports();
  owner.releaseNative();
  assert.throws(() => receipts.monitor(id), /Another process is observing/);
  owner.release();
  assert.equal(transitions, 2);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  const next = receipts.monitor(id);
  next.release();
});
const nativeBackground: Partial<StandaloneOptions> = { provider: 'claude', args: ['--bg'], background: true };
test.each([false, true])('standalone accepted identity preserves startup requirement %s', (initialStartup) => {
  const { home, receipts, standalone } = standaloneFixture();
  const id = standalone.launchId;
  const file = path.join(home, 'native.jsonl');
  fs.writeFileSync(file, 'x');
  const source = fs.statSync(file, { bigint: true });
  const parent = fs.statSync(home, { bigint: true });
  const evidence = {
    file,
    identity: `${source.dev}:${source.ino}`,
    ancestor: home,
    directory: `${parent.dev}:${parent.ino}`,
    cwd: home,
    bytes: 1,
    sha256: payloadSha256('x'),
  };
  if (initialStartup) receipts.startup(id, evidence);
  assert.equal(receipts.standaloneSession(id, session), session);
  const accepted = path.join(receipts.root, id, 'accepted.json');
  const original = fs.readFileSync(accepted);
  assert.equal(JSON.parse(original.toString('utf8')).startupRequired, initialStartup ? true : undefined);
  if (!initialStartup) receipts.startup(id, evidence);
  assert.doesNotThrow(() => assert.equal(receipts.standaloneSession(id, session), session));
  assert.deepEqual(fs.readFileSync(accepted), original);
  receipts.startupRefused(id, true);
  assert.equal(receipts.standaloneSession(id), session);
  assert.deepEqual(fs.readFileSync(accepted), original);
});
test.each(['sourceBaseline', 'sourceCandidate'] as const)(
  'standalone %s refuses missing or replaced retained evidence',
  (kind) => {
    for (const change of ['missing', 'replaced']) {
      const { home, receipts, standalone } = standaloneFixture();
      const stat = fs.statSync(home, { bigint: true });
      const directory = `${stat.dev}:${stat.ino}`;
      if (kind === 'sourceBaseline')
        receipts.sourceBaseline(standalone.launchId, {
          root: home,
          ancestor: home,
          directory,
          cwd: home,
          state: 'unavailable',
        });
      else
        receipts.sourceCandidate(standalone.launchId, {
          file: path.join(home, 'native.jsonl'),
          identity: directory,
          ancestor: home,
          directory,
          cwd: home,
          bytes: 1,
          sha256: payloadSha256('x'),
        });
      const file = path.join(
        receipts.root,
        standalone.launchId,
        kind === 'sourceBaseline' ? 'source-baseline.json' : 'source-candidate.json',
      );
      const original = fs.readFileSync(file);
      fs.renameSync(file, file + '.original');
      if (change === 'replaced') fs.writeFileSync(file, original);
      assert.throws(() => receipts[kind](standalone.launchId), /unavailable|cannot change|replaced/);
    }
  },
);
const unloggedAgentRun: Partial<StandaloneOptions> = {
  model: 'sol',
  name: '',
  agentRun: true,
  logAlias: null,
  deadlineMs: 1000,
};
const largeObservation = {
  supervisor: { pid: process.pid, token: 'f'.repeat(64) },
  worker: {
    pid: process.pid,
    command: 'c'.repeat(10 * 1024),
    startedAt: 'native-lifetime',
    argsSha256: payloadSha256('args'),
    commandLineSha256: payloadSha256('native\0args\0'),
  },
  sessionId: session,
  exitCode: 0,
  signal: null,
  monitor: 'finished' as const,
};
function drainAlias(capture: ReturnType<DispatchReceipts['capture']>) {
  for (let pass = 0; pass < 8 && capture.flushAlias(); pass++) {
    /* Drain bounded alias writes. */
  }
}
function savedResponse(text: string, extra: Partial<SavedDispatchResponse> = {}): SavedDispatchResponse {
  return { text, prompt: 'review', promptId: turn, responseIds: [], finished: true, failed: false, ...extra };
}
function hosted(
  receipts: DispatchReceipts,
  id: string,
  evidence: () => SavedDispatchResponse | null,
  {
    agent = 'codex',
    exited = false,
    submitted = true,
  }: { agent?: 'claude' | 'codex'; exited?: boolean; submitted?: boolean } = {},
) {
  const host = new HostedDispatch(receipts, evidence);
  const child = { key: 'worker', agent, state: () => ({ sessionId: session, exited }) };
  host.register(id, child);
  if (submitted) host.submitted(id, 1);
  return { host, child };
}
function failWitness(receipts: DispatchReceipts, id: string) {
  const witness = path.join(receipts.root, `${id}.accepted.json`);
  const write = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
    if (String(file) === witness) throw new Error('witness storage unavailable');
    return (write as any)(file, ...args);
  });
  syncBuiltinESMExports();
  return witness;
}
function directoryLink(target: string, link: string) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
function sessionSource(
  home: string,
  agent: 'claude' | 'codex',
  text: string,
  turnId: string,
  { parts = [text], padding = false }: { parts?: string[]; padding?: boolean } = {},
) {
  const at = '2026-01-01T00:00:00Z';
  const filler = padding ? [{ type: 'progress', padding: 'x'.repeat(600 * 1024) }] : [];
  const rows =
    agent === 'claude'
      ? [
          { type: 'user', uuid: 'prompt', timestamp: at, message: { role: 'user', content: 'review' } },
          ...filler,
          {
            type: 'assistant',
            timestamp: at,
            message: {
              id: 'response',
              role: 'assistant',
              stop_reason: 'end_turn',
              content: parts.map((part) => ({ type: 'text', text: part })),
              usage: { input_tokens: 1, output_tokens: 2 },
            },
          },
        ]
      : [
          { type: 'session_meta', payload: { id: session, cwd: home, source: 'vscode' } },
          { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: turnId } },
          { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: 'review' } },
          ...filler,
          {
            type: 'response_item',
            timestamp: at,
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
          },
          {
            type: 'event_msg',
            timestamp: at,
            payload: { type: 'task_complete', turn_id: turnId, last_agent_message: text },
          },
        ];
  const file = path.join(home, `${agent}.jsonl`);
  const encoded = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(file, encoded);
  const source = { file, agent, sessionId: session, ...revisionOf(fs.statSync(file, { bigint: true })) } as SessionFile;
  return { rows, source, encoded };
}
test('private reports remain independent when output aliases collide', () => {
  const aliasHome = scratch('arc-alias-');
  const alias = path.join(aliasHome, 'report.md');
  const a = fixture('manual', alias);
  const b = fixture('manual', alias);
  const first = report(a.receipts, a.launch.launchId, 'First');
  const second = report(b.receipts, b.launch.launchId, 'Second');
  assert.notEqual(first.report!.path, second.report!.path);
  assert.equal((a.receipts.result(a.launch.launchId, first.eventId) as { text: string }).text, 'First');
  assert.equal(fs.readFileSync(alias, 'utf8'), 'Second');
  assert.equal(a.receipts.refresh(a.launch.launchId), null);
  assert.equal(a.receipts.status(a.launch.launchId).events.length, 1);
});
test('concurrent channel captures retain each source byte once across stale cursors', () => {
  const { receipts, standalone } = standaloneFixture();
  const a = receipts.capture(standalone.launchId);
  const b = receipts.capture(standalone.launchId);
  try {
    const first = { offset: 3, identity: 'source' };
    a.write(Buffer.from('abc'), 'stdout.log', first);
    b.write(Buffer.from('abcde'), 'stdout.log', { offset: 5, identity: 'source' });
    a.write(Buffer.from('abc'), 'stdout.log', first);
    assert.deepEqual(first, { offset: 5, identity: 'source' });
    const c = receipts.capture(standalone.launchId);
    c.close();
    a.write(Buffer.from('fg'), 'stdout.log', { offset: 7, identity: 'source' });
    b.write(Buffer.from('ERR'), 'stderr.log', { offset: 3, identity: 'stderr' });
    assert.deepEqual(a.cursor('stdout.log'), { offset: 7, identity: 'source' });
    assert.equal(fs.readFileSync(receipts.artifact(standalone.launchId, 'worker.log'), 'utf8'), 'abcdefgERR');
    assert.equal(fs.readFileSync(standalone.standalone!.logAlias!, 'utf8'), 'abcdefgERR');
  } finally {
    a.close();
    b.close();
  }
});

test('native capture reconciles overlapping snapshots and preserves a reused alias', () => {
  const { receipts, standalone } = standaloneFixture(nativeBackground);
  const a = receipts.capture(standalone.launchId);
  const b = receipts.capture(standalone.launchId);
  try {
    a.native(Buffer.from('abc'), { offset: 3, identity: 'native' });
    b.native(Buffer.from('abcde'), { offset: 5, identity: 'native' });
    const stale = { offset: 3, identity: 'native' };
    a.native(Buffer.from('abc'), stale);
    assert.deepEqual(stale, { offset: 5, identity: 'native' });
    a.native(Buffer.from('old snapshot'));
    assert.equal(fs.readFileSync(standalone.standalone!.logAlias!, 'utf8'), 'abcde');
    const second = receipts.reserve({ ...standalone, origin: 'b'.repeat(24) });
    const replacement = receipts.capture(second.launchId);
    try {
      replacement.native(Buffer.from('Second launch'));
      const resumed = receipts.capture(standalone.launchId);
      try {
        assert.deepEqual(resumed.cursor('native-source.log'), { offset: 5, identity: 'native' });
        resumed.native(Buffer.from('fg'), { offset: 7, identity: 'native' });
      } finally {
        resumed.close();
      }
      assert.equal(fs.readFileSync(receipts.artifact(standalone.launchId, 'native.log'), 'utf8'), 'abcdefg');
      assert.equal(fs.readFileSync(standalone.standalone!.logAlias!, 'utf8'), 'Second launch');
      assert.throws(() => b.native(Buffer.from('x'), { offset: 8, identity: 'replacement' }), /position changed/);
    } finally {
      replacement.close();
    }
  } finally {
    a.close();
    b.close();
  }
});

test.each(
  (['print', 'native'] as const).flatMap((kind) =>
    (['continue', 'resume', 'legacy resume', 'bounded replay', 'replaced', 'reused'] as const).map((recovery) => ({
      kind,
      recovery,
    })),
  ),
)('failed log alias writes recover complete $kind bytes on $recovery', ({ kind, recovery }) => {
  const native = kind === 'native';
  const { receipts, standalone } = standaloneFixture(native ? nativeBackground : {});
  const alias = standalone.standalone!.logAlias!;
  const aliasByteBudget = recovery === 'bounded replay' ? 17 : undefined;
  let capture = receipts.capture(standalone.launchId, aliasByteBudget);
  const name = native ? 'native-source.log' : 'stdout.log';
  let offset = 0;
  const append = (bytes: Buffer) => {
    offset += bytes.length;
    const cursor = { offset, identity: 'source' };
    if (native) capture.native(bytes, cursor);
    else capture.write(bytes, name, cursor);
  };
  const prefix = Buffer.from('prefix\n');
  const missing = Buffer.alloc(recovery === 'bounded replay' ? 39 : 2 * 64 * 1024 + 17, 255);
  const tail = Buffer.from('tail\n');
  const privateFile = receipts.artifact(standalone.launchId, native ? 'native.log' : 'worker.log');
  try {
    append(prefix);
    const open = fs.openSync;
    let failed = false;
    const failure = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (String(file) === alias && !failed) {
        failed = true;
        throw Object.assign(new Error('alias temporarily unavailable'), { code: 'EPERM' });
      }
      return (open as any)(file, ...args);
    });
    syncBuiltinESMExports();
    assert.doesNotThrow(() => append(missing));
    failure.mockRestore();
    syncBuiltinESMExports();
    assert.equal(failed, true);
    assert.equal(fs.readFileSync(alias).equals(prefix), true);
    const captured = Buffer.concat([prefix, missing]);
    assert.equal(fs.readFileSync(privateFile).equals(captured), true);
    assert.deepEqual(capture.cursor(name), { offset: captured.length, identity: 'source' });
    const event = report(receipts, standalone.launchId);
    assert.equal((receipts.result(standalone.launchId, event.eventId) as { text: string }).text, 'Report');

    let replacement: Buffer | undefined;
    if (recovery === 'replaced') {
      fs.renameSync(alias, alias + '.old');
      replacement = Buffer.from('Replacement');
      fs.writeFileSync(alias, replacement);
    } else if (recovery === 'reused') {
      const second = receipts.reserve({ ...standalone, origin: 'b'.repeat(24) });
      const other = receipts.capture(second.launchId);
      replacement = Buffer.from('Second launch');
      try {
        if (native) other.native(replacement);
        else other.write(replacement);
      } finally {
        other.close();
      }
    } else if (recovery === 'legacy resume') {
      const checkpoint = receipts.artifact(standalone.launchId, 'capture.json');
      const state = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
      delete state.aliasBytes;
      fs.writeFileSync(checkpoint, JSON.stringify(state));
    }

    if (recovery !== 'continue') {
      capture.close();
      capture = new DispatchReceipts(path.dirname(receipts.root)).capture(standalone.launchId, aliasByteBudget);
      if (recovery === 'bounded replay') {
        const delivered = prefix.length + aliasByteBudget!;
        assert.deepEqual(fs.readFileSync(alias), captured.subarray(0, delivered));
        const checkpoint = JSON.parse(fs.readFileSync(receipts.artifact(standalone.launchId, 'capture.json'), 'utf8'));
        assert.equal(checkpoint.aliasBytes, delivered);
        assert.ok(delivered < captured.length);
      }
      drainAlias(capture);
      assert.ok(
        fs.readFileSync(alias).equals(replacement ?? captured),
        'resumed alias must contain every captured byte',
      );
    }
    append(tail);
    drainAlias(capture);
    const complete = Buffer.concat([captured, tail]);
    assert.equal(fs.readFileSync(privateFile).equals(complete), true);
    assert.ok(
      fs.readFileSync(alias).equals(replacement ?? complete),
      'alias must contain every captured byte exactly once',
    );
  } finally {
    capture.close();
  }
});

test.each(
  ['capture.json', 'capture-write.lock'].flatMap((name) =>
    ['open', 'read'].flatMap((phase) =>
      (name === 'capture.json' ? [false, true] : [false]).map((construction) => ({ name, phase, construction })),
    ),
  ),
)(
  'concurrent capture replacement remains retryable at $name during $phase with construction=$construction',
  ({ name, phase, construction }) => {
    const { receipts, home, standalone } = standaloneFixture();
    const alias = standalone.standalone!.logAlias!;
    const id = standalone.launchId;
    const a = receipts.capture(id, 2);
    const b = new DispatchReceipts(home).capture(id, 2);
    const source = receipts.artifact(id, 'stdout.log');
    fs.writeFileSync(source, 'abcdefghij');
    const stat = fs.statSync(source, { bigint: true });
    const cursor = { offset: 10, identity: `${stat.dev}:${stat.ino}` };
    const target = path.join(path.dirname(source), name);
    const open = fs.openSync;
    const read = fs.readSync;
    const lstat = fs.lstatSync;
    let descriptor: number | undefined;
    let readStarted = false;
    let fired = false;
    const replace = () => {
      fired = true;
      b.write(Buffer.from('abcdefghij'), 'stdout.log', cursor);
    };
    const opening = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (!fired && String(file) === target && phase === 'open') replace();
      const fd = (open as any)(file, ...args);
      if (!fired && String(file) === target) descriptor = fd;
      return fd;
    });
    const reading = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...args: any[]) => {
      const count = (read as any)(fd, ...args);
      if (fd === descriptor) readStarted = true;
      return count;
    }) as typeof fs.readSync);
    const stating = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: any, ...args: any[]) => {
      const stat = (lstat as any)(file, ...args);
      if (readStarted && String(file) === target && phase === 'read') {
        fired = true;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          ino: typeof stat.ino === 'bigint' ? stat.ino + 1n : stat.ino + 1,
        });
      }
      return stat;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () =>
          construction
            ? receipts.capture(id, 2).cursor('stdout.log')
            : name === 'capture.json'
              ? a.cursor('stdout.log')
              : a.write(Buffer.from('abcdefghij'), 'stdout.log', cursor),
        /dispatch write changed during recovery/,
      );
      assert.equal(fired, true);
      opening.mockRestore();
      reading.mockRestore();
      stating.mockRestore();
      syncBuiltinESMExports();
      if (phase === 'read') b.write(Buffer.from('abcdefghij'), 'stdout.log', cursor);
      assert.equal(a.cursor('stdout.log').offset, 10);
      drainAlias(a);
      assert.equal(fs.readFileSync(alias, 'utf8'), 'abcdefghij');
      assert.equal(fs.readFileSync(receipts.artifact(id, 'worker.log'), 'utf8'), 'abcdefghij');
    } finally {
      opening.mockRestore();
      reading.mockRestore();
      stating.mockRestore();
      syncBuiltinESMExports();
      a.close();
      b.close();
    }
  },
);

test.each([false, true])(
  'idle alias flushes preserve lock history and repair changed files, background %s',
  (background) => {
    const { receipts, standalone } = standaloneFixture({ provider: background ? 'claude' : 'codex', background });
    const alias = standalone.standalone!.logAlias!;
    const raw = receipts.artifact(standalone.launchId, 'worker.log');
    const directory = path.dirname(raw);
    const history = () =>
      fs
        .readdirSync(directory)
        .filter((name) => name.startsWith('capture-write'))
        .sort();
    const source = receipts.artifact(standalone.launchId, background ? 'native-source.log' : 'stdout.log');
    const a = receipts.capture(standalone.launchId, 2);
    const b = receipts.capture(standalone.launchId, 2);
    const append = (text: string) => {
      fs.appendFileSync(source, text);
      const stat = fs.statSync(source, { bigint: true });
      const cursor = { offset: Number(stat.size), identity: `${stat.dev}:${stat.ino}` };
      if (background) b.native(Buffer.from(text), cursor);
      else b.write(Buffer.from(text), 'stdout.log', cursor);
    };
    const drain = () => drainAlias(a);
    try {
      append('abcdef');
      drain();
      assert.equal(fs.readFileSync(alias, 'utf8'), 'abcdef');
      const idle = history();
      for (let pass = 0; pass < 12; pass++) assert.equal(a.flushAlias(), false);
      assert.deepEqual(history(), idle);

      fs.appendFileSync(raw, 'uncommitted');
      fs.appendFileSync(alias, 'uncommitted');
      a.flushAlias();
      assert.equal(fs.statSync(raw).size, background ? 0 : 6);
      assert.equal(fs.readFileSync(alias, 'utf8'), 'abcdef');

      append('ghij');
      drain();
      assert.equal(fs.readFileSync(alias, 'utf8'), 'abcdefghij');
      const settled = history();
      for (let pass = 0; pass < 12; pass++) assert.equal(a.flushAlias(), false);
      assert.deepEqual(history(), settled);

      fs.renameSync(alias, alias + '.old');
      fs.writeFileSync(alias, 'Replacement');
      const replaced = history();
      for (let pass = 0; pass < 12; pass++) assert.equal(a.flushAlias(), false);
      assert.deepEqual(history(), replaced);
      assert.equal(fs.readFileSync(alias, 'utf8'), 'Replacement');
      fs.unlinkSync(alias);
      for (let pass = 0; pass < 12; pass++) assert.equal(a.flushAlias(), false);
      assert.deepEqual(history(), replaced);
      assert.equal(fs.existsSync(alias), false);
      fs.writeFileSync(alias, 'Replacement');
      const checkpoint = path.join(directory, 'capture.json');
      const state = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
      fs.writeFileSync(checkpoint, JSON.stringify({ ...state, alias: null }));
      for (let pass = 0; pass < 12; pass++) assert.equal(a.flushAlias(), false);
      assert.deepEqual(history(), replaced);
      assert.equal(fs.readFileSync(alias, 'utf8'), 'Replacement');
      assert.equal(
        fs.readFileSync(background ? receipts.artifact(standalone.launchId, 'native.log') : raw, 'utf8'),
        'abcdefghij',
      );
    } finally {
      a.close();
      b.close();
    }
  },
);

test('held reader retries one publication and refuses unrelated rename failures without a pause', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOENT']) {
    const home = scratch('arc-held-reader-');
    let now = 0;
    let held = true;
    const pauses: number[] = [];
    const receipts = new DispatchReceipts(home, process.platform, {
      now: () => now,
      pause: (milliseconds: number) => {
        pauses.push(milliseconds);
        now += milliseconds;
        held = false;
      },
    });
    const launch = receipts.reserve({
      origin,
      requester: null,
      policy: null,
      promptSha256: payloadSha256('review'),
      completion: 'wait',
      alias: null,
    });
    const directory = path.join(receipts.root, launch.launchId);
    const target = path.join(directory, 'state.json');
    const rename = fs.renameSync;
    let attempts = 0;
    const replacement = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) !== target || !held) return rename(from, to);
      attempts++;
      if (process.platform === 'win32' && code === 'EPERM') {
        const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          rename(from, to);
          assert.fail('The held reader must prevent replacement.');
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'EPERM');
          throw error;
        } finally {
          fs.closeSync(descriptor);
        }
      }
      throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), { code });
    });
    syncBuiltinESMExports();
    try {
      if (code === 'ENOENT') {
        assert.throws(() => report(receipts, launch.launchId), { code });
        assert.deepEqual(pauses, []);
        assert.equal(attempts, 1);
      } else {
        const event = report(receipts, launch.launchId);
        assert.deepEqual(receipts.latest(launch.launchId), event);
        assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).events.length, 1);
        for (const suffix of ['json', 'md', 'anchor.json']) {
          assert.deepEqual(
            fs
              .readdirSync(directory)
              .filter((name) => new RegExp(`^[a-f0-9-]{36}[.]${suffix.replace('.', '[.]')}$`).test(name)),
            [`${event.eventId}.${suffix}`],
          );
        }
        assert.deepEqual(pauses, [10]);
        assert.equal(attempts, 1);
      }
      assert.equal(
        fs.readdirSync(directory).some((name) => /^state[.]json[.].*[.]tmp$/.test(name)),
        false,
      );
    } finally {
      replacement.mockRestore();
      syncBuiltinESMExports();
    }
  }
});

test('interrupted claims retain their token and acknowledgments retain exactly one disposition', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const claim = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
  const reopened = new DispatchReceipts(path.dirname(receipts.root));
  const retry = reopened.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string; status: string };
  assert.equal(retry.status, 'already-claimed');
  assert.equal(retry.token, claim.token);
  assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'foreign'));
  assert.throws(() => receipts.claim(launch.launchId, event.eventId, 'b'.repeat(24), 'owner'));
  const ack = receipts.ack(launch.launchId, event.eventId, origin, 'owner', claim.token, 'Accepted ✓');
  assert.deepEqual(receipts.ack(launch.launchId, event.eventId, origin, 'owner', claim.token, 'Accepted ✓'), ack);
  assert.equal(
    fs.readFileSync(path.join(receipts.root, launch.launchId, `${event.eventId}.disposition.md`), 'utf8'),
    'Accepted ✓',
  );
  assert.throws(() => receipts.ack(launch.launchId, event.eventId, origin, 'owner', claim.token, 'Rejected'));
});
test('changed report observations remain unread after an older event is consumed', () => {
  const aliasHome = scratch('arc-refresh-');
  const alias = path.join(aliasHome, 'report.md');
  const { receipts, launch } = fixture('manual', alias);
  const first = report(receipts, launch.launchId);
  const claim = receipts.claim(launch.launchId, first.eventId, origin, 'owner') as { token: string };
  receipts.ack(launch.launchId, first.eventId, origin, 'owner', claim.token, 'Accepted');
  fs.writeFileSync(receipts.status(launch.launchId).reportSource!, 'Changed');
  const changed = receipts.refresh(launch.launchId)!;
  assert.notEqual(changed.eventId, first.eventId);
  assert.equal(receipts.status(launch.launchId).events.at(-1)!.consumption.dispositionSha256, undefined);
  assert.throws(() => receipts.ack(launch.launchId, changed.eventId, origin, 'owner', claim.token, 'Accepted'));
  assert.equal((receipts.result(launch.launchId, first.eventId) as { text: string }).text, 'Report');
  assert.equal(receipts.refresh(launch.launchId), null);
});
test('report text and serialized text both respect reply allowances', () => {
  const { receipts, launch } = fixture();
  for (const text of ['x'.repeat(16_001), '\u0001'.repeat(16_000)]) {
    const event = report(receipts, launch.launchId, text);
    const result = receipts.result(launch.launchId, event.eventId) as { text: string | null };
    assert.equal(result.text, null);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 48 * 1024);
  }
});

test('retained reports reach the event limit without exceeding the internal state read allowance', () => {
  const { receipts, launch } = fixture();
  let last: DispatchEvent | null = null;
  for (let index = 0; index < 256; index++) last = report(receipts, launch.launchId);
  assert.equal(receipts.latest(launch.launchId)!.eventId, last!.eventId);
  assert.equal((receipts.result(launch.launchId, last!.eventId) as { text: string }).text, 'Report');
  fs.copyFileSync(
    path.join(receipts.root, launch.launchId, 'state.json'),
    path.join(receipts.root, launch.launchId, 'state.0.json'),
  );
  const next = report(receipts, launch.launchId, 'Final after capacity');
  assert.equal((receipts.result(launch.launchId, next.eventId) as { text: string }).text, 'Final after capacity');
});
test('authoritative receipt, report and accepted-turn replacements refuse', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const file = event.report!.path;
  fs.renameSync(file, `${file}.old`);
  fs.writeFileSync(file, 'Report');
  assert.throws(() => receipts.result(launch.launchId, event.eventId), /replaced/);
  const binding = { provider: 'codex' as const, sessionId: session, submissionId: 1, nativeTurnId: turn };
  receipts.bind(launch.launchId, binding);
  assert.throws(() => receipts.bind(launch.launchId, { ...binding, nativeTurnId: 'changed' }));
  const accepted = path.join(receipts.root, launch.launchId, 'accepted.json');
  fs.renameSync(accepted, `${accepted}.old`);
  fs.writeFileSync(accepted, JSON.stringify({ launchId: launch.launchId, ...binding }));
  assert.throws(() => receipts.bind(launch.launchId, binding));
  const receipt = path.join(receipts.root, launch.launchId, 'receipt.json');
  fs.renameSync(receipt, `${receipt}.old`);
  fs.writeFileSync(receipt, fs.readFileSync(`${receipt}.old`));
  assert.throws(() => receipts.launch(launch.launchId), /replaced/);
  assert.throws(() => receipts.launch('../unsafe'));
});
test('redirected receipt directories and private report aliases refuse', () => {
  const { receipts, launch, home } = fixture();
  const target = scratch('arc-dispatch-target-');
  const aliasDirectory = path.join(home, 'redirected');
  directoryLink(target, aliasDirectory);
  try {
    assert.throws(() => receipts.reserve({ ...launch, alias: path.join(aliasDirectory, 'report.md') }));
  } finally {
    fs.unlinkSync(aliasDirectory);
  }
  assert.throws(() => receipts.reserve({ ...launch, alias: path.join(receipts.root, 'alias.md') }));
  const directory = path.join(receipts.root, launch.launchId);
  fs.renameSync(directory, `${directory}.old`);
  directoryLink(`${directory}.old`, directory);
  try {
    assert.throws(() => receipts.launch(launch.launchId), /redirected|replaced/);
  } finally {
    fs.unlinkSync(directory);
  }
  assert.ok(fs.existsSync(home));
});
test('native successful completion waits for matching saved root evidence', () => {
  const { receipts, launch } = fixture();
  let saved: SavedDispatchResponse | null = null;
  const { host, child } = hosted(receipts, launch.launchId, () => saved);
  host.observe(child, { kind: 'text', text: 'Final', sourceId: 'response', nativeTurnId: turn }, 1);
  host.observe(child, { kind: 'native', event: { ...ending, sessionId: 'cccccccc-1111-2222-3333-444444444444' } }, 1);
  assert.equal(receipts.status(launch.launchId).events.length, 0);
  host.observe(child, { kind: 'native', event: ending }, 2);
  assert.equal(receipts.status(launch.launchId).events.length, 0);
  host.observe(child, { kind: 'native', event: ending }, 1);
  assert.equal(receipts.status(launch.launchId).events.at(-1)!.availability, 'pending');
  saved = savedResponse('Wrong');
  host.reconcileAll();
  assert.equal(receipts.status(launch.launchId).events.length, 1);
  saved.text = 'Final';
  host.reconcileAll();
  assert.equal(receipts.status(launch.launchId).events.at(-1)!.availability, 'available');
  host.observe(child, { kind: 'native', event: { ...ending, success: false } }, 1);
  assert.equal(receipts.status(launch.launchId).events.at(-1)!.outcome, 'succeeded');
});
test('native failure, input requests and unknown process exit remain distinct', () => {
  for (const mode of ['failed', 'needs-input', 'exit']) {
    const { receipts, launch } = fixture();
    const host = new HostedDispatch(receipts, () => savedResponse('Failure', { finished: false, failed: true }));
    const child = {
      key: mode,
      agent: 'codex',
      dispatchRootActive: () => true,
      state: () => ({ sessionId: session, exited: mode === 'exit' }),
    };
    host.register(launch.launchId, child);
    host.submitted(launch.launchId, 1);
    if (mode === 'failed') {
      host.observe(child, { kind: 'text', text: 'Failure', sourceId: 'response' }, 1);
      host.observe(child, { kind: 'native', event: { ...ending, success: false } }, 1);
      host.observe(
        child,
        { kind: 'turnEnd', outcome: { status: 'error', text: '', costUsd: null, turns: null, deniedTools: [] } },
        1,
      );
    } else if (mode === 'exit') host.exited(child);
    else
      host.observe(
        child,
        {
          kind: 'ask',
          ask: {
            kind: 'permission',
            id: 'ask',
            toolName: 'tool',
            displayName: 'Tool',
            description: '',
            toolUseId: '',
            input: {},
          },
        },
        undefined,
      );
    const event = receipts.status(launch.launchId).events.at(-1)!;
    assert.equal(event.outcome, mode === 'exit' ? 'unknown' : mode);
    if (mode !== 'failed') assert.equal(event.report, null);
  }
});
test('wait deadline and disconnection retain the exact worker and receipt', async () => {
  vi.useFakeTimers();
  const { receipts, launch } = fixture('wait');
  const { host, child } = hosted(receipts, launch.launchId, () => null, { submitted: false });
  const signal = new AbortController();
  const waited = host.wait(launch.launchId, 100, signal.signal);
  signal.abort();
  assert.deepEqual(await waited, {
    launchId: launch.launchId,
    state: 'uncertain',
    reason: 'The wait disconnected. Read dispatch status or recover this receipt.',
  });
  const deadline = host.wait(launch.launchId, 100, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(100);
  assert.equal(((await deadline) as { state: string }).state, 'deadline');
  assert.equal(receipts.launch(launch.launchId).launchId, launch.launchId);
  assert.throws(() => host.register(launch.launchId, child));
});
test('retained launches continue admission after 256 unconsumed receipts', () => {
  const { receipts, launch } = fixture();
  for (let index = 0; index < 256; index++) receipts.reserve(launch);
  assert.equal(receipts.launch(launch.launchId).launchId, launch.launchId);
  assert.equal(fs.readdirSync(receipts.root).filter((name) => !name.includes('.')).length, 257);
});

test('large dispositions never hide later event identities in bounded status pages', () => {
  const { receipts, launch } = fixture();
  const ids: string[] = [];
  for (let index = 0; index < 70; index++) {
    const event = report(receipts, launch.launchId, String(index));
    ids.push(event.eventId);
    const claim = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
    receipts.ack(launch.launchId, event.eventId, origin, 'owner', claim.token, '\u0001'.repeat(6000));
  }
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = receipts.status(launch.launchId, cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 48 * 1024);
    found.push(...page.events.map((event) => event.eventId));
    cursor = page.next ?? undefined;
  } while (cursor);
  assert.deepEqual(found, ids);
  assert.equal((receipts.result(launch.launchId, ids[0]) as any).consumption.disposition, '\u0001'.repeat(6000));
});

test.each(['hosted', 'standalone'] as const)(
  'exact-boundary %s launch keeps every status event readable',
  (transport) => {
    const { receipts, launch, home } = fixture();
    const input = {
      ...launch,
      transport,
      policy: { readOnly: true as const, readTools: [''] },
      ...(transport === 'standalone' ? { standalone: settings(home, unloggedAgentRun) } : {}),
    };
    const measured = receipts.reserve(input);
    input.policy.readTools[0] = 'x'.repeat(48 * 1024 - Buffer.byteLength(JSON.stringify(measured)));
    const large = receipts.reserve(input);
    assert.equal(Buffer.byteLength(JSON.stringify(large)), 48 * 1024);
    assert.deepEqual(receipts.launch(large.launchId), large);
    const empty = receipts.status(large.launchId);
    assert.ok(
      Buffer.byteLength(JSON.stringify(empty)) <= 44 * 1024,
      'an admitted launch needs a readable empty status',
    );
    if (transport === 'standalone') receipts.observation(large.launchId, largeObservation);
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const event = receipts.publish(
        large.launchId,
        {
          outcome: 'needs-input',
          availability: 'available',
          nativeEnding: ending,
          askId: 'a'.repeat(26 * 1024) + index,
        },
        'Original ' + index,
      );
      ids.push(event.eventId);
      const owner = 'o'.repeat(128);
      const claim = receipts.claim(large.launchId, event.eventId, origin, owner) as { token: string };
      receipts.ack(large.launchId, event.eventId, origin, owner, claim.token, 'Disposition ' + index);
    }
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = receipts.status(large.launchId, cursor, 128);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 44 * 1024);
      assert.ok(page.events.length > 0, 'the first accepted event must remain discoverable');
      assert.notEqual(page.next, cursor, 'a nonterminal status cursor must advance');
      assert.deepEqual(page.launch, {
        launchId: large.launchId,
        transport,
        origin,
        completion: large.completion,
      });
      if (transport === 'standalone') {
        assert.equal(page.observation!.sessionId, session);
        assert.equal(page.observation!.exitCode, 0);
        assert.equal(page.observation!.monitor, 'finished');
      }
      for (const event of page.events) {
        assert.equal(event.delivery, 'unavailable');
        assert.equal(event.consumption.dispositionSha256, payloadSha256('Disposition ' + ids.indexOf(event.eventId)));
      }
      assert.ok(page.reportSource);
      found.push(...page.events.map((event) => event.eventId));
      cursor = page.next ?? undefined;
      assert.ok(found.length <= ids.length);
    } while (cursor);
    assert.deepEqual(found, ids);
    assert.equal((receipts.result(large.launchId, ids[0]) as any).text, 'Original 0');
    assert.equal((receipts.result(large.launchId, ids[0]) as any).consumption.disposition, 'Disposition 0');
  },
);

test('first accepted event advances beside large readable launch and observation metadata', () => {
  const { receipts, standalone } = standaloneFixture({ ...unloggedAgentRun, args: ['x'.repeat(14 * 1024)] });
  receipts.observation(standalone.launchId, largeObservation);
  assert.ok(Buffer.byteLength(JSON.stringify(receipts.launch(standalone.launchId))) < 48 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(receipts.observation(standalone.launchId))) < 48 * 1024);
  const first = receipts.publish(
    standalone.launchId,
    {
      outcome: 'needs-input',
      availability: 'available',
      nativeEnding: ending,
      askId: 'a'.repeat(26 * 1024),
    },
    'First original',
  );
  const second = report(receipts, standalone.launchId, 'Second original');
  const page = receipts.status(standalone.launchId, undefined, 1);
  assert.deepEqual(
    page.events.map((event) => event.eventId),
    [first.eventId],
    'the first accepted event must remain discoverable',
  );
  assert.equal(page.next, `${standalone.launchId}:1`);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 44 * 1024);
  const next = receipts.status(standalone.launchId, page.next, 1);
  assert.deepEqual(
    next.events.map((event) => event.eventId),
    [second.eventId],
  );
  assert.equal(next.next, null);
  assert.equal((receipts.result(standalone.launchId, first.eventId) as any).text, 'First original');
});

test('unreadable observations leave the last readable observation intact', () => {
  const { receipts, standalone } = standaloneFixture(unloggedAgentRun);
  const observation = {
    supervisor: { pid: process.pid, token: 'f'.repeat(64) },
    worker: null,
    sessionId: null,
    exitCode: null,
    signal: null,
    monitor: 'starting' as const,
  };
  receipts.observation(standalone.launchId, observation);
  assert.throws(() =>
    receipts.observation(standalone.launchId, {
      ...observation,
      reason: 'x'.repeat(48 * 1024),
    }),
  );
  assert.deepEqual(receipts.observation(standalone.launchId), observation);
});

test('dead write owners allow exact claim recovery while live owners remain protected', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const first = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
  const lock = path.join(receipts.root, launch.launchId, 'write.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: turn, launchId: launch.launchId }));
  assert.equal((receipts.claim(launch.launchId, event.eventId, origin, 'owner') as any).token, first.token);
  fs.writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, token: 'dddddddd-1111-2222-3333-444444444444', launchId: launch.launchId }),
  );
  assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'owner'), /holds/);
  fs.unlinkSync(lock);
});

test('two stale recoverers cannot remove the newly acquired live owner or change a retained claim', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const claim = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
  const lock = path.join(receipts.root, launch.launchId, 'write.lock');
  const deadPid = 2147483647;
  const held = JSON.stringify({ pid: deadPid, token: turn, launchId: launch.launchId });
  fs.writeFileSync(lock, held);
  const successor = path.join(receipts.root, launch.launchId, `write.${turn}.next.lock`);
  const live = JSON.stringify({ pid: process.pid, token: session, launchId: launch.launchId });
  const link = fs.linkSync;
  const unlink = fs.unlinkSync;
  let interleaved = false;
  const recoverOther = () => {
    interleaved = true;
    // The other recoverer has already validated the same dead owner and now holds its successor.
    fs.writeFileSync(successor, live, { flag: 'wx' });
    fs.writeFileSync(lock, live);
  };
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === successor && !interleaved) recoverOther();
    return link(from, to);
  });
  vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    // A stale recoverer reaches removal after its final ownership check.
    if (String(file) === lock && !interleaved) recoverOther();
    return unlink(file);
  });
  syncBuiltinESMExports();
  assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'owner'));
  assert.equal(interleaved, true);
  assert.equal(fs.readFileSync(lock, 'utf8'), live);
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).consumption.owner, 'owner');
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.writeFileSync(path.join(receipts.root, launch.launchId, `write.${session}.released`), live);
  assert.equal((receipts.claim(launch.launchId, event.eventId, origin, 'owner') as any).token, claim.token);
});

test.each([1, 40])(
  'death after reserving %s recovery successors remains recoverable and uncertain owners remain protected',
  (count) => {
    const { receipts, launch } = fixture();
    const event = report(receipts, launch.launchId);
    const claim = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
    const directory = path.join(receipts.root, launch.launchId);
    let owner = { pid: 2147483647, token: turn, launchId: launch.launchId };
    fs.writeFileSync(path.join(directory, 'write.lock'), JSON.stringify(owner));
    for (let i = 0; i < count; i++) {
      const next = { ...owner, token: String(i).padStart(8, '0') + '-1111-2222-3333-444444444444' };
      fs.writeFileSync(path.join(directory, `write.${owner.token}.next.lock`), JSON.stringify(next));
      owner = next;
    }
    if (count > 32) assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'owner'), /Try again/);
    assert.equal((receipts.claim(launch.launchId, event.eventId, origin, 'owner') as any).token, claim.token);
    // Use a valid distinct owner token with an inaccessible process.
    fs.writeFileSync(
      path.join(directory, 'write.lock'),
      JSON.stringify({ pid: 2147483646, token: 'dddddddd-1111-2222-3333-444444444444', launchId: launch.launchId }),
    );
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'owner'), /holds/);
  },
);

test.each(['retry', 'conflict', 'replacement', 'redirect'] as const)(
  'accepted binding publication recovers only exact retained identity after witness failure: %s',
  (change) => {
    const { receipts, launch } = fixture();
    const binding = { provider: 'codex' as const, sessionId: session, submissionId: 1, nativeTurnId: turn };
    const accepted = path.join(receipts.root, launch.launchId, 'accepted.json');
    const witness = failWitness(receipts, launch.launchId);
    assert.throws(() => receipts.bind(launch.launchId, binding), /witness storage/);
    assert.ok(fs.existsSync(accepted));
    assert.equal(fs.existsSync(witness), false);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    if (change === 'replacement' || change === 'redirect') {
      fs.renameSync(accepted, accepted + '.old');
      if (change === 'replacement') fs.copyFileSync(accepted + '.old', accepted);
      else directoryLink(path.dirname(accepted), accepted);
    }
    if (change !== 'retry') {
      assert.throws(() =>
        receipts.bind(launch.launchId, change === 'conflict' ? { ...binding, nativeTurnId: 'foreign' } : binding),
      );
      if (change === 'redirect') fs.unlinkSync(accepted);
      return;
    }
    const reopened = new DispatchReceipts(path.dirname(receipts.root));
    assert.doesNotThrow(() => reopened.bind(launch.launchId, binding));
    assert.ok(fs.existsSync(witness));
    assert.doesNotThrow(() => reopened.bind(launch.launchId, binding));
  },
);

test('host reconciliation recovers a witness fault without another submission or worker', () => {
  const { receipts, launch } = fixture();
  const { host, child } = hosted(receipts, launch.launchId, () => savedResponse('Final'));
  const witness = failWitness(receipts, launch.launchId);
  host.accepted(launch.launchId, turn);
  host.observe(child, { kind: 'text', text: 'Final', sourceId: 'response' }, 1);
  host.observe(child, { kind: 'native', event: ending }, 1);
  assert.ok(fs.existsSync(path.join(receipts.root, launch.launchId, 'accepted.json')));
  assert.equal(fs.existsSync(witness), false);
  assert.equal(receipts.latest(launch.launchId), null);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  host.reconcileAll();
  assert.equal(receipts.latest(launch.launchId)!.availability, 'available');
  assert.equal((receipts.result(launch.launchId, receipts.latest(launch.launchId)!.eventId) as any).text, 'Final');
  host.reconcileAll();
  assert.equal(receipts.status(launch.launchId).events.length, 1);
});

test('receipt write errors preserve native observation and retry without repeating input', () => {
  const { receipts, launch } = fixture();
  const saved = savedResponse('Final', { promptId: 'turn-opaque' });
  const { host, child } = hosted(receipts, launch.launchId, () => saved);
  const bind = vi.spyOn(receipts, 'bind').mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  assert.doesNotThrow(() => host.accepted(launch.launchId, 'turn-opaque'));
  bind.mockRestore();
  host.observe(child, { kind: 'text', text: 'Final', sourceId: 'response' }, 1);
  const publish = vi.spyOn(receipts, 'publish').mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  assert.doesNotThrow(() => host.observe(child, { kind: 'native', event: { ...ending, turnId: 'turn-opaque' } }, 1));
  assert.equal(receipts.status(launch.launchId).events.length, 0);
  publish.mockRestore();
  host.reconcileAll();
  assert.equal(receipts.latest(launch.launchId)!.availability, 'available');
  assert.equal(receipts.latest(launch.launchId)!.outcome, 'succeeded');
});

test('interrupted native endings agree with interrupted saved evidence without becoming failed', () => {
  const { receipts, launch } = fixture();
  const { host, child } = hosted(receipts, launch.launchId, () => savedResponse('Partial', { interrupted: true }));
  host.observe(child, { kind: 'text', text: 'Partial', sourceId: 'response' }, 1);
  host.observe(child, { kind: 'native', event: { ...ending, success: false } }, 1);
  assert.equal(receipts.latest(launch.launchId), null);
  host.observe(
    child,
    { kind: 'turnEnd', outcome: { status: 'interrupted', text: '', costUsd: null, turns: null, deniedTools: [] } },
    1,
  );
  assert.equal(receipts.latest(launch.launchId)!.outcome, 'interrupted');
  assert.equal(receipts.latest(launch.launchId)!.availability, 'available');
});

test('startup error observation and subsequent child exit publish one unknown event', () => {
  const { receipts, launch } = fixture();
  const { host, child } = hosted(receipts, launch.launchId, () => null, { exited: true, submitted: false });
  host.unavailable(launch.launchId);
  host.exited(child);
  assert.equal(receipts.status(launch.launchId).events.length, 1);
});

test.each(['claude', 'codex'] as const)(
  'complete large %s evidence retains root identity and full final response',
  (agent) => {
    const { receipts, launch, home } = fixture();
    const { rows, source } = sessionSource(home, agent, 'First\nSecond', 'root-turn', {
      parts: ['First', ' ', 'Second'],
      padding: true,
    });
    let saved: SavedDispatchResponse | null = null;
    for (let attempts = 0; attempts < 100 && !saved; attempts++)
      saved = savedDispatchResponse(source, agent === 'claude' ? '1' : 'root-turn');
    assert.ok(saved);
    assert.equal(saved.text, agent === 'claude' ? 'First\n \nSecond' : 'First\nSecond');
    assert.equal(saved.prompt, 'review');
    assert.equal(saved.finished, true);
    if (agent === 'claude') assert.deepEqual(saved.responseIds, ['response']);
    const { host, child } = hosted(receipts, launch.launchId, () => saved, { agent });
    if (agent === 'claude') {
      const wire = new ClaudeWire({
        send: () => {},
        emit: (event) => host.observe(child, event, 1),
        sessionId: session,
      });
      wire.receive(JSON.stringify({ ...rows.at(-1), session_id: session }));
    } else host.observe(child, { kind: 'text', text: 'First\nSecond', sourceId: 'response' }, 1);
    host.observe(
      child,
      {
        kind: 'native',
        event:
          agent === 'claude'
            ? { ...ending, provider: 'claude', turnId: null, generation: 1 }
            : { ...ending, turnId: 'root-turn' },
      },
      1,
    );
    assert.equal(receipts.latest(launch.launchId)!.availability, 'available');
    assert.equal(fs.readFileSync(receipts.latest(launch.launchId)!.report!.path, 'utf8'), saved.text);
    assert.equal(savedDispatchResponse(source, agent === 'claude' ? '2' : 'foreign-turn'), null);
  },
);

test.each(
  (['claude', 'codex'] as const).flatMap((agent) => [
    { agent, escaping: 'backslash', character: 92, bytes: 4 * 1024 * 1024 + 1 },
    { agent, escaping: 'six-to-one', character: 1, bytes: 8 * 1024 * 1024 },
  ]),
)(
  'escaped $agent $escaping final response above four MiB survives bounded saved recovery',
  ({ agent, character, bytes }) => {
    const { receipts, launch, home } = fixture();
    const text = String.fromCharCode(character).repeat(bytes);
    const { rows, source, encoded } = sessionSource(home, agent, text, turn);
    const native = agent === 'claude' ? '1' : turn;
    let saved: SavedDispatchResponse | null = null;
    const readCallBudget = Math.ceil(Buffer.byteLength(encoded) / SESSION_READ_LIMITS.bytes) + rows.length + 1;
    for (let attempts = 0; attempts < readCallBudget && !saved; attempts++)
      saved = savedDispatchResponse(source, native);
    assert.ok(saved);
    assert.equal(saved.text.length, text.length);
    assert.equal(saved.text, text);
    assert.equal(saved.finished, true);
    if (agent === 'claude') assert.deepEqual(saved.responseIds, ['response']);
    else assert.equal(saved.promptId, turn);
    const { host, child } = hosted(receipts, launch.launchId, () => saved, { agent });
    host.observe(child, { kind: 'text', text, sourceId: 'response' }, 1);
    host.observe(
      child,
      {
        kind: 'native',
        event: agent === 'claude' ? { ...ending, provider: 'claude', turnId: null, generation: 1 } : ending,
      },
      1,
    );
    const event = receipts.latest(launch.launchId)!;
    assert.equal(event.availability, 'available');
    assert.equal(event.report!.bytes, Buffer.byteLength(text));
    assert.equal(fs.readFileSync(event.report!.path, 'utf8'), text);
  },
);

test.each([
  ['win32', 'C:\\Private\\dispatch', 'D:\\Reports\\result.md', true],
  ['win32', 'C:\\Private\\dispatch', 'c:\\private\\dispatch\\result.md', false],
  ['darwin', '/private/var/Arc/dispatch', '/private/var/Arc/dispatch/result.md', false],
  ['darwin', '/private/var/Arc/dispatch', '/Users/Reader/Reports/result.md', true],
  ['linux', '/home/reader/.arc/dispatch', '/home/reader/.arc/dispatch/result.md', false],
  ['linux', '/home/reader/.arc/dispatch', '/home/reader/reports/result.md', true],
] as const)('report aliases retain independent %s admission for %s and %s', (platform, root, alias, expected) => {
  assert.equal(outsideDispatchStorage(root, alias, platform), expected);
});

test('physical private parents refuse case variants and replaced private sources refuse refresh', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const candidate = path.join(receipts.root.toUpperCase(), 'report.md');
  if (fs.existsSync(path.dirname(candidate)))
    assert.throws(() => receipts.reserve({ ...launch, alias: candidate }), /private dispatch/);
  const source = receipts.status(launch.launchId).reportSource!;
  fs.renameSync(source, source + '.old');
  fs.writeFileSync(source, 'Replaced');
  assert.throws(() => receipts.refresh(launch.launchId), /replaced/);
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
});

test('trusted system temp roots resolve their physical parents without admitting private aliases', () => {
  const { receipts, launch, home } = fixture();
  const aliasHome = scratch('arc-system-temp-');
  const aliasDirectory = path.join(aliasHome, 'temp');
  directoryLink(home, aliasDirectory);
  const temporary = vi.spyOn(os, 'tmpdir').mockReturnValue(aliasDirectory);
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => receipts.reserve({ ...launch, alias: path.join(aliasDirectory, 'report.md') }));
    assert.throws(
      () => receipts.reserve({ ...launch, alias: path.join(aliasDirectory, 'dispatch', 'report.md') }),
      /private dispatch/,
    );
  } finally {
    temporary.mockRestore();
    syncBuiltinESMExports();
    fs.unlinkSync(aliasDirectory);
  }
});

test.each(['darwin', 'linux', 'win32'] as const)(
  'canonical /tmp admission retains independent %s expectations with configured temp elsewhere',
  (platform) => {
    const stat = fs.lstatSync;
    const realpath = fs.realpathSync.native;
    vi.spyOn(os, 'tmpdir').mockReturnValue(platform === 'win32' ? 'C:\\ConfiguredTemp' : '/configured/temp');
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: any, options: any) => {
      if (String(file) === '/tmp') return { isSymbolicLink: () => true };
      if (String(file).startsWith('/tmp/')) return { isSymbolicLink: () => String(file).includes('redirected') };
      if (String(file) === 'C:\\tmp') return { isSymbolicLink: () => true };
      if (String(file) === 'C:\\tmp\\reports') return { isSymbolicLink: () => false };
      return stat(file, options);
    }) as typeof fs.lstatSync);
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((file) =>
      String(file) === '/tmp' ? '/private/tmp' : realpath(file),
    );
    syncBuiltinESMExports();
    if (platform === 'darwin') {
      assert.doesNotThrow(() => safeDispatchPath('/tmp/reports', platform));
      assert.throws(() => safeDispatchPath('/tmp/redirected', platform), /redirected/);
      vi.spyOn(fs.realpathSync, 'native').mockReturnValue('/mutable/elsewhere');
      assert.throws(() => safeDispatchPath('/tmp/reports', platform), /redirected/);
    } else
      assert.throws(
        () => safeDispatchPath(platform === 'win32' ? 'C:\\tmp\\reports' : '/tmp/reports', platform),
        /redirected/,
      );
  },
);
