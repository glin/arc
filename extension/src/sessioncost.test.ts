import {
  ADVISOR_EXECUTOR,
  ADVISOR_ITERATIONS,
  ADVISOR_MODEL,
  ADVISOR_MODEL_USAGE,
  advisorIteration,
  advisorProbeRecords,
  advisorResponseRecords,
  MIXED_PASS_ITERATIONS,
  PER_PASS_ITERATIONS,
  bedrockAstraRecords,
  receiptDispatchFixture,
  claudeDispatchTranscript,
} from './turnfixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { tempDir } from './temproot';
import { createClaudeUsageLineReducer } from './transcript';
import { sessionCostProjection, sessionCostUsageOf } from './turncard';
import { quoteUsage } from './pricing';
import * as pricing from './pricing';
import * as projectSpend from './projectspend';
import * as codexReader from './codex';
import {
  findSessionTranscript,
  readSessionRequests,
  sessionCostReport,
  sessionCostReportAsync,
  sessionSources,
  sessionSourcesAsync,
  summarizeRequests,
  type SessionRequest,
} from './sessioncost';

function directory(): string {
  return tempDir('session-cost-');
}

const defaultRoots = { codexSessions: directory(), projects: directory() };

beforeEach(() => {
  vi.stubEnv('ARC_HOME', directory());
  vi.stubEnv('ARC_CODEX_ROOT', defaultRoots.codexSessions);
  vi.stubEnv('ARC_PROJECTS_ROOT', defaultRoots.projects);
});

test.each(['claude', 'codex'] as const)(
  'receipt-only %s parents include each child and immediate grandchild usage once',
  async (parentAgent) => {
    for (const childAgent of ['claude', 'codex'] as const) {
      const fx = receiptDispatchFixture(directory(), parentAgent, childAgent);
      vi.stubEnv('ARC_HOME', fx.home);
      fx.launch();
      fx.launch();
      fx.launch(fx.child, fx.grandchild);
      fx.launch(fx.child, fx.child);
      const roots = { projects: fx.projects, codexSessions: fx.codexSessions };
      assert.deepEqual(
        sessionSources(fx.parent.file, roots).map((source) => source.sessionId),
        fx.ids,
      );
      assert.deepEqual(
        (await sessionSourcesAsync(fx.parent.file, roots)).map((source) => source.sessionId),
        fx.ids,
      );
      const report = sessionCostReport(fx.parent.file, { roots });
      assert.deepEqual(
        report.children.map((child) => child.sessionId),
        fx.ids.slice(1),
      );
      assert.ok(report.children.every((child) => (child.costUsd ?? child.estimatedCostUsd ?? 0) > 0));
      assert.ok(report.children.every((child) => child.uncachedInputTokens === 10000 && child.outputTokens === 2000));
      fx.launch(fx.grandchild, fx.child);
      assert.deepEqual(
        sessionSources(fx.parent.file, roots).map((source) => source.sessionId),
        [fx.parent.sessionId],
      );
    }
  },
);

test('cost receipt discovery revisits pending identity and cooperatively cancels a large store', async () => {
  const fx = receiptDispatchFixture(directory(), 'claude', 'codex');
  vi.stubEnv('ARC_HOME', fx.home);
  const launch = fx.launch(fx.parent, fx.child, false, false);
  const roots = { projects: fx.projects, codexSessions: fx.codexSessions };
  assert.equal(sessionSources(fx.parent.file, roots).length, 1);
  fx.accept(launch.launchId);
  assert.equal(sessionSources(fx.parent.file, roots).length, 2);
  for (let index = 0; index < 300; index++)
    fs.mkdirSync(path.join(fx.receipts.root, `${index.toString(16).padStart(8, '0')}-1111-2222-3333-444444444444`));
  const controller = new AbortController();
  const pending = sessionSourcesAsync(fx.parent.file, roots, false, controller.signal);
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(sessionSources(fx.parent.file, roots).length, 2);
});

test('receipt cost collects competing transcript claims before descent and preserves native child precedence', async () => {
  const fx = receiptDispatchFixture(directory(), 'claude', 'codex');
  vi.stubEnv('ARC_HOME', fx.home);
  fx.launch();
  const roots = { projects: fx.projects, codexSessions: fx.codexSessions };
  const marker = `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${fx.child.sessionId}"}`;
  fs.appendFileSync(
    fx.grandchild.file,
    claudeDispatchTranscript('python dispatch.py --arc-dispatch', marker)
      .map((row) => JSON.stringify(row) + '\n')
      .join(''),
  );
  assert.deepEqual(
    sessionSources(fx.parent.file, roots).map((source) => source.sessionId),
    [fx.parent.sessionId],
  );
  assert.deepEqual(
    (await sessionSourcesAsync(fx.parent.file, roots)).map((source) => source.sessionId),
    [fx.parent.sessionId],
  );
  const native = receiptDispatchFixture(directory(), 'codex', 'codex');
  vi.stubEnv('ARC_HOME', native.home);
  const content = fs
    .readFileSync(native.child.file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  content[0].payload.parent_thread_id = native.parent.sessionId;
  fs.writeFileSync(native.child.file, content.map((row) => JSON.stringify(row) + '\n').join(''));
  native.launch(native.grandchild, native.child);
  const nativeRoots = { projects: native.projects, codexSessions: native.codexSessions };
  assert.deepEqual(
    sessionSources(native.parent.file, nativeRoots).map((source) => source.sessionId),
    [native.parent.sessionId, native.child.sessionId],
  );
  assert.deepEqual(
    sessionSources(native.grandchild.file, nativeRoots).map((source) => source.sessionId),
    [native.grandchild.sessionId],
  );

  const foreign = receiptDispatchFixture(directory(), 'claude', 'codex');
  vi.stubEnv('ARC_HOME', foreign.home);
  foreign.launch();
  const foreignChild = path.join(
    path.dirname(foreign.grandchild.file),
    foreign.grandchild.sessionId,
    'subagents',
    'agent-foreign.jsonl',
  );
  write(
    foreignChild,
    claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${foreign.child.sessionId}"}`,
    ),
  );
  const foreignRoots = { projects: foreign.projects, codexSessions: foreign.codexSessions };
  assert.deepEqual(
    sessionSources(foreign.parent.file, foreignRoots).map((source) => source.sessionId),
    [foreign.parent.sessionId],
  );
  assert.deepEqual(
    (await sessionSourcesAsync(foreign.parent.file, foreignRoots)).map((source) => source.sessionId),
    [foreign.parent.sessionId],
  );
});

test('unavailable receipt storage preserves foreground transcript cost fallback', async () => {
  const fx = receiptDispatchFixture(directory(), 'claude', 'claude');
  vi.stubEnv('ARC_HOME', fx.home);
  fs.mkdirSync(fx.home);
  fs.writeFileSync(path.join(fx.home, 'dispatch'), 'unavailable');
  const marker = `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${fx.child.sessionId}"}`;
  fs.appendFileSync(
    fx.parent.file,
    claudeDispatchTranscript('python dispatch.py --arc-dispatch', marker)
      .map((row) => JSON.stringify(row) + '\n')
      .join(''),
  );
  const roots = { projects: fx.projects, codexSessions: fx.codexSessions };
  assert.deepEqual(
    sessionSources(fx.parent.file, roots).map((source) => source.sessionId),
    fx.ids.slice(0, 2),
  );
  assert.deepEqual(
    (await sessionSourcesAsync(fx.parent.file, roots)).map((source) => source.sessionId),
    fx.ids.slice(0, 2),
  );
});

test('an unrelated receipt leaves unrelated transcript bodies and native child directories unread', async () => {
  const fx = receiptDispatchFixture(directory(), 'claude', 'claude');
  vi.stubEnv('ARC_HOME', fx.home);
  fx.launch();
  const target = fx.write('claude', 'dddddddd-1111-2222-3333-444444444444');
  const unrelated = new Set<string>();
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const nativeRead = nativeFs.readSync;
  const nativeOpen = nativeFs.openSync;
  const descriptors = new Map<number, string>();
  let unrelatedBytes = 0;
  const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
    const fd = nativeOpen(file, ...args);
    descriptors.set(fd, String(file));
    return fd;
  });
  const read = vi.spyOn(nativeFs, 'readSync').mockImplementation(((fd, ...args) => {
    const bytes = Reflect.apply(nativeRead, nativeFs, [fd, ...args]) as number;
    if (unrelated.has(descriptors.get(fd) ?? '')) unrelatedBytes += bytes;
    return bytes;
  }) as typeof fs.readSync);
  const enumerate = vi.spyOn(nativeFs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    const observations: number[] = [];
    const directoryReads: boolean[] = [];
    for (const count of [1, 12]) {
      for (let index = unrelated.size; index < count; index++) {
        const unused = fx.write('claude', `${index.toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`);
        fs.appendFileSync(unused.file, JSON.stringify({ type: 'ignored', padding: 'x'.repeat(96 * 1024) }) + '\n');
        unrelated.add(unused.file);
      }
      unrelatedBytes = 0;
      enumerate.mockClear();
      const roots = { projects: fx.projects, codexSessions: fx.codexSessions };
      for (const sources of [sessionSources(target.file, roots), await sessionSourcesAsync(target.file, roots)])
        assert.deepEqual(
          sources.map((source) => source.sessionId),
          [target.sessionId],
        );
      observations.push(unrelatedBytes);
      const unrelatedDirectories = new Set(
        [...unrelated, fx.parent.file, fx.child.file, fx.grandchild.file].map((file) =>
          path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents'),
        ),
      );
      directoryReads.push(enumerate.mock.calls.some(([file]) => unrelatedDirectories.has(String(file))));
    }
    assert.deepEqual(observations, [0, 0], 'Unrelated native bytes with one and twelve unrelated sources');
    assert.deepEqual(directoryReads, [false, false]);
    const foreignRoot = fx.write('claude', 'eeeeeeee-1111-2222-3333-444444444444');
    const requester = fx.write('claude', 'ffffffff-1111-2222-3333-444444444444');
    const requesterFile = path.join(
      path.dirname(foreignRoot.file),
      foreignRoot.sessionId,
      'subagents',
      `agent-${requester.sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(requesterFile), { recursive: true });
    fs.renameSync(requester.file, requesterFile);
    fx.launch({ ...requester, file: requesterFile }, fx.child);
    unrelatedBytes = 0;
    const roots = { projects: fx.projects, codexSessions: fx.codexSessions };
    for (const sources of [sessionSources(target.file, roots), await sessionSourcesAsync(target.file, roots)])
      assert.deepEqual(
        sources.map((source) => source.sessionId),
        [target.sessionId],
      );
    assert.equal(unrelatedBytes, 0, 'An unrelated native requester triggered catalog body reads');
  } finally {
    open.mockRestore();
    read.mockRestore();
    enumerate.mockRestore();
    syncBuiltinESMExports();
  }
});

test('receipt cost skips a native child removed after enumeration and retains surviving usage', async () => {
  for (const [cooperative, code] of [
    [false, 'ENOENT'],
    [true, 'ENOENT'],
    [false, 'ENOTDIR'],
    [true, 'ENOTDIR'],
  ] as const) {
    const fx = receiptDispatchFixture(directory(), 'claude', 'codex');
    vi.stubEnv('ARC_HOME', fx.home);
    fx.launch();
    const childDirectory = path.join(path.dirname(fx.parent.file), fx.parent.sessionId, 'subagents');
    const missing = write(path.join(childDirectory, 'agent-missing.jsonl'), [claudeRequest('missing', 20)]);
    const surviving = write(path.join(childDirectory, 'agent-surviving.jsonl'), [claudeRequest('surviving', 30)]);
    const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
    const nativeStat = nativeFs.statSync;
    let removed = false;
    const stat = vi.spyOn(nativeFs, 'statSync').mockImplementation((file, ...args) => {
      if (String(file) === missing && !removed) {
        removed = true;
        fs.unlinkSync(missing);
        if (code === 'ENOTDIR') throw Object.assign(new Error('Native child directory disappeared.'), { code });
      }
      return Reflect.apply(nativeStat, nativeFs, [file, ...args]);
    });
    syncBuiltinESMExports();
    try {
      const options = { roots: { projects: fx.projects, codexSessions: fx.codexSessions } };
      const report = cooperative
        ? await sessionCostReportAsync(fx.parent.file, options)
        : sessionCostReport(fx.parent.file, options);
      assert.equal(removed, true, 'The enumerated native child never reached its stat');
      assert.ok(report.children.some((child) => child.file === surviving && child.outputTokens === 30));
      assert.ok(report.children.some((child) => child.sessionId === fx.child.sessionId && child.requests > 0));
      assert.ok(!report.children.some((child) => child.file === missing));
    } finally {
      stat.mockRestore();
      syncBuiltinESMExports();
    }
  }
});

test.each([
  ['native discovery', false],
  ['native discovery', true],
  ['native catalog', false],
  ['native catalog', true],
  ['selected endpoint', false],
  ['selected endpoint', true],
] as const)('receipt cost preserves permission failures during %s (cooperative %s)', async (stage, cooperative) => {
  const fx = receiptDispatchFixture(directory(), 'claude', 'claude');
  vi.stubEnv('ARC_HOME', fx.home);
  let unavailable: string;
  if (stage === 'selected endpoint') {
    unavailable = path.join(
      path.dirname(fx.parent.file),
      fx.parent.sessionId,
      'subagents',
      `agent-${fx.grandchild.sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(unavailable), { recursive: true });
    fs.renameSync(fx.grandchild.file, unavailable);
    fx.launch({ ...fx.grandchild, file: unavailable }, fx.child);
  } else {
    fx.launch();
    unavailable = path.join(
      path.dirname(fx.grandchild.file),
      fx.grandchild.sessionId,
      'subagents',
      `agent-${fx.child.sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(unavailable), { recursive: true });
    fs.copyFileSync(fx.child.file, unavailable);
  }
  const options = { roots: { projects: fx.projects, codexSessions: fx.codexSessions } };
  const normal = cooperative
    ? await sessionCostReportAsync(fx.parent.file, options)
    : sessionCostReport(fx.parent.file, options);
  assert.deepEqual(
    normal.children.map((child) => child.sessionId),
    stage === 'selected endpoint' ? [fx.grandchild.sessionId, fx.child.sessionId] : [],
  );
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const nativeStat = nativeFs.statSync;
  let denied = false;
  const stat = vi.spyOn(nativeFs, 'statSync').mockImplementation((file, ...args) => {
    const bigint = args[0]?.bigint === true;
    if (String(file) === unavailable && !denied && bigint === (stage !== 'native discovery')) {
      denied = true;
      throw Object.assign(new Error('Native source is unavailable.'), { code: 'EACCES' });
    }
    return Reflect.apply(nativeStat, nativeFs, [file, ...args]);
  });
  syncBuiltinESMExports();
  try {
    if (cooperative) await assert.rejects(sessionCostReportAsync(fx.parent.file, options), { code: 'EACCES' });
    else assert.throws(() => sessionCostReport(fx.parent.file, options), { code: 'EACCES' });
    assert.equal(denied, true, 'The native source never reached the selected stat boundary');
  } finally {
    stat.mockRestore();
    syncBuiltinESMExports();
  }
});

test.each([
  ['directory', false],
  ['directory', true],
  ['body', false],
  ['body', true],
] as const)('receipt cost refuses incomplete competing %s evidence (cooperative %s)', async (stage, cooperative) => {
  const fx = receiptDispatchFixture(directory(), 'claude', 'claude');
  vi.stubEnv('ARC_HOME', fx.home);
  fx.launch();
  const competingDirectory = path.join(path.dirname(fx.grandchild.file), fx.grandchild.sessionId, 'subagents');
  if (stage === 'directory') {
    fs.mkdirSync(competingDirectory, { recursive: true });
    fs.copyFileSync(fx.child.file, path.join(competingDirectory, `agent-${fx.child.sessionId}.jsonl`));
  } else {
    fs.appendFileSync(
      fx.grandchild.file,
      claudeDispatchTranscript(
        'python dispatch.py --arc-dispatch',
        `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${fx.child.sessionId}"}`,
      )
        .map((row) => JSON.stringify(row) + '\n')
        .join(''),
    );
  }
  const options = { roots: { projects: fx.projects, codexSessions: fx.codexSessions } };
  const read = (file: string, sourceOnly = false) =>
    cooperative
      ? sessionCostReportAsync(file, { ...options, sourceOnly })
      : sessionCostReport(file, { ...options, sourceOnly });
  assert.deepEqual((await read(fx.parent.file)).children, []);
  const unrelated = fx.write('claude', 'dddddddd-1111-2222-3333-444444444444');
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const nativeDirectory = nativeFs.readdirSync;
  const nativeOpen = nativeFs.openSync;
  let denied = 0;
  const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation((file, ...args) => {
    if (stage === 'directory' && String(file) === competingDirectory) {
      denied++;
      throw Object.assign(new Error('Competing source is unavailable.'), { code: 'EACCES' });
    }
    return Reflect.apply(nativeDirectory, nativeFs, [file, ...args]);
  });
  const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
    if (stage === 'body' && String(file) === fx.grandchild.file) {
      denied++;
      throw Object.assign(new Error('Competing source is unavailable.'), { code: 'EACCES' });
    }
    return nativeOpen(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual((await read(unrelated.file)).children, []);
    assert.deepEqual((await read(fx.parent.file, true)).children, []);
    assert.equal(denied, 0, 'Unrelated and source-only reports read competing evidence');
    const expected =
      stage === 'directory' ? { code: 'EACCES' } : { message: `Cannot read transcript: ${fx.grandchild.file}` };
    if (cooperative) await assert.rejects(read(fx.parent.file) as Promise<unknown>, expected);
    else assert.throws(() => read(fx.parent.file), expected);
    assert.ok(denied > 0, 'The competing source never reached the failed read');
  } finally {
    enumerate.mockRestore();
    open.mockRestore();
    syncBuiltinESMExports();
  }
  assert.deepEqual((await read(fx.parent.file)).children, []);
});

test.each([
  ['directory', false],
  ['directory', true],
  ['body', false],
  ['body', true],
] as const)(
  'receipt cost retains surviving usage after competing %s disappearance (cooperative %s)',
  async (stage, cooperative) => {
    for (const code of ['ENOENT', 'ENOTDIR'] as const) {
      const fx = receiptDispatchFixture(directory(), 'claude', 'claude');
      vi.stubEnv('ARC_HOME', fx.home);
      fx.launch();
      const competingDirectory = path.join(path.dirname(fx.grandchild.file), fx.grandchild.sessionId, 'subagents');
      if (stage === 'directory') {
        fs.mkdirSync(competingDirectory, { recursive: true });
        fs.copyFileSync(fx.child.file, path.join(competingDirectory, `agent-${fx.child.sessionId}.jsonl`));
      } else {
        fs.appendFileSync(
          fx.grandchild.file,
          claudeDispatchTranscript(
            'python dispatch.py --arc-dispatch',
            `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${fx.child.sessionId}"}`,
          )
            .map((row) => JSON.stringify(row) + '\n')
            .join(''),
        );
      }
      const surviving = write(
        path.join(path.dirname(fx.parent.file), fx.parent.sessionId, 'subagents', 'agent-surviving.jsonl'),
        [claudeRequest('surviving', 30)],
      );
      const options = { roots: { projects: fx.projects, codexSessions: fx.codexSessions } };
      const read = () =>
        cooperative ? sessionCostReportAsync(fx.parent.file, options) : sessionCostReport(fx.parent.file, options);
      assert.deepEqual(
        (await read()).children.map((child) => child.file),
        [surviving],
      );
      const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
      const nativeDirectory = nativeFs.readdirSync;
      const nativeOpen = nativeFs.openSync;
      const nativeStat = nativeFs.statSync;
      const unavailable = stage === 'directory' ? competingDirectory : fx.grandchild.file;
      let removed = false;
      const disappear = () => {
        assert.equal(removed, false, 'The disappeared competitor was read again');
        fs.renameSync(unavailable, `${unavailable}.removed`);
        removed = true;
        throw Object.assign(new Error('Competing source disappeared.'), { code });
      };
      const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation((file, ...args) => {
        if (stage === 'directory' && String(file) === unavailable && !removed) disappear();
        return Reflect.apply(nativeDirectory, nativeFs, [file, ...args]);
      });
      const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
        if (stage === 'body' && String(file) === unavailable && !removed) disappear();
        return nativeOpen(file, ...args);
      });
      const stat = vi.spyOn(nativeFs, 'statSync').mockImplementation((file, ...args) => {
        if (stage === 'body' && removed && String(file) === unavailable)
          throw Object.assign(new Error('Competing source disappeared.'), { code });
        return Reflect.apply(nativeStat, nativeFs, [file, ...args]);
      });
      syncBuiltinESMExports();
      try {
        const report = await read();
        assert.equal(removed, true, 'The competing source never reached the disappearance boundary');
        assert.ok(report.children.some((child) => child.file === surviving && child.outputTokens === 30));
        assert.equal(report.children.filter((child) => child.sessionId === fx.child.sessionId).length, 1);
        assert.ok(
          report.children.some((child) => child.sessionId === fx.child.sessionId && child.outputTokens === 2000),
        );
      } finally {
        enumerate.mockRestore();
        open.mockRestore();
        stat.mockRestore();
        syncBuiltinESMExports();
      }
    }
  },
);

test('an unrelated receipt preserves an explicit outside-store parent and its foreground dispatch', async () => {
  const root = directory();
  const fx = receiptDispatchFixture(root, 'claude', 'claude');
  vi.stubEnv('ARC_HOME', fx.home);
  fx.launch();
  const outside = fx.write('codex', 'dddddddd-1111-2222-3333-444444444444');
  const file = path.join(root, 'rollout-outside.jsonl');
  fs.renameSync(outside.file, file);
  const records = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  records.splice(3, 0, {
    type: 'event_msg',
    timestamp: '2026-01-01T00:00:01Z',
    payload: {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'outside-launch',
        parsed_cmd: [{ cmd: 'python dispatch.py --arc-dispatch' }],
        stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${fx.grandchild.sessionId}"}`,
        status: 'completed',
        exit_code: 0,
      },
    },
  });
  fs.writeFileSync(file, records.map((row) => JSON.stringify(row) + '\n').join(''));
  assert.equal(codexReader.scanCodexDispatchReferences(file, outside.sessionId).references.length, 1);
  const roots = { projects: fx.projects, codexSessions: fx.codexSessions };
  const synchronous = sessionSources(file, roots).map((source) => source.sessionId);
  const cooperative = (await sessionSourcesAsync(file, roots)).map((source) => source.sessionId);
  assert.deepEqual(synchronous, [outside.sessionId, fx.grandchild.sessionId]);
  assert.deepEqual(cooperative, synchronous);
  records.splice(3, 1);
  fs.writeFileSync(file, records.map((row) => JSON.stringify(row) + '\n').join(''));
  fx.launch({ ...outside, file }, fx.grandchild);
  assert.deepEqual(codexReader.scanCodexDispatchReferences(file, outside.sessionId).references, []);
  assert.deepEqual(
    sessionSources(file, roots).map((source) => source.sessionId),
    [outside.sessionId, fx.grandchild.sessionId],
  );
  assert.deepEqual(
    (await sessionSourcesAsync(file, roots)).map((source) => source.sessionId),
    [outside.sessionId, fx.grandchild.sessionId],
  );
});

test('receipt cost follows a selected native subagent requester and rejects an incoming foreign receipt claim', async () => {
  const fx = receiptDispatchFixture(directory(), 'claude', 'codex');
  vi.stubEnv('ARC_HOME', fx.home);
  const nativeFile = path.join(
    path.dirname(fx.parent.file),
    fx.parent.sessionId,
    'subagents',
    `agent-${fx.grandchild.sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
  fs.renameSync(fx.grandchild.file, nativeFile);
  fx.launch({ ...fx.grandchild, file: nativeFile }, fx.child);
  const roots = { projects: fx.projects, codexSessions: fx.codexSessions };
  for (const sources of [sessionSources(fx.parent.file, roots), await sessionSourcesAsync(fx.parent.file, roots)])
    assert.deepEqual(
      sources.map((source) => source.sessionId),
      [fx.parent.sessionId, fx.grandchild.sessionId, fx.child.sessionId],
    );

  const conflict = receiptDispatchFixture(directory(), 'claude', 'codex');
  vi.stubEnv('ARC_HOME', conflict.home);
  fs.appendFileSync(
    conflict.parent.file,
    claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${conflict.child.sessionId}"}`,
    )
      .map((row) => JSON.stringify(row) + '\n')
      .join(''),
  );
  conflict.launch(conflict.grandchild, conflict.child);
  const conflictRoots = { projects: conflict.projects, codexSessions: conflict.codexSessions };
  for (const sources of [
    sessionSources(conflict.parent.file, conflictRoots),
    await sessionSourcesAsync(conflict.parent.file, conflictRoots),
  ])
    assert.deepEqual(
      sources.map((source) => source.sessionId),
      [conflict.parent.sessionId],
    );

  const foreign = receiptDispatchFixture(directory(), 'claude', 'codex');
  vi.stubEnv('ARC_HOME', foreign.home);
  const foreignRoot = foreign.write('claude', 'eeeeeeee-1111-2222-3333-444444444444');
  const foreignFile = path.join(
    path.dirname(foreignRoot.file),
    foreignRoot.sessionId,
    'subagents',
    `agent-${foreign.grandchild.sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
  fs.renameSync(foreign.grandchild.file, foreignFile);
  fs.appendFileSync(
    foreign.parent.file,
    claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${foreign.child.sessionId}"}`,
    )
      .map((row) => JSON.stringify(row) + '\n')
      .join(''),
  );
  foreign.launch({ ...foreign.grandchild, file: foreignFile }, foreign.child);
  const foreignRoots = { projects: foreign.projects, codexSessions: foreign.codexSessions };
  for (const sources of [
    sessionSources(foreign.parent.file, foreignRoots),
    await sessionSourcesAsync(foreign.parent.file, foreignRoots),
  ])
    assert.deepEqual(
      sources.map((source) => source.sessionId),
      [foreign.parent.sessionId],
    );
});

function competingCostFixture(
  agent: 'claude' | 'codex',
  childAgent: 'claude' | 'codex' = agent === 'codex' ? 'claude' : 'codex',
) {
  const fx = receiptDispatchFixture(directory(), 'claude', childAgent);
  vi.stubEnv('ARC_HOME', fx.home);
  fx.launch();
  const candidate = agent === 'claude' ? fx.grandchild : fx.write('codex', fx.grandchild.sessionId);
  const project =
    agent === 'claude' ? path.join(fx.projects, 'foreign-project') : path.join(fx.codexSessions, '2026', '01', '01');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, path.basename(candidate.file));
  fs.renameSync(candidate.file, file);
  const marker = `ARC_DISPATCH_SESSION={"agent":"${fx.child.agent}","session_id":"${fx.child.sessionId}"}`;
  if (agent === 'claude')
    fs.appendFileSync(
      file,
      claudeDispatchTranscript('python dispatch.py --arc-dispatch', marker)
        .map((row) => JSON.stringify(row) + '\n')
        .join(''),
    );
  else {
    const rows = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    rows.splice(3, 0, {
      type: 'event_msg',
      timestamp: '2026-01-01T00:00:01Z',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'foreign-launch',
          parsed_cmd: [{ cmd: 'python dispatch.py --arc-dispatch' }],
          stdout: marker,
          status: 'completed',
          exit_code: 0,
        },
      },
    });
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row) + '\n').join(''));
  }
  const options = { roots: { projects: fx.projects, codexSessions: fx.codexSessions } };
  return { ...fx, competitor: file, project, options };
}

test.each(['claude', 'codex'] as const)('receipt competition refuses a premature %s body end', async (agent) => {
  for (const cooperative of [true, false]) {
    const fx = competingCostFixture(agent);
    const report = () =>
      cooperative ? sessionCostReportAsync(fx.parent.file, fx.options) : sessionCostReport(fx.parent.file, fx.options);
    assert.deepEqual((await report()).children, []);
    const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
    const originalOpen = nativeFs.openSync,
      originalRead = nativeFs.readSync,
      originalClose = nativeFs.closeSync;
    const descriptors = new Map<number, boolean>();
    let catalogOpened = false,
      stopped = false;
    const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (String(file) === fx.competitor) {
        descriptors.set(fd, agent === 'claude' || catalogOpened);
        catalogOpened = true;
      }
      return fd;
    });
    const read = vi.spyOn(nativeFs, 'readSync').mockImplementation(((fd, ...args) => {
      if (descriptors.get(fd)) {
        stopped = true;
        return 0;
      }
      return Reflect.apply(originalRead, nativeFs, [fd, ...args]);
    }) as typeof fs.readSync);
    const close = vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
      descriptors.delete(fd);
      originalClose(fd);
    });
    syncBuiltinESMExports();
    try {
      const expected = { message: `Cannot read transcript: ${fx.competitor}` };
      if (cooperative) await assert.rejects(report() as Promise<unknown>, expected);
      else assert.throws(report, expected);
      assert.equal(stopped, true);
      assert.equal(descriptors.size, 0);
      assert.equal(fs.existsSync(fx.competitor), true);
    } finally {
      close.mockRestore();
      read.mockRestore();
      open.mockRestore();
      syncBuiltinESMExports();
    }
  }
});

test.each(['project', 'root', 'stat', 'local'] as const)(
  'receipt competition refuses the Claude catalog %s omission',
  async (stage) => {
    for (const cooperative of [true, false])
      for (const code of ['EACCES', 'EPERM']) {
        const fx = competingCostFixture('claude');
        if (stage === 'local') {
          const outside = path.join(path.dirname(fx.projects), 'outside');
          fs.mkdirSync(outside);
          for (const source of [fx.parent, { file: fx.competitor }]) {
            const target = path.join(outside, path.basename(source.file));
            fs.renameSync(source.file, target);
            if (source === fx.parent) fx.parent.file = target;
            else fx.competitor = target;
          }
          fx.project = outside;
        }
        const report = (file = fx.parent.file, sourceOnly = false) =>
          cooperative
            ? sessionCostReportAsync(file, { ...fx.options, sourceOnly })
            : sessionCostReport(file, { ...fx.options, sourceOnly });
        assert.deepEqual((await report()).children, []);
        const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
        const originalDirectory = nativeFs.readdirSync,
          originalStat = nativeFs.statSync;
        const failure = Object.assign(new Error('Competing catalog is unavailable.'), { code });
        let denied = 0,
          nativeVisits = 0;
        const selectedDirectory = path.join(path.dirname(fx.parent.file), fx.parent.sessionId, 'subagents');
        const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation((file, ...args) => {
          if (String(file) === selectedDirectory) nativeVisits++;
          if (stage !== 'stat' && String(file) === (stage === 'root' ? fx.projects : fx.project)) {
            denied++;
            throw failure;
          }
          return Reflect.apply(originalDirectory, nativeFs, [file, ...args]);
        });
        const stat = vi.spyOn(nativeFs, 'statSync').mockImplementation((file, ...args) => {
          if (stage === 'stat' && String(file) === fx.competitor) {
            denied++;
            throw failure;
          }
          return Reflect.apply(originalStat, nativeFs, [file, ...args]);
        });
        syncBuiltinESMExports();
        try {
          assert.deepEqual((await report(fx.parent.file, true)).children, []);
          assert.equal(denied, 0);
          if (cooperative) await assert.rejects(report() as Promise<unknown>, { code });
          else assert.throws(report, { code });
          assert.ok(denied > 0);
          assert.equal(nativeVisits, 1, 'A known applicable refusal reached the global native census');
        } finally {
          stat.mockRestore();
          enumerate.mockRestore();
          syncBuiltinESMExports();
        }
      }
  },
);

test.each(['startup', 'witness', 'bytes', 'iteration'] as const)(
  'receipt competition refuses missing %s evidence',
  async (stage) => {
    for (const child of ['claude', 'codex'] as const)
      for (const cooperative of [true, false]) {
        const fx = receiptDispatchFixture(directory(), 'claude', child);
        vi.stubEnv('ARC_HOME', fx.home);
        const first = fx.launch(),
          second = fx.launch(fx.grandchild, fx.child);
        const options = { roots: { projects: fx.projects, codexSessions: fx.codexSessions } };
        const report = () =>
          cooperative ? sessionCostReportAsync(fx.parent.file, options) : sessionCostReport(fx.parent.file, options);
        assert.deepEqual((await report()).children, []);
        const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
        const originalOpen = nativeFs.openSync,
          originalRead = nativeFs.readSync,
          originalClose = nativeFs.closeSync,
          originalDirectory = nativeFs.opendirSync;
        const startup = path.join(fx.receipts.root, second.launchId, 'startup.json');
        const before = fs.readFileSync(startup);
        const target = stage === 'witness' ? path.join(fx.receipts.root, `${second.launchId}.startup.json`) : startup;
        const firstEntry = fs
          .readdirSync(fx.receipts.root, { withFileTypes: true })
          .find((entry) => entry.name === first.launchId)!;
        const failure = Object.assign(new Error('Competing receipt is unavailable.'), { code: 'EACCES' });
        const descriptors = new Map<number, string>();
        let denied = 0,
          closed = 0;
        const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
          if ((stage === 'startup' || stage === 'witness') && String(file) === target) {
            denied++;
            throw failure;
          }
          const fd = originalOpen(file, ...args);
          descriptors.set(fd, String(file));
          return fd;
        });
        const read = vi.spyOn(nativeFs, 'readSync').mockImplementation(((fd, ...args) => {
          if (stage === 'bytes' && descriptors.get(fd) === target) {
            denied++;
            throw failure;
          }
          return Reflect.apply(originalRead, nativeFs, [fd, ...args]);
        }) as typeof fs.readSync);
        const close = vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
          descriptors.delete(fd);
          originalClose(fd);
        });
        const enumerate = vi.spyOn(nativeFs, 'opendirSync').mockImplementation((file, ...args) => {
          const dir = Reflect.apply(originalDirectory, nativeFs, [file, ...args]);
          if (stage === 'iteration' && String(file) === fx.receipts.root) {
            let visited = false;
            vi.spyOn(dir, 'readSync').mockImplementation(() => {
              if (!visited) {
                visited = true;
                return firstEntry;
              }
              denied++;
              throw failure;
            });
            const close = dir.closeSync.bind(dir);
            vi.spyOn(dir, 'closeSync').mockImplementation(() => {
              closed++;
              close();
            });
          }
          return dir;
        });
        syncBuiltinESMExports();
        try {
          if (cooperative) await assert.rejects(report() as Promise<unknown>, { code: 'EACCES' });
          else assert.throws(report, { code: 'EACCES' });
          assert.ok(denied > 0);
          if (stage === 'iteration') assert.ok(closed > 0);
          assert.equal(descriptors.size, 0);
        } finally {
          enumerate.mockRestore();
          close.mockRestore();
          read.mockRestore();
          open.mockRestore();
          syncBuiltinESMExports();
        }
        assert.deepEqual(fs.readFileSync(startup), before);
        assert.equal(fs.existsSync(fx.child.file), true);
        assert.deepEqual((await report()).children, []);
      }
  },
);

test.each(['directory', 'root', 'opening'] as const)(
  'receipt competition classifies the Codex %s refusal',
  async (stage) => {
    for (const cooperative of [false, true])
      for (const outcome of ['present', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'non-directory'] as const) {
        const fx = competingCostFixture('codex');
        const report = () =>
          cooperative
            ? sessionCostReportAsync(fx.parent.file, fx.options)
            : sessionCostReport(fx.parent.file, fx.options);
        assert.deepEqual((await report()).children, []);
        const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
        const originalDirectory = nativeFs.readdirSync,
          originalOpen = nativeFs.openSync,
          originalStat = nativeFs.statSync;
        const target =
          stage === 'opening'
            ? fx.competitor
            : stage === 'root'
              ? fx.codexSessions
              : path.join(fx.codexSessions, '2026');
        const held = path.join(path.dirname(fx.projects), 'held-competitor');
        const before = fs.readFileSync(fx.competitor);
        let denied = 0,
          checked = 0;
        const deny = () => {
          denied++;
          if ((outcome === 'ENOENT' || outcome === 'ENOTDIR' || outcome === 'non-directory') && denied === 1) {
            fs.renameSync(target, held);
            if (outcome === 'non-directory') fs.writeFileSync(target, 'unavailable');
          }
          throw Object.assign(new Error('Competing catalog is unavailable.'), {
            code: outcome === 'ENOENT' || outcome === 'ENOTDIR' || outcome === 'EPERM' ? outcome : 'EACCES',
          });
        };
        const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation((file, ...args) => {
          if (stage !== 'opening' && String(file) === target) deny();
          return Reflect.apply(originalDirectory, nativeFs, [file, ...args]);
        });
        const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
          if (stage === 'opening' && String(file) === target) deny();
          return originalOpen(file, ...args);
        });
        const stat = vi.spyOn(nativeFs, 'statSync').mockImplementation((file, ...args) => {
          if (String(file) === target && denied) {
            checked++;
            if (outcome === 'EACCES' || outcome === 'EPERM' || outcome === 'ENOENT' || outcome === 'ENOTDIR')
              throw Object.assign(new Error('Competing pathname is unavailable.'), { code: outcome });
          }
          return Reflect.apply(originalStat, nativeFs, [file, ...args]);
        });
        syncBuiltinESMExports();
        try {
          const absent =
            outcome === 'ENOENT' || outcome === 'ENOTDIR' || (outcome === 'non-directory' && stage !== 'opening');
          if (absent) {
            const result = await report();
            assert.equal(
              result.children.filter((child) => child.sessionId === fx.child.sessionId && child.outputTokens === 2000)
                .length,
              1,
            );
          } else {
            const expected =
              outcome === 'EACCES' || outcome === 'EPERM'
                ? { code: outcome }
                : { message: `Cannot read transcript${stage === 'opening' ? '' : ' directory'}: ${target}` };
            if (cooperative) await assert.rejects(report() as Promise<unknown>, expected);
            else assert.throws(report, expected);
          }
          assert.ok(denied > 0);
          if (!(stage === 'root' && outcome === 'ENOENT'))
            assert.ok(checked > 0, 'The reader did not classify its actual uncertain pathname');
        } finally {
          stat.mockRestore();
          open.mockRestore();
          enumerate.mockRestore();
          syncBuiltinESMExports();
        }
        if (fs.existsSync(held)) {
          if (outcome === 'non-directory') fs.unlinkSync(target);
          fs.renameSync(held, target);
        }
        assert.deepEqual(fs.readFileSync(fx.competitor), before);
      }
  },
);

test.each(['project', 'stat'] as const)(
  'receipt competition preserves Claude catalog %s disappearance',
  async (stage) => {
    for (const cooperative of [false, true])
      for (const code of ['ENOENT', 'ENOTDIR']) {
        const fx = competingCostFixture('claude');
        const surviving = write(
          path.join(path.dirname(fx.parent.file), fx.parent.sessionId, 'subagents', 'agent-surviving.jsonl'),
          [claudeRequest('surviving', 30)],
        );
        const report = () =>
          cooperative
            ? sessionCostReportAsync(fx.parent.file, fx.options)
            : sessionCostReport(fx.parent.file, fx.options);
        assert.deepEqual(
          (await report()).children.map((child) => child.file),
          [surviving],
        );
        const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
        const originalDirectory = nativeFs.readdirSync,
          originalStat = nativeFs.statSync;
        const target = stage === 'project' ? fx.project : fx.competitor,
          held = target + '.held';
        const before = fs.readFileSync(fx.competitor);
        let removed = false;
        const disappear = () => {
          fs.renameSync(target, held);
          removed = true;
          throw Object.assign(new Error('Competing catalog disappeared.'), { code });
        };
        const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation((file, ...args) => {
          if (stage === 'project' && String(file) === target && !removed) disappear();
          return Reflect.apply(originalDirectory, nativeFs, [file, ...args]);
        });
        const stat = vi.spyOn(nativeFs, 'statSync').mockImplementation((file, ...args) => {
          if (stage === 'stat' && String(file) === target && !removed) disappear();
          return Reflect.apply(originalStat, nativeFs, [file, ...args]);
        });
        syncBuiltinESMExports();
        try {
          const result = await report();
          assert.equal(removed, true);
          assert.ok(result.children.some((child) => child.file === surviving && child.outputTokens === 30));
          assert.equal(
            result.children.filter((child) => child.sessionId === fx.child.sessionId && child.outputTokens === 2000)
              .length,
            1,
          );
        } finally {
          stat.mockRestore();
          enumerate.mockRestore();
          syncBuiltinESMExports();
        }
        fs.renameSync(held, target);
        assert.deepEqual(fs.readFileSync(fx.competitor), before);
      }
  },
);

test.each(['claude', 'codex'] as const)(
  'receipt competition classifies %s body failures inside each read closure',
  async (agent) => {
    for (const cooperative of [false, true])
      for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']) {
        const fx = competingCostFixture(agent);
        const report = () =>
          cooperative
            ? sessionCostReportAsync(fx.parent.file, fx.options)
            : sessionCostReport(fx.parent.file, fx.options);
        assert.deepEqual((await report()).children, []);
        const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
        const originalOpen = nativeFs.openSync,
          originalClose = nativeFs.closeSync,
          originalStat = nativeFs.statSync;
        const held = fx.competitor + '.held',
          before = fs.readFileSync(fx.competitor);
        let catalogOpened = false,
          denied = false,
          checked = false;
        const descriptors = new Set<number>();
        const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
          if (String(file) === fx.competitor) {
            if (agent === 'claude' || catalogOpened) {
              denied = true;
              if (code === 'ENOENT' || code === 'ENOTDIR') fs.renameSync(fx.competitor, held);
              throw Object.assign(new Error('Competing body is unavailable.'), { code });
            }
            catalogOpened = true;
          }
          const fd = originalOpen(file, ...args);
          descriptors.add(fd);
          return fd;
        });
        const close = vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
          descriptors.delete(fd);
          originalClose(fd);
        });
        const stat = vi.spyOn(nativeFs, 'statSync').mockImplementation((file, ...args) => {
          if (denied && String(file) === fx.competitor && (code === 'ENOENT' || code === 'ENOTDIR')) {
            checked = true;
            throw Object.assign(new Error('Competing body disappeared.'), { code });
          }
          return Reflect.apply(originalStat, nativeFs, [file, ...args]);
        });
        syncBuiltinESMExports();
        try {
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            const result = await report();
            assert.equal(checked, true);
            assert.equal(
              result.children.filter((child) => child.sessionId === fx.child.sessionId && child.outputTokens === 2000)
                .length,
              1,
            );
          } else {
            const expected = agent === 'claude' ? { message: `Cannot read transcript: ${fx.competitor}` } : { code };
            if (cooperative) await assert.rejects(report() as Promise<unknown>, expected);
            else assert.throws(report, expected);
          }
          assert.equal(denied, true);
          assert.equal(descriptors.size, 0);
        } finally {
          stat.mockRestore();
          close.mockRestore();
          open.mockRestore();
          syncBuiltinESMExports();
        }
        if (fs.existsSync(held)) fs.renameSync(held, fx.competitor);
        assert.deepEqual(fs.readFileSync(fx.competitor), before);
      }
  },
);

test.each(['receipt', 'catalog', 'late-receipt'] as const)(
  'dispatch-bearing cost refuses hidden %s competition without a qualified touch',
  async (boundary) => {
    for (const cooperative of [false, true]) {
      const root = directory(),
        fx = receiptDispatchFixture(root, 'claude', 'codex');
      vi.stubEnv('ARC_HOME', fx.home);
      const marker = claudeDispatchTranscript(
        'python dispatch.py --arc-dispatch',
        `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${fx.child.sessionId}"}`,
      )
        .map((row) => JSON.stringify(row) + '\n')
        .join('');
      fs.appendFileSync(fx.parent.file, marker);
      const foreignDirectory = path.join(fx.projects, 'foreign-project');
      let requester = fx.grandchild;
      if (boundary === 'catalog' || boundary === 'late-receipt') {
        const foreign = fx.write('claude', 'eeeeeeee-1111-2222-3333-444444444444');
        const subtree = path.join(path.dirname(foreign.file), foreign.sessionId, 'subagents');
        fs.mkdirSync(subtree, { recursive: true });
        const requesterFile = path.join(subtree, `agent-${requester.sessionId}.jsonl`);
        fs.renameSync(requester.file, requesterFile);
        fs.mkdirSync(foreignDirectory, { recursive: true });
        fs.renameSync(foreign.file, path.join(foreignDirectory, path.basename(foreign.file)));
        fs.renameSync(path.dirname(subtree), path.join(foreignDirectory, foreign.sessionId));
        requester = {
          ...requester,
          file: path.join(foreignDirectory, foreign.sessionId, 'subagents', path.basename(requesterFile)),
        };
      }
      const launch = fx.launch(requester, fx.child);
      const options = { roots: { projects: fx.projects, codexSessions: fx.codexSessions } };
      const report = (sourceOnly = false) =>
        cooperative
          ? sessionCostReportAsync(fx.parent.file, { ...options, sourceOnly })
          : sessionCostReport(fx.parent.file, { ...options, sourceOnly });
      assert.deepEqual((await report()).children, []);
      const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
      const originalDirectory = nativeFs.readdirSync,
        originalOpen = nativeFs.openSync;
      let denied = 0,
        startupSeen = false;
      const target = path.join(fx.receipts.root, launch.launchId, 'startup.json');
      const failure = Object.assign(new Error('Competing source is unavailable.'), { code: 'EACCES' });
      const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation((file, ...args) => {
        if (boundary === 'catalog' && String(file) === foreignDirectory) {
          denied++;
          throw failure;
        }
        return Reflect.apply(originalDirectory, nativeFs, [file, ...args]);
      });
      const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
        if (String(file) === target) {
          if (boundary === 'receipt' || (boundary === 'late-receipt' && startupSeen)) {
            denied++;
            throw failure;
          }
          startupSeen = true;
        }
        return originalOpen(file, ...args);
      });
      syncBuiltinESMExports();
      try {
        assert.deepEqual((await report(true)).children, []);
        assert.equal(denied, 0);
        for (let retry = 0; retry < 2; retry++) {
          if (cooperative) await assert.rejects(report() as Promise<unknown>, { code: 'EACCES' });
          else assert.throws(report, { code: 'EACCES' });
        }
        assert.ok(denied > 0);
        // A native-only selection has no admitted dispatch child for this uncertainty to invalidate.
        fs.writeFileSync(fx.parent.file, fs.readFileSync(fx.parent.file, 'utf8').replace(marker, ''));
        assert.deepEqual((await report()).children, []);
      } finally {
        open.mockRestore();
        enumerate.mockRestore();
        syncBuiltinESMExports();
      }
    }
  },
);

test.each(['missing', 'non-directory', 'opening', 'later-opening'] as const)(
  'receipt competition preserves %s storage policy with a catalog refusal',
  async (mode) => {
    for (const cooperative of [false, true]) {
      const fx = competingCostFixture('claude', 'claude');
      // The selected transcript supplies its ordinary fallback edge.
      fs.appendFileSync(
        fx.parent.file,
        claudeDispatchTranscript(
          'python dispatch.py --arc-dispatch',
          `ARC_DISPATCH_SESSION={"agent":"${fx.child.agent}","session_id":"${fx.child.sessionId}"}`,
        )
          .map((row) => JSON.stringify(row) + '\n')
          .join(''),
      );
      if (mode === 'missing' || mode === 'non-directory') {
        fs.renameSync(fx.receipts.root, fx.receipts.root + '.held');
        if (mode === 'non-directory') fs.writeFileSync(fx.receipts.root, 'unavailable');
      }
      const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
      const originalDirectory = nativeFs.readdirSync,
        originalOpen = nativeFs.opendirSync;
      const failure = Object.assign(new Error('Receipt storage is unavailable.'), { code: 'EPERM' });
      let opened = false,
        denied = 0,
        catalogDenied = 0;
      const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation((file, ...args) => {
        if (mode !== 'later-opening' && String(file) === fx.project) {
          catalogDenied++;
          throw Object.assign(new Error('Foreign project is unavailable.'), { code: 'EACCES' });
        }
        return Reflect.apply(originalDirectory, nativeFs, [file, ...args]);
      });
      const open = vi.spyOn(nativeFs, 'opendirSync').mockImplementation((file, ...args) => {
        if (String(file) === fx.receipts.root) {
          if (mode === 'opening' || (mode === 'later-opening' && opened)) {
            denied++;
            throw failure;
          }
          opened = true;
        }
        return Reflect.apply(originalOpen, nativeFs, [file, ...args]);
      });
      syncBuiltinESMExports();
      const report = () =>
        cooperative
          ? sessionCostReportAsync(fx.parent.file, fx.options)
          : sessionCostReport(fx.parent.file, fx.options);
      try {
        if (mode === 'later-opening') {
          if (cooperative) await assert.rejects(report() as Promise<unknown>, { code: 'EPERM' });
          else assert.throws(report, { code: 'EPERM' });
        } else {
          const result = await report();
          assert.equal(
            result.children.filter((child) => child.sessionId === fx.child.sessionId && child.outputTokens === 2000)
              .length,
            1,
          );
        }
        if (mode === 'opening' || mode === 'later-opening') assert.ok(denied > 0);
      } finally {
        open.mockRestore();
        enumerate.mockRestore();
        syncBuiltinESMExports();
      }
      if (mode !== 'later-opening') assert.ok(catalogDenied > 0);
    }
  },
);

test('unrelated and source-only cost retain their boundaries with refused catalog and receipt evidence', async () => {
  for (const cooperative of [false, true]) {
    const fx = competingCostFixture('claude');
    const target = fx.write('claude', 'dddddddd-1111-2222-3333-444444444444');
    const second = fx.launch(fx.grandchild, fx.child);
    const startup = path.join(fx.receipts.root, second.launchId, 'startup.json');
    const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
    const originalDirectory = nativeFs.readdirSync,
      originalOpen = nativeFs.openSync;
    let denied = 0,
      bodies = 0;
    const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation((file, ...args) => {
      if (String(file) === fx.project) {
        denied++;
        throw Object.assign(new Error('Foreign project is unavailable.'), { code: 'EACCES' });
      }
      return Reflect.apply(originalDirectory, nativeFs, [file, ...args]);
    });
    const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
      if (String(file) === startup) {
        denied++;
        throw Object.assign(new Error('Competing receipt is unavailable.'), { code: 'EPERM' });
      }
      if (String(file) === fx.competitor) bodies++;
      return originalOpen(file, ...args);
    });
    syncBuiltinESMExports();
    try {
      const report = (sourceOnly: boolean) =>
        cooperative
          ? sessionCostReportAsync(target.file, { ...fx.options, sourceOnly })
          : sessionCostReport(target.file, { ...fx.options, sourceOnly });
      assert.deepEqual((await report(true)).children, []);
      assert.equal(denied, 0);
      assert.deepEqual((await report(false)).children, []);
      assert.ok(denied > 0);
      assert.equal(bodies, 0);
    } finally {
      open.mockRestore();
      enumerate.mockRestore();
      syncBuiltinESMExports();
    }
  }
});

test('applicable cost refuses a null cooperative catalog without cancellation', async () => {
  const fx = competingCostFixture('codex');
  assert.deepEqual((await sessionCostReportAsync(fx.parent.file, fx.options)).children, []);
  const enumeration = vi.spyOn(codexReader, 'enumerateRolloutFilesAsync').mockResolvedValue(null);
  try {
    await assert.rejects(sessionCostReportAsync(fx.parent.file, fx.options), {
      message: `Cannot read transcript directory: ${fx.codexSessions}`,
    });
    assert.ok(enumeration.mock.calls.length > 0);
  } finally {
    enumeration.mockRestore();
  }
});

test.each(['claude', 'codex'] as const)('required %s bodies classify a premature-end pathname check', async (agent) => {
  for (const cooperative of [false, true])
    for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']) {
      const fx = competingCostFixture(agent);
      const report = () =>
        cooperative
          ? sessionCostReportAsync(fx.parent.file, fx.options)
          : sessionCostReport(fx.parent.file, fx.options);
      assert.deepEqual((await report()).children, []);
      const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
      const originalOpen = nativeFs.openSync,
        originalRead = nativeFs.readSync,
        originalClose = nativeFs.closeSync,
        originalStat = nativeFs.statSync;
      const descriptors = new Map<number, boolean>();
      const before = fs.readFileSync(fx.competitor),
        held = fx.competitor + '.held';
      let catalogOpened = false,
        stopped = false,
        checked = false;
      const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
        const fd = originalOpen(file, ...args);
        if (String(file) === fx.competitor) {
          descriptors.set(fd, agent === 'claude' || catalogOpened);
          catalogOpened = true;
        }
        return fd;
      });
      const read = vi.spyOn(nativeFs, 'readSync').mockImplementation(((fd, ...args) => {
        if (descriptors.get(fd)) {
          if (!stopped && (code === 'ENOENT' || code === 'ENOTDIR')) fs.renameSync(fx.competitor, held);
          stopped = true;
          return 0;
        }
        return Reflect.apply(originalRead, nativeFs, [fd, ...args]);
      }) as typeof fs.readSync);
      const close = vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
        descriptors.delete(fd);
        originalClose(fd);
      });
      const stat = vi.spyOn(nativeFs, 'statSync').mockImplementation((file, ...args) => {
        if (stopped && String(file) === fx.competitor) {
          checked = true;
          throw Object.assign(new Error('Competing body pathname is unavailable.'), { code });
        }
        return Reflect.apply(originalStat, nativeFs, [file, ...args]);
      });
      syncBuiltinESMExports();
      try {
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          const result = await report();
          assert.equal(
            result.children.filter((child) => child.sessionId === fx.child.sessionId && child.outputTokens === 2000)
              .length,
            1,
          );
        } else if (cooperative) await assert.rejects(report() as Promise<unknown>, { code });
        else assert.throws(report, { code });
        assert.equal(stopped, true);
        assert.equal(checked, true);
        assert.equal(descriptors.size, 0);
      } finally {
        stat.mockRestore();
        close.mockRestore();
        read.mockRestore();
        open.mockRestore();
        syncBuiltinESMExports();
      }
      if (fs.existsSync(held)) fs.renameSync(held, fx.competitor);
      assert.deepEqual(fs.readFileSync(fx.competitor), before);
    }
});

test('required Codex bodies preserve their captured append target and bounded null openings', async () => {
  for (const cooperative of [false, true]) {
    const fx = competingCostFixture('codex');
    const noOpening = fx.write('codex', 'dddddddd-1111-2222-3333-444444444444');
    fs.writeFileSync(noOpening.file, JSON.stringify({ type: 'ignored', padding: 'x'.repeat(96 * 1024) }) + '\n');
    assert.equal(codexReader.readCodexOpening(noOpening.file), null);
    const report = () =>
      cooperative ? sessionCostReportAsync(fx.parent.file, fx.options) : sessionCostReport(fx.parent.file, fx.options);
    assert.deepEqual((await report()).children, []);
    const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
    const originalOpen = nativeFs.openSync,
      originalRead = nativeFs.readSync,
      originalClose = nativeFs.closeSync;
    const descriptors = new Map<number, boolean>();
    let catalogOpened = false,
      appended = false;
    const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (String(file) === fx.competitor) {
        descriptors.set(fd, catalogOpened);
        catalogOpened = true;
      }
      return fd;
    });
    const read = vi.spyOn(nativeFs, 'readSync').mockImplementation(((fd, ...args) => {
      const count = Reflect.apply(originalRead, nativeFs, [fd, ...args]);
      if (descriptors.get(fd) && !appended) {
        appended = true;
        fs.appendFileSync(fx.competitor, JSON.stringify({ type: 'ignored', padding: 'x'.repeat(96 * 1024) }) + '\n');
      }
      return count;
    }) as typeof fs.readSync);
    const close = vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
      descriptors.delete(fd);
      originalClose(fd);
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual((await report()).children, []);
      assert.equal(appended, true);
      assert.equal(descriptors.size, 0);
    } finally {
      close.mockRestore();
      read.mockRestore();
      open.mockRestore();
      syncBuiltinESMExports();
    }
  }
});

test('Codex body disappearance requires an absent failed pathname', async () => {
  for (const cooperative of [false, true])
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const fx = competingCostFixture('codex');
      const report = () =>
        cooperative
          ? sessionCostReportAsync(fx.parent.file, fx.options)
          : sessionCostReport(fx.parent.file, fx.options);
      assert.deepEqual((await report()).children, []);
      const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
      const originalOpen = nativeFs.openSync;
      let catalogOpened = false,
        denied = false;
      const open = vi.spyOn(nativeFs, 'openSync').mockImplementation((file, ...args) => {
        if (String(file) === fx.competitor) {
          if (catalogOpened) {
            denied = true;
            throw Object.assign(new Error('Competing body is unavailable.'), { code });
          }
          catalogOpened = true;
        }
        return originalOpen(file, ...args);
      });
      syncBuiltinESMExports();
      try {
        if (cooperative) await assert.rejects(report() as Promise<unknown>, { code });
        else assert.throws(report, { code });
        assert.equal(denied, true);
        assert.equal(fs.existsSync(fx.competitor), true);
      } finally {
        open.mockRestore();
        syncBuiltinESMExports();
      }
    }
});

test('a known unrelated receipt preserves a dispatch-bearing tree with an unrelated catalog refusal', async () => {
  for (const cooperative of [false, true]) {
    const fx = receiptDispatchFixture(directory(), 'claude', 'claude');
    vi.stubEnv('ARC_HOME', fx.home);
    const unrelated = fx.write('claude', 'dddddddd-1111-2222-3333-444444444444');
    fx.launch(fx.grandchild, unrelated);
    fs.appendFileSync(
      fx.parent.file,
      claudeDispatchTranscript(
        'python dispatch.py --arc-dispatch',
        `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${fx.child.sessionId}"}`,
      )
        .map((row) => JSON.stringify(row) + '\n')
        .join(''),
    );
    const foreign = path.join(fx.projects, 'foreign-project');
    fs.mkdirSync(foreign);
    const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
    const originalDirectory = nativeFs.readdirSync;
    const selectedDirectory = path.join(path.dirname(fx.parent.file), fx.parent.sessionId, 'subagents');
    let denied = 0,
      nativeVisits = 0;
    const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation((file, ...args) => {
      if (String(file) === foreign) {
        denied++;
        throw Object.assign(new Error('Foreign project is unavailable.'), { code: 'EPERM' });
      }
      if (String(file) === selectedDirectory) nativeVisits++;
      return Reflect.apply(originalDirectory, nativeFs, [file, ...args]);
    });
    syncBuiltinESMExports();
    try {
      const options = { roots: { projects: fx.projects, codexSessions: fx.codexSessions } };
      const result = cooperative
        ? await sessionCostReportAsync(fx.parent.file, options)
        : sessionCostReport(fx.parent.file, options);
      assert.equal(
        result.children.filter((child) => child.sessionId === fx.child.sessionId && child.outputTokens === 2000).length,
        1,
      );
      assert.ok(denied > 0);
      assert.equal(nativeVisits, 1);
    } finally {
      enumerate.mockRestore();
      syncBuiltinESMExports();
    }
  }
});

afterEach(() => vi.unstubAllEnvs());

function write(file: string, records: object[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

test('per-pass pricing applies a recorded response cost once across two bands', () => {
  const file = write(
    path.join(directory(), 'recorded.jsonl'),
    advisorResponseRecords({ iterations: MIXED_PASS_ITERATIONS, reportedCost: 0.123 }),
  );
  const requests = readSessionRequests(file);
  assert.equal(summarizeRequests(requests).costUsd, 0.123);
  assert.equal(requests[0].contextBand, null);
});

test('mixed-tier advisor responses retain expiry coverage at ten minutes and expire after one hour', () => {
  for (const [seconds, expected] of [
    [600, 0],
    [3601, 1],
  ] as const) {
    const file = write(path.join(directory(), 'mixed-return.jsonl'), [
      advisorProbeRecords()[0],
      ...advisorResponseRecords({ id: 'before', iterations: PER_PASS_ITERATIONS, blocks: 1 }),
      {
        ...advisorProbeRecords()[0],
        uuid: 'second-prompt',
        timestamp: '2026-10-11T09:18:09Z',
        message: { role: 'user', content: 'Continue the review.' },
      },
      ...advisorResponseRecords({
        id: 'after',
        at: seconds,
        blocks: 1,
        iterations: [advisorIteration({ input_tokens: 66035 })],
      }),
    ]);
    const expiry = summarizeRequests(readSessionRequests(file)).cacheExpiry!;
    assert.equal(expiry.returns, expected);
    assert.equal(expiry.unavailableLifetime, 0);
    assert.equal(expiry.byLifetime['1h'], expected);
  }
});

test('CLI expiry uses explicit unknown and reverse-prefix facts and preserves missing-fact fallback', () => {
  const before = pricedRequest('claude-haiku-5-5', 0, { visibleTurnId: 'first', cacheLifetime: '5m' });
  before.usage.cacheWrite1h = 453;
  before.usage.cacheWrite5m = 65580;
  const after = pricedRequest('claude-haiku-5-5', 66035, {
    timestamp: before.timestamp + 600000,
    visibleTurnId: 'second',
  });
  assert.equal(summarizeRequests([before, after]).cacheExpiry?.byLifetime['5m'], 1);
  before.cacheLifetime = null;
  assert.equal(summarizeRequests([before, after]).cacheExpiry?.unavailableLifetime, 1);
  before.usage.cacheWrite1h = 0;
  assert.equal(summarizeRequests([before, after]).cacheExpiry?.unavailableLifetime, 1);
  delete before.cacheLifetime;
  assert.equal(summarizeRequests([before, after]).cacheExpiry?.byLifetime['5m'], 1);
});

test('per-pass pricing measures cache expiry from the returning first pass', () => {
  const prompt = (at: number) => ({
    ...advisorProbeRecords()[0],
    uuid: `p-${at}`,
    timestamp: new Date(Date.parse('2026-10-11T09:08:09Z') + at * 1000).toISOString(),
  });
  const first = [
    advisorIteration({ cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } }),
  ];
  const after = [
    advisorIteration({ cache_creation: { ephemeral_5m_input_tokens: 100000, ephemeral_1h_input_tokens: 0 } }),
    advisorIteration({ cache_read_input_tokens: 100001 }),
  ];
  const file = write(path.join(directory(), 'return.jsonl'), [
    prompt(0),
    ...advisorResponseRecords({ id: 'before', iterations: first }),
    prompt(599),
    ...advisorResponseRecords({ id: 'after', at: 600, iterations: after }),
  ]);
  const report = summarizeRequests(readSessionRequests(file));
  assert.equal(report.cacheExpiry?.returns, 1);
  assert.equal(report.cacheExpiry?.extraCostAfterExpiryUsd, 0.0001);
  assert.equal(report.cacheExpiry?.inputCostAfterExpiryUsd, 0.0125);
});

function claudeRequest(id: string, output: number, tools: string[] = [], model = 'claude-opus-5'): object {
  return {
    type: 'assistant',
    timestamp: '2026-09-26T00:00:01Z',
    message: {
      id,
      role: 'assistant',
      model,
      content: tools.map((tool) => ({ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'pwd' } })),
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

function pricedRequest(model: string | null, input: number, options: Partial<SessionRequest> = {}): SessionRequest {
  return {
    timestamp: Date.parse('2026-09-26T00:00:01Z'),
    agent: model?.startsWith('claude-') ? 'claude' : 'codex',
    provider: model?.startsWith('claude-') ? null : 'openai',
    model,
    contextWindow: null,
    contextBand: null,
    billingClass: 'unknown',
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    usage: {
      requests: 1,
      input,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWrite30m: 0,
      output: 0,
      thinking: 0,
    },
    requestKey: `request-${input}`,
    toolCalls: 0,
    ...options,
  };
}

function cumulativeCostFixture(id = 'parent', model = 'gpt-6-sol') {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (multiple = 1) => ({
    input_tokens: 1000 * multiple,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 100 * multiple,
    reasoning_output_tokens: 0,
    total_tokens: 1100 * multiple,
  });
  const bill = (response: string, second: number, multiple: number, turnId = 'turn-1') => ({
    type: 'token_usage_record',
    timestamp: at(second),
    payload: {
      thread_id: id,
      session_id: 'root-parent',
      turn_id: turnId,
      response_id: response,
      usage: usage(),
      thread_token_usage: usage(multiple),
      turn_token_usage: usage(multiple),
    },
  });
  const snapshot = (second: number, multiple: number, last = usage()) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: {
      type: 'token_count',
      info: { last_token_usage: last, total_token_usage: usage(multiple) },
    },
  });
  const start = [
    { type: 'session_meta', timestamp: at(0), payload: { id, source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model } },
  ];
  const save = (records: object[]) => write(path.join(directory(), `rollout-2026-09-26T00-00-00-${id}.jsonl`), records);
  return { at, usage, bill, snapshot, start, save };
}

test('cumulative evidence reconciles distinct equal responses and delayed snapshots in the billing window', () => {
  const f = cumulativeCostFixture('child');
  const duplicate = f.bill('one', 8, 1);
  const file = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.bill('two', 4, 2),
    f.snapshot(7, 1),
    duplicate,
    f.snapshot(9, 2),
  ]);
  const report = sessionCostReport(file, { since: f.at(3), until: f.at(5), byModel: true, sourceOnly: true });
  assert.equal(report.parent.requests, 2);
  assert.equal(report.parent.coverage, 'recorded-reconciled');
  assert.equal(report.parent.requestCountExact, undefined);
  assert.equal(report.parent.costUsd, 0.006);
  assert.equal(report.parent.pricedCostUsd, 0.006);
  assert.equal(report.parent.modelCosts![0].costUsd, 0.006);
  assert.equal(report.combined.costUsd, 0.006);
  assert.equal(report.parent.toolCalls, null);
  assert.equal(report.parent.requestsWithTwoOrMoreTools, null);
  assert.equal(report.parent.cacheExpiry!.coverage, 'complete');
  const later = sessionCostReport(file, { since: f.at(6), until: f.at(10), sourceOnly: true }).parent;
  assert.equal(later.requests, 0);
  assert.equal(later.costUsd, undefined);
  assert.equal(later.requestCountExact, undefined);
});

test('a native child report keeps its own Astra bill behind a delayed opening and excludes inherited and repeated work', () => {
  const f = cumulativeCostFixture('native-child', 'gpt-6-astra');
  const opening = {
    type: 'session_meta',
    timestamp: f.at(10),
    payload: {
      id: 'native-child',
      session_id: 'root-parent',
      parent_thread_id: 'root-parent',
      timestamp: f.at(0),
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'root-parent' } } },
      model_provider: 'openai',
    },
  };
  const start = {
    type: 'event_msg',
    timestamp: f.at(11),
    payload: { type: 'task_started', turn_id: 'turn-1', started_at: Date.parse(f.at(1)) / 1000 },
  };
  const inherited = [
    { ...start, payload: { ...start.payload, turn_id: 'inherited', started_at: Date.parse(f.at(-10)) / 1000 } },
    { type: 'turn_context', timestamp: f.at(11), payload: { turn_id: 'inherited', model: 'gpt-6-sol' } },
    f.bill('inherited-bill', 11, 1, 'inherited'),
    f.snapshot(11, 1),
  ];
  const context = {
    type: 'turn_context',
    timestamp: f.at(12),
    payload: { turn_id: 'turn-1', model: 'gpt-6-astra', effort: 'high' },
  };
  const file = f.save([
    opening,
    ...inherited,
    start,
    context,
    f.bill('own', 13, 1),
    f.snapshot(14, 1),
    f.bill('own', 15, 1),
    f.snapshot(16, 1),
    start,
    context,
    f.bill('repeated', 17, 2),
    f.snapshot(18, 2),
  ]);
  const report = sessionCostReport(file, { sourceOnly: true, byModel: true });
  assert.equal(report.parent.requests, 1);
  assert.deepEqual(report.parent.models, ['gpt-6-astra']);
  assert.equal(report.parent.coverage, 'recorded-reconciled');
  assert.equal(report.parent.costUsd, 0.015);
  assert.deepEqual(report.children, []);
});

test('rounded native starts require the exact child bill and retain unknown full cost without confirmation', () => {
  for (const rounding of [0, 750]) {
    for (const thread of ['native-rounded', 'root-parent', 'foreign', null]) {
      const f = cumulativeCostFixture('native-rounded', 'gpt-6-astra');
      const opening = {
        type: 'session_meta',
        timestamp: f.at(10),
        payload: {
          id: 'native-rounded',
          session_id: 'root-parent',
          parent_thread_id: 'root-parent',
          timestamp: new Date(Date.parse(f.at(0)) + rounding).toISOString(),
          model_provider: 'openai',
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: 'root-parent' } } },
        },
      };
      const start = {
        type: 'event_msg',
        timestamp: f.at(11),
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: Date.parse(f.at(0)) / 1000 },
      };
      const context = {
        type: 'turn_context',
        timestamp: f.at(12),
        payload: { turn_id: 'turn-1', model: 'gpt-6-astra', effort: 'high' },
      };
      const bill = f.bill('rounded', 14, 1);
      const file = f.save([
        opening,
        start,
        context,
        f.snapshot(13, 1),
        ...(thread ? [{ ...bill, payload: { ...bill.payload, thread_id: thread } }] : []),
      ]);
      const report = sessionCostReport(file, { sourceOnly: true, byModel: true }).parent;
      assert.equal(report.requests, 1, String(thread));
      if (thread === 'native-rounded') {
        assert.equal(report.costUsd, 0.015);
        assert.equal(report.coverage, 'recorded-reconciled');
      } else {
        assert.equal(report.costUsd, null, String(thread));
        assert.equal(report.pricedCostUsd, 0, String(thread));
      }
    }
  }
});

test('rounded native reports preserve original usage across repeated confirmation and distinct-turn eviction', () => {
  const f = cumulativeCostFixture('native-rounded', 'gpt-6-astra');
  const opening = {
    type: 'session_meta',
    timestamp: f.at(10),
    payload: {
      id: 'native-rounded',
      session_id: 'root-parent',
      parent_thread_id: 'root-parent',
      timestamp: new Date(Date.parse(f.at(0)) + 750).toISOString(),
      model_provider: 'openai',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'root-parent' } } },
    },
  };
  const start = {
    type: 'event_msg',
    timestamp: f.at(11),
    payload: { type: 'task_started', turn_id: 'turn-1', started_at: Date.parse(f.at(0)) / 1000 },
  };
  const context = {
    type: 'turn_context',
    timestamp: f.at(12),
    payload: { turn_id: 'turn-1', model: 'gpt-6-astra', effort: 'high' },
  };
  const original = [
    opening,
    start,
    context,
    f.snapshot(13, 1),
    { type: 'event_msg', timestamp: f.at(18), payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ];
  const repeated = { ...start, timestamp: f.at(19) };
  for (const replayUsage of [false, true]) {
    const file = f.save([
      ...original,
      repeated,
      ...(replayUsage ? [f.snapshot(19, 9)] : []),
      f.bill('own', 20, 1),
      f.bill('repeated', 21, 2),
      f.snapshot(22, 2),
    ]);
    const requests = readSessionRequests(file);
    assert.equal(requests.filter((request) => request.billingRecord).length, 1);
    const report = sessionCostReport(file, { sourceOnly: true, byModel: true }).parent;
    assert.equal(report.requests, 1);
    assert.equal(report.costUsd, 0.015);
    assert.equal(report.coverage, 'recorded-reconciled');
    assert.deepEqual(report.models, ['gpt-6-astra']);
  }
  for (const laterTurns of [0, 64, 65]) {
    const file = f.save([
      ...original,
      ...Array.from({ length: laterTurns }, (_, index) => ({
        type: 'event_msg',
        timestamp: f.at(21 + index),
        payload: { type: 'task_started', turn_id: `later-${index}`, started_at: Date.parse(f.at(21 + index)) / 1000 },
      })),
    ]);
    assert.equal(readSessionRequests(file).filter((request) => !request.evidenceOnly).length, 1);
    const report = sessionCostReport(file, { sourceOnly: true, byModel: true }).parent;
    assert.equal(report.requests, 1);
    assert.equal(report.costUsd, null);
    assert.equal(report.pricedCostUsd, 0);
    assert.equal(report.coverage, 'legacy-snapshots');
    assert.equal(report.cacheExpiry?.coverage, 'unknown-request-coverage');
  }
  const result = {
    type: 'result',
    session_id: 'printed',
    total_cost_usd: 0.01,
    duration_ms: 100,
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {
      'claude-haiku-4-5': {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        thinkingTokens: 0,
        costUSD: 0.01,
        contextWindow: 200_000,
        canonicalModel: 'claude-haiku-4-5',
        costBasis: 'list',
      },
    },
  };
  const print = {
    type: 'event_msg',
    timestamp: f.at(17),
    payload: {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'print',
        command: ['claude', '-p', 'review', '--output-format', 'json'],
        parsed_cmd: [{ type: 'unknown', cmd: 'claude -p review --output-format json' }],
        status: 'completed',
        exit_code: 0,
        stdout: JSON.stringify(result),
      },
    },
  };
  for (const thread of ['native-rounded', 'root-parent', 'foreign', null]) {
    const file = f.save([
      ...original,
      print,
      print,
      ...(thread ? [{ ...f.bill('own', 20, 1), payload: { ...f.bill('own', 20, 1).payload, thread_id: thread } }] : []),
    ]);
    const requests = readSessionRequests(file, 'claude-print', 'print:printed').filter(
      (request) => request.agent === 'claude',
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].incomplete ?? false, thread !== 'native-rounded');
    const summary = summarizeRequests(requests);
    assert.equal(summary.costUsd, thread === 'native-rounded' ? 0.01 : null);
    assert.equal(summary.pricedCostUsd, thread === 'native-rounded' ? 0.01 : 0);
  }
});

test('a removed bill prevents a numeric total and invalidates an empty window before the revealing snapshot', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), f.snapshot(8, 2)]);
  const report = sessionCostReport(file, { since: f.at(5), until: f.at(6), byModel: true, sourceOnly: true });
  assert.equal(report.parent.requests, 0);
  assert.equal(report.parent.coverage, 'recorded-gaps');
  assert.equal(report.parent.costUsd, null);
  assert.equal(report.parent.requestCountExact, false);
  assert.equal(report.combined.coverage, 'recorded-gaps');
  const whole = sessionCostReport(file, { byModel: true, sourceOnly: true }).parent;
  assert.equal(whole.requests, 1);
  assert.equal(whole.pricedCostUsd, 0.003);
  assert.equal(whole.modelCosts![0].costUsd, null);
});

test('a cumulative jump detects missing usage even when every remaining bill has a matching snapshot', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), f.bill('three', 8, 3), f.snapshot(9, 3)]);
  const summary = sessionCostReport(file, { since: f.at(5), until: f.at(6), sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'recorded-gaps');
  assert.equal(summary.requests, 0);
  assert.equal(summary.costUsd, null);
  const before = sessionCostReport(file, {
    until: new Date(Date.parse(f.at(3)) + 1).toISOString(),
    sourceOnly: true,
  }).parent;
  assert.equal(before.coverage, 'recorded-reconciled');
  assert.equal(before.costUsd, 0.003);
});

test('a contradictory complete revision removes its quote even when the revision falls outside the window', () => {
  const f = cumulativeCostFixture();
  const revision = f.bill('one', 12, 1);
  revision.payload.usage = f.usage(2);
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), revision]);
  const summary = sessionCostReport(file, { since: f.at(3), until: f.at(5), byModel: true, sourceOnly: true }).parent;
  assert.equal(summary.requests, 1);
  assert.equal(summary.pricedRequests, 0);
  assert.equal(summary.pricedCostUsd, 0);
  assert.equal(summary.costUsd, null);
  assert.equal(summary.coverage, 'billed-with-unknown-coverage');
  assert.equal(summary.modelCosts![0].costUsd, null);
});

test('a partial bill receives complete cumulative evidence without moving its charging boundary', () => {
  const f = cumulativeCostFixture();
  const partial = {
    type: 'token_usage_record',
    timestamp: f.at(3),
    payload: {
      response_id: 'one',
      turn_id: 'turn-1',
      thread_id: 'parent',
      usage: { input_tokens: 1000 },
    },
  };
  const file = f.save([...f.start, partial, f.snapshot(4, 1), f.bill('one', 9, 1)]);
  const summary = sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent;
  assert.equal(summary.requests, 1);
  assert.equal(summary.coverage, 'recorded-reconciled');
  assert.equal(summary.costUsd, 0.003);
});

test('missing ownership or cumulative counters preserve unknown coverage and the priced subtotal', () => {
  const f = cumulativeCostFixture();
  const causes = {
    thread_id: 'anonymous-evidence',
    thread_token_usage: 'snapshot-unmatched',
    turn_token_usage: 'snapshot-unmatched',
  } as const;
  for (const field of ['thread_id', 'thread_token_usage', 'turn_token_usage'] as const) {
    const bill = f.bill('one', 3, 1);
    const { [field]: omitted, ...payload } = bill.payload;
    assert.ok(omitted);
    const summary = sessionCostReport(f.save([...f.start, { ...bill, payload }, f.snapshot(4, 1)]), {
      sourceOnly: true,
    }).parent;
    assert.equal(summary.coverage, 'billed-with-unknown-coverage');
    assert.equal(summary.costUsd, null);
    assert.equal(summary.pricedCostUsd, 0.003);
    assert.equal(summary.coverageDefect?.cause, causes[field], field);
  }
});

test('a foreign billing thread cannot establish reconciled source coverage', () => {
  const f = cumulativeCostFixture();
  const bill = f.bill('one', 3, 1);
  bill.payload.thread_id = 'foreign';
  const summary = sessionCostReport(f.save([...f.start, bill, f.snapshot(4, 1)]), { sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'billed-with-unknown-coverage');
  assert.equal(summary.costUsd, null);
  assert.equal(summary.pricedCostUsd ?? 0, 0);
  assert.equal(summary.pricedRequests, 0);
  assert.equal(summary.requests, 0);
  const foreign = f.bill('foreign-response', 8, 2);
  foreign.payload.thread_id = 'foreign';
  const mixed = sessionCostReport(
    f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), foreign, f.snapshot(9, 2)]),
    {
      sourceOnly: true,
      byModel: true,
    },
  ).parent;
  assert.equal(mixed.coverage, 'billed-with-unknown-coverage');
  assert.equal(mixed.costUsd, null);
  assert.equal(mixed.pricedCostUsd, 0.003);
  assert.equal(mixed.requests, 1);
  assert.equal(mixed.modelCosts![0].pricedCostUsd, 0.003);
});

test('copied parent metadata does not invalidate the child source cumulative evidence', () => {
  const f = cumulativeCostFixture('child');
  const file = f.save([
    f.start[0],
    { type: 'session_meta', timestamp: f.at(0), payload: { id: 'root-parent', timestamp: f.at(-60) } },
    { ...f.start[1], payload: { ...f.start[1].payload, started_at: Date.parse(f.at(1)) } },
    f.start[2],
    f.bill('one', 3, 1),
    f.snapshot(4, 1),
  ]);
  const summary = sessionCostReport(file, { sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'recorded-reconciled');
  assert.equal(summary.costUsd, 0.003);
});

test('compaction and counter resets preserve earlier reconciled windows and retain later empty uncertainty', () => {
  const f = cumulativeCostFixture();
  const compacted = { type: 'compacted', timestamp: f.at(6), payload: {} };
  for (const boundary of [compacted, f.bill('reset', 6, 1)]) {
    const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), boundary, f.snapshot(7, 1)]);
    const earlier = sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent;
    assert.equal(earlier.coverage, 'recorded-reconciled');
    assert.equal(earlier.costUsd, 0.003);
    const later = sessionCostReport(file, { since: f.at(8), until: f.at(9), sourceOnly: true }).parent;
    assert.equal(later.requests, 0);
    assert.equal(later.costUsd, null);
    assert.equal(later.requestCountExact, false);
    assert.equal(later.coverage, 'billed-with-unknown-coverage');
  }
  const file = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.snapshot(4, 1),
    compacted,
    f.bill('two', 8, 2),
    f.snapshot(9, 2),
  ]);
  const earlier = sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent;
  assert.equal(earlier.coverage, 'recorded-reconciled');
  assert.equal(earlier.costUsd, 0.003);
  const tied = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.snapshot(4, 1),
    { type: 'compacted', timestamp: f.at(8), payload: {} },
    f.bill('restart', 8, 1),
    f.snapshot(9, 1),
  ]);
  const excludedBoundary = sessionCostReport(tied, { since: f.at(3), until: f.at(8), sourceOnly: true }).parent;
  assert.equal(excludedBoundary.coverage, 'recorded-reconciled');
  assert.equal(excludedBoundary.costUsd, 0.003);
  const includedBoundary = sessionCostReport(tied, { since: f.at(8), until: f.at(9), sourceOnly: true }).parent;
  assert.equal(includedBoundary.costUsd, null);
});

test('an explicit baseline after compaction or reset closes prior uncertainty for the restarted window', () => {
  const f = cumulativeCostFixture();
  for (const scenario of [
    { unknown: f.bill('reset', 6, 1), compacted: 8, restart: 10 },
    { unknown: f.snapshot(6, 0), compacted: 8, restart: 10 },
    { unknown: f.snapshot(6, 0), compacted: 6, restart: 6 },
    { unknown: f.snapshot(6, 0), compacted: null, restart: 10 },
  ]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      scenario.unknown,
      ...(scenario.compacted === null ? [] : [{ type: 'compacted', timestamp: f.at(scenario.compacted), payload: {} }]),
      f.bill('restart', scenario.restart, 1),
      f.snapshot(scenario.restart + 1, 1),
      f.bill('next', 12, 2),
      f.snapshot(13, 2),
    ]);
    const before = sessionCostReport(file, { since: f.at(6), until: f.at(7), sourceOnly: true }).parent;
    assert.equal(before.coverage, 'billed-with-unknown-coverage');
    assert.equal(before.costUsd, null);
    const since = Math.max(8, scenario.restart);
    const after = sessionCostReport(file, { since: f.at(since), until: f.at(14), sourceOnly: true }).parent;
    assert.equal(after.coverage, 'recorded-reconciled', JSON.stringify(scenario));
    assert.equal(after.costUsd, scenario.restart < since ? 0.003 : 0.006);
    assert.equal(after.requests, scenario.restart < since ? 1 : 2);
    assert.equal(after.requestCountExact, undefined);
  }
});

test('truncated metadata between valid bills preserves the usable cost report', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1)]);
  fs.appendFileSync(file, '{"type":"session_meta","payload":\n');
  fs.appendFileSync(file, [f.bill('two', 8, 2), f.snapshot(9, 2)].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const summary = sessionCostReport(file, { sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'recorded-reconciled');
  assert.equal(summary.costUsd, 0.006);
  assert.equal(summary.requests, 2);
});

test('an unmatched cumulative-only snapshot survives zero emitted request usage', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), f.snapshot(8, 2, f.usage(0))]);
  const summary = sessionCostReport(file, { since: f.at(5), until: f.at(6), sourceOnly: true }).parent;
  assert.equal(summary.requests, 0);
  assert.equal(summary.coverage, 'recorded-gaps');
  assert.equal(summary.costUsd, null);
  const anonymous = f.save([...f.start, f.snapshot(8, 2, f.usage(0))]);
  assert.equal(sessionCostReport(anonymous, { sourceOnly: true }).parent.coverage, 'unknown-request-coverage');
});

test('unsupported rates retain reconciled recorded identity with unavailable cost', () => {
  const f = cumulativeCostFixture('parent', 'future-model');
  const summary = sessionCostReport(f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1)]), {
    sourceOnly: true,
    byModel: true,
  }).parent;
  assert.equal(summary.coverage, 'recorded-reconciled');
  assert.equal(summary.requestCountExact, undefined);
  assert.equal(summary.costUsd, null);
  assert.equal(summary.pricedCostUsd, 0);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.modelCosts![0].costUsd, null);
});

test('a snapshot counter reset keeps earlier costs and marks later empty windows unknown', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), f.snapshot(6, 0)]);
  const earlier = sessionCostReport(file, { until: f.at(5), sourceOnly: true }).parent;
  assert.equal(earlier.costUsd, 0.003);
  const later = sessionCostReport(file, { since: f.at(8), until: f.at(9), sourceOnly: true }).parent;
  assert.equal(later.costUsd, null);
  assert.equal(later.coverage, 'billed-with-unknown-coverage');
  for (const intermediate of [[], [f.snapshot(6, 2)]]) {
    const repeated = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      f.bill('two', 5, 2),
      ...intermediate,
      f.snapshot(7, 1),
      f.bill('three', 8, 3),
      f.snapshot(9, 3),
    ]);
    const afterReset = sessionCostReport(repeated, { since: f.at(8), until: f.at(10), sourceOnly: true }).parent;
    assert.equal(afterReset.costUsd, null);
    assert.equal(afterReset.coverage, 'billed-with-unknown-coverage');
    assert.equal(afterReset.pricedCostUsd, 0.003);
  }
});

test('backward clocks include the preceding anchor boundary in a cumulative-gap window', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 8, 1), f.snapshot(8, 1), f.bill('three', 4, 3), f.snapshot(4, 3)]);
  const summary = sessionCostReport(file, { since: f.at(8), until: f.at(9), sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'recorded-gaps');
  assert.equal(summary.costUsd, null);
});

test('advancing snapshots below pending billing counters retain later uncertainty', () => {
  const f = cumulativeCostFixture();
  for (const multiple of [1.5, 2]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      f.bill('two', 5, 2),
      ...(multiple === 2 ? [f.bill('three', 6, 3)] : []),
      f.snapshot(7, multiple),
      ...(multiple === 2 ? [] : [f.bill('three', 8, 3)]),
      f.snapshot(9, 3),
    ]);
    const summary = sessionCostReport(file, {
      since: f.at(8),
      until: f.at(10),
      byModel: true,
      sourceOnly: true,
    }).parent;
    assert.equal(summary.costUsd, multiple === 2 ? undefined : null);
    if (multiple !== 2) {
      assert.equal(summary.coverage, 'billed-with-unknown-coverage');
      assert.equal(summary.requestCountExact, false);
      assert.equal(summary.pricedCostUsd, 0.003);
      assert.equal(summary.modelCosts![0].costUsd, null);
    } else {
      const whole = sessionCostReport(file, { byModel: true, sourceOnly: true }).parent;
      assert.equal(whole.costUsd, 0.009);
      assert.equal(whole.coverage, 'recorded-reconciled');
      assert.equal(whole.modelCosts![0].costUsd, 0.009);
    }
  }
});

test('a repaired cumulative bill progresses at its accepted arrival without charging twice', () => {
  const f = cumulativeCostFixture();
  const partial = {
    type: 'token_usage_record',
    timestamp: f.at(4),
    payload: {
      response_id: 'two',
      turn_id: 'turn-1',
      thread_id: 'parent',
      usage: { input_tokens: 1000 },
    },
  };
  const file = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    partial,
    f.snapshot(5, 1),
    f.bill('two', 6, 2),
    f.snapshot(7, 1),
    f.bill('three', 8, 3),
    f.snapshot(9, 3),
  ]);
  const later = sessionCostReport(file, { since: f.at(8), until: f.at(10), byModel: true, sourceOnly: true }).parent;
  assert.equal(later.costUsd, null);
  assert.equal(later.coverage, 'billed-with-unknown-coverage');
  assert.equal(later.pricedCostUsd, 0.003);
  assert.equal(later.requestCountExact, false);
  assert.equal(later.modelCosts![0].costUsd, null);
  const threadRevision = {
    ...partial,
    timestamp: f.at(6),
    payload: { ...partial.payload, thread_token_usage: f.usage(2) },
  };
  const turnRevision = {
    ...partial,
    timestamp: f.at(10),
    payload: { ...partial.payload, turn_token_usage: f.usage(2) },
  };
  const usageRevision = { ...partial, timestamp: f.at(11), payload: { ...partial.payload, usage: f.usage() } };
  const split = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    partial,
    f.snapshot(5, 1),
    threadRevision,
    f.snapshot(7, 1),
    turnRevision,
    usageRevision,
    f.bill('three', 12, 3),
    f.snapshot(13, 3),
  ]);
  const afterSplit = sessionCostReport(split, { since: f.at(12), until: f.at(14), sourceOnly: true }).parent;
  assert.equal(afterSplit.costUsd, null);
  assert.equal(afterSplit.pricedCostUsd, 0.003);
  const charged = sessionCostReport(split, { since: f.at(4), until: f.at(5), sourceOnly: true }).parent;
  assert.equal(charged.requests, 1);
  assert.equal(charged.pricedCostUsd, 0.003);
  const duplicate = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.snapshot(5, 1),
    f.bill('one', 6, 1),
    f.snapshot(7, 1),
    f.bill('two', 8, 2),
    f.snapshot(9, 2),
  ]);
  assert.equal(sessionCostReport(duplicate, { sourceOnly: true }).parent.costUsd, 0.006);
});

test('backward restart clocks preserve both boundaries and empty uncertain windows', () => {
  const f = cumulativeCostFixture();
  for (const priorReset of [false, true]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      ...(priorReset ? [f.snapshot(8, 0)] : []),
      { type: 'compacted', timestamp: f.at(8), payload: {} },
      f.bill('restart', 6, 1),
      f.snapshot(9, 1),
      f.bill('next', 12, 2),
      f.snapshot(13, 2),
    ]);
    for (const since of [6, 7, 8]) {
      const summary = sessionCostReport(file, {
        since: f.at(since),
        until: f.at(since + 1),
        byModel: true,
        sourceOnly: true,
      }).parent;
      assert.equal(summary.costUsd, null);
      assert.equal(summary.coverage, 'billed-with-unknown-coverage');
      assert.equal(summary.requestCountExact, false);
      if (since === 6) {
        assert.equal(summary.pricedCostUsd, 0.003);
        assert.equal(summary.modelCosts![0].costUsd, null);
      } else assert.equal(summary.requests, 0);
    }
    assert.equal(sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent.costUsd, 0.003);
    assert.equal(sessionCostReport(file, { since: f.at(12), until: f.at(14), sourceOnly: true }).parent.costUsd, 0.003);
  }
});

test('an incompatible future baseline preserves reset uncertainty and later recovery', () => {
  const f = cumulativeCostFixture();
  const file = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.snapshot(4, 1),
    f.bill('two', 5, 2),
    f.snapshot(7, 1),
    f.bill('restart', 8, 1),
    f.snapshot(9, 1),
    f.bill('next', 12, 2),
    f.snapshot(13, 2),
  ]);
  const empty = sessionCostReport(file, { since: f.at(7), until: f.at(8), byModel: true, sourceOnly: true });
  assert.equal(empty.parent.coverage, 'billed-with-unknown-coverage');
  assert.equal(empty.parent.costUsd, null);
  assert.equal(empty.parent.requestCountExact, false);
  assert.equal(empty.combined.costUsd, null);
  assert.equal(sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent.costUsd, 0.003);
  const recovered = sessionCostReport(file, { since: f.at(12), until: f.at(14), byModel: true, sourceOnly: true });
  assert.equal(recovered.parent.coverage, 'recorded-reconciled');
  assert.equal(recovered.parent.costUsd, 0.003);
  assert.equal(recovered.parent.requestCountExact, undefined);
  assert.equal(recovered.parent.modelCosts![0].costUsd, 0.003);
  assert.equal(recovered.combined.costUsd, 0.003);
});

test('delayed restart snapshots recover after billing advances without consuming a rejected future match', () => {
  const f = cumulativeCostFixture();
  for (const resetToZero of [true, false]) {
    for (const restartSecond of [8, 7, 6]) {
      for (const early of [false, true]) {
        for (const duplicate of [false, true]) {
          const restart = f.snapshot(resetToZero ? 13 : 11, 1);
          const file = f.save([
            ...f.start,
            f.bill('one', 3, 1),
            f.snapshot(4, 1),
            f.bill('two', 5, 2),
            f.snapshot(7, resetToZero ? 0 : 1, resetToZero ? f.usage(0) : f.usage()),
            f.bill('restart', restartSecond, 1),
            ...(early ? [restart, ...(duplicate ? [restart] : [])] : []),
            f.bill('next', resetToZero ? 12 : 10, 2),
            ...(early ? [] : [restart, ...(duplicate ? [restart] : [])]),
            f.snapshot(resetToZero ? 14 : 12, 2),
            ...(resetToZero ? [] : [f.bill('third', 14, 3), f.snapshot(15, 3)]),
          ]);
          const report = sessionCostReport(file, {
            since: f.at(resetToZero ? 12 : 14),
            until: f.at(resetToZero ? 15 : 16),
            byModel: true,
            sourceOnly: true,
          });
          for (const summary of [report.parent, report.combined, report.parent.modelCosts![0]]) {
            assert.equal(
              summary.coverage,
              'recorded-reconciled',
              JSON.stringify({ resetToZero, restartSecond, early, duplicate }),
            );
            assert.equal(summary.requestCountExact, undefined);
            assert.equal(summary.costUsd, 0.003);
            assert.equal(summary.pricedCostUsd, 0.003);
            assert.equal(summary.requests, 1);
          }
        }
      }
    }
  }
});

test('compatible snapshots before their bills preserve cumulative progression', () => {
  const f = cumulativeCostFixture();
  const file = f.save([
    ...f.start,
    f.snapshot(3, 1),
    f.bill('one', 4, 1),
    f.snapshot(5, 2),
    f.bill('two', 6, 2),
    f.snapshot(7, 0, f.usage(0)),
    f.snapshot(9, 1),
    f.bill('restart', 8, 1),
    f.snapshot(11, 2),
    f.bill('next', 12, 2),
  ]);
  for (const [since, until, cost] of [
    [4, 7, 0.006],
    [12, 14, 0.003],
  ]) {
    const report = sessionCostReport(file, { since: f.at(since), until: f.at(until), byModel: true, sourceOnly: true });
    assert.equal(report.parent.costUsd, cost);
    assert.equal(report.parent.requestCountExact, undefined);
    assert.equal(report.parent.coverage, 'recorded-reconciled');
    assert.equal(report.parent.modelCosts![0].costUsd, cost);
    assert.equal(report.combined.costUsd, cost);
  }
});

test('an unchanged delayed snapshot cannot invent a reset while billing is ahead', () => {
  const f = cumulativeCostFixture();
  for (const duplicate of [[], [f.snapshot(6, 1)]]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.bill('two', 4, 2),
      f.snapshot(5, 1),
      ...duplicate,
      f.snapshot(7, 2),
      f.bill('three', 9, 3),
      f.snapshot(10, 3),
    ]);
    const report = sessionCostReport(file, { since: f.at(9), until: f.at(11), byModel: true, sourceOnly: true });
    assert.equal(report.parent.coverage, 'recorded-reconciled');
    assert.equal(report.parent.costUsd, 0.003);
    assert.equal(report.parent.modelCosts![0].costUsd, 0.003);
    assert.equal(report.combined.costUsd, 0.003);
  }
});

test('a usage-only repair cannot replay inherited cumulative fields after compaction', () => {
  const f = cumulativeCostFixture();
  const partial = f.bill('two', 5, 2);
  const repair = {
    type: 'token_usage_record',
    timestamp: f.at(11),
    payload: {
      thread_id: 'parent',
      turn_id: 'turn-1',
      response_id: 'two',
      usage: f.usage(),
    },
  };
  for (const beforeCompaction of [false, true]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      { ...partial, payload: { ...partial.payload, usage: { input_tokens: 1000 } } },
      f.snapshot(6, 2),
      ...(beforeCompaction ? [repair] : []),
      { type: 'compacted', timestamp: f.at(8), payload: {} },
      f.bill('restart', 9, 1),
      f.snapshot(10, 1),
      ...(beforeCompaction ? [] : [repair]),
      f.snapshot(12, 1),
      f.bill('next', 13, 2),
      f.snapshot(14, 2),
    ]);
    const charged = sessionCostReport(file, { since: f.at(5), until: f.at(6), sourceOnly: true }).parent;
    assert.equal(charged.requests, 1);
    assert.equal(charged.costUsd, 0.003);
    for (const [since, until] of [
      [9, 11],
      [12, 15],
    ]) {
      const report = sessionCostReport(file, {
        since: f.at(since),
        until: f.at(until),
        byModel: true,
        sourceOnly: true,
      });
      assert.equal(report.parent.coverage, 'recorded-reconciled');
      assert.equal(report.parent.costUsd, 0.003);
      assert.equal(report.parent.requestCountExact, undefined);
      assert.equal(report.parent.modelCosts![0].costUsd, 0.003);
      assert.equal(report.combined.costUsd, 0.003);
    }
  }
});

test('a child with only an intersecting unknown interval remains in the combined report', () => {
  const root = directory();
  const parentFixture = cumulativeCostFixture();
  const childFixture = cumulativeCostFixture('child');
  const parent = write(path.join(root, 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    ...parentFixture.start,
    parentFixture.bill('parent-one', 3, 1),
    parentFixture.snapshot(4, 1),
  ]);
  write(path.join(root, 'rollout-2026-09-26T00-00-00-child.jsonl'), [
    { ...childFixture.start[0], payload: { ...childFixture.start[0].payload, parent_thread_id: 'parent' } },
    ...childFixture.start.slice(1),
    childFixture.bill('child-one', 3, 1),
    childFixture.snapshot(4, 1),
    { type: 'compacted', timestamp: childFixture.at(6), payload: {} },
  ]);
  const report = sessionCostReport(parent, {
    since: parentFixture.at(8),
    until: parentFixture.at(9),
    roots: { codexSessions: root, projects: root },
  });
  assert.equal(report.parent.costUsd, undefined);
  assert.equal(report.children.length, 1);
  assert.equal(report.children[0].requests, 0);
  assert.equal(report.children[0].coverage, 'billed-with-unknown-coverage');
  assert.equal(report.combined.costUsd, null);
  assert.equal(report.combined.requestCountExact, false);
});

test('a repeated parent request counts once and keeps its first usage', () => {
  const file = write(path.join(directory(), 'parent.jsonl'), [
    claudeRequest('request-1', 4, ['tool-1']),
    claudeRequest('request-1', 40, ['tool-1', 'tool-2']),
  ]);
  const requests = readSessionRequests(file);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].usage.output, 4);
  assert.equal(requests[0].toolCalls, 2);
});

test('Codex billing records count unique requests alongside matching token snapshots', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model: 'gpt-5.6-terra' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: { response_id: 'ordinary', turn_id: 'turn-1', usage: usage(10, 2) },
    },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage(10, 2), total_token_usage: usage(10, 2) } },
    },
    {
      type: 'token_usage_record',
      timestamp: at(4),
      payload: { response_id: 'same-usage', turn_id: 'turn-1', usage: usage(10, 2) },
    },
    {
      type: 'token_usage_record',
      timestamp: at(5),
      payload: { response_id: 'compaction', turn_id: 'turn-1', usage: usage(168_565, 200) },
    },
    {
      type: 'token_usage_record',
      timestamp: at(5),
      payload: { response_id: 'compaction', turn_id: 'turn-1', usage: usage(168_565, 200) },
    },
    {
      type: 'compacted',
      timestamp: at(6),
      payload: { compaction_response_id: 'compaction', latest_token_usage_record: { usage: usage(168_565, 200) } },
    },
    {
      type: 'event_msg',
      timestamp: at(6),
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-6-sol', model_provider_id: 'openai' },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(7),
      payload: { type: 'token_count', info: { last_token_usage: usage(0, 0), total_token_usage: usage(10, 2) } },
    },
    {
      type: 'token_usage_record',
      timestamp: at(8),
      payload: { response_id: 'unmatched', turn_id: 'turn-1', usage: usage(20, 3) },
    },
  ]);
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const reads = vi.spyOn(nativeFs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    const report = sessionCostReport(file);
    assert.deepEqual(
      reads.mock.calls.map(([root]) => String(root)),
      [defaultRoots.codexSessions],
    );
    assert.equal(report.parent.requests, 4);
    assert.equal(report.parent.uncachedInputTokens, 168_605);
    assert.deepEqual(report.parent.models, ['gpt-5.6-terra', 'gpt-6-sol']);
    assert.equal(report.parent.coverage, 'billed-with-unknown-coverage');
    assert.equal(report.parent.costUsd, null);
    assert.equal(report.parent.snapshotEvidence?.count, 1);
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a delayed copied-turn date removes billing usage from the session report', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'copied' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: { response_id: 'copied-response', turn_id: 'copied', usage },
    },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'task_started', turn_id: 'current' } },
    {
      type: 'turn_context',
      timestamp: at(4),
      payload: { turn_id: 'copied', model: 'gpt-6-sol', current_date: '2026-08-24' },
    },
  ]);
  assert.equal(sessionCostReport(file).parent.requests, 0);
});

test('a delayed copied-turn date removes an earlier failed tool from the report', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'copied' } },
    {
      type: 'event_msg',
      timestamp: at(2),
      payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
    },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'task_started', turn_id: 'current' } },
    {
      type: 'turn_context',
      timestamp: at(4),
      payload: { turn_id: 'copied', model: 'gpt-6-sol', current_date: '2026-08-24' },
    },
  ]);
  const report = sessionCostReport(file);
  assert.equal(report.parent.failedToolCalls, 0);
  assert.equal(report.combined.failedToolCalls, 0);
});

test('a later turn setting does not change a preceding compaction response', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'compact', turn_id: 'first', usage } },
    {
      type: 'compacted',
      timestamp: at(4),
      payload: { compaction_response_id: 'compact', latest_token_usage_record: { usage } },
    },
    { type: 'event_msg', timestamp: at(5), payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: at(6), payload: { type: 'task_started', turn_id: 'second' } },
    {
      type: 'event_msg',
      timestamp: at(7),
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-5.6-terra', model_provider_id: 'amazon-bedrock', service_tier: 'priority' },
      },
    },
  ]);
  const request = readSessionRequests(file).find((request) => request.billingRecord)!;
  assert.deepEqual([request.model, request.provider, request.serviceTier], [null, 'openai', null]);
  assert.equal(request.incomplete, true);
});

test('billing usage receives delayed model metadata and retains pending tools', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'call-a' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'response-a', turn_id: 'first', usage } },
    { type: 'turn_context', timestamp: at(4), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
  ]);
  assert.deepEqual(
    readSessionRequests(file)
      .filter((request) => !request.coverageDefect)
      .map((request) => [request.model, request.toolCalls]),
    [['gpt-6-sol', 1]],
  );
  assert.equal(sessionCostReport(file).parent.pricedRequests, 1);
});

test('Codex compaction billing keeps model identities across response ID shapes and native arrival orders', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 3000,
    cached_input_tokens: 2000,
    cache_write_input_tokens: 0,
    output_tokens: 30,
    reasoning_output_tokens: 0,
    total_tokens: 3030,
  };
  for (const identity of [{ model: 'openai.gpt-6-astra' }, { model: '', model_id: 'openai.gpt-6-astra' }])
    for (const explicit of [true, false])
      for (const nativeFirst of [true, false]) {
        const native = {
          type: 'token_usage_record',
          timestamp: at(nativeFirst ? 3 : 6),
          payload: { response_id: 'compact', turn_id: 'turn', usage },
        };
        const compact = {
          type: 'compacted',
          timestamp: at(4),
          payload: {
            ...(explicit ? { compaction_response_id: 'compact' } : {}),
            latest_token_usage_record: { response_id: 'compact', usage },
          },
        };
        const settings = {
          type: 'event_msg',
          timestamp: at(5),
          payload: {
            type: 'thread_settings_applied',
            thread_settings: {
              ...identity,
              model_provider_id: 'amazon-bedrock',
              service_tier: 'standard',
            },
          },
        };
        const file = write(path.join(directory(), 'rollout-parent.jsonl'), [
          {
            type: 'session_meta',
            timestamp: at(0),
            payload: { id: 'parent', source: 'cli', model_provider: 'openai' },
          },
          { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn' } },
          { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn', model: 'gpt-5.6-sol' } },
          ...(nativeFirst ? [native, compact, settings] : [compact, settings, native]),
        ]);
        const request = readSessionRequests(file).find((request) => request.billingRecord)!;
        assert.deepEqual(
          [request.model, request.provider, request.serviceTier, request.inferenceClass],
          ['openai.gpt-6-astra', 'amazon-bedrock', 'standard', 'in-region'],
        );
        assert.equal(request.compactionUsage, true);
        assert.equal(request.incomplete, undefined);
      }
});

test('identified compaction usage keeps its priced subtotal beside a native normal bill', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (input: number, cached: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const normal = usage(100, 40, 10);
  const compact = usage(3000, 2000, 30);
  for (const nativeCompaction of [false, true]) {
    const file = write(path.join(directory(), 'rollout-parent.jsonl'), [
      { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
      { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn' } },
      { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn', model: 'gpt-5.6-sol' } },
      {
        type: 'event_msg',
        timestamp: at(3),
        payload: { type: 'token_count', info: { last_token_usage: normal, total_token_usage: normal } },
      },
      {
        type: 'token_usage_record',
        timestamp: at(4),
        payload: {
          thread_id: 'parent',
          session_id: 'parent',
          turn_id: 'turn',
          response_id: 'normal',
          usage: normal,
          thread_token_usage: normal,
          turn_token_usage: normal,
        },
      },
      {
        type: 'compacted',
        timestamp: at(5),
        payload: { compaction_response_id: 'compact', latest_token_usage_record: { usage: compact } },
      },
      {
        type: 'event_msg',
        timestamp: at(6),
        payload: {
          type: 'thread_settings_applied',
          thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai' },
        },
      },
      ...(nativeCompaction
        ? [
            {
              type: 'token_usage_record',
              timestamp: at(7),
              payload: { thread_id: 'parent', turn_id: 'turn', response_id: 'compact', usage: compact },
            },
          ]
        : []),
      {
        type: 'event_msg',
        timestamp: at(8),
        payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'Complete.' },
      },
    ]);
    const requests = readSessionRequests(file);
    const summary = summarizeRequests(requests);
    assert.equal(summary.pricedRequests, 2);
    assert.equal(summary.pricedCostUsd, 0.014);
    assert.equal(requests.filter((request) => request.compactionUsage && !request.evidenceOnly).length, 1);
    assert.equal(summary.costUsd, null);
    assert.equal(summary.coverage, 'billed-with-unknown-coverage');
  }
});

// Usage vectors from the first compaction of a recorded Codex rollout: input, cached, cache write, output, reasoning.
const RECORDED_COMPACTION = {
  before: [253_027, 250_624, 0, 239, 31],
  compaction: [255_583, 252_800, 0, 6_664, 0],
  after: [35_516, 12_544, 0, 413, 27],
  next: [45_415, 35_328, 0, 162, 56],
} as const;

function compactionCostFixture(id = 'parent') {
  const f = cumulativeCostFixture(id);
  const counters = (vector: readonly number[]) => ({
    input_tokens: vector[0],
    cached_input_tokens: vector[1],
    cache_write_input_tokens: vector[2],
    output_tokens: vector[3],
    reasoning_output_tokens: vector[4],
    total_tokens: vector[0] + vector[3],
  });
  const add = (...vectors: (readonly number[])[]) =>
    vectors.reduce<number[]>((sum, vector) => sum.map((value, index) => value + vector[index]), [0, 0, 0, 0, 0]);
  const bill = (response: string, second: number, usage: readonly number[], thread: readonly number[]) => ({
    type: 'token_usage_record',
    timestamp: f.at(second),
    payload: {
      thread_id: id,
      session_id: 'root-parent',
      turn_id: 'turn-1',
      response_id: response,
      usage: counters(usage),
      thread_token_usage: counters(thread),
      turn_token_usage: counters(thread),
    },
  });
  const snapshot = (second: number, total: readonly number[], last: object) => ({
    type: 'event_msg',
    timestamp: f.at(second),
    payload: { type: 'token_count', info: { total_token_usage: counters(total), last_token_usage: last } },
  });
  // Codex reports zero request counters and the new context size after a compaction.
  const zeroLast = { ...counters([0, 0, 0, 0, 0]), total_tokens: 30_094 };
  const compacted = (second: number, response: string, usage: readonly number[], thread: readonly number[]) => ({
    type: 'compacted',
    timestamp: f.at(second),
    payload: {
      message: '',
      compaction_response_id: response,
      latest_token_usage_record: {
        thread_id: id,
        turn_id: 'turn-1',
        response_id: response,
        usage: counters(usage),
        thread_token_usage: counters(thread),
        turn_token_usage: counters(thread),
      },
    },
  });
  const settings = (second: number) => ({
    type: 'event_msg',
    timestamp: f.at(second),
    payload: { type: 'thread_settings_applied', thread_id: id, thread_settings: { model: 'gpt-6-sol' } },
  });
  // One compaction between two reconciled requests on each side. Thread totals include the compaction
  // request. Snapshot totals exclude it.
  const records = (
    options: {
      nativeAfter?: boolean;
      withoutCompactionBill?: boolean;
      withoutZeroSnapshot?: boolean;
      afterExtraInput?: number;
      // Fields that replace the compacted record's copy of the compaction bill.
      copy?: Record<string, unknown>;
    } = {},
  ) => {
    const { before, compaction, after, next } = RECORDED_COMPACTION;
    const compactionThread = add(before, compaction);
    const compactionBill = options.withoutCompactionBill
      ? []
      : [bill('compaction', options.nativeAfter ? 7 : 6, compaction, compactionThread)];
    const compactedRecord = compacted(options.nativeAfter ? 6 : 7, 'compaction', compaction, compactionThread);
    Object.assign(compactedRecord.payload.latest_token_usage_record, options.copy);
    const record = [compactedRecord, settings(options.nativeAfter ? 6 : 7)];
    const afterThread = add(compactionThread, after, [options.afterExtraInput ?? 0, 0, 0, 0, 0]);
    return [
      ...f.start,
      bill('before', 3, before, before),
      snapshot(4, before, counters(before)),
      ...(options.nativeAfter ? [...record, ...compactionBill] : [...compactionBill, ...record]),
      ...(options.withoutZeroSnapshot ? [] : [snapshot(8, before, zeroLast)]),
      bill('after', 10, after, afterThread),
      snapshot(11, add(before, after), counters(after)),
      bill('next', 12, next, add(compactionThread, after, next)),
      snapshot(13, add(before, after, next), counters(next)),
    ];
  };
  return { ...f, counters, add, bill, snapshot, zeroLast, compacted, settings, records };
}

test('an identified Codex compaction bill keeps the parent reconciled in every window around the compaction', () => {
  for (const nativeAfter of [false, true]) {
    const f = compactionCostFixture();
    const file = f.save(f.records({ nativeAfter }));
    const label = JSON.stringify({ nativeAfter });
    const requests = readSessionRequests(file);
    assert.equal(requests.filter((request) => request.compactionUsage && !request.evidenceOnly).length, 1, label);
    const whole = sessionCostReport(file, { sourceOnly: true, byModel: true }).parent;
    assert.equal(whole.coverage, 'recorded-reconciled', label);
    assert.equal(whole.requests, 4, label);
    assert.equal(whole.requestCountExact, undefined, label);
    assert.equal(typeof whole.costUsd, 'number', label);
    assert.equal(whole.costUsd, whole.pricedCostUsd, label);
    assert.equal(whole.contextMax, RECORDED_COMPACTION.compaction[0], label);
    assert.equal(whole.contextFirst, RECORDED_COMPACTION.before[0], label);
    assert.equal(whole.coverageDefect, undefined, label);
    const ending = sessionCostReport(file, { until: f.at(9), sourceOnly: true }).parent;
    assert.equal(ending.coverage, 'recorded-reconciled', label);
    assert.equal(ending.requests, 2, label);
    assert.equal(typeof ending.costUsd, 'number', label);
    const starting = sessionCostReport(file, { since: f.at(9), sourceOnly: true }).parent;
    assert.equal(starting.coverage, 'recorded-reconciled', label);
    assert.equal(starting.requests, 2, label);
    assert.equal(typeof starting.costUsd, 'number', label);
    assert.equal(starting.contextFirst, RECORDED_COMPACTION.after[0], label);
    assert.equal(starting.contextMax, RECORDED_COMPACTION.next[0], label);
    const empty = sessionCostReport(file, { since: f.at(9), until: f.at(9), sourceOnly: true }).parent;
    assert.equal(empty.requests, 0, label);
    assert.equal(empty.costUsd, undefined, label);
    assert.equal(empty.coverage, undefined, label);
  }
});

test('Codex reconciliation continues through several compactions and stops at a genuine counter reset', () => {
  const f = compactionCostFixture();
  const { before, compaction, after } = RECORDED_COMPACTION;
  const second = [276_066, 271_104, 0, 8_480, 0];
  const first = f.add(before, compaction);
  const middle = f.add(first, after);
  const secondThread = f.add(middle, second);
  const last = f.add(secondThread, after);
  const reset = [1_000, 0, 0, 100, 0];
  const file = f.save([
    ...f.start,
    f.bill('before', 3, before, before),
    f.snapshot(4, before, f.counters(before)),
    f.bill('compaction-1', 5, compaction, first),
    f.compacted(6, 'compaction-1', compaction, first),
    f.settings(6),
    f.snapshot(7, before, f.zeroLast),
    f.bill('after-1', 8, after, middle),
    f.snapshot(9, f.add(before, after), f.counters(after)),
    f.bill('compaction-2', 10, second, secondThread),
    f.compacted(11, 'compaction-2', second, secondThread),
    f.settings(11),
    f.snapshot(12, f.add(before, after), f.zeroLast),
    f.bill('after-2', 13, after, last),
    f.snapshot(14, f.add(before, after, after), f.counters(after)),
    f.snapshot(15, [0, 0, 0, 0, 0], f.counters([0, 0, 0, 0, 0])),
    f.bill('restart', 16, reset, reset),
    f.snapshot(17, reset, f.counters(reset)),
    // A compaction after the new baseline must not carry the offsets gained before the reset.
    f.bill('compaction-3', 18, second, f.add(reset, second)),
    f.compacted(19, 'compaction-3', second, f.add(reset, second)),
    f.settings(19),
    f.snapshot(20, reset, f.zeroLast),
    f.bill('after-3', 21, after, f.add(reset, second, after)),
    f.snapshot(22, f.add(reset, after), f.counters(after)),
  ]);
  const reconciled = sessionCostReport(file, { until: f.at(15), sourceOnly: true }).parent;
  assert.equal(reconciled.coverage, 'recorded-reconciled');
  assert.equal(reconciled.requests, 5);
  assert.equal(typeof reconciled.costUsd, 'number');
  const resetWindow = sessionCostReport(file, { since: f.at(15), until: f.at(16), sourceOnly: true }).parent;
  assert.equal(resetWindow.coverage, 'billed-with-unknown-coverage');
  assert.equal(resetWindow.costUsd, null);
  assert.deepEqual(resetWindow.coverageDefect, {
    kind: 'billed-with-unknown-coverage',
    since: f.at(15),
    cause: 'reset',
  });
  const restarted = sessionCostReport(file, { since: f.at(16), sourceOnly: true }).parent;
  assert.equal(restarted.coverage, 'recorded-reconciled');
  assert.equal(restarted.requests, 3);
  assert.equal(typeof restarted.costUsd, 'number');
  assert.equal(restarted.coverageDefect, undefined);
  const latest = sessionCostReport(file, { since: f.at(21), sourceOnly: true }).parent;
  assert.equal(latest.coverage, 'recorded-reconciled');
  assert.equal(latest.requests, 1);
  assert.equal(typeof latest.costUsd, 'number');
});

test('Codex counters that advance by less than the bill are not reported as a reset', () => {
  const f = compactionCostFixture();
  const first = [1_000, 0, 0, 100, 0];
  const second = [400, 0, 0, 40, 0];
  const shortfall = [200, 0, 0, 20, 0];
  const file = f.save([
    ...f.start,
    f.bill('first', 3, first, first),
    f.snapshot(4, first, f.counters(first)),
    f.bill('second', 5, second, f.add(first, shortfall)),
    f.snapshot(6, f.add(first, shortfall), f.counters(second)),
  ]);
  const summary = sessionCostReport(file, { since: f.at(5), sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'billed-with-unknown-coverage');
  assert.equal(summary.costUsd, null);
  assert.deepEqual(summary.coverageDefect, {
    kind: 'billed-with-unknown-coverage',
    since: f.at(5),
    cause: 'cumulative-jump',
  });
});

test('an unexplained Codex compaction offset keeps the full cost unknown', () => {
  for (const options of [{ afterExtraInput: 1 }, { withoutCompactionBill: true }, { withoutZeroSnapshot: true }]) {
    const f = compactionCostFixture();
    const file = f.save(f.records(options));
    const label = JSON.stringify(options);
    for (const window of [{}, { since: f.at(9) }]) {
      const summary = sessionCostReport(file, { ...window, sourceOnly: true }).parent;
      assert.notEqual(summary.coverage, 'recorded-reconciled', label);
      assert.notEqual(summary.coverage, undefined, label);
      assert.equal(summary.costUsd, null, label);
      assert.equal(summary.requestCountExact, false, label);
      assert.equal(summary.contextMax, null, label);
    }
    const earlier = sessionCostReport(file, { until: f.at(5), sourceOnly: true }).parent;
    assert.equal(earlier.coverage, 'recorded-reconciled', label);
    assert.equal(typeof earlier.costUsd, 'number', label);
  }
});

test('a compacted record whose bill copy disagrees with the native bill keeps the full cost unknown', () => {
  const { compaction, before } = RECORDED_COMPACTION;
  const f = compactionCostFixture();
  const variants = {
    usage: { usage: f.counters(f.add(compaction, compaction)) },
    thread: { thread_id: 'foreign' },
    response: { response_id: 'other-response' },
    cumulative: { thread_token_usage: f.counters(f.add(before, compaction, [1, 0, 0, 0, 0])) },
  };
  for (const nativeAfter of [false, true]) {
    for (const [name, copy] of Object.entries(variants)) {
      const file = f.save(f.records({ nativeAfter, copy }));
      const label = JSON.stringify({ nativeAfter, name });
      for (const window of [{}, { since: f.at(9) }]) {
        const summary = sessionCostReport(file, { ...window, sourceOnly: true }).parent;
        assert.equal(summary.coverage, 'billed-with-unknown-coverage', label);
        assert.equal(summary.costUsd, null, label);
        assert.equal(summary.requestCountExact, false, label);
        assert.equal(summary.coverageDefect?.kind, 'billed-with-unknown-coverage', label);
      }
    }
  }
});

test('the coverage diagnostic names the first unresolved interval and its cause', () => {
  const f = compactionCostFixture();
  const unmatched = f.save(f.records({ withoutCompactionBill: true }));
  for (const window of [{}, { since: f.at(9) }]) {
    const report = sessionCostReport(unmatched, { ...window, sourceOnly: true, byModel: true });
    assert.deepEqual(report.parent.coverageDefect, {
      kind: 'billed-with-unknown-coverage',
      since: f.at(7),
      cause: 'compaction-unmatched',
    });
    for (const row of report.parent.modelCosts!) assert.equal('coverageDefect' in row, false);
    assert.equal(report.combined.coverageDefect, undefined);
  }
  const legacy = cumulativeCostFixture('legacy');
  const file = legacy.save([...legacy.start, legacy.snapshot(4, 1)]);
  const summary = sessionCostReport(file, { sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'legacy-snapshots');
  assert.deepEqual(summary.coverageDefect, { kind: 'legacy-snapshots', since: null, cause: 'legacy-snapshots' });
  // An unmatched bill precedes a cumulative jump. The gap sets the kind, and the earlier interval sets the rest.
  const mixed = cumulativeCostFixture();
  const jump = sessionCostReport(
    mixed.save([
      ...mixed.start,
      mixed.bill('one', 3, 1),
      mixed.snapshot(4, 1),
      mixed.bill('two', 5, 2),
      mixed.bill('three', 6, 3),
      mixed.snapshot(7, 3),
      mixed.bill('five', 8, 5),
      mixed.snapshot(9, 5),
    ]),
    { sourceOnly: true },
  ).parent;
  assert.deepEqual(jump.coverageDefect, { kind: 'recorded-gaps', since: mixed.at(5), cause: 'snapshot-unmatched' });
});

test('parent, child, combined, and model figures agree for a reconciled compaction', () => {
  const root = directory();
  const f = compactionCostFixture();
  const child = cumulativeCostFixture('child');
  const parent = write(path.join(root, 'rollout-2026-09-26T00-00-00-parent.jsonl'), f.records());
  write(path.join(root, 'rollout-2026-09-26T00-00-00-child.jsonl'), [
    { ...child.start[0], payload: { ...child.start[0].payload, parent_thread_id: 'parent' } },
    ...child.start.slice(1),
    child.bill('child-one', 3, 1),
    child.snapshot(4, 1),
  ]);
  const report = sessionCostReport(parent, { roots: { codexSessions: root, projects: root }, byModel: true });
  assert.equal(report.parent.coverage, 'recorded-reconciled');
  assert.equal(report.parent.requests, 4);
  assert.equal(typeof report.parent.costUsd, 'number');
  assert.equal(report.children.length, 1);
  assert.equal(report.children[0].coverage, 'recorded-reconciled');
  assert.equal(report.children[0].costUsd, 0.003);
  assert.equal(report.combined.coverage, 'recorded-reconciled');
  assert.equal(report.combined.requests, 5);
  assert.equal(report.combined.costUsd, Math.round((report.parent.costUsd! + 0.003) * 10_000) / 10_000);
  assert.equal(report.combined.contextMax, RECORDED_COMPACTION.compaction[0]);
  const rows = report.parent.modelCosts!;
  assert.deepEqual(
    rows.map((row) => [row.model, row.requests, row.costUsd]),
    [['gpt-6-sol', 4, report.parent.costUsd]],
  );
  for (const row of [...rows, ...report.children[0].modelCosts!]) assert.equal('coverageDefect' in row, false);
});

function cacheExpiryCostFixture() {
  const f = compactionCostFixture();
  const usage = [100_000, 90_000, 0, 500, 0];
  const records = (
    options: { withoutFirst?: boolean; withoutFirstSnapshot?: boolean; withoutSecondSnapshot?: boolean } = {},
  ) => {
    const gap = 31 * 60;
    // An unmatched first bill needs an earlier reconciled baseline, so its successor still reconciles.
    const base = options.withoutFirstSnapshot ? usage : [0, 0, 0, 0, 0];
    return [
      ...f.start,
      ...(options.withoutFirstSnapshot
        ? [f.bill('opening', 2, usage, usage), f.snapshot(2, usage, f.counters(usage))]
        : []),
      ...(options.withoutFirst ? [] : [f.bill('first', 3, usage, f.add(base, usage))]),
      ...(options.withoutFirst || options.withoutFirstSnapshot
        ? []
        : [f.snapshot(4, f.add(base, usage), f.counters(usage))]),
      f.bill('second', 3 + gap, usage, f.add(base, usage, usage)),
      ...(options.withoutSecondSnapshot ? [] : [f.snapshot(4 + gap, f.add(base, usage, usage), f.counters(usage))]),
    ];
  };
  return { ...f, records, gap: 31 * 60 };
}

test('a reconciled Codex source prices its cache-expiry return', () => {
  const f = cacheExpiryCostFixture();
  const summary = sessionCostReport(f.save(f.records()), { sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'recorded-reconciled');
  assert.equal(summary.cacheExpiry!.coverage, 'complete');
  assert.equal(summary.cacheExpiry!.returns, 1);
  assert.equal(summary.cacheExpiry!.longestGapSeconds, f.gap);
  assert.equal(typeof summary.cacheExpiry!.extraCostAfterExpiryUsd, 'number');
  assert.equal(typeof summary.cacheExpiry!.inputCostAfterExpiryUsd, 'number');
  assert.equal(summary.toolCalls, null);
  assert.equal(summary.requestsWithTwoOrMoreTools, null);
});

test('cache expiry uses the request before the window and stays unknown when that request is unknown', () => {
  const f = cacheExpiryCostFixture();
  const since = f.at(10);
  const windowed = sessionCostReport(f.save(f.records()), { since, sourceOnly: true }).parent;
  assert.equal(windowed.requests, 1);
  assert.equal(windowed.coverage, 'recorded-reconciled');
  assert.equal(windowed.cacheExpiry!.coverage, 'complete');
  assert.equal(windowed.cacheExpiry!.returns, 1);
  assert.equal(typeof windowed.cacheExpiry!.extraCostAfterExpiryUsd, 'number');
  const unmatched = sessionCostReport(f.save(f.records({ withoutFirstSnapshot: true })), { since, sourceOnly: true });
  assert.equal(unmatched.parent.coverage, 'recorded-reconciled');
  assert.equal(unmatched.parent.cacheExpiry!.coverage, 'unknown-request-coverage');
  assert.equal(unmatched.parent.cacheExpiry!.extraCostAfterExpiryUsd, null);
  const missing = sessionCostReport(f.save(f.records({ withoutFirst: true })), { since, sourceOnly: true }).parent;
  assert.equal(missing.cacheExpiry!.coverage, 'unknown-request-coverage');
  assert.equal(missing.cacheExpiry!.extraCostAfterExpiryUsd, null);
  const unknown = sessionCostReport(f.save(f.records({ withoutSecondSnapshot: true })), { sourceOnly: true }).parent;
  assert.equal(unknown.coverage, 'billed-with-unknown-coverage');
  assert.equal(unknown.cacheExpiry!.coverage, 'unknown-request-coverage');
  assert.equal(unknown.cacheExpiry!.inputCostAfterExpiryUsd, null);
});

test('equal billing usage on separate responses does not merge across a preceding snapshot', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'event_msg',
      timestamp: at(3),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    {
      type: 'token_usage_record',
      timestamp: at(4),
      payload: { response_id: 'later-response', turn_id: 'first', usage },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.requests, 1);
  assert.equal(summary.snapshotEvidence?.count, 1);
  assert.equal(summary.costUsd, null);
});

test('one bill and a later equal snapshot retain separate evidence without inventing a second bill', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'bill', turn_id: 'first', usage } },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ]);
  const report = sessionCostReport(file);
  assert.deepEqual(
    [report.parent.requests, report.parent.snapshotEvidence?.count, report.parent.uncachedInputTokens],
    [1, 1, 10],
  );
  assert.equal(report.parent.coverage, 'billed-with-unknown-coverage');
  assert.equal(report.parent.costUsd, null);
  assert.equal(report.parent.pricedRequests, 1);
  assert.equal(report.parent.costPerRequest, null);
  assert.equal(report.parent.requestsWithTwoOrMoreTools, null);
  const beforeSnapshot = sessionCostReport(file, { until: at(4) }).parent;
  assert.deepEqual([beforeSnapshot.requests, beforeSnapshot.snapshotEvidence], [1, undefined]);
  const afterBill = sessionCostReport(file, { since: at(4) }).parent;
  assert.deepEqual([afterBill.requests, afterBill.snapshotEvidence?.count], [0, 1]);
  assert.equal(afterBill.coverage, 'billed-with-unknown-coverage');
  assert.equal(afterBill.toolCalls, null);
});

test('two bills before two snapshots price only the two identified responses', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'one', turn_id: 'first', usage } },
    { type: 'token_usage_record', timestamp: at(4), payload: { response_id: 'two', turn_id: 'first', usage } },
    {
      type: 'event_msg',
      timestamp: at(5),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    {
      type: 'event_msg',
      timestamp: at(6),
      payload: {
        type: 'token_count',
        info: { last_token_usage: usage, total_token_usage: { ...usage, input_tokens: 20 } },
      },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.deepEqual([summary.requests, summary.snapshotEvidence?.count, summary.uncachedInputTokens], [2, 2, 20]);
  assert.equal(summary.costUsd, null);
});

test('a partial billed response stays unpriced', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: { response_id: 'partial', turn_id: 'first', usage: { input_tokens: 10, output_tokens: 2 } },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.deepEqual(
    [summary.requests, summary.pricedRequests, summary.unpricedRequests, summary.pricedCostUsd],
    [1, 0, 1, 0],
  );
  assert.equal(summary.costUsd, null);
  assert.equal(summary.uncachedInputTokens, 10);
  assert.equal(summary.outputTokens, 2);
});

test('a complete revision repairs a partial bill, while malformed counters remain unpriced', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: { response_id: 'bill', turn_id: 'first', usage: { input_tokens: 10, output_tokens: 2 } },
    },
  ];
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  assert.equal(sessionCostReport(file, { sourceOnly: true }).parent.unpricedRequests, 1);
  records.push({
    type: 'token_usage_record',
    timestamp: at(4),
    payload: {
      response_id: 'bill',
      turn_id: 'first',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    },
  });
  write(file, records);
  assert.deepEqual(
    [
      sessionCostReport(file, { sourceOnly: true }).parent.pricedRequests,
      sessionCostReport(file, { sourceOnly: true }).parent.uncachedInputTokens,
    ],
    [1, 10],
  );
  records.push({
    type: 'token_usage_record',
    timestamp: at(5),
    payload: {
      response_id: 'bad',
      turn_id: 'first',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 11,
        cache_write_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    },
  });
  write(file, records);
  assert.deepEqual(
    [
      sessionCostReport(file, { sourceOnly: true }).parent.pricedRequests,
      sessionCostReport(file, { sourceOnly: true }).parent.unpricedRequests,
    ],
    [1, 1],
  );
});

test('a duplicate bill leaves later response tools pending', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'one', turn_id: 'first', usage } },
    { type: 'response_item', timestamp: at(4), payload: { type: 'custom_tool_call', call_id: 'later-tool' } },
    { type: 'token_usage_record', timestamp: at(5), payload: { response_id: 'one', turn_id: 'first', usage } },
    { type: 'token_usage_record', timestamp: at(6), payload: { response_id: 'two', turn_id: 'first', usage } },
  ]);
  assert.deepEqual(
    readSessionRequests(file)
      .filter((request) => request.billingRecord)
      .map((request) => request.toolCalls),
    [0, 1],
  );
});

test('a Codex child with only a tool call retains its unattributed tool evidence', () => {
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-child.jsonl'), [
    {
      type: 'session_meta',
      timestamp: '2026-09-26T00:00:00Z',
      payload: { id: 'child', source: 'cli', model_provider: 'openai' },
    },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'first' } },
    {
      type: 'response_item',
      timestamp: '2026-09-26T00:00:02Z',
      payload: { type: 'custom_tool_call', call_id: 'tool' },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.requests, 0);
  assert.equal(summary.unattributedToolCalls, 1);
  assert.equal(summary.toolCalls, null);
});

test('a partial token snapshot and its billing record count one request', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'response-a', turn_id: 'first', usage } },
    { type: 'event_msg', timestamp: at(4), payload: { type: 'token_count', info: { total_token_usage: usage } } },
  ]);
  const report = sessionCostReport(file);
  assert.equal(report.parent.requests, 1);
  assert.equal(report.parent.uncachedInputTokens, 10);
  assert.equal(report.parent.unpricedRequests, 0);
});

test('a Codex compaction zero-token snapshot preserves unidentified compaction coverage', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'token_usage_record', timestamp: at(2), payload: { usage: usage(168_565, 200) } },
    { type: 'compacted', timestamp: at(3), payload: { latest_token_usage_record: { usage: usage(168_565, 200) } } },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage(0, 0), total_token_usage: usage(0, 0) } },
    },
  ]);
  assert.deepEqual(
    readSessionRequests(file)
      .filter((request) => !request.coverageDefect)
      .map((request) => request.incomplete),
    [true],
  );
  assert.equal(sessionCostReport(file).parent.requests, 1);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'event_msg',
      timestamp: at(5),
      payload: { type: 'token_count', info: { total_token_usage: usage(10, 2) } },
    }) + '\n',
  );
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.requests, 2);
  assert.equal(summary.unpricedRequests, 2);
  assert.equal(summary.costUsd, null);
});

test('a compaction snapshot retains 64 requests awaiting model metadata', () => {
  const at = (millisecond: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, 0, millisecond)).toISOString();
  const usage = (input: number, output = 2) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
  ];
  for (let index = 0; index < 64; index++) {
    records.push({
      type: 'event_msg',
      timestamp: at(index + 2),
      payload: {
        type: 'token_count',
        info: { last_token_usage: usage(10), total_token_usage: usage((index + 1) * 10, (index + 1) * 2) },
      },
    });
  }
  records.push(
    { type: 'compacted', timestamp: at(66), payload: {} },
    {
      type: 'event_msg',
      timestamp: at(67),
      payload: { type: 'token_count', info: { last_token_usage: usage(0, 0), total_token_usage: usage(640, 128) } },
    },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  const requests = readSessionRequests(file);
  assert.equal(requests.filter((request) => !request.coverageDefect).length, 64);
  assert.equal(requests[0].usage.input, 10);
  assert.equal(sessionCostReport(file).parent.requests, 64);
});

test('old copied turns lose both billed and snapshot usage while a replay keeps its original bill', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
  ];
  for (const id of ['original', 'copied']) {
    records.push(
      { type: 'event_msg', timestamp: at(records.length), payload: { type: 'task_started', turn_id: id } },
      { type: 'turn_context', timestamp: at(records.length + 1), payload: { turn_id: id, model: 'gpt-6-sol' } },
      {
        type: 'token_usage_record',
        timestamp: at(records.length + 2),
        payload: { response_id: id, turn_id: id, usage },
      },
      {
        type: 'event_msg',
        timestamp: at(records.length + 3),
        payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
      },
    );
  }
  for (let index = 0; index < 65; index++) {
    records.push({
      type: 'event_msg',
      timestamp: at(records.length),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  }
  records.push(
    {
      type: 'turn_context',
      timestamp: at(500),
      payload: { turn_id: 'copied', model: 'gpt-6-sol', current_date: '2026-08-24' },
    },
    { type: 'event_msg', timestamp: at(501), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'turn_context', timestamp: at(501), payload: { turn_id: 'original', model: 'gpt-5.6-terra' } },
    { type: 'token_usage_record', timestamp: at(502), payload: { response_id: 'replay', turn_id: 'original', usage } },
    {
      type: 'event_msg',
      timestamp: at(503),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  );
  const requests = readSessionRequests(
    write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records),
  );
  assert.deepEqual(
    requests.filter((request) => !request.evidenceOnly).map((request) => request.requestKey),
    ['codex-billing:original'],
  );
  assert.equal(requests.find((request) => request.billingRecord)?.model, 'gpt-6-sol');
});

test('replayed model metadata cannot price an original bill without a model', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: { response_id: 'original-response', turn_id: 'original', usage },
    },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 3),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push(
    { type: 'event_msg', timestamp: at(68), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'turn_context', timestamp: at(69), payload: { turn_id: 'original', model: 'gpt-6-astra' } },
    {
      type: 'token_usage_record',
      timestamp: at(70),
      payload: { response_id: 'replayed-response', turn_id: 'original', usage },
    },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  const requests = readSessionRequests(file).filter((request) => request.billingRecord);
  assert.deepEqual(
    requests.map((request) => [request.requestKey, request.model]),
    [['codex-billing:original-response', null]],
  );
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.costUsd, null);
});

test('original turn metadata prices its bill while another turn replays', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: { response_id: 'original-bill', turn_id: 'original', usage },
    },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'task_started', turn_id: 'other' } },
    { type: 'event_msg', timestamp: at(4), payload: { type: 'task_started', turn_id: 'other' } },
    { type: 'turn_context', timestamp: at(5), payload: { turn_id: 'original', model: 'gpt-6-sol' } },
  ]);
  const requests = readSessionRequests(file).filter((request) => request.billingRecord);
  assert.deepEqual(
    requests.map((request) => [request.requestKey, request.model]),
    [['codex-billing:original-bill', 'gpt-6-sol']],
  );
  assert.equal(sessionCostReport(file).parent.unpricedRequests, 0);
});

test('replayed turn metadata cannot price its original bill after another turn starts', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: { response_id: 'original-bill', turn_id: 'original', usage },
    },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 3),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push(
    { type: 'event_msg', timestamp: at(68), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'event_msg', timestamp: at(69), payload: { type: 'task_started', turn_id: 'next' } },
    { type: 'turn_context', timestamp: at(70), payload: { turn_id: 'original', model: 'gpt-6-astra' } },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  assert.deepEqual(
    readSessionRequests(file)
      .filter((request) => request.billingRecord)
      .map((request) => [request.requestKey, request.model]),
    [['codex-billing:original-bill', null]],
  );
  assert.equal(sessionCostReport(file).parent.unpricedRequests, 1);
});

test('replayed context cannot price an earlier anonymous snapshot after another turn starts', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'event_msg',
      timestamp: at(2),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 3),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push(
    { type: 'event_msg', timestamp: at(68), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'event_msg', timestamp: at(69), payload: { type: 'task_started', turn_id: 'next' } },
    { type: 'turn_context', timestamp: at(70), payload: { turn_id: 'original', model: 'gpt-6-astra' } },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.model),
    [null],
  );
  assert.equal(sessionCostReport(file).parent.unpricedRequests, 1);
});

test('replayed context does not release an anonymous original snapshot at its new model', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'event_msg',
      timestamp: at(2),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'event_msg', timestamp: at(4), payload: { type: 'task_started', turn_id: 'next' } },
    { type: 'turn_context', timestamp: at(5), payload: { turn_id: 'original', model: 'gpt-6-astra' } },
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.model),
    [null],
  );
});

test('replayed Codex snapshot and failed completion do not add usage or failures after 65 turns', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'original', model: 'gpt-6-sol' } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'original-tool' } },
    {
      type: 'event_msg',
      timestamp: at(3),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
    },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 5),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push(
    { type: 'event_msg', timestamp: at(70), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'turn_context', timestamp: at(71), payload: { turn_id: 'original', model: 'gpt-6-sol' } },
    { type: 'response_item', timestamp: at(71), payload: { type: 'custom_tool_call', call_id: 'original-tool' } },
    {
      type: 'event_msg',
      timestamp: at(72),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    {
      type: 'event_msg',
      timestamp: at(73),
      payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
    },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  assert.equal(readSessionRequests(file).length, 1);
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.failedToolCalls, 1);
  assert.equal(summary.unattributedToolCalls, undefined);
});

test('a large Codex failure history remains reportable', () => {
  const createReducer = codexReader.createCodexUsageLineReducer;
  let snapshots = 0;
  vi.spyOn(codexReader, 'createCodexUsageLineReducer').mockImplementation((...args) => {
    const reducer = createReducer(...args);
    const snapshot = reducer.snapshot;
    reducer.snapshot = () => {
      snapshots++;
      return snapshot();
    };
    return reducer;
  });
  const file = path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl');
  const failure = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-09-26T00:00:03Z',
    payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
  });
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: { id: 'parent', source: 'cli', model_provider: 'openai' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-09-26T00:00:01Z',
        payload: { type: 'task_started', turn_id: 'turn' },
      }),
      failure.repeat(130_000).replaceAll('}{', '}\n{'),
    ].join('\n') + '\n',
  );
  assert.equal(sessionCostReport(file).parent.failedToolCalls, 130_000);
  assert.ok(snapshots < 10, `${snapshots} complete state copies for one turn's failure history`);
}, 30_000);

test('billing identity survives a duplicate across a snapshot and delayed metadata after 65 turns', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'tool' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'same', turn_id: 'first', usage } },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    { type: 'token_usage_record', timestamp: at(5), payload: { response_id: 'same', turn_id: 'first', usage } },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 6),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push({ type: 'turn_context', timestamp: at(100), payload: { turn_id: 'first', model: 'gpt-6-sol' } });
  const requests = readSessionRequests(
    write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records),
  );
  assert.deepEqual(
    requests
      .filter((request) => !request.evidenceOnly)
      .map((request) => [request.model, request.toolCalls, request.usage.input]),
    [['gpt-6-sol', 1, 10]],
  );
});

test('a later equal snapshot cannot absorb a bill across another billing boundary', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'first', turn_id: 'first', usage } },
    {
      type: 'token_usage_record',
      timestamp: at(4),
      payload: { response_id: 'second', turn_id: 'first', usage: { ...usage, output_tokens: 3 } },
    },
    {
      type: 'event_msg',
      timestamp: at(5),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.requests, 2);
  assert.equal(summary.snapshotEvidence?.count, 1);
});

test('a populated partial snapshot pairs with billing and retains corrected billing metadata', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-5.6-terra' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'bill', turn_id: 'first', usage } },
    { type: 'compacted', timestamp: at(4), payload: { compaction_response_id: 'bill' } },
    {
      type: 'event_msg',
      timestamp: at(5),
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-6-sol', model_provider_id: 'openai', service_tier: 'priority' },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(6),
      payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 2 }, total_token_usage: usage } },
    },
  ]);
  const requests = readSessionRequests(file);
  assert.deepEqual(
    requests
      .filter((request) => !request.evidenceOnly)
      .map((request) => [request.model, request.serviceTier, request.usage.input]),
    [['gpt-6-sol', 'priority', 10]],
  );
});

test('a closing event prevents later settings from repricing a compaction bill', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  for (const close of ['task_complete', 'turn_aborted']) {
    const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
      { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
      { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
      { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
      { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'bill', turn_id: 'first', usage } },
      { type: 'compacted', timestamp: at(4), payload: { compaction_response_id: 'bill' } },
      { type: 'event_msg', timestamp: at(5), payload: { type: close } },
      {
        type: 'event_msg',
        timestamp: at(6),
        payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-terra' } },
      },
    ]);
    assert.equal(readSessionRequests(file)[0].model, 'gpt-6-sol');
  }
});

test('the last of 65 pending snapshots retains its own pairing position', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
  ];
  for (let index = 0; index < 64; index++) {
    records.push({
      type: 'event_msg',
      timestamp: at(index + 2),
      payload: {
        type: 'token_count',
        info: { last_token_usage: usage, total_token_usage: { ...usage, input_tokens: (index + 1) * 10 } },
      },
    });
  }
  records.push(
    { type: 'token_usage_record', timestamp: at(67), payload: { response_id: 'bill', turn_id: 'first', usage } },
    {
      type: 'event_msg',
      timestamp: at(68),
      payload: {
        type: 'token_count',
        info: { last_token_usage: usage, total_token_usage: { ...usage, input_tokens: 650 } },
      },
    },
    { type: 'turn_context', timestamp: at(69), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  const requests = readSessionRequests(file);
  assert.equal(requests.filter((request) => !request.coverageDefect).length, 66);
  assert.ok(requests.some((request) => request.requestKey === `codex:first:${Date.parse(at(2))}:1`));
  assert.ok(
    requests.some((request) => request.requestKey === `codex:first:${Date.parse(at(68))}:65` && request.evidenceOnly),
  );
});

test('a report filters request clocks and omits children outside the window', () => {
  const root = directory();
  const parent = write(path.join(root, 'parent.jsonl'), [
    { ...claudeRequest('since', 2), timestamp: '2026-09-26T00:00:01Z' },
    { ...claudeRequest('until', 2), timestamp: '2026-09-26T00:00:03Z' },
  ]);
  write(path.join(root, 'parent', 'subagents', 'agent-second.jsonl'), [
    { ...claudeRequest('child-second', 2), timestamp: '2026-09-26T00:00:02Z' },
  ]);
  write(path.join(root, 'parent', 'subagents', 'agent-first.jsonl'), [
    { ...claudeRequest('child-first', 2), timestamp: '2026-09-26T00:00:01Z' },
  ]);
  write(path.join(root, 'parent', 'subagents', 'agent-late.jsonl'), [
    { ...claudeRequest('child-late', 2), timestamp: '2026-09-26T00:00:03Z' },
  ]);
  const report = sessionCostReport(parent, { since: '2026-09-25T19:00:01-05:00', until: '2026-09-26T00:00:03Z' });
  assert.deepEqual(report.window, { since: '2026-09-26T00:00:01.000Z', until: '2026-09-26T00:00:03.000Z' });
  assert.equal(report.parent.requests, 1);
  assert.deepEqual(
    report.children.map((child) => child.sessionId),
    ['first', 'second'],
  );
  assert.equal(report.combined.requests, 3);
  assert.match(report.rateNote, /promotional rate through \d{4}-\d{2}-\d{2}/);
  const empty = sessionCostReport(parent, { since: '2026-09-27T00:00:00Z' });
  assert.equal(empty.parent.requests, 0);
  assert.equal(empty.parent.pricedRequests, 0);
  assert.equal(empty.parent.unpricedRequests, 0);
  assert.deepEqual(empty.children, []);
  assert.deepEqual(empty.combined, empty.parent);
});

test('a windowed async report summarizes each native child before reading the next child history', async () => {
  const root = directory();
  const parent = write(path.join(root, 'parent.jsonl'), [claudeRequest('parent', 2)]);
  const outputs = new Map<string, number>();
  for (const [id, output] of [
    ['first', 111],
    ['second', 222],
  ] as const) {
    const file = write(path.join(root, 'parent', 'subagents', `agent-${id}.jsonl`), [
      { ...claudeRequest(`${id}-old`, output), timestamp: '2026-09-25T00:00:00Z' },
      claudeRequest(`${id}-selected`, output),
    ]);
    outputs.set(file, output);
  }
  const options = { since: '2026-09-26T00:00:00Z', byModel: true };
  const expected = sessionCostReport(parent, options);
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const originalOpen = nativeFs.openSync;
  const originalQuote = pricing.quoteUsage;
  const opens = new Map<string, number>();
  const priced = new Set<number>();
  let lastUsage: string | undefined;
  let summarizedBeforeNextRead = true;
  const read = vi.spyOn(nativeFs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const file = String(args[0]);
    if (outputs.has(file)) {
      const count = (opens.get(file) ?? 0) + 1;
      opens.set(file, count);
      if (count === 2) {
        if (lastUsage) summarizedBeforeNextRead &&= priced.has(outputs.get(lastUsage)!);
        lastUsage = file;
      }
    }
    return originalOpen(...args);
  });
  const quote = vi.spyOn(pricing, 'quoteUsage').mockImplementation((input) => {
    priced.add(input.usage.output);
    return originalQuote(input);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await sessionCostReportAsync(parent, options), expected);
    assert.equal(opens.size, 2);
    assert.ok([...opens.values()].every((count) => count === 2));
    assert.equal(summarizedBeforeNextRead, true, 'Each child must be summarized before the next history is read.');
    assert.equal(expected.children.length, 2);
    assert.ok(expected.children.every((child) => child.requests === 1));
  } finally {
    read.mockRestore();
    quote.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a report rejects impossible ISO window dates, times, and offsets', () => {
  const file = write(path.join(directory(), 'parent.jsonl'), [claudeRequest('one', 2)]);
  for (const since of ['2026-02-30T00:00:00Z', '2026-09-26T25:00:00Z', '2026-09-26T00:00:00+24:00']) {
    assert.throws(() => sessionCostReport(file, { since }), /Invalid since time/);
  }
});

test('until-text Python absolute anchors ignore inner lines and trailing newlines', () => {
  const textRequest = (id: string, second: number, text: string) => ({
    type: 'assistant',
    timestamp: new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString(),
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  });
  const file = write(path.join(directory(), 'parent.jsonl'), [
    textRequest('inner', 1, 'Before\nFound\n'),
    textRequest('start', 2, 'Found\n'),
    textRequest('end', 3, 'Before\nFound'),
    textRequest('both', 4, 'Found'),
  ]);
  const start = sessionCostReport(file, { byTool: true, untilText: '(?i)\\Afound' });
  const end = sessionCostReport(file, { byTool: true, untilText: '(?i)found\\Z' });
  assert.equal(start.untilText?.matched, true);
  assert.equal(end.untilText?.matched, true);
  assert.equal(start.untilText?.byTool.rows[0]?.requests, 1);
  assert.equal(end.untilText?.byTool.rows[0]?.requests, 2);
});

test('request prices use the request context band, regional rate, and service tier', () => {
  const short = summarizeRequests([pricedRequest('gpt-5.6-terra', 272_000)]);
  const long = summarizeRequests([pricedRequest('gpt-5.6-terra', 272_001)]);
  assert.equal(short.costUsd, 0.544);
  assert.equal(long.costUsd, 1.088);
  const regional = summarizeRequests([pricedRequest('claude-opus-5', 1_000, { inferenceClass: 'in-region' })]);
  assert.equal(regional.costUsd, 0.0055);
  const fast = summarizeRequests([pricedRequest('claude-opus-5-5', 1_000, { serviceTier: 'fast' })]);
  assert.equal(fast.costUsd, 0.008);
  const priority = summarizeRequests([pricedRequest('gpt-5.6-terra', 1_000, { serviceTier: 'priority' })]);
  assert.equal(priority.costUsd, null);
  assert.deepEqual(priority.unpricedModels, []);
  const terra = summarizeRequests([
    pricedRequest('gpt-6.1-terra', 100_000, {
      contextBand: 'short',
      usage: {
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        thinking: 0,
        requests: 1,
        input: 100_000,
        cacheWrite30m: 20_000,
        cacheRead: 100_000,
        output: 10_000,
      },
    }),
  ]);
  assert.ok(Math.abs(terra.pricedCostUsd! - 0.18) < 1e-12);
  const terraLong = summarizeRequests([pricedRequest('gpt-6.1-terra', 272_001)]);
  assert.equal(terraLong.costUsd, 0.544);
  const terraFast = summarizeRequests([pricedRequest('gpt-6.1-terra', 100_000, { serviceTier: 'fast' })]);
  assert.equal(terraFast.costUsd, 0.2);
  for (const options of [{ serviceTier: 'unknown-tier' }, { provider: 'amazon-bedrock' }, { incomplete: true }]) {
    const unsupported = summarizeRequests([pricedRequest('gpt-6.1-terra', 100_000, options)]);
    assert.equal(unsupported.costUsd, null);
  }
});

test('model costs reconcile individual request quotes across providers, tiers, and context bands', () => {
  const requests = [
    pricedRequest('gpt-5.6-terra', 272_000),
    pricedRequest('gpt-5.6-terra', 272_001),
    pricedRequest('gpt-6.1-sol', 100_000),
    pricedRequest('gpt-6.1-sol', 100_000, { serviceTier: 'fast' }),
    pricedRequest('gpt-6.1-sol', 100_000, { serviceTier: 'flex' }),
    pricedRequest('claude-opus-5', 1_000, { inferenceClass: 'in-region' }),
    pricedRequest('claude-opus-5-5', 1_000, { serviceTier: 'fast' }),
    pricedRequest('us.openai.gpt-6.1-sol', 100_000, { provider: 'amazon-bedrock' }),
    pricedRequest('global.openai.gpt-6.1-sol', 100_000, { provider: 'amazon-bedrock' }),
    pricedRequest('gpt-6.1-sol', 100_000, { provider: 'amazon-bedrock', serviceTier: 'fast' }),
    pricedRequest(null, 30, {
      reportedCost: 0.12,
      unclassifiedCacheWrite: 13,
      usage: {
        requests: 1,
        input: 30,
        cacheRead: 17,
        cacheWrite5m: 3,
        cacheWrite1h: 5,
        cacheWrite30m: 7,
        output: 11,
        thinking: 2,
      },
    }),
    pricedRequest('future-model', 40),
  ];
  const plain = summarizeRequests(requests);
  const detail = summarizeRequests(requests, undefined, true);
  const { modelCosts, ...withoutModels } = detail;
  assert.deepEqual(withoutModels, plain);
  assert.deepEqual(plain.models, detail.models);
  assert.equal(modelCosts![0].model, null);
  for (const row of modelCosts!) {
    const expected = summarizeRequests(requests.filter((request) => request.model === row.model));
    assert.equal(row.costUsd, expected.costUsd);
    assert.equal(row.pricedCostUsd, expected.pricedCostUsd);
    assert.equal(row.requests, expected.requests);
    assert.equal(row.unpricedRequests, expected.unpricedRequests);
    assert.equal(row.outputTokens, expected.outputTokens);
    assert.equal(row.reasoningOutputTokens, expected.reasoningOutputTokens);
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        'model',
        'requests',
        'pricedRequests',
        'unpricedRequests',
        'costUsd',
        'pricedCostUsd',
        'uncachedInputTokens',
        'cachedInputTokens',
        'cacheWriteInputTokens',
        'outputTokens',
        'reasoningOutputTokens',
      ].sort(),
    );
  }
  for (const key of [
    'requests',
    'pricedRequests',
    'unpricedRequests',
    'uncachedInputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
  ] as const)
    assert.equal(
      modelCosts!.reduce((sum, row) => sum + (row[key] ?? 0), 0),
      detail[key],
    );
  assert.ok(Math.abs(modelCosts!.reduce((sum, row) => sum + row.pricedCostUsd!, 0) - detail.pricedCostUsd!) < 1e-12);
  assert.equal(modelCosts!.find((row) => row.model === 'gpt-5.6-terra')!.pricedCostUsd, 1.632);
  assert.equal(modelCosts!.find((row) => row.model === 'gpt-6.1-sol')!.pricedCostUsd, 0.7);
  assert.equal(modelCosts!.find((row) => row.model === null)!.pricedCostUsd, 0.12);
  assert.equal(modelCosts!.find((row) => row.model === 'future-model')!.costUsd, null);
});

test('model costs retain source uncertainty, partial counters, estimates, and unattributable evidence', () => {
  const rows = [
    pricedRequest('claude-opus-5', 1_000),
    pricedRequest('gpt-6-sol', 2_000, { billingRecord: true }),
    pricedRequest('legacy-model', 3_000, { legacySnapshot: true, reportedCost: 0.2 }),
    pricedRequest(null, 4_000, { incomplete: true }),
    pricedRequest('evidence-model', 5_000, { evidenceOnly: true, billedCoverage: true }),
    pricedRequest(null, 0, { evidenceOnly: true, toolOnly: true, toolCalls: 2 }),
  ];
  const summary = summarizeRequests(rows, undefined, true);
  assert.equal(summary.snapshotEvidence?.inputTokens, 5_000);
  assert.equal(summary.unattributedToolCalls, 2);
  assert.equal(summary.modelCosts!.length, 4);
  assert.equal(
    summary.modelCosts!.reduce((sum, row) => sum + row.requests, 0),
    summary.requests,
  );
  assert.equal(
    summary.modelCosts!.reduce((sum, row) => sum + row.uncachedInputTokens!, 0),
    summary.uncachedInputTokens,
  );
  assert.ok(
    Math.abs(summary.modelCosts!.reduce((sum, row) => sum + row.pricedCostUsd!, 0) - summary.pricedCostUsd!) < 1e-12,
  );
  assert.equal(
    summary.modelCosts!.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0),
    summary.estimatedCostUsd,
  );
  for (const row of summary.modelCosts!) {
    assert.equal(row.requestCountExact, false);
    assert.equal(row.coverage, 'billed-with-unknown-coverage');
    assert.equal(row.costUsd, null);
  }
  assert.equal(summary.modelCosts![0].unpricedRequests, 1);
  const legacy = summarizeRequests(
    rows.filter((row) => row.legacySnapshot || row.model === 'claude-opus-5'),
    undefined,
    true,
  );
  assert.equal(legacy.modelCosts![0].coverage, 'legacy-snapshots');
  assert.equal(legacy.modelCosts![0].costUsd, null);
  assert.deepEqual(summarizeRequests([rows[4]], undefined, true).modelCosts, []);
  assert.deepEqual(summarizeRequests([], undefined, true).modelCosts, []);
});

test('model costs add unrounded request amounts before rounding public subtotals', () => {
  const same = summarizeRequests(
    [
      pricedRequest('reported-model', 0, { reportedCost: 0.00004 }),
      pricedRequest('reported-model', 0, { reportedCost: 0.00004 }),
    ],
    undefined,
    true,
  );
  assert.equal(same.costUsd, 0.0001);
  assert.equal(same.modelCosts![0].costUsd, 0.0001);
  const separate = summarizeRequests(
    [pricedRequest(null, 0, { reportedCost: 0.00004 }), pricedRequest('reported-model', 0, { reportedCost: 0.00004 })],
    undefined,
    true,
  );
  assert.equal(separate.costUsd, 0.0001);
  assert.equal(
    separate.modelCosts!.reduce((sum, row) => sum + row.costUsd!, 0),
    0,
  );
});

test('model rows keep absent identity distinct and normalized missing counters equal to explicit zero', () => {
  const file = write(path.join(directory(), 'parent.jsonl'), [
    { type: 'assistant', timestamp: '2026-09-26T00:00:01Z', message: { id: 'missing', usage: { input_tokens: 10 } } },
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:02Z',
      message: { id: 'zero', model: 'future-model', usage: { input_tokens: 10, output_tokens: 0, thinking_tokens: 0 } },
    },
  ]);
  const summary = sessionCostReport(file, { sourceOnly: true, byModel: true }).parent;
  assert.deepEqual(summary.models, ['future-model']);
  assert.deepEqual(
    summary.modelCosts!.map((row) => [row.model, row.outputTokens, row.reasoningOutputTokens]),
    [
      [null, 0, 0],
      ['future-model', 0, 0],
    ],
  );
  assert.equal(summary.unpricedRequests, 2);
  const bedrockRecords = fs
    .readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'bedrock-tool-calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const [profile, expected] of [
    ['us.', 0.1744],
    ['global.', 0.1585],
  ] as const) {
    const text = JSON.stringify(bedrockRecords).replaceAll('us.anthropic.', `${profile}anthropic.`);
    const bedrock = write(path.join(directory(), 'bedrock.jsonl'), JSON.parse(text));
    const report = sessionCostReport(bedrock, { sourceOnly: true, byModel: true });
    assert.equal(report.parent.modelCosts![0].model, 'claude-opus-5-5');
    assert.equal(report.parent.modelCosts![0].pricedCostUsd, expected);
    assert.equal(report.parent.pricedCostUsd, expected);
    assert.equal(report.parent.modelCosts![0].requests, report.parent.requests);
  }
});

test('missing speed rate is separate from a missing model rate', () => {
  const fast = summarizeRequests([
    pricedRequest('claude-opus-4-7', 1_000, { serviceTier: 'fast', recordedSpeed: 'fast' }),
  ]);
  assert.equal(fast.fastModeUnpricedRequests, 1);
  assert.deepEqual(fast.unpricedModels, []);
  const priority = summarizeRequests([
    pricedRequest('claude-opus-5', 1_000, { serviceTier: 'priority', recordedSpeed: 'standard' }),
  ]);
  assert.equal(priority.fastModeUnpricedRequests, 0);
  assert.deepEqual(priority.unpricedModels, []);
  const file = write(path.join(directory(), 'parent.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'standard-priority',
        model: 'claude-opus-4-7',
        content: [],
        usage: {
          input_tokens: 1_000,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          speed: 'standard',
          service_tier: 'priority',
        },
      },
    },
  ]);
  assert.equal(sessionCostReport(file).parent.fastModeUnpricedRequests, 0);
});

test('a request without pass bands prices its recorded token volume despite a different context band', () => {
  const request = pricedRequest('claude-haiku-5-5', 100001, { contextBand: 'short' });
  const summary = summarizeRequests([request]);
  assert.equal(summary.pricedRequests, 1);
  assert.equal(summary.costUsd, 0.05);
});

test('cache-expiry amounts use recorded request input without pass bands despite a different context band', () => {
  const before = pricedRequest('claude-haiku-5-5', 0, { contextBand: 'short', visibleTurnId: 'first' });
  before.usage.cacheWrite5m = 1000;
  const after = pricedRequest('claude-haiku-5-5', 100001, {
    contextBand: 'short',
    timestamp: before.timestamp + 600_000,
    visibleTurnId: 'second',
  });
  const expiry = summarizeRequests([before, after]).cacheExpiry!;
  assert.equal(expiry.returns, 1);
  assert.equal(expiry.inputCostAfterExpiryUsd, 0.05);
  assert.equal(expiry.extraCostAfterExpiryUsd, 0.0005);
});

test('an incomplete recorded cost does not hide a model without a public rate', () => {
  const unknown = pricedRequest('future-model', 1000, { incomplete: true, reportedCost: 0.123 });
  const known = pricedRequest('claude-opus-5', 1000, { incomplete: true, reportedCost: 0.123 });
  assert.deepEqual(summarizeRequests([unknown]).unpricedModels, ['future-model']);
  assert.deepEqual(summarizeRequests([known]).unpricedModels, []);
});

test('cached-read cost share stays unavailable when a priced aggregate has no request bands', () => {
  const request = pricedRequest('claude-haiku-5-5', 200001, {
    usage: {
      requests: 2,
      input: 100000,
      cacheRead: 100001,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
      thinking: 0,
    },
  });
  const summary = summarizeRequests([request]);
  assert.equal(summary.pricedRequests, 1);
  assert.equal(summary.costUsd, 0.055);
  assert.equal(summary.cacheReadShareOfCost, null);
});

test('a cumulative Claude child uses the speed on its final usage record', () => {
  const child = write(path.join(directory(), 'agent-child.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'one',
        model: 'claude-opus-4-7',
        content: [],
        usage: { input_tokens: 1_000, output_tokens: 2, speed: 'standard' },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:02Z',
      message: {
        id: 'one',
        model: 'claude-opus-4-7',
        content: [],
        usage: { input_tokens: 2_000, output_tokens: 4, speed: 'fast' },
      },
    },
  ]);
  const report = summarizeRequests(readSessionRequests(child, 'claude-subagent'));
  assert.equal(report.unpricedRequests, 1);
  assert.equal(report.fastModeUnpricedRequests, 1);
});

test('context mean rounds a half value to the nearest even integer', () => {
  const summary = summarizeRequests([pricedRequest('claude-opus-5', 29_324), pricedRequest('claude-opus-5', 29_325)]);
  assert.equal(summary.contextMean, 29_324);
});

test('combined failure diagnostics retain attributed Claude calls beside Codex failures', () => {
  const claude = pricedRequest('claude-opus-5', 1_000, { failedToolCalls: 1 });
  const codex = pricedRequest('gpt-6-sol', 1_000);
  const summary = summarizeRequests([claude, codex], 1);
  assert.equal(summary.failedToolCalls, 2);
  assert.equal(summary.failedToolCallRequests, 1);
  assert.equal(summary.failedToolCallCostUsd, null);
});

test('a sidechain response does not consume the next parent request tool result', () => {
  const first = claudeRequest('first', 2, ['read-call']);
  const sidechain = { ...claudeRequest('sidechain', 2), isSidechain: true };
  const next = { ...claudeRequest('next', 2), timestamp: '2026-09-26T00:00:03Z' };
  const file = write(path.join(directory(), 'parent.jsonl'), [
    first,
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-call', content: 'text' }] } },
    sidechain,
    next,
  ]);
  const requests = readSessionRequests(file);
  assert.deepEqual(
    requests.map((request) => request.toolKinds),
    [[], ['other']],
  );
});

function codexToolRecords(f: ReturnType<typeof cumulativeCostFixture>) {
  const call = (second: number, id: string, name: string, args: unknown, type = 'function_call') => ({
    type: 'response_item',
    timestamp: f.at(second),
    payload: {
      type,
      name,
      call_id: id,
      ...(type === 'custom_tool_call' ? { input: args } : { arguments: JSON.stringify(args) }),
    },
  });
  const output = (second: number, id: string, text: string, type = 'function_call_output') => ({
    type: 'response_item',
    timestamp: f.at(second),
    payload: { type, call_id: id, output: text },
  });
  return { call, output };
}

test('a Codex tool output belongs to the first billing record after it, not the token_count event after it', () => {
  const f = cumulativeCostFixture();
  const { call, output } = codexToolRecords(f);
  const file = f.save([
    ...f.start,
    f.bill('issuer', 3, 1),
    call(4, 'wait-1', 'wait_agent', { timeout_ms: 1000 }),
    output(5, 'wait-1', JSON.stringify({ timed_out: true })),
    f.snapshot(6, 1),
    f.bill('reader', 7, 2),
    f.snapshot(8, 2),
  ]);
  const requests = readSessionRequests(file);
  const billed = (id: string) => requests.find((request) => request.requestKey === `codex-billing:${id}`)!;
  assert.equal(billed('issuer').toolKinds, undefined);
  assert.deepEqual(billed('reader').toolKinds, ['wait']);
  assert.deepEqual(billed('reader').toolLabels, ['wait_agent']);
  const rows = sessionCostReport(file, { byTool: true, sourceOnly: true }).byTool!.rows;
  assert.deepEqual(
    rows.map((row) => [row.kind, row.requests, row.tools.map((tool) => tool.tool)]),
    [
      ['wait', 1, ['wait_agent']],
      ['no tool result', 1, []],
    ],
  );
});

test('Codex tool calls map to kinds on every shell form and through the exec wrapper', () => {
  const f = cumulativeCostFixture();
  const { call, output } = codexToolRecords(f);
  const cases: [object, string, string][] = [
    [call(0, 'shell-git', 'shell', { command: ['bash', '-lc', 'git status'] }), 'git', 'shell git'],
    [
      call(0, 'shell-search', 'shell', {
        command: [
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          '-Command',
          'Select-String -Path a.ts -Pattern x',
        ],
      }),
      'search',
      'shell select-string',
    ],
    [
      call(0, 'shell-switches', 'shell', {
        command: ['PowerShell.EXE', '-noprofile', '-NonInteractive', '-Command', 'Get-ChildItem -Recurse src'],
      }),
      'search',
      'shell get-childitem',
    ],
    [
      call(0, 'shell-policy', 'shell', {
        command: ['C:/Program Files/PowerShell/7/PWSH.exe', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-C', 'git log'],
      }),
      'git',
      'shell git',
    ],
    // PowerShell runs build.ps1 here, and passes `-c` to the script.
    [
      call(0, 'shell-file', 'shell', { command: ['pwsh', '-NoProfile', '-File', './build.ps1', '-c', 'git status'] }),
      'other',
      'shell pwsh',
    ],
    [
      call(0, 'shell-encoded', 'shell', {
        command: ['powershell', '-NoProfile', '-EncodedCommand', 'ZwBpAHQAIABzAHQAYQB0AHUAcwA=', '-c', 'git status'],
      }),
      'other',
      'shell powershell',
    ],
    [call(0, 'shell-no-switch', 'shell', { command: ['pwsh', '-NoLogo', 'git', 'status'] }), 'other', 'shell pwsh'],
    [call(0, 'shell-command', 'shell_command', { command: 'npm run build' }), 'test or build', 'shell_command npm'],
    [
      call(0, 'windows-read', 'exec_command', { cmd: 'Get-Content C:\\repo\\src\\a.ts -TotalCount 20' }),
      'file read',
      'exec_command get-content',
    ],
    [call(0, 'posix-test', 'exec_command', { cmd: 'cd /repo && npm test' }), 'test or build', 'exec_command npm'],
    [call(0, 'patch', 'apply_patch', '*** Begin Patch', 'custom_tool_call'), 'file edit', 'apply_patch'],
    [
      call(0, 'wrapped-wait', 'exec', 'await tools.wait_agent({ timeout_ms: 1000 });', 'custom_tool_call'),
      'wait',
      'wait_agent',
    ],
    [
      call(
        0,
        'wrapped-command',
        'exec',
        'const r = await tools.exec_command({ "cmd": "rg -n foo src" });',
        'custom_tool_call',
      ),
      'search',
      'exec_command rg',
    ],
    [call(0, 'stdin', 'write_stdin', { session_id: 1, chars: '' }), 'wait', 'write_stdin'],
    [call(0, 'cell', 'wait', { cell_id: 1 }), 'wait', 'wait'],
    [call(0, 'spawn', 'spawn_agent', { task_name: 'worker' }), 'subagent launch', 'spawn_agent'],
    [call(0, 'message', 'send_message', { target: 'worker' }), 'other', 'send_message'],
    [call(0, 'mcp', 'mcp__github__get_issue', { number: 1 }), 'other', 'mcp__github__get_issue'],
  ];
  const records: object[] = [...f.start];
  cases.forEach(([held], index) => {
    const second = 3 + index * 3;
    const id = (held as { payload: { call_id: string; type: string } }).payload;
    records.push(
      f.bill(`r${index}`, second, index + 1),
      { ...held, timestamp: f.at(second + 1) },
      output(
        second + 2,
        id.call_id,
        'done',
        id.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output',
      ),
    );
  });
  records.push(f.bill(`r${cases.length}`, 3 + cases.length * 3, cases.length + 1));
  const requests = readSessionRequests(f.save(records));
  cases.forEach(([, kind, label], index) => {
    const reader = requests.find((request) => request.requestKey === `codex-billing:r${index + 1}`)!;
    assert.deepEqual([reader.toolKinds, reader.toolLabels], [[kind], [label]], label);
  });
});

test('a Codex rollout without billing records keeps every request at no tool result', () => {
  const f = cumulativeCostFixture();
  const { call, output } = codexToolRecords(f);
  const file = f.save([
    ...f.start,
    call(3, 'read', 'exec_command', { cmd: 'cat a.ts' }),
    output(4, 'read', 'text'),
    f.snapshot(5, 1),
    f.snapshot(6, 2),
  ]);
  const rows = sessionCostReport(file, { byTool: true, sourceOnly: true }).byTool!.rows;
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['no tool result'],
  );
});

test('Claude edits and a macOS program path map to their kinds and labels', () => {
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const file = write(path.join(directory(), 'parent.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'first',
        model: 'claude-opus-5',
        usage,
        content: [
          { type: 'tool_use', id: 'search', name: 'Bash', input: { command: '/opt/homebrew/bin/rg -n foo src' } },
          { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/Users/me/a.ts' } },
          { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: '/Users/me/b.ts' } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: ['search', 'edit', 'write'].map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
      },
    },
    { ...claudeRequest('next', 2), timestamp: '2026-09-26T00:00:03Z' },
  ]);
  const next = readSessionRequests(file).at(-1)!;
  assert.deepEqual(next.toolKinds, ['search', 'file edit', 'file edit']);
  assert.deepEqual(next.toolLabels, ['Bash rg', 'Edit', 'Write']);
});

test('partial summaries retain known cost and mark unknown models', () => {
  const known = pricedRequest('claude-opus-5', 1_000, {
    usage: {
      requests: 1,
      input: 1_000,
      cacheRead: 1_000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWrite30m: 0,
      output: 100,
      thinking: 40,
    },
    toolCalls: 2,
  });
  const unknown = pricedRequest('future-model', 500);
  const summary = summarizeRequests([known, unknown]);
  assert.equal(summary.requests, 2);
  assert.equal(summary.pricedRequests, 1);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.costUsd, null);
  assert.equal(summary.pricedCostUsd, 0.008);
  assert.deepEqual(summary.costPerRequestByFifth, [0.008, null]);
  assert.equal(summary.contextMean, 1_250);
  assert.equal(summary.contextMax, 2_000);
  assert.equal(summary.contextFirst, 2_000);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.requestsWithTwoOrMoreTools, 1);
  assert.deepEqual(summary.models, ['claude-opus-5', 'future-model']);
  assert.deepEqual(summary.unpricedModels, ['future-model']);
  assert.equal(summary.cacheReadShareOfCost, null);
  assert.equal(summarizeRequests([known]).cacheReadShareOfCost, 0.063);
});

test('combined coverage retains billed and legacy source evidence', () => {
  const claude = pricedRequest('claude-opus-5', 1_000);
  const bill = pricedRequest('gpt-6-sol', 1_000, { billingRecord: true });
  const snapshot = pricedRequest('gpt-6-sol', 1_000, { evidenceOnly: true, billedCoverage: true, toolCalls: 2 });
  const legacy = pricedRequest('gpt-6-sol', 1_000, { legacySnapshot: true });
  const mixed = summarizeRequests([bill, legacy]);
  assert.equal(mixed.coverage, 'billed-with-unknown-coverage');
  assert.equal(mixed.pricedCostUsd, summarizeRequests([bill]).pricedCostUsd);
  assert.equal(mixed.estimatedCostUsd, summarizeRequests([legacy]).estimatedCostUsd);
  assert.equal(mixed.toolCalls, null);
  assert.equal(mixed.requestsWithTwoOrMoreTools, null);
  const evidence = summarizeRequests([snapshot, claude]);
  assert.equal(evidence.coverage, 'billed-with-unknown-coverage');
  assert.equal(evidence.costUsd, null);
  assert.equal(evidence.requestCountExact, false);
  assert.equal(evidence.toolCalls, null);
  assert.equal(evidence.cacheReadShareOfCost, null);
  assert.equal(summarizeRequests([legacy, claude]).coverage, 'legacy-snapshots');
});

test('a growing child request keeps its final usage and unique tools', () => {
  const file = write(path.join(directory(), 'subagents', 'agent-child.jsonl'), [
    claudeRequest('request-1', 4, ['tool-1']),
    claudeRequest('request-1', 40, ['tool-1', 'tool-2']),
  ]);
  const requests = readSessionRequests(file, 'claude-subagent');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].usage.output, 40);
  assert.equal(requests[0].toolCalls, 2);
});

test('synthetic records never become requests', () => {
  const file = write(path.join(directory(), 'parent.jsonl'), [
    claudeRequest('synthetic', 8, [], '<synthetic>'),
    claudeRequest('real', 9),
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.requestKey),
    ['claude:real'],
  );
});

test('Codex tool calls belong to the request that records their usage', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const event = (kind: string, second: number, payload: object = {}) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: { type: kind, ...payload },
  });
  const item = (second: number, call: string) => ({
    type: 'response_item',
    timestamp: at(second),
    payload: { type: 'custom_tool_call', name: 'exec', call_id: call, input: '{}' },
  });
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: input + 2,
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    event('task_started', 1, { turn_id: 'turn-1' }),
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model: 'gpt-6-sol', effort: 'low' } },
    item(3, 'call-a'),
    item(4, 'call-b'),
    event('token_count', 5, {
      info: { last_token_usage: usage(10), total_token_usage: usage(10), model_context_window: 258400 },
    }),
    item(6, 'call-c'),
    event('token_count', 7, {
      info: { last_token_usage: usage(20), total_token_usage: usage(30), model_context_window: 258400 },
    }),
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.toolCalls),
    [2, 1],
  );
});

test('a delayed Codex context keeps tools with their original turn', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const event = (kind: string, second: number, payload: object = {}) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: { type: kind, ...payload },
  });
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: input + 2,
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    event('task_started', 1, { turn_id: 'first' }),
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'first-tool' } },
    event('token_count', 3, { info: { last_token_usage: usage(10), total_token_usage: usage(10) } }),
    event('task_complete', 4),
    event('task_started', 5, { turn_id: 'second' }),
    { type: 'response_item', timestamp: at(6), payload: { type: 'custom_tool_call', call_id: 'second-tool' } },
    { type: 'turn_context', timestamp: at(7), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    event('token_count', 8, { info: { last_token_usage: usage(20), total_token_usage: usage(30) } }),
    { type: 'turn_context', timestamp: at(9), payload: { turn_id: 'second', model: 'gpt-6-sol' } },
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.toolCalls),
    [1, 1],
  );
});

test('a Codex request without final context keeps its usage as unpriced', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    {
      type: 'event_msg',
      timestamp: at(2),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => [request.model, request.usage.input, request.incomplete]),
    [[null, 10, true]],
  );
});

test('a Codex token count without last usage remains an unpriced incomplete request', () => {
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    {
      type: 'session_meta',
      timestamp: '2026-09-26T00:00:00Z',
      payload: { id: 'parent', source: 'cli', model_provider: 'openai' },
    },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:03Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } },
    },
  ]);
  const requests = readSessionRequests(file);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].incomplete, true);
  const report = sessionCostReport(file);
  const summary = report.parent;
  assert.equal(summary.requests, 1);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.costUsd, null);
  assert.equal(summary.requestCountExact, false);
  assert.deepEqual([summary.contextFirst, summary.contextMean, summary.contextMax], [null, null, null]);
  assert.equal(report.combined.requests, 1);
  assert.deepEqual(
    [report.combined.contextFirst, report.combined.contextMean, report.combined.contextMax],
    [null, null, null],
  );
});

test('unresolved Codex requests retain source order and count each tool once', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: input + 2,
  });
  const event = (kind: string, second: number, payload: object = {}) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: { type: kind, ...payload },
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    event('task_started', 1, { turn_id: 'first' }),
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'first-tool' } },
    event('token_count', 3, { info: { last_token_usage: usage(10), total_token_usage: usage(10) } }),
    event('task_complete', 4),
    event('task_started', 5, { turn_id: 'second' }),
    { type: 'response_item', timestamp: at(6), payload: { type: 'custom_tool_call', call_id: 'second-tool' } },
    event('token_count', 7, { info: { last_token_usage: usage(20), total_token_usage: usage(30) } }),
    { type: 'turn_context', timestamp: at(8), payload: { turn_id: 'second', model: 'gpt-6-sol' } },
    event('task_started', 9, { turn_id: 'third' }),
    { type: 'response_item', timestamp: at(10), payload: { type: 'custom_tool_call', call_id: 'third-a' } },
    event('token_count', 11, { info: { last_token_usage: usage(30), total_token_usage: usage(60) } }),
    { type: 'response_item', timestamp: at(12), payload: { type: 'custom_tool_call', call_id: 'third-b' } },
    event('token_count', 13, { info: { last_token_usage: usage(40), total_token_usage: usage(100) } }),
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => [request.requestKey.split(':')[1], request.toolCalls]),
    [
      ['first', 1],
      ['second', 1],
      ['third', 1],
      ['third', 1],
    ],
  );
});

test('replayed Codex tools do not join later request counts', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const event = (kind: string, second: number, payload: object = {}) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: { type: kind, ...payload },
  });
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: input + 2,
  });
  const tool = (second: number, id: string) => ({
    type: 'response_item',
    timestamp: at(second),
    payload: { type: 'custom_tool_call', call_id: id },
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    event('task_started', 1, { turn_id: 'first' }),
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    tool(3, 'owned'),
    event('token_count', 4, { info: { last_token_usage: usage(10), total_token_usage: usage(10) } }),
    event('task_complete', 5),
    event('task_started', 6, { turn_id: 'first' }),
    tool(7, 'replayed'),
    event('task_complete', 8),
    event('task_started', 9, { turn_id: 'second' }),
    { type: 'turn_context', timestamp: at(10), payload: { turn_id: 'second', model: 'gpt-6-sol' } },
    tool(11, 'later'),
    event('token_count', 12, { info: { last_token_usage: usage(20), total_token_usage: usage(30) } }),
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.toolCalls),
    [1, 1],
  );
});

test('a Codex child two levels below its parent is discovered', () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const rollout = (id: string, parent?: string, agent?: string) =>
    write(path.join(sessions, '2026', '09', '26', `rollout-2026-09-26T00-00-00-${id}.jsonl`), [
      {
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: {
          id,
          cwd: root,
          model_provider: 'openai',
          ...(parent
            ? { parent_thread_id: parent, source: { subagent: { thread_spawn: { agent_path: agent } } } }
            : { source: 'cli' }),
        },
      },
    ]);
  const parent = rollout('parent');
  rollout('child', 'parent', '/root/child');
  rollout('grandchild', 'child', '/root/child/grandchild');
  const sources = sessionSources(parent, { codexSessions: sessions });
  assert.deepEqual(
    sources.map((source) => source.sessionId),
    ['parent', 'child', 'grandchild'],
  );
  assert.deepEqual(
    sources.map((source) => source.kind),
    ['codex', 'codex-thread', 'codex-thread'],
  );
  assert.equal(sources[2].agent, '/root/child/grandchild');
});

test('the public Codex cost sources include one Claude session launched by a shell receipt', () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const projects = path.join(root, 'projects');
  const childId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const parent = write(path.join(sessions, 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'parent', source: 'cli', cwd: root } },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'launch' } },
    { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: 'launch', model: 'gpt-6-sol' } },
    {
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:03Z',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'exec-launch',
          status: 'completed',
          exit_code: 0,
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --runner claude --arc-dispatch' }],
          stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
        },
      },
    },
  ]);
  write(path.join(projects, 'project', `${childId}.jsonl`), [claudeRequest('child-usage', 7)]);
  write(path.join(projects, 'project', childId, 'subagents', 'agent-nested.jsonl'), [claudeRequest('nested-usage', 3)]);
  const roots = { codexSessions: sessions, projects };
  assert.deepEqual(
    sessionSources(parent, roots).map(({ kind, sessionId }) => [kind, sessionId]),
    [
      ['codex', 'parent'],
      ['claude-session', childId],
      ['claude-subagent', 'nested'],
    ],
  );
  const report = sessionCostReport(parent, { roots });
  assert.equal(report.children.length, 2);
  assert.deepEqual(report.children.map((child) => child.outputTokens).sort(), [3, 7]);
});

test('a Codex session reports a linked multi-request Claude print result without per-request context', async () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const file = write(path.join(sessions, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    {
      type: 'session_meta',
      timestamp: at(0),
      payload: { id: 'parent', source: 'cli', cwd: root, model_provider: 'openai' },
    },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: {
        response_id: 'outside-window',
        turn_id: 'turn-1',
        usage: {
          input_tokens: 100_000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
        },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(3),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 2, total_tokens: 100_002 },
          total_token_usage: { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 2, total_tokens: 100_002 },
        },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'exec-1',
          command: ['claude', '-p', 'review', '--output-format', 'json'],
          parsed_cmd: [{ type: 'unknown', cmd: 'claude -p review --output-format json' }],
          status: 'completed',
          exit_code: 0,
          stdout: JSON.stringify({
            type: 'result',
            session_id: 'printed',
            num_turns: 2,
            total_cost_usd: 0.01,
            duration_ms: 100,
            is_error: false,
            usage: {
              input_tokens: 199_950,
              output_tokens: 2,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 50,
            },
            modelUsage: {
              'claude-haiku-4-5': {
                inputTokens: 199_950,
                outputTokens: 2,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 50,
                thinkingTokens: 0,
                costUSD: 0.01,
                contextWindow: 200_000,
                canonicalModel: 'claude-haiku-4-5',
                costBasis: 'list',
              },
            },
          }),
        },
      },
    },
  ]);
  const sources = sessionSources(file, { codexSessions: sessions });
  assert.deepEqual(
    sources.map((source) => source.kind),
    ['codex', 'claude-print'],
  );
  assert.equal(sources[1].sessionId, 'printed');
  assert.equal(sources[0].requests?.filter((request) => !request.coverageDefect).length, 2);
  const windowed = sessionCostReport(file, { since: at(3), until: at(5), roots: { codexSessions: sessions } });
  assert.equal(windowed.parent.coverage, 'billed-with-unknown-coverage');
  assert.equal(windowed.children[0].pricedRequests, 1);
  assert.equal(windowed.combined.coverage, 'billed-with-unknown-coverage');
  assert.equal(windowed.combined.costUsd, null);
  assert.equal(windowed.combined.pricedCostUsd, windowed.children[0].pricedCostUsd);
  assert.equal(windowed.combined.requestCountExact, false);
  assert.equal(sources[1].requests?.length, 1);
  const report = sessionCostReport(file, { roots: { codexSessions: sessions } });
  for (const window of [{}, { since: at(3), until: at(5) }]) {
    const ordinary = sessionCostReport(file, { ...window, roots: { codexSessions: sessions }, byModel: true });
    const direct = sessionCostReport(file, {
      ...window,
      roots: { codexSessions: sessions },
      sourceOnly: true,
      byModel: true,
    });
    assert.deepEqual(
      await sessionCostReportAsync(file, { ...window, roots: { codexSessions: sessions }, byModel: true }),
      ordinary,
    );
    assert.deepEqual(
      await sessionCostReportAsync(file, {
        ...window,
        roots: { codexSessions: sessions },
        sourceOnly: true,
        byModel: true,
      }),
      direct,
    );
    assert.deepEqual(direct.parent, ordinary.parent);
    assert.deepEqual(direct.children, []);
    // The coverage diagnostic belongs to source summaries only.
    const { modelCosts, ...parent } = direct.parent;
    delete parent.coverageDefect;
    assert.deepEqual(direct.combined, parent);
    assert.equal(modelCosts!.length, direct.parent.requests ? 1 : 0);
    assert.equal('modelCosts' in direct.combined, false);
  }
  assert.equal(report.parent.contextFirst, null);
  assert.equal(report.parent.requestCountExact, false);
  assert.deepEqual(
    [report.children[0].contextFirst, report.children[0].contextMean, report.children[0].contextMax],
    [null, null, null],
  );
  assert.equal(report.children[0].uncachedInputTokens, 199_950);
  assert.equal(report.children[0].cacheWriteInputTokens, 50);
  assert.equal(report.children[0].requestCountExact, false);
  assert.equal(report.children[0].costUsd, 0.01);
  assert.equal(report.children[0].costPerRequest, null);
  assert.deepEqual(report.children[0].costPerRequestByFifth, [null]);
  assert.equal(report.combined.requestCountExact, false);
  assert.equal(report.combined.requests, 2);
  assert.equal(report.combined.uncachedInputTokens, 299_950);
  assert.equal(report.combined.costUsd, null);
  assert.deepEqual(
    [report.combined.contextFirst, report.combined.contextMean, report.combined.contextMax],
    [null, null, null],
  );
});

test('a completed Claude print result replaces its incomplete request', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const completed = (second: number, stdout: string) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'exec-1',
        command: ['claude', '-p', 'review', '--output-format', 'json'],
        parsed_cmd: [{ type: 'unknown', cmd: 'claude -p review --output-format json' }],
        status: 'completed',
        exit_code: 0,
        stdout,
      },
    },
  });
  const result = JSON.stringify({
    type: 'result',
    session_id: 'printed',
    total_cost_usd: 0.01,
    duration_ms: 100,
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {
      'claude-haiku-4-5': {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        thinkingTokens: 0,
        costUSD: 0.01,
        contextWindow: 200_000,
        canonicalModel: 'claude-haiku-4-5',
        costBasis: 'list',
      },
    },
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    completed(2, '{"type":"result","session_id":'),
    completed(3, result),
  ]);
  const requests = readSessionRequests(file);
  assert.deepEqual(requests, []);
  assert.deepEqual(
    readSessionRequests(file, 'claude-print', 'exec-1:printed').map((request) => [
      request.incomplete ?? false,
      request.linkedSessionId,
    ]),
    [[false, 'printed']],
  );
});

test('a direct Claude child path keeps its child identity and role', () => {
  const file = write(path.join(directory(), 'subagents', 'agent-child.jsonl'), [claudeRequest('one', 2)]);
  assert.deepEqual(
    sessionSources(file).map(({ kind, sessionId }) => [kind, sessionId]),
    [['claude-subagent', 'child']],
  );
});

test('source-only parent and child reads retain source model costs without discovering descendants', () => {
  const root = directory();
  const parent = write(path.join(root, 'parent.jsonl'), [
    { ...claudeRequest('later', 40_000), timestamp: '2026-09-26T00:00:02Z' },
    claudeRequest('parent', 2),
  ]);
  const child = write(path.join(root, 'parent', 'subagents', 'agent-child.jsonl'), [claudeRequest('child', 4)]);
  write(path.join(path.dirname(child), 'agent-grandchild.jsonl'), [claudeRequest('grandchild', 8)]);
  const ordinary = sessionCostReport(parent, { byModel: true });
  assert.equal(ordinary.children.length, 2);
  assert.equal(ordinary.parent.modelCosts![0].outputTokens, 40_002);
  assert.equal(ordinary.children.find((source) => source.sessionId === 'child')!.modelCosts![0].outputTokens, 4);
  assert.equal('modelCosts' in ordinary.combined, false);
  for (const file of [parent, child]) {
    const plain = sessionCostReport(file);
    const direct = sessionCostReport(file, { sourceOnly: true });
    assert.deepEqual(direct.parent, plain.parent);
    assert.deepEqual(direct.children, []);
    assert.deepEqual(direct.combined, direct.parent);
  }
});

test('repeated source-only calls read only the selected source and bypass catalogs and discovery', () => {
  const root = directory();
  const projects = path.join(root, 'projects');
  const sessions = path.join(root, 'sessions');
  const claude = write(path.join(projects, 'sample', 'parent.jsonl'), [claudeRequest('parent', 2)]);
  const codex = write(path.join(sessions, 'rollout-parent.jsonl'), [
    { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'parent', source: 'cli' } },
  ]);
  for (let index = 0; index < 100; index++) {
    write(path.join(projects, 'other', `unused-${index}.jsonl`), [claudeRequest('unused', 100)]);
    write(path.join(sessions, `rollout-unused-${index}.jsonl`), [
      { type: 'session_meta', payload: { id: `unused-${index}`, source: 'cli' } },
    ]);
  }
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation(() => {
    throw new Error('Unexpected directory enumeration');
  });
  const open = vi.spyOn(nativeFs, 'openSync');
  const claudeDiscovery = vi.spyOn(projectSpend, 'discoverClaudeSessionSpendSources').mockImplementation(() => {
    throw new Error('Unexpected Claude discovery');
  });
  const codexDiscovery = vi.spyOn(codexReader, 'scanCodexDispatchReferences').mockImplementation(() => {
    throw new Error('Unexpected Codex discovery');
  });
  syncBuiltinESMExports();
  try {
    const reads: number[] = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const start = open.mock.calls.length;
      for (const file of [claude, codex]) {
        assert.equal(findSessionTranscript(file, { projects, codexSessions: sessions }, true), file);
        assert.deepEqual(
          sessionCostReport(file, { roots: { projects, codexSessions: sessions }, sourceOnly: true }).children,
          [],
        );
      }
      reads.push(open.mock.calls.length - start);
    }
    assert.equal(enumerate.mock.calls.length, 0);
    assert.equal(claudeDiscovery.mock.calls.length, 0);
    assert.equal(codexDiscovery.mock.calls.length, 0);
    assert.ok(open.mock.calls.every(([file]) => [claude, codex].includes(String(file))));
    assert.ok(reads[0] > 0 && reads.every((count) => count === reads[0]), JSON.stringify(reads));
    console.log(`Source-only repeated reads: ${JSON.stringify(reads)}, unrelated transcripts: 200, enumerations: 0.`);
    assert.throws(
      () => findSessionTranscript('parent', { projects, codexSessions: sessions }, true),
      /requires an existing transcript file path/,
    );
    assert.throws(
      () => findSessionTranscript(path.join(root, 'missing.jsonl'), {}, true),
      /requires an existing transcript file path/,
    );
    assert.throws(() => findSessionTranscript(root, {}, true), /not a file/);
  } finally {
    enumerate.mockRestore();
    open.mockRestore();
    claudeDiscovery.mockRestore();
    codexDiscovery.mockRestore();
    syncBuiltinESMExports();
  }
});

test('an explicitly supplied Claude child role works for a copied file', () => {
  const file = write(path.join(directory(), 'copy.jsonl'), [
    { ...claudeRequest('one', 2), isSidechain: true },
    { ...claudeRequest('one', 9), isSidechain: true },
  ]);
  assert.equal(readSessionRequests(file, 'claude-subagent')[0].usage.output, 9);
});

test('an opening Codex record identifies a copied rollout', () => {
  const file = write(path.join(directory(), 'copy.jsonl'), [
    { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'copied', source: 'cli' } },
  ]);
  assert.deepEqual(
    sessionSources(file).map(({ kind, sessionId }) => [kind, sessionId]),
    [['codex', 'copied']],
  );
});

test('a dispatched Claude session and its child join the source tree', () => {
  const root = directory();
  const parent = write(path.join(root, 'parent.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'launch',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'tool-launch', name: 'Bash', input: { command: 'claude --bg -p task' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-26T00:00:02Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-launch', content: 'Session started: child' }],
      },
      toolUseResult: { stdout: '{"type":"result","session_id":"abcdef12"}' },
    },
  ]);
  write(path.join(root, 'abcdef12.jsonl'), [
    claudeRequest('child-request', 2, ['nested-launch']),
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:03Z',
      message: {
        id: 'nested-launch',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'nested-launch', name: 'Bash', input: { command: 'claude --bg -p nested' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-26T00:00:04Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nested-launch', content: 'nested' }] },
      toolUseResult: { stdout: '{"type":"result","session_id":"abcdef34"}' },
    },
  ]);
  write(path.join(root, 'abcdef12', 'subagents', 'agent-nested.jsonl'), [claudeRequest('subagent', 3)]);
  write(path.join(root, 'abcdef34.jsonl'), [claudeRequest('grandchild', 4)]);
  const sources = sessionSources(parent);
  assert.deepEqual(
    sources.map(({ kind, sessionId }) => [kind, sessionId]),
    [
      ['claude', 'parent'],
      ['claude-session', 'abcdef12'],
      ['claude-subagent', 'nested'],
      ['claude-session', 'abcdef34'],
    ],
  );
});

test('a dispatched Claude session in another project includes its descendants', async () => {
  const root = directory();
  const projects = path.join(root, 'projects');
  const parent = write(path.join(projects, 'project-a', 'parent.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'launch',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'launch-tool', name: 'Bash', input: { command: 'claude --bg -p task' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-26T00:00:02Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-tool', content: 'child' }] },
      toolUseResult: { stdout: '{"type":"result","session_id":"abcdef12"}' },
    },
  ]);
  write(path.join(projects, 'project-b', 'abcdef12.jsonl'), [claudeRequest('child', 2)]);
  write(path.join(projects, 'project-b', 'abcdef12', 'subagents', 'agent-grandchild.jsonl'), [
    claudeRequest('grandchild', 3),
  ]);
  const codexSessions = path.join(root, 'unused-codex');
  write(path.join(codexSessions, 'rollout-unused.jsonl'), [
    { type: 'session_meta', payload: { id: 'unused', source: 'exec' } },
  ]);
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const reads = vi.spyOn(nativeFs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    assert.deepEqual(
      sessionSources(parent, { projects, codexSessions }).map(({ kind, sessionId }) => [kind, sessionId]),
      [
        ['claude', 'parent'],
        ['claude-session', 'abcdef12'],
        ['claude-subagent', 'grandchild'],
      ],
    );
    const roots = { projects, codexSessions };
    assert.deepEqual(await sessionSourcesAsync(parent, roots), sessionSources(parent, roots));
    assert.deepEqual(await sessionCostReportAsync(parent, { roots }), sessionCostReport(parent, { roots }));
    assert.equal(reads.mock.calls.filter(([file]) => String(file) === codexSessions).length, 0);
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a Codex-only dispatch includes overlapping native children without reading Claude projects', () => {
  const root = directory();
  const projects = path.join(root, 'unused-claude');
  const codexSessions = path.join(root, 'sessions');
  const ids = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map((prefix) => `${prefix}-1111-1111-1111-111111111111`);
  const files = ids.map((id, index) =>
    write(path.join(codexSessions, `rollout-2026-09-26T00-00-00-${id}.jsonl`), [
      {
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: { id, cwd: root, source: 'exec', ...(index === 2 ? { parent_thread_id: ids[1] } : {}) },
      },
      { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: id } },
      { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: id, model: 'gpt-6-sol' } },
      ...(index < 2
        ? [
            {
              type: 'event_msg',
              timestamp: '2026-09-26T00:00:03Z',
              payload: {
                type: 'item_completed',
                item: {
                  type: 'CommandExecution',
                  id: 'launch',
                  parsed_cmd: [{ cmd: 'python launch.py --arc-dispatch' }],
                  stdout: `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'codex', session_id: ids[index + 1] })}`,
                },
              },
            },
          ]
        : []),
    ]),
  );
  write(path.join(projects, 'project', 'unused.jsonl'), [claudeRequest('unused', 1)]);
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const reads = vi.spyOn(nativeFs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    assert.deepEqual(
      sessionSources(files[0], { projects, codexSessions }).map((source) => source.sessionId),
      ids,
    );
    assert.equal(reads.mock.calls.filter(([file]) => String(file) === projects).length, 0);
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a same-project dispatch resolves with relative and differently cased project roots', () => {
  const projects = path.join(directory(), 'projects');
  const project = path.join(projects, 'project-a');
  const parent = write(path.join(project, 'parent.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'launch',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'launch-tool', name: 'Bash', input: { command: 'claude --bg -p task' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-26T00:00:02Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-tool', content: 'child' }] },
      toolUseResult: { stdout: '{"type":"result","session_id":"abcdef12"}' },
    },
  ]);
  write(path.join(project, 'abcdef12.jsonl'), [claudeRequest('child', 2)]);
  write(path.join(project, 'abcdef12', 'subagents', 'agent-grandchild.jsonl'), [claudeRequest('grandchild', 3)]);
  const ids = (root: string) => sessionSources(parent, { projects: root }).map((source) => source.sessionId);
  const expected = ['parent', 'abcdef12', 'grandchild'];
  assert.deepEqual(ids(projects), expected);
  assert.deepEqual(ids(path.relative(process.cwd(), projects)), expected);
  if (process.platform === 'win32') assert.deepEqual(ids(projects.toUpperCase()), expected);
});

test('an unknown id reports no transcript', () => {
  const root = directory();
  assert.throws(
    () =>
      findSessionTranscript('absent', {
        projects: path.join(root, 'projects'),
        codexSessions: path.join(root, 'sessions'),
      }),
    /No transcript found for absent/,
  );
});

test('an id matching two stores reports both paths', () => {
  const root = directory();
  const projects = path.join(root, 'projects');
  const sessions = path.join(root, 'sessions');
  const claude = write(path.join(projects, 'project-a', 'same.jsonl'), [{}]);
  const codex = write(path.join(sessions, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-same.jsonl'), [{}]);
  assert.throws(
    () => findSessionTranscript('same', { projects, codexSessions: sessions }),
    (error: Error) => error.message.includes(claude) && error.message.includes(codex),
  );
});

test('mixed dispatched source chains include Codex native descendants once from either parent agent', async () => {
  for (const parentAgent of ['claude', 'codex']) {
    const root = directory();
    const projects = path.join(root, 'projects');
    const sessions = path.join(root, 'sessions');
    const parentId = 'bbbbbbbb-1111-1111-1111-111111111111';
    const childId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const claudeId = 'cccccccc-1111-1111-1111-111111111111';
    const receipt = (agent: string, sessionId: string) =>
      `ARC_DISPATCH_SESSION=${JSON.stringify({ agent, session_id: sessionId })}`;
    const command = (stdout: string) => ({
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:03Z',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'launch',
          parsed_cmd: [{ cmd: 'python launch.py --arc-dispatch' }],
          stdout,
        },
      },
    });
    const rollout = (id: string, parent: string | null, output: number, stdout?: string) =>
      write(path.join(sessions, `rollout-2026-09-26T00-00-00-${id}.jsonl`), [
        {
          type: 'session_meta',
          timestamp: '2026-09-26T00:00:00Z',
          payload: {
            id,
            cwd: root,
            source: 'exec',
            model_provider: 'openai',
            ...(parent ? { parent_thread_id: parent } : {}),
          },
        },
        { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: id } },
        { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: id, model: 'gpt-6-sol' } },
        ...(stdout ? [command(stdout)] : []),
        {
          type: 'event_msg',
          timestamp: '2026-09-26T00:00:04Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output },
              total_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output },
              model_context_window: 258400,
            },
          },
        },
        { type: 'event_msg', timestamp: '2026-09-26T00:00:05Z', payload: { type: 'task_complete', turn_id: id } },
      ]);
    const claude = (id: string, targetAgent: string, targetId: string) =>
      write(path.join(projects, 'project', `${id}.jsonl`), [
        { type: 'user', cwd: root, message: { role: 'user', content: 'work' } },
        claudeRequest(id, 7),
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'launch', name: 'Bash', input: { command: 'python launch.py --arc-dispatch' } },
            ],
          },
        },
        {
          type: 'user',
          toolUseResult: { stdout: receipt(targetAgent, targetId) },
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'launch', content: receipt(targetAgent, targetId) }],
          },
        },
      ]);
    const parent =
      parentAgent === 'codex'
        ? rollout(parentId, null, 2, receipt('codex', childId))
        : claude(parentId, 'codex', childId);
    rollout(childId, null, 3, receipt('claude', claudeId));
    rollout('native', childId, 5);
    claude(claudeId, parentAgent, parentId);
    const roots = { projects, codexSessions: sessions };
    const sources = sessionSources(parent, roots);
    assert.deepEqual(
      new Set(sources.map((source) => source.sessionId)),
      new Set([parentId, childId, 'native', claudeId]),
    );
    assert.equal(sources.length, 4);
    assert.deepEqual(await sessionSourcesAsync(parent, roots), sources);
    for (const options of [
      { roots, byModel: true },
      { roots, byModel: true, since: '2026-09-26T00:00:02Z', until: '2026-09-26T00:00:05Z' },
      { roots, sourceOnly: true, byModel: true },
    ])
      assert.deepEqual(await sessionCostReportAsync(parent, options), sessionCostReport(parent, options));
    assert.equal(sources.find((source) => source.sessionId === childId)?.kind, 'codex-thread');
    assert.equal(sessionCostReport(parent, { roots }).combined.outputTokens, parentAgent === 'codex' ? 17 : 22);
  }
});

test('native CLI source collection visits each source once across a chain and siblings', () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const files = Array.from({ length: 16 }, (_, index) =>
    write(path.join(sessions, `rollout-2026-09-26T00-00-00-${index}.jsonl`), [
      {
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: {
          id: String(index),
          cwd: root,
          source: 'exec',
          ...(index ? { parent_thread_id: String(index < 8 ? index - 1 : 3) } : {}),
        },
      },
    ]),
  );
  const realpath = fs.realpathSync;
  let calls = 0;
  fs.realpathSync = Object.assign(
    ((...args: Parameters<typeof realpath>) => {
      calls++;
      return (realpath as any)(...args);
    }) as typeof realpath,
    { native: realpath.native },
  );
  try {
    const sources = sessionSources(files[0], { codexSessions: sessions });
    assert.equal(sources.length, files.length);
    assert.ok(calls <= files.length * 2, `${calls} canonical lookups for ${files.length} sources`);
  } finally {
    fs.realpathSync = realpath;
  }
});

test('Bedrock cache expiry uses documented duration for write-only, read-only and mixed usage without inventing request coverage', () => {
  for (const first of [
    { input_tokens: 1000, cache_write_input_tokens: 1000, output_tokens: 10 },
    { input_tokens: 1000, cached_input_tokens: 1000, output_tokens: 10 },
    { input_tokens: 1000, cached_input_tokens: 500, cache_write_input_tokens: 500, output_tokens: 10 },
  ]) {
    for (const model of [
      'openai.gpt-6.1-sol',
      'us.openai.gpt-6.1-sol',
      'global.openai.gpt-6.1-sol',
      'openai.gpt-6-luna',
    ]) {
      const f = cumulativeCostFixture('bedrock-expiry', model);
      const file = f.save([
        { ...f.start[0], payload: { id: 'bedrock-expiry', cwd: directory(), model_provider: 'amazon-bedrock' } },
        ...f.start.slice(1),
        { type: 'event_msg', timestamp: f.at(3), payload: { type: 'user_message', message: 'first prompt' } },
        { type: 'event_msg', timestamp: f.at(3), payload: { type: 'token_count', info: { last_token_usage: first } } },
        { type: 'event_msg', timestamp: f.at(4), payload: { type: 'task_complete', turn_id: 'turn-1' } },
        { type: 'event_msg', timestamp: f.at(1863), payload: { type: 'task_started', turn_id: 'turn-2' } },
        { type: 'turn_context', timestamp: f.at(1863), payload: { turn_id: 'turn-2', model } },
        { type: 'event_msg', timestamp: f.at(1863), payload: { type: 'user_message', message: 'second prompt' } },
        {
          type: 'event_msg',
          timestamp: f.at(1863),
          payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, output_tokens: 10 } } },
        },
      ]);
      const report = sessionCostReport(file, { sourceOnly: true }).parent;
      assert.equal(report.cacheExpiry?.byLifetime['30m'], 1, model);
      assert.equal(report.cacheExpiry?.byBoundary.afterAUserTurn, 1, model);
      assert.equal(report.cacheExpiry?.unavailableLifetime, 0, model);
      assert.equal(report.cacheExpiry?.coverage, 'unknown-request-coverage');
      assert.equal(report.cacheExpiry?.inputCostAfterExpiryUsd, null);
      assert.equal(report.requests, 2);
    }
  }
});

test('Bedrock Astra parent and native Plato each price their own requests exactly once', () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const parent = write(path.join(sessions, 'rollout-bedrock-astra-parent.jsonl'), bedrockAstraRecords());
  write(path.join(sessions, 'rollout-bedrock-astra-plato.jsonl'), bedrockAstraRecords(true));
  const report = sessionCostReport(parent, {
    roots: { codexSessions: sessions, projects: path.join(root, 'projects') },
    byModel: true,
  });
  assert.equal(report.children.length, 1);
  for (const [row, count, cost, quantities] of [
    [report.parent, 33, 6.5229, [1386, 2_854_856, 195_229, 12_416]],
    [report.children[0], 11, 2.5627, [462, 678_914, 100_169, 7882]],
    [report.combined, 44, 9.0856, [1848, 3_533_770, 295_398, 20_298]],
  ] as const) {
    assert.equal(row.requests, count);
    assert.equal(row.pricedRequests, count);
    assert.equal(row.unpricedRequests, 0);
    assert.ok(row.costUsd !== null && Math.abs(row.costUsd! - cost) < 1e-10);
    assert.deepEqual(
      [row.uncachedInputTokens, row.cachedInputTokens, row.cacheWriteInputTokens, row.outputTokens],
      quantities,
    );
  }
});

test('cache-expiry evidence reports the cost a warm cache would have saved beside the input cost', () => {
  const file = path.join(directory(), 'expired.jsonl');
  const usage = (input: number, write5m: number, read = 0) => ({
    input_tokens: input,
    output_tokens: 1,
    cache_read_input_tokens: read,
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: 0 },
  });
  const records = [
    { type: 'user', timestamp: '2026-09-26T00:00:00Z', message: { content: 'first' } },
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: { id: 'one', model: 'claude-opus-5', usage: usage(100, 299_900), content: [] },
    },
    { type: 'user', timestamp: '2026-09-26T01:00:00Z', message: { content: 'second' } },
    {
      type: 'assistant',
      timestamp: '2026-09-26T01:00:01Z',
      message: { id: 'two', model: 'claude-opus-5', usage: usage(10_000, 300_000), content: [] },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const rate = (category: 'input' | 'cacheWrite5m' | 'cacheRead') =>
    quoteUsage({
      usage: {
        requests: 1,
        input: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead: 0,
        output: 0,
        thinking: 0,
        [category]: 1_000_000,
      },
      model: 'claude-opus-5',
      provider: null,
      contextWindow: null,
      requestTokens: 1,
      inferenceClass: null,
      serviceTier: null,
      reportedCost: null,
    })!.cost / 1_000_000;

  const expiry = sessionCostReport(file, { sourceOnly: true }).parent.cacheExpiry!;

  assert.equal(expiry.returns, 1);
  // The return resent the previous request's 300k context and sent 10k of new text.
  assert.equal(
    expiry.inputCostAfterExpiryUsd,
    Number((10_000 * rate('input') + 300_000 * rate('cacheWrite5m')).toFixed(4)),
  );
  assert.equal(
    expiry.extraCostAfterExpiryUsd,
    Number((300_000 * (rate('cacheWrite5m') - rate('cacheRead'))).toFixed(4)),
  );
});

test('session cost prices a Claude advisor consultation at the advisor model rates', () => {
  const root = directory();
  const projects = path.join(root, 'projects');
  const file = write(path.join(projects, 'advisor-probe', 'advisor-probe.jsonl'), advisorProbeRecords());
  const report = sessionCostReport(file, {
    roots: { codexSessions: path.join(root, 'sessions'), projects },
    byModel: true,
  });
  const executor = ADVISOR_MODEL_USAGE[ADVISOR_EXECUTOR].costUSD;
  const advisor = ADVISOR_MODEL_USAGE[ADVISOR_MODEL].costUSD;
  assert.equal(report.parent.requests, 2);
  assert.equal(report.parent.unpricedRequests, 0);
  assert.equal(report.parent.costUsd, Number((executor + advisor).toFixed(4)));
  assert.deepEqual(
    [report.parent.contextFirst, report.parent.contextMean, report.parent.contextMax],
    [43_473, 43_473, 43_473],
  );
  assert.deepEqual(
    report.parent.modelCosts?.map((row) => [row.model, row.requests, row.costUsd]),
    [
      [ADVISOR_EXECUTOR, 1, Number(executor.toFixed(4))],
      [ADVISOR_MODEL, 1, Number(advisor.toFixed(4))],
    ],
  );
  // The CLI priced the executor's five-minute writes from its last pass, which the top-level split omits.
  const unrounded = readSessionRequests(file)
    .filter((request) => !request.evidenceOnly)
    .reduce(
      (sum, request) =>
        sum +
        (quoteUsage({ usage: request.usage, model: request.model, provider: null, contextWindow: null })?.cost ?? NaN),
      0,
    );
  assert.ok(Math.abs(unrounded - (executor + advisor)) < 1e-9, String(unrounded));
});

test('advisor consultations stay out of cache-expiry returns and context figures', () => {
  const root = directory();
  const first = [
    advisorIteration({
      input_tokens: 3,
      output_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 30_000, ephemeral_1h_input_tokens: 0 },
    }),
    advisorIteration({ type: 'advisor_message', model: ADVISOR_MODEL, input_tokens: 90_000, output_tokens: 400 }),
    advisorIteration({ input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 30_000 }),
  ];
  // Ten minutes later the five-minute write has lapsed, and the next response writes the prefix again.
  const later = [
    advisorIteration({
      input_tokens: 4,
      output_tokens: 12,
      cache_creation: { ephemeral_5m_input_tokens: 60_050, ephemeral_1h_input_tokens: 0 },
    }),
    advisorIteration({ type: 'advisor_message', model: ADVISOR_MODEL, input_tokens: 95_000, output_tokens: 300 }),
  ];
  const summary = (advised: boolean) => {
    const keep = (items: typeof first) => (advised ? items : items.filter((item) => item.type === 'message'));
    const records = [
      ...advisorResponseRecords({ id: 'first', iterations: keep(first) }),
      ...advisorResponseRecords({ id: 'later', at: 600, iterations: keep(later) }),
    ];
    return summarizeRequests(readSessionRequests(write(path.join(root, `${advised}.jsonl`), records)));
  };
  const advised = summary(true);
  const plain = summary(false);
  assert.equal(advised.requests, plain.requests + 2);
  assert.equal(plain.cacheExpiry?.returns, 1);
  assert.equal(advised.contextFirst, 30_002);
  assert.equal(plain.contextFirst, 30_002);
  const figures = ({ cacheExpiry, contextMean, contextMax }: typeof plain) => ({
    returns: cacheExpiry?.returns,
    contextMean,
    contextMax,
  });
  assert.deepEqual(figures(advised), figures(plain));
  assert.equal(advised.contextMean, 45_028);
  assert.equal(advised.contextMax, 60_054);
  assert.equal(advised.cacheExpiry?.extraCostAfterExpiryUsd, 0.0035);
});

test('an advisor cannot become the parent window peak context after an Agent launch', () => {
  const root = directory();
  const launch = {
    type: 'assistant',
    uuid: 'launch-record',
    timestamp: '2026-10-11T09:08:09Z',
    message: {
      id: 'launch',
      role: 'assistant',
      model: ADVISOR_EXECUTOR,
      content: [{ type: 'tool_use', id: 'agent-call', name: 'Agent', input: { prompt: 'Review.' } }],
      usage: { input_tokens: 30_000, output_tokens: 10 },
    },
  };
  const result = {
    type: 'user',
    timestamp: '2026-10-11T09:08:09.500Z',
    toolUseResult: { agentId: 'child' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'Finished.' }] },
  };
  const file = write(path.join(root, 'parent.jsonl'), [
    launch,
    result,
    ...advisorResponseRecords({
      iterations: [
        advisorIteration({ input_tokens: 20_000, output_tokens: 10 }),
        advisorIteration({ type: 'advisor_message', model: ADVISOR_MODEL, input_tokens: 95_000, output_tokens: 300 }),
        advisorIteration({ input_tokens: 40_000, output_tokens: 20 }),
      ],
    }),
  ]);
  const report = sessionCostReport(file, { windowAgent: 'child' });
  assert.equal(report.parentWindow?.requests, 3);
  assert.equal(report.parentWindow?.contextAtStart, 30_000);
  assert.equal(report.parentWindow?.contextAtPeak, 40_000);
  assert.equal(report.parentWindow?.costUsd, report.parent.costUsd);
  assert.ok((report.parentWindow?.costUsd ?? 0) > 0.19);
});

test('an unknown Claude usage iteration leaves the session cost partial', () => {
  const root = directory();
  const iterations = [...ADVISOR_ITERATIONS, advisorIteration({ type: 'future_message', input_tokens: 500 })];
  const file = write(path.join(root, 'unknown.jsonl'), advisorResponseRecords({ iterations }));
  const summary = summarizeRequests(readSessionRequests(file));
  assert.equal(summary.requests, 2);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.costUsd, null);
});

// The panel reads tool results through its own transcript readers, the spend ledger and the
// session cost popover. Each Tools row must give the share and request count that the matching
// `arc cost --by-tool` kinds give.
// The session cost parts the panel reads from a transcript's lifetime buckets.
function panelParts(file: string, reducer: Parameters<typeof projectSpend.indexSpendFile>[3]) {
  const { record } = projectSpend.indexSpendFile(
    undefined,
    file,
    'workspace',
    reducer,
    Date.parse('2026-09-27T00:00:00Z'),
  );
  return (record.lifetimeBuckets ?? []).map((bucket) => sessionCostUsageOf({ bucket, role: 'main' }));
}

// The Tools tab rows as label, share, and request count.
function panelTools(parts: Parameters<typeof sessionCostProjection>[0]) {
  const chip = sessionCostProjection(parts).stats.find((stat) => stat.metric === 'cost')!;
  // Every part is main agent work, so a row's share of the main agent's cost gives its dollars.
  return chip
    .detailList!.cost!.tabs.find((tab) => tab.name === 'Tools')!
    .parts[0].rows.map((row) => ({
      label: row.label,
      percent: row.percent,
      dollars: row.share * Number(chip.dollars),
      requests: Number(/, ([0-9,]+) requests?, /.exec(row.title)![1].replace(/,/g, '')),
    }));
}

function panelToolRows(file: string, reducer: Parameters<typeof projectSpend.indexSpendFile>[3]) {
  return panelTools(panelParts(file, reducer)).map((row) => [row.label, row.percent, row.requests]);
}

// Rows by share, then by label, so two rows with one share compare in one order.
const byShare = (rows: (string | number)[][]) =>
  [...rows].sort(
    (left, right) =>
      parseInt(String(right[1])) - parseInt(String(left[1])) || String(left[0]).localeCompare(String(right[0])),
  );

function cliToolRows(file: string, merged: readonly string[]) {
  const rows = sessionCostReport(file, { byTool: true, sourceOnly: true }).byTool!.rows;
  const label: Record<string, string> = { wait: 'Waits', 'file read': 'File read', search: 'Search', git: 'Git' };
  const shown = rows.filter((row) => !merged.includes(row.kind));
  const rest = rows.filter((row) => merged.includes(row.kind));
  return [
    ...shown.map((row) => ({
      label: row.kind === 'no tool result' ? 'No tool result' : label[row.kind],
      share: row.shareOfCost!,
      requests: row.requests,
    })),
    {
      label: 'Other tool results',
      share: rest.reduce((sum, row) => sum + row.shareOfCost!, 0),
      requests: rest.reduce((sum, row) => sum + row.requests, 0),
    },
  ]
    .sort((left, right) => right.share - left.share)
    .map((row) => [row.label, `${Math.round(row.share * 100)}%`, row.requests]);
}

test('the panel Tools rows agree with arc cost --by-tool on a Codex and a Claude transcript', () => {
  const f = cumulativeCostFixture();
  const { call, output } = codexToolRecords(f);
  const codex = f.save([
    ...f.start,
    f.bill('r1', 3, 1),
    call(4, 'w', 'wait_agent', { timeout_ms: 1000 }),
    output(5, 'w', JSON.stringify({ timed_out: true })),
    f.snapshot(6, 1),
    f.bill('r2', 7, 2),
    call(8, 'a', 'exec_command', { cmd: 'cat a.ts' }),
    call(9, 'b', 'exec_command', { cmd: 'cat b.ts' }),
    call(10, 'g', 'exec_command', { cmd: 'git status' }),
    output(11, 'a', 'a'),
    output(12, 'b', 'b'),
    output(13, 'g', 'clean'),
    f.snapshot(14, 2),
    f.bill('r3', 15, 3),
    call(16, 's', 'exec_command', { cmd: 'rg -n foo src' }),
    output(17, 's', 'src/a.ts:1:foo'),
    f.snapshot(18, 3),
    f.bill('r4', 19, 4),
    f.snapshot(20, 4),
    f.bill('r5', 21, 5),
    f.snapshot(22, 5),
  ]);
  const codexRows = panelToolRows(codex, codexReader.createCodexUsageLineReducer as never);
  assert.deepEqual(byShare(codexRows), byShare(cliToolRows(codex, ['git'])));
  assert.deepEqual(byShare(codexRows), [
    ['No tool result', '40%', 2],
    ['Search', '20%', 1],
    ['Waits', '20%', 1],
    ['File read', '13%', 1],
    ['Other tool results', '7%', 1],
  ]);
  // A repeated billing record for a response adds the results read after its first record.
  const r = cumulativeCostFixture();
  const repeated = r.save([
    ...r.start,
    r.bill('r1', 3, 1),
    call(4, 'w', 'wait_agent', { timeout_ms: 1000 }),
    output(5, 'w', JSON.stringify({ timed_out: false })),
    r.snapshot(6, 1),
    r.bill('r2', 7, 2),
    r.snapshot(8, 2),
    call(9, 'p', 'apply_patch', { input: '*** Begin Patch' }),
    output(10, 'p', 'Done'),
    r.bill('r2', 11, 2),
    call(12, 'g', 'exec_command', { cmd: 'git status' }),
    output(13, 'g', 'clean'),
    r.bill('r3', 14, 3),
    r.snapshot(15, 3),
    call(16, 's', 'exec_command', { cmd: 'rg -n foo src' }),
    output(17, 's', 'src/a.ts:1:foo'),
    r.bill('r4', 18, 4),
    r.snapshot(19, 4),
  ]);
  const repeatedRows = panelToolRows(repeated, codexReader.createCodexUsageLineReducer as never);
  assert.deepEqual(byShare(repeatedRows), byShare(cliToolRows(repeated, ['file edit'])));
  assert.deepEqual(byShare(repeatedRows), [
    ['Git', '25%', 1],
    ['No tool result', '25%', 1],
    ['Search', '25%', 1],
    ['Other tool results', '13%', 1],
    ['Waits', '13%', 1],
  ]);
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const response = (id: string, second: number, content: object[] = []) => ({
    type: 'assistant',
    timestamp: `2026-09-26T00:00:0${second}Z`,
    message: { id, role: 'assistant', model: 'claude-opus-5', usage, content },
  });
  const results = (ids: string[]) => ({
    type: 'user',
    message: { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) },
  });
  const claude = write(path.join(directory(), 'tools.jsonl'), [
    response('m1', 1, [
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'b.ts' } },
      { type: 'tool_use', id: 'g1', name: 'Bash', input: { command: 'git log -1' } },
    ]),
    results(['r1', 'r2', 'g1']),
    response('m2', 2, [{ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'foo' } }]),
    results(['s1']),
    // A repeated result line adds no result, as the CLI counts each result once.
    results(['s1']),
    response('m3', 3),
    response('m4', 4),
  ]);
  const claudeRows = panelToolRows(claude, (state) => createClaudeUsageLineReducer(state as never));
  assert.deepEqual(claudeRows, cliToolRows(claude, ['git']));
  assert.deepEqual(claudeRows, [
    ['No tool result', '50%', 2],
    ['Search', '25%', 1],
    ['File read', '17%', 1],
    ['Other tool results', '8%', 1],
  ]);
  // A compaction estimate counts under No tool result in the panel. The CLI counts recorded usage
  // only, so every other row matches, and No tool result differs by the estimate alone.
  const compacted = write(path.join(directory(), 'compacted.jsonl'), [
    response('c1', 1, [
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', id: 'g1', name: 'Bash', input: { command: 'git log -1' } },
    ]),
    results(['r1', 'g1']),
    {
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-09-26T00:00:02Z',
      compactMetadata: { trigger: 'manual', preTokens: 62_077, postTokens: 4_336, durationMs: 12_409 },
    },
    {
      type: 'user',
      isCompactSummary: true,
      timestamp: '2026-09-26T00:00:02Z',
      message: { role: 'user', content: 'Retained summary' },
    },
    response('c2', 3),
  ]);
  const parts = panelParts(compacted, (state) => createClaudeUsageLineReducer(state as never));
  const estimates = parts.filter((part) => part.compactionEstimate);
  assert.equal(estimates.length, 1);
  const estimated = Number(sessionCostProjection(estimates).stats.find((stat) => stat.metric === 'cost')!.dollars);
  assert.ok(estimated > 0);
  const label: Record<string, string> = { 'no tool result': 'No tool result', 'file read': 'File read', git: 'Git' };
  const cli = sessionCostReport(compacted, { byTool: true, sourceOnly: true }).byTool!.rows.map((row) => ({
    label: label[row.kind],
    dollars: row.costUsd,
    requests: row.requests,
  }));
  const panel = panelTools(parts);
  // The CLI rounds dollars to four places, so the panel's dollars compare at that precision.
  const cents = (rows: { label: string; dollars: number; requests: number }[]) =>
    rows
      .map((row) => [row.label, Math.round(row.dollars * 10_000 + 1e-9), row.requests])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const others = (rows: { label: string; dollars: number; requests: number }[]) =>
    cents(rows.filter((row) => row.label !== 'No tool result'));
  assert.deepEqual(others(panel), others(cli));
  assert.deepEqual(
    others(panel).map((row) => row[0]),
    ['File read', 'Git'],
  );
  const none = (rows: { label: string; dollars: number; requests: number }[]) =>
    rows.find((row) => row.label === 'No tool result')!;
  assert.equal(none(panel).requests, none(cli).requests + estimates[0].usage.requests!);
  assert.equal(estimates[0].usage.requests, 1);
  assert.ok(Math.abs(none(panel).dollars - none(cli).dollars - estimated) < 0.0001);
  // Supplemental usage and a recorded cost carry no tool results, so the panel counts both under
  // No tool result and leaves every other row as it was. The CLI reads neither.
  const recorded = parts.find((part) => !part.compactionEstimate)!;
  const supplemental = { ...recorded, usage: { ...recorded.usage, requests: 2 } };
  delete supplemental.tools;
  delete supplemental.waits;
  const listed = { ...supplemental, usage: { ...supplemental.usage, requests: 3 }, recordedCost: 4, costBasis: 'list' };
  const added = Number(
    sessionCostProjection([supplemental, listed]).stats.find((stat) => stat.metric === 'cost')!.dollars,
  );
  const widened = panelTools([...parts, supplemental, listed]);
  assert.deepEqual(others(widened), others(panel));
  assert.equal(none(widened).requests, none(panel).requests + 5);
  assert.ok(Math.abs(none(widened).dollars - none(panel).dollars - added) < 1e-9);
  assert.ok(added > 4);
});
