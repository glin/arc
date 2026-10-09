import { revisionOf } from './transcript';
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import {
  ProgressiveWorker,
  CommitRepositoryReservations,
  RAIL_ENRICHMENT_READ_BYTES,
  acceptsProgressiveResult,
  metadataReadBudget,
  preservesLoadedHistory,
  sameProgressiveRevision,
  type ProgressiveInput,
  type ProgressiveCheckpoint,
  type ProgressiveResult,
} from './progressiveworker';
import {
  readSession,
  normalizeFsPath,
  sessionOutcomeOf,
  sessionStatFactsOf,
  type AgentKind,
  type SessionRead,
  type Turn,
} from './transcript';
import { readCodexSession } from './codex';
import { scanCodexDispatchReferences } from './codex';
import { railCacheMarkOf } from './turnrail';
import { logOf, toCard, turnCost } from './turncard';
import { codexAgentSpendVersion, codexSpendIndex, type CodexSubagentFile } from './codex';
import { agentSpendDependencyKey } from './transcript';
import { openSpendBand } from './agentspend';
import {
  readClaudeSessionIncremental,
  readClaudeSessionIncrementalAsync,
  readClaudeHistoryPageAsync,
  recoverClaudeAttachmentSlice,
  type ClaudeForwardCheckpoint,
} from './claudehistory';
import {
  readCodexSessionIncremental,
  readCodexSessionIncrementalAsync,
  type CodexForwardCheckpoint,
  COMMIT_REPOSITORY_PARSER_VERSION,
} from './codexhistory';
import {
  codexContextRecords,
  claudeDispatchTranscript,
  powershellDispatchExecution,
  throughStructuredClone,
  worktreeCreationCommand,
} from './turnfixtures';

test('commit ownership reservations survive changed relationships and parser generations without refunds', () => {
  const parent = { file: 'parent', sessionId: 'parent', revision: { dev: 1, ino: 1, size: 100, mtimeMs: 1 } };
  const child = { file: 'child', sessionId: 'child', revision: { dev: 1, ino: 2, size: 100, mtimeMs: 1 } };
  const ledger = new CommitRepositoryReservations();
  for (let attempt = 0; attempt < 128; attempt++) {
    const allowance = ledger.reserve(
      { ...parent, sessionId: String(attempt) },
      { ...child, file: 'changed-path-' + attempt },
    );
    assert.equal(allowance.parentBytes + allowance.childBytes, 1024 * 1024);
  }
  assert.equal(ledger.bytes(parent), 64 * 1024 * 1024);
  assert.deepEqual(ledger.reserve(parent, child), { parentBytes: 0, childBytes: 0 });
  assert.equal(
    ledger.reserve({ ...parent, revision: { ...parent.revision, size: 101 } }, child).parentBytes,
    512 * 1024,
  );
});

test(
  'cancelled commit ownership reads exhaust host reservations across replacement workers',
  { timeout: 90_000 },
  async () => {
    const directory = tempDir('commit-worker-cancel-');
    const parentFile = path.join(directory, 'parent.jsonl');
    const childFile = path.join(directory, 'child.jsonl');
    const marker = path.join(directory, 'reading');
    fs.writeFileSync(parentFile, '{"type":"session_meta","payload":{"id":"parent"}}\n');
    fs.writeFileSync(childFile, '{"type":"session_meta","payload":{"id":"child","parent_thread_id":"parent"}}\n');
    const sourceOf = (file: string, sessionId: string) => {
      const { size, mtimeMs, dev, ino } = revisionOf(fs.statSync(file, { bigint: true }));
      return { file, sessionId, revision: { size, mtimeMs, dev, ino } };
    };
    const parent = sourceOf(parentFile, 'parent');
    const child = sourceOf(childFile, 'child');
    const ledger = new CommitRepositoryReservations();
    const prelude = `const blockingFs=require('node:fs'); const originalRead=blockingFs.readSync; blockingFs.readSync=function(...args){const bytes=originalRead.apply(this,args);blockingFs.writeFileSync(${JSON.stringify(marker)},'reading');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return bytes;};`;
    for (let attempt = 0; attempt < 128; attempt++) {
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
      const worker = new ProgressiveWorker(prelude + source);
      const controller = new AbortController();
      const allowance = ledger.reserve(parent, child);
      const pending = worker.run(
        {
          kind: 'commit-repositories',
          parent,
          child,
          commits: [],
          parserVersion: COMMIT_REPOSITORY_PARSER_VERSION,
          token: null,
          ...allowance,
        },
        attempt,
        controller.signal,
      );
      await vi.waitFor(() => assert.ok(fs.existsSync(marker)), { timeout: 5000, interval: 1 });
      controller.abort();
      assert.equal(await pending, null);
      worker.stop();
    }
    assert.equal(ledger.bytes(parent), 64 * 1024 * 1024);
    assert.deepEqual(ledger.reserve(parent, child), { parentBytes: 0, childBytes: 0 });
  },
);

test('commit ownership workers resume a parent across children and reject changed source revisions', async () => {
  const directory = tempDir('commit-worker-');
  const parentFile = path.join(directory, 'parent.jsonl');
  const childFile = path.join(directory, 'child.jsonl');
  const record = (type: string, payload: object) =>
    JSON.stringify({ type, timestamp: '2026-08-25T12:00:00Z', payload }) + '\n';
  const command = worktreeCreationCommand(['C:/first']);
  fs.writeFileSync(
    parentFile,
    record('session_meta', { id: 'parent' }) +
      record('event_msg', { type: 'task_started', turn_id: 'parent-turn' }) +
      record('turn_context', { turn_id: 'parent-turn', current_date: '2026-08-25' }) +
      record('ignored', { padding: 'x'.repeat(2 * 1024 * 1024) }) +
      record('event_msg', {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          command: ['powershell.exe', '-Command', command],
          parsed_cmd: [{ cmd: command }],
          cwd: 'file:///C:/outer',
          stdout: '',
          status: 'completed',
          exit_code: 0,
          started_at_ms: 1,
          completed_at_ms: 2,
        },
      }),
  );
  const hash = 'a'.repeat(40);
  const epoch = Date.parse('2026-08-25T12:00:00Z');
  const writeChild = (id: string) =>
    fs.writeFileSync(
      childFile,
      record('session_meta', { id, parent_thread_id: 'parent' }) +
        record('event_msg', { type: 'task_started', turn_id: 'child-turn' }) +
        record('turn_context', { turn_id: 'child-turn', current_date: '2026-08-25' }) +
        record('event_msg', {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            command: ['powershell.exe', '-Command', 'git commit -m recorded'],
            parsed_cmd: [{ cmd: 'git commit -m recorded' }],
            cwd: 'file:///C:/outer',
            stdout: `[main ${hash.slice(0, 7)}] Recorded`,
            status: 'completed',
            exit_code: 0,
            started_at_ms: epoch + 2,
            completed_at_ms: epoch + 3,
          },
        }) +
        record('event_msg', {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            command: ['powershell.exe', '-Command', 'python report.py'],
            parsed_cmd: [{ cmd: 'python report.py' }],
            cwd: 'file:///C:/outer',
            stdout: JSON.stringify({ sha: hash, repository: 'C:/first/.claude/worktrees/worker' }),
            status: 'completed',
            exit_code: 0,
            started_at_ms: 3,
            completed_at_ms: 4,
          },
        }),
    );
  writeChild('child');
  const sourceOf = (file: string, sessionId: string) => {
    const { size, mtimeMs, dev, ino } = revisionOf(fs.statSync(file, { bigint: true }));
    return { file, sessionId, revision: { size, mtimeMs, dev, ino } };
  };
  const ledger = new CommitRepositoryReservations();
  const worker = new ProgressiveWorker(source);
  fs.writeFileSync(
    childFile,
    fs
      .readFileSync(childFile, 'utf8')
      .replace('"started_at_ms":3', '"started_at_ms":' + (epoch + 3))
      .replace('"completed_at_ms":4', '"completed_at_ms":' + (epoch + 4)),
  );
  let request = {
    kind: 'commit-repositories' as const,
    parent: sourceOf(parentFile, 'parent'),
    child: sourceOf(childFile, 'child'),
    commits: [
      {
        sha: hash,
        at: epoch + 3,
        evidenceAt: epoch + 4,
        dirs: ['C:/first/.claude/worktrees/worker'],
        turnId: 'child-turn',
      },
    ],
    parserVersion: COMMIT_REPOSITORY_PARSER_VERSION,
    token: null as string | null,
    parentBytes: 0,
    childBytes: 0,
  };
  try {
    let result;
    for (let attempt = 0; attempt < 16; attempt++) {
      request = { ...request, ...ledger.reserve(request.parent, request.child) };
      result = await worker.run(request, attempt, new AbortController().signal);
      assert.ok(result?.value.kind === 'commit-repositories');
      assert.ok(result.value.readBytes.parent + result.value.readBytes.child <= 1024 * 1024);
      if (result.value.status !== 'pending') break;
      request.token = result.value.token;
    }
    assert.ok(result?.value.kind === 'commit-repositories');
    assert.equal(result.value.status, 'complete');
    assert.equal(result.value.targets[0].dirs[0], 'C:/first');
    writeChild('second-child');
    fs.writeFileSync(
      childFile,
      fs
        .readFileSync(childFile, 'utf8')
        .replace('"started_at_ms":3', '"started_at_ms":' + (epoch + 3))
        .replace('"completed_at_ms":4', '"completed_at_ms":' + (epoch + 4)),
    );
    request = {
      ...request,
      child: sourceOf(childFile, 'second-child'),
      token: null,
      ...ledger.reserve(request.parent, sourceOf(childFile, 'second-child')),
    };
    const shared = await worker.run(request, 20, new AbortController().signal);
    assert.ok(shared?.value.kind === 'commit-repositories');
    assert.equal(shared.value.status, 'complete');
    assert.equal(shared.value.readBytes.parent, 0, 'the complete parent was reread for another child');
    fs.appendFileSync(parentFile, record('ignored', {}));
    const stale = await worker.run(request, 21, new AbortController().signal);
    assert.ok(stale?.value.kind === 'commit-repositories');
    assert.equal(stale.value.status, 'stale');
    assert.deepEqual(stale.value.targets, []);
  } finally {
    worker.stop();
  }
});
import {
  CLAUDE_METADATA_TAIL_BYTES,
  CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
  VERSION,
  carryAgentRunScan,
  loadDerivedCache,
  limitCodexDispatchCursors,
  railEnrichmentNeeds,
  saveDerivedCache,
  scanKeptThroughGrowth,
  withAgentRunScanProgress,
  withRailEnrichment,
  withMetadataCoverage,
  type DerivedTitleEntry,
} from './derivedcache';
import {
  MAX_CLAUDE_CHILD_REFERENCES_PER_FILE,
  MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT,
  scanForAgentRun,
} from './transcript';
import { railBuckets } from './view/rail';
import { beginForwardSessionRecovery } from './history';
import { createCodexSessionReducer, codexSessionLineMayAffectRead } from './codex';
import { estimateCost } from './pricing';

// Measure actual read counts for parent rescans and use a second root to check unrelated rejection.
test('a new Claude session reaches a complete cut beside parent growth with bounded append reads', async () => {
  const directory = tempDir('claude-changed-catalog-');
  const file = path.join(directory, 'parent.jsonl');
  const quiet = path.join(directory, 'quiet.jsonl');
  const fresh = path.join(directory, 'fresh.jsonl');
  const arm = path.join(directory, 'grow');
  fs.writeFileSync(file, '{"type":"ignored","padding":"' + 'x'.repeat(3 * 1024 * 1024) + '"}\n');
  fs.writeFileSync(quiet, '{"type":"ignored"}\n');
  const prelude = `const countFs = require('node:fs'); const originalOpen = countFs.openSync; const originalRead = countFs.readSync;
    const files = new Map(); const bytes = {}; countFs.openSync = function(file,...rest) { const fd=originalOpen.call(this,file,...rest); files.set(fd,String(file)); return fd; };
    countFs.readSync = function(fd,...rest) { const count=originalRead.call(this,fd,...rest); const file=files.get(fd); bytes[file]=(bytes[file]||0)+count;
      if(file===${JSON.stringify(file)} && countFs.existsSync(${JSON.stringify(arm)})) { countFs.unlinkSync(${JSON.stringify(arm)}); countFs.appendFileSync(file,'{"type":"ignored"}\\n'); } return count; };
    const port=require('node:worker_threads').parentPort; const post=port.postMessage; port.postMessage=function(message) { if(message.result) message.result.bytes={...bytes}; return post.call(this,message); };`;
  const worker = new ProgressiveWorker(prelude + source);
  const session = (file: string) => {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { file, agent: 'claude' as const, sessionId: path.basename(file), size: stat.size, mtimeMs: stat.mtimeMs };
  };
  try {
    let result;
    for (let pass = 0; pass < 30; pass++) {
      result = await worker.run(
        { kind: 'claude-children', parents: [session(file), session(quiet)], repositoryRoots: [directory] },
        pass,
        new AbortController().signal,
      );
      assert.ok(result && result.value.kind !== 'stale');
      if (result.value.kind === 'claude-children') break;
    }
    assert.ok(result?.value.kind === 'claude-children');
    const before = (result as typeof result & { bytes: Record<string, number> }).bytes;
    const firstOffset = result.value.referenceEntries.find(([, entry]) => entry.sessionId === path.basename(file))![1]
      .claudeCursor!.offset;
    fs.appendFileSync(file, '{"type":"ignored"}\n');
    fs.writeFileSync(fresh, '{"type":"user","cwd":"C:/repo"}\n');
    fs.writeFileSync(arm, 'armed');
    let appendQuanta = 0;
    for (let pass = 0; pass < 80; pass++) {
      result = await worker.run(
        {
          kind: 'claude-children',
          parents: [session(file), session(quiet), session(fresh)],
          repositoryRoots: [directory],
        },
        40,
        new AbortController().signal,
      );
      assert.ok(
        result && (result.value.kind === 'claude-children-progress' || result.value.kind === 'claude-children'),
      );
      assert.ok(result.value.charges!.readBytes <= 8 * 1024 * 1024);
      assert.ok(result.value.charges!.quanta <= 8);
      appendQuanta += result.value.charges!.quanta;
      const cursor = result.value.referenceEntries.find(([, entry]) => entry.sessionId === path.basename(file))?.[1]
        .claudeCursor;
      assert.ok(cursor && cursor.offset >= firstOffset, 'append validation restarted parsing');
      if (result.value.kind === 'claude-children') break;
    }
    assert.ok(result?.value.kind === 'claude-children');
    assert.ok(appendQuanta > 1);
    const after = (result as typeof result & { bytes: Record<string, number> }).bytes;
    assert.ok(after[file] - before[file] >= firstOffset, 'append qualification omitted consumed bytes');
    assert.equal(after[quiet], before[quiet], 'the quiet parent reread content');
    assert.ok(after[fresh] > 0, 'the new session never entered the captured inputs');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Recovery must preserve unmatched launches, not just rediscover an empty source.
test('acknowledged Claude discovery resumes after worker restart while metadata remains serviceable', async () => {
  const directory = tempDir('claude-discovery-restart-');
  const file = path.join(directory, 'parent.jsonl');
  fs.writeFileSync(
    file,
    [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'launch', name: 'Agent' }] } },
      { type: 'ignored', text: 'x'.repeat(600000) },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
        toolUseResult: { agentId: 'child' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const session = { file, sessionId: 'parent', agent: 'claude' as const, size: stat.size, mtimeMs: stat.mtimeMs };
  let worker = new ProgressiveWorker('performance.now = () => 0;' + source);
  let entries: Array<[string, import('./derivedcache').ClaudeChildReferenceCacheEntry]> = [];
  let checkpoint: import('./progressiveworker').DiscoveryCheckpoint | undefined;
  let previous = 0;
  try {
    for (let pass = 0; pass < 30; pass++) {
      const result = await worker.run(
        {
          kind: 'claude-children',
          parents: [session],
          repositoryRoots: [directory],
          referenceEntries: entries,
          discovery: checkpoint,
          quantumBytes: 65536,
        },
        pass,
        new AbortController().signal,
      );
      assert.ok(
        result && (result.value.kind === 'claude-children-progress' || result.value.kind === 'claude-children'),
      );
      entries = result.value.referenceEntries;
      const offset = entries[0][1].claudeCursor!.offset;
      assert.ok(offset > previous, 'a worker restart discarded acknowledged source bytes');
      previous = offset;
      if (result.value.kind === 'claude-children') {
        assert.equal(result.value.references[0].sessionId, 'child');
        return;
      }
      checkpoint = result.value.checkpoint;
      assert.equal('references' in result.value, false);
      const metadata = await worker.run({ kind: 'metadata', session }, pass, new AbortController().signal);
      assert.ok(metadata?.value.kind === 'metadata');
      const cache = path.join(directory, 'cache.json');
      saveDerivedCache(cache, [], entries, [], undefined, checkpoint);
      const restored = loadDerivedCache(cache);
      entries = [...restored.claudeChildReferences];
      checkpoint = restored.discovery;
      worker.stop();
      worker = new ProgressiveWorker('performance.now = () => 0;' + source);
    }
    assert.fail('acknowledged discovery never reached its fixed target');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded Claude discovery visits all roots and serves selected history during catalog quanta', async () => {
  const directory = tempDir('claude-fair-discovery-');
  const parents = Array.from({ length: 1100 }, (_, index) => {
    const file = path.join(directory, `${index}.jsonl`);
    fs.writeFileSync(file, '{"type":"user","message":{"content":"hello"}}\n');
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { file, sessionId: String(index), agent: 'claude' as const, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const worker = new ProgressiveWorker('performance.now = () => 0;' + source);
  try {
    let previous = new Map<string, number>();
    let total = 0;
    let progressMessages = 0;
    let rootRows = 0;
    let completedPaths = 0;
    let checkpointJsonBytes = 0;
    let entryJsonBytes = 0;
    let checkpoint: import('./progressiveworker').DiscoveryCheckpoint | undefined;
    for (let pass = 0; pass < Math.ceil(parents.length / 8) + 5; pass++) {
      let discoverySettled = false;
      const discovery = worker.run(
        {
          kind: 'claude-children',
          parents,
          repositoryRoots: [directory],
          discovery: checkpoint,
          discoveryBytes: 65536,
        },
        pass,
        new AbortController().signal,
        ({ value }) => {
          assert.equal(value.kind, 'claude-children-delta');
          if (value.kind !== 'claude-children-delta') return;
          progressMessages++;
          rootRows += (value.checkpoint?.parents.length ?? 0) + (value.checkpoint?.catalog.length ?? 0);
          completedPaths += (value.checkpoint?.completed.length ?? 0) + value.completed.length;
          checkpointJsonBytes += Buffer.byteLength(JSON.stringify({ ...value, referenceEntries: undefined }));
          entryJsonBytes += Buffer.byteLength(JSON.stringify(value.referenceEntries));
        },
      );
      void discovery.then(() => {
        discoverySettled = true;
      });
      const history = worker.run(
        {
          kind: 'window',
          input: { session: parents[0], folders: [directory], children: [], maxTurns: 40, tailBytes: 65536 },
        },
        pass,
        new AbortController().signal,
      );
      assert.equal((await history)?.value.kind, 'window');
      assert.equal(discoverySettled, false, 'selected history waited until the catalog request ended');
      const result = await discovery;
      assert.ok(
        result && (result.value.kind === 'claude-children-progress' || result.value.kind === 'claude-children'),
      );
      assert.ok(result.value.charges!.readBytes <= 65536);
      total += result.value.charges!.quanta;
      checkpoint = result.value.checkpoint;
      for (const [file, entry] of result.value.referenceEntries) {
        assert.ok(entry.claudeCursor!.offset >= (previous.get(file) ?? 0));
        previous.set(file, entry.claudeCursor!.offset);
      }
      if (result.value.kind === 'claude-children') {
        assert.equal(previous.size, parents.length);
        assert.equal(total, parents.length, 'quiet completed roots were rescanned');
        assert.equal(progressMessages, parents.length, 'a completed source quantum lost its acknowledgment');
        assert.ok(rootRows <= 4 * parents.length, 'source acknowledgments replayed the frozen root catalog');
        assert.ok(completedPaths <= 2 * parents.length, 'source acknowledgments replayed completed paths');
        assert.ok(
          checkpointJsonBytes <= 4 * entryJsonBytes,
          'source acknowledgment envelopes exceeded a linear payload bound',
        );
        return;
      }
      assert.equal('children' in result.value, false);
    }
    assert.fail('a finite source set never reached complete membership');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['deleted', 'unreachable'] as const)(
  'a %s protected Claude source releases a colliding unfinished root',
  async (change) => {
    const directory = tempDir('claude-protected-release-');
    const files = ['protected', 'waiting'].map((name) => path.join(directory, name + '.jsonl'));
    for (const file of files)
      fs.writeFileSync(file, JSON.stringify({ type: 'ignored', text: 'x'.repeat(600000) }) + '\n');
    const parents = files.map((file) => {
      const stat = revisionOf(fs.statSync(file, { bigint: true }));
      return { file, sessionId: path.basename(file), agent: 'claude' as const, size: stat.size, mtimeMs: stat.mtimeMs };
    });
    let worker = new ProgressiveWorker('performance.now = () => 0;' + source);
    const request = { kind: 'claude-children' as const, parents, repositoryRoots: [directory], quantumBytes: 65536 };
    try {
      let checkpoint: import('./progressiveworker').DiscoveryCheckpoint | undefined;
      let entries: Array<[string, import('./derivedcache').ClaudeChildReferenceCacheEntry]> = [];
      for (let pass = 0; pass < 10; pass++) {
        const result = await worker.run(request, pass, new AbortController().signal);
        assert.ok(result?.value.kind === 'claude-children-progress');
        checkpoint = result.value.checkpoint;
        entries = result.value.referenceEntries;
        if (checkpoint.protectedFile) break;
      }
      assert.ok(checkpoint?.protectedFile);
      const protectedFile = checkpoint.protectedFile;
      const waiting = parents.find((parent) => normalizeFsPath(parent.file) !== protectedFile)!;
      assert.ok(entries.find(([file]) => file === normalizeFsPath(waiting.file))!.at(1));
      const prior = entries.find(([file]) => file === normalizeFsPath(waiting.file))![1].claudeCursor!.offset;
      assert.ok(prior < waiting.size);
      if (change === 'deleted')
        fs.unlinkSync(parents.find((parent) => normalizeFsPath(parent.file) === protectedFile)!.file);
      else {
        // A surviving root has no accepted path to the protected source after rebuilding.
        checkpoint.parents = [waiting];
        checkpoint.catalog = [waiting];
        worker.stop();
        worker = new ProgressiveWorker('performance.now = () => 0;' + source);
      }
      const result = await completeDiscovery(
        worker,
        {
          ...request,
          parents: change === 'deleted' ? parents : [waiting],
          discovery: checkpoint,
          referenceEntries: entries,
        },
        20,
        new AbortController().signal,
      );
      assert.ok(result?.value.kind === 'claude-children', 'the protected source blocked the waiting root');
      const resumed = result.value.referenceEntries.find(([file]) => file === normalizeFsPath(waiting.file))![1];
      assert.equal(resumed.claudeCursor!.offset, waiting.size);
      assert.ok(resumed.claudeCursor!.offset > prior);
      assert.equal(result.value.checkpoint?.protectedFile, undefined);
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('a completed Claude quantum survives cancellation before a later colliding source finishes', async () => {
  const directory = tempDir('claude-quantum-ack-');
  const files = ['first', 'later'].map((name) => path.join(directory, name + '.jsonl'));
  for (const file of files)
    fs.writeFileSync(file, JSON.stringify({ type: 'ignored', text: 'x'.repeat(2 * 1024 * 1024) }) + '\n');
  const parents = files.map((file) => {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { file, sessionId: path.basename(file), agent: 'claude' as const, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  let worker = new ProgressiveWorker('performance.now = () => 0;' + source);
  let acknowledged:
    | Extract<import('./progressiveworker').ProgressiveValue, { kind: 'claude-children-delta' }>
    | undefined;
  const controller = new AbortController();
  try {
    const result = await worker.run(
      { kind: 'claude-children', parents, repositoryRoots: [directory], quantumBytes: 65536 },
      1,
      controller.signal,
      (result) => {
        assert.equal(result.value.kind, 'claude-children-delta');
        if (result.value.kind !== 'claude-children-delta') return;
        acknowledged = result.value;
        controller.abort();
      },
    );
    assert.equal(result, null, 'the later source finished before cancellation');
    assert.ok(acknowledged, 'the worker lost its completed quantum');
    assert.equal(acknowledged.charges.quanta, 1);
    assert.equal(acknowledged.referenceEntries.length, 1, 'an acknowledgment replayed unrelated retained source state');
    assert.ok(acknowledged.checkpoint);
    const checkpoint = {
      ...acknowledged.checkpoint,
      sequence: acknowledged.sequence,
      position: acknowledged.position,
      protectedFile: acknowledged.protectedFile,
      completed: acknowledged.completed.filter(([, complete]) => complete).map(([file]) => file),
    };
    const [file, entry] = acknowledged.referenceEntries[0];
    const previous = entry.claudeCursor!.offset;
    assert.ok(previous > 0);
    worker.stop();
    worker = new ProgressiveWorker('performance.now = () => 0;' + source);
    let advanced = false;
    for (let pass = 0; pass < 10; pass++) {
      const resumed = await worker.run(
        {
          kind: 'claude-children',
          parents,
          repositoryRoots: [directory],
          referenceEntries: acknowledged.referenceEntries,
          discovery: checkpoint,
          quantumBytes: 65536,
          discoveryBytes: pass === 0 ? 65536 : undefined,
        },
        2 + pass,
        new AbortController().signal,
        (result) => {
          assert.equal(result.value.kind, 'claude-children-delta');
          if (result.value.kind !== 'claude-children-delta') return;
          const next = result.value.referenceEntries.find(([key]) => key === normalizeFsPath(file))?.[1];
          if (!next || advanced) return;
          assert.ok(next.claudeCursor!.offset > previous, 'termination discarded acknowledged bytes');
          assert.equal(next.sourceGeneration, entry.sourceGeneration);
          advanced = true;
        },
      );
      assert.ok(resumed?.value.kind === 'claude-children-progress');
      const retained = resumed.value.referenceEntries.find(([key]) => key === normalizeFsPath(file))?.[1];
      assert.ok(retained, 'termination discarded the acknowledged source');
      assert.ok(retained.claudeCursor!.offset >= previous, 'termination discarded acknowledged bytes');
      assert.equal(retained.sourceGeneration, entry.sourceGeneration);
      if (pass === 0) assert.equal(retained.claudeCursor!.offset, previous);
      if (advanced) break;
    }
    assert.ok(advanced, 'the acknowledged source never resumed');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a detected larger same-inode Claude rewrite removes dispatched person and spend facts', async () => {
  const directory = tempDir('claude-dispatch-generation-');
  const id = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const parentFile = path.join(directory, 'parent.jsonl');
  const file = path.join(directory, id + '.jsonl');
  const write = (file: string, rows: unknown[]) =>
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  write(parentFile, claudeDispatchTranscript('claude --bg review', 'backgrounded · 4f4bf298 · Review'));
  const rows = (human: boolean) => [
    {
      type: 'user',
      cwd: directory,
      timestamp: timestamp(0),
      message: { role: 'user', content: human ? 'Review original' : 'Review replacement' },
    },
    ...(human
      ? [
          {
            type: 'user',
            origin: { kind: 'human' },
            timestamp: timestamp(1),
            message: { role: 'user', content: 'A human follow-up' },
          },
        ]
      : []),
    {
      type: 'assistant',
      timestamp: timestamp(2),
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: 'Finished',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: human ? 100 : 7, output_tokens: 1 },
      },
    },
  ];
  write(file, rows(true));
  const session = (file: string, sessionId: string) => {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { file, sessionId, agent: 'claude' as const, size: stat.size, mtimeMs: stat.mtimeMs };
  };
  const worker = new ProgressiveWorker(source);
  const request = () => ({
    kind: 'claude-children' as const,
    parents: [session(parentFile, 'parent'), session(file, id)],
    catalog: [session(parentFile, 'parent'), session(file, id)],
    repositoryRoots: [directory],
  });
  try {
    const first = await completeDiscovery(worker, request(), 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children');
    assert.equal(first.value.dispatchFacts[0].person, true);
    const before = revisionOf(fs.statSync(file, { bigint: true }));
    write(file, [...rows(false), { type: 'ignored', text: 'x'.repeat(before.size + 1000) }]);
    assert.equal(fs.statSync(file, { bigint: true }).ino.toString(), before.ino);
    assert.ok(fs.statSync(file).size > before.size);
    const next = await completeDiscovery(worker, request(), 2, new AbortController().signal);
    assert.ok(next?.value.kind === 'claude-children');
    assert.equal(
      next.value.dispatchFacts[0].person,
      false,
      'the replacement retained human evidence from the old generation',
    );
    const prior = first.value.referenceEntries.find(([key]) => key === normalizeFsPath(file))![1];
    const replaced = next.value.referenceEntries.find(([key]) => key === normalizeFsPath(file))![1];
    assert.ok(replaced.sourceGeneration! > prior.sourceGeneration!);
    assert.equal(next.value.dispatchFacts[0].spend.models[0]?.usage.input, 7);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude recursive closure removes deleted descendants and restores later appearances', async () => {
  const directory = tempDir('claude-recursive-closure-');
  const parentFile = path.join(directory, 'parent.jsonl');
  const childDirectory = path.join(directory, 'parent', 'subagents');
  fs.mkdirSync(childDirectory, { recursive: true });
  const childFile = path.join(childDirectory, 'agent-child.jsonl');
  const grandFile = path.join(childDirectory, 'agent-grand.jsonl');
  const records = (child?: string) =>
    [
      { type: 'user', cwd: directory, message: { content: 'hello' } },
      ...(child
        ? [
            { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'launch' }] } },
            {
              type: 'user',
              message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
              toolUseResult: { agentId: child },
            },
          ]
        : []),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n';
  fs.writeFileSync(parentFile, records('child'));
  fs.writeFileSync(childFile, records('grand'));
  fs.writeFileSync(grandFile, records());
  const stat = revisionOf(fs.statSync(parentFile, { bigint: true }));
  const parent = {
    file: parentFile,
    sessionId: 'parent',
    agent: 'claude' as const,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  const worker = new ProgressiveWorker(source);
  const request = { kind: 'claude-children' as const, parents: [parent], repositoryRoots: [directory] };
  try {
    let result = await completeDiscovery(worker, request, 1, new AbortController().signal);
    assert.ok(result?.value.kind === 'claude-children');
    assert.deepEqual(
      result.value.children.map((child) => child.sessionId),
      ['child', 'grand'],
    );
    fs.unlinkSync(childFile);
    result = await completeDiscovery(worker, request, 2, new AbortController().signal);
    assert.ok(result?.value.kind === 'claude-children');
    assert.deepEqual(result.value.children, []);
    assert.equal(
      result.value.referenceEntries.some(([, entry]) => entry.sessionId === 'grand'),
      false,
    );
    fs.writeFileSync(childFile, records());
    result = await completeDiscovery(worker, request, 3, new AbortController().signal);
    assert.ok(result?.value.kind === 'claude-children');
    assert.deepEqual(
      result.value.children.map((child) => child.sessionId),
      ['child'],
    );
    const changed = new Date(fs.statSync(childFile).mtimeMs + 1000);
    fs.writeFileSync(childFile, records('grand'));
    fs.utimesSync(childFile, changed, changed);
    result = await completeDiscovery(worker, request, 4, new AbortController().signal);
    assert.ok(result?.value.kind === 'claude-children');
    assert.deepEqual(
      result.value.children.map((child) => child.sessionId),
      ['child', 'grand'],
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('metadata recovery reconciles two supported records before refusing retention', async () => {
  const directory = tempDir('metadata-reservation-');
  const file = path.join(directory, 'session.jsonl');
  const message = (length: number) => ({
    type: 'event_msg',
    payload: { type: 'agent_message', phase: 'commentary', message: 'x'.repeat(length) },
  });
  fs.writeFileSync(
    file,
    [...opening('codex'), message(8_387_200), message(20_000)].map((record) => JSON.stringify(record)).join('\n') +
      '\n',
  );
  const worker = new ProgressiveWorker(source);
  try {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    const result = await worker.run(
      {
        kind: 'metadata-recovery',
        session: { file, sessionId: 'session', agent: 'codex', size: stat.size, mtimeMs: stat.mtimeMs },
        eligible: ['session'],
        sliceBytes: 16 * 1024 * 1024,
        // Hold the record whole, so its full charge forces the reconciliation this test covers.
        reduceAboveBytes: 16 * 1024 * 1024,
      },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'metadata-recovery');
    assert.equal(result.value.status, 'complete');
    assert.deepEqual(result.value.read, readCodexSession(file, 'session', { tailBytes: stat.size }));
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('metadata recovery does no retained replay-map traversal for ignored chunks', () => {
  const directory = tempDir('metadata-accounting-');
  const file = path.join(directory, 'session.jsonl');
  const prefix = Array.from(
    { length: 20_000 },
    (_, i) => JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'replay-' + i } }) + '\n',
  ).join('');
  const ignored = (JSON.stringify({ type: 'ignored', body: 'x'.repeat(1024) }) + '\n').repeat(4096);
  fs.writeFileSync(file, prefix + ignored);
  const reducer = createCodexSessionReducer('session', { maxTurns: 40 });
  let visits = 0;
  const scanPayload = reducer.retainedPayloadScan.bind(reducer);
  reducer.retainedPayloadScan = function* () {
    visits++;
    const scan = scanPayload();
    for (;;) {
      const next = scan.next();
      if (next.done) return next.value;
      visits++;
      yield;
    }
  };
  const countPayload = reducer.retainedBytes.bind(reducer);
  reducer.retainedBytes = () => {
    visits++;
    return countPayload();
  };
  const work = {
    chunkBytes: 256 * 1024,
    recovery: {
      through: 0,
      readBytes: 0,
      retainedCharge: 0,
      retainedLimit: 64 * 1024 * 1024,
      recordLimit: 16 * 1024 * 1024,
      reduceAbove: 1024 * 1024,
      accepts: codexSessionLineMayAffectRead,
      fragments: [] as Buffer[],
      fragmentBytes: 0,
    },
  };
  const scan = beginForwardSessionRecovery(file, 'codex', 'session', () => reducer, work);
  try {
    while (work.recovery.through < prefix.length) assert.equal(scan.next().done, false);
    const before = visits;
    let next = scan.next();
    while (!next.done) next = scan.next();
    assert.ok(next.value.read);
    assert.equal(visits, before, 'ignored chunks revisited every retained replay identity');
    assert.ok(reducer.retainedBytes() > 1_000_000);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['missing', 'changed', 'refused', 'pruned', 'cancelled', 'stopped'] as const)(
  'metadata recovery releases accepted progress after %s admission',
  async (failure) => {
    const directory = tempDir('metadata-owner-');
    const files = ['a', 'b'].map((name) => path.join(directory, name + '.jsonl'));
    for (const file of files)
      fs.writeFileSync(
        file,
        opening('codex')
          .map((record) => JSON.stringify(record))
          .join('\n') +
          '\n' +
          (JSON.stringify({ type: 'ignored', body: 'x'.repeat(1024) }) + '\n').repeat(256),
      );
    const marker = path.join(directory, 'refuse');
    const instrumented =
      source +
      `\nconst nativeStat = require('node:fs').statSync; require('node:fs').statSync = (...args) => { if (args[0] === ${JSON.stringify(files[0])} && require('node:fs').existsSync(${JSON.stringify(marker)})) throw new Error('refused stat'); return nativeStat(...args); };`;
    const worker = new ProgressiveWorker(instrumented);
    const request = (i: number) => {
      const stat = revisionOf(fs.statSync(files[i], { bigint: true }));
      return {
        kind: 'metadata-recovery' as const,
        session: {
          file: files[i],
          sessionId: String(i),
          agent: 'codex' as const,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
        eligible: ['0', '1'],
        sliceBytes: 65536,
      };
    };
    try {
      const firstRequest = request(0);
      const first = await worker.run(firstRequest, 1, new AbortController().signal);
      assert.ok(first?.value.kind === 'metadata-recovery' && first.value.status === 'pending');
      assert.ok(first.value.through > 0);
      if (failure === 'pruned') worker.retainMetadataRecovery(['1']);
      else if (failure === 'stopped') {
        worker.stop();
        const restarted = await worker.run(firstRequest, 2, new AbortController().signal);
        assert.ok(restarted?.value.kind === 'metadata-recovery');
        assert.equal(restarted.value.through, 65536);
        worker.retainMetadataRecovery(['1']);
      } else if (failure === 'cancelled') {
        const controller = new AbortController();
        const pending = worker.run({ ...firstRequest, sliceBytes: 16 * 1024 * 1024 }, 1, controller.signal);
        controller.abort();
        await pending;
        worker.retainMetadataRecovery(['1']);
      } else {
        if (failure === 'missing') fs.unlinkSync(files[0]);
        if (failure === 'changed') fs.appendFileSync(files[0], '\n');
        if (failure === 'refused') fs.writeFileSync(marker, 'refuse');
        const rejected = await worker.run(firstRequest, 1, new AbortController().signal);
        assert.equal(rejected?.value.kind, 'stale');
      }
      const next = await worker.run(request(1), 2, new AbortController().signal);
      assert.ok(next?.value.kind === 'metadata-recovery');
      assert.ok(next.value.readBytes > 0, 'the waiting session was blocked by a discarded recovery owner');
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

const source = buildSync({
  entryPoints: [path.join(__dirname, 'progressiveworker-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  write: false,
}).outputFiles[0].text;
const timestamp = (at: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString();

test('saved Codex categories cross the worker boundary only for the captured file revision', async () => {
  const directory = tempDir('codex-context-worker-');
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(
    file,
    codexContextRecords('saved', true)
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const { size, mtimeMs, ino } = revisionOf(fs.statSync(file, { bigint: true }));
  const session = { file, size, mtimeMs, ino, agent: 'codex' as const, sessionId: 'saved' };
  const worker = new ProgressiveWorker(source);
  try {
    const result = await worker.run({ kind: 'codex-context', session }, 7, new AbortController().signal);
    assert.equal(result?.generation, 7);
    assert.ok(result?.value.kind === 'codex-context');
    assert.ok(result.value.estimate?.kind === 'codex-retained-context');
    assert.equal(result.value.estimate?.used, 10100);
    assert.equal(result.value.estimate?.basis, 'request');
    assert.deepEqual(
      new Set(result.value.estimate?.categories.map((row) => row.name)),
      new Set(['Messages', 'Instructions', 'Tool calls', 'Tool results', 'Unattributed context']),
    );
    fs.appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    const stale = await worker.run({ kind: 'codex-context', session }, 8, new AbortController().signal);
    assert.equal(stale?.value.kind, 'stale');
    assert.equal(await worker.run({ kind: 'codex-context', session }, 9, AbortSignal.abort()), null);
    const records = codexContextRecords('saved', true);
    records.push({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' },
    });
    fs.writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const {
      size: pendingSize,
      mtimeMs: pendingMtime,
      ino: pendingIno,
    } = revisionOf(fs.statSync(file, { bigint: true }));
    const pending = await worker.run(
      { kind: 'codex-context', session: { ...session, size: pendingSize, mtimeMs: pendingMtime, ino: pendingIno } },
      10,
      new AbortController().signal,
    );
    assert.ok(pending?.value.kind === 'codex-context');
    assert.deepEqual(pending.value.estimate, {
      kind: 'codex-context-unavailable',
      session: 'saved',
      model: 'gpt-6.1-sol',
      reason: 'pending-tools',
    });
  } finally {
    worker.stop();
  }
});

async function completeDiscovery(
  worker: ProgressiveWorker,
  request: import('./progressiveworker').ProgressiveRequest,
  generation: number,
  signal: AbortSignal,
): Promise<ProgressiveResult | null> {
  for (let pass = 0; pass < 100; pass++) {
    const result = await worker.run(request, generation, signal);
    if (result?.value.kind === 'claude-children' && result.value.continuation) continue;
    if (result?.value.kind !== 'claude-children-progress') return result;
  }
  throw new Error('discovery never completed its captured inputs');
}

test('worker interior rewrite plus growth matches fresh discovery and retires the generation', async () => {
  const directory = tempDir('relationship-interior-growth-');
  const file = path.join(directory, 'parent.jsonl');
  fs.writeFileSync(
    file,
    [
      { type: 'ignored', payload: 'x'.repeat(1024) },
      ...claudeDispatchTranscript(
        'python dispatch.py --arc-dispatch',
        'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa"}',
        'launch',
      ),
      ...Array.from({ length: 100 }, () => ({ type: 'ignored', payload: 'y'.repeat(1024) })),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const request = () => ({
    kind: 'claude-children' as const,
    parents: [
      { file, agent: 'claude' as const, sessionId: 'parent', ...revisionOf(fs.statSync(file, { bigint: true })) },
    ],
    repositoryRoots: [directory],
  });
  const worker = new ProgressiveWorker(source);
  const freshWorker = new ProgressiveWorker(source);
  try {
    const signal = new AbortController().signal;
    const first = await completeDiscovery(worker, request(), 1, signal);
    assert.ok(first?.value.kind === 'claude-children');
    assert.deepEqual(
      first.value.referenceEntries[0][1].references.map((reference) => reference.sessionId),
      ['aaaaaaaa'],
    );
    const old = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, old.replace('aaaaaaaa', 'bbbbbbbb') + '{"type":"ignored"}\n');
    fs.utimesSync(file, new Date(0), new Date(first.value.referenceEntries[0][1].mtimeMs + 2000));
    const resumed = await completeDiscovery(worker, request(), 2, signal);
    const fresh = await completeDiscovery(freshWorker, request(), 2, signal);
    assert.ok(resumed?.value.kind === 'claude-children' && fresh?.value.kind === 'claude-children');
    assert.deepEqual(resumed.value.references, fresh.value.references);
    assert.deepEqual(resumed.value.referenceEntries[0][1].references, fresh.value.referenceEntries[0][1].references);
    assert.deepEqual(resumed.value.children, fresh.value.children);
    assert.ok(resumed.value.referenceEntries[0][1].relationshipComplete);
    assert.equal(
      resumed.value.referenceEntries[0][1].sourceGeneration,
      first.value.referenceEntries[0][1].sourceGeneration! + 1,
    );
  } finally {
    worker.stop();
    freshWorker.stop();
  }
});

// Changed negative answers require prefix reads before a current revision can assert absence.
test.each(['claude', 'codex'] as const)(
  '%s validation charges actual bytes and resumes cancelled durable comparisons',
  async (agent) => {
    const directory = tempDir('relationship-validation-meter-');
    const file = path.join(directory, 'parent.jsonl');
    const cache = path.join(directory, 'cache.json');
    const receipt = 'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa"}';
    const records =
      agent === 'claude'
        ? claudeDispatchTranscript('python dispatch.py --arc-dispatch', receipt, 'launch')
        : [
            ...opening('codex'),
            { type: 'turn_context', timestamp: timestamp(3), payload: { turn_id: 'prompt' } },
            {
              type: 'event_msg',
              timestamp: timestamp(4),
              payload: {
                type: 'item_completed',
                item: {
                  type: 'CommandExecution',
                  id: 'launch',
                  parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
                  stdout: receipt,
                },
              },
            },
          ];
    fs.writeFileSync(
      file,
      [
        { type: 'ignored', payload: 'x'.repeat(1024) },
        ...records,
        ...Array.from({ length: 330 }, () => ({ type: 'ignored', payload: 'y'.repeat(1024) })),
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')
        .replaceAll('ARC_DISPATCH_SESSION', 'ARC_DISPATCH_IGNORED') + '\n',
    );
    const request = () => ({
      kind: 'claude-children' as const,
      parents: [{ file, agent, sessionId: 'session', ...revisionOf(fs.statSync(file, { bigint: true })) }],
      repositoryRoots: [directory],
      quantumBytes: 65536,
      discoveryBytes: 65536,
    });
    const observed = `const vf=require('node:fs'), vr=vf.readSync, vo=vf.openSync; const vfiles=new Map(); let validationBytes=0; let largestRead=0;
    performance.now=()=>0;
    vf.openSync=function(file,...args){const fd=vo.call(this,file,...args);vfiles.set(fd,String(file));return fd;};
    vf.readSync=function(fd,buffer,offset,length,position){const count=vr.call(this,fd,buffer,offset,length,position);if(vfiles.get(fd)===${JSON.stringify(file)}){validationBytes+=count;largestRead=Math.max(largestRead,length);}return count;};
    const vp=require('node:worker_threads').parentPort, vpost=vp.postMessage; vp.postMessage=function(message){if(message.result)Object.assign(message.result,{validationBytes,largestRead});return vpost.call(this,message);};`;
    let worker = new ProgressiveWorker(observed + source);
    try {
      const first = await completeDiscovery(worker, request(), 1, new AbortController().signal);
      assert.ok(first?.value.kind === 'claude-children');
      assert.equal(first.value.referenceEntries[0][1].relationshipComplete, true);
      assert.deepEqual(first.value.referenceEntries[0][1].references, []);
      const old = first.value.referenceEntries[0][1];
      fs.writeFileSync(
        file,
        fs.readFileSync(file, 'utf8').replaceAll('ARC_DISPATCH_IGNORED', 'ARC_DISPATCH_SESSION') +
          '{"type":"ignored"}\n',
      );
      fs.utimesSync(file, new Date(0), new Date(old.mtimeMs + 2000));
      const controller = new AbortController();
      let checkpoint: import('./progressiveworker').DiscoveryCheckpoint | undefined;
      let entries: typeof first.value.referenceEntries = [];
      let observedBytes = (first as typeof first & { validationBytes: number }).validationBytes;
      let acknowledgedPosition = 0;
      const pending = await worker.run(
        { ...request(), referenceEntries: first.value.referenceEntries },
        2,
        controller.signal,
        (result) => {
          if (result.value.kind !== 'claude-children-delta') return;
          checkpoint ??= result.value.checkpoint;
          if (!result.value.referenceEntries.length) return;
          const entry = result.value.referenceEntries[0][1];
          const evidence = entry.claudeCursor?.evidence ?? entry.cursor?.evidence;
          assert.ok(evidence?.validation);
          assert.equal(entry.complete, false);
          assert.equal(entry.relationshipComplete, false);
          assert.deepEqual(entry.validatedRevision, old.validatedRevision);
          assert.equal(
            result.value.charges.readBytes,
            (result as typeof result & { validationBytes: number }).validationBytes - observedBytes,
          );
          assert.equal(result.value.charges.readBytes, 49152);
          assert.ok((result as typeof result & { largestRead: number }).largestRead <= 256 * 1024);
          acknowledgedPosition = evidence.validation.digest.offset;
          assert.equal(acknowledgedPosition, 49152);
          entries = result.value.referenceEntries;
          checkpoint ??= result.value.checkpoint;
          assert.ok(checkpoint);
          console.log(`${agent} validation quantum: ${result.value.charges.readBytes} actual and charged bytes`);
          controller.abort();
        },
      );
      assert.equal(pending, null);
      assert.ok(acknowledgedPosition > 0);
      saveDerivedCache(cache, [], entries, [], undefined, checkpoint);
      const restored = loadDerivedCache(cache);
      worker.stop();
      worker = new ProgressiveWorker(observed + source);
      let lastPosition = acknowledgedPosition;
      let completed: ProgressiveResult | null = null;
      for (let pass = 0; pass < 40; pass++) {
        completed = await worker.run(
          { ...request(), referenceEntries: [...restored.claudeChildReferences], discovery: restored.discovery },
          3,
          new AbortController().signal,
        );
        assert.ok(completed);
        assert.ok(completed.value.kind === 'claude-children' || completed.value.kind === 'claude-children-progress');
        if (completed.value.referenceEntries[0][1].relationshipComplete) break;
        const entry = completed.value.referenceEntries[0][1];
        const evidence = entry.claudeCursor?.evidence ?? entry.cursor?.evidence;
        if (evidence?.validation) {
          assert.ok(evidence.validation.digest.offset > lastPosition);
          lastPosition = evidence.validation.digest.offset;
        }
      }
      assert.ok(completed?.value.kind === 'claude-children');
      const entry = completed.value.referenceEntries[0][1];
      assert.equal(entry.relationshipComplete, true);
      assert.equal(entry.sourceGeneration, old.sourceGeneration! + 1);
      assert.deepEqual(
        entry.references.map((reference) => reference.sessionId),
        ['aaaaaaaa'],
      );
    } finally {
      worker.stop();
    }
  },
);

test('discovery transport rejects obsolete generation progress while the selected request completes', async () => {
  const worker =
    new ProgressiveWorker(`const p=require('node:worker_threads').parentPort;p.on('message',m=>{if(!m.request)return;
    p.postMessage({id:m.id,progress:true,result:{generation:m.generation-1,revision:null,value:{kind:'claude-children-progress',referenceEntries:[]}}});
    p.postMessage({id:m.id,result:{generation:m.generation,revision:null,value:{kind:'stale'}}});});`);
  let progress = 0;
  try {
    const result = await worker.run(
      { kind: 'claude-children', parents: [], repositoryRoots: [] },
      9,
      new AbortController().signal,
      () => {
        progress++;
      },
    );
    assert.equal(result?.generation, 9);
    assert.equal(progress, 0);
  } finally {
    worker.stop();
  }
});

test.each(['claude', 'codex'] as const)(
  '%s validation stops reading at an injected deadline and resumes its position',
  async (agent) => {
    const directory = tempDir('relationship-validation-deadline-');
    const file = path.join(directory, 'parent.jsonl');
    fs.writeFileSync(
      file,
      Array.from({ length: 100 }, () => JSON.stringify({ type: 'ignored', text: 'x'.repeat(1024) })).join('\n') + '\n',
    );
    const request = () => ({
      kind: 'claude-children' as const,
      parents: [{ file, agent, sessionId: 'parent', ...revisionOf(fs.statSync(file, { bigint: true })) }],
      repositoryRoots: [directory],
    });
    const firstWorker = new ProgressiveWorker(source);
    let worker: ProgressiveWorker | undefined;
    try {
      const first = await completeDiscovery(firstWorker, request(), 1, new AbortController().signal);
      assert.ok(first?.value.kind === 'claude-children');
      fs.appendFileSync(file, '{"type":"ignored"}\n');
      const timed = `let validationClock=0;performance.now=()=>validationClock;const df=require('node:fs'),dr=df.readSync;df.readSync=function(...args){const count=dr.apply(this,args);validationClock+=15;return count;};`;
      worker = new ProgressiveWorker(timed + source);
      const firstSlice = await worker.run(
        { ...request(), referenceEntries: first.value.referenceEntries },
        2,
        new AbortController().signal,
      );
      assert.ok(firstSlice?.value.kind === (agent === 'claude' ? 'claude-children-progress' : 'claude-children'));
      const entry = firstSlice.value.referenceEntries[0][1];
      const evidence = entry.claudeCursor?.evidence ?? entry.cursor?.evidence;
      assert.equal(firstSlice.value.charges!.readBytes, first.value.referenceEntries[0][1].size);
      assert.equal(firstSlice.value.charges!.quanta, 1);
      assert.equal(evidence?.validation?.digest.offset, 4096);
      const next = await worker.run(request(), 3, new AbortController().signal);
      assert.ok(next?.value.kind === (agent === 'claude' ? 'claude-children-progress' : 'claude-children'));
      const nextEntry = next.value.referenceEntries[0][1];
      assert.equal((nextEntry.claudeCursor?.evidence ?? nextEntry.cursor?.evidence)?.validation?.digest.offset, 8192);
    } finally {
      firstWorker.stop();
      worker?.stop();
    }
  },
);

test.each(['claude', 'codex'] as const)(
  '%s production validation stays inside its provider allowance',
  async (agent) => {
    const directory = tempDir('relationship-production-allowance-');
    const file = path.join(directory, 'parent.jsonl');
    fs.writeFileSync(
      file,
      Array.from(
        { length: agent === 'claude' ? 1300 : 8300 },
        () => '{"type":"ignored","text":"' + 'x'.repeat(1024) + '"}\n',
      ).join(''),
    );
    const request = () => ({
      kind: 'claude-children' as const,
      parents: [{ file, agent, sessionId: 'parent', ...revisionOf(fs.statSync(file, { bigint: true })) }],
      repositoryRoots: [directory],
    });
    const observed = `performance.now=()=>0;const pf=require('node:fs'),pr=pf.readSync,ps=pf.statSync,pfstat=pf.fstatSync;
      let ioReads=0,ioStats=0;pf.readSync=function(...args){ioReads++;return pr.apply(this,args);};
      pf.statSync=function(...args){ioStats++;return ps.apply(this,args);};pf.fstatSync=function(...args){ioStats++;return pfstat.apply(this,args);};
      const port=require('node:worker_threads').parentPort,post=port.postMessage.bind(port);port.postMessage=function(message){if(message.result)Object.assign(message.result,{ioReads,ioStats});post(message);};`;
    const worker = new ProgressiveWorker(observed + source);
    try {
      const first = await completeDiscovery(worker, request(), 1, new AbortController().signal);
      assert.ok(first?.value.kind === 'claude-children');
      const offset = (first.value.referenceEntries[0][1].claudeCursor ?? first.value.referenceEntries[0][1].cursor)!
        .offset;
      fs.appendFileSync(file, '{"type":"ignored"}\n');
      const validation = await worker.run(request(), 2, new AbortController().signal);
      assert.ok(validation?.value.kind === (agent === 'claude' ? 'claude-children-progress' : 'claude-children'));
      const allowance = (agent === 'claude' ? 1 : 8) * 1024 * 1024 - 16 * 1024;
      assert.equal(validation.value.charges!.readBytes, allowance);
      const beforeIo = first as typeof first & { ioReads: number; ioStats: number };
      const afterIo = validation as typeof validation & { ioReads: number; ioStats: number };
      const reads = Math.ceil(allowance / (256 * 1024));
      assert.equal(afterIo.ioReads - beforeIo.ioReads, reads, 'validation split a buffer into individual block reads');
      assert.equal(
        afterIo.ioStats - beforeIo.ioStats,
        2 * reads + 5,
        'validation repeated source stats between hash blocks',
      );
      const cursor =
        validation.value.referenceEntries[0][1].claudeCursor ?? validation.value.referenceEntries[0][1].cursor;
      assert.equal(cursor?.offset, offset);
      assert.equal(cursor?.evidence?.validation?.digest.offset, allowance);
      assert.ok(Buffer.byteLength(JSON.stringify(cursor.evidence)) <= 16384);
      console.log(
        `${agent} production validation byte allowance with a frozen clock: ${validation.value.charges!.readBytes} bytes, ${Buffer.byteLength(JSON.stringify(cursor.evidence))} serialized evidence bytes`,
      );
    } finally {
      worker.stop();
    }
  },
);

test('discovery admission coalesces the waiter and keeps selected reads independent', async () => {
  const worker = new ProgressiveWorker(`const p=require('node:worker_threads').parentPort;let active;
    p.on('message',m=>{if(!m.request)return;if(m.request.kind==='claude-children'&&!active){active=m;return;}
      p.postMessage({id:m.id,result:{generation:m.generation,revision:null,value:{kind:'stale'}}});
      if(active){p.postMessage({id:active.id,result:{generation:active.generation,revision:null,value:{kind:'stale'}}});active=null;}});`);
  const request = { kind: 'claude-children' as const, parents: [], repositoryRoots: [] };
  try {
    const signal = new AbortController().signal;
    const active = worker.run(request, 1, signal);
    const superseded = worker.run(request, 2, signal);
    const latest = worker.run(request, 3, signal);
    assert.equal(await superseded, null);
    const selected = await worker.run(
      { kind: 'metadata', session: { agent: 'claude', sessionId: 'selected', file: 'unused', size: 1, mtimeMs: 1 } },
      4,
      signal,
    );
    assert.equal(selected?.generation, 4);
    assert.equal((await active)?.generation, 1);
    await vi.waitFor(() => assert.equal(worker.transport.requests, 3));
    await worker.run(
      { kind: 'metadata', session: { agent: 'claude', sessionId: 'selected', file: 'unused', size: 1, mtimeMs: 1 } },
      5,
      signal,
    );
    assert.equal((await latest)?.generation, 3);
    assert.equal(worker.transport.requests, 4);
    const activeSignal = new AbortController();
    const waitingSignal = new AbortController();
    const cancelled = worker.run(request, 6, activeSignal.signal);
    await vi.waitFor(() => assert.equal(worker.transport.requests, 5));
    const surviving = worker.run(request, 7, waitingSignal.signal);
    activeSignal.abort();
    assert.equal(await cancelled, null);
    assert.equal(waitingSignal.signal.aborted, false);
    assert.equal((await surviving)?.generation, 7, 'aborting active discovery cancelled its live waiter');
  } finally {
    worker.stop();
  }
});

test.each([1, 2])('Claude unparseable terminal releases protection and finishes with %i sources', async (count) => {
  const directory = tempDir('relationship-terminal-release-');
  const parents = Array.from({ length: count }, (_, index) => {
    const file = path.join(directory, `${index}.jsonl`);
    fs.writeFileSync(
      file,
      index === 0 ? '{"type":"ignored"}\n{"type":"ignored","text":"' + 'x'.repeat(300000) : '{"type":"ignored"}\n',
    );
    return {
      file,
      sessionId: String(index),
      agent: 'claude' as const,
      ...revisionOf(fs.statSync(file, { bigint: true })),
    };
  });
  const worker = new ProgressiveWorker('performance.now=()=>0;' + source);
  const request = {
    kind: 'claude-children' as const,
    parents,
    repositoryRoots: [directory],
    quantumBytes: 65536,
    discoveryBytes: 65536,
  };
  try {
    const first = await worker.run(request, 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children-progress');
    const checkpoint = { ...first.value.checkpoint, protectedFile: normalizeFsPath(parents[0].file) };
    const restored = await worker.run(
      { ...request, parents: [...parents].reverse(), discovery: checkpoint },
      2,
      new AbortController().signal,
    );
    assert.ok(restored?.value.kind === 'claude-children-progress');
    assert.equal(restored.value.checkpoint.protectedFile, normalizeFsPath(parents[0].file));
    const result = await completeDiscovery(worker, request, 3, new AbortController().signal);
    assert.ok(result?.value.kind === 'claude-children');
    assert.equal(result.value.continuation, false);
    assert.equal(result.value.checkpoint?.protectedFile, undefined);
    assert.equal(result.value.checkpoint?.completed.length, count);
    const entry = new Map(result.value.referenceEntries).get(normalizeFsPath(parents[0].file))!;
    assert.ok(entry.claudeCursor!.fragmentBytes > 0);
    assert.equal(entry.claudeCursor!.terminalApplied, false);
    assert.equal(entry.complete, true);
    assert.equal(entry.relationshipComplete, true);
    for (const [, current] of result.value.referenceEntries) assert.equal(current.claudeCursor?.offset, current.size);
    const next = await worker.run(request, 4, new AbortController().signal);
    assert.ok(next?.value.kind === 'claude-children');
    assert.equal(next.value.continuation, false);
    assert.equal(next.value.charges!.readBytes, 0);
  } finally {
    worker.stop();
  }
});

test.each(['claude', 'codex'] as const)(
  '%s evicted finished evidence avoids unchanged reads and rebuilds changes',
  async (agent) => {
    const directory = tempDir('relationship-evicted-finished-');
    const file = path.join(directory, 'parent.jsonl');
    const cache = path.join(directory, 'cache.json');
    fs.writeFileSync(file, '{"type":"ignored"}\n');
    const request = () => ({
      kind: 'claude-children' as const,
      parents: [{ file, sessionId: 'parent', agent, ...revisionOf(fs.statSync(file, { bigint: true })) }],
      repositoryRoots: [directory],
    });
    let worker = new ProgressiveWorker('performance.now=()=>0;' + source);
    try {
      const first = await completeDiscovery(worker, request(), 1, new AbortController().signal);
      assert.ok(first?.value.kind === 'claude-children');
      const evicted = limitCodexDispatchCursors(first.value.referenceEntries, 0);
      assert.equal(evicted[0][1].cursor, undefined);
      assert.equal(evicted[0][1].claudeCursor, undefined);
      assert.ok(evicted[0][1].evidence);
      saveDerivedCache(cache, [], evicted);
      const entries = [...loadDerivedCache(cache).claudeChildReferences];
      worker.stop();
      const readless = `const ef=require('node:fs');ef.readSync=()=>{throw new Error('unchanged evicted source was read');};`;
      worker = new ProgressiveWorker(readless + source);
      const next = await worker.run({ ...request(), referenceEntries: entries }, 2, new AbortController().signal);
      assert.ok(next?.value.kind === 'claude-children');
      assert.equal(next.value.charges!.readBytes, 0);
      assert.equal(next.value.charges!.quanta, 0);
      assert.deepEqual(next.value.checkpoint?.completed, [normalizeFsPath(file)]);
      assert.equal(
        next.value.referenceEntries[0][1].sourceGeneration,
        first.value.referenceEntries[0][1].sourceGeneration,
      );
      worker.stop();
      fs.appendFileSync(file, '{"type":"ignored"}\n');
      worker = new ProgressiveWorker('performance.now=()=>0;' + source);
      const changed = await completeDiscovery(
        worker,
        { ...request(), referenceEntries: entries },
        3,
        new AbortController().signal,
      );
      assert.ok(changed?.value.kind === 'claude-children');
      assert.equal(changed.value.charges!.readBytes, fs.statSync(file).size);
      assert.equal(
        changed.value.referenceEntries[0][1].sourceGeneration,
        first.value.referenceEntries[0][1].sourceGeneration! + 1,
      );
    } finally {
      worker.stop();
    }
  },
);

test('a pending large Codex rollout permits complete publication beside changed Claude facts', async () => {
  const directory = tempDir('relationship-codex-publication-');
  const claudeFile = path.join(directory, 'claude.jsonl');
  const codexFile = path.join(directory, 'codex.jsonl');
  fs.writeFileSync(claudeFile, '{"type":"ignored"}\n');
  fs.writeFileSync(codexFile, '{"type":"ignored"}\n');
  const childFile = path.join(directory, 'aaaaaaaa.jsonl');
  fs.writeFileSync(childFile, JSON.stringify({ type: 'user', cwd: directory, message: { content: 'child' } }) + '\n');
  const request = () => ({
    kind: 'claude-children' as const,
    parents: [
      {
        file: claudeFile,
        sessionId: 'claude',
        agent: 'claude' as const,
        ...revisionOf(fs.statSync(claudeFile, { bigint: true })),
      },
      {
        file: codexFile,
        sessionId: 'codex',
        agent: 'codex' as const,
        ...revisionOf(fs.statSync(codexFile, { bigint: true })),
      },
    ],
    catalog: [
      {
        file: childFile,
        sessionId: 'aaaaaaaa',
        agent: 'claude' as const,
        ...revisionOf(fs.statSync(childFile, { bigint: true })),
      },
    ],
    repositoryRoots: [directory],
  });
  const worker = new ProgressiveWorker('performance.now=()=>0;' + source);
  try {
    await completeDiscovery(worker, request(), 1, new AbortController().signal);
    fs.appendFileSync(codexFile, ('{"type":"ignored","text":"' + 'x'.repeat(1024) + '"}\n').repeat(8300));
    fs.appendFileSync(
      claudeFile,
      claudeDispatchTranscript(
        'python dispatch.py --arc-dispatch',
        'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa"}',
        'launch',
      )
        .map((row) => JSON.stringify(row) + '\n')
        .join(''),
    );
    const result = await worker.run(request(), 2, new AbortController().signal);
    assert.ok(result?.value.kind === 'claude-children');
    assert.equal(result.value.complete, true);
    assert.equal(result.value.continuation, true);
    assert.deepEqual(
      result.value.references.map((reference) => reference.sessionId),
      ['aaaaaaaa'],
    );
    const entry = new Map(result.value.referenceEntries).get(normalizeFsPath(codexFile))!;
    assert.ok(entry.cursor!.offset < entry.size);
    assert.equal(entry.complete, false);
    assert.equal(entry.relationshipComplete, false);
  } finally {
    worker.stop();
  }
});

test('pending Codex comparison retains dispatched sessions and spend through complete replies', async () => {
  const directory = tempDir('relationship-codex-retained-dispatch-');
  const file = path.join(directory, 'parent.jsonl');
  const childId = 'aaaaaaaa-1111-1111-1111-111111111111';
  const childFile = path.join(directory, childId + '.jsonl');
  const line = (record: object) => JSON.stringify(record) + '\n';
  fs.writeFileSync(
    childFile,
    line({ type: 'user', timestamp: timestamp(0), cwd: directory, message: { content: 'work' } }) +
      line({
        type: 'assistant',
        timestamp: timestamp(1),
        message: {
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
  );
  fs.utimesSync(childFile, 100, 100);
  fs.writeFileSync(
    file,
    line({ type: 'session_meta', payload: { id: 'parent', cwd: directory } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'launch' } }) +
      line({ type: 'turn_context', payload: { turn_id: 'launch' } }) +
      line({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'launch',
            parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
            stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
          },
        },
      }) +
      line({ type: 'ignored', text: 'x'.repeat(1024) }).repeat(8300),
  );
  const session = (file: string, sessionId: string, agent: 'claude' | 'codex') => ({
    file,
    sessionId,
    agent,
    ...revisionOf(fs.statSync(file, { bigint: true })),
  });
  const request = () => ({
    kind: 'claude-children' as const,
    parents: [session(file, 'parent', 'codex')],
    catalog: [session(childFile, childId, 'claude')],
    repositoryRoots: [directory],
  });
  const worker = new ProgressiveWorker('performance.now=()=>0;' + source);
  try {
    const first = await completeDiscovery(worker, request(), 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children');
    assert.equal(first.value.references[0]?.parentSessionId, 'parent');
    assert.equal(first.value.dispatchFacts[0]?.spend.found, true);
    assert.equal(first.value.dispatchFacts[0]?.spend.models[0]?.usage.output, 3);
    const old = new Map(first.value.referenceEntries).get(normalizeFsPath(file))!;
    assert.ok(old.cursor!.offset > 8 * 1024 * 1024);
    fs.appendFileSync(file, line({ type: 'ignored' }));
    const pending = await worker.run(request(), 2, new AbortController().signal);
    assert.ok(pending?.value.kind === 'claude-children');
    assert.equal(pending.value.complete, true);
    assert.equal(pending.value.continuation, true);
    const entry = new Map(pending.value.referenceEntries).get(normalizeFsPath(file))!;
    assert.ok(entry.cursor!.evidence!.validation);
    assert.equal(entry.complete, false);
    assert.equal(entry.relationshipComplete, false);
    assert.equal(entry.sourceGeneration, old.sourceGeneration);
    assert.deepEqual(entry.validatedRevision, old.validatedRevision);
    assert.deepEqual(pending.value.references, first.value.references);
    assert.deepEqual(pending.value.dispatchFacts, first.value.dispatchFacts);
    assert.equal(pending.value.charges!.dispatchSpendRereads, 0);
    fs.appendFileSync(file, line({ type: 'ignored' }));
    const unreached = await worker.run({ ...request(), discoveryBytes: 16 * 1024 }, 3, new AbortController().signal);
    assert.ok(unreached?.value.kind === 'claude-children');
    assert.equal(unreached.value.complete, true);
    assert.equal(unreached.value.continuation, true);
    assert.equal(unreached.value.charges!.readBytes, 0);
    assert.equal(unreached.value.referenceEntries[0][1].complete, false);
    assert.equal(unreached.value.referenceEntries[0][1].relationshipComplete, false);
    assert.deepEqual(unreached.value.references, first.value.references);
    assert.deepEqual(unreached.value.dispatchFacts, first.value.dispatchFacts);
    const stable = await completeDiscovery(worker, request(), 3, new AbortController().signal);
    assert.ok(stable?.value.kind === 'claude-children');
    const finished = new Map(stable.value.referenceEntries).get(normalizeFsPath(file))!;
    assert.equal(finished.complete, true);
    assert.equal(finished.relationshipComplete, true);
    assert.equal(finished.cursor!.evidence!.validation, undefined);
    assert.equal(finished.sourceGeneration, old.sourceGeneration);
    assert.deepEqual(stable.value.references, first.value.references);
    assert.deepEqual(stable.value.dispatchFacts, first.value.dispatchFacts);
    assert.equal(stable.value.continuation, false);
    const rewritten = fs.readFileSync(file);
    const mismatchAt = rewritten.lastIndexOf('x');
    assert.ok(mismatchAt > 8 * 1024 * 1024 && mismatchAt < finished.cursor!.offset);
    rewritten[mismatchAt] = 'y'.charCodeAt(0);
    fs.writeFileSync(file, rewritten);
    fs.appendFileSync(file, line({ type: 'ignored' }));
    fs.utimesSync(file, 104, 104);
    const comparing = await worker.run(request(), 4, new AbortController().signal);
    assert.ok(comparing?.value.kind === 'claude-children');
    const comparingEntry = comparing.value.referenceEntries[0][1];
    assert.ok(comparingEntry.cursor!.evidence!.validation);
    assert.equal(comparingEntry.complete, false);
    assert.equal(comparingEntry.relationshipComplete, false);
    assert.equal(comparingEntry.sourceGeneration, old.sourceGeneration);
    assert.deepEqual(comparing.value.references, first.value.references);
    assert.deepEqual(comparing.value.dispatchFacts, first.value.dispatchFacts);
    const mismatch = await worker.run(request(), 5, new AbortController().signal);
    assert.ok(mismatch?.value.kind === 'claude-children');
    assert.equal(mismatch.value.referenceEntries[0][1].sourceGeneration, old.sourceGeneration! + 1);
    assert.deepEqual(mismatch.value.referenceEntries[0][1].references, []);
    assert.deepEqual(mismatch.value.references, []);
    assert.deepEqual(mismatch.value.dispatchFacts, []);
    fs.writeFileSync(file, line({ type: 'ignored' }));
    const reset = await worker.run(request(), 6, new AbortController().signal);
    assert.ok(reset?.value.kind === 'claude-children');
    assert.equal(reset.value.referenceEntries[0][1].sourceGeneration, old.sourceGeneration! + 2);
    assert.deepEqual(reset.value.references, []);
    assert.deepEqual(reset.value.dispatchFacts, []);
  } finally {
    worker.stop();
  }
});

test('an unreached same-size Codex rewrite retains dispatch references until comparison retires them', async () => {
  const directory = tempDir('relationship-codex-unreached-rewrite-');
  const file = path.join(directory, 'parent.jsonl');
  const childId = 'aaaaaaaa-1111-1111-1111-111111111111';
  const childFile = path.join(directory, childId + '.jsonl');
  const line = (record: object) => JSON.stringify(record) + '\n';
  fs.writeFileSync(childFile, line({ type: 'user', cwd: directory, message: { content: 'work' } }));
  fs.utimesSync(childFile, 100, 100);
  const padding = line({ type: 'ignored', text: 'x'.repeat(1024) }).repeat(8);
  fs.writeFileSync(
    file,
    line({ type: 'session_meta', payload: { id: 'parent', cwd: directory } }) +
      padding +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'launch' } }) +
      line({ type: 'turn_context', payload: { turn_id: 'launch' } }) +
      line({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'launch',
            parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
            stdout: 'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa-1111-1111-1111-111111111111"}',
          },
        },
      }) +
      padding,
  );
  fs.utimesSync(file, 100, 100);
  const request = () => ({
    kind: 'claude-children' as const,
    parents: [
      { file, sessionId: 'parent', agent: 'codex' as const, ...revisionOf(fs.statSync(file, { bigint: true })) },
    ],
    catalog: [
      {
        file: childFile,
        sessionId: childId,
        agent: 'claude' as const,
        ...revisionOf(fs.statSync(childFile, { bigint: true })),
      },
    ],
    repositoryRoots: [directory],
  });
  const worker = new ProgressiveWorker('performance.now=()=>0;' + source);
  try {
    const first = await completeDiscovery(worker, request(), 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children');
    const old = first.value.referenceEntries[0][1];
    assert.equal(first.value.references.length, 1);
    const before = fs.readFileSync(file, 'utf8');
    const at = before.indexOf('aaaaaaaa-1111');
    assert.ok(at > 4096 && at < before.length - 4096);
    fs.writeFileSync(file, before.replace('aaaaaaaa-1111', 'bbbbbbbb-1111'));
    fs.utimesSync(file, 102, 102);
    assert.equal(fs.statSync(file).size, old.size);
    const unreached = await worker.run({ ...request(), discoveryBytes: 16 * 1024 }, 2, new AbortController().signal);
    assert.ok(unreached?.value.kind === 'claude-children');
    const entry = unreached.value.referenceEntries[0][1];
    assert.equal(unreached.value.charges!.readBytes, 0);
    assert.equal(entry.complete, false);
    assert.equal(entry.relationshipComplete, false);
    assert.equal(entry.sourceGeneration, old.sourceGeneration);
    assert.deepEqual(entry.validatedRevision, old.validatedRevision);
    assert.deepEqual(unreached.value.references, first.value.references);
    const reached = await worker.run(request(), 3, new AbortController().signal);
    assert.ok(reached?.value.kind === 'claude-children');
    assert.equal(reached.value.referenceEntries[0][1].sourceGeneration, old.sourceGeneration! + 1);
    assert.deepEqual(reached.value.references, []);
    assert.deepEqual(reached.value.dispatchFacts, []);
  } finally {
    worker.stop();
  }
});

test.each(['appended', 'unchanged'] as const)(
  'a protected Claude child keeps priority with an %s parent',
  async (change) => {
    const directory = tempDir('relationship-protected-child-');
    const parentFile = path.join(directory, 'parent.jsonl');
    const childDirectory = path.join(directory, 'parent', 'subagents');
    fs.mkdirSync(childDirectory, { recursive: true });
    const childFile = path.join(childDirectory, 'agent-child.jsonl');
    const line = (record: object) => JSON.stringify(record) + '\n';
    fs.writeFileSync(
      parentFile,
      line({ type: 'user', cwd: directory, message: { content: 'work' } }) +
        line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'launch', name: 'Agent' }] } }) +
        line({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
          toolUseResult: { agentId: 'child' },
        }),
    );
    fs.writeFileSync(
      childFile,
      line({ type: 'user', cwd: directory, isSidechain: true, message: { content: 'work' } }) +
        line({ type: 'ignored', text: 'x'.repeat(900000) }),
    );
    const session = (file: string, sessionId: string, childTranscript = false) => ({
      file,
      sessionId,
      childTranscript,
      agent: 'claude' as const,
      ...revisionOf(fs.statSync(file, { bigint: true })),
    });
    const request = () => ({
      kind: 'claude-children' as const,
      parents: [session(parentFile, 'parent')],
      catalog: [session(parentFile, 'parent')],
      repositoryRoots: [directory],
      quantumBytes: 65536,
      discoveryBytes: 65536,
    });
    const worker = new ProgressiveWorker('performance.now=()=>0;' + source);
    try {
      let saved:
        | Extract<import('./progressiveworker').ProgressiveValue, { kind: 'claude-children-progress' }>
        | undefined;
      for (let pass = 0; pass < 12; pass++) {
        const result = await worker.run(request(), 1, new AbortController().signal);
        assert.ok(result?.value.kind === 'claude-children-progress');
        saved = result.value;
        if (saved.checkpoint.protectedFile) break;
      }
      const key = normalizeFsPath(childFile);
      assert.equal(saved?.checkpoint.protectedFile, key);
      const prior = new Map(saved.referenceEntries).get(key)!.claudeCursor!.offset;
      if (change === 'appended') fs.appendFileSync(parentFile, line({ type: 'ignored' }));
      const next = await worker.run(request(), 2, new AbortController().signal);
      assert.ok(next?.value.kind === 'claude-children-progress');
      assert.equal(next.value.checkpoint.protectedFile, key);
      const entries = new Map(next.value.referenceEntries);
      assert.ok(entries.get(key)!.claudeCursor!.offset > prior);
      assert.equal(
        entries.get(normalizeFsPath(parentFile))!.claudeCursor!.offset,
        saved.referenceEntries.find(([file]) => file === normalizeFsPath(parentFile))![1].claudeCursor!.offset,
      );
      const finished = await completeDiscovery(worker, request(), 3, new AbortController().signal);
      assert.ok(finished?.value.kind === 'claude-children');
      assert.equal(finished.value.checkpoint?.protectedFile, undefined);
      assert.equal(finished.value.children[0]?.sessionId, 'child');
    } finally {
      worker.stop();
    }
  },
);

test('expired Codex terminal checks preserve revision pairing and retained dispatch references', async () => {
  const directory = tempDir('relationship-codex-terminal-expiry-');
  const file = path.join(directory, 'parent.jsonl');
  const childId = 'aaaaaaaa-1111-1111-1111-111111111111';
  const childFile = path.join(directory, childId + '.jsonl');
  fs.writeFileSync(childFile, JSON.stringify({ type: 'user', cwd: directory, message: { content: 'work' } }) + '\n');
  fs.utimesSync(childFile, 100, 100);
  const records = [
    { type: 'session_meta', payload: { id: 'parent', cwd: directory } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'launch' } },
    { type: 'turn_context', payload: { turn_id: 'launch' } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'launch',
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
          stdout: 'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa-1111-1111-1111-111111111111"}',
        },
      },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));
  fs.utimesSync(file, 100, 100);
  const request = () => ({
    kind: 'claude-children' as const,
    parents: [
      { file, sessionId: 'parent', agent: 'codex' as const, ...revisionOf(fs.statSync(file, { bigint: true })) },
    ],
    catalog: [
      {
        file: childFile,
        sessionId: childId,
        agent: 'claude' as const,
        ...revisionOf(fs.statSync(childFile, { bigint: true })),
      },
    ],
    repositoryRoots: [directory],
  });
  const firstWorker = new ProgressiveWorker('performance.now=()=>0;' + source);
  let worker: ProgressiveWorker | undefined;
  try {
    const first = await completeDiscovery(firstWorker, request(), 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children');
    const old = first.value.referenceEntries[0][1];
    assert.equal(old.cursor!.terminalApplied, true);
    assert.equal(old.references.length, 1);
    assert.equal(first.value.references.length, 1);
    assert.ok(old.cursor!.offset < 4096);
    fs.appendFileSync(file, 'x');
    fs.utimesSync(file, 102, 102);
    const timed = `let terminalClock=0;performance.now=()=>terminalClock;const tf=require('node:fs'),tr=tf.readSync;tf.readSync=function(...args){const count=tr.apply(this,args);terminalClock+=15;return count;};`;
    worker = new ProgressiveWorker(timed + source);
    const expired = await worker.run(
      { ...request(), referenceEntries: first.value.referenceEntries },
      2,
      new AbortController().signal,
    );
    assert.ok(expired?.value.kind === 'claude-children');
    const entry = expired.value.referenceEntries[0][1];
    assert.equal(expired.value.charges!.readBytes, old.cursor!.offset);
    assert.equal(entry.cursor!.evidence!.validation, undefined);
    assert.deepEqual(entry.cursor!.evidence!.accepted, entry.cursor!.evidence!.provisional);
    assert.equal(entry.cursor!.size, entry.cursor!.evidence!.provisional.size);
    assert.equal(entry.cursor!.mtimeMs, entry.cursor!.evidence!.provisional.mtimeMs);
    assert.equal(entry.cursor!.dev, entry.cursor!.evidence!.provisional.dev);
    assert.equal(entry.cursor!.ino, entry.cursor!.evidence!.provisional.ino);
    assert.equal(entry.complete, false);
    assert.equal(entry.relationshipComplete, false);
    assert.deepEqual(entry.validatedRevision, old.validatedRevision);
    assert.deepEqual(expired.value.references, first.value.references);
    worker.stop();
    worker = new ProgressiveWorker('performance.now=()=>0;' + source);
    const reset = await worker.run(
      { ...request(), referenceEntries: expired.value.referenceEntries },
      3,
      new AbortController().signal,
    );
    assert.ok(reset?.value.kind === 'claude-children');
    assert.equal(reset.value.referenceEntries[0][1].sourceGeneration, old.sourceGeneration! + 1);
    assert.deepEqual(reset.value.references, []);
  } finally {
    firstWorker.stop();
    worker?.stop();
  }
});

test('Claude relationship completeness waits for bytes appended beyond its frozen target', async () => {
  const directory = tempDir('relationship-frozen-target-');
  const file = path.join(directory, 'parent.jsonl');
  fs.writeFileSync(file, (JSON.stringify({ type: 'ignored', text: 'x'.repeat(1024) }) + '\n').repeat(150));
  fs.utimesSync(file, 100, 100);
  const request = () => ({
    kind: 'claude-children' as const,
    parents: [
      { file, sessionId: 'parent', agent: 'claude' as const, ...revisionOf(fs.statSync(file, { bigint: true })) },
    ],
    repositoryRoots: [directory],
    quantumBytes: 65536,
    discoveryBytes: 65536,
  });
  const worker = new ProgressiveWorker('performance.now=()=>0;' + source);
  try {
    const first = await worker.run(request(), 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children-progress');
    const target = first.value.referenceEntries[0][1].claudeCursor!.target;
    assert.ok(first.value.referenceEntries[0][1].claudeCursor!.offset < target);
    fs.appendFileSync(file, (JSON.stringify({ type: 'ignored' }) + '\n').repeat(100));
    fs.utimesSync(file, 102, 102);
    let reached = false;
    for (let pass = 0; pass < 20; pass++) {
      const result = await worker.run(request(), 2, new AbortController().signal);
      assert.ok(result?.value.kind === 'claude-children-progress');
      const entry = result.value.referenceEntries[0][1];
      if (entry.claudeCursor!.offset !== target) continue;
      reached = true;
      assert.ok(entry.claudeCursor!.offset < entry.size);
      assert.equal(entry.relationshipComplete, false);
      break;
    }
    assert.equal(reached, true);
    const finished = await completeDiscovery(worker, request(), 3, new AbortController().signal);
    assert.ok(finished?.value.kind === 'claude-children');
    assert.equal(finished.value.referenceEntries[0][1].relationshipComplete, true);
    assert.equal(finished.value.referenceEntries[0][1].claudeCursor!.offset, fs.statSync(file).size);
  } finally {
    worker.stop();
  }
});

test('zero-byte source resets preserve the request quantum allowance', async () => {
  const directory = tempDir('relationship-zero-byte-quanta-');
  const parents = Array.from({ length: 11 }, (_, index) => {
    const file = path.join(directory, `${index}.jsonl`);
    fs.writeFileSync(file, '{"type":"ignored"}\n');
    return {
      file,
      sessionId: String(index),
      agent: 'claude' as const,
      ...revisionOf(fs.statSync(file, { bigint: true })),
    };
  });
  const worker = new ProgressiveWorker('performance.now=()=>0;' + source);
  const request = { kind: 'claude-children' as const, parents, repositoryRoots: [directory] };
  try {
    await completeDiscovery(worker, request, 1, new AbortController().signal);
    for (const parent of parents) fs.writeFileSync(parent.file, '');
    const reset = await worker.run(request, 2, new AbortController().signal);
    assert.ok(reset?.value.kind === 'claude-children-progress');
    assert.equal(reset.value.charges.readBytes, 0);
    assert.equal(reset.value.charges.quanta, 0);
    assert.equal(reset.value.charges.resets, parents.length);
    assert.equal(
      reset.value.referenceEntries.filter(([, entry]) => entry.claudeCursor?.offset === 0 && entry.size === 0).length,
      parents.length,
    );
    const result = await worker.run(request, 3, new AbortController().signal);
    assert.ok(result?.value.kind === 'claude-children');
    assert.equal(result.value.continuation, false);
    assert.equal(result.value.charges!.quanta, 0);
    assert.equal(result.value.checkpoint?.completed.length, parents.length);
  } finally {
    worker.stop();
  }
});

test('a production discovery request admits at most eight quanta and ten replies', async () => {
  const directory = tempDir('relationship-production-replies-');
  const parents = Array.from({ length: 11 }, (_, index) => {
    const file = path.join(directory, `${index}.jsonl`);
    fs.writeFileSync(file, '{"type":"ignored"}\n');
    return {
      file,
      sessionId: String(index),
      agent: 'claude' as const,
      ...revisionOf(fs.statSync(file, { bigint: true })),
    };
  });
  const worker = new ProgressiveWorker(source, () => true);
  try {
    let replies = 1;
    const result = await worker.run(
      { kind: 'claude-children', parents, repositoryRoots: [directory] },
      1,
      new AbortController().signal,
      () => {
        replies++;
      },
    );
    assert.ok(result?.value.kind === 'claude-children-progress');
    assert.equal(result.value.charges.quanta, 8);
    assert.ok(replies <= 10);
    console.log(
      `Production discovery reply cap: ${replies} replies, ${worker.transport.replyJsonBytes} serialized reply bytes, ${worker.transport.jsonMs} ms JSON accounting`,
    );
    assert.equal(result.value.checkpoint.completed.length, 8);
    assert.equal(
      (
        await completeDiscovery(
          worker,
          { kind: 'claude-children', parents, repositoryRoots: [directory] },
          2,
          new AbortController().signal,
        )
      )?.value.kind,
      'claude-children',
    );
  } finally {
    worker.stop();
  }
});

test.each(['claude', 'codex'] as const)('%s validation services selected work between read chunks', async (agent) => {
  const directory = tempDir('relationship-chunk-admission-');
  const file = path.join(directory, 'parent.jsonl');
  const selectedFile = path.join(directory, 'selected.jsonl');
  const armed = path.join(directory, 'armed');
  fs.writeFileSync(
    file,
    Array.from({ length: 300 }, () => JSON.stringify({ type: 'ignored', text: 'x'.repeat(1024) }) + '\n').join(''),
  );
  fs.writeFileSync(selectedFile, '{"type":"user","message":{"content":"hello"}}\n');
  const selected = {
    file: selectedFile,
    sessionId: 'selected',
    agent: 'claude',
    ...revisionOf(fs.statSync(selectedFile, { bigint: true })),
  };
  const scheduled = `performance.now=()=>0;const sf=require('node:fs'),sr=sf.readSync;const sp=require('node:worker_threads').parentPort;let queued=false,selectedFinished=false;const send=sp.postMessage.bind(sp);
    sp.postMessage=function(m){if(m.id===999){selectedFinished=true;return;}if(m.result)m.result.selectedFinished=selectedFinished;send(m);};
    sf.readSync=function(...args){const n=sr.apply(this,args);if(!queued&&sf.existsSync(${JSON.stringify(armed)})){queued=true;setImmediate(()=>sp.emit('message',{id:999,generation:88,request:{kind:'metadata',session:${JSON.stringify(selected)}}}));}return n;};`;
  const request = () => ({
    kind: 'claude-children' as const,
    parents: [{ file, agent, sessionId: 'parent', ...revisionOf(fs.statSync(file, { bigint: true })) }],
    repositoryRoots: [directory],
    quantumBytes: 65536,
    discoveryBytes: 65536,
  });
  const worker = new ProgressiveWorker(scheduled + source);
  try {
    const first = await completeDiscovery(worker, request(), 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children');
    fs.appendFileSync(file, '{"type":"ignored"}\n');
    fs.writeFileSync(armed, 'ready');
    let selectedBeforeAcknowledgment: boolean | undefined;
    const result = await worker.run(request(), 2, new AbortController().signal, (reply) => {
      if (reply.value.kind === 'claude-children-delta' && reply.value.referenceEntries.length)
        selectedBeforeAcknowledgment ??= (reply as ProgressiveResult & { selectedFinished: boolean }).selectedFinished;
    });
    assert.ok(result?.value.kind === (agent === 'claude' ? 'claude-children-progress' : 'claude-children'));
    assert.equal(selectedBeforeAcknowledgment, true, 'selected work waited for the whole validation quantum');
  } finally {
    worker.stop();
  }
});

test('restored protected validation precedes a competing source and releases it after completion', async () => {
  const directory = tempDir('relationship-protected-validation-');
  const parents = ['protected', 'waiting'].map((sessionId) => {
    const file = path.join(directory, sessionId + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'ignored', text: 'x'.repeat(700000) }) + '\n');
    return { file, sessionId, agent: 'claude' as const, ...revisionOf(fs.statSync(file, { bigint: true })) };
  });
  let worker = new ProgressiveWorker('performance.now=()=>0;' + source);
  const request = {
    kind: 'claude-children' as const,
    parents,
    repositoryRoots: [directory],
    quantumBytes: 65536,
    discoveryBytes: 65536,
  };
  try {
    let saved:
      | Extract<import('./progressiveworker').ProgressiveValue, { kind: 'claude-children-progress' }>
      | undefined;
    for (let pass = 0; pass < 20; pass++) {
      const result = await worker.run(request, 1, new AbortController().signal);
      assert.ok(result?.value.kind === 'claude-children-progress');
      saved = result.value;
      if (saved.checkpoint.protectedFile) break;
    }
    assert.ok(saved?.checkpoint.protectedFile);
    const protectedParent = parents.find((parent) => normalizeFsPath(parent.file) === saved.checkpoint.protectedFile)!;
    const waiting = parents.find((parent) => parent !== protectedParent)!;
    const before = new Map(saved.referenceEntries);
    const waitingOffset = before.get(normalizeFsPath(waiting.file))?.claudeCursor?.offset ?? 0;
    fs.appendFileSync(protectedParent.file, '{"type":"ignored"}\n');
    const checkpoint = {
      ...saved.checkpoint,
      parents: [waiting, protectedParent],
      catalog: [waiting, protectedParent],
    };
    worker.stop();
    worker = new ProgressiveWorker('performance.now=()=>0;' + source);
    const next = await worker.run(
      { ...request, parents: checkpoint.parents, discovery: checkpoint, referenceEntries: saved.referenceEntries },
      2,
      new AbortController().signal,
    );
    assert.ok(next?.value.kind === 'claude-children-progress');
    const entries = new Map(next.value.referenceEntries);
    assert.ok(entries.get(normalizeFsPath(protectedParent.file))?.claudeCursor?.evidence?.validation?.digest.offset);
    assert.equal(entries.get(normalizeFsPath(waiting.file))?.claudeCursor?.offset ?? 0, waitingOffset);
    const selected = await worker.run(
      { kind: 'metadata', session: { ...waiting, ...revisionOf(fs.statSync(waiting.file, { bigint: true })) } },
      3,
      new AbortController().signal,
    );
    assert.equal(selected?.value.kind, 'metadata');
    const completed = await completeDiscovery(
      worker,
      { ...request, parents: checkpoint.parents },
      4,
      new AbortController().signal,
    );
    assert.ok(completed?.value.kind === 'claude-children');
    assert.equal(completed.value.checkpoint?.protectedFile, undefined);
    assert.equal(
      completed.value.referenceEntries.find(([file]) => file === normalizeFsPath(waiting.file))?.[1].claudeCursor
        ?.offset,
      fs.statSync(waiting.file).size,
    );
  } finally {
    worker.stop();
  }
});

async function discoveryState(
  worker: ProgressiveWorker,
  request: import('./progressiveworker').ProgressiveRequest,
  generation: number,
  signal: AbortSignal,
) {
  const result = await worker.run(request, generation, signal);
  assert.ok(result);
  if (result.value.kind !== 'claude-children' && result.value.kind !== 'claude-children-progress') return result;
  const value = result.value;
  if (value.kind === 'claude-children-progress') {
    for (const key of ['references', 'children', 'dispatchFacts'])
      assert.equal(key in value, false, 'pending state supplied catalog fields');
  }
  const references =
    value.kind === 'claude-children'
      ? value.references
      : value.referenceEntries.flatMap(([, entry]) => {
          const evidence = entry.claudeCursor?.evidence ?? entry.cursor?.evidence;
          return evidence?.validation || evidence?.accepted === null
            ? []
            : (entry.pendingReferences ?? entry.references);
        });
  return {
    ...result,
    value: {
      kind: 'claude-children' as const,
      references,
      children: value.kind === 'claude-children' ? value.children : [],
      dispatchFacts: value.kind === 'claude-children' ? value.dispatchFacts : [],
      referenceEntries: value.referenceEntries,
      complete: value.referenceEntries.every(([, entry]) => entry.relationshipComplete !== false),
      continuation: value.continuation,
    },
  };
}

test('generation 35 empty names reread an unchanged image-bearing rollout after restart', async () => {
  const directory = tempDir('image-title-restart-');
  const file = path.join(directory, 'session.jsonl');
  const cache = path.join(directory, 'derived-session-cache.json');
  const records = opening('codex');
  records.splice(
    2,
    1,
    {
      type: 'response_item',
      timestamp: timestamp(1),
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              '# AGENTS.md instructions for C:/repo\n<INSTRUCTIONS>' +
              'injected-context '.repeat(9000) +
              '</INSTRUCTIONS>',
          },
        ],
      },
    },
    {
      type: 'response_item',
      timestamp: timestamp(1),
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>injected environment</environment_context>' }],
      },
    },
    {
      type: 'response_item',
      timestamp: timestamp(2),
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '**Compare** the screenshot with [the panel](docs/ui-design.md)\nand explain the missing session heading',
          },
          { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(576978) },
        ],
      },
    },
  );
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const { size, mtimeMs } = revisionOf(fs.statSync(file, { bigint: true }));
  const empty: DerivedTitleEntry = {
    size,
    mtimeMs,
    label: '',
    fullLabel: '',
    foldedLabel: '',
    activityMs: null,
    agentRun: false,
    outcome: null,
    stats: null,
  };
  fs.writeFileSync(cache, JSON.stringify({ version: 35, titles: [{ file, entry: empty }], claudeChildReferences: [] }));
  const loaded = loadDerivedCache(cache);
  assert.equal(loaded.titles.has(file), false);
  const worker = new ProgressiveWorker(source);
  try {
    const session = { file, size, mtimeMs, agent: 'codex' as const, sessionId: 'session' };
    const result = await worker.run({ kind: 'metadata', session }, 1, new AbortController().signal);
    assert.ok(result?.value.kind === 'metadata');
    assert.equal(result.value.entry.label, 'Compare the screenshot with the panel and explain the mis...');
    assert.equal(
      result.value.entry.fullLabel,
      'Compare the screenshot with the panel and explain the missing session heading',
    );
    assert.deepEqual({ size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }, { size, mtimeMs });
    saveDerivedCache(cache, [[file, result.value.entry]]);
    const restored = loadDerivedCache(cache).titles.get(file)!;
    assert.equal(restored.label, result.value.entry.label);
    assert.equal(restored.fullLabel, result.value.entry.fullLabel);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('metadata source recovery preserves earlier usage across slices append and restart', async () => {
  const directory = tempDir('metadata-source-slices-');
  const file = path.join(directory, 'session.jsonl');
  const records = [
    ...opening('codex'),
    { type: 'turn_context', timestamp: timestamp(1), payload: { turn_id: 'prompt', model: 'gpt-5-codex' } },
    {
      type: 'event_msg',
      timestamp: timestamp(2),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 12000, output_tokens: 50, cached_input_tokens: 500 },
          total_token_usage: { input_tokens: 12000, output_tokens: 50, cached_input_tokens: 500 },
          model_context_window: 200000,
        },
      },
    },
    ...Array.from({ length: 2000 }, () => ({ type: 'ignored', text: 'x'.repeat(256) })),
    {
      type: 'event_msg',
      timestamp: timestamp(3),
      payload: { type: 'task_complete', turn_id: 'prompt', last_agent_message: 'Finished' },
    },
    { type: 'event_msg', timestamp: timestamp(4), payload: { type: 'task_started', turn_id: 'empty' } },
    { type: 'event_msg', timestamp: timestamp(5), payload: { type: 'task_complete', turn_id: 'empty' } },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  let worker = new ProgressiveWorker(source);
  const request = () => ({
    kind: 'metadata-recovery' as const,
    session: {
      file,
      sessionId: 'session',
      agent: 'codex' as const,
      size: fs.statSync(file).size,
      mtimeMs: fs.statSync(file).mtimeMs,
    },
    eligible: ['session'],
    sliceBytes: 65536,
  });
  try {
    let previous = 0;
    const first = await worker.run(request(), 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'metadata-recovery' && first.value.status === 'pending');
    assert.equal(first.value.through, 65536);
    worker.stop();
    worker = new ProgressiveWorker(source);
    const rebuilt = await worker.run(request(), 1, new AbortController().signal);
    assert.ok(rebuilt?.value.kind === 'metadata-recovery');
    assert.equal(rebuilt.value.through, 65536, 'restart retained an unpublished parser cursor');
    previous = rebuilt.value.through;
    for (let i = 0; i < 20; i++) {
      if (i < 3) fs.appendFileSync(file, JSON.stringify({ type: 'ignored', text: 'append' }) + '\n');
      const result = await worker.run(request(), 1, new AbortController().signal);
      assert.ok(result?.value.kind === 'metadata-recovery');
      assert.ok(result.value.readBytes <= 65536);
      assert.equal(result.value.through - previous, result.value.readBytes, 'a recovery slice repeated source bytes');
      previous = result.value.through;
      if (result.value.status === 'complete') {
        assert.deepEqual(result.value.read, readCodexSession(file, 'session', { tailBytes: fs.statSync(file).size }));
        assert.ok(result.value.read?.turns[0].usage);
        assert.equal(result.value.read?.turns.length, 1, 'an empty newest task displaced drawable history');
        return;
      }
    }
    assert.fail('forward metadata recovery did not finish');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['record', 'retained'] as const)(
  'metadata recovery bounds %s payload without publishing a complete answer',
  async (limit) => {
    const directory = tempDir('metadata-source-limits-');
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(
      file,
      [
        ...opening('codex'),
        ...Array.from({ length: 20 }, (_, i) => ({
          type: 'event_msg',
          timestamp: timestamp(i + 2),
          payload: {
            type: 'agent_message',
            message: 'Distinct update ' + i + ' ' + 'x'.repeat(1024),
            phase: 'commentary',
          },
        })),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const worker = new ProgressiveWorker(source);
    try {
      const result = await worker.run(
        {
          kind: 'metadata-recovery',
          session: {
            file,
            sessionId: 'session',
            agent: 'codex',
            size: fs.statSync(file).size,
            mtimeMs: fs.statSync(file).mtimeMs,
          },
          eligible: ['session'],
          sliceBytes: 65536,
          ...(limit === 'record' ? { recordBytes: 512 } : { retainedBytes: 12000 }),
        },
        1,
        new AbortController().signal,
      );
      assert.ok(result?.value.kind === 'metadata-recovery');
      assert.equal(result.value.status, 'exhausted');
      assert.equal(result.value.read, undefined);
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

// A Codex rollout whose tool output carries a spawn result and a large inline screenshot, as captured from real sessions.
function giantImageRollout(file: string, imageBytes: number): void {
  const records = [
    ...opening('codex'),
    { type: 'turn_context', timestamp: timestamp(1), payload: { turn_id: 'prompt', model: 'gpt-5.6' } },
    {
      type: 'response_item',
      timestamp: timestamp(2),
      payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn', arguments: '{}' },
    },
    {
      type: 'response_item',
      timestamp: timestamp(3),
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'spawn',
        output: [
          { type: 'input_text', text: JSON.stringify({ agent_id: 'child', nickname: 'Child' }) },
          ...(imageBytes
            ? [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'iVBOR'.repeat(imageBytes / 5) }]
            : []),
        ],
      },
    },
    {
      type: 'event_msg',
      timestamp: timestamp(4),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 12000, output_tokens: 50, cached_input_tokens: 500 },
          total_token_usage: { input_tokens: 12000, output_tokens: 50, cached_input_tokens: 500 },
          model_context_window: 200000,
        },
      },
    },
    {
      type: 'event_msg',
      timestamp: timestamp(5),
      payload: { type: 'task_complete', turn_id: 'prompt', last_agent_message: 'Finished' },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

async function recoverInWorker(file: string, extra: object = {}, agent: AgentKind = 'codex') {
  const worker = new ProgressiveWorker(source);
  try {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    for (let slice = 0; slice < 100; slice++) {
      const result = await worker.run(
        {
          kind: 'metadata-recovery',
          session: { file, sessionId: 'session', agent, size: stat.size, mtimeMs: stat.mtimeMs },
          eligible: ['session'],
          sliceBytes: 16 * 1024 * 1024,
          ...extra,
        },
        1,
        new AbortController().signal,
      );
      assert.ok(result?.value.kind === 'metadata-recovery');
      if (result.value.status !== 'pending') return result.value;
    }
    throw new Error('metadata recovery did not finish');
  } finally {
    worker.stop();
  }
}

test('metadata recovery reads a rollout whose tool output holds a 12 MB screenshot', async () => {
  const directory = tempDir('metadata-giant-record-');
  try {
    const giant = path.join(directory, 'giant.jsonl');
    const plain = path.join(directory, 'plain.jsonl');
    giantImageRollout(giant, 12 * 1024 * 1024);
    giantImageRollout(plain, 0);
    const recovered = await recoverInWorker(giant);
    assert.equal(recovered.status, 'complete');
    // Slices that end inside the record carry its reduction across worker requests.
    const sliced = await recoverInWorker(giant, { sliceBytes: 2 * 1024 * 1024 });
    assert.equal(sliced.status, 'complete');
    assert.deepEqual(sessionStatFactsOf(sliced.read!), sessionStatFactsOf(recovered.read!));
    const expected = readCodexSession(plain, 'session', { tailBytes: fs.statSync(plain).size });
    const read = recovered.read!;
    assert.deepEqual(sessionStatFactsOf(read), sessionStatFactsOf(expected));
    assert.deepEqual(sessionOutcomeOf(read), sessionOutcomeOf(expected));
    assert.deepEqual(
      read.turns.map((turn) => [turn.prompt, turn.startedAt, turnCost(turn)]),
      expected.turns.map((turn) => [turn.prompt, turn.startedAt, turnCost(turn)]),
    );
    assert.equal(read.turns[0].prompt, 'Keep this open');
    assert.ok((turnCost(read.turns[0]).dollars ?? 0) > 0, 'the recovered turn lost its cost');
    const outcome = sessionOutcomeOf(read)!;
    assert.ok(
      [
        ...(outcome.openChildren ?? []),
        ...(outcome.closedChildren ?? []).map((child) => (typeof child === 'string' ? child : child.id)),
      ].includes('child'),
      'the spawn result before the screenshot was lost',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('metadata recovery of a 12 MB record holds a small retained charge', () => {
  const directory = tempDir('metadata-giant-charge-');
  try {
    const file = path.join(directory, 'giant.jsonl');
    giantImageRollout(file, 12 * 1024 * 1024);
    const control = {
      through: 0,
      readBytes: 0,
      retainedCharge: 0,
      retainedLimit: 64 * 1024 * 1024,
      recordLimit: 16 * 1024 * 1024,
      reduceAbove: 1024 * 1024,
      accepts: codexSessionLineMayAffectRead,
      fragments: [] as Buffer[],
      fragmentBytes: 0,
    };
    const scan = beginForwardSessionRecovery(
      file,
      'codex',
      'session',
      () => createCodexSessionReducer('session', { maxTurns: 40 }),
      {
        chunkBytes: 256 * 1024,
        recovery: control,
      },
    );
    let peak = 0;
    let held = 0;
    for (let next = scan.next(); ; next = scan.next()) {
      peak = Math.max(peak, control.retainedCharge);
      held = Math.max(
        held,
        control.fragments.reduce((total, fragment) => total + fragment.length, 0),
      );
      if (next.done) {
        assert.ok(next.value.read, 'recovery published no answer');
        break;
      }
    }
    // Reduction starts once the unfinished record passes 1 MiB, so at most 1 MiB and one chunk of it is held whole.
    assert.ok(held <= 1024 * 1024 + 256 * 1024, `recovery held ${held} bytes of one record`);
    assert.ok(peak < 64 * 1024, `the reduced record charged ${peak} bytes`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('metadata recovery keeps compaction usage and Claude facts past reduced records', async () => {
  const directory = tempDir('metadata-reduced-records-');
  const limits = { reduceAboveBytes: 4096, recordBytes: 256 * 1024 };
  const write = (file: string, records: object[]) =>
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const compacted = (history: object[]) => [
    ...opening('codex'),
    { type: 'turn_context', timestamp: timestamp(1), payload: { turn_id: 'prompt', model: 'gpt-5.6' } },
    {
      type: 'compacted',
      timestamp: timestamp(2),
      payload: {
        message: '',
        replacement_history: history,
        latest_token_usage_record: { usage: { input_tokens: 30000, output_tokens: 10, cached_input_tokens: 0 } },
      },
    },
    {
      type: 'event_msg',
      timestamp: timestamp(3),
      payload: { type: 'task_complete', turn_id: 'prompt', last_agent_message: 'Finished' },
    },
  ];
  const document = (data: string) => [
    {
      type: 'user',
      promptId: 'prompt',
      timestamp: timestamp(0),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this report' },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
        ],
      },
    },
    {
      type: 'assistant',
      timestamp: timestamp(1),
      requestId: 'request',
      message: {
        id: 'message',
        model: 'claude-opus-4-6',
        role: 'assistant',
        content: [{ type: 'text', text: 'Read it' }],
        usage: { input_tokens: 4000, output_tokens: 20 },
      },
    },
  ];
  try {
    const files = Object.fromEntries(
      ['codex-giant', 'codex-plain', 'claude-giant', 'claude-plain'].map((name) => [
        name,
        path.join(directory, name + '.jsonl'),
      ]),
    );
    const history = Array.from({ length: 64 }, (_, i) => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Earlier ] "work" ' + i + ' ' + 'x'.repeat(32 * 1024) }],
    }));
    write(files['codex-giant'], compacted(history));
    write(files['codex-plain'], compacted([]));
    write(files['claude-giant'], document('JVBER'.repeat(440 * 1024)));
    write(files['claude-plain'], document('JVBER'));
    assert.ok(fs.statSync(files['codex-giant']).size > 2 * 1024 * 1024);
    assert.ok(fs.statSync(files['claude-giant']).size > 2 * 1024 * 1024);

    const codex = await recoverInWorker(files['codex-giant'], limits);
    assert.equal(codex.status, 'complete');
    const codexExpected = readCodexSession(files['codex-plain'], 'session', {
      tailBytes: fs.statSync(files['codex-plain']).size,
    });
    assert.deepEqual(sessionStatFactsOf(codex.read!), sessionStatFactsOf(codexExpected));
    assert.equal(codex.read!.compactions.length, 1);
    assert.equal(codex.read!.compactions[0].contextBefore, 30000, 'the compaction lost its usage');

    const claude = await recoverInWorker(files['claude-giant'], limits, 'claude');
    assert.equal(claude.status, 'complete');
    const claudeExpected = readSession(files['claude-plain'], 'session', {
      tailBytes: fs.statSync(files['claude-plain']).size,
    });
    assert.deepEqual(sessionStatFactsOf(claude.read!), sessionStatFactsOf(claudeExpected));
    assert.deepEqual(sessionOutcomeOf(claude.read!), sessionOutcomeOf(claudeExpected));
    assert.ok(claude.read!.turns[0].usage, 'the Claude turn lost its usage');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('metadata recovery drops a broken reduced record and reads a reduced last record', async () => {
  const directory = tempDir('metadata-reduced-edges-');
  const limits = { reduceAboveBytes: 4096, recordBytes: 256 * 1024 };
  const usage = (input: number, padding = '') => ({
    type: 'event_msg',
    timestamp: timestamp(3),
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: input, output_tokens: 50, cached_input_tokens: 0 },
        total_token_usage: { input_tokens: input, output_tokens: 50, cached_input_tokens: 0 },
        model_context_window: 200000,
        ...(padding ? { padding } : {}),
      },
    },
  });
  const lines = (...records: (object | string)[]) =>
    records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record)));
  const turn = [
    ...opening('codex'),
    { type: 'turn_context', timestamp: timestamp(2), payload: { turn_id: 'prompt', model: 'gpt-5.6' } },
  ];
  const broken = '{"type":"compacted","payload":{"message":"' + 'x'.repeat(8192);
  const padding = 'x'.repeat(8192);
  const files: Record<string, string> = {
    plain: lines(...turn, usage(12000)).join('\n') + '\n',
    brokenMiddle: lines(...turn, broken, usage(12000)).join('\n') + '\n',
    brokenLast: lines(...turn, usage(12000), broken).join('\n'),
    paddedLast: lines(...turn, usage(12000, padding)).join('\n'),
  };
  try {
    const recovered: Record<string, Awaited<ReturnType<typeof recoverInWorker>>> = {};
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(directory, name + '.jsonl');
      fs.writeFileSync(file, text);
      recovered[name] = await recoverInWorker(file, limits);
    }
    const expected = sessionStatFactsOf(recovered.plain.read!);
    assert.ok(
      expected?.turns.some((turn) => turn.contextTokens),
      'the plain rollout has no context figure to compare',
    );
    for (const name of ['brokenMiddle', 'brokenLast', 'paddedLast']) {
      assert.equal(recovered[name].status, 'complete', name);
      assert.deepEqual(sessionStatFactsOf(recovered[name].read!), expected, name);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('metadata recovery keeps the end of a long Agent result in a child transcript', async () => {
  const directory = tempDir('metadata-reduced-agent-tail-');
  const file = path.join(directory, 'child.jsonl');
  const id = 'a6dc23d1b0eaed94d';
  const report =
    'Report line with \\ "quotes" and é\n'.repeat(12_000) +
    `agentId: ${id} (use SendMessage with to: '${id}', summary: '<5-10 word recap>' to continue this agent)\n` +
    '<usage>subagent_tokens: 63920\ntool_uses: 57\nduration_ms: 221257</usage>';
  const sidechain = { isSidechain: true, agentId: 'child-1', cwd: 'c:/repo' };
  const records = [
    {
      ...sidechain,
      type: 'user',
      timestamp: timestamp(0),
      message: { role: 'user', content: 'launch a nested agent' },
    },
    {
      ...sidechain,
      type: 'assistant',
      timestamp: timestamp(1),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'launch', name: 'Agent', input: { description: 'Nested sweep' } }],
      },
    },
    {
      ...sidechain,
      type: 'user',
      timestamp: timestamp(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'launch', content: [{ type: 'text', text: report }] }],
      },
    },
    {
      ...sidechain,
      type: 'assistant',
      timestamp: timestamp(3),
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'The sweep finished.' }] },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  try {
    assert.ok(Buffer.byteLength(report) > 4 * 64 * 1024, 'the report is too short to lose its middle');
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    const session = { file, sessionId: 'child-1', agent: 'claude', size: stat.size, mtimeMs: stat.mtimeMs };
    const recovered = await recoverInWorker(
      file,
      { reduceAboveBytes: 4096, session: { ...session, childTranscript: true }, eligible: ['child-1'] },
      'claude',
    );
    assert.equal(recovered.status, 'complete');
    const rows = (read: SessionRead) =>
      read.turns.flatMap((turn) =>
        turn.agents.map(({ id, status, tokens, toolUses, durationMs }) => ({
          id,
          status,
          tokens,
          toolUses,
          durationMs,
        })),
      );
    const expected = rows(readSession(file, 'child-1', { tailBytes: stat.size, childTranscript: true }));
    assert.deepEqual(expected, [{ id, status: 'completed', tokens: 63920, toolUses: 57, durationMs: 221257 }]);
    assert.deepEqual(rows(recovered.read!), expected, 'the reduced result lost the end its child id is read from');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude worker requests leave the Codex catalog canonical paths untouched', async () => {
  const directory = tempDir('worker-claude-codex-paths-');
  const file = path.join(directory, 'parent.jsonl');
  const marker = path.join(directory, 'realpath-calls');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'user', timestamp: timestamp(0), message: { role: 'user', content: 'review' } }) + '\n',
  );
  const instrumented =
    source +
    `\nconst nativePath = require('node:fs').realpathSync.native; require('node:fs').realpathSync.native = (...args) => { require('node:fs').appendFileSync(${JSON.stringify(marker)}, String(args[0]) + '\\n'); return nativePath(...args); };`;
  const worker = new ProgressiveWorker(instrumented);
  try {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    const result = await worker.run(
      {
        kind: 'window',
        input: {
          session: { agent: 'claude', file, sessionId: 'parent', size: stat.size, mtimeMs: stat.mtimeMs },
          folders: [],
          maxTurns: 40,
          tailBytes: 4096,
          children: [
            {
              file: path.join(directory, 'codex.jsonl'),
              threadId: 'codex',
              parentThreadId: 'other',
              agentPath: '/root/codex',
              openedAt: null,
              startedAt: null,
              threadSource: 'subagent',
              backgroundReview: false,
            },
          ],
        },
      },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'window');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    worker.stop();
  }
});

test('a Claude worker window passes built-in commands the CLI answered beyond the tail to the earlier real turn', async () => {
  const directory = tempDir('worker-claude-local-commands-');
  const file = path.join(directory, 'parent.jsonl');
  const records: object[] = [
    { type: 'user', uuid: 'real', timestamp: timestamp(0), message: { role: 'user', content: 'real question' } },
    {
      type: 'assistant',
      uuid: 'real-answer',
      timestamp: timestamp(1),
      message: {
        role: 'assistant',
        model: 'claude-opus-4-1',
        content: [{ type: 'text', text: 'real answer' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
  const command = (uuid: string, second: number) => ({
    type: 'user',
    uuid,
    timestamp: timestamp(second),
    message: {
      role: 'user',
      content:
        '<command-name>/mcp</command-name>\n<command-message>mcp</command-message>\n<command-args></command-args>',
    },
  });
  const answer = (uuid: string, second: number, text: string) => ({
    type: 'user',
    uuid: `${uuid}-answer`,
    parentUuid: uuid,
    timestamp: timestamp(second),
    message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` },
  });
  for (let index = 0; index < 40; index++) {
    records.push(command(`mcp-${index}`, 2 + index), answer(`mcp-${index}`, 2 + index, 'Reconnected. '.repeat(20)));
  }
  // The tail starts inside the newest command, so only the tail holds its answer.
  const blank = JSON.stringify(answer('mcp-last', 50, '')).length;
  records.push(command('mcp-last', 50), answer('mcp-last', 50, 'x'.repeat(3950 - blank)));
  const lines = records.map((record) => JSON.stringify(record));
  const [commandBytes, answerBytes] = lines.slice(-2).map((line) => Buffer.byteLength(line) + 1);
  assert.ok(
    answerBytes < 4096 && commandBytes + answerBytes > 4096,
    'the tail no longer splits a command from its answer',
  );
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const worker = new ProgressiveWorker(source);
  try {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    const result = await worker.run(
      {
        kind: 'window',
        input: {
          session: { agent: 'claude', file, sessionId: 'parent', size: stat.size, mtimeMs: stat.mtimeMs },
          folders: [],
          maxTurns: 40,
          tailBytes: 4096,
          children: [],
        },
      },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'window');
    assert.deepEqual(
      result.value.read.turns.map((turn) => turn.prompt),
      ['real question'],
      'the timeline opened without the real turn before the commands',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function dispatchWorkerSource(requestKiB: number, cursorKiB = 64 * 1024): string {
  return source
    .replace(
      'var CODEX_DISPATCH_REQUEST_BYTES = 8 * 1024 * 1024;',
      `var CODEX_DISPATCH_REQUEST_BYTES = ${requestKiB} * 1024;`,
    )
    .replace(
      'var MAX_CODEX_DISPATCH_CURSOR_BYTES = 64 * 1024 * 1024;',
      `var MAX_CODEX_DISPATCH_CURSOR_BYTES = ${cursorKiB} * 1024;`,
    );
}

test('stable partial Codex parents yield to a later dispatch and resume after an append', async () => {
  const directory = tempDir('panel-progressive-codex-fair-');
  const childId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const child = path.join(directory, `${childId}.jsonl`);
  fs.writeFileSync(child, `${JSON.stringify({ type: 'user', cwd: directory })}\n`);
  const parents = Array.from({ length: 6 }, (_unused, index) => {
    const file = path.join(directory, `parent-${index}.jsonl`);
    const records = [
      { type: 'session_meta', timestamp: timestamp(0), payload: { id: `parent-${index}`, cwd: directory } },
      { type: 'event_msg', timestamp: timestamp(1), payload: { type: 'task_started', turn_id: `turn-${index}` } },
      { type: 'turn_context', timestamp: timestamp(2), payload: { turn_id: `turn-${index}` } },
    ];
    const opening = records.map((record) => JSON.stringify(record) + '\n').join('');
    const tail =
      index === 5
        ? JSON.stringify({
            type: 'event_msg',
            timestamp: timestamp(3),
            payload: {
              type: 'item_completed',
              item: {
                type: 'CommandExecution',
                id: 'launch',
                parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
                stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
              },
            },
          }) + '\n'
        : JSON.stringify({ type: 'ignored', payload: 'x'.repeat(5 * 1024) }).slice(0, -2);
    fs.writeFileSync(file, opening + tail);
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { agent: 'codex' as const, file, sessionId: `parent-${index}`, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const worker = new ProgressiveWorker(dispatchWorkerSource(36));
  try {
    const request = {
      kind: 'claude-children' as const,
      parents,
      catalog: [
        { agent: 'claude' as const, file: child, sessionId: childId, size: childStat.size, mtimeMs: childStat.mtimeMs },
      ],
      repositoryRoots: [directory],
    };
    const first = await discoveryState(worker, request, 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children');
    assert.equal(first.value.complete, false);
    assert.equal(first.value.continuation, true);
    let entries = first.value.referenceEntries;
    let found = false;
    for (let pass = 2; pass <= 40; pass++) {
      const result = await discoveryState(
        worker,
        { ...request, referenceEntries: entries },
        pass,
        new AbortController().signal,
      );
      assert.ok(result?.value.kind === 'claude-children');
      entries = result.value.referenceEntries;
      found = result.value.references.some((reference) => reference.sessionId === childId);
      if (found) {
        assert.equal(result.value.complete, false, 'partial parents gave a complete negative answer');
        assert.equal(result.value.continuation, false, 'stable EOF requested another scan');
        break;
      }
    }
    assert.equal(found, true, 'unchanged partial parents starved the later dispatch');
    fs.appendFileSync(parents[0].file, '"}\n');
    const stat = revisionOf(fs.statSync(parents[0].file, { bigint: true }));
    parents[0] = { ...parents[0], size: stat.size, mtimeMs: stat.mtimeMs };
    const appended = await discoveryState(
      worker,
      { ...request, parents, referenceEntries: entries },
      5,
      new AbortController().signal,
    );
    assert.ok(appended?.value.kind === 'claude-children');
    assert.equal(
      appended.value.referenceEntries.find(([, entry]) => entry.sessionId === 'parent-0')?.[1].complete,
      true,
    );
    // The parent stops growing. Discovery then settles, so the session list can complete.
    let settled = appended;
    for (let pass = 6; pass <= 12 && settled.value.kind === 'claude-children' && settled.value.continuation; pass++) {
      const next = await discoveryState(
        worker,
        { ...request, parents, referenceEntries: settled.value.referenceEntries },
        pass,
        new AbortController().signal,
      );
      assert.ok(next?.value.kind === 'claude-children');
      settled = next;
    }
    assert.ok(settled.value.kind === 'claude-children');
    assert.equal(settled.value.continuation, false, 'a parent that grew once and then stopped kept discovery pending');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a Codex parent that grows after its scan keeps discovery pending until the next pass reads the new bytes', async () => {
  const directory = tempDir('panel-progressive-codex-grown-');
  const childId = '6b8c18d2-c0d0-4e07-8fc3-9f02a710a992';
  const child = path.join(directory, `${childId}.jsonl`);
  fs.writeFileSync(child, JSON.stringify({ type: 'user', cwd: directory }) + String.fromCharCode(10));
  const file = path.join(directory, 'parent.jsonl');
  const line = (record: object) => JSON.stringify(record) + String.fromCharCode(10);
  fs.writeFileSync(
    file,
    line({ type: 'session_meta', timestamp: timestamp(0), payload: { id: 'parent', cwd: directory } }) +
      line({ type: 'event_msg', timestamp: timestamp(1), payload: { type: 'task_started', turn_id: 'turn' } }) +
      line({ type: 'turn_context', timestamp: timestamp(2), payload: { turn_id: 'turn' } }),
  );
  const launch = line({
    type: 'event_msg',
    timestamp: timestamp(3),
    payload: {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'launch',
        parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
        stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
      },
    },
  });
  // The launch lands after the parent scan and before the walk that checks every parent again.
  const mutate = path.join(directory, 'mutate');
  const parts = source.split('found = walk();');
  assert.equal(parts.length, 3, 'the worker no longer walks once before and once after its parent scans');
  const grow = `if (require('node:fs').existsSync(${JSON.stringify(mutate)})) { require('node:fs').appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(launch)}); require('node:fs').unlinkSync(${JSON.stringify(mutate)}); }`;
  const worker = new ProgressiveWorker(parts[0] + 'found = walk();' + parts[1] + grow + 'found = walk();' + parts[2]);
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const request = (referenceEntries?: unknown) => {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return {
      kind: 'claude-children' as const,
      parents: [{ agent: 'codex' as const, file, sessionId: 'parent', size: stat.size, mtimeMs: stat.mtimeMs }],
      catalog: [
        { agent: 'claude' as const, file: child, sessionId: childId, size: childStat.size, mtimeMs: childStat.mtimeMs },
      ],
      repositoryRoots: [directory],
      ...(referenceEntries ? { referenceEntries } : {}),
    } as import('./progressiveworker').ProgressiveRequest;
  };
  try {
    fs.writeFileSync(mutate, 'grow');
    const grown = await discoveryState(worker, request(), 1, new AbortController().signal);
    assert.ok(grown?.value.kind === 'claude-children');
    assert.equal(fs.existsSync(mutate), false, 'the parent did not grow during the pass');
    assert.equal(grown.value.continuation, true, 'a parent that grew during the pass claimed discovery complete');
    assert.equal(grown.value.references.length, 0, 'the pass read bytes written after its scan');
    const next = await discoveryState(worker, request(grown.value.referenceEntries), 2, new AbortController().signal);
    assert.ok(next?.value.kind === 'claude-children');
    assert.ok(
      next.value.references.some((reference) => reference.sessionId === childId),
      'the next pass treated the grown bytes as already read',
    );
    assert.equal(next.value.continuation, false, 'the parent stopped growing but discovery stayed pending');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a rotated scan hides a changed parent until it reads the replacement receipt', async () => {
  const directory = tempDir('panel-progressive-codex-rotated-');
  const oldId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const newId = '6b8c18d2-c0d0-4ea7-aec3-9f02ac71a992';
  const catalog = [oldId, newId].map((sessionId) => {
    const file = path.join(directory, `${sessionId}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: directory })}\n`);
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { agent: 'claude' as const, file, sessionId, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const receipt = (sessionId: string) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'launch',
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
          stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${sessionId}"}`,
        },
      },
    }) + '\n';
  const firstFile = path.join(directory, 'parent-0.jsonl');
  const prefix = [
    { type: 'session_meta', payload: { id: 'parent-0', cwd: directory } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'launch' } },
    { type: 'turn_context', payload: { turn_id: 'launch' } },
  ]
    .map((record) => JSON.stringify(record) + '\n')
    .join('');
  fs.writeFileSync(
    firstFile,
    prefix + receipt(oldId) + `${JSON.stringify({ type: 'ignored', payload: 'x'.repeat(9 * 1024 * 1024) })}\n`,
  );
  const secondFile = path.join(directory, 'parent-1.jsonl');
  fs.writeFileSync(
    secondFile,
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'parent-1', cwd: directory } })}\n`,
  );
  const parents = [firstFile, secondFile].map((file, index) => {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { agent: 'codex' as const, file, sessionId: `parent-${index}`, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const worker = new ProgressiveWorker(source);
  try {
    const request = { kind: 'claude-children' as const, parents, catalog, repositoryRoots: [directory] };
    const first = await discoveryState(worker, request, 1, new AbortController().signal);
    assert.equal(first?.value.kind, 'claude-children');
    if (!first || first.value.kind !== 'claude-children') return;
    assert.deepEqual(
      first.value.references.map((reference) => reference.sessionId),
      [oldId],
    );
    const original = fs.readFileSync(firstFile, 'utf8');
    fs.writeFileSync(firstFile, original.replace(oldId, newId));
    const changed = new Date(parents[0].mtimeMs + 1000);
    fs.utimesSync(firstFile, changed, changed);
    const stat = revisionOf(fs.statSync(firstFile, { bigint: true }));
    parents[0] = { ...parents[0], size: stat.size, mtimeMs: stat.mtimeMs };
    assert.equal(stat.size, first.value.referenceEntries.find(([, entry]) => entry.sessionId === 'parent-0')?.[1].size);
    const waiting = await discoveryState(
      worker,
      { ...request, parents, referenceEntries: first.value.referenceEntries },
      2,
      new AbortController().signal,
    );
    assert.equal(waiting?.value.kind, 'claude-children');
    if (!waiting || waiting.value.kind !== 'claude-children') return;
    assert.deepEqual(
      waiting.value.references.filter((reference) => reference.sessionId === oldId),
      [],
    );
    let rescanned = await discoveryState(
      worker,
      { ...request, parents, referenceEntries: waiting.value.referenceEntries },
      3,
      new AbortController().signal,
    );
    for (
      let pass = 0;
      rescanned?.value.kind === 'claude-children' &&
      !rescanned.value.references.some((reference) => reference.sessionId === newId) &&
      pass < 40;
      pass++
    )
      rescanned = await discoveryState(
        worker,
        { ...request, parents, referenceEntries: rescanned.value.referenceEntries },
        3,
        new AbortController().signal,
      );
    assert.equal(rescanned?.value.kind, 'claude-children');
    if (rescanned?.value.kind === 'claude-children')
      assert.deepEqual(
        rescanned.value.references.map((reference) => reference.sessionId),
        [newId],
      );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a pass after a complete reply that asks for another pass starts its count at the unchanged finished sources', async () => {
  const directory = tempDir('panel-progressive-seeded-pass-');
  const line = (record: object) => JSON.stringify(record) + String.fromCharCode(10);
  const parents = Array.from({ length: 5 }, (_unused, index) => {
    const file = path.join(directory, `parent-${index}.jsonl`);
    fs.writeFileSync(file, line({ type: 'user', cwd: directory, message: { content: `prompt ${index}` } }));
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { agent: 'claude' as const, file, sessionId: `parent-${index}`, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const worker = new ProgressiveWorker(source);
  try {
    const request = () =>
      ({
        kind: 'claude-children',
        parents,
        repositoryRoots: [directory],
      }) as import('./progressiveworker').ProgressiveRequest;
    const first = await completeDiscovery(worker, request(), 1, new AbortController().signal);
    assert.equal(first?.value.kind, 'claude-children');
    // An active session writes to its transcript, so the follow-up pass finds one grown parent.
    fs.appendFileSync(parents[0].file, line({ type: 'user', cwd: directory, message: { content: 'follow-up' } }));
    const grown = revisionOf(fs.statSync(parents[0].file, { bigint: true }));
    parents[0] = { ...parents[0], size: grown.size, mtimeMs: grown.mtimeMs };
    const counts: number[] = [];
    const completed = new Set<string>();
    const second = await worker.run(request(), 2, new AbortController().signal, (result) => {
      if (result.value.kind !== 'claude-children-delta') return true;
      for (const file of result.value.checkpoint?.completed ?? []) completed.add(file);
      for (const [file, complete] of result.value.completed) if (complete) completed.add(file);
      counts.push(completed.size - Number(completed.has(normalizeFsPath(parents[0].file))));
      return true;
    });
    assert.equal(second?.value.kind, 'claude-children');
    if (second?.value.kind !== 'claude-children') return;
    assert.equal(counts[0], 4, 'the follow-up count restarted below the unchanged finished sources');
    assert.equal(second.value.charges?.quanta, 1, 'the follow-up pass read an unchanged finished source');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a pass keeps an active transcript that grows after its seed check', async () => {
  const directory = tempDir('panel-progressive-seed-growth-');
  const line = (record: object) => JSON.stringify(record) + String.fromCharCode(10);
  const files = ['finished', 'active'].map((name) => {
    const file = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(file, line({ type: 'user', cwd: directory, message: { content: name } }));
    return file;
  });
  const parents = () =>
    files.map((file, index) => {
      const stat = revisionOf(fs.statSync(file, { bigint: true }));
      return { agent: 'claude' as const, file, sessionId: `parent-${index}`, size: stat.size, mtimeMs: stat.mtimeMs };
    });
  // The worker appends to the active transcript right after its next stat, as an agent writing between two checks would.
  const marker = files[1] + '.grow';
  const growing = buildSync({
    entryPoints: [path.join(__dirname, 'progressiveworker-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    banner: {
      js: `(() => {
        const fs = require('node:fs');
        const stat = fs.statSync;
        fs.statSync = function (file, ...rest) {
          const value = stat.call(this, file, ...rest);
          if (String(file) === ${JSON.stringify(files[1])} && fs.existsSync(${JSON.stringify(marker)})) {
            fs.unlinkSync(${JSON.stringify(marker)});
            fs.appendFileSync(file, ${JSON.stringify(line({ type: 'user', cwd: directory, message: { content: 'more' } }))});
          }
          return value;
        };
      })();`,
    },
  }).outputFiles[0].text;
  const worker = new ProgressiveWorker(growing);
  try {
    const request = (): import('./progressiveworker').ProgressiveRequest => ({
      kind: 'claude-children',
      parents: parents(),
      repositoryRoots: [directory],
    });
    const first = await completeDiscovery(worker, request(), 1, new AbortController().signal);
    assert.equal(first?.value.kind, 'claude-children');
    // The finished source changes, so the next pass creates an epoch and seeds it.
    fs.appendFileSync(files[0], line({ type: 'user', cwd: directory, message: { content: 'again' } }));
    fs.appendFileSync(files[1], line({ type: 'user', cwd: directory, message: { content: 'again' } }));
    fs.writeFileSync(marker, '');
    const second = await worker.run(request(), 2, new AbortController().signal);
    assert.equal(fs.existsSync(marker), false, 'the worker never checked the active transcript');
    assert.equal(second?.value.kind, 'claude-children', 'growth after the seed check reset the active transcript');
    if (second?.value.kind !== 'claude-children') return;
    assert.equal(second.value.charges?.resets, 0);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a pass after a complete reply reads an unchanged Codex rollout that stopped before its end', async () => {
  const directory = tempDir('panel-progressive-seeded-codex-');
  const file = path.join(directory, 'parent.jsonl');
  const filler = JSON.stringify({ type: 'ignored', payload: 'x'.repeat(1024) }) + String.fromCharCode(10);
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', timestamp: timestamp(0), payload: { id: 'parent', cwd: directory } }) +
      String.fromCharCode(10) +
      filler.repeat(160),
  );
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const parent = { agent: 'codex' as const, file, sessionId: 'parent', size: stat.size, mtimeMs: stat.mtimeMs };
  const worker = new ProgressiveWorker(source);
  try {
    const request = {
      kind: 'claude-children' as const,
      parents: [parent],
      repositoryRoots: [directory],
      discoveryBytes: 64 * 1024,
    };
    const first = await worker.run(request, 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children');
    assert.equal(first.value.continuation, true, 'the first pass reached the end of the rollout');
    const stopped = first.value.referenceEntries[0][1];
    assert.equal(stopped.visitedEof, false);
    const second = await worker.run(request, 2, new AbortController().signal);
    assert.ok(second?.value.kind === 'claude-children');
    assert.equal(second.value.charges?.hits, 0, 'an unfinished Codex rollout counted as finished');
    assert.equal(second.value.charges?.quanta, 1, 'the follow-up pass skipped an unfinished Codex rollout');
    assert.ok(second.value.referenceEntries[0][1].cursor!.offset > stopped.cursor!.offset);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unfinished cursor overflow keeps discovery and saved progress alive', async () => {
  const directory = tempDir('panel-progressive-codex-overflow-');
  const childId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const child = path.join(directory, `${childId}.jsonl`);
  fs.writeFileSync(child, `${JSON.stringify({ type: 'user', cwd: directory })}\n`);
  const parents = Array.from({ length: 8 }, (_unused, index) => {
    const file = path.join(directory, `parent-${index}.jsonl`);
    fs.writeFileSync(
      file,
      index === 7
        ? [
            { type: 'session_meta', payload: { id: `parent-${index}`, cwd: directory } },
            { type: 'event_msg', payload: { type: 'task_started', turn_id: 'launch' } },
            { type: 'turn_context', payload: { turn_id: 'launch' } },
            {
              type: 'event_msg',
              payload: {
                type: 'item_completed',
                item: {
                  type: 'CommandExecution',
                  id: 'launch',
                  parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
                  stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
                },
              },
            },
          ]
            .map((record) => JSON.stringify(record) + '\n')
            .join('')
        : `${JSON.stringify({ type: 'session_meta', payload: { id: `parent-${index}`, cwd: directory } })}\n${JSON.stringify({ type: 'ignored', payload: 'x'.repeat(100 * 1024) })}\n`,
    );
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { agent: 'codex' as const, file, sessionId: `parent-${index}`, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const request = {
    kind: 'claude-children' as const,
    parents,
    catalog: [
      { agent: 'claude' as const, file: child, sessionId: childId, size: childStat.size, mtimeMs: childStat.mtimeMs },
    ],
    repositoryRoots: [directory],
  };
  const limitedSource = dispatchWorkerSource(24, 0.25);
  assert.ok(limitedSource.includes('var MAX_CODEX_DISPATCH_CURSOR_BYTES = 0.25 * 1024;'));
  let worker = new ProgressiveWorker(limitedSource);
  try {
    let entries: Array<[string, import('./derivedcache').ClaudeChildReferenceCacheEntry]> = [];
    let found = false;
    for (let pass = 1; pass <= 120; pass++) {
      const result = await discoveryState(
        worker,
        { ...request, referenceEntries: entries },
        pass,
        new AbortController().signal,
      );
      assert.ok(result?.value.kind === 'claude-children', 'cursor overflow aborted discovery');
      entries = result.value.referenceEntries;
      assert.ok(
        entries.reduce(
          (bytes, [, entry]) => bytes + (entry.cursor ? Buffer.byteLength(JSON.stringify(entry.cursor)) : 0),
          0,
        ) <= 256,
      );
      assert.ok(
        entries.some(([, entry]) => entry.complete === false && !entry.cursor),
        'the fixture evicted no unfinished cursor',
      );
      assert.equal(result.value.complete, false, 'evicted unfinished cursors became a complete answer');
      if (pass === 3) {
        const cacheFile = path.join(directory, 'cache.json');
        saveDerivedCache(cacheFile, [], entries);
        entries = [...loadDerivedCache(cacheFile).claudeChildReferences];
        worker.stop();
        worker = new ProgressiveWorker(limitedSource);
      }
      found = result.value.references.some((reference) => reference.sessionId === childId);
      if (found) break;
    }
    assert.equal(found, true, 'evicted early cursors kept the later parent from discovery');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a cursorless incomplete parent keeps its child after cache reload and resumes scanning', async () => {
  const directory = tempDir('panel-progressive-codex-cursorless-');
  const childId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const child = path.join(directory, `${childId}.jsonl`);
  fs.writeFileSync(child, `${JSON.stringify({ type: 'user', cwd: directory })}\n`);
  const file = path.join(directory, 'parent.jsonl');
  const opening = [
    { type: 'session_meta', payload: { id: 'parent', cwd: directory } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'launch' } },
    { type: 'turn_context', payload: { turn_id: 'launch' } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'launch',
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
          stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
        },
      },
    },
  ];
  fs.writeFileSync(file, opening.map((record) => JSON.stringify(record) + '\n').join(''));
  for (let index = 0; index < 9; index++)
    fs.appendFileSync(file, `${JSON.stringify({ type: 'ignored', payload: 'x'.repeat(1024 * 1024) })}\n`);
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const request = {
    kind: 'claude-children' as const,
    parents: [{ agent: 'codex' as const, file, sessionId: 'parent', size: stat.size, mtimeMs: stat.mtimeMs }],
    catalog: [
      { agent: 'claude' as const, file: child, sessionId: childId, size: childStat.size, mtimeMs: childStat.mtimeMs },
    ],
    repositoryRoots: [directory],
  };
  let worker = new ProgressiveWorker(source);
  try {
    const first = await discoveryState(worker, request, 1, new AbortController().signal);
    assert.equal(first?.value.kind, 'claude-children');
    if (!first || first.value.kind !== 'claude-children') return;
    assert.equal(first.value.complete, false);
    assert.deepEqual(
      first.value.references.map((reference) => reference.sessionId),
      [childId],
    );
    const evicted = limitCodexDispatchCursors(first.value.referenceEntries, 0);
    assert.equal(evicted[0][1].cursor, undefined);
    const cacheFile = path.join(directory, 'cache.json');
    saveDerivedCache(cacheFile, [], evicted);
    const restored = [...loadDerivedCache(cacheFile).claudeChildReferences];
    assert.equal(restored.length, 1);
    worker.stop();
    worker = new ProgressiveWorker(source);
    const resumed = await discoveryState(
      worker,
      { ...request, referenceEntries: restored },
      2,
      new AbortController().signal,
    );
    assert.equal(resumed?.value.kind, 'claude-children');
    if (resumed?.value.kind === 'claude-children') {
      assert.deepEqual(
        resumed.value.references.map((reference) => reference.sessionId),
        [childId],
      );
      assert.ok(resumed.value.referenceEntries[0][1].cursor?.offset);
    }
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a classified dispatch beyond the first resumed budget stays visible through reconstruction', async () => {
  const directory = tempDir('panel-progressive-codex-late-dispatch-');
  const childId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const child = path.join(directory, `${childId}.jsonl`);
  fs.writeFileSync(child, `${JSON.stringify({ type: 'user', cwd: directory })}\n`);
  const file = path.join(directory, 'parent.jsonl');
  const opening = [
    { type: 'session_meta', payload: { id: 'parent', cwd: directory } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'launch' } },
    { type: 'turn_context', payload: { turn_id: 'launch' } },
  ];
  fs.writeFileSync(file, opening.map((record) => JSON.stringify(record) + '\n').join(''));
  const filler = `${JSON.stringify({ type: 'ignored', payload: 'x'.repeat(1024 * 1024) })}\n`;
  for (let index = 0; index < 9; index++) fs.appendFileSync(file, filler);
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'launch',
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
          stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
        },
      },
    })}\n`,
  );
  for (let index = 0; index < 9; index++) fs.appendFileSync(file, filler);
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const request = {
    kind: 'claude-children' as const,
    parents: [{ agent: 'codex' as const, file, sessionId: 'parent', size: stat.size, mtimeMs: stat.mtimeMs }],
    catalog: [
      { agent: 'claude' as const, file: child, sessionId: childId, size: childStat.size, mtimeMs: childStat.mtimeMs },
    ],
    repositoryRoots: [directory],
  };
  let worker = new ProgressiveWorker(source);
  try {
    let result = await discoveryState(worker, request, 1, new AbortController().signal);
    assert.ok(result?.value.kind === 'claude-children');
    assert.deepEqual(result.value.references, [], 'the first budget reached the receipt');
    for (let pass = 2; pass <= 50; pass++) {
      result = await discoveryState(
        worker,
        { ...request, referenceEntries: result.value.referenceEntries },
        pass,
        new AbortController().signal,
      );
      assert.ok(result?.value.kind === 'claude-children');
      if (result.value.references.some((reference) => reference.sessionId === childId)) break;
    }
    assert.ok(result?.value.kind === 'claude-children');
    assert.equal(result.value.complete, false, 'the receipt had no unfinished suffix');
    assert.deepEqual(
      result.value.references.map((reference) => reference.sessionId),
      [childId],
    );
    const evicted = limitCodexDispatchCursors(result.value.referenceEntries, 0);
    assert.equal(evicted[0][1].cursor, undefined);
    const cacheFile = path.join(directory, 'cache.json');
    saveDerivedCache(cacheFile, [], evicted);
    const restored = [...loadDerivedCache(cacheFile).claudeChildReferences];
    worker.stop();
    worker = new ProgressiveWorker(source);
    result = await discoveryState(worker, { ...request, referenceEntries: restored }, 6, new AbortController().signal);
    assert.ok(result?.value.kind === 'claude-children');
    for (
      let pass = 0;
      result.value.kind === 'claude-children' &&
      !result.value.references.some((reference) => reference.sessionId === childId) &&
      pass < 40;
      pass++
    ) {
      const next = await discoveryState(
        worker,
        { ...request, referenceEntries: result.value.referenceEntries },
        2,
        new AbortController().signal,
      );
      assert.ok(next?.value.kind === 'claude-children');
      result = next;
    }
    assert.ok(result.value.kind === 'claude-children');
    assert.equal(result.value.complete, false);
    assert.deepEqual(
      result.value.references.map((reference) => reference.sessionId),
      [childId],
    );
    for (let pass = 7; pass <= 110 && !result.value.complete; pass++) {
      result = await discoveryState(
        worker,
        { ...request, referenceEntries: result.value.referenceEntries },
        pass,
        new AbortController().signal,
      );
      assert.ok(result?.value.kind === 'claude-children');
      assert.deepEqual(
        result.value.references.map((reference) => reference.sessionId),
        [childId],
      );
    }
    assert.equal(result.value.complete, true, 'reconstruction did not finish');
    assert.deepEqual(
      result.value.referenceEntries[0][1].references.map((reference) => reference.sessionId),
      [childId],
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a copied-turn retraction removes a held child during cursorless reconstruction', async () => {
  const directory = tempDir('panel-progressive-codex-retraction-');
  const childId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const child = path.join(directory, `${childId}.jsonl`);
  fs.writeFileSync(child, `${JSON.stringify({ type: 'user', cwd: directory })}\n`);
  const file = path.join(directory, 'parent.jsonl');
  const records = [
    { timestamp: '2026-08-27T12:00:00.000Z', type: 'session_meta', payload: { id: 'parent', cwd: directory } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'launch' } },
    { type: 'turn_context', payload: { turn_id: 'launch', current_date: '2026-08-27' } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'launch',
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
          stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
        },
      },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record) + '\n').join(''));
  const filler = `${JSON.stringify({ type: 'ignored', payload: 'x'.repeat(1024 * 1024) })}\n`;
  for (let index = 0; index < 9; index++) fs.appendFileSync(file, filler);
  fs.appendFileSync(
    file,
    `${JSON.stringify({ type: 'turn_context', payload: { turn_id: 'launch', current_date: '2026-08-26' } })}\n`,
  );
  fs.appendFileSync(file, '{"type":"ignored","payload":"tail"');
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const request = {
    kind: 'claude-children' as const,
    parents: [{ agent: 'codex' as const, file, sessionId: 'parent', size: stat.size, mtimeMs: stat.mtimeMs }],
    catalog: [
      { agent: 'claude' as const, file: child, sessionId: childId, size: childStat.size, mtimeMs: childStat.mtimeMs },
    ],
    repositoryRoots: [directory],
  };
  let worker = new ProgressiveWorker(source);
  try {
    let result = await discoveryState(worker, request, 1, new AbortController().signal);
    assert.equal(result?.value.kind, 'claude-children');
    assert.deepEqual(
      result.value.references.map((reference) => reference.sessionId),
      [childId],
    );
    const evicted = limitCodexDispatchCursors(result.value.referenceEntries, 0);
    assert.equal(evicted[0][1].cursor, undefined);
    const cacheFile = path.join(directory, 'cache.json');
    saveDerivedCache(cacheFile, [], evicted);
    worker.stop();
    worker = new ProgressiveWorker(source);
    result = await discoveryState(
      worker,
      { ...request, referenceEntries: [...loadDerivedCache(cacheFile).claudeChildReferences] },
      2,
      new AbortController().signal,
    );
    assert.equal(result?.value.kind, 'claude-children');
    assert.deepEqual(
      result.value.references.map((reference) => reference.sessionId),
      [childId],
    );
    assert.ok(result.value.referenceEntries[0][1].cursor!.offset < stat.size, 'copied-turn evidence was already read');
    result = await discoveryState(
      worker,
      { ...request, referenceEntries: result.value.referenceEntries },
      3,
      new AbortController().signal,
    );
    assert.equal(result?.value.kind, 'claude-children');
    for (
      let pass = 0;
      result.value.kind === 'claude-children' && !result.value.referenceEntries[0][1].visitedEof && pass < 40;
      pass++
    ) {
      const next = await discoveryState(
        worker,
        { ...request, referenceEntries: result.value.referenceEntries },
        3,
        new AbortController().signal,
      );
      assert.ok(next?.value.kind === 'claude-children');
      result = next;
    }
    assert.ok(result.value.kind === 'claude-children');
    assert.deepEqual(result.value.references, [], 'the copied receipt returned after its retraction');
    assert.equal(result.value.complete, false);
    assert.equal(result.value.referenceEntries[0][1].visitedEof, true);
    saveDerivedCache(cacheFile, [], result.value.referenceEntries);
    worker.stop();
    worker = new ProgressiveWorker(source);
    result = await discoveryState(
      worker,
      { ...request, referenceEntries: [...loadDerivedCache(cacheFile).claudeChildReferences] },
      4,
      new AbortController().signal,
    );
    assert.equal(result?.value.kind, 'claude-children');
    assert.deepEqual(result.value.references, [], 'stable partial EOF restored the copied receipt');
    fs.appendFileSync(file, '}\n');
    const completedStat = revisionOf(fs.statSync(file, { bigint: true }));
    result = await discoveryState(
      worker,
      {
        ...request,
        parents: [{ ...request.parents[0], size: completedStat.size, mtimeMs: completedStat.mtimeMs }],
        referenceEntries: result.value.referenceEntries,
      },
      5,
      new AbortController().signal,
    );
    assert.equal(result?.value.kind, 'claude-children');
    for (let pass = 0; result.value.kind === 'claude-children' && !result.value.complete && pass < 80; pass++) {
      const next = await discoveryState(
        worker,
        {
          ...request,
          parents: [{ ...request.parents[0], ...revisionOf(fs.statSync(file, { bigint: true })) }],
          referenceEntries: result.value.referenceEntries,
        },
        5,
        new AbortController().signal,
      );
      assert.ok(next?.value.kind === 'claude-children');
      result = next;
    }
    assert.ok(result.value.kind === 'claude-children');
    assert.equal(result.value.complete, true);
    assert.deepEqual(result.value.references, [], 'completion restored the copied receipt');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a large unfinished parent reaches its final receipt under production cursor retention', async () => {
  const directory = tempDir('panel-progressive-codex-retention-');
  const childId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const child = path.join(directory, `${childId}.jsonl`);
  fs.writeFileSync(child, `${JSON.stringify({ type: 'user', cwd: directory })}\n`);
  const file = path.join(directory, 'large-parent.jsonl');
  fs.writeFileSync(
    file,
    [
      { type: 'session_meta', payload: { id: 'large-parent', cwd: directory } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'launch' } },
      { type: 'turn_context', payload: { turn_id: 'launch' } },
    ]
      .map((record) => JSON.stringify(record) + '\n')
      .join(''),
  );
  for (let index = 0; index < 24; index++)
    fs.appendFileSync(file, `${JSON.stringify({ type: 'ignored', payload: 'x'.repeat(1024 * 1024) })}\n`);
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'launch',
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
          stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
        },
      },
    })}\n`,
  );
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const parent = { agent: 'codex' as const, file, sessionId: 'large-parent', size: stat.size, mtimeMs: stat.mtimeMs };
  const seed = scanCodexDispatchReferences(file, parent.sessionId, null, 0).cursor;
  const largeEntry: import('./derivedcache').ClaudeChildReferenceCacheEntry = {
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    source: 'codex',
    complete: false,
    visitedEof: false,
    cursor: { ...seed, seenBloom: 'A'.repeat(89_000) },
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    dev: stat.dev,
    ino: stat.ino,
    sessionId: parent.sessionId,
    childTranscript: false,
    references: [],
  };
  const stableFile = path.join(directory, 'stable-template.jsonl');
  const stableText = `${JSON.stringify({ type: 'session_meta', payload: { id: 'stable', cwd: directory } })}\n{"type":"ignored","payload":"x"`;
  fs.writeFileSync(stableFile, stableText);
  const stableParents = Array.from({ length: 840 }, (_unused, index) => {
    const stable = path.join(directory, `stable-${index}.jsonl`);
    fs.writeFileSync(stable, stableText);
    const revision = revisionOf(fs.statSync(stable, { bigint: true }));
    return {
      agent: 'codex' as const,
      file: stable,
      sessionId: `stable-${index}`,
      size: revision.size,
      mtimeMs: revision.mtimeMs,
      dev: revision.dev,
      ino: revision.ino,
    };
  });
  const entries: Array<[string, import('./derivedcache').ClaudeChildReferenceCacheEntry]> = [
    [file, largeEntry],
    ...stableParents.map((item): [string, import('./derivedcache').ClaudeChildReferenceCacheEntry] => [
      item.file,
      {
        ...largeEntry,
        complete: false,
        visitedEof: true,
        cursor: {
          ...scanCodexDispatchReferences(item.file, item.sessionId).cursor,
          parentSessionId: item.sessionId,
          dev: item.dev,
          ino: item.ino,
          seenBloom: 'A'.repeat(80_000),
        },
        mtimeMs: item.mtimeMs,
        size: item.size,
        dev: item.dev,
        ino: item.ino,
        sessionId: item.sessionId,
      },
    ]),
  ];
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const request = {
    kind: 'claude-children' as const,
    parents: [parent, ...stableParents],
    catalog: [
      { agent: 'claude' as const, file: child, sessionId: childId, size: childStat.size, mtimeMs: childStat.mtimeMs },
    ],
    repositoryRoots: [directory],
  };
  let worker = new ProgressiveWorker(source);
  try {
    let held = entries;
    let found = false;
    for (let pass = 1; pass <= Math.ceil(stableParents.length / 8) + 100; pass++) {
      const result = await discoveryState(
        worker,
        { ...request, referenceEntries: held },
        pass,
        new AbortController().signal,
      );
      assert.equal(result?.value.kind, 'claude-children');
      if (!result || result.value.kind !== 'claude-children') break;
      held = result.value.referenceEntries;
      const cursor = held.find(([, entry]) => entry.sessionId === parent.sessionId)?.[1].cursor;
      assert.ok(cursor && cursor.offset > 0, 'retention discarded the large parent scan');
      found = result.value.references.some((reference) => reference.sessionId === childId);
      if (pass === 2) {
        const cacheFile = path.join(directory, 'cache.json');
        saveDerivedCache(cacheFile, [], held);
        held = [...loadDerivedCache(cacheFile).claudeChildReferences];
        worker.stop();
        worker = new ProgressiveWorker(source);
      }
      if (found) break;
    }
    assert.equal(found, true, 'the large parent never reached its final receipt');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a restart rediscovers PowerShell receipts from old complete and visited-EOF entries without changing the parent', async () => {
  const directory = tempDir('panel-progressive-powershell-upgrade-');
  const file = path.join(directory, 'parent.jsonl');
  const childId = '3f99580e-a054-4ce7-a686-c4e65f32f98a';
  const child = path.join(directory, `${childId}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: 'session_meta', timestamp: timestamp(0), payload: { id: 'parent', cwd: directory, source: 'cli' } },
      { type: 'event_msg', timestamp: timestamp(1), payload: { type: 'task_started', turn_id: 'launch' } },
      { type: 'turn_context', timestamp: timestamp(2), payload: { turn_id: 'launch' } },
      {
        type: 'event_msg',
        timestamp: timestamp(3),
        payload: { type: 'item_completed', item: powershellDispatchExecution },
      },
    ]
      .map((record) => JSON.stringify(record) + '\n')
      .join(''),
  );
  fs.writeFileSync(child, JSON.stringify({ type: 'user', cwd: directory, message: { content: 'review' } }) + '\n');
  const before = revisionOf(fs.statSync(file, { bigint: true }));
  const cursor = scanCodexDispatchReferences(file, 'parent').cursor;
  const parent = { agent: 'codex' as const, file, sessionId: 'parent', size: before.size, mtimeMs: before.mtimeMs };
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const request = {
    kind: 'claude-children' as const,
    parents: [parent],
    repositoryRoots: [directory],
    catalog: [
      { agent: 'claude' as const, file: child, sessionId: childId, size: childStat.size, mtimeMs: childStat.mtimeMs },
    ],
  };
  for (const complete of [true, false]) {
    const entry = {
      parserVersion: 12,
      source: 'codex' as const,
      complete,
      visitedEof: true,
      cursor: { ...cursor, candidates: [] },
      mtimeMs: before.mtimeMs,
      size: before.size,
      dev: before.dev,
      ino: before.ino,
      sessionId: 'parent',
      childTranscript: false,
      references: [],
    };
    const cacheFile = path.join(directory, 'cache.json');
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ version: VERSION, titles: [], claudeChildReferences: [{ file, entry }] }),
    );
    const restored = loadDerivedCache(cacheFile).claudeChildReferences;
    for (const referenceEntries of [[[file, entry]], [...restored]] as Array<
      Array<[string, import('./derivedcache').ClaudeChildReferenceCacheEntry]>
    >) {
      const worker = new ProgressiveWorker(source);
      try {
        const found = await discoveryState(worker, { ...request, referenceEntries }, 1, new AbortController().signal);
        assert.equal(found?.value.kind, 'claude-children');
        if (!found || found.value.kind !== 'claude-children') continue;
        assert.deepEqual(
          found.value.references.map((reference) => [reference.sessionId, reference.toolUseIds]),
          [[childId, [powershellDispatchExecution.id]]],
        );
        const reused = await discoveryState(
          worker,
          { ...request, referenceEntries: found.value.referenceEntries },
          2,
          new AbortController().signal,
        );
        assert.equal(reused?.value.kind, 'claude-children');
        if (reused?.value.kind === 'claude-children')
          assert.deepEqual(reused.value.referenceEntries, found.value.referenceEntries);
      } finally {
        worker.stop();
      }
    }
  }
  const after = revisionOf(fs.statSync(file, { bigint: true }));
  assert.deepEqual(
    [after.size, after.mtimeMs, after.dev, after.ino],
    [before.size, before.mtimeMs, before.dev, before.ino],
  );
});

test('Codex dispatch discovery resumes beyond its request byte budget', async () => {
  const directory = tempDir('panel-progressive-codex-dispatch-');
  const id = '3f99580e-a054-4ce7-a686-c4e65f32f98a';
  const file = path.join(directory, 'parent.jsonl');
  const child = path.join(directory, `${id}.jsonl`);
  const records = [
    { type: 'session_meta', timestamp: timestamp(0), payload: { id: 'parent', cwd: directory, source: 'cli' } },
    { type: 'event_msg', timestamp: timestamp(1), payload: { type: 'task_started', turn_id: 'launch' } },
    { type: 'turn_context', timestamp: timestamp(2), payload: { turn_id: 'launch', model: 'gpt-6-sol' } },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record) + '\n').join(''));
  const filler = JSON.stringify({ type: 'ignored', payload: 'x'.repeat(1024 * 1024) }) + '\n';
  for (let index = 0; index < 9; index++) fs.appendFileSync(file, filler);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'event_msg',
      timestamp: timestamp(3),
      payload: {
        type: 'item_completed',
        item: {
          ...powershellDispatchExecution,
        },
      },
    }) + '\n',
  );
  fs.writeFileSync(child, JSON.stringify({ type: 'user', cwd: directory, message: { content: 'hello' } }) + '\n');
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const parent = { agent: 'codex' as const, file, sessionId: 'parent', mtimeMs: stat.mtimeMs, size: stat.size };
  const catalog = [
    { agent: 'claude' as const, file: child, sessionId: id, mtimeMs: childStat.mtimeMs, size: childStat.size },
  ];
  let worker = new ProgressiveWorker(source);
  try {
    let entries: Array<[string, import('./derivedcache').ClaudeChildReferenceCacheEntry]> = [];
    let completed = false;
    let passes = 0;
    while (!completed && passes < 400) {
      const result = await discoveryState(
        worker,
        {
          kind: 'claude-children',
          parents: [parent],
          catalog,
          repositoryRoots: [directory],
          referenceEntries: entries,
        },
        ++passes,
        new AbortController().signal,
      );
      assert.equal(result?.value.kind, 'claude-children');
      if (!result || result.value.kind !== 'claude-children') break;
      entries = result.value.referenceEntries;
      if (passes === 1) {
        const cursor = entries[0]?.[1].cursor;
        assert.ok(cursor && cursor.offset <= 8 * 1024 * 1024);
        worker.stop();
        worker = new ProgressiveWorker(source);
      }
      completed = result.value.complete;
      if (!completed) assert.equal(result.value.references.length, 0);
      else
        assert.deepEqual(
          result.value.references.map((reference) => reference.sessionId),
          [id],
        );
    }
    assert.ok(completed);
    assert.ok(passes > 1);
  } finally {
    worker.stop();
  }
});

test('large partial Codex records keep bounded cursors across parents and a worker restart', async () => {
  const directory = tempDir('panel-progressive-codex-partials-');
  const childId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const child = path.join(directory, `${childId}.jsonl`);
  fs.writeFileSync(child, `${JSON.stringify({ type: 'user', cwd: directory, message: { content: 'hello' } })}\n`);
  const parents = Array.from({ length: 4 }, (_unused, index) => {
    const file = path.join(directory, `parent-${index}.jsonl`);
    const records = [
      { type: 'session_meta', timestamp: timestamp(0), payload: { id: `parent-${index}`, cwd: directory } },
      { type: 'event_msg', timestamp: timestamp(1), payload: { type: 'task_started', turn_id: `turn-${index}` } },
      { type: 'turn_context', timestamp: timestamp(2), payload: { turn_id: `turn-${index}` } },
    ];
    const receipt = `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`;
    const last = JSON.stringify({
      type: 'event_msg',
      timestamp: timestamp(3),
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: `launch-${index}`,
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --runner claude --arc-dispatch' }],
          stdout: receipt + '\n' + 'x'.repeat(3 * 1024 * 1024),
        },
      },
    });
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record) + '\n').join('') + last.slice(0, -1));
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { agent: 'codex' as const, file, sessionId: `parent-${index}`, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const childStat = revisionOf(fs.statSync(child, { bigint: true }));
  const catalog = [
    { agent: 'claude' as const, file: child, sessionId: childId, size: childStat.size, mtimeMs: childStat.mtimeMs },
  ];
  const request = { kind: 'claude-children' as const, parents, catalog, repositoryRoots: [directory] };
  let entries: Array<[string, import('./derivedcache').ClaudeChildReferenceCacheEntry]> = [];
  let worker = new ProgressiveWorker(source);
  try {
    for (let pass = 0; pass < 4; pass++) {
      const result = await discoveryState(
        worker,
        { ...request, referenceEntries: entries },
        pass + 1,
        new AbortController().signal,
      );
      assert.equal(result?.value.kind, 'claude-children');
      if (!result || result.value.kind !== 'claude-children') break;
      entries = result.value.referenceEntries;
      if (!result.value.continuation) break;
    }
    assert.equal(entries.length, 4);
    assert.ok(entries.every(([, entry]) => entry.cursor?.fragment === '' && entry.cursor.fragmentStart !== null));
    const cacheFile = path.join(directory, 'cache.json');
    saveDerivedCache(cacheFile, [], entries);
    const restored = loadDerivedCache(cacheFile).claudeChildReferences;
    assert.equal(restored.size, 4);
    worker.stop();
    worker = new ProgressiveWorker(source);
    fs.appendFileSync(parents[3].file, '}\n');
    const stat = revisionOf(fs.statSync(parents[3].file, { bigint: true }));
    parents[3] = { ...parents[3], size: stat.size, mtimeMs: stat.mtimeMs };
    let resumed = await discoveryState(
      worker,
      { ...request, parents, referenceEntries: [...restored] },
      1,
      new AbortController().signal,
    );
    for (
      let pass = 0;
      resumed?.value.kind === 'claude-children' &&
      !resumed.value.references.some((reference) => reference.parentSessionId === 'parent-3') &&
      pass < 80;
      pass++
    )
      resumed = await discoveryState(
        worker,
        { ...request, parents, referenceEntries: resumed.value.referenceEntries },
        1,
        new AbortController().signal,
      );
    assert.equal(resumed?.value.kind, 'claude-children');
    if (resumed?.value.kind === 'claude-children') {
      assert.deepEqual(
        resumed.value.references.map((reference) => reference.parentSessionId),
        ['parent-3'],
      );
      assert.ok(resumed.value.referenceEntries.every(([, entry]) => entry.cursor?.fragment === ''));
    }
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude child discovery runs in the worker and reuses unchanged transcript reads', async () => {
  const directory = tempDir('panel-progressive-claude-discovery-');
  const parents = Array.from({ length: 6 }, (_unused, parentIndex) => {
    const sessionId = `parent-${parentIndex}`;
    const file = path.join(directory, `${sessionId}.jsonl`);
    const records: object[] = [];
    for (let childIndex = 0; childIndex < 4; childIndex++) {
      const childId = `child-${parentIndex}-${childIndex}`;
      const toolUseId = `launch-${parentIndex}-${childIndex}`;
      records.push(
        {
          type: 'assistant',
          timestamp: timestamp(childIndex * 2),
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: childId } }],
          },
        },
        {
          type: 'user',
          timestamp: timestamp(childIndex * 2 + 1),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
          toolUseResult: { agentId: childId, status: 'completed', totalToolUseCount: 1 },
        },
      );
      const childDirectory = path.join(directory, sessionId, 'subagents');
      fs.mkdirSync(childDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(childDirectory, `agent-${childId}.jsonl`),
        `${JSON.stringify({ type: 'user', cwd: 'C:/repo' })}\n`,
      );
    }
    fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    return { agent: 'claude' as const, file, sessionId, mtimeMs: stat.mtimeMs, size: stat.size };
  });
  const observedSource =
    `const observedFs = require('node:fs');
    const observedOpen = observedFs.openSync; const observedClose = observedFs.closeSync;
    const observedRead = observedFs.readSync; const observedFiles = new Map();
    let observedReads = 0; let observedParentReads = 0; let observedChildReads = 0;
    observedFs.openSync = function (file, ...args) { const fd = observedOpen.call(this,file,...args); observedFiles.set(fd,String(file)); return fd; };
    observedFs.closeSync = function (fd) { observedFiles.delete(fd); return observedClose.call(this,fd); };
    observedFs.readSync = function (fd, ...args) { const count = observedRead.call(this,fd,...args); observedReads++;
      const file = observedFiles.get(fd); if (count > 0 && file) { if (file.includes('subagents')) observedChildReads++; else observedParentReads++; }
      return count; };
    const observedPort = require('node:worker_threads').parentPort;
    const observedPost = observedPort.postMessage;
    observedPort.postMessage = function (message) { if (message.result) Object.assign(message.result,
      { observedReads, observedParentReads, observedChildReads }); return observedPost.call(this,message); };` + source;
  const worker = new ProgressiveWorker(observedSource);
  try {
    const request = { kind: 'claude-children' as const, parents, repositoryRoots: ['C:/repo'] };
    const first = await completeDiscovery(worker, request, 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'claude-children');
    assert.equal(first.value.children.length, 24);
    assert.equal(first.value.references.length, 24);
    const firstReads = (first as typeof first & { observedReads: number }).observedReads;
    assert.equal(firstReads > 0, true, 'discovery never read the parent and child sources');
    const second = await completeDiscovery(worker, request, 2, new AbortController().signal);
    assert.ok(second?.value.kind === 'claude-children');
    assert.equal(
      (second as typeof second & { observedReads: number }).observedReads,
      firstReads,
      'unchanged parent and child revisions repeated transcript reads',
    );

    const restarted = new ProgressiveWorker(observedSource);
    try {
      const restored = await completeDiscovery(
        restarted,
        { ...request, referenceEntries: first.value.referenceEntries },
        1,
        new AbortController().signal,
      );
      assert.ok(restored?.value.kind === 'claude-children');
      assert.equal(restored.value.children.length, 24);
      const observed = restored as typeof restored & {
        observedReads: number;
        observedParentReads: number;
        observedChildReads: number;
      };
      assert.equal(
        observed.observedParentReads,
        0,
        'a fresh worker fully scanned unchanged parent transcripts despite persisted references',
      );
      assert.ok(observed.observedChildReads > 0, 'the restart fixture did not exercise required child head validation');
    } finally {
      restarted.stop();
    }

    const appendedParent = parents[1];
    const appendedChildId = 'child-appended';
    const appendedToolId = 'launch-appended';
    fs.appendFileSync(
      appendedParent.file,
      [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: appendedToolId, name: 'Agent' }] } },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: appendedToolId }] },
          toolUseResult: { agentId: appendedChildId },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const appendedChild = path.join(directory, appendedParent.sessionId, 'subagents', `agent-${appendedChildId}.jsonl`);
    fs.writeFileSync(appendedChild, `${JSON.stringify({ type: 'user', cwd: 'C:/repo' })}\n`);
    const appendedStat = revisionOf(fs.statSync(appendedParent.file, { bigint: true }));
    parents[1] = { ...appendedParent, mtimeMs: appendedStat.mtimeMs, size: appendedStat.size };
    const changedWorker = new ProgressiveWorker(observedSource);
    let changedEntries: typeof first.value.referenceEntries = [];
    try {
      const changed = await completeDiscovery(
        changedWorker,
        { ...request, parents, referenceEntries: first.value.referenceEntries },
        1,
        new AbortController().signal,
      );
      assert.ok(changed?.value.kind === 'claude-children');
      assert.equal(
        changed.value.children.length,
        25,
        'a parent changed while Arc was closed did not contribute its appended child',
      );
      changedEntries = changed.value.referenceEntries;
    } finally {
      changedWorker.stop();
    }

    fs.unlinkSync(appendedChild);
    const deletedWorker = new ProgressiveWorker(observedSource);
    try {
      const withoutDeleted = await completeDiscovery(
        deletedWorker,
        { ...request, parents, referenceEntries: changedEntries },
        1,
        new AbortController().signal,
      );
      assert.ok(withoutDeleted?.value.kind === 'claude-children');
      assert.equal(
        withoutDeleted.value.children.length,
        24,
        'a deleted child remained in the complete catalog behind its cached parent reference',
      );
    } finally {
      deletedWorker.stop();
    }

    const replacedParent = parents[0];
    const replacement = path.join(directory, 'replacement.jsonl');
    const replacedStat = revisionOf(fs.statSync(replacedParent.file, { bigint: true }));
    const blank = Buffer.alloc(replacedStat.size, 0x20);
    fs.writeFileSync(replacement, blank);
    fs.unlinkSync(replacedParent.file);
    fs.renameSync(replacement, replacedParent.file);
    fs.utimesSync(replacedParent.file, new Date(replacedStat.mtimeMs), new Date(replacedStat.mtimeMs));
    const replacementStat = revisionOf(fs.statSync(replacedParent.file, { bigint: true }));
    parents[0] = { ...replacedParent, mtimeMs: replacementStat.mtimeMs, size: replacementStat.size };
    const identityMatchedEntries: typeof changedEntries = changedEntries.map(([file, entry]) => [
      file,
      entry.sessionId === replacedParent.sessionId
        ? { ...entry, mtimeMs: replacementStat.mtimeMs, size: replacementStat.size }
        : entry,
    ]);
    const replacementWorker = new ProgressiveWorker(observedSource);
    try {
      const replaced = await completeDiscovery(
        replacementWorker,
        { ...request, parents, referenceEntries: identityMatchedEntries },
        1,
        new AbortController().signal,
      );
      assert.ok(replaced?.value.kind === 'claude-children');
      assert.equal(
        replaced.value.children.length,
        20,
        'a replaced parent reused relationships recorded by the file at its old identity',
      );
    } finally {
      replacementWorker.stop();
    }
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude dispatch discovery resolves a unique catalog prefix without adding a child transcript', async () => {
  const directory = tempDir('panel-progressive-claude-dispatch-');
  const parentFile = path.join(directory, 'parent.jsonl');
  const childId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const childFile = path.join(directory, `${childId}.jsonl`);
  const records = [
    {
      type: 'assistant',
      timestamp: timestamp(1),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'dispatch-1', name: 'Bash', input: { command: 'claude --bg review' } }],
      },
    },
    {
      type: 'user',
      timestamp: timestamp(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'dispatch-1', content: 'backgrounded Â· 4f4bf298 Â· Review' }],
      },
      toolUseResult: { stdout: 'backgrounded Â· 4f4bf298 Â· Review' },
    },
  ];
  fs.writeFileSync(parentFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  fs.writeFileSync(
    childFile,
    [
      { type: 'user', cwd: 'C:/repo', timestamp: timestamp(0), message: { role: 'user', content: 'Review' } },
      {
        type: 'assistant',
        timestamp: timestamp(1),
        message: { role: 'assistant', stop_reason: 'end_turn', content: 'Finished' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const parentStat = revisionOf(fs.statSync(parentFile, { bigint: true }));
  const childStat = revisionOf(fs.statSync(childFile, { bigint: true }));
  const parent = {
    agent: 'claude' as const,
    file: parentFile,
    sessionId: 'parent',
    mtimeMs: parentStat.mtimeMs,
    size: parentStat.size,
  };
  const child = {
    agent: 'claude' as const,
    file: childFile,
    sessionId: childId,
    mtimeMs: childStat.mtimeMs,
    size: childStat.size,
  };
  const worker = new ProgressiveWorker(source);
  try {
    const result = await completeDiscovery(
      worker,
      {
        kind: 'claude-children',
        parents: [parent],
        catalog: [parent, child],
        repositoryRoots: ['C:/repo'],
      },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'claude-children');
    assert.deepEqual(result.value.children, []);
    assert.deepEqual(result.value.references, [
      {
        kind: 'dispatch',
        agent: 'claude',
        parentSessionId: 'parent',
        sessionId: childId,
        file: childFile,
        toolUseIds: ['dispatch-1'],
        name: 'Review',
        owned: false,
      },
    ]);
    assert.deepEqual(
      result.value.dispatchFacts.map((facts) => [facts.sessionId, facts.spend.found, facts.person]),
      [[childId, true, false]],
    );
    // A person typing into the child reaches the host with the child's other figures.
    fs.appendFileSync(
      childFile,
      JSON.stringify({
        type: 'user',
        cwd: 'C:/repo',
        timestamp: timestamp(3),
        origin: { kind: 'human' },
        message: { role: 'user', content: 'Use the other fixture' },
      }) + '\n',
    );
    const grown = revisionOf(fs.statSync(childFile, { bigint: true }));
    const typed = await completeDiscovery(
      worker,
      {
        kind: 'claude-children',
        parents: [parent],
        catalog: [parent, { ...child, mtimeMs: grown.mtimeMs, size: grown.size }],
        repositoryRoots: ['C:/repo'],
      },
      2,
      new AbortController().signal,
    );
    assert.ok(typed?.value.kind === 'claude-children');
    assert.deepEqual(
      typed.value.dispatchFacts.map((facts) => facts.person),
      [true],
      'a person typing into a dispatched session did not reach its facts',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an active dispatched transcript reads only its bounded metadata', async () => {
  const directory = tempDir('panel-progressive-active-dispatch-');
  const parentFile = path.join(directory, 'parent.jsonl');
  const childId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const childFile = path.join(directory, `${childId}.jsonl`);
  const parentRecords = [
    {
      type: 'assistant',
      timestamp: timestamp(1),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'dispatch-1', name: 'Bash', input: { command: 'python review.py --arc-dispatch' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: timestamp(2),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'dispatch-1',
            content: `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`,
          },
        ],
      },
      toolUseResult: { stdout: `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}` },
    },
  ];
  fs.writeFileSync(parentFile, parentRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const activeAt = new Date(Date.now() - 1000).toISOString();
  const activeRecords: Record<string, unknown>[] = [
    { type: 'user', cwd: 'C:/repo', timestamp: activeAt, message: { role: 'user', content: 'Review' } },
    ...Array.from({ length: 40 }, (_unused, index) => ({
      type: 'assistant',
      timestamp: activeAt,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: `tool-${index}`,
            name: 'Bash',
            input: { command: 'dir', padding: 'x'.repeat(64 * 1024) },
          },
        ],
      },
    })),
  ];
  activeRecords.push(
    {
      type: 'assistant',
      timestamp: activeAt,
      message: {
        role: 'assistant',
        id: 'edit-message',
        model: 'claude',
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 34 },
        content: [
          {
            type: 'tool_use',
            id: 'edit-file',
            name: 'Edit',
            input: { file_path: 'C:/repo/changed.ts', old_string: 'old', new_string: 'new' },
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: activeAt,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-file', content: 'changed' }] },
      toolUseResult: {
        filePath: 'C:/repo/changed.ts',
        originalFile: 'old\n',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
      },
    },
    {
      type: 'assistant',
      timestamp: activeAt,
      cwd: 'C:/repo',
      message: {
        role: 'assistant',
        id: 'commit-message',
        model: 'claude',
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'commit-file', name: 'Bash', input: { command: 'git commit -am "Child fix"' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: activeAt,
      cwd: 'C:/repo',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'commit-file', content: '[topic abc1234] Child fix\n 1 file changed' },
        ],
      },
      toolUseResult: { stdout: '[topic abc1234] Child fix\n 1 file changed', stderr: '' },
    },
  );
  fs.writeFileSync(childFile, activeRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const parentStat = revisionOf(fs.statSync(parentFile, { bigint: true }));
  const childStat = revisionOf(fs.statSync(childFile, { bigint: true }));
  const parent = {
    agent: 'claude' as const,
    file: parentFile,
    sessionId: 'parent',
    mtimeMs: parentStat.mtimeMs,
    size: parentStat.size,
  };
  const child = {
    agent: 'claude' as const,
    file: childFile,
    sessionId: childId,
    mtimeMs: childStat.mtimeMs,
    size: childStat.size,
  };
  const observedSource =
    `const observedFs = require('node:fs'); const observedRead = observedFs.readSync;
    let simulatedNow = ${Date.parse(activeAt) + 1000}; Date.now = () => simulatedNow;
    let activeBytes = 0; observedFs.readSync = function (fd, buffer, ...args) { const read = observedRead.call(this, fd, buffer, ...args);
      try { if (observedFs.fstatSync(fd).size === ${childStat.size}) activeBytes += read; } catch {} return read; };
    const observedPort = require('node:worker_threads').parentPort; const observedPost = observedPort.postMessage;
    observedPort.on('message', (message) => {
      if (message.generation > 1) simulatedNow = ${Date.parse(activeAt) + 2 * 60 * 60 * 1000};
    });
    observedPort.postMessage = function (message) { if (message.result) message.result.activeBytes = activeBytes; return observedPost.call(this, message); };` +
    source;
  const worker = new ProgressiveWorker(observedSource);
  try {
    const result = await completeDiscovery(
      worker,
      { kind: 'claude-children', parents: [parent], catalog: [parent, child], repositoryRoots: ['C:/repo'] },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'claude-children');
    assert.ok(result.value.dispatchFacts[0], JSON.stringify(result.value));
    assert.equal(result.value.dispatchFacts[0]?.spend.found, false);
    assert.ok(
      (result as typeof result & { activeBytes: number }).activeBytes < 400 * 1024,
      'an active dispatched transcript read beyond its metadata window',
    );
    const stopped = await completeDiscovery(
      worker,
      { kind: 'claude-children', parents: [parent], catalog: [parent, child], repositoryRoots: ['C:/repo'] },
      2,
      new AbortController().signal,
    );
    assert.ok(stopped?.value.kind === 'claude-children');
    const spend = stopped.value.dispatchFacts[0]?.spend;
    assert.equal(spend?.found, true, 'a quiet unfinished child kept its empty active spend');
    assert.equal(spend?.unfinished, true);
    assert.equal(spend?.artifacts?.complete, false);
    assert.equal(spend?.models[0]?.usage.output, 34);
    assert.deepEqual(
      spend?.artifacts?.files.map((file) => file.path),
      ['C:/repo/changed.ts'],
    );
    assert.deepEqual(
      spend?.commits?.map((commit) => commit.sha),
      ['abc1234'],
    );
    assert.ok((spend?.endedAt ?? 0) >= (spend?.startedAt ?? Infinity));
    const settledBytes = (stopped as typeof stopped & { activeBytes: number }).activeBytes;
    // The quiet child's spend read carries its person fact, so the file is read whole once.
    assert.ok(
      settledBytes - (result as typeof result & { activeBytes: number }).activeBytes < childStat.size + 512 * 1024,
      'a quiet dispatched transcript was read whole more than once',
    );
    const retained = await completeDiscovery(
      worker,
      { kind: 'claude-children', parents: [parent], catalog: [parent, child], repositoryRoots: ['C:/repo'] },
      3,
      new AbortController().signal,
    );
    assert.ok(retained?.value.kind === 'claude-children');
    assert.equal(
      (retained as typeof retained & { activeBytes: number }).activeBytes,
      settledBytes,
      'the stopped child was read again without a file revision change',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// A running child scan excludes its launch prompt. A follow-up typed prompt is classified when the quiet child receives a whole-file read.

test('a running dispatched child reads as a person only from its whole file', async () => {
  const directory = tempDir('panel-progressive-person-dispatch-');
  const parentFile = path.join(directory, 'parent.jsonl');
  const childId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const childFile = path.join(directory, `${childId}.jsonl`);
  const receipt = `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`;
  fs.writeFileSync(
    parentFile,
    [
      {
        type: 'assistant',
        timestamp: timestamp(1),
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'dispatch-1', name: 'Bash', input: { command: 'python review.py --arc-dispatch' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: timestamp(2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'dispatch-1', content: receipt }] },
        toolUseResult: { stdout: receipt },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const activeAt = new Date(Date.now() - 1000).toISOString();
  const append = (record: Record<string, unknown>) => fs.appendFileSync(childFile, JSON.stringify(record) + '\n');
  append({
    type: 'system',
    subtype: 'informational',
    sessionKind: 'bg',
    cwd: 'C:/repo',
    timestamp: activeAt,
    content: 'Starting',
  });
  const parentStat = revisionOf(fs.statSync(parentFile, { bigint: true }));
  const parent = {
    agent: 'claude' as const,
    file: parentFile,
    sessionId: 'parent',
    mtimeMs: parentStat.mtimeMs,
    size: parentStat.size,
  };
  const catalog = () => {
    const stat = revisionOf(fs.statSync(childFile, { bigint: true }));
    return [
      parent,
      { agent: 'claude' as const, file: childFile, sessionId: childId, mtimeMs: stat.mtimeMs, size: stat.size },
    ];
  };
  const clockedSource =
    `let simulatedNow = ${Date.parse(activeAt) + 1000}; Date.now = () => simulatedNow;
    require('node:worker_threads').parentPort.on('message', (message) => {
      if (message.generation > 2) simulatedNow = ${Date.parse(activeAt) + 2 * 60 * 60 * 1000};
    });` + source;
  const worker = new ProgressiveWorker(clockedSource);
  const person = async (generation: number) => {
    const result = await completeDiscovery(
      worker,
      { kind: 'claude-children', parents: [parent], catalog: catalog(), repositoryRoots: ['C:/repo'] },
      generation,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'claude-children');
    return result.value.dispatchFacts.map((facts) => facts.person);
  };
  try {
    assert.deepEqual(await person(1), [false]);
    append({
      type: 'user',
      sessionKind: 'bg',
      origin: { kind: 'human' },
      cwd: 'C:/repo',
      timestamp: activeAt,
      message: { role: 'user', content: 'Review the branch' },
    });
    assert.deepEqual(await person(2), [false], 'the launch prompt written after discovery read as a person');
    append({
      type: 'user',
      sessionKind: 'bg',
      origin: { kind: 'human' },
      cwd: 'C:/repo',
      timestamp: activeAt,
      message: { role: 'user', content: 'Use the other fixture' },
    });
    assert.deepEqual(await person(3), [true], 'the whole file of a quiet child was not read for a person');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a completed dispatched transcript beyond its metadata tail keeps its spend and artifacts', async () => {
  const directory = tempDir('panel-progressive-completed-dispatch-');
  const parentFile = path.join(directory, 'parent.jsonl');
  const childId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const childFile = path.join(directory, `${childId}.jsonl`);
  const parentRecords = [
    {
      type: 'assistant',
      timestamp: timestamp(1),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'dispatch-1', name: 'Bash', input: { command: 'python review.py --arc-dispatch' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: timestamp(2),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'dispatch-1',
            content: `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`,
          },
        ],
      },
      toolUseResult: { stdout: `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}` },
    },
  ];
  fs.writeFileSync(parentFile, parentRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const completedRecords = [
    { type: 'user', cwd: 'C:/repo', timestamp: timestamp(0), message: { role: 'user', content: 'Review' } },
    {
      type: 'assistant',
      timestamp: timestamp(1),
      message: {
        role: 'assistant',
        model: 'claude',
        content: [
          {
            type: 'tool_use',
            id: 'edit-1',
            name: 'Edit',
            input: { file_path: 'C:/repo/changed.ts', old_string: 'old', new_string: 'new' },
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: timestamp(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'changed' }] },
      toolUseResult: {
        filePath: 'C:/repo/changed.ts',
        originalFile: 'old\n',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
      },
    },
    {
      type: 'assistant',
      timestamp: timestamp(3),
      message: {
        role: 'assistant',
        model: 'claude',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 12,
          output_tokens: 34,
        },
        content: 'Finished',
      },
    },
  ];
  const filler = Array.from({ length: 320 }, () => ({
    type: 'assistant',
    timestamp: timestamp(2),
    message: { role: 'assistant', stop_reason: 'tool_use', content: 'x'.repeat(1024) },
  }));
  fs.writeFileSync(
    childFile,
    [...completedRecords.slice(0, 3), ...filler, completedRecords[3]]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  assert.ok(fs.statSync(childFile).size > 256 * 1024, 'fixture did not exceed the metadata tail');
  const parentStat = revisionOf(fs.statSync(parentFile, { bigint: true }));
  const childStat = revisionOf(fs.statSync(childFile, { bigint: true }));
  const parent = {
    agent: 'claude' as const,
    file: parentFile,
    sessionId: 'parent',
    mtimeMs: parentStat.mtimeMs,
    size: parentStat.size,
  };
  const child = {
    agent: 'claude' as const,
    file: childFile,
    sessionId: childId,
    mtimeMs: childStat.mtimeMs,
    size: childStat.size,
  };
  const worker = new ProgressiveWorker(source);
  try {
    const result = await completeDiscovery(
      worker,
      { kind: 'claude-children', parents: [parent], catalog: [parent, child], repositoryRoots: ['C:/repo'] },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'claude-children');
    const facts = result.value.dispatchFacts[0];
    assert.ok(facts?.spend.found, JSON.stringify(result.value));
    assert.deepEqual(
      facts?.spend.artifacts?.files.map((file) => file.path),
      ['C:/repo/changed.ts'],
    );
    assert.equal(facts?.spend.models[0]?.usage.output, 34);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude child discovery retries interrupted and concurrently changed parents without rescanning quiet parents', async () => {
  const directory = tempDir('panel-progressive-claude-retry-');
  const quietFile = path.join(directory, 'quiet.jsonl');
  const changingFile = path.join(directory, 'changing.jsonl');
  const childId = 'child-after-growth';
  const toolUseId = 'launch-after-growth';
  const childDirectory = path.join(directory, 'changing', 'subagents');
  const childFile = path.join(childDirectory, `agent-${childId}.jsonl`);
  fs.mkdirSync(childDirectory, { recursive: true });
  fs.writeFileSync(quietFile, `${JSON.stringify({ type: 'user', cwd: 'C:/repo' })}\n`);
  fs.writeFileSync(changingFile, `${JSON.stringify({ type: 'user', cwd: 'C:/repo' })}\n`);
  fs.writeFileSync(childFile, `${JSON.stringify({ type: 'user', cwd: 'C:/repo' })}\n`);
  const quietStat = revisionOf(fs.statSync(quietFile, { bigint: true }));
  const changingStat = revisionOf(fs.statSync(changingFile, { bigint: true }));
  const parents = [
    { agent: 'claude' as const, file: quietFile, sessionId: 'quiet', mtimeMs: quietStat.mtimeMs, size: quietStat.size },
    {
      agent: 'claude' as const,
      file: changingFile,
      sessionId: 'changing',
      mtimeMs: changingStat.mtimeMs,
      size: changingStat.size,
    },
  ];
  const request = { kind: 'claude-children' as const, parents, repositoryRoots: ['C:/repo'] };
  const prelude = (fault: 'interrupt' | 'grow') => `const faultFs = require('node:fs');
    const faultOpen = faultFs.openSync; const faultClose = faultFs.closeSync; const faultRead = faultFs.readSync;
    const faultFiles = new Map(); const faultReads = Object.create(null); let faulted = false;
    faultFs.openSync = function (file, ...args) { const fd = faultOpen.call(this,file,...args); faultFiles.set(fd,String(file)); return fd; };
    faultFs.readSync = function (fd, ...args) { const file = faultFiles.get(fd); if (file) faultReads[file] = (faultReads[file] || 0) + 1;
      if (${JSON.stringify(fault)} === 'interrupt' && file === ${JSON.stringify(changingFile)} && !faulted) { faulted = true; throw new Error('interrupted read'); }
      return faultRead.call(this,fd,...args); };
    faultFs.closeSync = function (fd) { const file = faultFiles.get(fd); faultFiles.delete(fd); const result = faultClose.call(this,fd);
      if (${JSON.stringify(fault)} === 'grow' && file === ${JSON.stringify(changingFile)} && !faulted) { faulted = true;
        faultFs.appendFileSync(file, ${JSON.stringify(
          [
            { type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Agent' }] } },
            {
              type: 'user',
              message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
              toolUseResult: { agentId: childId },
            },
          ]
            .map((record) => JSON.stringify(record))
            .join('\n') + '\n',
        )}); }
      return result; };
    const faultPort = require('node:worker_threads').parentPort; const faultPost = faultPort.postMessage;
    faultPort.postMessage = function (message) { if (message.result) message.result.faultReads = {...faultReads}; return faultPost.call(this,message); };`;
  try {
    for (const fault of ['interrupt', 'grow'] as const) {
      const initialRecords =
        fault === 'interrupt'
          ? [
              { type: 'user', cwd: 'C:/repo' },
              { type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Agent' }] } },
              {
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
                toolUseResult: { agentId: childId },
              },
            ]
          : [{ type: 'user', cwd: 'C:/repo' }];
      fs.writeFileSync(changingFile, `${initialRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
      const stat = revisionOf(fs.statSync(changingFile, { bigint: true }));
      parents[1] = { ...parents[1], mtimeMs: stat.mtimeMs, size: stat.size };
      const worker = new ProgressiveWorker(prelude(fault) + source);
      try {
        const first = await worker.run({ ...request, parents }, 1, new AbortController().signal);
        assert.ok(
          first?.value.kind === 'claude-children-progress',
          `${fault}: source progress or its fixed cut was lost`,
        );
        const firstReads = (first as typeof first & { faultReads: Record<string, number> }).faultReads;
        const second = await completeDiscovery(
          worker,
          {
            ...request,
            parents: parents.map((parent) => {
              const current = revisionOf(fs.statSync(parent.file, { bigint: true }));
              return { ...parent, mtimeMs: current.mtimeMs, size: current.size };
            }),
          },
          2,
          new AbortController().signal,
        );
        assert.ok(second?.value.kind === 'claude-children');
        const secondReads = (second as typeof second & { faultReads: Record<string, number> }).faultReads;
        assert.equal(
          secondReads[quietFile],
          firstReads[quietFile],
          `${fault}: retry rescanned a quiet parent whose completed result was reusable`,
        );
        assert.equal(
          second.value.children.some((child) => child.sessionId === childId),
          true,
          `a negative result from an ${fault === 'grow' ? 'concurrently changed' : 'interrupted'} parent survived the retry`,
        );
      } finally {
        worker.stop();
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function opening(agent: AgentKind): object[] {
  return agent === 'claude'
    ? [
        {
          type: 'user',
          promptId: 'prompt',
          timestamp: timestamp(0),
          message: { role: 'user', content: [{ type: 'text', text: 'Keep this open' }] },
        },
      ]
    : [
        { type: 'session_meta', timestamp: timestamp(0), payload: { id: 'session', cwd: 'C:/repo', source: 'vscode' } },
        { type: 'event_msg', timestamp: timestamp(1), payload: { type: 'task_started', turn_id: 'prompt' } },
        {
          type: 'response_item',
          timestamp: timestamp(1),
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep this open' }] },
        },
      ];
}

for (const agent of ['claude', 'codex'] as const) {
  test(`${agent} history pages carry an open turn range through the worker`, async () => {
    const directory = tempDir(`panel-progressive-${agent}-open-history-`);
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(
      file,
      opening(agent)
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
    const input: ProgressiveInput = {
      session: { file, sessionId: 'session', agent, mtimeMs, size },
      folders: [],
      children: [],
      maxTurns: 40,
      tailBytes: 2048,
    };
    const worker = new ProgressiveWorker(source);
    try {
      const result = await worker.run({ kind: 'page', input, cursor: null }, 1, new AbortController().signal);
      assert.ok(result?.value.kind === 'page');
      assert.equal(result.value.page.kind, 'page');
      if (result.value.page.kind !== 'page') {
        return;
      }
      assert.deepEqual(result.value.page.turns, []);
      assert.equal(result.value.page.cursor, null);
      assert.ok(
        result.value.page.openRange,
        'the worker dropped the range that keeps an open turn outside completed history',
      );
      assert.ok(result.value.page.openRange.start < result.value.page.openRange.end);
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('the Claude worker preserves the exact child close time', async () => {
  const directory = tempDir('panel-progressive-claude-close-');
  const file = path.join(directory, 'session.jsonl');
  const records = [
    {
      type: 'user',
      promptId: 'prompt',
      timestamp: timestamp(0),
      message: { role: 'user', content: [{ type: 'text', text: 'Run a child' }] },
    },
    {
      type: 'assistant',
      timestamp: timestamp(1),
      message: {
        role: 'assistant',
        id: 'launch',
        model: 'claude-opus-5',
        content: [
          {
            type: 'tool_use',
            id: 'agent-call',
            name: 'Agent',
            input: { description: 'Check it', run_in_background: true },
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: timestamp(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'launched' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'child-1', description: 'Check it' },
    },
    {
      type: 'assistant',
      timestamp: timestamp(3),
      message: {
        role: 'assistant',
        id: 'answer',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Waiting' }],
      },
    },
    {
      type: 'user',
      timestamp: timestamp(4),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content:
          '<task-notification><task-id>child-1</task-id><tool-use-id>agent-call</tool-use-id><status>completed</status></task-notification>',
      },
    },
    {
      type: 'assistant',
      timestamp: timestamp(5),
      message: {
        role: 'assistant',
        id: 'later',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The child finished' }],
      },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
  const worker = new ProgressiveWorker(source);
  try {
    const result = await worker.run(
      {
        kind: 'window',
        input: {
          session: { file, sessionId: 'session', agent: 'claude', mtimeMs, size },
          folders: [],
          children: [],
          claudeChildren: [],
          maxTurns: 40,
          tailBytes: 4096,
        },
      },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'window');
    assert.deepEqual(sessionOutcomeOf(result.value.read)?.closedChildren, [
      { id: 'child-1', closedAt: Date.parse(timestamp(4)) },
    ]);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Metadata retains background commands from the tail even when the turn's first prompt lies before it.

test('a Claude metadata entry carries the background commands the tail read found', async () => {
  const directory = tempDir('panel-progressive-claude-background-');
  const file = path.join(directory, 'session.jsonl');
  const records = [
    {
      type: 'user',
      promptId: 'prompt',
      timestamp: timestamp(0),
      message: { role: 'user', content: [{ type: 'text', text: 'orchestrate the release' }] },
    },
    {
      type: 'assistant',
      timestamp: timestamp(1),
      message: {
        role: 'assistant',
        id: 'padding',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'x'.repeat(8_000) }],
      },
    },
    {
      type: 'assistant',
      timestamp: timestamp(2),
      message: {
        role: 'assistant',
        id: 'launch',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'cmd1', name: 'Bash', input: { command: 'npm test', run_in_background: true } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: timestamp(3),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'cmd1', content: 'Command running in background with ID: b349silf3' },
        ],
      },
      toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b349silf3' },
    },
    {
      type: 'assistant',
      timestamp: timestamp(4),
      message: {
        role: 'assistant',
        id: 'answer',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The suite runs in the background.' }],
      },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
  const worker = new ProgressiveWorker(source);
  try {
    const session = { file, size, mtimeMs, agent: 'claude' as const, sessionId: 'session' };
    const metadata = await worker.run({ kind: 'metadata', session, tailBytes: 2_048 }, 1, new AbortController().signal);
    assert.ok(metadata?.value.kind === 'metadata');
    const entry = metadata.value.entry;
    assert.equal(entry.outcome, null, 'the tail read holds no typed prompt');
    assert.equal(entry.backgroundCommands?.length, 1, 'the tail read carried the launch forward');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function activity(agent: AgentKind, n: number): object {
  return agent === 'claude'
    ? {
        type: 'assistant',
        timestamp: timestamp(n + 2),
        message: {
          role: 'assistant',
          id: `message-${n}`,
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: `tool-${n}`, name: 'Bash', input: { command: `echo ${n}` } }],
        },
      }
    : {
        type: 'response_item',
        timestamp: timestamp(n + 2),
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: `tool-${n}`,
          arguments: JSON.stringify({ cmd: `echo ${n}` }),
        },
      };
}

// Include hidden call ids, full commands, Claude child ids, and symbol-keyed byte ranges on open turns.

function detailedTurn(agent: AgentKind, n: number, closed: boolean): object[] {
  const command = `echo ${n}\n${'echo more detail than one line holds\n'.repeat(8)}`;
  const answer = {
    type: 'assistant',
    timestamp: timestamp(n * 4 + 2),
    message: {
      role: 'assistant',
      id: `answer-${n}`,
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: `answer ${n} ${'x'.repeat(600)}` }],
    },
  };
  const complete = {
    type: 'event_msg',
    timestamp: timestamp(n * 4 + 2),
    payload: { type: 'task_complete', turn_id: `prompt-${n}`, last_agent_message: `answer ${n} ${'x'.repeat(600)}` },
  };
  return agent === 'claude'
    ? [
        {
          type: 'user',
          promptId: `prompt-${n}`,
          timestamp: timestamp(n * 4),
          message: { role: 'user', content: [{ type: 'text', text: `prompt ${n}` }] },
        },
        {
          type: 'assistant',
          timestamp: timestamp(n * 4 + 1),
          message: {
            role: 'assistant',
            id: `message-${n}`,
            model: 'claude-opus-5',
            content: [
              { type: 'tool_use', id: `tool-${n}`, name: 'Bash', input: { command } },
              {
                type: 'tool_use',
                id: `agent-${n}`,
                name: 'Agent',
                input: { description: 'look', subagent_type: 'Explore' },
              },
            ],
          },
        },
        ...(closed ? [answer] : []),
      ]
    : [
        { type: 'event_msg', timestamp: timestamp(n * 4), payload: { type: 'task_started', turn_id: `prompt-${n}` } },
        {
          type: 'response_item',
          timestamp: timestamp(n * 4),
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `prompt ${n}` }] },
        },
        {
          type: 'response_item',
          timestamp: timestamp(n * 4 + 1),
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: `tool-${n}`,
            arguments: JSON.stringify({ cmd: command }),
          },
        },
        ...(closed ? [complete] : []),
      ];
}

// Read non-enumerable fields explicitly because deep equality omits them.

function hiddenFieldsOf(turns: readonly Turn[]): unknown[] {
  return turns.map((turn) => ({
    steps: turn.steps.map((step) => [step.id ?? null, step.fullDetail ?? null]),
    agents: turn.agents.map((agent) => agent.toolUseId ?? null),
  }));
}

// Check hidden field descriptors as well as values so resumed turns retain their write constraints.

function hiddenDescriptorsOf(turns: readonly Turn[]): unknown[] {
  return turns.map((turn) => ({
    steps: turn.steps.map((step) =>
      ['id', 'fullDetail'].map((key) => Object.getOwnPropertyDescriptor(step, key) ?? null),
    ),
    agents: turn.agents.map((agent) => Object.getOwnPropertyDescriptor(agent, 'toolUseId') ?? null),
  }));
}

test('Claude relationship changes invalidate the current window and refresh retained child rows', async () => {
  const directory = tempDir('panel-progressive-claude-child-');
  const parent = path.join(directory, 'parent.jsonl');
  const childDirectory = path.join(directory, 'parent', 'subagents');
  const child = path.join(childDirectory, 'agent-child.jsonl');
  fs.mkdirSync(childDirectory, { recursive: true });
  fs.writeFileSync(
    parent,
    [
      {
        type: 'user',
        promptId: 'prompt',
        timestamp: timestamp(0),
        cwd: 'C:/repo',
        message: { role: 'user', content: [{ type: 'text', text: 'Delegate the check' }] },
      },
      {
        type: 'assistant',
        timestamp: timestamp(1),
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 'launch-child', name: 'Agent', input: { description: 'Review child' } }],
        },
      },
      {
        type: 'user',
        timestamp: timestamp(2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-child', content: 'done' }] },
        toolUseResult: { agentId: 'child', status: 'completed', totalToolUseCount: 2 },
      },
      {
        type: 'assistant',
        timestamp: timestamp(3),
        message: {
          role: 'assistant',
          id: 'answer',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Reviewed.' }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  fs.writeFileSync(
    child,
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      timestamp: timestamp(2),
      cwd: 'C:/repo',
      message: {
        role: 'assistant',
        id: 'child-answer',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Child complete.' }],
        usage: { input_tokens: 20, output_tokens: 5 },
      },
    }) + '\n',
  );
  const worker = new ProgressiveWorker(source);
  try {
    const parentStat = revisionOf(fs.statSync(parent, { bigint: true }));
    const childStat = revisionOf(fs.statSync(child, { bigint: true }));
    const session = {
      agent: 'claude' as const,
      file: parent,
      sessionId: 'parent',
      mtimeMs: parentStat.mtimeMs,
      size: parentStat.size,
    };
    const base = { session, folders: ['C:/repo'], children: [], maxTurns: 40, tailBytes: 4096 };
    const unavailable = await worker.run({ kind: 'window', input: base }, 1, new AbortController().signal);
    assert.ok(unavailable?.value.kind === 'window');
    assert.equal(unavailable.value.read.turns[0].agents[0].childSessionId, undefined);
    const claudeChildren = [
      {
        agent: 'claude' as const,
        file: child,
        sessionId: 'child',
        parentSessionId: 'parent',
        toolUseIds: ['launch-child'],
        mtimeMs: childStat.mtimeMs,
        size: childStat.size,
        cwd: 'C:/repo',
        agentRun: true as const,
        childTranscript: true as const,
      },
    ];
    const availableInput = { ...base, claudeChildren };
    const available = await worker.run(
      { kind: 'window', input: availableInput, checkpoint: unavailable.value.checkpoint },
      2,
      new AbortController().signal,
    );
    assert.ok(available?.value.kind === 'window');
    assert.notEqual(
      available.value.agentKey,
      unavailable.value.agentKey,
      'verified child availability did not invalidate the unchanged parent window',
    );
    assert.equal(available.value.read.turns[0].agents[0].childSessionId, 'child');

    const retained = await worker.run(
      {
        kind: 'retained',
        input: availableInput,
        pages: [{ turns: unavailable.value.read.turns, compactions: [], bytes: 1 }],
      },
      3,
      new AbortController().signal,
    );
    assert.ok(retained?.value.kind === 'retained');
    assert.equal(
      retained.value.pages[0].turns[0].agents[0].childSessionId,
      'child',
      'an older parent row kept its unavailable child target after discovery changed',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  { trimmed: false, knownChild: false },
  { trimmed: true, knownChild: false },
  { trimmed: false, knownChild: true },
  { trimmed: true, knownChild: true },
])(
  'Codex row runtime survives worker replies with $trimmed trimmed launch and $knownChild known child',
  async ({ trimmed, knownChild }) => {
    const directory = tempDir('codex-row-runtime-');
    const file = path.join(directory, 'parent.jsonl');
    const record = (type: string, at: number, payload: object) =>
      JSON.stringify({ type, timestamp: timestamp(at), payload });
    fs.writeFileSync(
      file,
      [
        record('session_meta', 0, { id: 'parent', cwd: 'C:/repo', source: 'vscode' }),
        record('event_msg', 1, { type: 'task_started', turn_id: 'turn' }),
        record('event_msg', 2, { type: 'user_message', message: 'delegate' }),
        record('response_item', 4, {
          type: 'function_call',
          name: 'spawn_agent',
          call_id: 'spawn',
          arguments: JSON.stringify({ task_name: 'worker', message: 'review' }),
        }),
        record('event_msg', 5, {
          type: 'sub_agent_activity',
          event_id: 'spawn',
          agent_thread_id: 'child',
          agent_path: '/root/worker',
          kind: 'running',
        }),
        ...Array.from({ length: trimmed ? 61 : 0 }, (_, index) =>
          record('response_item', 6, {
            type: 'function_call',
            name: 'exec_command',
            call_id: `command-${index}`,
            arguments: '{}',
          }),
        ),
        record('event_msg', 8, { type: 'task_complete', turn_id: 'turn', last_agent_message: 'delegated' }),
      ].join('\n') + '\n',
    );
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    const childFile = path.join(directory, 'child.jsonl');
    fs.writeFileSync(childFile, record('event_msg', 5, { type: 'task_started', turn_id: 'child-turn' }) + '\n');
    const input = {
      session: { agent: 'codex' as const, file, sessionId: 'parent', size: stat.size, mtimeMs: stat.mtimeMs },
      folders: ['C:/repo'],
      children: knownChild
        ? [
            {
              file: childFile,
              threadId: 'child',
              parentThreadId: 'parent',
              agentPath: '/root/worker',
              openedAt: Date.parse(timestamp(5)),
              startedAt: Date.parse(timestamp(3)),
              threadSource: 'subagent',
              backgroundReview: false,
            },
          ]
        : [],
      maxTurns: 40,
      tailBytes: stat.size,
    };
    const worker = new ProgressiveWorker(source);
    const now = Date.parse(timestamp(180));
    const check = (turn: Turn) => {
      assert.equal(turn.agents[0].toolUseId, undefined);
      assert.equal(
        turn.steps.some((step) => step.id !== undefined),
        false,
      );
      assert.equal(
        turn.steps.some((step) => step.name === 'spawn_agent'),
        !trimmed,
      );
      const row = toCard(turn, true, now, [], null, false, new Set(['child'])).agents[0];
      assert.equal(row.state, 'running');
      assert.equal(
        row.since,
        Date.parse(timestamp(knownChild ? 3 : 4)),
        'the running Subagents row lost elapsed runtime',
      );
      assert.equal(
        row.figures.some((figure) => figure.metric === 'duration'),
        false,
      );
      assert.equal(toCard(turn, true, now).agents[0].since, null, 'a missing ending counted up without live evidence');
      const launch = logOf(turn).rows.find((step) => step.sourceId === 'spawn');
      if (!trimmed) assert.equal(launch?.figure, '', 'runtime restored hidden Activity outcome pairing');
    };
    try {
      const window = await worker.run({ kind: 'window', input }, 1, new AbortController().signal);
      assert.ok(window?.value.kind === 'window');
      check(window.value.read.turns[0]);
      const page = await worker.run({ kind: 'page', input, cursor: null }, 2, new AbortController().signal);
      assert.ok(page?.value.kind === 'page' && page.value.page.kind === 'page');
      check(page.value.page.turns[0]);
      const retained = await worker.run(
        {
          kind: 'retained',
          input,
          pages: [{ turns: [...page.value.page.turns], compactions: [], bytes: 0 }],
        },
        3,
        new AbortController().signal,
      );
      assert.ok(retained?.value.kind === 'retained');
      check(retained.value.pages[0].turns[0]);
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

// Child rollout appends change the worker cost key without changing the parent structural key.

test('a Codex child append moves the worker cost key and leaves the parent window current', async () => {
  const directory = tempDir('panel-progressive-codex-child-');
  const parent = path.join(directory, 'parent.jsonl');
  const child = path.join(directory, 'child.jsonl');
  const event = (at: number, payload: object) =>
    JSON.stringify({ type: 'event_msg', timestamp: timestamp(at), payload });
  fs.writeFileSync(
    parent,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: timestamp(0),
        payload: { id: 'parent', cwd: 'C:/repo', source: 'vscode' },
      }),
      event(1, { type: 'task_started', turn_id: 'turn' }),
      event(2, { type: 'user_message', message: 'delegate the review' }),
      event(8, { type: 'task_complete', turn_id: 'turn', last_agent_message: 'delegated' }),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(child, event(4, { type: 'task_started', turn_id: 'child-turn' }) + '\n');
  const worker = new ProgressiveWorker(source);
  try {
    const stat = revisionOf(fs.statSync(parent, { bigint: true }));
    const session = {
      agent: 'codex' as const,
      file: parent,
      sessionId: 'parent',
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
    const children = [
      {
        file: child,
        threadId: 'child',
        parentThreadId: 'parent',
        agentPath: '/root/review',
        openedAt: Date.parse(timestamp(4)),
        startedAt: Date.parse(timestamp(3)),
        threadSource: 'guardian_review',
        backgroundReview: false,
      },
    ];
    const input = { session, folders: ['C:/repo'], children, maxTurns: 40, tailBytes: 4096 };
    const running = await worker.run({ kind: 'window', input }, 1, new AbortController().signal);
    assert.ok(running?.value.kind === 'window');
    assert.deepEqual(
      running.value.read.turns[0].agents.map((agent) => [agent.id, agent.status]),
      [['child', 'running']],
    );
    assert.deepEqual(
      running.value.structuralAgentIds,
      ['child'],
      'the window result names no structural row, so a refresh cannot tell one from a parent-recorded row',
    );
    const card = (turn: Turn, live: boolean) =>
      toCard(turn, true, Date.parse(timestamp(180)), [], null, false, new Set(live ? ['child'] : [])).agents[0];
    assert.equal(card(running.value.read.turns[0], true).since, Date.parse(timestamp(3)));
    assert.equal(card(running.value.read.turns[0], false).since, null);

    // The child writes while it runs. Its row is still open, so the recorded half of the key
    // names no revision for it and only the child revisions can move the key.
    fs.appendFileSync(child, event(5, { type: 'user_message', message: 'reviewing' }) + '\n');
    const appended = await worker.run({ kind: 'window', input }, 2, new AbortController().signal);
    assert.ok(appended?.value.kind === 'window');
    assert.equal(
      appended.value.structuralKey,
      running.value.structuralKey,
      'a child append invalidated the parent window, so the selected card shows the loading row',
    );
    assert.notEqual(
      appended.value.agentKey,
      running.value.agentKey,
      'the worker cost key drops the child revisions the host key carries, so the two never agree',
    );

    // The refresh reapplies the child's own lifecycle to turns the host holds. Those turns
    // crossed the worker boundary, so the refresh needs the structural rows named.
    fs.appendFileSync(
      child,
      event(6, { type: 'task_complete', turn_id: 'child-turn', last_agent_message: 'reviewed' }) + '\n',
    );
    const page = { turns: appended.value.read.turns, compactions: [], bytes: 0 };
    const finished = await worker.run(
      { kind: 'retained', input, pages: [page], structuralAgentIds: appended.value.structuralAgentIds },
      3,
      new AbortController().signal,
    );
    assert.ok(finished?.value.kind === 'retained');
    assert.equal(finished.value.pages[0].turns[0].agents[0].status, 'completed');
    assert.equal(card(finished.value.pages[0].turns[0], false).since, null);
    assert.equal(
      card(finished.value.pages[0].turns[0], false).figures.find((figure) => figure.metric === 'duration')
        ?.compactLabel,
      '3s',
    );

    fs.appendFileSync(child, event(20, { type: 'task_started', turn_id: 'resumed-turn' }) + '\n');
    const resumed = await worker.run(
      {
        kind: 'retained',
        input,
        pages: [{ ...page, turns: finished.value.pages[0].turns }],
        structuralAgentIds: appended.value.structuralAgentIds,
      },
      4,
      new AbortController().signal,
    );
    assert.ok(resumed?.value.kind === 'retained');
    assert.equal(
      resumed.value.pages[0].turns[0].agents[0].status,
      'running',
      'the card calls a resumed child finished, because the refresh read its row as parent-recorded',
    );
    assert.equal(card(resumed.value.pages[0].turns[0], true).since, Date.parse(timestamp(3)));
    assert.equal(
      card(resumed.value.pages[0].turns[0], true).figures.some((figure) => figure.metric === 'duration'),
      false,
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('grandchild-only changes refresh warm Codex root costs and retained pages', async () => {
  const directory = tempDir('panel-progressive-nested-codex-');
  const files = ['root', 'child', 'grandchild'].map((id) => path.join(directory, `${id}.jsonl`));
  const record = (type: string, at: number, payload: object) =>
    JSON.stringify({ type, timestamp: timestamp(at), payload });
  const task = (id: string, second: number, input: number) => [
    record('event_msg', second, {
      type: 'task_started',
      turn_id: id,
      started_at: Date.parse(timestamp(second)) / 1000,
    }),
    record('turn_context', second + 1, { turn_id: id, model: 'gpt-5.6-sol', effort: 'high' }),
    record('event_msg', second + 1, { type: 'user_message', message: 'review' }),
    record('event_msg', second + 2, {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: input, output_tokens: 0 }, model_context_window: 258400 },
    }),
    record('event_msg', second + 5, { type: 'task_complete', turn_id: id, last_agent_message: 'done' }),
  ];
  const write = (id: string, parent: string | null, second: number, input: number, launch?: string) => {
    const records = [
      record('session_meta', second, {
        id,
        session_id: 'root',
        cwd: 'C:/repo',
        model_provider: 'openai',
        ...(parent
          ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: `/root/${id}` } } } }
          : { source: 'vscode' }),
      }),
      ...task(`${id}-turn`, second + 1, input),
    ];
    if (launch)
      records.splice(
        4,
        0,
        record('response_item', second + 3, {
          type: 'function_call',
          name: 'spawn_agent',
          call_id: `spawn-${launch}`,
          arguments: JSON.stringify({ task_name: launch }),
        }),
        record('response_item', second + 4, {
          type: 'function_call_output',
          call_id: `spawn-${launch}`,
          output: JSON.stringify({ task_name: `/root/${launch}` }),
        }),
      );
    return records.join('\n') + '\n';
  };
  fs.writeFileSync(files[0], write('root', null, 0, 100, 'child'));
  fs.writeFileSync(files[1], write('child', 'root', 3, 200, 'grandchild'));
  const children: CodexSubagentFile[] = [
    {
      file: files[1],
      threadId: 'child',
      parentThreadId: 'root',
      agentPath: '/root/child',
      openedAt: Date.parse(timestamp(3)),
      startedAt: Date.parse(timestamp(3)),
      threadSource: 'subagent',
      backgroundReview: false,
    },
  ];
  const worker = new ProgressiveWorker(source);
  try {
    const stat = revisionOf(fs.statSync(files[0], { bigint: true }));
    const session = {
      agent: 'codex' as const,
      file: files[0],
      sessionId: 'root',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    const input = {
      session,
      folders: ['C:/repo'],
      children,
      maxTurns: 40,
      tailBytes: 4096,
      spendNow: Date.now() + 6_000,
    };
    const run = async (generation: number, checkpoint?: ProgressiveCheckpoint) => {
      const result = await worker.run(
        { kind: 'window', input: { ...input, children: [...children] }, checkpoint },
        generation,
        new AbortController().signal,
      );
      assert.ok(result?.value.kind === 'window');
      return result.value;
    };
    const missing = await run(1);
    assert.equal(turnCost(missing.read.turns[0]).partial, true);
    fs.writeFileSync(files[2], write('grandchild', 'child', 6, 400));
    children.push({
      file: files[2],
      threadId: 'grandchild',
      parentThreadId: 'child',
      agentPath: '/root/grandchild',
      openedAt: Date.parse(timestamp(6)),
      startedAt: Date.parse(timestamp(6)),
      threadSource: 'subagent',
      backgroundReview: false,
    });
    const appeared = await run(2, missing.checkpoint);
    assert.equal(appeared.readBytes, 0);
    assert.ok(Math.abs(turnCost(appeared.read.turns[0]).dollars! - 0.0028) < 1e-12);
    assert.equal(turnCost(appeared.read.turns[0]).partial, false);
    assert.notEqual(appeared.agentKey, missing.agentKey);
    assert.equal(appeared.structuralKey, missing.structuralKey);
    const index = codexSpendIndex(children);
    const version = codexAgentSpendVersion(files[1], index);
    const expectedKey = agentSpendDependencyKey(
      appeared.read.turns,
      () => files[1],
      (file) => codexAgentSpendVersion(file, index, undefined, undefined, files[0]),
      appeared.structuralKey,
      [files[1]],
      input.spendNow,
    );
    assert.equal(appeared.agentKey, expectedKey);
    assert.ok(version.includes('grandchild'));
    const savedGrandchild = fs.readFileSync(files[2]);
    fs.appendFileSync(files[2], ' '.repeat(10_000_000) + '\n');
    assert.ok(openSpendBand(codexAgentSpendVersion(files[1], index), Date.now())?.startsWith('20000:'));
    fs.writeFileSync(files[2], savedGrandchild);
    fs.appendFileSync(files[2], task('resumed-grandchild', 20, 800).join('\n') + '\n');
    const appended = await run(3, appeared.checkpoint);
    assert.equal(appended.readBytes, 0);
    assert.notEqual(appended.agentKey, appeared.agentKey);
    assert.ok(Math.abs(turnCost(appended.read.turns[0]).dollars! - 0.006) < 1e-12);
    const retained = await worker.run(
      {
        kind: 'retained',
        input: { ...input, children: [...children] },
        pages: [{ turns: appeared.read.turns, compactions: [], bytes: 0 }],
        structuralAgentIds: appeared.structuralAgentIds,
      },
      4,
      new AbortController().signal,
    );
    assert.ok(retained?.value.kind === 'retained');
    assert.equal(turnCost(retained.value.pages[0].turns[0]).dollars, turnCost(appended.read.turns[0]).dollars);
    fs.appendFileSync(files[2], task('open-grandchild', 40, 200).slice(0, -1).join('\n') + '\n');
    fs.utimesSync(files[1], 100, 100);
    fs.utimesSync(files[2], 100, 100);
    input.spendNow = 100_000;
    const open = await run(5, appended.checkpoint);
    assert.equal(open.read.turns[0].agents[0].status, 'completed');
    assert.ok(open.read.turns[0].agents[0].artifacts);
    assert.equal(turnCost(open.read.turns[0]).partial, true);
    const openCost = turnCost(open.read.turns[0]).dollars;
    fs.appendFileSync(
      files[2],
      record('event_msg', 45, { type: 'task_complete', turn_id: 'open-grandchild', last_agent_message: 'done' }) + '\n',
    );
    fs.utimesSync(files[2], 100.1, 100.1);
    input.spendNow = 100_100;
    const held = await run(6, open.checkpoint);
    assert.equal(held.agentKey, open.agentKey);
    assert.equal(turnCost(held.read.turns[0]).partial, true);
    input.spendNow = 105_101;
    const quiet = await run(7, held.checkpoint);
    assert.notEqual(quiet.agentKey, held.agentKey);
    assert.equal(turnCost(quiet.read.turns[0]).partial, false);
    assert.equal(turnCost(quiet.read.turns[0]).dollars, openCost);
    assert.ok(quiet.read.turns[0].agents[0].artifacts);
    let retainedPages: import('./historypages').HistoryPage[] = [
      { turns: quiet.read.turns, compactions: [], bytes: 0 },
    ];
    for (const [offset, event] of [
      ['start', record('event_msg', 50, { type: 'task_started', turn_id: 'direct-resume' })],
      ['older', record('event_msg', 51, { type: 'task_complete', turn_id: 'child-turn' })],
      ['complete', record('event_msg', 55, { type: 'task_complete', turn_id: 'direct-resume' })],
    ]) {
      fs.appendFileSync(files[1], event + '\n');
      fs.utimesSync(files[1], 100, 100);
      input.spendNow += 6_000;
      const refreshed = await worker.run(
        {
          kind: 'retained',
          input,
          pages: structuredClone(retainedPages),
          structuralAgentIds: quiet.structuralAgentIds,
        },
        8,
        new AbortController().signal,
      );
      assert.ok(refreshed?.value.kind === 'retained');
      retainedPages = refreshed.value.pages;
      const fresh = await run(8);
      const facts = (turn: (typeof quiet.read.turns)[number]) => ({
        cost: turnCost(turn),
        rows: turn.agents.map((agent) => [
          agent.id,
          agent.status,
          agent.durationMs,
          agent.spendPartial,
          agent.childSessionId,
        ]),
      });
      assert.deepEqual(facts(retainedPages[0].turns[0]), facts(fresh.read.turns[0]), offset);
      assert.equal(turnCost(retainedPages[0].turns[0]).partial, offset !== 'complete', offset);
      assert.equal(turnCost(retainedPages[0].turns[0]).dollars, openCost, offset);
    }
    fs.unlinkSync(files[2]);
    const disappeared = await run(8, quiet.checkpoint);
    assert.equal(disappeared.readBytes, 0);
    assert.notEqual(disappeared.agentKey, appended.agentKey);
    assert.equal(turnCost(disappeared.read.turns[0]).partial, true);
    assert.ok(Math.abs(turnCost(disappeared.read.turns[0]).dollars! - 0.0012) < 1e-12);
    fs.writeFileSync(files[2], write('grandchild', 'child', 6, 400));
    fs.utimesSync(files[2], 100, 100);
    fs.unlinkSync(files[1]);
    const missingDirect = await run(9, disappeared.checkpoint);
    assert.equal(turnCost(missingDirect.read.turns[0]).partial, true);
    assert.ok(Math.abs(turnCost(missingDirect.read.turns[0]).dollars! - 0.002) < 1e-12);
    const childRecords = write('child', 'root', 3, 200, 'grandchild')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    delete childRecords[0].payload.source;
    childRecords[0].payload.thread_source = 'subagent';
    fs.writeFileSync(files[1], childRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
    fs.utimesSync(files[1], 100, 100);
    children[0].parentThreadId = null;
    const rootRecords = write('root', null, 0, 100, 'child')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    rootRecords.find((record) => record.payload.type === 'function_call_output').payload.output = JSON.stringify({
      agent_id: 'child',
      nickname: 'child',
    });
    fs.writeFileSync(files[0], rootRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const changedRoot = revisionOf(fs.statSync(files[0], { bigint: true }));
    session.size = changedRoot.size;
    session.mtimeMs = changedRoot.mtimeMs;
    const explicit = await run(10);
    assert.equal(explicit.read.turns[0].agents[0].childSessionId, 'child');
    assert.equal(turnCost(explicit.read.turns[0]).partial, true);
    assert.ok(Math.abs(turnCost(explicit.read.turns[0]).dollars! - 0.0028) < 1e-12);
  } finally {
    worker.stop();
  }
});

test('Claude child spend uses the paired transcript when navigation scope rejects it', async () => {
  const directory = tempDir('panel-progressive-claude-spend-');
  const parent = path.join(directory, 'parent.jsonl');
  const childDirectory = path.join(directory, 'parent', 'subagents');
  const child = path.join(childDirectory, 'agent-child.jsonl');
  fs.mkdirSync(childDirectory, { recursive: true });
  fs.writeFileSync(
    parent,
    [
      {
        type: 'user',
        promptId: 'prompt',
        timestamp: timestamp(0),
        cwd: 'C:/repo',
        message: { role: 'user', content: [{ type: 'text', text: 'Delegate the check' }] },
      },
      {
        type: 'assistant',
        timestamp: timestamp(1),
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 'launch-child', name: 'Agent', input: { description: 'Review child' } }],
        },
      },
      {
        type: 'user',
        timestamp: timestamp(2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-child', content: 'done' }] },
        toolUseResult: { agentId: 'child', status: 'completed', totalToolUseCount: 2 },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  fs.writeFileSync(
    child,
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      timestamp: timestamp(2),
      cwd: 'D:/outside',
      message: {
        role: 'assistant',
        id: 'child-answer',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Child complete.' }],
        usage: { input_tokens: 20, output_tokens: 5 },
      },
    }) + '\n',
  );
  const worker = new ProgressiveWorker(source);
  try {
    const parentStat = revisionOf(fs.statSync(parent, { bigint: true }));
    const input = {
      session: {
        agent: 'claude' as const,
        file: parent,
        sessionId: 'parent',
        mtimeMs: parentStat.mtimeMs,
        size: parentStat.size,
      },
      folders: ['C:/repo'],
      children: [],
      claudeChildren: [],
      maxTurns: 40,
      tailBytes: 4096,
      claudeChildReferences: [
        {
          parentSessionId: 'parent',
          sessionId: 'child',
          file: child,
          toolUseIds: ['launch-child'],
        },
      ],
    } as ProgressiveInput & {
      claudeChildReferences: Array<{
        parentSessionId: string;
        sessionId: string;
        file: string;
        toolUseIds: string[];
      }>;
    };
    const result = await worker.run({ kind: 'window', input }, 1, new AbortController().signal);
    assert.ok(result?.value.kind === 'window');
    const agent = result.value.read.turns[0].agents[0];
    assert.equal(agent.spendFound, true, 'repository scope incorrectly removed verified child spend');
    assert.equal(agent.childSessionId, undefined, 'an out-of-scope child became a navigation target');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// A background child that no discovery pass has listed yet. Claude Code writes its meta file
// beside the child transcript when the child starts, and the meta names the launch call. With
// `nested`, the child launches a haiku grandchild that reads more than the child itself, and its
// meta file sits in the same folder with `parentAgentId`. `view: 'child'` reads the child
// transcript as its own session. With `running`, the parent has no completion notice yet.
async function undiscoveredBackgroundChild(
  metaToolUseId: string,
  {
    nested = false,
    view = 'parent',
    running = false,
  }: { nested?: boolean; view?: 'parent' | 'child'; running?: boolean } = {},
) {
  const directory = tempDir('panel-progressive-claude-meta-child-');
  const parent = path.join(directory, 'parent.jsonl');
  const childDirectory = path.join(directory, 'parent', 'subagents');
  fs.mkdirSync(childDirectory, { recursive: true });
  const grandchildNotice =
    '<task-notification><task-id>grandchild</task-id><tool-use-id>launch-grandchild</tool-use-id>' +
    '<status>completed</status><subagent_tokens>504000</subagent_tokens>' +
    '<tool_uses>3</tool_uses><duration_ms>35000</duration_ms></task-notification>';
  const grandchildLaunch = [
    {
      type: 'assistant',
      isSidechain: true,
      timestamp: timestamp(3),
      cwd: 'C:/repo',
      message: {
        role: 'assistant',
        id: 'child-launch',
        model: 'claude-opus-5-5',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'launch-grandchild',
            name: 'Agent',
            input: { description: 'Search the tests', model: 'haiku', run_in_background: true },
          },
        ],
        usage: { input_tokens: 1_000, output_tokens: 100 },
      },
    },
    {
      type: 'user',
      isSidechain: true,
      timestamp: timestamp(4),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'launch-grandchild',
            content: 'Async agent launched successfully.\nagentId: grandchild',
          },
        ],
      },
      toolUseResult: {
        isAsync: true,
        status: 'async_launched',
        agentId: 'grandchild',
        description: 'Search the tests',
      },
    },
    { type: 'queue-operation', operation: 'enqueue', timestamp: timestamp(41), content: grandchildNotice },
    {
      type: 'user',
      isSidechain: true,
      timestamp: timestamp(42),
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: grandchildNotice },
    },
  ];
  const completionNotice = [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: timestamp(60),
      content:
        '<task-notification><task-id>child</task-id><tool-use-id>launch-child</tool-use-id>' +
        '<status>completed</status><subagent_tokens>116028</subagent_tokens>' +
        '<tool_uses>12</tool_uses><duration_ms>780000</duration_ms></task-notification>',
    },
    {
      type: 'user',
      timestamp: timestamp(61),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content:
          '<task-notification><task-id>child</task-id><tool-use-id>launch-child</tool-use-id>' +
          '<status>completed</status><subagent_tokens>116028</subagent_tokens>' +
          '<tool_uses>12</tool_uses><duration_ms>780000</duration_ms></task-notification>',
      },
    },
  ];
  fs.writeFileSync(
    parent,
    jsonLines([
      {
        type: 'user',
        promptId: 'prompt',
        timestamp: timestamp(0),
        cwd: 'C:/repo',
        message: { role: 'user', content: [{ type: 'text', text: 'Review in the background' }] },
      },
      {
        type: 'assistant',
        timestamp: timestamp(1),
        message: {
          role: 'assistant',
          id: 'launch',
          model: 'claude-opus-5-5',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'launch-child',
              name: 'Agent',
              input: { description: 'Review child', model: 'opus', run_in_background: true },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: timestamp(2),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'launch-child',
              content: 'Async agent launched successfully.\nagentId: child',
            },
          ],
        },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'child', description: 'Review child' },
      },
      {
        type: 'assistant',
        timestamp: timestamp(3),
        message: {
          role: 'assistant',
          id: 'waiting',
          model: 'claude-opus-5-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'The review runs in the background.' }],
        },
      },
      ...(running ? [] : completionNotice),
    ]),
  );
  fs.writeFileSync(
    path.join(childDirectory, 'agent-child.jsonl'),
    jsonLines([
      {
        type: 'user',
        isSidechain: true,
        timestamp: timestamp(2),
        cwd: 'C:/repo',
        message: { role: 'user', content: [{ type: 'text', text: 'Review the change' }] },
      },
      ...(nested ? grandchildLaunch : []),
      {
        type: 'assistant',
        isSidechain: true,
        timestamp: timestamp(59),
        cwd: 'C:/repo',
        effort: 'high',
        message: {
          role: 'assistant',
          id: 'child-answer',
          model: 'claude-opus-5-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Review complete.' }],
          usage: { input_tokens: 100_000, output_tokens: 16_000 },
        },
      },
    ]),
  );
  fs.writeFileSync(
    path.join(childDirectory, 'agent-child.meta.json'),
    JSON.stringify({
      agentType: 'general-purpose',
      toolUseId: metaToolUseId,
      requestShape: 'background',
      model: 'opus',
    }),
  );
  if (nested) {
    fs.writeFileSync(
      path.join(childDirectory, 'agent-grandchild.jsonl'),
      jsonLines([
        {
          type: 'user',
          isSidechain: true,
          timestamp: timestamp(5),
          cwd: 'C:/repo',
          message: { role: 'user', content: [{ type: 'text', text: 'Search the tests' }] },
        },
        {
          type: 'assistant',
          isSidechain: true,
          timestamp: timestamp(40),
          cwd: 'C:/repo',
          message: {
            role: 'assistant',
            id: 'grandchild-answer',
            model: 'claude-haiku-4-5',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Search complete.' }],
            usage: { input_tokens: 500_000, output_tokens: 4_000 },
          },
        },
      ]),
    );
    fs.writeFileSync(
      path.join(childDirectory, 'agent-grandchild.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'launch-grandchild', parentAgentId: 'child' }),
    );
  }
  const viewed = view === 'child' ? path.join(childDirectory, 'agent-child.jsonl') : parent;
  const worker = new ProgressiveWorker(source);
  try {
    const { mtimeMs, size } = revisionOf(fs.statSync(viewed, { bigint: true }));
    const result = await worker.run(
      {
        kind: 'window',
        input: {
          session:
            view === 'child'
              ? { agent: 'claude', file: viewed, sessionId: 'agent-child', mtimeMs, size, childTranscript: true }
              : { agent: 'claude', file: viewed, sessionId: 'parent', mtimeMs, size },
          folders: ['C:/repo'],
          children: [],
          claudeChildren: [],
          claudeChildReferences: [],
          maxTurns: 40,
          tailBytes: 1 << 20,
        },
      },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'window');
    const [turn] = result.value.read.turns;
    return { agent: turn.agents[0], row: toCard(turn, false, Date.parse(timestamp(120)), ['C:/repo']).agents[0] };
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('a Claude background child prices from its own meta file before discovery lists it', async () => {
  const { agent, row } = await undiscoveredBackgroundChild('launch-child');
  assert.equal(agent.spendFound, true, 'the child transcript was not found without a discovery reference');
  assert.match(row.figures[0]?.compactLabel ?? '', /^\$/, 'the row fell back to the notice token count');
  assert.equal(row.effort, 'high', 'the row lost the effort the child recorded');
});

test('a Claude child row names its own model when a nested subagent read more under another', async () => {
  const { agent, row } = await undiscoveredBackgroundChild('launch-child', { nested: true });
  assert.ok(
    agent.spend.some((part) => part.model === 'claude-haiku-4-5'),
    'the nested subagent spend did not reach the row',
  );
  assert.equal(row.model, 'opus-5-5', 'the row named a model only a nested subagent ran');
  assert.equal(row.effort, 'high');
});

test('a running Claude background child row names the model it ran beside its cost', async () => {
  const { agent, row } = await undiscoveredBackgroundChild('launch-child', { running: true });
  assert.equal(agent.status, 'running', 'the fixture child finished');
  assert.equal(agent.model, 'opus');
  assert.equal(row.model, 'opus-5-5', 'the running row named the Agent call alias');
  const [cost] = row.figures;
  assert.equal(cost?.compactLabel, '$0.72+');
  assert.match(cost?.detail ?? '', /Cost by usage · opus-5-5: \$0\.72/);
});

test('a Claude child viewed as its own session prices its nested launch from the shared meta folder', async () => {
  const { agent, row } = await undiscoveredBackgroundChild('launch-child', { nested: true, view: 'child' });
  assert.equal(agent.id, 'grandchild');
  assert.equal(agent.spendFound, true, 'the nested child transcript was not found without a discovery reference');
  assert.match(row.figures[0]?.compactLabel ?? '', /^\$/, 'the row fell back to the notice token count');
  assert.equal(row.model, 'haiku-4-5');
});

test('a Claude child meta file that names another launch attaches no spend', async () => {
  const { agent, row } = await undiscoveredBackgroundChild('another-launch');
  assert.equal(agent.spendFound, false, 'a meta file for another launch supplied this row its spend');
  assert.deepEqual(
    row.figures.map((figure) => figure.compactLabel),
    ['13m', '116k tokens'],
  );
  assert.equal(row.effort, null);
});

test('Claude child commits cross the worker boundary and refresh on retained pages and workspace changes', async () => {
  const directory = tempDir('panel-progressive-claude-commits-');
  const parent = path.join(directory, 'parent.jsonl');
  const childDirectory = path.join(directory, 'parent', 'subagents');
  const child = path.join(childDirectory, 'agent-child.jsonl');
  const tree = 'C:/worktrees/review-child';
  fs.mkdirSync(childDirectory, { recursive: true });
  fs.writeFileSync(
    parent,
    [
      {
        type: 'user',
        promptId: 'prompt',
        timestamp: timestamp(0),
        cwd: 'C:/repo',
        message: { role: 'user', content: [{ type: 'text', text: 'Delegate the fix' }] },
      },
      {
        type: 'assistant',
        timestamp: timestamp(1),
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 'launch-child', name: 'Agent', input: { description: 'Fix child' } }],
        },
      },
      {
        type: 'user',
        timestamp: timestamp(2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-child', content: 'done' }] },
        toolUseResult: { agentId: 'child', status: 'completed', totalToolUseCount: 2 },
      },
      {
        type: 'assistant',
        timestamp: timestamp(3),
        message: {
          role: 'assistant',
          id: 'answer',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Fixed.' }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const childRecords = (prompt: string, command: string, stdout: string, start: number) => [
    {
      type: 'user',
      isSidechain: true,
      timestamp: timestamp(start),
      cwd: tree,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    },
    {
      type: 'assistant',
      isSidechain: true,
      timestamp: timestamp(start + 1),
      cwd: tree,
      message: {
        role: 'assistant',
        id: `child-${start}`,
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: `commit-${start}`, name: 'Bash', input: { command } }],
      },
    },
    {
      type: 'user',
      isSidechain: true,
      timestamp: timestamp(start + 2),
      cwd: tree,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `commit-${start}`, content: stdout }] },
      toolUseResult: { stdout, stderr: '' },
    },
    {
      type: 'assistant',
      isSidechain: true,
      timestamp: timestamp(start + 3),
      cwd: tree,
      message: {
        role: 'assistant',
        id: `done-${start}`,
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Committed.' }],
      },
    },
  ];
  fs.writeFileSync(
    child,
    childRecords(
      'commit the fix',
      'git commit -am "child fix"',
      '[topic abc1234] Child fix\n 1 file changed, 2 insertions(+)',
      4,
    )
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const worker = new ProgressiveWorker(source);
  try {
    const parentStat = revisionOf(fs.statSync(parent, { bigint: true }));
    const input = {
      session: {
        agent: 'claude' as const,
        file: parent,
        sessionId: 'parent',
        mtimeMs: parentStat.mtimeMs,
        size: parentStat.size,
      },
      folders: [tree],
      children: [],
      claudeChildren: [],
      maxTurns: 40,
      tailBytes: 4096,
      claudeChildReferences: [
        {
          parentSessionId: 'parent',
          sessionId: 'child',
          file: child,
          toolUseIds: ['launch-child'],
        },
      ],
    } as ProgressiveInput;
    const first = await worker.run({ kind: 'window', input }, 1, new AbortController().signal);
    assert.ok(first?.value.kind === 'window');
    const attached = first.value.read.turns[0].agents[0];
    assert.equal(attached.childSessionId, undefined);
    assert.deepEqual(
      attached.commits?.map((commit) => [commit.sha, commit.place, commit.dir]),
      [['abc1234', null, tree]],
    );

    const movedWorkspace = await worker.run(
      {
        kind: 'retained',
        input: { ...input, folders: ['C:/repo'] },
        pages: [{ turns: first.value.read.turns, compactions: [], bytes: 1 }],
      },
      2,
      new AbortController().signal,
    );
    assert.ok(movedWorkspace?.value.kind === 'retained');
    assert.deepEqual(
      movedWorkspace.value.pages[0].turns[0].agents[0].commits?.map((commit) => [commit.sha, commit.place, commit.dir]),
      [['abc1234', { kind: 'named', dir: tree }, tree]],
      'a workspace-folder change kept commit placement from the unchanged child-file revision',
    );

    fs.appendFileSync(
      child,
      childRecords('commit quietly', 'git commit -q -am "quiet child"', '', 8)
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const retained = await worker.run(
      {
        kind: 'retained',
        input,
        pages: [{ turns: first.value.read.turns, compactions: [], bytes: 1 }],
      },
      3,
      new AbortController().signal,
    );
    assert.ok(retained?.value.kind === 'retained');
    assert.equal(retained.value.pages[0].turns[0].agents[0].commits?.length, 1);
    assert.equal(retained.value.pages[0].turns[0].agents[0].commitIntents?.length, 1);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const agent of ['claude', 'codex'] as const) {
  test(`a ${agent} parser snapshot survives the structured clone the worker boundary copies it with`, () => {
    const directory = tempDir('panel-progressive-clone-');
    const file = path.join(directory, 'session.jsonl');
    try {
      const records = [
        ...(agent === 'codex'
          ? [
              {
                type: 'session_meta',
                timestamp: timestamp(0),
                payload: { id: 'session', cwd: 'C:/repo', source: 'vscode' },
              },
            ]
          : []),
        ...Array.from({ length: 6 }, (_unused, index) => detailedTurn(agent, index + 1, index < 5)).flat(),
      ];
      fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      // Smaller than the transcript, so the resumed read has a tail floor above byte zero.
      const options = { tailBytes: 4096, maxTurns: 40 };
      const resume = (checkpoint?: ClaudeForwardCheckpoint | CodexForwardCheckpoint) =>
        agent === 'claude'
          ? readClaudeSessionIncremental(file, 'session', checkpoint as ClaudeForwardCheckpoint | undefined, options)
          : readCodexSessionIncremental(file, 'session', checkpoint as CodexForwardCheckpoint | undefined, options);
      const initial = resume();
      assert.ok(initial.checkpoint);
      fs.appendFileSync(
        file,
        detailedTurn(agent, 7, false)
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );
      const intact = resume(initial.checkpoint);
      const cloned = resume(throughStructuredClone(initial.checkpoint));
      assert.ok(cloned.checkpoint!.coveredFrom > 0);
      // Require hidden fields in the fixture before comparing their values.
      assert.ok(
        hiddenFieldsOf(intact.read!.turns).some((turn) =>
          JSON.stringify(turn).includes('more detail than one line holds'),
        ),
      );
      assert.deepEqual(
        cloned.read!.turns.map((turn) => turn.prompt),
        intact.read!.turns.map((turn) => turn.prompt),
      );
      assert.deepEqual(cloned.read, intact.read);
      assert.deepEqual(hiddenFieldsOf(cloned.read!.turns), hiddenFieldsOf(intact.read!.turns));
      assert.deepEqual(hiddenDescriptorsOf(cloned.read!.turns), hiddenDescriptorsOf(intact.read!.turns));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test(`${agent} first-rail metadata reads no turn-start enrichment bytes`, async () => {
    const directory = tempDir('panel-progressive-metadata-');
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(
      file,
      [
        ...opening(agent),
        ...Array.from({ length: 96 }, () => ({ type: 'ignored', content: 'x'.repeat(32 * 1024) })),
        activity(agent, 0),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const observedSource =
      `const observedFs = require('node:fs');
      const observedRead = observedFs.readSync; let observedBytes = 0;
      observedFs.readSync = function (...args) { const count = observedRead.apply(this,args); observedBytes += count; return count; };
      const observedPort = require('node:worker_threads').parentPort;
      const observedPost = observedPort.postMessage;
      observedPort.postMessage = function (message) { if (message.result) message.result.observedBytes = observedBytes; return observedPost.call(this,message); };` +
      source;
    const worker = new ProgressiveWorker(observedSource);
    try {
      const { size, mtimeMs } = revisionOf(fs.statSync(file, { bigint: true }));
      const session = { file, size, mtimeMs, agent, sessionId: 'session' };
      const result = await worker.run({ kind: 'metadata', session }, 1, new AbortController().signal);
      assert.ok(result?.value.kind === 'metadata');
      assert.equal(result.value.entry.starts, undefined);
      const observedBytes = (result as typeof result & { observedBytes: number }).observedBytes;
      assert.ok(observedBytes <= metadataReadBudget(session));
      if (agent === 'codex') {
        assert.equal(observedBytes, 1024 * 1024 + 256 * 1024);
        assert.equal(metadataReadBudget(session), observedBytes);
      }
      const starts = await worker.run({ kind: 'starts', session }, 1, new AbortController().signal);
      assert.ok(starts?.value.kind === 'starts');
      assert.equal(starts.value.starts.starts.length, 1);
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test(`${agent} dormant checkpoints skip a large excluded append before reducing its bounded tail`, async () => {
    const directory = tempDir('panel-progressive-dormant-');
    const file = path.join(directory, 'session.jsonl');
    const closed =
      agent === 'claude'
        ? {
            type: 'assistant',
            timestamp: timestamp(2),
            message: {
              role: 'assistant',
              id: 'answer',
              model: 'claude-opus-5',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'Finished' }],
            },
          }
        : { type: 'event_msg', timestamp: timestamp(2), payload: { type: 'task_complete', turn_id: 'prompt' } };
    fs.writeFileSync(file, [...opening(agent), closed].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const worker = new ProgressiveWorker(source);
    const input = (): ProgressiveInput => {
      const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
      return {
        session: { file, sessionId: 'session', agent, mtimeMs, size },
        folders: [],
        children: [],
        maxTurns: 40,
        tailBytes: 2048,
      };
    };
    try {
      const initial = await worker.run({ kind: 'window', input: input() }, 1, new AbortController().signal);
      assert.ok(initial?.value.kind === 'window');
      assert.equal(initial.value.read.turns[0].finished, true);
      fs.appendFileSync(
        file,
        JSON.stringify({ type: 'ignored', text: 'x'.repeat(32 * 1024) }) +
          '\n' +
          opening(agent)
            .map((record) => JSON.stringify(record).replaceAll('prompt', 'next'))
            .join('\n') +
          '\n',
      );
      const next = await worker.run(
        { kind: 'window', input: input(), checkpoint: initial.value.checkpoint },
        2,
        new AbortController().signal,
      );
      assert.ok(next?.value.kind === 'window');
      assert.ok(next.value.readBytes <= 2048);
      assert.equal(next.value.read.turns.length, 1);
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test.runIf(agent === 'claude')(
    'Claude dormant checkpoints recover the window selected in skipped bytes',
    async () => {
      const attachment = (modelId: string) => ({
        type: 'attachment',
        timestamp: timestamp(0),
        attachment: { type: 'model', identity: { modelId } },
      });
      const reply = (id: string) => ({
        type: 'assistant',
        timestamp: timestamp(2),
        message: {
          role: 'assistant',
          id,
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Finished' }],
        },
      });
      const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
      for (const [before, skipped] of [
        ['claude-opus-5[1m]', 'claude-opus-5'],
        ['claude-opus-5', 'claude-opus-5[1m]'],
      ]) {
        const directory = tempDir('panel-progressive-attachment-');
        const file = path.join(directory, 'session.jsonl');
        fs.writeFileSync(file, lines([attachment(before), ...opening(agent), reply('answer')]));
        const worker = new ProgressiveWorker(source);
        const input = (): ProgressiveInput => {
          const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
          return {
            session: { file, sessionId: 'session', agent, mtimeMs, size },
            folders: [],
            children: [],
            maxTurns: 40,
            tailBytes: 2048,
          };
        };
        try {
          const initial = await worker.run({ kind: 'window', input: input() }, 1, new AbortController().signal);
          assert.ok(initial?.value.kind === 'window');
          assert.equal(initial.value.read.turns[0].modelAttachment, before);
          const next = opening(agent).map((record) => JSON.parse(JSON.stringify(record).replaceAll('prompt', 'next')));
          fs.appendFileSync(
            file,
            lines([
              attachment(skipped),
              { type: 'ignored', text: 'x'.repeat(32 * 1024) },
              ...next,
              reply('next-answer'),
            ]),
          );
          const later = await worker.run(
            { kind: 'window', input: input(), checkpoint: initial.value.checkpoint },
            2,
            new AbortController().signal,
          );
          assert.ok(later?.value.kind === 'window');
          assert.ok(later.value.readBytes <= 2048);
          assert.deepEqual(
            later.value.read.turns.map((turn) => turn.modelAttachment),
            [skipped],
            `a skipped switch to ${skipped} kept ${before}`,
          );
        } finally {
          worker.stop();
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  );
  test.runIf(agent === 'claude')(
    'a rewrite between append validation and cold recovery publishes no mixed-revision window',
    async () => {
      const directory = tempDir('panel-progressive-recovery-race-');
      const file = path.join(directory, 'session.jsonl');
      const closed = {
        type: 'assistant',
        timestamp: timestamp(2),
        message: {
          role: 'assistant',
          id: 'answer',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Finished' }],
        },
      };
      fs.writeFileSync(file, [...opening(agent), closed].map((record) => JSON.stringify(record)).join('\n') + '\n');
      const input = (): ProgressiveInput => {
        const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
        return {
          session: { file, sessionId: 'session', agent, mtimeMs, size },
          folders: [],
          children: [],
          maxTurns: 40,
          tailBytes: 1024,
        };
      };
      const initialWorker = new ProgressiveWorker(source);
      try {
        const initial = await initialWorker.run({ kind: 'window', input: input() }, 1, new AbortController().signal);
        assert.ok(initial?.value.kind === 'window');
        fs.appendFileSync(file, JSON.stringify({ type: 'ignored', text: 'x'.repeat(32 * 1024) }) + '\n');
        const requested = input();
        const requestedIdentity = revisionOf(fs.statSync(file, { bigint: true }));
        const stable = await initialWorker.run(
          { kind: 'window', input: requested, checkpoint: initial.value.checkpoint },
          2,
          new AbortController().signal,
        );
        assert.ok(stable?.value.kind === 'window');
        assert.equal(stable.value.reset, true, 'the excluded append did not enter cold recovery');
        assert.deepEqual(stable.value.appendFrom, initial.revision, 'cold recovery lost its validated append revision');
        const replacement =
          [
            ...opening(agent).map((record) => ({ ...record, promptId: 'replacement' })),
            { ...closed, message: { ...closed.message, id: 'replacement-answer' } },
            { type: 'ignored', text: 'y'.repeat(64 * 1024) },
          ]
            .map((record) => JSON.stringify(record))
            .join('\n') + '\n';
        const seam = 'const tail = tailOf(session.file, tailBytes, true);';
        const racedSource = source.replace(
          seam,
          `require('node:fs').writeFileSync(session.file, ${JSON.stringify(replacement)}); ${seam}`,
        );
        assert.notEqual(racedSource, source, 'the worker bundle no longer exposes the recovery seam');
        const racingWorker = new ProgressiveWorker(racedSource);
        try {
          const result = await racingWorker.run(
            { kind: 'window', input: requested, checkpoint: initial.value.checkpoint },
            2,
            new AbortController().signal,
          );
          assert.equal(result?.value.kind, 'stale', 'a recovery read from a later rewrite was published');
          assert.equal('appendFrom' in (result?.value ?? {}), false, 'a stale result serialized append proof');
          const rewritten = revisionOf(fs.statSync(file, { bigint: true }));
          assert.ok(rewritten.size > requested.session.size, 'the rewrite did not grow the same file');
          assert.deepEqual(
            { dev: rewritten.dev, ino: rewritten.ino },
            { dev: requestedIdentity.dev, ino: requestedIdentity.ino },
            'the fixture replaced the file identity instead of rewriting it in place',
          );
        } finally {
          racingWorker.stop();
        }
      } finally {
        initialWorker.stop();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  test(`${agent} worker recovers a newest turn beyond its tail and retains its append checkpoint`, async () => {
    const directory = tempDir('panel-progressive-large-');
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(
      file,
      [
        ...opening(agent),
        ...Array.from({ length: 384 }, () => ({ type: 'ignored', content: 'x'.repeat(32 * 1024) })),
        activity(agent, 0),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const boundedSource =
      `const boundedFs = require('node:fs');
      const originalRead = boundedFs.readSync;
      boundedFs.readSync = function (fd, buffer, offset, length, position) {
        if (length > 256 * 1024) throw new Error('A transcript read exceeded 256 KiB.');
        return originalRead.call(this, fd, buffer, offset, length, position);
      };` + source;
    const worker = new ProgressiveWorker(boundedSource);
    let checkpoint: ProgressiveCheckpoint | undefined;
    try {
      for (let n = 0; n < 3; n++) {
        if (n) {
          fs.appendFileSync(file, JSON.stringify(activity(agent, n)) + '\n');
        }
        const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
        const input: ProgressiveInput = {
          session: { file, sessionId: 'session', agent, mtimeMs, size },
          folders: [],
          children: [],
          maxTurns: 40,
          tailBytes: 1024,
        };
        const result = await worker.run({ kind: 'window', input, checkpoint }, n, new AbortController().signal);
        assert.ok(result?.value.kind === 'window');
        assert.equal(result.value.read.turns.length, 1);
        assert.deepEqual(
          result.value.read.turns,
          agent === 'claude'
            ? readSession(file, 'session', { tailBytes: size }).turns
            : readCodexSession(file, 'session', { tailBytes: size }).turns,
        );
        if (checkpoint) {
          assert.equal(result.value.reset, false);
        }
        checkpoint = result.value.checkpoint;
      }
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test(`${agent} forward recovery observes cancellation between bounded chunks`, async () => {
    const directory = tempDir('panel-progressive-abort-');
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(
      file,
      [
        ...opening(agent),
        ...Array.from({ length: 384 }, () => ({ type: 'ignored', content: 'x'.repeat(32 * 1024) })),
        activity(agent, 0),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const controller = new AbortController();
    let slices = 0;
    try {
      const read = agent === 'claude' ? readClaudeSessionIncrementalAsync : readCodexSessionIncrementalAsync;
      const result = await read(
        file,
        'session',
        undefined,
        { tailBytes: fs.statSync(file).size },
        {
          signal: controller.signal,
          pause: async () => {
            if (++slices === 2) controller.abort();
          },
        },
      );
      assert.equal(result.kind, 'cancelled');
      assert.equal(slices, 2);
      assert.ok(result.readBytes <= 512 * 1024);
      assert.equal(result.checkpoint, null);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test(`${agent} worker resumes one open card across ten appends and matches its one-shot reader`, async () => {
    const directory = tempDir('panel-progressive-');
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(
      file,
      opening(agent)
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const worker = new ProgressiveWorker(source);
    let checkpoint: ProgressiveCheckpoint | undefined;
    try {
      for (let n = 0; n <= 10; n++) {
        if (n) {
          fs.appendFileSync(file, JSON.stringify(activity(agent, n)) + '\n');
        }
        const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
        const input: ProgressiveInput = {
          session: { file, sessionId: 'session', agent, mtimeMs, size },
          folders: [],
          children: [],
          maxTurns: 40,
          tailBytes: 4 * 1024 * 1024,
        };
        const result = await worker.run({ kind: 'window', input, checkpoint }, n, new AbortController().signal);
        assert.ok(result);
        assert.equal(acceptsProgressiveResult(result, n, input.session), true);
        assert.equal(result.value.kind, 'window');
        if (result.value.kind !== 'window') {
          throw new Error('The worker returned no window.');
        }
        assert.equal(result.value.read.turns.length, 1);
        assert.deepEqual(
          result.value.read,
          agent === 'claude'
            ? readSession(file, 'session', { maxTurns: 40, tailBytes: input.tailBytes })
            : readCodexSession(file, 'session', { maxTurns: 40, tailBytes: input.tailBytes }),
        );
        if (checkpoint) {
          assert.equal(result.value.reset, false);
          assert.equal(result.value.readBytes, size - checkpoint.appliedThrough);
        }
        checkpoint = result.value.checkpoint;
      }
      const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
      const input: ProgressiveInput = {
        session: { file, sessionId: 'session', agent, mtimeMs, size },
        folders: [],
        children: [],
        maxTurns: 40,
        tailBytes: 4 * 1024 * 1024,
      };
      const unchanged = await worker.run({ kind: 'window', input, checkpoint }, 11, new AbortController().signal);
      assert.ok(unchanged?.value.kind === 'window');
      assert.equal(unchanged.value.readBytes, 0);
      assert.equal(acceptsProgressiveResult(unchanged, 12, input.session), false);
      assert.equal(acceptsProgressiveResult(unchanged, 11, { size: size + 1, mtimeMs }), false);
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test(`${agent} unchanged window reads no transcript content or transcript records`, async () => {
    const directory = tempDir('panel-progressive-retained-window-');
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(
      file,
      [...opening(agent), activity(agent, 0)].map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const observedSource =
      `const observedFs = require('node:fs');
      const observedRead = observedFs.readSync;
      let transcriptReadCalls = 0;
      observedFs.readSync = function (...args) { transcriptReadCalls++; return observedRead.apply(this, args); };
      const observedParse = JSON.parse;
      let transcriptParseCalls = 0;
      JSON.parse = function (value, ...args) {
        if (typeof value === 'string' && value.includes('"timestamp"')) { transcriptParseCalls++; }
        return observedParse.call(this, value, ...args);
      };
      const observedPort = require('node:worker_threads').parentPort;
      const observedPost = observedPort.postMessage;
      observedPort.postMessage = function (message) {
        if (message.result) {
          message.result.transcriptReadCalls = transcriptReadCalls;
          message.result.transcriptParseCalls = transcriptParseCalls;
        }
        return observedPost.call(this, message);
      };` + source;
    const worker = new ProgressiveWorker(observedSource);
    try {
      const input = (): ProgressiveInput => {
        const { mtimeMs, size } = revisionOf(fs.statSync(file, { bigint: true }));
        return {
          session: { file, sessionId: 'session', agent, mtimeMs, size },
          folders: [],
          children: [],
          maxTurns: 40,
          tailBytes: 4096,
        };
      };
      const first = await worker.run({ kind: 'window', input: input() }, 1, new AbortController().signal);
      assert.ok(first?.value.kind === 'window');
      const retained = (await worker.run(
        { kind: 'window', input: input(), checkpoint: first.value.checkpoint },
        2,
        new AbortController().signal,
      )) as typeof first & { transcriptReadCalls: number; transcriptParseCalls: number };
      assert.ok(retained?.value.kind === 'window');
      assert.equal(retained.value.readBytes, 0);
      assert.equal(retained.transcriptReadCalls - (first as typeof retained).transcriptReadCalls, 0);
      assert.equal(retained.transcriptParseCalls - (first as typeof retained).transcriptParseCalls, 0);
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('a running identified Claude child does not make the worker read its transcript for effort', async () => {
  const directory = tempDir('panel-progressive-running-child-');
  const sessionId = 'parent';
  const childId = 'child-effort';
  const file = path.join(directory, 'parent.jsonl');
  const child = path.join(directory, sessionId, 'subagents', `agent-${childId}.jsonl`);
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, JSON.stringify({ type: 'assistant', effort: 'high' }) + '\n');
  fs.writeFileSync(
    file,
    jsonLines([
      {
        type: 'user',
        promptId: 'prompt',
        timestamp: timestamp(0),
        message: { role: 'user', content: [{ type: 'text', text: 'Keep this open' }] },
      },
      {
        type: 'assistant',
        timestamp: timestamp(1),
        message: {
          role: 'assistant',
          id: 'launch',
          model: 'claude-opus-5',
          content: [
            {
              type: 'tool_use',
              id: 'agent-call',
              name: 'Agent',
              input: { description: 'Inspect', subagent_type: 'Explore' },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: timestamp(2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'launched' }] },
        toolUseResult: { agentId: childId, description: 'Inspect', totalToolUseCount: 0, status: 'running' },
      },
    ]),
  );
  const guardedSource =
    `const observedFs = require('node:fs');
    const observedOpen = observedFs.openSync;
    let readRunningChild = false;
    observedFs.openSync = function (file, ...args) {
      if (file === ${JSON.stringify(child)}) {
        readRunningChild = true;
        throw new Error('The worker read a running child transcript.');
      }
      return observedOpen.call(this, file, ...args);
    };
    const observedPort = require('node:worker_threads').parentPort;
    const observedPost = observedPort.postMessage;
    observedPort.postMessage = function (message) {
      if (message.result) { message.result.readRunningChild = readRunningChild; }
      return observedPost.call(this, message);
    };` + source;
  const worker = new ProgressiveWorker(guardedSource);
  try {
    const { size, mtimeMs } = revisionOf(fs.statSync(file, { bigint: true }));
    const result = await worker.run(
      {
        kind: 'window',
        input: {
          session: { file, sessionId, agent: 'claude', size, mtimeMs },
          folders: [],
          children: [],
          maxTurns: 40,
          tailBytes: 4096,
        },
      },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'window');
    assert.deepEqual(
      result.value.read.turns[0].agents.map((agent) => ({ id: agent.id, status: agent.status, effort: agent.effort })),
      [{ id: childId, status: 'running', effort: null }],
    );
    assert.equal((result as typeof result & { readRunningChild: boolean }).readRunningChild, false);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deferred metadata recovers the warm cache from an oversized newest Claude turn', async () => {
  const directory = tempDir('panel-progressive-oversized-metadata-');
  const file = path.join(directory, 'session.jsonl');
  const requestAt = Date.parse(timestamp(2));
  const records = [
    ...opening('claude'),
    {
      type: 'assistant',
      timestamp: timestamp(2),
      message: {
        role: 'assistant',
        id: 'answer',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }],
        usage: {
          input_tokens: 20_000,
          cache_read_input_tokens: 10_000,
          cache_creation_input_tokens: 10_000,
          cache_creation: { ephemeral_1h_input_tokens: 10_000, ephemeral_5m_input_tokens: 0 },
          output_tokens: 1,
        },
      },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const worker = new ProgressiveWorker(source);
  try {
    const { size, mtimeMs } = revisionOf(fs.statSync(file, { bigint: true }));
    const session = { file, size, mtimeMs, agent: 'claude' as const, sessionId: 'session' };
    const bounded = await worker.run({ kind: 'metadata', session }, 1, new AbortController().signal);
    assert.ok(bounded?.value.kind === 'metadata');
    assert.equal(
      bounded.value.entry.stats,
      null,
      'the fixture no longer places the newest turn start outside the first metadata tail',
    );
    const recovered = await worker.run(
      {
        kind: 'metadata',
        session,
        tailBytes: RAIL_ENRICHMENT_READ_BYTES,
      },
      1,
      new AbortController().signal,
    );
    assert.ok(recovered?.value.kind === 'metadata');
    assert.ok(recovered.value.entry.stats);
    assert.ok(
      railCacheMarkOf(recovered.value.entry.stats, requestAt + 1),
      'the deferred bounded read did not recover the warm cache mark',
    );
    assert.ok(
      metadataReadBudget(session, RAIL_ENRICHMENT_READ_BYTES) <= RAIL_ENRICHMENT_READ_BYTES,
      'the Claude recovery read exceeded its bounded admission cost',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a Codex start without a prompt completes one expanded metadata pass per file revision', async () => {
  const directory = tempDir('panel-progressive-empty-codex-start-');
  const file = path.join(directory, 'session.jsonl');
  const records = [
    { type: 'session_meta', timestamp: timestamp(0), payload: { id: 'session', cwd: 'C:/repo', source: 'vscode' } },
    { type: 'event_msg', timestamp: timestamp(1), payload: { type: 'task_started', turn_id: 'empty' } },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const worker = new ProgressiveWorker(source);
  try {
    const revision = revisionOf(fs.statSync(file, { bigint: true }));
    const session = {
      file,
      sessionId: 'session',
      agent: 'codex' as const,
      mtimeMs: revision.mtimeMs,
      size: revision.size,
    };
    const bounded = await worker.run({ kind: 'metadata', session }, 1, new AbortController().signal);
    const starts = await worker.run({ kind: 'starts', session }, 1, new AbortController().signal);
    assert.ok(bounded?.value.kind === 'metadata');
    assert.ok(starts?.value.kind === 'starts');
    assert.equal(bounded.value.entry.stats, null);
    assert.equal(starts.value.starts.starts.length, 1);

    const firstPass = { ...bounded.value.entry, starts: starts.value.starts };
    assert.deepEqual(railEnrichmentNeeds(firstPass, session), { starts: false, metadata: true });
    const expanded = await worker.run(
      {
        kind: 'metadata',
        session,
        tailBytes: RAIL_ENRICHMENT_READ_BYTES,
      },
      1,
      new AbortController().signal,
    );
    assert.ok(expanded?.value.kind === 'metadata');
    assert.ok(expanded.value.coverage);
    const accepted = withMetadataCoverage(
      { ...expanded.value.entry, starts: starts.value.starts },
      expanded.value.coverage,
    );
    assert.equal(accepted.stats, null);
    assert.equal(
      railEnrichmentNeeds(accepted, session),
      null,
      'the next enrichment pass reread an unchanged revision after the expanded read found no turn',
    );

    fs.appendFileSync(file, JSON.stringify({ type: 'ignored' }) + '\n');
    const changedRevision = revisionOf(fs.statSync(file, { bigint: true }));
    const changedSession = { ...session, mtimeMs: changedRevision.mtimeMs, size: changedRevision.size };
    const refreshed = await worker.run({ kind: 'metadata', session: changedSession }, 2, new AbortController().signal);
    const changedStarts = await worker.run(
      { kind: 'starts', session: changedSession },
      2,
      new AbortController().signal,
    );
    assert.ok(refreshed?.value.kind === 'metadata');
    assert.ok(changedStarts?.value.kind === 'starts');
    assert.deepEqual(
      railEnrichmentNeeds({ ...refreshed.value.entry, starts: changedStarts.value.starts }, changedSession),
      {
        starts: false,
        metadata: true,
      },
      'a changed revision did not become eligible for another expanded read',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a replaced selection rejects the old generation without changing the accepted session', () => {
  const accepted = { session: 'newest', cards: ['current'] };
  let drawn = accepted;
  const result = {
    generation: 1,
    revision: { size: 20, mtimeMs: 30, dev: 1, ino: 2 },
    value: { kind: 'stale' as const },
  };
  if (acceptsProgressiveResult(result, 2, { size: 20, mtimeMs: 30 })) {
    drawn = { session: 'previous', cards: ['stale'] };
  }
  assert.equal(drawn, accepted);
});

test('a cancelled worker request settles and permits a replacement request', async () => {
  const worker = new ProgressiveWorker('require("node:worker_threads").parentPort.on("message", () => {});');
  const controller = new AbortController();
  const pending = worker.run(
    { kind: 'metadata', session: { file: 'unused', agent: 'claude', sessionId: 'old', size: 0, mtimeMs: 0 } },
    1,
    controller.signal,
  );
  controller.abort();
  assert.equal(await pending, null);
  worker.stop();
});

test('cancelling catalog work keeps a concurrent selected read and its worker alive', async () => {
  const worker = new ProgressiveWorker(`
    const { parentPort } = require('node:worker_threads');
    let selected = null;
    parentPort.on('message', (message) => {
      if (message.cancel !== undefined) {
        if (selected) parentPort.postMessage({ id: selected.id, result: {
          generation: selected.generation, revision: { size: 1, mtimeMs: 1, dev: 1, ino: 1 },
          value: { kind: 'stale' },
        } });
        return;
      }
      if (message.request.kind === 'window') {
        selected = message;
      }
    });
  `);
  const catalogController = new AbortController();
  const selectionController = new AbortController();
  const session = { file: 'unused', agent: 'claude' as const, sessionId: 'selected', size: 1, mtimeMs: 1 };
  const catalog = worker.run({ kind: 'metadata', session }, 1, catalogController.signal);
  const selection = worker.run(
    {
      kind: 'window',
      input: {
        session,
        folders: [],
        children: [],
        maxTurns: 40,
        tailBytes: 1024,
      },
    },
    7,
    selectionController.signal,
  );
  catalogController.abort();
  assert.equal(await catalog, null);
  const selected = await selection;
  assert.equal(selected?.generation, 7, 'catalog cancellation stopped the selected read');
  assert.equal(selected?.value.kind, 'stale');
  worker.stop();
});

test('a window that grows during its read returns stale at the current revision', async () => {
  const directory = tempDir('panel-progressive-window-growth-');
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(
    file,
    opening('claude')
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const requested = revisionOf(fs.statSync(file, { bigint: true }));
  const marker = source.match(/const after = revisionOf\d*\(file\);/)?.[0];
  assert.ok(marker);
  const grownSource = source.replace(
    marker,
    `require('node:fs').appendFileSync(file, JSON.stringify({ type: 'ignored', value: 'grown' }) + '\\n'); ${marker}`,
  );
  const worker = new ProgressiveWorker(grownSource);
  try {
    const input: ProgressiveInput = {
      session: {
        file,
        sessionId: 'session',
        agent: 'claude',
        size: requested.size,
        mtimeMs: requested.mtimeMs,
        dev: requested.dev,
        ino: requested.ino,
      },
      folders: [],
      children: [],
      maxTurns: 40,
      tailBytes: 1024,
    };
    const result = await worker.run({ kind: 'window', input }, 7, new AbortController().signal);
    assert.equal(result?.value.kind, 'stale');
    assert.ok(result.revision);
    assert.equal(
      sameProgressiveRevision(result.revision, requested),
      false,
      'the stale result kept the revision from before the mutation',
    );
    assert.equal(sameProgressiveRevision(result.revision, revisionOf(fs.statSync(file, { bigint: true }))), true);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('loaded history requires an exact revision or append proof from that revision', () => {
  const previous = { size: 10, mtimeMs: 10, dev: 1, ino: 2 };
  const result: ProgressiveResult = {
    generation: 1,
    revision: previous,
    value: {
      kind: 'window',
      read: { turns: [], compactions: [], readBytes: 0, turnLimitReached: false },
      checkpoint: {} as ProgressiveCheckpoint,
      reset: true,
      appendFrom: null,
      readBytes: 0,
      retainedBytes: 0,
      checkpointBytes: 0,
      agentKey: '',
      structuralKey: '',
    },
  };
  assert.equal(preservesLoadedHistory(previous, result), true);
  result.revision = { ...previous, size: 11, mtimeMs: 11 };
  assert.equal(preservesLoadedHistory(previous, result), false);
  if (result.value.kind !== 'window') {
    throw new Error('The fixture is not a window.');
  }
  result.value.appendFrom = previous;
  assert.equal(preservesLoadedHistory(previous, result), true);
  result.value.appendFrom = { ...previous, mtimeMs: 9 };
  assert.equal(preservesLoadedHistory(previous, result), false);
});

test('catalog metadata keeps the revision that supplied its facts and survives later growth', async () => {
  const directory = tempDir('panel-progressive-metadata-growth-');
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(
    file,
    opening('claude')
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const requested = revisionOf(fs.statSync(file, { bigint: true }));
  const beforeMarker = source.match(/const before = revisionOf\d*\(file\);/)?.[0];
  const afterMarker = source.match(/const after = revisionOf\d*\(file\);/)?.[0];
  assert.ok(beforeMarker);
  assert.ok(afterMarker);
  const append = `require('node:fs').appendFileSync(file, JSON.stringify({ type: 'ignored', value: 'grown' }) + '\\n');`;
  const grownSource = source
    .replace(beforeMarker, `${append} ${beforeMarker}`)
    .replace(afterMarker, `${append} ${afterMarker}`);
  const worker = new ProgressiveWorker(grownSource);
  try {
    const session = {
      file,
      sessionId: 'session',
      agent: 'claude' as const,
      size: requested.size,
      mtimeMs: requested.mtimeMs,
    };
    const result = await worker.run({ kind: 'metadata', session }, 9, new AbortController().signal);
    const current = revisionOf(fs.statSync(file, { bigint: true }));
    assert.ok(result?.value.kind === 'metadata');
    assert.ok(result.revision);
    assert.equal(
      result.revision.size < current.size,
      true,
      'metadata facts were labelled with bytes appended after the read',
    );
    assert.deepEqual(
      { size: result.value.entry.size, mtimeMs: result.value.entry.mtimeMs },
      { size: result.revision.size, mtimeMs: result.revision.mtimeMs },
      'metadata facts and their source revision disagree',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('shrinkage, replacement, and same-size rewrite make a completed window stale', async () => {
  const mutations = [
    ['shrinkage', `require('node:fs').truncateSync(file, Math.max(0, before.size - 1));`],
    [
      'replacement',
      `const replacementBytes = require('node:fs').readFileSync(file); require('node:fs').unlinkSync(file); require('node:fs').writeFileSync(file, replacementBytes);`,
    ],
    [
      'same-size rewrite',
      `const rewrittenBytes = require('node:fs').readFileSync(file); require('node:fs').writeFileSync(file, rewrittenBytes); require('node:fs').utimesSync(file, new Date(before.mtimeMs + 5000), new Date(before.mtimeMs + 5000));`,
    ],
  ] as const;
  const marker = source.match(/const after = revisionOf\d*\(file\);/)?.[0];
  assert.ok(marker);
  for (const [name, mutation] of mutations) {
    const directory = tempDir(`panel-progressive-window-${name.replaceAll(' ', '-')}-`);
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(
      file,
      opening('claude')
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const requested = revisionOf(fs.statSync(file, { bigint: true }));
    const worker: ProgressiveWorker = new ProgressiveWorker(source.replace(marker, `${mutation} ${marker}`));
    try {
      const input: ProgressiveInput = {
        session: {
          file,
          sessionId: 'session',
          agent: 'claude',
          size: requested.size,
          mtimeMs: requested.mtimeMs,
          dev: requested.dev,
          ino: requested.ino,
        },
        folders: [],
        children: [],
        maxTurns: 40,
        tailBytes: 1024,
      };
      const result: ProgressiveResult | null = await worker.run(
        { kind: 'window', input },
        8,
        new AbortController().signal,
      );
      assert.equal(result?.value.kind, 'stale', `${name} published a completed window`);
      assert.equal(
        result ? acceptsProgressiveResult(result, 8, requested) : false,
        false,
        `${name} retained the requested revision`,
      );
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

// A Claude print review has one originless prompt, Bash results beyond the metadata tail, a finished turn, and a stop summary.

function reviewRun(
  options: { prompt?: Record<string, unknown>; after?: object[]; middle?: object[]; hook?: boolean } = {},
): object[] {
  const calls = Array.from({ length: 40 }, (_unused, n) => [
    {
      type: 'assistant',
      timestamp: timestamp(n * 2 + 1),
      message: {
        role: 'assistant',
        id: `call-${n}`,
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `bash-${n}`, name: 'Bash', input: { command: `git show HEAD~${n}` } }],
      },
    },
    {
      type: 'user',
      timestamp: timestamp(n * 2 + 2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `bash-${n}`, content: `diff ${n} ${'x'.repeat(20 * 1024)}` }],
      },
    },
  ]);
  return [
    {
      type: 'user',
      promptId: 'review',
      timestamp: timestamp(0),
      promptSource: 'sdk',
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'text', text: 'Review the candidate commit and report' }] },
      ...options.prompt,
    },
    ...calls.slice(0, 20).flat(),
    ...(options.middle ?? []),
    ...calls.slice(20).flat(),
    {
      type: 'assistant',
      timestamp: timestamp(90),
      message: {
        role: 'assistant',
        id: 'report',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'No blocking findings.' }],
      },
    },
    ...(options.hook === false
      ? []
      : [{ type: 'system', subtype: 'stop_hook_summary', timestamp: timestamp(91), hookCount: 1 }]),
    ...(options.after ?? []),
  ];
}

const jsonLines = (records: object[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

// Every subagent record has isSidechain. Its first prompt names the SDK entrypoint, and Bash results extend beyond the metadata tail.

function subagentRun(): object[] {
  const calls = Array.from({ length: 40 }, (_unused, n) => [
    {
      type: 'assistant',
      isSidechain: true,
      timestamp: timestamp(n * 2 + 1),
      message: {
        role: 'assistant',
        id: `call-${n}`,
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `bash-${n}`, name: 'Bash', input: { command: `git show HEAD~${n}` } }],
      },
    },
    {
      type: 'user',
      isSidechain: true,
      timestamp: timestamp(n * 2 + 2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `bash-${n}`, content: `diff ${n} ${'x'.repeat(20 * 1024)}` }],
      },
    },
  ]);
  return [
    {
      type: 'user',
      isSidechain: true,
      promptId: 'subagent',
      timestamp: timestamp(0),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'text', text: 'Implement the fix' }] },
    },
    ...calls.flat(),
    {
      type: 'assistant',
      isSidechain: true,
      timestamp: timestamp(90),
      message: {
        role: 'assistant',
        id: 'report',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
      },
    },
  ];
}

// Sidechain-only records have no parent prompts. A large subagent transcript must retain its agent-run classification.

test('a large Claude subagent session files under Run by agents, not Today', async () => {
  const directory = tempDir('panel-progressive-subagent-run-');
  const worker = new ProgressiveWorker(source);
  try {
    const file = path.join(directory, 'agent-subagent.jsonl');
    fs.writeFileSync(file, jsonLines(subagentRun()));
    assert.ok(
      fs.statSync(file).size > CLAUDE_METADATA_TAIL_BYTES,
      'the fixture no longer exceeds the metadata tail the scan gates on',
    );
    const { size, mtimeMs } = revisionOf(fs.statSync(file, { bigint: true }));
    const session = {
      file,
      size,
      mtimeMs,
      agent: 'claude' as const,
      sessionId: 'child-1',
      childTranscript: true as const,
    };

    const metadata = await worker.run({ kind: 'metadata', session }, 1, new AbortController().signal);
    assert.ok(metadata?.value.kind === 'metadata');
    const entry = metadata.value.entry;
    assert.equal(entry.agentRun, true, 'the metadata read did not answer a child transcript as an agent run');

    const starts = await worker.run(
      { kind: 'starts', session, agentRunScan: entry.agentRunScan },
      1,
      new AbortController().signal,
    );
    assert.ok(starts?.value.kind === 'starts');
    assert.equal(
      starts.value.agentRunScan,
      undefined,
      'a child transcript asked for the whole-file agent-run scan it does not need',
    );

    const enriched = withRailEnrichment(entry, starts.value.starts, starts.value.agentRunScan);
    assert.equal(
      enriched.agentRun,
      true,
      'rail enrichment overwrote the agent-run answer for a large subagent session',
    );

    const now = new Date(2026, 0, 2).getTime();
    const { buckets } = railBuckets(
      [
        {
          at: now,
          pinnedTop: false,
          current: false,
          archived: false,
          agentRun: enriched.agentRun,
        },
      ],
      now,
    );
    assert.ok(
      buckets.some((bucket) => bucket.id === 'agent'),
      'the card is not filed under Run by agents',
    );
    assert.equal(
      buckets.some((bucket) => bucket.id === 'today'),
      false,
      'the card is also filed under Today',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Read metadata, resume its cursor, and enrich the session list entry in order.
async function railEntry(
  worker: ProgressiveWorker,
  file: string,
  previous?: DerivedTitleEntry,
): Promise<DerivedTitleEntry> {
  const { size, mtimeMs } = revisionOf(fs.statSync(file, { bigint: true }));
  const session = { file, size, mtimeMs, agent: 'claude' as const, sessionId: 'session' };
  const metadata = await worker.run({ kind: 'metadata', session }, 1, new AbortController().signal);
  assert.ok(metadata?.value.kind === 'metadata');
  const entry = carryAgentRunScan(previous, metadata.value.entry);
  const starts = await worker.run(
    { kind: 'starts', session, agentRunScan: entry.agentRunScan },
    1,
    new AbortController().signal,
  );
  assert.ok(starts?.value.kind === 'starts');
  return withRailEnrichment(entry, starts.value.starts, starts.value.agentRunScan);
}

test('a review run larger than the metadata tail files under Run by agents', async () => {
  const directory = tempDir('panel-progressive-agent-run-');
  const worker = new ProgressiveWorker(source);
  try {
    const write = (name: string, records: object[]) => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, jsonLines(records));
      return file;
    };
    const reported = write('reported.jsonl', reviewRun());
    assert.ok(fs.statSync(reported).size > 512 * 1024, 'the fixture no longer exceeds the metadata tail and head');
    const entry = await railEntry(worker, reported);
    assert.equal(entry.agentRun, true, 'the reported review run is filed under a day');
    const compacted = await railEntry(
      worker,
      write(
        'compacted.jsonl',
        reviewRun({ middle: [{ type: 'system', subtype: 'compact_boundary', timestamp: timestamp(41) }] }),
      ),
    );
    assert.equal(compacted.agentRun, true, 'a review run that compacted is filed under a day');
    const editor = (entrypoint: string) =>
      reviewRun({ prompt: { entrypoint, promptSource: undefined, version: '2.1.195' }, hook: false });
    assert.equal(
      (await railEntry(worker, write('sdk.jsonl', editor('sdk-cli')))).agentRun,
      true,
      'a large single-prompt run from an SDK caller is filed under a day',
    );

    const person: [string, string][] = [
      ['a large single-prompt editor session with no origin', write('editor.jsonl', editor('claude-vscode'))],
      ['a prompt with a human origin', write('human.jsonl', reviewRun({ prompt: { origin: { kind: 'human' } } }))],
      [
        'a local command record',
        write(
          'local.jsonl',
          reviewRun({ after: [{ type: 'system', subtype: 'local_command', timestamp: timestamp(92) }] }),
        ),
      ],
      [
        'an unknown system record',
        write(
          'unknown.jsonl',
          reviewRun({ after: [{ type: 'system', subtype: 'a_later_kind', timestamp: timestamp(92) }] }),
        ),
      ],
      // Place a human-origin prompt outside the SDK-only exception and outside the head and tail windows.

      [
        'a human-origin prompt outside the head and the tail',
        write(
          'middle.jsonl',
          reviewRun({
            middle: [
              {
                type: 'user',
                promptId: 'second',
                timestamp: timestamp(41),
                origin: { kind: 'human' },
                message: { role: 'user', content: [{ type: 'text', text: 'also check the docs' }] },
              },
            ],
          }),
        ),
      ],
    ];
    for (const [what, file] of person) {
      assert.equal((await railEntry(worker, file)).agentRun, false, `${what} was not read as a person`);
    }
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an agent-run scan whose transcript grew while it ran keeps its cursor', async () => {
  const directory = tempDir('panel-progressive-agent-run-grown-');
  const worker = new ProgressiveWorker(source);
  try {
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(file, jsonLines(reviewRun()));
    const revision = (stat: fs.Stats) => ({ size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
    const before = revision(fs.statSync(file));
    const session = {
      file,
      size: before.size,
      mtimeMs: before.mtimeMs,
      agent: 'claude' as const,
      sessionId: 'session',
    };
    const metadata = await worker.run({ kind: 'metadata', session }, 1, new AbortController().signal);
    assert.ok(metadata?.value.kind === 'metadata');
    const entry = metadata.value.entry;
    const scan = scanForAgentRun(file, before.size);

    // Claude Code appends a record while the scan runs, so the whole read comes back stale.
    fs.appendFileSync(file, jsonLines([{ type: 'system', subtype: 'turn_duration', timestamp: timestamp(93) }]));
    const grown = revision(fs.statSync(file));
    const kept = scanKeptThroughGrowth({ kind: 'starts', agentRunScan: scan }, before, grown);
    assert.deepEqual(kept, scan, 'a scan whose transcript only grew lost its cursor');
    // A Windows file id can exceed 2^53, where adding one leaves the number unchanged.
    assert.equal(
      scanKeptThroughGrowth({ kind: 'starts', agentRunScan: scan }, before, { ...grown, dev: grown.dev + 1 }),
      undefined,
      'a scan of a replaced transcript kept its cursor',
    );
    assert.equal(
      scanKeptThroughGrowth({ kind: 'starts', agentRunScan: scan }, before, { ...grown, size: before.size - 1 }),
      undefined,
      'a scan of a transcript that shrank kept its cursor',
    );
    const held = withAgentRunScanProgress(entry, scan);
    assert.ok(held);
    assert.equal(held.agentRun, entry.agentRun);
    assert.equal(held.starts, entry.starts);
    assert.equal(
      withAgentRunScanProgress(held, { ...scan, bytes: scan.bytes - 1 }),
      null,
      'an older scan moved a newer cursor back',
    );

    // Corrupt the first record so an accidental restart produces a different person classification.
    const text = fs.readFileSync(file, 'utf8');
    const firstLine = text.indexOf('\n');
    fs.writeFileSync(file, '#'.repeat(firstLine) + text.slice(firstLine));
    assert.equal(
      (await railEntry(worker, file, held)).agentRun,
      true,
      'the next pass read the transcript again from the start',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rail enrichment resumes after an append between starts and expanded metadata', async () => {
  const directory = tempDir('panel-progressive-agent-run-between-');
  const worker = new ProgressiveWorker(source);
  try {
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(file, jsonLines(reviewRun()));
    const before = revisionOf(fs.statSync(file, { bigint: true }));
    const session = {
      file,
      size: before.size,
      mtimeMs: before.mtimeMs,
      agent: 'claude' as const,
      sessionId: 'session',
    };
    const metadata = await worker.run({ kind: 'metadata', session }, 1, new AbortController().signal);
    assert.ok(metadata?.value.kind === 'metadata');
    const starts = await worker.run({ kind: 'starts', session }, 1, new AbortController().signal);
    assert.ok(starts?.value.kind === 'starts');
    const accepted = withRailEnrichment(metadata.value.entry, starts.value.starts, starts.value.agentRunScan);
    assert.equal(accepted.agentRunScan?.bytes, session.size);

    fs.appendFileSync(file, jsonLines([{ type: 'system', subtype: 'turn_duration', timestamp: timestamp(93) }]));
    const expanded = await worker.run(
      { kind: 'metadata', session, tailBytes: RAIL_ENRICHMENT_READ_BYTES },
      1,
      new AbortController().signal,
    );
    assert.ok(expanded);
    assert.equal(
      acceptsProgressiveResult(expanded, 2, fs.statSync(file)),
      false,
      'the fixture did not reject the metadata request after the intervening append',
    );

    const text = fs.readFileSync(file, 'utf8');
    const firstLine = text.indexOf('\n');
    fs.writeFileSync(
      file,
      '#'.repeat(firstLine) +
        text.slice(firstLine) +
        jsonLines([{ type: 'system', subtype: 'turn_duration', timestamp: timestamp(94) }]),
    );
    const resumed = scanForAgentRun(file, fs.statSync(file).size, accepted.agentRunScan);
    assert.equal(resumed.bytes > session.size, true);
    assert.equal(resumed.person, false, 'the next scan restarted at byte zero after metadata was rejected');
    assert.equal(
      scanForAgentRun(file, fs.statSync(file).size).person,
      true,
      'the fixture cannot distinguish a resumed scan from a whole-file scan',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the agent-run scan resumes from its stored cursor and stops reading a person', async () => {
  const directory = tempDir('panel-progressive-agent-run-resume-');
  const worker = new ProgressiveWorker(source);
  try {
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(file, jsonLines(reviewRun()));
    const cache = path.join(directory, 'cache.json');
    const first = await railEntry(worker, file);
    assert.equal(first.agentRun, true);
    const firstScan = first.agentRunScan;
    assert.ok(firstScan);
    saveDerivedCache(cache, [[file, first]]);
    const stored = loadDerivedCache(cache).titles.get(file);
    assert.deepEqual(stored?.agentRunScan, first.agentRunScan, 'the scan cursor does not survive the derived cache');

    // Corrupt the first record so an accidental restart produces a different person classification.
    const text = fs.readFileSync(file, 'utf8');
    const firstLine = text.indexOf('\n');
    fs.writeFileSync(
      file,
      '#'.repeat(firstLine) +
        text.slice(firstLine) +
        jsonLines([{ type: 'system', subtype: 'turn_duration', timestamp: timestamp(93) }]),
    );
    const appended = await railEntry(worker, file, stored);
    assert.equal(appended.agentRun, true, 'a run answer read more than the appended bytes');

    // An originless SDK prompt does not establish human activity. A queued follow-up does, because it records an attached reader's submission.

    fs.appendFileSync(
      file,
      jsonLines([
        {
          type: 'attachment',
          timestamp: timestamp(94),
          attachment: {
            type: 'queued_command',
            timestamp: timestamp(94),
            commandMode: 'prompt',
            prompt: [{ type: 'text', text: 'and the tests' }],
          },
        },
      ]),
    );
    const prompted = await railEntry(worker, file, appended);
    assert.equal(prompted.agentRun, false, 'a follow-up queued while the agent worked did not make it a person');
    assert.equal(prompted.agentRunScan?.person, true);
    const held = prompted.agentRunScan;
    assert.ok(held);
    assert.equal(
      scanForAgentRun(path.join(directory, 'missing.jsonl'), Number.MAX_SAFE_INTEGER, held),
      held,
      'a person answer read the file again',
    );

    // A file that shrank is read from the start.
    const shrunk = jsonLines(reviewRun()).slice(0, 300 * 1024);
    fs.writeFileSync(file, shrunk.slice(0, shrunk.lastIndexOf('\n') + 1));
    const { size } = revisionOf(fs.statSync(file, { bigint: true }));
    const rewritten = scanForAgentRun(file, size, { ...firstScan, bytes: size + 1 });
    assert.equal(rewritten.bytes, size);
    assert.equal(rewritten.prompts, 1);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a human-origin typed prompt appended after a stored run turns it into a final person', async () => {
  const directory = tempDir('panel-progressive-agent-run-human-append-');
  const worker = new ProgressiveWorker(source);
  try {
    const file = path.join(directory, 'session.jsonl');
    fs.writeFileSync(file, jsonLines(reviewRun()));
    const first = await railEntry(worker, file);
    assert.equal(first.agentRun, true);

    // A human-origin prompt changes the stored agent-run classification even after the initial scan.

    fs.appendFileSync(
      file,
      jsonLines([
        {
          type: 'user',
          promptId: 'second',
          timestamp: timestamp(93),
          entrypoint: 'sdk-cli',
          origin: { kind: 'human' },
          message: { role: 'user', content: [{ type: 'text', text: 'also check the docs' }] },
        },
      ]),
    );
    const appended = await railEntry(worker, file, first);
    assert.equal(
      appended.agentRun,
      false,
      'a human-origin prompt appended after a stored run was not read as a person',
    );
    assert.equal(
      appended.agentRunScan?.person,
      true,
      'the scan did not lock a human-origin prompt as a final person sign',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the metadata read names a Claude session by one first prompt as it grows past the tail window', async () => {
  const directory = tempDir('panel-progressive-session-name-');
  const file = path.join(directory, 'session.jsonl');
  const prompt = (text: string, at: number) => ({
    type: 'user',
    timestamp: timestamp(at),
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const answer = (at: number) => ({
    type: 'assistant',
    timestamp: timestamp(at),
    message: {
      role: 'assistant',
      id: `a${at}`,
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }],
    },
  });
  const append = (records: object[]) =>
    fs.appendFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const tailBytes = 4096;
  const worker = new ProgressiveWorker(source);
  const read = async () => {
    const { size, mtimeMs } = revisionOf(fs.statSync(file, { bigint: true }));
    const result = await worker.run(
      { kind: 'metadata', session: { file, size, mtimeMs, agent: 'claude', sessionId: 'session' }, tailBytes },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'metadata');
    return result.value.entry;
  };
  try {
    append([prompt('rename the rail rows', 0), answer(1)]);
    const small = await read();
    assert.deepEqual([small.label, small.nameSource, small.nameAt], ['rename the rail rows', 'prompt', 0]);
    assert.ok(small.headKey, 'a read of the whole file names its first record');
    for (let n = 1; n <= 30; n++) {
      append([prompt(`follow-up ${n} ${'x'.repeat(300)}`, n * 2), answer(n * 2 + 1)]);
    }
    assert.ok(fs.statSync(file).size > tailBytes, 'the fixture no longer grows past the tail window');
    const grown = await read();
    assert.deepEqual(
      [grown.label, grown.nameSource, grown.headKey],
      ['rename the rail rows', 'prompt', small.headKey],
      'a file larger than the tail reads its first prompt from the head',
    );
    const before = fs.statSync(file).size;
    append([{ type: 'ai-title', aiTitle: 'Rail row names', sessionId: 'session' }, prompt('more', 90), answer(91)]);
    const titled = await read();
    assert.deepEqual(
      [titled.label, titled.nameSource, titled.nameAt, titled.headKey],
      ['Rail row names', 'generated', before, small.headKey],
    );
    const parsed = readClaudeSessionIncremental(file, 'session', undefined, { tailBytes })?.read?.turns.at(-1);
    assert.equal(
      parsed?.sessionTitleAt,
      titled.nameAt,
      'the parse and the metadata read place one record at two offsets',
    );
    fs.writeFileSync(
      file,
      [prompt('another session', 0), answer(1)].map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    assert.notEqual((await read()).headKey, small.headKey, 'a replaced transcript keeps the first fingerprint');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// A parent at the reference limit retains its cached child links across restart without rereading the parent.

test('an orchestrator parent past the per-file reference limit stays cached across a restart', async () => {
  const directory = tempDir('panel-progressive-claude-dispatches-');
  const file = path.join(directory, 'parent.jsonl');
  const results = Math.floor(MAX_CLAUDE_CHILD_REFERENCES_PER_FILE / MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT) + 1;
  const records = Array.from({ length: results }, (_unused, result) => {
    const ids = Array.from(
      { length: MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT },
      (_id, at) =>
        `${(result * MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT + at).toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`,
    );
    const command = ids.map((_id, at) => `python dispatch.py --arc-dispatch ${at}.md`).join(' && ');
    const output = ids
      .map((id) => `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id })}`)
      .join('\n');
    return claudeDispatchTranscript(command, output, `dispatch-${result}`);
  }).flat();
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const parents = [{ agent: 'claude' as const, file, sessionId: 'parent', mtimeMs: stat.mtimeMs, size: stat.size }];
  const counted =
    `const countedFs = require('node:fs'); const countedOpen = countedFs.openSync;
    const countedRead = countedFs.readSync; const countedFiles = new Map(); let parentReads = 0;
    countedFs.openSync = function (file, ...args) { const fd = countedOpen.call(this, file, ...args);
      countedFiles.set(fd, String(file)); return fd; };
    countedFs.readSync = function (fd, ...args) { const count = countedRead.call(this, fd, ...args);
      if (count > 0 && String(countedFiles.get(fd)).endsWith('parent.jsonl')) parentReads++; return count; };
    const countedPort = require('node:worker_threads').parentPort;
    const countedPost = countedPort.postMessage;
    countedPort.postMessage = function (message) { if (message.result) Object.assign(message.result,
      { parentReads }); return countedPost.call(this, message); };` + source;
  const request = { kind: 'claude-children' as const, parents, repositoryRoots: [directory] };
  const worker = new ProgressiveWorker(counted);
  const restarted = new ProgressiveWorker(counted);
  try {
    let first: ProgressiveResult | null | undefined;
    for (let pass = 0; pass < 30; pass++) {
      first = await worker.run(request, pass, new AbortController().signal);
      if (first?.value.kind === 'claude-children') break;
    }
    assert.ok(first?.value.kind === 'claude-children');
    assert.ok((first as typeof first & { parentReads: number }).parentReads > 0, 'the first discovery read no parent');
    // The scan's own references, before the catalog resolves each dispatch to a file.
    const linked = (entries: typeof first.value.referenceEntries) => entries.map(([, entry]) => entry.references);
    assert.equal(
      linked(first.value.referenceEntries)[0]?.length,
      MAX_CLAUDE_CHILD_REFERENCES_PER_FILE,
      'the parent linked no dispatches',
    );
    const cacheFile = path.join(directory, 'cache.json');
    saveDerivedCache(cacheFile, [], first.value.referenceEntries);
    const restored = loadDerivedCache(cacheFile).claudeChildReferences;
    assert.equal(restored.size, 1, 'the derived session cache dropped the orchestrator parent');
    const again = await restarted.run({ ...request, referenceEntries: [...restored] }, 1, new AbortController().signal);
    assert.ok(again?.value.kind === 'claude-children');
    assert.equal((again as typeof again & { parentReads: number }).parentReads, 0, 'the restart read the parent again');
    assert.deepEqual(
      linked(again.value.referenceEntries),
      linked(first.value.referenceEntries),
      'the restart linked other children',
    );
  } finally {
    worker.stop();
    restarted.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex dispatched facts survive old parent caches, late catalog arrival and native descendant growth', async () => {
  const directory = tempDir('codex-dispatched-facts-');
  const childId = 'aaaaaaaa-1111-1111-1111-111111111111';
  const childFile = path.join(directory, `${childId}.jsonl`);
  const nativeFile = path.join(directory, 'native.jsonl');
  const parentFile = path.join(directory, 'parent.jsonl');
  fs.writeFileSync(
    parentFile,
    claudeDispatchTranscript(
      'python launch.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${childId}"}`,
    )
      .map((record) => JSON.stringify(record) + '\n')
      .join(''),
  );
  const records = (id: string, output: number) => [
    {
      type: 'session_meta',
      timestamp: timestamp(0),
      payload: { id, cwd: directory, source: 'exec', model_provider: 'openai' },
    },
    { type: 'event_msg', timestamp: timestamp(1), payload: { type: 'task_started', turn_id: id } },
    { type: 'turn_context', timestamp: timestamp(2), payload: { turn_id: id, model: 'gpt-6-sol' } },
    { type: 'event_msg', timestamp: timestamp(2), payload: { type: 'user_message', message: 'work' } },
    {
      type: 'event_msg',
      timestamp: timestamp(3),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output },
          total_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output },
          model_context_window: 258400,
        },
      },
    },
    { type: 'event_msg', timestamp: timestamp(4), payload: { type: 'task_complete', turn_id: id } },
  ];
  const write = (file: string, entries: unknown[]) =>
    fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  write(childFile, records(childId, 3));
  fs.utimesSync(childFile, 100, 100);
  const nativeRecords = records('native', 5);
  (nativeRecords[0].payload as any).parent_thread_id = childId;
  write(nativeFile, nativeRecords);
  fs.utimesSync(nativeFile, 100, 100);
  const session = (file: string, sessionId: string, agent: 'claude' | 'codex') => ({
    file,
    sessionId,
    agent,
    size: fs.statSync(file).size,
    mtimeMs: fs.statSync(file).mtimeMs,
  });
  const parent = session(parentFile, 'parent', 'claude');
  const child = session(childFile, childId, 'codex');
  const native = {
    file: nativeFile,
    threadId: 'native',
    parentThreadId: childId,
    agentPath: '/native',
    openedAt: 0,
    startedAt: 0,
    threadSource: 'subagent',
    backgroundReview: false,
  };
  let worker = new ProgressiveWorker(source);
  try {
    const request = {
      kind: 'claude-children' as const,
      parents: [parent],
      catalog: [parent],
      codexChildren: [native],
      repositoryRoots: [directory],
      referenceEntries: [
        [
          parentFile,
          {
            parserVersion: 12,
            source: 'claude' as const,
            complete: true,
            sessionId: 'parent',
            childTranscript: false,
            size: parent.size,
            mtimeMs: parent.mtimeMs,
            dev: fs.statSync(parentFile).dev,
            ino: fs.statSync(parentFile).ino,
            references: [],
          },
        ],
      ] as Array<[string, import('./derivedcache').ClaudeChildReferenceCacheEntry]>,
    };
    const missing = await worker.run(request, 1, new AbortController().signal);
    assert.ok(missing?.value.kind === 'claude-children');
    assert.deepEqual(missing.value.references, []);
    assert.equal(missing.value.referenceEntries[0][1].references.length, 1);
    const cache = path.join(directory, 'cache.json');
    saveDerivedCache(cache, [], missing.value.referenceEntries);
    worker.stop();
    worker = new ProgressiveWorker(source);
    const found = await worker.run(
      { ...request, catalog: [parent, child], referenceEntries: [...loadDerivedCache(cache).claudeChildReferences] },
      1,
      new AbortController().signal,
    );
    assert.ok(found?.value.kind === 'claude-children');
    const facts = found.value.dispatchFacts[0];
    assert.equal(facts.spend.found, true);
    assert.equal(
      facts.spend.models.reduce((sum, model) => sum + model.usage.output, 0),
      8,
    );
    assert.equal(facts.startedAt, Date.parse(timestamp(1)));
    assert.equal(facts.person, false);
    const changedNativeRecords = records('native', 9);
    (changedNativeRecords[0].payload as any).parent_thread_id = childId;
    write(nativeFile, changedNativeRecords);
    fs.utimesSync(nativeFile, 101, 101);
    const changed = await worker.run({ ...request, catalog: [parent, child] }, 1, new AbortController().signal);
    assert.ok(changed?.value.kind === 'claude-children');
    assert.equal(
      changed.value.dispatchFacts[0].spend.models.reduce((sum, model) => sum + model.usage.output, 0),
      12,
    );
    fs.appendFileSync(
      childFile,
      [
        { type: 'event_msg', timestamp: timestamp(5), payload: { type: 'task_started', turn_id: 'reader' } },
        { type: 'event_msg', timestamp: timestamp(6), payload: { type: 'user_message', message: 'please continue' } },
      ]
        .map((entry) => JSON.stringify(entry) + '\n')
        .join(''),
    );
    const person = await worker.run(
      { ...request, catalog: [parent, session(childFile, childId, 'codex')] },
      1,
      new AbortController().signal,
    );
    assert.ok(person?.value.kind === 'claude-children');
    assert.equal(person.value.dispatchFacts[0].person, false, 'a headless continuation retains agent ownership');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['claude', 'codex'] as const)(
  'recent completed Codex figures hydrate through bounded slices under a %s parent',
  async (agent) => {
    const directory = tempDir('codex-dispatch-completion-');
    const id = 'aaaaaaaa-1111-1111-1111-111111111111';
    const parentFile = path.join(directory, 'parent.jsonl');
    const childFile = path.join(directory, id + '.jsonl');
    const clock = path.join(directory, 'clock');
    const line = (type: string, second: number, payload: object) =>
      JSON.stringify({ type, timestamp: timestamp(second), payload }) + '\n';
    const receipt = `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${id}"}`;
    fs.writeFileSync(
      parentFile,
      agent === 'claude'
        ? claudeDispatchTranscript('python child.py --arc-dispatch', receipt)
            .map((r) => JSON.stringify(r) + '\n')
            .join('')
        : line('session_meta', 0, { id: 'parent', cwd: directory, source: 'cli' }) +
            line('event_msg', 1, { type: 'task_started', turn_id: 'launch' }) +
            line('turn_context', 2, { turn_id: 'launch' }) +
            line('event_msg', 2, { type: 'user_message', message: 'review' }) +
            line('event_msg', 3, {
              type: 'item_completed',
              item: {
                type: 'CommandExecution',
                id: 'launch',
                status: 'completed',
                exit_code: 0,
                parsed_cmd: [{ type: 'unknown', cmd: 'python child.py --arc-dispatch' }],
                stdout: receipt,
              },
            }) +
            line('event_msg', 4, { type: 'task_complete', turn_id: 'launch' }),
    );
    const records =
      line('session_meta', 0, { id, cwd: directory, source: 'exec', model_provider: 'openai' }) +
      line('event_msg', 1, { type: 'task_started', turn_id: 'work' }) +
      line('turn_context', 2, { turn_id: 'work', model: 'gpt-6.1-sol', effort: 'high' }) +
      line('event_msg', 2, { type: 'user_message', message: 'work' }) +
      line('response_item', 3, {
        type: 'function_call',
        call_id: 'tool',
        name: 'exec_command',
        arguments: '{"cmd":"echo ok"}',
      }) +
      line('event_msg', 3, { type: 'agent_message', message: 'x'.repeat(700 * 1024) }) +
      line('event_msg', 4, {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
          total_token_usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
          model_context_window: 258400,
        },
      });
    const end = line('event_msg', 5, { type: 'task_complete', turn_id: 'work' });
    fs.writeFileSync(childFile, records + end);
    const modified = fs.statSync(childFile).mtimeMs;
    fs.writeFileSync(clock, String(modified + 5 * 60_000));
    const counted = `const f = require('node:fs'); let whole = 0, forward = 0; const o = f.openSync, r = f.readSync; const files = new Map();
    f.openSync = function(p, ...a) { const fd = o.call(this,p,...a); files.set(fd,String(p)); return fd; };
    f.readSync = function(fd,b,off,len,pos) { if(files.get(fd) === ${JSON.stringify(childFile)}) { if(len > 262144) whole++; if(len === 262144) forward++; } return r.call(this,fd,b,off,len,pos); };
    const port = require('node:worker_threads').parentPort, post = port.postMessage; port.postMessage = function(m) { if(m.result) Object.assign(m.result,{whole,forward}); return post.call(this,m); };`;
    const workerSource =
      counted +
      source +
      `\nDate.now = () => Number(require('node:fs').readFileSync(${JSON.stringify(clock)}, 'utf8'));`;
    let worker = new ProgressiveWorker(workerSource);
    const session = (file: string, sessionId: string, agent: 'claude' | 'codex') => ({
      file,
      sessionId,
      agent,
      size: fs.statSync(file).size,
      mtimeMs: fs.statSync(file).mtimeMs,
    });
    const request = () => ({
      kind: 'claude-children' as const,
      parents: [session(parentFile, 'parent', agent)],
      catalog: [session(parentFile, 'parent', agent), session(childFile, id, 'codex')],
      repositoryRoots: [directory],
    });
    const read = async () => {
      const result = await worker.run(request(), 1, new AbortController().signal);
      assert.ok(result?.value.kind === 'claude-children');
      const counted = result as typeof result & { whole: number; forward: number };
      return { value: result.value, whole: counted.whole, forward: counted.forward };
    };
    try {
      const first = await read();
      assert.equal(first.value.dispatchFacts[0].spend.found, false);
      assert.equal(first.value.continuation, true);
      assert.equal(first.whole, 0);
      assert.equal(first.value.dispatchFacts[0].refreshAt, modified + 3_600_000);
      let result = first;
      for (let i = 0; i < 8 && result.value.continuation; i++) result = await read();
      const facts = result.value.dispatchFacts[0];
      assert.equal(facts.spend.found, true);
      assert.equal(facts.spend.models[0].model, 'gpt-6.1-sol');
      assert.equal(facts.spend.effort, 'high');
      assert.equal(facts.startedAt, Date.parse(timestamp(1)));
      assert.equal(facts.endedAt, Date.parse(timestamp(5)));
      assert.equal(facts.toolUses, 1);
      assert.equal(facts.refreshAt, null);
      assert.equal(facts.spend.models[0].usage.output, 3);
      assert.ok((estimateCost(facts.spend.models[0].usage, 'gpt-6.1-sol', 'openai') ?? 0) > 0);
      const again = await read();
      assert.equal(again.whole, result.whole);
      assert.equal(again.forward, result.forward);
      const replacement = path.join(directory, 'replacement.jsonl');
      fs.writeFileSync(replacement, records + end);
      fs.renameSync(replacement, childFile);
      result = await read();
      assert.equal(result.value.dispatchFacts[0].spend.found, false);
      assert.equal(result.value.continuation, true, 'direct large replacement continues from its reset cursor');
      for (let i = 0; i < 8 && result.value.continuation; i++) result = await read();
      assert.equal(result.value.dispatchFacts[0].spend.found, true, 'direct large replacement reaches completed EOF');
      // Append revokes the completed EOF even when its start lies outside the tail.
      fs.appendFileSync(childFile, line('event_msg', 6, { type: 'task_started', turn_id: 'next' }));
      result = await read();
      assert.equal(result.value.dispatchFacts[0].spend.found, false);
      assert.equal(result.whole, again.whole);
      // An unchanged unknown record hydrates once at its deadline.
      fs.writeFileSync(clock, String(fs.statSync(childFile).mtimeMs + 3_600_001));
      result = await read();
      assert.equal(result.value.dispatchFacts[0].spend.unfinished, true);
      assert.equal(result.value.dispatchFacts[0].spend.artifacts?.complete, false);
      const quiet = await read();
      assert.equal(quiet.whole, result.whole);
      worker.stop();
      worker = new ProgressiveWorker(workerSource);
      fs.writeFileSync(childFile, records + end);
      fs.writeFileSync(clock, String(fs.statSync(childFile).mtimeMs + 300_000));
      result = await read();
      assert.equal(result.value.dispatchFacts[0].spend.found, false);
      for (let i = 0; i < 8 && result.value.continuation; i++) result = await read();
      assert.equal(result.value.dispatchFacts[0].spend.found, true);
      const stableSize = fs.statSync(childFile).size;
      const changedAt = fs.statSync(childFile).mtimeMs + 10;
      fs.writeFileSync(
        childFile,
        (records + end).replace('"type":"task_complete","turn_id":"work"', '"type":"task_complete","turn_id":"evil"'),
      );
      fs.utimesSync(childFile, changedAt / 1000, changedAt / 1000);
      assert.equal(fs.statSync(childFile).size, stableSize);
      result = await read();
      for (let i = 0; i < 8 && result.value.continuation; i++) result = await read();
      assert.equal(result.value.dispatchFacts[0].spend.found, false, 'same-size rewrites reset completion');
      fs.writeFileSync(childFile, records.slice(0, records.indexOf('\n') + 1));
      result = await read();
      assert.equal(result.value.dispatchFacts[0].spend.found, false, 'shrink resets completion');
      fs.unlinkSync(childFile);
      fs.writeFileSync(childFile, records + end);
      result = await read();
      for (let i = 0; i < 8 && result.value.continuation; i++) result = await read();
      assert.equal(result.value.dispatchFacts[0].spend.found, true, 'replacement rebuilds completion');
    } finally {
      worker.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('rejected dispatch terminals keep whole spend unread until quiet and source changes reject publication', async () => {
  const directory = tempDir('dispatch-rejected-completion-');
  const id = 'aaaaaaaa-1111-1111-1111-111111111111';
  const parentFile = path.join(directory, 'parent.jsonl'),
    childFile = path.join(directory, id + '.jsonl');
  const clock = path.join(directory, 'clock'),
    mutate = path.join(directory, 'mutate');
  const record = (type: string, second: number, payload: object) =>
    JSON.stringify({ type, timestamp: timestamp(second), payload }) + '\n';
  const event = (type: string, second: number, extra: object = {}) => record('event_msg', second, { type, ...extra });
  const opening = record('session_meta', 0, { id, cwd: directory, source: 'exec' });
  const start = event('task_started', 1, { turn_id: 'work' }),
    end = event('task_complete', 4, { turn_id: 'work' });
  fs.writeFileSync(
    parentFile,
    claudeDispatchTranscript(
      'python child.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${id}"}`,
    )
      .map((r) => JSON.stringify(r) + '\n')
      .join(''),
  );
  const declaration = source.indexOf('function readCodexDispatchedSpend(');
  assert.ok(declaration >= 0);
  const body = source.indexOf('{', declaration);
  const instrumented =
    source.slice(0, body + 1) +
    `\nwholeSpend++; if (f.existsSync(${JSON.stringify(mutate)}) && f.readFileSync(${JSON.stringify(mutate)}, 'utf8') === 'hydrate') f.appendFileSync(${JSON.stringify(childFile)}, ' ');\n` +
    source.slice(body + 1);
  const prefix = `const f = require('node:fs'); let wholeSpend = 0; const read = f.readSync, open = f.openSync; const files = new Map();
    f.openSync = function(p,...a) { const fd = open.call(this,p,...a); files.set(fd,String(p)); return fd; };
    f.readSync = function(fd,...a) { const n = read.call(this,fd,...a); if (files.get(fd) === ${JSON.stringify(childFile)} && a[2] === 262144 && f.existsSync(${JSON.stringify(mutate)})) f.appendFileSync(${JSON.stringify(childFile)}, ' '); return n; };
    const port = require('node:worker_threads').parentPort, post = port.postMessage;
    port.postMessage = function(m) { if(m.result) m.result.wholeSpend = wholeSpend; return post.call(this,m); };`;
  const workerSource =
    prefix + instrumented + `\nDate.now = () => Number(f.readFileSync(${JSON.stringify(clock)}, 'utf8'));`;
  const session = (file: string, sessionId: string) => ({
    file,
    sessionId,
    agent: file === childFile ? ('codex' as const) : ('claude' as const),
    size: fs.statSync(file).size,
    mtimeMs: fs.statSync(file).mtimeMs,
  });
  const cases = [
    opening + end,
    opening + start + event('task_complete', 4, { turn_id: 'other' }),
    opening + start + start + end,
    opening + start + end + event('user_message', 5, { message: 'more' }),
    opening + start + end + event('token_count', 5),
    opening + start + end + record('turn_context', 5, { turn_id: 'work' }),
    opening + event('task_started', 1, { turn_id: 'work', started_at: Date.parse(timestamp(-100)) }) + end,
    opening + start + record('turn_context', 2, { turn_id: 'work', current_date: '2025-12-01' }) + end,
    record('session_meta', 0, { id: 'foreign' }) + start + end,
    opening + record('session_meta', 0, { id: 'foreign' }) + start + end,
    opening + start + record('session_meta', 2, { id: 'foreign' }) + record('session_meta', 3, { id }) + end,
    opening + JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'work' } }) + '\n' + end,
    opening + start + end + '{',
    opening + start + 'broken\n' + end,
    opening + start + end + 'null\n' + event('task_started', 5, { turn_id: 'next' }),
    opening + start + 'x'.repeat(1024 * 1024 + 1) + '\n' + end,
    opening +
      Array.from({ length: 65 }, (_, i) => event('task_started', 1, { turn_id: String(i) })).join('') +
      event('task_complete', 4, { turn_id: '64' }),
  ];
  try {
    for (const bytes of cases) {
      fs.writeFileSync(childFile, bytes);
      fs.writeFileSync(clock, String(fs.statSync(childFile).mtimeMs + 300_000));
      const worker = new ProgressiveWorker(workerSource);
      const request = () => ({
        kind: 'claude-children' as const,
        parents: [session(parentFile, 'parent')],
        catalog: [session(parentFile, 'parent'), session(childFile, id)],
        repositoryRoots: [directory],
      });
      try {
        let result;
        for (let i = 0; i < 10; i++) {
          result = await worker.run(request(), 1, new AbortController().signal);
          assert.ok(result?.value.kind === 'claude-children');
          if (!result.value.continuation) break;
        }
        assert.ok(result?.value.kind === 'claude-children');
        assert.equal(result.value.dispatchFacts[0].spend.found, false);
        assert.equal((result as typeof result & { wholeSpend: number }).wholeSpend, 0);
      } finally {
        worker.stop();
      }
    }
    for (const change of ['scan', 'hydrate']) {
      fs.writeFileSync(
        childFile,
        opening +
          start +
          (change === 'scan' ? event('agent_message', 2, { message: 'x'.repeat(300 * 1024) }) : '') +
          end,
      );
      fs.writeFileSync(clock, String(fs.statSync(childFile).mtimeMs + 300_000));
      fs.writeFileSync(mutate, change);
      const worker = new ProgressiveWorker(workerSource);
      try {
        const result = await worker.run(
          {
            kind: 'claude-children',
            parents: [session(parentFile, 'parent')],
            catalog: [session(parentFile, 'parent'), session(childFile, id)],
            repositoryRoots: [directory],
          },
          1,
          new AbortController().signal,
        );
        assert.ok(result?.value.kind === 'claude-children', change);
        assert.equal(result.value.references.length, 1, 'dispatch growth removed launch ownership');
        assert.equal(result.value.dispatchFacts[0].spend.partial, true, 'dispatch growth claimed complete spend');
        assert.equal(result.value.continuation, true, 'dispatch growth lost its retry');
      } finally {
        worker.stop();
        fs.unlinkSync(mutate);
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['large-opening', 'copied-before', 'copied-after'])(
  'an opening-only dispatched Codex child retains launch ownership across delayed prompts and copied turns (%s)',
  async (shape) => {
    const directory = tempDir('codex-delayed-launch-person-');
    const id = 'aaaaaaaa-1111-1111-1111-111111111111';
    const parentFile = path.join(directory, 'parent.jsonl');
    const childFile = path.join(directory, id + '.jsonl');
    const clock = path.join(directory, 'clock');
    const record = (type: string, second: number, payload: object) =>
      JSON.stringify({ type, timestamp: timestamp(second), payload }) + '\n';
    fs.writeFileSync(clock, String(Date.parse(timestamp(10))));
    fs.writeFileSync(
      parentFile,
      claudeDispatchTranscript(
        'python launch.py --arc-dispatch',
        `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${id}"}`,
      )
        .map((record) => JSON.stringify(record) + '\n')
        .join(''),
    );
    fs.writeFileSync(
      childFile,
      record('session_meta', 0, { id, cwd: directory, source: shape === 'large-opening' ? 'exec' : 'cli' }) +
        (shape === 'large-opening' ? record('turn_context', 0, { instructions: 'x'.repeat(300 * 1024) }) : '') +
        (shape === 'copied-before'
          ? record('event_msg', 0, { type: 'task_started', turn_id: 'dated-copy' }) +
            record('event_msg', 0, { type: 'user_message', message: 'copied prompt' }) +
            record('event_msg', 0, { type: 'task_complete', turn_id: 'dated-copy' })
          : '') +
        record('event_msg', 1, { type: 'task_started', turn_id: 'launch' }),
    );
    const session = (file: string, sessionId: string, agent: 'claude' | 'codex') => ({
      file,
      sessionId,
      agent,
      size: fs.statSync(file).size,
      mtimeMs: fs.statSync(file).mtimeMs,
    });
    const parent = session(parentFile, 'parent', 'claude');
    const worker = new ProgressiveWorker(
      source + `\nDate.now = () => Number(require('node:fs').readFileSync(${JSON.stringify(clock)}, 'utf8'));`,
    );
    const person = async () => {
      const result = await worker.run(
        {
          kind: 'claude-children',
          parents: [parent],
          catalog: [parent, session(childFile, id, 'codex')],
          repositoryRoots: [directory],
        },
        1,
        new AbortController().signal,
      );
      assert.ok(result?.value.kind === 'claude-children');
      return result.value.dispatchFacts[0].person;
    };
    try {
      assert.equal(await person(), false);
      fs.appendFileSync(
        childFile,
        record('event_msg', 2, { type: 'user_message', message: 'work' }) +
          record('response_item', 2, {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'work' }],
          }),
      );
      if (shape === 'copied-before') {
        fs.appendFileSync(childFile, record('turn_context', 2, { turn_id: 'dated-copy', current_date: '2025-12-30' }));
      }
      if (shape === 'copied-after') {
        fs.appendFileSync(
          childFile,
          record('event_msg', 2, { type: 'task_started', turn_id: 'dated-copy' }) +
            record('event_msg', 2, { type: 'user_message', message: 'copied prompt' }) +
            record('event_msg', 2, { type: 'task_complete', turn_id: 'dated-copy' }) +
            record('event_msg', 2, { type: 'task_started', turn_id: 'next' }),
        );
        assert.equal(await person(), true, 'unclassified prompts await their dated context');
        fs.appendFileSync(childFile, record('turn_context', 2, { turn_id: 'dated-copy', current_date: '2025-12-30' }));
      }
      assert.equal(await person(), false, shape + ': the delayed launch and its duplicate are unattended');
      assert.equal(await person(), false, 'unchanged active rereads preserve ownership');
      fs.appendFileSync(
        childFile,
        record('event_msg', 3, { type: 'task_started', turn_id: 'launch' }) +
          record('event_msg', 4, { type: 'user_message', message: 'copied work' }),
      );
      assert.equal(await person(), false, 'a repeated turn stays copied');
      fs.writeFileSync(clock, String(Date.parse(timestamp(600))));
      fs.utimesSync(childFile, 100, 100);
      assert.equal(await person(), false, 'quiet ownership agrees with active ownership');
      fs.appendFileSync(
        childFile,
        record('event_msg', 601, { type: 'task_started', turn_id: 'reader' }) +
          record('event_msg', 602, { type: 'user_message', message: 'please continue' }),
      );
      fs.writeFileSync(clock, String(Date.parse(timestamp(603))));
      assert.equal(await person(), shape !== 'large-opening');
    } finally {
      worker.stop();
    }
  },
);

test('quiet dispatched Codex roots throttle open native descendants and refresh settled exact figures', async () => {
  const directory = tempDir('codex-dispatched-open-native-');
  const id = 'aaaaaaaa-1111-1111-1111-111111111111';
  const parentFile = path.join(directory, 'parent.jsonl');
  const childFile = path.join(directory, id + '.jsonl');
  const nativeFile = path.join(directory, 'native.jsonl');
  const clock = path.join(directory, 'clock');
  const reads = path.join(directory, 'reads');
  const record = (type: string, second: number, payload: object) =>
    JSON.stringify({ type, timestamp: timestamp(second), payload }) + '\n';
  const usage = (output: number) =>
    record('event_msg', 3, {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 10, output_tokens: output },
        total_token_usage: { input_tokens: 10, output_tokens: output },
      },
    });
  fs.writeFileSync(
    parentFile,
    claudeDispatchTranscript(
      'python launch.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${id}"}`,
    )
      .map((record) => JSON.stringify(record) + '\n')
      .join(''),
  );
  fs.writeFileSync(
    childFile,
    record('session_meta', 0, { id, cwd: directory, source: 'exec' }) +
      record('event_msg', 1, { type: 'task_started', turn_id: 'root' }) +
      record('response_item', 2, { type: 'function_call', name: 'spawn_agent', call_id: 'spawn', arguments: '{}' }) +
      record('response_item', 3, {
        type: 'function_call_output',
        call_id: 'spawn',
        output: JSON.stringify({ agent_id: 'native', nickname: 'native' }),
      }) +
      record('event_msg', 4, { type: 'task_complete', turn_id: 'root', last_agent_message: 'done' }),
  );
  fs.writeFileSync(
    nativeFile,
    record('session_meta', 1, { id: 'native', cwd: directory, source: 'exec' }) +
      record('event_msg', 2, { type: 'task_started', turn_id: 'native-turn' }) +
      record('turn_context', 2, { turn_id: 'native-turn', model: 'gpt-6-sol' }) +
      usage(1),
  );
  const epoch = Date.parse(timestamp(0));
  fs.utimesSync(childFile, epoch / 1000 + 90, epoch / 1000 + 90);
  fs.utimesSync(nativeFile, epoch / 1000 + 7200, epoch / 1000 + 7200);
  fs.writeFileSync(clock, String(epoch + 7200000));
  const session = (file: string, sessionId: string, agent: 'claude' | 'codex') => ({
    file,
    sessionId,
    agent,
    size: fs.statSync(file).size,
    mtimeMs: fs.statSync(file).mtimeMs,
  });
  const parent = session(parentFile, 'parent', 'claude');
  const native = {
    file: nativeFile,
    threadId: 'native',
    parentThreadId: null,
    agentPath: '/root/native',
    openedAt: 0,
    startedAt: 0,
    threadSource: 'subagent',
    backgroundReview: false,
  };
  const nativeInode = fs.statSync(nativeFile).ino;
  const instrument = `\nconst fsCount = require('node:fs'); const readCount = fsCount.readSync; fsCount.readSync = function(fd, buffer, ...args) { const result = readCount.call(this, fd, buffer, ...args); if (fsCount.fstatSync(fd).ino === ${nativeInode}) fsCount.appendFileSync(${JSON.stringify(reads)}, 'read\\n'); return result; }; Date.now = () => Number(fsCount.readFileSync(${JSON.stringify(clock)}, 'utf8'));`;

  const worker = new ProgressiveWorker(instrument + source);
  const facts = async () => {
    const result = await worker.run(
      {
        kind: 'claude-children',
        parents: [parent],
        catalog: [parent, session(childFile, id, 'codex')],
        codexChildren: [native],
        repositoryRoots: [directory],
      },
      1,
      new AbortController().signal,
    );
    assert.ok(result?.value.kind === 'claude-children');
    return result.value.dispatchFacts[0].spend;
  };
  const count = () => (fs.existsSync(reads) ? fs.readFileSync(reads, 'utf8').trim().split('\n').length : 0);
  try {
    const open = await facts();
    assert.equal(open.partial, true, JSON.stringify(open));
    assert.equal(open.artifacts?.complete, false);
    const firstReads = count();
    assert.ok(firstReads > 0);
    for (let index = 1; index <= 3; index++) {
      fs.appendFileSync(nativeFile, usage(index + 1));
      fs.utimesSync(nativeFile, epoch / 1000 + 7200 + index / 10, epoch / 1000 + 7200 + index / 10);
      fs.writeFileSync(clock, String(epoch + 7200000 + index * 100));
      const held = await facts();
      assert.equal(held.partial, true);
      assert.equal(held.artifacts?.complete, false);
    }
    assert.equal(count(), firstReads, 'growing descendants were parsed again inside one band');
    fs.appendFileSync(nativeFile, record('event_msg', 5, { type: 'task_complete', turn_id: 'native-turn' }));
    fs.utimesSync(nativeFile, epoch / 1000 + 7200.4, epoch / 1000 + 7200.4);
    fs.writeFileSync(clock, String(epoch + 7206000));
    const settled = await facts();
    assert.equal(settled.partial, true, 'missing ancestry remains uncertain after completion');
    assert.equal(settled.artifacts?.complete, false, JSON.stringify(settled));
    assert.equal(
      settled.models.reduce((sum, model) => sum + model.usage.output, 0),
      10,
    );
    assert.ok(count() > firstReads);
  } finally {
    worker.stop();
  }
});

test('attachment recovery resumes budgeted cursors and caches positive and negative boundaries', async () => {
  const directory = tempDir('attachment-recovery-');
  const file = path.join(directory, 'session.jsonl');
  const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const attachment = (identity: string) => ({
    type: 'attachment',
    attachment: { type: 'model', identity: { modelId: identity } },
  });
  const prompt = (name: string, at: number) => ({
    type: 'user',
    timestamp: timestamp(at),
    message: { role: 'user', content: name },
  });
  const reply = (name: string, at: number) => ({
    type: 'assistant',
    effort: 'high',
    timestamp: timestamp(at),
    message: {
      role: 'assistant',
      id: `msg_bdrk_${name}`,
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: name }],
      usage: { input_tokens: 100, output_tokens: 10 },
    },
  });
  const filler = lines(Array.from({ length: 160 }, () => ({ type: 'ignored', text: 'x'.repeat(16384) })));
  try {
    for (const identity of ['us-gov.anthropic.claude-opus-5-5[1m]', 'global.anthropic.claude-opus-5-5[1m]', null]) {
      fs.writeFileSync(
        file,
        (identity ? lines([attachment(identity)]) : '') + filler + lines([prompt('Go', 1), reply('Done', 2)]),
      );
      const options = { tailBytes: 2048, maxTurns: 40 };
      let result = await readClaudeSessionIncrementalAsync(file, 'session', undefined, options, {
        attachmentBudget: { maxBytes: 32768, maxMilliseconds: Infinity },
      });
      assert.ok(result.read && result.checkpoint);
      assert.equal(result.readBytes, 2048);
      assert.equal(result.recoveryPending, true);
      const pending = throughStructuredClone(result.checkpoint) as ClaudeForwardCheckpoint;
      assert.equal(pending.attachmentRecovery?.status, 'pending');
      const cancelled = new AbortController();
      cancelled.abort();
      const abandoned = await readClaudeSessionIncrementalAsync(file, 'session', pending, options, {
        signal: cancelled.signal,
      });
      assert.equal(abandoned.kind, 'cancelled');
      const supplied = readClaudeSessionIncremental(file, 'session', undefined, {
        ...options,
        recoveredModelAttachment: identity,
      });
      assert.equal(supplied.read?.turns[0].modelAttachment ?? null, identity);
      assert.deepEqual(supplied.read?.turns[0].usageParts, result.read.turns[0].usageParts);
      const initialUsageParts = structuredClone(result.read.turns[0].usageParts);
      const initialCost = turnCost(result.read.turns[0]);
      let recoveryBytes = result.recoveryBytes ?? 0;
      const deadline = Date.now() + 10000;
      while (result.recoveryPending && Date.now() < deadline) {
        result = await readClaudeSessionIncrementalAsync(
          file,
          'session',
          throughStructuredClone(result.checkpoint!),
          options,
          { attachmentBudget: { maxBytes: 32768, maxMilliseconds: Infinity } },
        );
        assert.ok((result.recoveryBytes ?? 0) <= 32768);
        recoveryBytes += result.recoveryBytes ?? 0;
      }
      assert.equal(result.recoveryPending, false);
      assert.ok(result.read && result.checkpoint);
      assert.equal(result.read.turns[0].modelAttachment ?? null, identity);
      assert.deepEqual(result.read.turns[0].usageParts, initialUsageParts);
      assert.deepEqual(turnCost(result.read.turns[0]), initialCost);
      assert.ok(result.read.turns[0].usageParts?.every((part) => part.inferenceClass === 'bedrock-regional'));
      assert.ok(recoveryBytes > 1024 * 1024);
      const cached = await readClaudeSessionIncrementalAsync(
        file,
        'session',
        throughStructuredClone(result.checkpoint),
        options,
      );
      assert.equal(cached.readBytes, 0);
      assert.equal(cached.recoveryBytes, 0);
      fs.appendFileSync(file, lines([prompt('Follow-up', 3), reply('Follow-up answer', 4)]));
      const appended = await readClaudeSessionIncrementalAsync(
        file,
        'session',
        throughStructuredClone(result.checkpoint),
        options,
      );
      assert.ok(appended.read && appended.checkpoint);
      assert.equal(appended.recoveryPending, false);
      assert.equal(appended.read.turns.at(-1)?.modelAttachment ?? null, identity);
      assert.ok(appended.read.turns.at(-1)?.usageParts?.every((part) => part.inferenceClass === 'bedrock-regional'));
      assert.equal(appended.checkpoint.parserState.usageState.modelProfile ?? null, null);
      const state = (appended.checkpoint as ClaudeForwardCheckpoint).attachmentRecovery!;
      const replaced = fs.readFileSync(file);
      replaced[0] = replaced[0] === 123 ? 32 : 123;
      fs.writeFileSync(file, replaced);
      fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
      assert.equal(recoverClaudeAttachmentSlice(file, state).kind, 'stale');
      fs.writeFileSync(file, '');
      assert.equal(recoverClaudeAttachmentSlice(file, state).kind, 'stale');
    }
    const identities = ['claude-opus-5-5[1m]', 'claude-opus-5-5'];
    fs.writeFileSync(
      file,
      lines([
        attachment(identities[0]),
        prompt('older', 1),
        reply('older answer', 2),
        attachment(identities[1]),
        prompt('newer', 3),
        reply('newer answer', 4),
      ]),
    );
    const first = await readClaudeHistoryPageAsync(file, 'session', null, { targetTurns: 1, chunkBytes: 80 });
    assert.ok(first.page);
    assert.equal(first.page.turns[0].modelAttachment, identities[1]);
    const second = await readClaudeHistoryPageAsync(file, 'session', first.page.nextOlderCursor, {
      targetTurns: 1,
      chunkBytes: 80,
    });
    assert.ok(second.page);
    assert.equal(second.page.turns[0].modelAttachment, identities[0]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each([false, true])(
  'cold attachment recovery preserves completed replies before a later window selection (%s)',
  async (nextReply) => {
    const directory = tempDir('completed-attachment-');
    const file = path.join(directory, 'session.jsonl');
    const attachment = (modelId: string) => ({
      type: 'attachment',
      attachment: { type: 'model', identity: { modelId } },
    });
    const prompt = (content: string) => ({ type: 'user', timestamp: timestamp(1), message: { role: 'user', content } });
    const reply = (id: string) => ({
      type: 'assistant',
      timestamp: timestamp(2),
      message: {
        role: 'assistant',
        id,
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: id }],
      },
    });
    const filler = JSON.stringify({ type: 'ignored', text: 'x'.repeat(16384) }) + '\n';
    const records = [
      prompt('older'),
      reply('older'),
      attachment('claude-opus-5-5'),
      ...(nextReply ? [prompt('newer'), reply('newer')] : []),
    ];
    const tail = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    fs.writeFileSync(file, JSON.stringify(attachment('claude-opus-5-5[1m]')) + '\n' + filler + tail);
    const result = await readClaudeSessionIncrementalAsync(file, 'session', undefined, {
      tailBytes: Buffer.byteLength(tail) + 1,
    });
    assert.ok(result.read);
    assert.deepEqual(
      result.read.turns.map((turn) => [turn.prompt, turn.modelAttachment]),
      nextReply
        ? [
            ['older', 'claude-opus-5-5[1m]'],
            ['newer', 'claude-opus-5-5'],
          ]
        : [['older', 'claude-opus-5-5[1m]']],
    );
  },
);

test('pending attachment recovery advances through contiguous appends and rejects rewrites', async () => {
  const directory = tempDir('growing-attachment-');
  const file = path.join(directory, 'session.jsonl');
  const record = (value: unknown) => JSON.stringify(value) + '\n';
  const prefix = record({
    type: 'attachment',
    attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } },
  });
  const filler = record({ type: 'ignored', text: 'x'.repeat(512) });
  fs.writeFileSync(
    file,
    prefix +
      filler.repeat(80) +
      record({ type: 'user', timestamp: timestamp(1), message: { role: 'user', content: 'Go' } }),
  );
  const options = { tailBytes: 2048 };
  const work = { attachmentBudget: { maxBytes: 4096, maxMilliseconds: Infinity } };
  let result = await readClaudeSessionIncrementalAsync(file, 'session', undefined, options, work);
  assert.ok(result.checkpoint && result.recoveryPending);
  const firstEnd = (result.checkpoint as ClaudeForwardCheckpoint).attachmentRecovery!.cursor.end;
  fs.appendFileSync(file, filler);
  result = await readClaudeSessionIncrementalAsync(
    file,
    'session',
    throughStructuredClone(result.checkpoint),
    options,
    work,
  );
  assert.ok(result.checkpoint);
  assert.equal((result.checkpoint as ClaudeForwardCheckpoint).attachmentRecovery!.cursor.end, firstEnd - 4096);
  const deadline = Date.now() + 10000;
  while (result.recoveryPending && Date.now() < deadline) {
    fs.appendFileSync(file, filler);
    result = await readClaudeSessionIncrementalAsync(
      file,
      'session',
      throughStructuredClone(result.checkpoint!),
      options,
      work,
    );
  }
  assert.equal(result.recoveryPending, false);
  assert.equal((result.checkpoint as ClaudeForwardCheckpoint).attachmentRecovery!.identity, 'claude-opus-5-5[1m]');
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 5] = 32;
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
  const rewritten = await readClaudeSessionIncrementalAsync(
    file,
    'session',
    throughStructuredClone(result.checkpoint!),
    options,
    work,
  );
  assert.equal(rewritten.kind, 'reset');
  fs.writeFileSync(file, prefix);
  const truncated = await readClaudeSessionIncrementalAsync(
    file,
    'session',
    throughStructuredClone(result.checkpoint!),
    options,
    work,
  );
  assert.equal(truncated.kind, 'reset');
});

test.each(['stable', 'stale', 'cancelled'])(
  'newest discovery accounts for every recovery read including stale work (%s)',
  async (outcome) => {
    const directory = tempDir('discovery-recovery-bytes-');
    const file = path.join(directory, 'session.jsonl');
    const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    fs.writeFileSync(
      file,
      lines([
        { type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } } },
        { type: 'user', timestamp: timestamp(1), message: { role: 'user', content: 'Go' } },
        {
          type: 'assistant',
          timestamp: timestamp(2),
          message: {
            role: 'assistant',
            id: 'answer',
            model: 'claude-opus-5-5',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done' }],
          },
        },
        ...Array.from({ length: 30 }, () => ({ type: 'ignored', text: 'x'.repeat(16384) })),
      ]),
    );
    const listener = source.lastIndexOf('parentPort?.on(');
    const listenerStart = source.lastIndexOf('\n', listener) + 1;
    assert.ok(listener > 0);
    const execution =
      outcome === 'cancelled'
        ? source.slice(0, listenerStart) +
          `
    require('node:worker_threads').parentPort.on('message', async message => {
      const controller = new AbortController(); cancelDiscovery = () => controller.abort();
      const value = await execute(message.request, controller.signal);
      require('node:worker_threads').parentPort.postMessage({id:message.id,result:{generation:message.generation,revision:null,value}});
    });`
        : source;
    const instrumented =
      `const observedFs = require('node:fs'); const nativeRead = observedFs.readSync;
    let cancelDiscovery = () => {};
    let recoveryReadBytes = 0; let moved = false;
    observedFs.readSync = function(...args) {
      const stack = new Error().stack || ''; const bytes = nativeRead.apply(this, args);
      if (stack.includes('recoverClaudeAttachmentSlice')) recoveryReadBytes += bytes;
      if (${outcome !== 'stable'} && !moved && recoveryReadBytes && stack.includes('discover')) {
        moved = true;
        if (${outcome === 'cancelled'}) cancelDiscovery();
        else observedFs.utimesSync(${JSON.stringify(file)}, new Date(), new Date(Date.now()+10000));
      }
      return bytes;
    };
    const port = require('node:worker_threads').parentPort; const nativePost = port.postMessage;
    port.postMessage = function(message) { if(message.result) message.result.observedRecoveryBytes = recoveryReadBytes; return nativePost.call(this,message); };
    ` + execution;
    const worker = new ProgressiveWorker(instrumented);
    try {
      const stat = revisionOf(fs.statSync(file, { bigint: true }));
      const result = await worker.run(
        {
          kind: 'window',
          input: {
            session: { file, sessionId: 'session', agent: 'claude', size: stat.size, mtimeMs: stat.mtimeMs },
            folders: [],
            children: [],
            maxTurns: 40,
            tailBytes: 128,
          },
        },
        1,
        new AbortController().signal,
      );
      assert.ok(result);
      assert.equal(result.value.kind, outcome === 'stable' ? 'window' : 'stale');
      const observed = (result as typeof result & { observedRecoveryBytes: number }).observedRecoveryBytes;
      assert.ok(observed > 0);
      assert.equal((result.value as { recoveryBytes?: number }).recoveryBytes, observed);
    } finally {
      worker.stop();
    }
  },
);

test.each(['claude', 'codex'] as const)(
  'a reload charges parent checks, subagent head reads, and %s dispatched spend rereads to their own counters',
  async (agent) => {
    const directory = tempDir('relationship-read-counters-');
    const id = '4f4bf298-958f-4751-8782-d8688ff808a6';
    const parentFile = path.join(directory, 'parent.jsonl');
    const dispatchedFile = path.join(directory, id + '.jsonl');
    const nativeFile = path.join(directory, 'native.jsonl');
    const goneFile = path.join(directory, 'gone.jsonl');
    const childDirectory = path.join(directory, 'parent', 'subagents');
    const childFile = path.join(childDirectory, 'agent-child.jsonl');
    const write = (file: string, rows: unknown[]) =>
      fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.mkdirSync(childDirectory, { recursive: true });
    write(parentFile, [
      ...(agent === 'claude'
        ? claudeDispatchTranscript('claude --bg review', 'backgrounded · 4f4bf298 · Review')
        : claudeDispatchTranscript(
            'python launch.py --arc-dispatch',
            `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${id}"}`,
          )),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'launch' }] } },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
        toolUseResult: { agentId: 'child' },
      },
    ]);
    write(childFile, [{ type: 'user', cwd: directory, message: { content: 'child work' } }]);
    const rollout = (threadId: string, output: number) => [
      {
        type: 'session_meta',
        timestamp: timestamp(0),
        payload: { id: threadId, cwd: directory, source: 'exec', model_provider: 'openai' },
      },
      { type: 'event_msg', timestamp: timestamp(1), payload: { type: 'task_started', turn_id: threadId } },
      { type: 'turn_context', timestamp: timestamp(2), payload: { turn_id: threadId, model: 'gpt-6-sol' } },
      { type: 'event_msg', timestamp: timestamp(2), payload: { type: 'user_message', message: 'work' } },
      {
        type: 'event_msg',
        timestamp: timestamp(3),
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output },
            total_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output },
            model_context_window: 258400,
          },
        },
      },
      { type: 'event_msg', timestamp: timestamp(4), payload: { type: 'task_complete', turn_id: threadId } },
    ];
    if (agent === 'claude') {
      write(dispatchedFile, [
        { type: 'user', cwd: directory, timestamp: timestamp(0), message: { role: 'user', content: 'Review' } },
        {
          type: 'assistant',
          timestamp: timestamp(2),
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: 'Finished',
            model: 'claude-sonnet-4-20250514',
            usage: { input_tokens: 7, output_tokens: 1 },
          },
        },
      ]);
    } else {
      write(dispatchedFile, rollout(id, 3));
      const native = rollout('native', 5);
      (native[0].payload as { parent_thread_id?: string }).parent_thread_id = id;
      write(nativeFile, native);
      fs.utimesSync(dispatchedFile, 100, 100);
      fs.utimesSync(nativeFile, 100, 100);
    }

    const session = (file: string, sessionId: string) => {
      const stat = revisionOf(fs.statSync(file, { bigint: true }));
      return { file, sessionId, agent: 'claude' as const, size: stat.size, mtimeMs: stat.mtimeMs };
    };
    const dispatched = { ...session(dispatchedFile, id), agent };
    // A parent whose file is gone is checked again for absence, before its scan and again before publication.
    const gone = { file: goneFile, sessionId: 'gone', agent: 'claude' as const, size: 1, mtimeMs: 1 };
    // A Codex dispatched session is a catalog entry with a native descendant, never a relationship parent.
    const parents = [session(parentFile, 'parent'), gone, ...(agent === 'claude' ? [dispatched] : [])];
    const request = {
      kind: 'claude-children' as const,
      parents,
      catalog: [session(parentFile, 'parent'), dispatched],
      codexChildren:
        agent === 'codex'
          ? [
              {
                file: nativeFile,
                threadId: 'native',
                parentThreadId: id,
                agentPath: '/native',
                openedAt: 0,
                startedAt: 0,
                threadSource: 'subagent',
                backgroundReview: false,
              },
            ]
          : [],
      repositoryRoots: [directory],
    };
    const candidates = agent === 'claude' ? 3 : 2;
    // Every clock read advances one millisecond, and every byte the worker reads is summed independently of the counters.
    const observedSource =
      `const observedFs = require('node:fs');
    const observedRead = observedFs.readSync; const observedReadFile = observedFs.readFileSync;
    let observedBytes = 0; let observedTick = 0;
    performance.now = () => ++observedTick;
    observedFs.readSync = function (...args) { const count = observedRead.apply(this, args); observedBytes += count; return count; };
    observedFs.readFileSync = function (...args) { const value = observedReadFile.apply(this, args);
      observedBytes += typeof value === 'string' ? Buffer.byteLength(value) : value.length; return value; };
    const observedPort = require('node:worker_threads').parentPort;
    const observedPost = observedPort.postMessage;
    observedPort.postMessage = function (message) { if (message.result) Object.assign(message.result, { observedBytes });
      return observedPost.call(this, message); };` + source;
    const first = new ProgressiveWorker(source);
    const reloaded = new ProgressiveWorker(observedSource);
    try {
      const found = await completeDiscovery(first, request, 1, new AbortController().signal);
      assert.ok(found?.value.kind === 'claude-children');
      assert.deepEqual(
        found.value.children.map((child) => child.sessionId),
        ['child'],
      );
      assert.equal(found.value.dispatchFacts.length, 1);
      const run = async (referenceEntries: typeof found.value.referenceEntries, generation: number) => {
        const result = await reloaded.run({ ...request, referenceEntries }, generation, new AbortController().signal);
        assert.ok(result?.value.kind === 'claude-children', 'cached relationships needed another pass');
        assert.ok(result.value.charges, 'the reply carried no discovery charges');
        return {
          charges: result.value.charges,
          entries: result.value.referenceEntries,
          observed: result as typeof result & { observedBytes: number },
        };
      };
      const cold = await run(found.value.referenceEntries, 1);
      assert.equal(cold.charges.readBytes, 0, 'cached relationships charged relationship scan bytes');
      assert.equal(cold.charges.hits, candidates);
      assert.equal(
        cold.charges.parentChecks,
        2 * candidates + 3,
        'source checks share admission observations and recheck publication and missing files',
      );
      assert.equal(cold.charges.parentCheckMs, 2 * candidates + 3);
      assert.equal(cold.charges.childHeadFiles, 1);
      assert.equal(cold.charges.childHeadBytes, fs.statSync(childFile).size);
      assert.equal(cold.charges.childHeadMs, 4 * candidates + 2, 'walk duration includes source checks in both walks');
      assert.equal(cold.charges.dispatchSpendVisits, 1);
      assert.equal(cold.charges.dispatchSpendRereads, 1);
      assert.equal(cold.charges.dispatchSpendFiles, agent === 'claude' ? 1 : 2);
      assert.ok(
        cold.charges.dispatchSpendBytes >= fs.statSync(dispatchedFile).size,
        'the spend reread missed the transcript',
      );
      assert.ok(cold.charges.dispatchSpendMs >= 1);
      assert.equal(
        cold.charges.childHeadBytes + cold.charges.dispatchSpendBytes,
        cold.observed.observedBytes,
        'a relationship read escaped the counters',
      );
      const warm = await run(cold.entries, 2);
      assert.equal(warm.observed.observedBytes, cold.observed.observedBytes, 'held relationship facts read again');
      assert.equal(warm.charges.childHeadFiles, 0);
      assert.equal(warm.charges.childHeadBytes, 0);
      assert.equal(warm.charges.dispatchSpendVisits, 1);
      assert.equal(warm.charges.dispatchSpendRereads, 0, 'held dispatched facts counted as a reread');
      assert.equal(warm.charges.dispatchSpendFiles, 0);
      assert.equal(warm.charges.dispatchSpendBytes, 0);
    } finally {
      first.stop();
      reloaded.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
