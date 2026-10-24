import {
  bedrockAstraRecords,
  advisorProbeRecords,
  advisorResponseRecords,
  PER_PASS_ITERATIONS,
  claudeDispatchTranscript,
} from '../../extension/src/turnfixtures.ts';
import { tempDir } from '../../extension/src/temproot.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { runCost as costOutput } from '../src/cost.ts';

const runCost = async (args: string[]) => await costOutput([...args, '--json']);
const round = (value: number) => Math.round(value * 10_000) / 10_000;

test.each([
  'codex catalog',
  'claude catalog',
  'id lookup',
  'native child admission',
  'claude relationships',
  'codex relationships',
  'claude usage',
  'codex usage',
])('cost cancels during %s before discovery or reading finishes', async (stage) => {
  const { root, projects, codex, file: claude } = fixture();
  const controller = new AbortController();
  const reason = new Error('cancel selected cost read');
  const entries = 80;
  const transcriptBytes = 1024 * 1024;
  const readBudget = 512 * 1024;
  const flags = ['--projects', projects, '--codex-sessions', codex, '--json'];
  let target = claude;
  if (stage.startsWith('codex')) {
    target = path.join(codex, 'rollout-parent.jsonl');
    fs.writeFileSync(target, JSON.stringify({ type: 'session_meta', payload: { id: 'parent', source: 'cli' } }) + '\n');
  }
  if (stage === 'codex catalog') {
    for (let index = 0; index < entries; index++)
      fs.writeFileSync(
        path.join(codex, `rollout-${index}.jsonl`),
        JSON.stringify({ type: 'session_meta', payload: { id: `unrelated-${index}`, source: 'cli' } }) + '\n',
      );
  } else if (stage === 'claude catalog') {
    fs.appendFileSync(
      target,
      claudeDispatchTranscript(
        'python launch.py --arc-dispatch',
        'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa-1111-2222-3333-444444444444"}',
      )
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    for (let index = 0; index < entries; index++)
      fs.copyFileSync(claude, path.join(path.dirname(claude), `unrelated-${index}.jsonl`));
  } else if (stage === 'id lookup') {
    target = 'wanted';
    for (let index = 0; index < entries; index++) fs.mkdirSync(path.join(projects, `project-${index}`));
    fs.copyFileSync(claude, path.join(projects, 'project-0', 'wanted.jsonl'));
  } else if (stage === 'native child admission') {
    const directory = path.join(path.dirname(claude), 'session-1', 'subagents');
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < entries; index++) fs.copyFileSync(claude, path.join(directory, `agent-${index}.jsonl`));
  } else {
    fs.appendFileSync(target, '\n'.repeat(transcriptBytes));
    if (stage.endsWith('usage')) flags.push('--source-only');
  }
  const nativeFs: typeof fs = createRequire(import.meta.url)('node:fs');
  const originalOpen = nativeFs.openSync;
  const originalRead = nativeFs.readSync;
  const originalClose = nativeFs.closeSync;
  const originalStat = nativeFs.statSync;
  const originalExists = nativeFs.existsSync;
  const originalRealpathNative = nativeFs.realpathSync.native;
  const descriptors = new Map<number, string>();
  let work = 0;
  let observed: number | undefined;
  let scheduled: NodeJS.Immediate | undefined;
  const interrupt = () => {
    if (scheduled) return;
    scheduled = setImmediate(() => {
      observed = work;
      controller.abort(reason);
    });
  };
  const spies = [
    vi.spyOn(nativeFs.realpathSync, 'native').mockImplementation(((
      ...args: Parameters<typeof fs.realpathSync.native>
    ) => {
      if (stage === 'native child admission' && path.basename(String(args[0])).startsWith('agent-')) {
        work++;
        interrupt();
      }
      return originalRealpathNative(...args);
    }) as typeof fs.realpathSync.native),
    vi.spyOn(nativeFs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      descriptors.set(fd, String(args[0]));
      return fd;
    }) as typeof fs.openSync),
    vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
      descriptors.delete(fd);
      originalClose(fd);
    }),
    vi.spyOn(nativeFs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const bytes = originalRead(...args);
      if (
        stage !== 'id lookup' &&
        !stage.endsWith('catalog') &&
        descriptors.get(args[0]) === target &&
        bytes >= 64 * 1024
      ) {
        work += bytes;
        interrupt();
      }
      return bytes;
    }) as typeof fs.readSync),
    vi.spyOn(nativeFs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      const name = String(args[0]);
      if (
        stage.endsWith('catalog') &&
        name.startsWith(stage === 'codex catalog' ? codex : path.dirname(claude)) &&
        /^(?:unrelated-|rollout-\d)/.test(path.basename(name))
      ) {
        work++;
        interrupt();
      }
      return originalStat(...args);
    }) as typeof fs.statSync),
    vi.spyOn(nativeFs, 'existsSync').mockImplementation((file) => {
      if (stage === 'id lookup' && String(file).startsWith(projects) && String(file).endsWith('wanted.jsonl')) {
        work++;
        interrupt();
      }
      return originalExists(file);
    }),
  ];
  syncBuiltinESMExports();
  try {
    await assert.rejects(costOutput([target, ...flags], controller.signal), (error) => error === reason);
    assert.ok(observed !== undefined && observed > 0, 'An event-loop callback must run during the selected work.');
    assert.ok(
      work <
        (stage.endsWith('catalog') || stage === 'id lookup' || stage === 'native child admission'
          ? entries
          : readBudget),
      `${work} completed work before cancellation`,
    );
    assert.equal(descriptors.size, 0, 'Cancellation must close every opened transcript.');
  } finally {
    if (scheduled) clearImmediate(scheduled);
    for (const spy of spies) spy.mockRestore();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each([1, 2])(
  'cost reads a large dispatch catalog across %i project directories without argument expansion',
  async (projectCount) => {
    const { root, projects, codex, file } = fixture();
    const entries = 160_000;
    const perProject = entries / projectCount;
    const directories = Array.from({ length: projectCount }, (_, index) => path.join(projects, `catalog-${index}`));
    const names = Array<string>(perProject).fill('unrelated.jsonl');
    fs.appendFileSync(
      file,
      claudeDispatchTranscript(
        'python launch.py --arc-dispatch',
        'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa-1111-2222-3333-444444444444"}',
      )
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const nativeFs: typeof fs = createRequire(import.meta.url)('node:fs');
    const originalRead = nativeFs.readdirSync;
    const originalStat = nativeFs.statSync;
    const stat = originalStat(file, { bigint: true });
    let admitted = 0;
    const reads = vi.spyOn(nativeFs, 'readdirSync').mockImplementation(((
      ...args: Parameters<typeof fs.readdirSync>
    ) => {
      const name = String(args[0]);
      if (name === projects)
        return directories.map((directory) => ({ name: path.basename(directory), isDirectory: () => true }));
      if (directories.includes(name)) return names;
      return originalRead(...args);
    }) as typeof fs.readdirSync);
    const stats = vi.spyOn(nativeFs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      if (directories.includes(path.dirname(String(args[0])))) {
        admitted++;
        return stat;
      }
      return originalStat(...args);
    }) as typeof fs.statSync);
    syncBuiltinESMExports();
    try {
      const report = JSON.parse(await runCost([file, '--projects', projects, '--codex-sessions', codex]));
      assert.equal(admitted, entries);
      assert.equal(report.parent.requests, 1);
      assert.deepEqual(report.children, []);
    } finally {
      reads.mockRestore();
      stats.mockRestore();
      syncBuiltinESMExports();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(['SIGINT', 'SIGTERM'] as const)('main awaits cost and cancels its active scan on %s', async (signal) => {
  const { root, file } = fixture();
  fs.appendFileSync(file, '\n'.repeat(1024 * 1024));
  const argv = process.argv;
  const exitCode = process.exitCode;
  const listenerCounts = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
  const nativeFs: typeof fs = createRequire(import.meta.url)('node:fs');
  const originalRead = nativeFs.readSync;
  const originalOpen = nativeFs.openSync;
  const originalClose = nativeFs.closeSync;
  const descriptors = new Map<number, string>();
  let readBytes = 0;
  let observed = false;
  let scheduled: NodeJS.Immediate | undefined;
  vi.resetModules();
  const command = await import('../src/cost.ts');
  const originalCost = command.runCost;
  let pending: Promise<string> | undefined;
  const cost = vi.spyOn(command, 'runCost').mockImplementation((...args) => {
    pending = originalCost(...args);
    return pending;
  });
  const opens = vi.spyOn(nativeFs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args);
    descriptors.set(fd, String(args[0]));
    return fd;
  }) as typeof fs.openSync);
  const closes = vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
    descriptors.delete(fd);
    originalClose(fd);
  });
  const reads = vi.spyOn(nativeFs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const bytes = originalRead(...args);
    if (descriptors.get(args[0]) === file && bytes >= 64 * 1024) {
      readBytes += bytes;
      if (!scheduled)
        scheduled = setImmediate(() => {
          observed = true;
          process.emit(signal);
        });
    }
    return bytes;
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.argv = [process.execPath, argv[1], 'cost', file, '--source-only', '--json'];
  try {
    await import('../src/main.ts');
    assert.ok(pending, 'main must call the production cost command.');
    await pending.catch(() => {});
    await vi.waitFor(() => assert.ok(stderr.mock.calls.length || stdout.mock.calls.length));
    assert.equal(observed, true);
    assert.ok(readBytes < 128 * 1024, `${readBytes} transcript bytes read before cancellation`);
    assert.equal(descriptors.size, 0);
    assert.deepEqual(stdout.mock.calls, [], 'A cancelled cost command must publish no completed report.');
    assert.match(stderr.mock.calls.map(([text]) => String(text)).join(''), /Cost report cancelled/);
    assert.deepEqual(
      ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)),
      listenerCounts,
    );
    assert.equal(process.exitCode, signal === 'SIGINT' ? 130 : 143);
  } finally {
    if (scheduled) clearImmediate(scheduled);
    process.argv = argv;
    process.exitCode = exitCode;
    cost.mockRestore();
    reads.mockRestore();
    opens.mockRestore();
    closes.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
    syncBuiltinESMExports();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(['SIGINT', 'SIGTERM'] as const)(
  'main honours a %s callback queued after cost rendering before publishing stdout',
  async (signal) => {
    const { root, file } = fixture();
    const argv = process.argv;
    const exitCode = process.exitCode;
    const listenerCounts = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
    let scheduled: NodeJS.Immediate | undefined;
    let observed = false;
    let callback!: () => void;
    const callbackFinished = new Promise<void>((resolve) => (callback = resolve));
    vi.resetModules();
    const command = await import('../src/cost.ts');
    const originalCost = command.runCost;
    const cost = vi.spyOn(command, 'runCost').mockImplementation(async (...args) => {
      const output = await originalCost(...args);
      scheduled = setImmediate(() => {
        observed = process.emit(signal);
        callback();
      });
      return output;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.argv = [process.execPath, argv[1], 'cost', file, '--source-only', '--json'];
    try {
      await import('../src/main.ts');
      await callbackFinished;
      await vi.waitFor(() => assert.ok(stderr.mock.calls.length || stdout.mock.calls.length));
      assert.equal(observed, true, 'The queued callback must reach the active cancellation listener.');
      assert.deepEqual(stdout.mock.calls, [], 'A cancelled cost command must publish no completed report.');
      assert.match(stderr.mock.calls.map(([text]) => String(text)).join(''), /Cost report cancelled/);
      assert.equal(process.exitCode, signal === 'SIGINT' ? 130 : 143);
      assert.deepEqual(
        ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)),
        listenerCounts,
      );
    } finally {
      if (scheduled) clearImmediate(scheduled);
      process.argv = argv;
      process.exitCode = exitCode;
      cost.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
      vi.resetModules();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('human cost preserves unknown totals and requested detail while JSON drops only invariant notes', async () => {
  const { root, file } = fixture();
  try {
    const args = [file, '--source-only', '--by-model', '--by-tool', '--until-text', 'no match'];
    const report = JSON.parse(await runCost(args));
    const human = await costOutput(args);
    for (const value of [
      'Parent',
      'Combined',
      '$0.0002',
      'By model:',
      'By tool',
      'Matched: false',
      report.untilText.note,
    ])
      assert.ok(human.includes(value), value);
    assert.equal(report.untilText.matched, false);
    assert.equal('cacheExpiryNote' in report, false);
    assert.equal('requestsNote' in report.byTool, false);
    assert.equal('requestsNote' in report.untilText.byTool, false);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.message.model = 'unpriced-future-model';
    fs.writeFileSync(file, JSON.stringify(record) + '\n');
    const unknown = await costOutput([file, '--source-only']);
    assert.match(unknown, /Parent\s+1\s+unknown/);
    assert.ok(unknown.includes('unpriced-future-model'));
    const zero = await costOutput([file, '--source-only', '--since', '2027-01-01T00:00:00Z']);
    assert.match(zero, /Parent\s+0\s+unknown/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const defaultRoots = { codex: tempDir('cli-cost-codex-'), projects: tempDir('cli-cost-projects-') };

beforeEach(() => {
  vi.stubEnv('ARC_CODEX_ROOT', defaultRoots.codex);
  vi.stubEnv('ARC_PROJECTS_ROOT', defaultRoots.projects);
});

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-cost-cli-'));
  const projects = path.join(root, 'projects');
  const codex = path.join(root, 'sessions');
  const file = path.join(projects, 'sample', 'session-1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'request-1',
        model: 'claude-opus-5',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) + '\n',
  );
  return { root, projects, codex, file };
}

async function sourceOnlyParity(file: string, flags: string[] = []): Promise<void> {
  const ordinary = JSON.parse(await runCost([file, ...flags]));
  const direct = JSON.parse(await runCost([file, ...flags, '--source-only']));
  assert.deepEqual(direct.parent, ordinary.parent);
  assert.deepEqual(direct.children, []);
  // The coverage diagnostic belongs to source summaries only.
  const { coverageDefect, ...quantities } = direct.parent;
  assert.deepEqual(direct.combined, quantities);
  assert.equal('coverageDefect' in direct.combined, false);
  assert.equal(coverageDefect === undefined || typeof coverageDefect.cause === 'string', true);
  for (const key of ['source', 'window', 'byTool', 'untilText', 'parentWindow'])
    assert.deepEqual(direct[key], ordinary[key]);
  assert.equal('modelCosts' in ordinary.parent, false);
  const detail = JSON.parse(await runCost([file, ...flags, '--source-only', '--by-model']));
  const { modelCosts, ...parent } = detail.parent;
  assert.deepEqual(parent, ordinary.parent);
  assert.equal(Array.isArray(modelCosts), true);
  assert.deepEqual(detail.children, []);
  assert.deepEqual(detail.combined, quantities);
  for (const key of ['source', 'window', 'byTool', 'untilText', 'parentWindow'])
    assert.deepEqual(detail[key], ordinary[key]);
}

test('per-pass pricing reaches arc cost for the e2a025b8 response', async () => {
  const { file, projects, codex } = fixture();
  fs.writeFileSync(
    file,
    [advisorProbeRecords()[0], ...advisorResponseRecords({ iterations: PER_PASS_ITERATIONS, thinking: 152 })]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const { parent } = JSON.parse(
    await runCost([file, '--projects', projects, '--codex-sessions', codex, '--by-model', '--json']),
  );
  assert.equal(parent.costUsd, 0.1537);
  assert.equal(parent.requests, 2);
  assert.equal(parent.contextMean, 66035);
  assert.equal(parent.cacheReadShareOfCost, 0.004);
  assert.deepEqual(
    parent.modelCosts.map((row: { costUsd: number }) => row.costUsd),
    [0.0139, 0.1398],
  );
});

test('cost rejects unsupported formats before applying an empty request window', async () => {
  const { root, file } = fixture();
  const assistant = JSON.parse(fs.readFileSync(file, 'utf8'));
  const init = { type: 'system', subtype: 'init', session_id: 'stream-session', tools: [] };
  const streamed = { ...assistant, parent_tool_use_id: null };
  const result = { type: 'result', subtype: 'success', total_cost_usd: 1, modelUsage: {} };
  const stream = [init, streamed, result];
  const cases = [
    [JSON.stringify(stream), /JSON arrays.*Claude stream logs/],
    [JSON.stringify(stream, null, 2), /JSON arrays.*Claude stream logs/],
    [JSON.stringify([1, { unrelated: true }]), /JSON arrays/],
    [stream.map((record) => JSON.stringify(record)).join('\n'), /Claude stream logs/],
    [JSON.stringify(streamed), /Claude stream logs/],
    [JSON.stringify(result), /Claude stream logs/],
    [JSON.stringify({ type: 'stream_event', event: { type: 'message_delta' } }), /Claude stream logs/],
    ['', /No native transcript records/],
    [' \n\t', /No native transcript records/],
    ['not JSON\n{"unfinished":', /No native transcript records/],
    [JSON.stringify({ unrelated: true }), /No native transcript records/],
    [JSON.stringify({ type: 'assistant' }), /No native transcript records/],
  ] as const;
  try {
    const failures: string[] = [];
    for (const [index, [content, error]] of cases.entries()) {
      fs.writeFileSync(file, content);
      for (const flags of [[], ['--source-only'], ['--since', '2027-01-01T00:00:00Z']]) {
        try {
          await assert.rejects(async () => await runCost([file, ...flags]), error, content);
        } catch (failure) {
          failures.push(`Case ${index}, flags ${flags.join(' ')}: ${String(failure)}`);
        }
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost preserves native usage, metadata-only sessions, and incomplete trailing lines', async () => {
  const { root, file, codex, projects } = fixture();
  try {
    const native = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, '{"type":"assistant","message":');
    assert.equal(JSON.parse(await runCost([file, '--source-only'])).parent.requests, 1);
    assert.equal(JSON.parse(await runCost([file, '--since', '2027-01-01T00:00:00Z'])).parent.requests, 0);
    fs.writeFileSync(file, JSON.stringify({ type: 'custom-title', sessionId: 'session-1', customTitle: 'Saved' }));
    assert.equal(JSON.parse(await runCost([file])).parent.requests, 0);
    const child = path.join(projects, 'sample', 'session-1', 'subagents', 'agent-child.jsonl');
    fs.mkdirSync(path.dirname(child), { recursive: true });
    fs.writeFileSync(child, native);
    const withChild = JSON.parse(await runCost([file, '--projects', projects, '--codex-sessions', codex]));
    assert.equal(withChild.children.length, 1);
    assert.equal(withChild.combined.requests, 1);
    const rollout = path.join(codex, 'rollout-metadata.jsonl');
    fs.writeFileSync(
      rollout,
      JSON.stringify({ type: 'session_meta', payload: { id: 'metadata', cwd: root, source: 'cli' } }),
    );
    assert.equal(JSON.parse(await runCost([rollout, '--source-only'])).parent.requests, 0);
    fs.writeFileSync(
      rollout,
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'native-session', source: 'cli' } }),
    );
    const nativeFs = createRequire(import.meta.url)('node:fs');
    const reads = vi.spyOn(nativeFs, 'readdirSync');
    syncBuiltinESMExports();
    try {
      for (const flags of [[], ['--source-only']]) {
        reads.mockClear();
        const report = JSON.parse(await runCost([rollout, ...flags]));
        assert.deepEqual(
          reads.mock.calls.map(([directory]) => String(directory)),
          flags.length ? [] : [defaultRoots.codex],
        );
        assert.equal(report.source.kind, 'codex');
        assert.equal(report.source.sessionId, 'native-session');
        assert.equal(report.parent.requests, 0);
      }
    } finally {
      reads.mockRestore();
      syncBuiltinESMExports();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('standalone receipts price each original child once through both native parent formats', async () => {
  for (const parentAgent of ['claude', 'codex'])
    for (const childAgent of ['claude', 'codex']) {
      const { root, projects, codex, file } = fixture();
      try {
        const id = 'aaaaaaaa-1111-2222-3333-444444444444';
        const child =
          childAgent === 'claude'
            ? path.join(path.dirname(file), `${id}.jsonl`)
            : path.join(codex, `rollout-${id}.jsonl`);
        const at = '2026-09-26T00:00:01Z';
        const counts = {
          input_tokens: 1000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 100,
          reasoning_output_tokens: 0,
          total_tokens: 1100,
        };
        fs.writeFileSync(
          child,
          childAgent === 'claude'
            ? fs.readFileSync(file)
            : [
                {
                  type: 'session_meta',
                  timestamp: at,
                  payload: { id, cwd: root, source: 'exec', model_provider: 'openai' },
                },
                { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 'own' } },
                {
                  type: 'turn_context',
                  timestamp: at,
                  payload: { turn_id: 'own', model: 'gpt-6-astra', effort: 'high' },
                },
                {
                  type: 'event_msg',
                  timestamp: at,
                  payload: { type: 'token_count', info: { last_token_usage: counts, total_token_usage: counts } },
                },
              ]
                .map((row) => JSON.stringify(row))
                .join('\n') + '\n',
        );
        const marker = `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: childAgent, session_id: id, name: 'Review', owned: true })}`;
        const command = `arc run --provider ${childAgent} --arc-dispatch --agent-run=false`;
        const parent = parentAgent === 'claude' ? file : path.join(codex, 'rollout-parent.jsonl');
        const records =
          parentAgent === 'claude'
            ? [
                ...claudeDispatchTranscript(command, marker, 'first'),
                ...claudeDispatchTranscript(command, marker, 'second'),
              ]
            : [
                { type: 'session_meta', timestamp: at, payload: { id: 'parent', cwd: root, source: 'cli' } },
                { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 'own' } },
                {
                  type: 'turn_context',
                  timestamp: at,
                  payload: { turn_id: 'own', cwd: root, model: 'gpt-6.1-sol', effort: 'high' },
                },
                ...['first', 'second'].map((tool) => ({
                  type: 'event_msg',
                  timestamp: at,
                  payload: {
                    type: 'item_completed',
                    item: {
                      type: 'CommandExecution',
                      id: tool,
                      command: ['bash', '-c', command],
                      status: 'completed',
                      exit_code: 0,
                      stdout: marker,
                    },
                  },
                })),
              ];
        fs.writeFileSync(parent, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
        fs.writeFileSync(path.join(root, 'copied-report.jsonl'), fs.readFileSync(child));
        fs.writeFileSync(path.join(root, 'receipt-output.txt'), marker);
        const roots = ['--projects', projects, '--codex-sessions', codex, '--by-model'];
        const original = JSON.parse(await runCost([child, '--source-only', ...roots]));
        const report = JSON.parse(await runCost([parent, ...roots]));
        assert.equal(original.parent.requests, 1, childAgent);
        assert.equal(report.children.length, 1, `${parentAgent}/${childAgent}`);
        assert.equal(report.children[0].file, child);
        assert.equal(report.children[0].sessionId, id);
        assert.equal(report.children[0].costUsd, original.parent.costUsd);
        assert.equal(report.combined.requests, original.parent.requests);
        assert.equal(report.combined.costUsd, original.parent.costUsd);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
});

test('cost attributes a delayed native child once through colliding parent session ids', async () => {
  const { root, projects, codex } = fixture();
  try {
    const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
    const counts = {
      input_tokens: 1000,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 100,
      reasoning_output_tokens: 0,
      total_tokens: 1100,
    };
    const parent = path.join(codex, 'rollout-parent.jsonl');
    const child = path.join(codex, 'rollout-child.jsonl');
    fs.writeFileSync(
      parent,
      JSON.stringify({
        type: 'session_meta',
        timestamp: at(0),
        payload: {
          id: 'native-parent',
          session_id: 'native-parent',
          cwd: root,
          source: 'cli',
          model_provider: 'openai',
        },
      }) + '\n',
    );
    const records = [
      {
        type: 'session_meta',
        timestamp: at(10),
        payload: {
          id: 'native-child',
          session_id: 'native-parent',
          parent_thread_id: 'native-parent',
          timestamp: at(0),
          cwd: root,
          model_provider: 'openai',
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: 'native-parent' } } },
        },
      },
      {
        type: 'event_msg',
        timestamp: at(11),
        payload: { type: 'task_started', turn_id: 'own', started_at: Date.parse(at(1)) / 1000 },
      },
      { type: 'turn_context', timestamp: at(12), payload: { turn_id: 'own', model: 'gpt-6-astra', effort: 'high' } },
      {
        type: 'token_usage_record',
        timestamp: at(13),
        payload: {
          turn_id: 'own',
          thread_id: 'native-child',
          session_id: 'native-parent',
          response_id: 'response',
          usage: counts,
          thread_token_usage: counts,
          turn_token_usage: counts,
        },
      },
      {
        type: 'event_msg',
        timestamp: at(14),
        payload: { type: 'token_count', info: { last_token_usage: counts, total_token_usage: counts } },
      },
    ];
    fs.writeFileSync(child, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const roots = ['--projects', projects, '--codex-sessions', codex];
    const direct = JSON.parse(await runCost([child, '--source-only', '--by-model', ...roots]));
    assert.equal(direct.parent.requests, 1);
    assert.equal(direct.parent.modelCosts[0].model, 'gpt-6-astra');
    assert.equal(direct.parent.costUsd, 0.015);
    assert.deepEqual(direct.children, []);
    const combined = JSON.parse(await runCost([parent, '--by-model', ...roots]));
    assert.equal(combined.children.length, 1);
    assert.equal(combined.children[0].sessionId, 'native-child');
    assert.equal(combined.combined.requests, 1);
    assert.equal(combined.combined.costUsd, direct.parent.costUsd);
    const [opening, start, context, bill, snapshot] = records;
    opening.payload.timestamp = new Date(Date.parse(at(0)) + 750).toISOString();
    start.payload.started_at = Date.parse(at(0)) / 1000;
    const original = [
      opening,
      start,
      context,
      snapshot,
      { type: 'event_msg', timestamp: at(18), payload: { type: 'task_complete', turn_id: 'own' } },
    ];
    const scenarios = [
      {
        tail: [
          { ...start, timestamp: at(19) },
          { ...bill, timestamp: at(20) },
        ],
        cost: 0.015,
        coverage: 'recorded-reconciled',
      },
      {
        tail: Array.from({ length: 64 }, (_, index) => ({
          type: 'event_msg',
          timestamp: at(21 + index),
          payload: { type: 'task_started', turn_id: `later-${index}`, started_at: Date.parse(at(21 + index)) / 1000 },
        })),
        cost: null,
        coverage: 'legacy-snapshots',
      },
    ];
    for (const scenario of scenarios) {
      fs.writeFileSync(
        child,
        [...original, ...scenario.tail].map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
      const report = JSON.parse(await runCost([child, '--source-only', '--by-model', ...roots])).parent;
      assert.equal(report.requests, 1);
      assert.equal(report.costUsd, scenario.cost);
      assert.equal(report.coverage, scenario.coverage);
      assert.deepEqual(report.models, ['gpt-6-astra']);
    }
    const print = {
      type: 'event_msg',
      timestamp: at(17),
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'print',
          command: ['claude', '-p', 'review', '--output-format', 'json'],
          parsed_cmd: [{ type: 'unknown', cmd: 'claude -p review --output-format json' }],
          status: 'completed',
          exit_code: 0,
          stdout: JSON.stringify({
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
          }),
        },
      },
    };
    for (const beforeBill of [true, false]) {
      const ordered = beforeBill
        ? [...original, print, print, { ...bill, timestamp: at(20) }]
        : [...original, { ...bill, timestamp: at(20) }, print, print];
      fs.writeFileSync(child, ordered.map((record) => JSON.stringify(record)).join('\n') + '\n');
      const report = JSON.parse(await runCost([child, '--by-model', ...roots]));
      assert.equal(report.children.length, 1);
      assert.equal(report.children[0].sessionId, 'printed');
      assert.equal(report.children[0].costUsd, 0.01);
      assert.equal(report.combined.requests, 2);
      assert.equal(report.combined.costUsd, 0.025);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost resolves an id with explicit roots and prints the versioned JSON report by default', async () => {
  const { root, projects, codex, file } = fixture();
  try {
    const report = JSON.parse(await runCost(['session-1', '--projects', projects, '--codex-sessions', codex]));
    assert.equal(report.schemaVersion, 3);
    assert.equal(typeof report.buildCommit, 'string');
    assert.equal(report.source.file, file);
    assert.equal(report.parent.requests, 1);
    assert.deepEqual(report.parent.models, ['claude-opus-5']);
    assert.equal(report.combined.requests, 1);
    await sourceOnlyParity(file, ['--projects', projects, '--codex-sessions', codex]);
    await sourceOnlyParity(path.relative(process.cwd(), file), ['--projects', projects, '--codex-sessions', codex]);
    await assert.rejects(
      async () => await runCost(['session-1', '--source-only', '--projects', projects, '--codex-sessions', codex]),
      /requires an existing transcript file path/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost JSON exposes reconciled recorded totals and retains empty windows with missing bills', async () => {
  const { root, projects, codex } = fixture();
  const file = path.join(codex, 'rollout-2026-09-26T00-00-00-child.jsonl');
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (multiple: number) => ({
    input_tokens: 1000 * multiple,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 100 * multiple,
    reasoning_output_tokens: 0,
    total_tokens: 1100 * multiple,
  });
  const records = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'child', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: {
        thread_id: 'child',
        session_id: 'root-parent',
        turn_id: 'turn-1',
        response_id: 'one',
        usage: usage(1),
        thread_token_usage: usage(1),
        turn_token_usage: usage(1),
      },
    },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage(1), total_token_usage: usage(1) } },
    },
  ];
  const flags = ['--projects', projects, '--codex-sessions', codex, '--by-model', '--source-only'];
  try {
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const report = JSON.parse(await runCost([file, ...flags]));
    assert.equal(report.schemaVersion, 3);
    assert.equal(report.parent.coverage, 'recorded-reconciled');
    assert.equal(report.parent.costUsd, 0.003);
    assert.equal(report.parent.pricedCostUsd, 0.003);
    assert.equal('requestCountExact' in report.parent, false);
    assert.equal(report.parent.modelCosts[0].costUsd, 0.003);
    assert.equal(report.combined.costUsd, 0.003);
    assert.equal(report.parent.toolCalls, null);
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'event_msg',
        timestamp: at(8),
        payload: {
          type: 'token_count',
          info: { last_token_usage: usage(1), total_token_usage: usage(2) },
        },
      }) + '\n',
    );
    const gap = JSON.parse(await runCost([file, ...flags, '--since', at(5), '--until', at(6)]));
    assert.equal(gap.parent.coverage, 'recorded-gaps');
    assert.equal(gap.parent.requests, 0);
    assert.equal(gap.parent.costUsd, null);
    assert.equal(gap.parent.requestCountExact, false);
    assert.equal(gap.combined.costUsd, null);
    assert.equal(gap.combined.coverage, 'recorded-gaps');
    const bill = (response_id: string, second: number, multiple: number) => ({
      type: 'token_usage_record',
      timestamp: at(second),
      payload: {
        thread_id: 'child',
        turn_id: 'turn-1',
        response_id,
        usage: usage(1),
        thread_token_usage: usage(multiple),
        turn_token_usage: usage(multiple),
      },
    });
    const snapshot = (second: number, multiple: number) => ({
      type: 'event_msg',
      timestamp: at(second),
      payload: { type: 'token_count', info: { last_token_usage: usage(1), total_token_usage: usage(multiple) } },
    });
    fs.writeFileSync(
      file,
      [
        ...records.slice(0, 3),
        bill('one', 3, 1),
        snapshot(4, 1),
        bill('two', 5, 2),
        snapshot(7, 1.5),
        bill('three', 8, 3),
        snapshot(9, 3),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const unresolved = JSON.parse(await runCost([file, ...flags, '--since', at(8), '--until', at(10)]));
    assert.equal(unresolved.parent.coverage, 'billed-with-unknown-coverage');
    assert.equal(unresolved.parent.costUsd, null);
    assert.equal(unresolved.parent.pricedCostUsd, 0.003);
    assert.equal(unresolved.parent.requestCountExact, false);
    assert.equal(unresolved.parent.modelCosts[0].costUsd, null);
    assert.equal(unresolved.combined.costUsd, null);
    fs.writeFileSync(
      file,
      [
        ...records.slice(0, 3),
        bill('one', 3, 1),
        snapshot(4, 1),
        bill('two', 5, 2),
        snapshot(7, 1),
        bill('restart', 8, 1),
        snapshot(9, 1),
        bill('next', 12, 2),
        snapshot(13, 2),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const reset = JSON.parse(await runCost([file, ...flags, '--since', at(7), '--until', at(8)]));
    assert.equal(reset.parent.requests, 0);
    assert.equal(reset.parent.coverage, 'billed-with-unknown-coverage');
    assert.equal(reset.parent.costUsd, null);
    assert.equal(reset.parent.requestCountExact, false);
    assert.equal(reset.combined.costUsd, null);
    const recovery = JSON.parse(await runCost([file, ...flags, '--since', at(12), '--until', at(14)]));
    assert.equal(recovery.parent.coverage, 'recorded-reconciled');
    assert.equal(recovery.parent.costUsd, 0.003);
    assert.equal(recovery.parent.modelCosts[0].costUsd, 0.003);
    assert.equal(recovery.combined.costUsd, 0.003);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost selects the explicit Codex sessions root over the environment root', async () => {
  const { root, projects, codex } = fixture();
  const environmentRoot = path.join(root, 'environment-sessions');
  const relativeFile = path.join('2026', '09', '26', 'rollout-2026-09-26T00-00-00-codex-session.jsonl');
  const explicitFile = path.join(codex, relativeFile);
  const environmentFile = path.join(environmentRoot, relativeFile);
  const previousCodex = process.env.ARC_CODEX_ROOT;
  const records = [
    { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'codex-session', source: 'cli' } },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: 'turn-1', model: 'gpt-6-sol' } },
    {
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:03Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 },
          total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 },
        },
      },
    },
  ];
  fs.mkdirSync(path.dirname(explicitFile), { recursive: true });
  fs.mkdirSync(path.dirname(environmentFile), { recursive: true });
  fs.writeFileSync(explicitFile, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  fs.writeFileSync(environmentFile, JSON.stringify(records[0]) + '\n');
  process.env.ARC_CODEX_ROOT = environmentRoot;
  try {
    const report = JSON.parse(await runCost(['codex-session', '--projects', projects, '--codex-sessions', codex]));
    assert.equal(report.source.file, explicitFile);
    assert.equal(report.parent.requests, 1);
    assert.deepEqual(report.parent.models, ['gpt-6-sol']);
  } finally {
    if (previousCodex === undefined) delete process.env.ARC_CODEX_ROOT;
    else process.env.ARC_CODEX_ROOT = previousCodex;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost prices recorded Bedrock GPT-6.1 Sol requests and cache categories', async () => {
  for (const [model, expected] of [
    ['openai.gpt-6.1-sol', 1.76],
    ['us.openai.gpt-6.1-sol', 1.76],
    ['global.openai.gpt-6.1-sol', 1.6],
  ] as const) {
    const { root, projects, codex } = fixture();
    try {
      const file = path.join(codex, '2026', '10', '01', 'rollout-2026-10-01T00-00-00-bedrock-sol.jsonl');
      const records = [
        {
          type: 'session_meta',
          timestamp: '2026-10-01T00:00:00Z',
          payload: { id: 'bedrock-sol', source: 'cli', model_provider: 'amazon-bedrock' },
        },
        {
          type: 'event_msg',
          timestamp: '2026-10-01T00:00:01Z',
          payload: { type: 'task_started', turn_id: 'first' },
        },
        {
          type: 'turn_context',
          timestamp: '2026-10-01T00:00:02Z',
          payload: { turn_id: 'first', model },
        },
        ...[220_000, 220_000, 320_000].map((input, index) => ({
          type: 'token_usage_record',
          timestamp: `2026-10-01T00:00:0${index + 3}Z`,
          payload: {
            response_id: `bedrock-${index}`,
            turn_id: 'first',
            usage: {
              input_tokens: input,
              cached_input_tokens: index === 2 ? 150_000 : 100_000,
              cache_write_input_tokens: 20_000,
              output_tokens: 10_000,
              reasoning_output_tokens: 0,
              total_tokens: input + 10_000,
            },
          },
        })),
        {
          type: 'event_msg',
          timestamp: '2026-10-01T00:00:06Z',
          payload: { type: 'task_complete', turn_id: 'first', last_agent_message: 'done' },
        },
      ];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      const report = JSON.parse(await runCost(['bedrock-sol', '--projects', projects, '--codex-sessions', codex]));
      assert.equal(report.parent.requests, 3);
      assert.deepEqual(report.parent.models, [model]);
      assert.ok(Math.abs(report.parent.pricedCostUsd - expected) < 1e-12);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('cost JSON separates identified Codex bills from anonymous snapshots', async () => {
  const { root, projects, codex } = fixture();
  const file = path.join(codex, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-billed.jsonl');
  const usage = {
    input_tokens: 100_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 100_002,
  };
  const records = [
    {
      type: 'session_meta',
      timestamp: '2026-09-26T00:00:00Z',
      payload: { id: 'billed', source: 'cli', model_provider: 'openai' },
    },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: '2026-09-26T00:00:03Z',
      payload: { response_id: 'one', turn_id: 'first', usage },
    },
    {
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:04Z',
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const child = path.join(codex, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-legacy-child.jsonl');
  fs.writeFileSync(
    child,
    [
      {
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: {
          id: 'legacy-child',
          parent_thread_id: 'billed',
          source: { subagent: { thread_spawn: { agent_path: '/root/legacy' } } },
          model_provider: 'openai',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-09-26T00:00:01Z',
        payload: { type: 'task_started', turn_id: 'child-turn' },
      },
      {
        type: 'turn_context',
        timestamp: '2026-09-26T00:00:02Z',
        payload: { turn_id: 'child-turn', model: 'gpt-6-sol' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-09-26T00:00:03Z',
        payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  try {
    const report = JSON.parse(await runCost(['billed', '--projects', projects, '--codex-sessions', codex]));
    assert.equal(report.schemaVersion, 3);
    assert.equal(report.parent.requests, 1);
    assert.equal(report.parent.snapshotEvidence.count, 1);
    assert.equal(report.parent.coverage, 'billed-with-unknown-coverage');
    assert.equal(report.parent.cacheExpiry.coverage, 'unknown-request-coverage');
    assert.equal(report.parent.cacheExpiry.inputCostAfterExpiryUsd, null);
    assert.equal(report.parent.costUsd, null);
    assert.ok(report.parent.pricedCostUsd > 0);
    await sourceOnlyParity(file, ['--projects', projects, '--codex-sessions', codex]);
    const detail = JSON.parse(await runCost([file, '--projects', projects, '--codex-sessions', codex, '--by-model']));
    assert.equal(detail.parent.modelCosts[0].coverage, 'billed-with-unknown-coverage');
    assert.equal(detail.children[0].modelCosts[0].coverage, 'legacy-snapshots');
    assert.equal(detail.children[0].modelCosts[0].estimatedCostUsd, detail.children[0].estimatedCostUsd);
    assert.equal('modelCosts' in detail.combined, false);
    assert.equal(report.parent.costPerRequest, null);
    assert.equal(report.children[0].coverage, 'legacy-snapshots');
    assert.equal(report.children[0].pricedCostUsd, 0);
    assert.ok(report.children[0].estimatedCostUsd > 0);
    assert.equal(report.combined.coverage, 'billed-with-unknown-coverage');
    assert.equal(report.combined.pricedCostUsd, report.parent.pricedCostUsd);
    assert.equal(report.combined.estimatedCostUsd, report.children[0].estimatedCostUsd);
    assert.equal(report.combined.costUsd, null);
    assert.equal(report.combined.toolCalls, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost groups empty compaction and absent model identities in one null row', async () => {
  const { root, projects, codex } = fixture();
  const file = path.join(codex, 'rollout-2026-09-26T00-00-00-empty-model.jsonl');
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 2,
    cache_write_input_tokens: 3,
    output_tokens: 4,
    reasoning_output_tokens: 1,
    total_tokens: input + 4,
  });
  const records = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'empty-model', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'compaction' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'compaction', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: { response_id: 'compact-bill', turn_id: 'compaction', usage: usage(10) },
    },
    { type: 'compacted', timestamp: at(4), payload: { compaction_response_id: 'compact-bill' } },
    {
      type: 'event_msg',
      timestamp: at(5),
      payload: { type: 'thread_settings_applied', thread_settings: { model: '' } },
    },
    { type: 'event_msg', timestamp: at(6), payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: at(7), payload: { type: 'task_started', turn_id: 'absent' } },
    {
      type: 'token_usage_record',
      timestamp: at(8),
      payload: { response_id: 'absent-bill', turn_id: 'absent', usage: usage(20) },
    },
    { type: 'event_msg', timestamp: at(9), payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: at(10), payload: { type: 'task_started', turn_id: 'unknown' } },
    { type: 'turn_context', timestamp: at(11), payload: { turn_id: 'unknown', model: 'future-model' } },
    {
      type: 'token_usage_record',
      timestamp: at(12),
      payload: { response_id: 'unknown-bill', turn_id: 'unknown', usage: usage(30) },
    },
    { type: 'event_msg', timestamp: at(13), payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: at(14), payload: { type: 'task_started', turn_id: 'priced' } },
    { type: 'turn_context', timestamp: at(15), payload: { turn_id: 'priced', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(16),
      payload: { response_id: 'priced-bill', turn_id: 'priced', usage: usage(40) },
    },
  ];
  try {
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const flags = [file, '--projects', projects, '--codex-sessions', codex];
    const ordinary = JSON.parse(await runCost(flags));
    assert.deepEqual(ordinary.parent.models, ['future-model', 'gpt-6-sol']);
    assert.deepEqual(ordinary.parent.unpricedModels, ['', 'future-model', 'unknown']);
    await sourceOnlyParity(file, flags.slice(1));
    const detail = JSON.parse(await runCost([...flags, '--source-only', '--by-model']));
    const { modelCosts, ...parent } = detail.parent;
    assert.deepEqual(parent, ordinary.parent);
    assert.deepEqual(
      modelCosts.map((row: { model: string | null }) => row.model),
      [null, 'future-model', 'gpt-6-sol'],
    );
    assert.equal(modelCosts[0].requests, 2);
    assert.equal(modelCosts[0].unpricedRequests, 2);
    assert.equal(modelCosts[0].uncachedInputTokens, 20);
    assert.equal(modelCosts[0].cachedInputTokens, 4);
    assert.equal(modelCosts[0].cacheWriteInputTokens, 6);
    assert.equal(modelCosts[0].outputTokens, 8);
    assert.equal(modelCosts[0].reasoningOutputTokens, 2);
    assert.equal(modelCosts[0].costUsd, null);
    assert.equal(modelCosts[0].pricedCostUsd, 0);
    for (const key of [
      'requests',
      'pricedRequests',
      'unpricedRequests',
      'uncachedInputTokens',
      'cachedInputTokens',
      'cacheWriteInputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'pricedCostUsd',
    ])
      assert.equal(
        modelCosts.reduce((sum: number, row: Record<string, number>) => sum + row[key], 0),
        parent[key],
      );
    assert.ok(parent.pricedCostUsd > 0);
    assert.ok(
      modelCosts.every(
        (row: { coverage: string; costUsd: null }) => row.coverage === parent.coverage && row.costUsd === null,
      ),
    );
    assert.deepEqual(detail.children, []);
    assert.equal('modelCosts' in detail.combined, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost reads environment roots and applies an exclusive until time', async () => {
  const { root, projects, codex } = fixture();
  const previousProjects = process.env.ARC_PROJECTS_ROOT;
  const previousCodex = process.env.ARC_CODEX_ROOT;
  process.env.ARC_PROJECTS_ROOT = projects;
  process.env.ARC_CODEX_ROOT = codex;
  try {
    const report = JSON.parse(await runCost(['session-1', '--until', '2026-09-26T00:00:01Z', '--json']));
    assert.equal(report.parent.requests, 0);
    assert.equal(report.window.until, '2026-09-26T00:00:01.000Z');
  } finally {
    if (previousProjects === undefined) delete process.env.ARC_PROJECTS_ROOT;
    else process.env.ARC_PROJECTS_ROOT = previousProjects;
    if (previousCodex === undefined) delete process.env.ARC_CODEX_ROOT;
    else process.env.ARC_CODEX_ROOT = previousCodex;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost rejects missing targets, bad times, and ambiguous ids', async () => {
  const { root, projects, codex, file } = fixture();
  try {
    const flags = ['--projects', projects, '--codex-sessions', codex];
    await assert.rejects(async () => await runCost(['missing', ...flags]), /No transcript found/);
    await assert.rejects(async () => await runCost([file, '--since', 'yesterday', ...flags]), /Invalid since time/);
    await assert.rejects(async () => await runCost([file, '--unexpected', ...flags]), /Unknown cost option/);
    const second = path.join(projects, 'other', 'session-1.jsonl');
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.copyFileSync(file, second);
    await assert.rejects(async () => await runCost(['session-1', ...flags]), /More than one transcript matched/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost attributes failed tools and launch windows to the requests that made them', async () => {
  const { root, file } = fixture();
  try {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 26, 0, minute)).toISOString();
    const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    fs.writeFileSync(
      file,
      [
        { type: 'user', timestamp: at(0), message: { content: 'start' } },
        {
          type: 'assistant',
          timestamp: at(1),
          message: {
            id: 'first',
            model: 'claude-opus-5',
            usage,
            content: [
              { type: 'tool_use', id: 'git-call', name: 'Bash', input: { command: 'cd repo && MSG="a b" git status' } },
              { type: 'tool_use', id: 'agent-call', name: 'Agent', input: { prompt: 'review' } },
            ],
          },
        },
        {
          type: 'user',
          timestamp: at(2),
          toolUseResult: { agentId: 'a1' },
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'git-call', is_error: true, content: 'failed' },
              { type: 'tool_result', tool_use_id: 'agent-call', content: 'agentId: a1' },
            ],
          },
        },
        {
          type: 'assistant',
          timestamp: at(3),
          message: {
            id: 'second',
            model: 'claude-opus-5',
            usage,
            content: [
              { type: 'tool_use', id: 'finding-call', name: 'Agent', input: { message: 'FINDING in handback' } },
            ],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const report = JSON.parse(
      await runCost([file, '--by-tool', '--until-text', 'FINDING', '--window-agent', 'a1', '--until', at(4)]),
    );
    assert.equal(report.parent.failedToolCalls, 1);
    assert.equal(report.parent.failedToolCallRequests, 1);
    assert.ok(report.parent.failedToolCallCostUsd > 0);
    assert.equal(report.byTool.rows.find((row: { kind: string }) => row.kind === 'git').requests, 1);
    assert.equal(report.byTool.rows.find((row: { kind: string }) => row.kind === 'subagent launch').requests, 1);
    assert.equal(report.untilText.matched, true);
    assert.equal(report.untilText.byTool.rows.length, 1);
    assert.equal(report.parentWindow.requests, 2);
    assert.equal(report.parentWindow.contextAtStart, 100);
    assert.equal(report.parentWindow.contextAtPeak, 100);
    assert.equal('requestsNote' in report.parentWindow.byTool, false);
    const human = await costOutput([
      file,
      '--source-only',
      '--by-tool',
      '--until-text',
      'FINDING',
      '--window-agent',
      'a1',
    ]);
    for (const detail of ['Failed tools: 1', 'Matched: true', 'Agent window:', 'Agent window tools'])
      assert.ok(human.includes(detail), detail);
    const exclusive = JSON.parse(await runCost([file, '--window-agent', 'a1', '--until', at(3)]));
    assert.equal(exclusive.parent.requests, 1);
    assert.equal(exclusive.parentWindow.requests, 2);
    for (let mask = 0; mask < 32; mask++) {
      if (mask & 8 && !(mask & 4)) continue;
      const flags = [
        ...(mask & 1 ? ['--since', at(1)] : []),
        ...(mask & 2 ? ['--until', at(3)] : []),
        ...(mask & 4 ? ['--by-tool'] : []),
        ...(mask & 8 ? ['--until-text', 'FINDING'] : []),
        ...(mask & 16 ? ['--window-agent', 'a1'] : []),
      ];
      await sourceOnlyParity(file, flags);
    }
    await assert.rejects(
      async () => await runCost([file, '--source-only', '--until-text', 'finding']),
      /requires --by-tool[.]/,
    );
    await assert.rejects(
      async () => await runCost([file, '--source-only', '--window-agent', 'missing']),
      /No Agent launch found/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('until-text accepts Python global case, multiline, and dotall flags', async () => {
  const { root, file } = fixture();
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.message.content = [{ type: 'text', text: 'noise\nFound\na bug' }];
    fs.writeFileSync(file, JSON.stringify(record) + '\n');
    const report = JSON.parse(await runCost([file, '--by-tool', '--until-text', '(?ims)^found.a bug']));
    assert.equal(report.untilText.matched, true);
    await assert.rejects(
      async () => await runCost([file, '--by-tool', '--until-text', '(?x)found']),
      /Invalid --until-text pattern/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost JSON uses the Python context mean for an even tie', async () => {
  const { root, file } = fixture();
  try {
    const first = JSON.parse(fs.readFileSync(file, 'utf8'));
    first.message.usage.input_tokens = 29_324;
    const second = {
      ...first,
      timestamp: '2026-09-26T00:00:02Z',
      message: { ...first.message, id: 'request-2', usage: { ...first.message.usage, input_tokens: 29_325 } },
    };
    fs.writeFileSync(file, [first, second].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const report = JSON.parse(await runCost([file]));
    assert.equal(report.parent.contextMean, 29_324);
    assert.equal(report.combined.contextMean, 29_324);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(
  [
    ['openai', 'gpt-6.1-sol', 1],
    ['amazon-bedrock', 'openai.gpt-6.1-sol', 1.1],
    ['amazon-bedrock', 'us.openai.gpt-6.1-sol', 1.1],
    ['amazon-bedrock', 'global.openai.gpt-6.1-sol', 1],
  ].flatMap(([provider, model, multiplier]) =>
    [
      [0, 40_000, 0.16],
      [40_000, 0, 0.064],
      [20_000, 20_000, 0.112],
    ].map(([read, written, cost]) => ({ provider, model, read, written, cost: cost * Number(multiplier) })),
  ),
)(
  'cost reports generic cache lifetime for $model with $read reads and $written writes',
  async ({ provider, model, read, written, cost }) => {
    const { root, projects, codex } = fixture();
    const file = path.join(codex, 'rollout-session.jsonl');
    try {
      const records: object[] = [
        {
          type: 'session_meta',
          timestamp: '2026-09-30T10:00:00Z',
          payload: { id: 'session', source: 'cli', model_provider: provider },
        },
      ];
      for (const [index, timestamp, input, cached, write] of [
        [0, '2026-09-30T10:00:00Z', 40_000, read, written],
        [1, '2026-09-30T11:01:00Z', 30_000, 0, 0],
      ]) {
        const turn = `turn-${index}`;
        records.push(
          { type: 'turn_context', timestamp, payload: { turn_id: turn, model } },
          {
            type: 'token_usage_record',
            timestamp,
            payload: {
              turn_id: turn,
              response_id: `response-${index}`,
              usage: {
                input_tokens: input,
                cached_input_tokens: cached,
                cache_write_input_tokens: write,
                output_tokens: 0,
                reasoning_output_tokens: 0,
              },
            },
          },
        );
      }
      fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      const report = JSON.parse(await runCost([file, '--projects', projects, '--codex-sessions', codex]));
      assert.equal(report.parent.pricedRequests, 2);
      assert.equal(report.parent.uncachedInputTokens, 30_000);
      assert.equal(report.parent.cachedInputTokens, read);
      assert.equal(report.parent.cacheWriteInputTokens, written);
      assert.equal(report.parent.pricedCostUsd, Number(cost.toFixed(4)));
      assert.equal(report.parent.costUsd, null);
      assert.equal(report.parent.cacheExpiry.returns, 1);
      assert.equal(report.parent.cacheExpiry.unavailableLifetime, 0);
      assert.equal(report.parent.cacheExpiry.byLifetime['30m'], 1);
      assert.equal(report.parent.cacheExpiry.coverage, 'unknown-request-coverage');
      assert.equal(report.parent.cacheExpiry.inputCostAfterExpiryUsd, null);
      assert.deepEqual(report.combined.cacheExpiry, report.parent.cacheExpiry);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(['5m', '1h'])(
  'cost reports fast-mode gaps and explicit %s cache expiry from adjacent priced requests',
  async (lifetime) => {
    const { root, file } = fixture();
    try {
      const usage = (speed: string) => ({
        input_tokens: 100,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: lifetime === '5m' ? 50 : 0,
          ephemeral_1h_input_tokens: lifetime === '1h' ? 50 : 0,
        },
        speed,
      });
      fs.writeFileSync(
        file,
        [
          { type: 'user', timestamp: '2026-09-26T00:00:00Z', message: { content: 'first' } },
          {
            type: 'assistant',
            timestamp: '2026-09-26T00:00:01Z',
            message: { id: 'one', model: 'claude-opus-5', usage: usage('standard'), content: [] },
          },
          { type: 'user', timestamp: '2026-09-26T01:01:00Z', message: { content: 'second' } },
          {
            type: 'assistant',
            timestamp: '2026-09-26T01:01:01Z',
            message: { id: 'two', model: 'claude-opus-5', usage: usage('standard'), content: [] },
          },
          {
            type: 'assistant',
            timestamp: '2026-09-26T01:01:02Z',
            message: { id: 'three', model: 'claude-opus-5', usage: usage('priority'), content: [] },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );
      const report = JSON.parse(await runCost([file]));
      assert.equal(report.parent.fastModeUnpricedRequests, 1);
      assert.equal(report.parent.cacheExpiry.returns, 1);
      assert.equal(report.parent.cacheExpiry.coverage, 'complete');
      assert.ok(report.parent.cacheExpiry.inputCostAfterExpiryUsd > 0);
      assert.equal(report.parent.cacheExpiry.byLifetime[lifetime], 1);
      assert.equal(report.combined.cacheExpiry.returns, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('cost keeps Codex tool failures without assigning their cost to a request', async () => {
  const { root, codex } = fixture();
  const file = path.join(codex, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-failed.jsonl');
  const child = path.join(codex, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-failed-child.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'failed', source: 'cli' } },
        {
          type: 'event_msg',
          timestamp: '2026-09-26T00:00:02Z',
          payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    fs.writeFileSync(
      child,
      [
        {
          type: 'session_meta',
          timestamp: '2026-09-26T00:00:00Z',
          payload: {
            id: 'failed-child',
            parent_thread_id: 'failed',
            source: { subagent: { thread_spawn: { parent_thread_id: 'failed', agent_path: '/root/failed-child' } } },
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-09-26T00:00:02Z',
          payload: { type: 'item_completed', item: { type: 'McpToolCall', status: 'failed' } },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const report = JSON.parse(
      await runCost([
        file,
        '--codex-sessions',
        codex,
        '--since',
        '2026-09-26T00:00:01Z',
        '--until',
        '2026-09-26T00:00:03Z',
      ]),
    );
    assert.equal(report.parent.requests, 0);
    assert.equal(report.parent.failedToolCalls, 1);
    assert.equal(report.parent.failedToolCallRequests, 0);
    assert.equal(report.parent.failedToolCallCostUsd, null);
    assert.equal(report.children.length, 1);
    assert.equal(report.children[0].requests, 0);
    assert.equal(report.children[0].failedToolCalls, 1);
    assert.equal(report.combined.failedToolCalls, 2);
    assert.equal(report.combined.failedToolCallCostUsd, null);
    await sourceOnlyParity(file, [
      '--codex-sessions',
      codex,
      '--since',
      '2026-09-26T00:00:01Z',
      '--until',
      '2026-09-26T00:00:03Z',
    ]);
    const direct = JSON.parse(
      await runCost([
        file,
        '--source-only',
        '--by-model',
        '--codex-sessions',
        codex,
        '--since',
        '2026-09-26T00:00:01Z',
        '--until',
        '2026-09-26T00:00:03Z',
      ]),
    );
    assert.equal(direct.parent.failedToolCalls, 1);
    assert.equal(direct.parent.failedToolCallRequests, 0);
    assert.equal(direct.parent.failedToolCallCostUsd, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost resolves an Agent launch from subagent metadata when its result has no id', async () => {
  const { root, file } = fixture();
  try {
    const meta = path.join(path.dirname(file), 'session-1', 'subagents', 'agent-fallback.meta.json');
    fs.mkdirSync(path.dirname(meta), { recursive: true });
    fs.writeFileSync(meta, JSON.stringify({ toolUseId: 'launch-call' }));
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-26T00:00:01Z',
        message: {
          id: 'launch',
          model: 'claude-opus-5',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'launch-call', name: 'Agent', input: { prompt: 'review' } }],
          usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }) + '\n',
    );
    const report = JSON.parse(await runCost([file, '--window-agent', 'fallback']));
    assert.equal(report.parentWindow.agentIdStartRequest, 'launch');
    assert.equal(report.parentWindow.requests, 1);
    await sourceOnlyParity(file, [
      '--window-agent',
      'fallback',
      '--by-tool',
      '--until-text',
      'never',
      '--since',
      '2026-09-26T00:00:01Z',
      '--until',
      '2026-09-26T00:00:01Z',
    ]);
    const nativeFs = createRequire(import.meta.url)('node:fs');
    const enumeration = vi.spyOn(nativeFs, 'readdirSync').mockImplementation(() => {
      throw new Error('Unexpected directory enumeration');
    });
    const reads = vi.spyOn(nativeFs, 'readFileSync');
    const opens = vi.spyOn(nativeFs, 'openSync');
    syncBuiltinESMExports();
    try {
      const direct = JSON.parse(await runCost([file, '--source-only', '--by-model', '--window-agent', 'fallback']));
      assert.equal(direct.parentWindow.agentIdStartRequest, 'launch');
      assert.equal(enumeration.mock.calls.length, 0);
      assert.deepEqual(
        reads.mock.calls.map(([path]) => String(path)),
        [meta],
      );
      assert.ok(opens.mock.calls.every(([path]) => [file, meta].includes(String(path))));
    } finally {
      enumeration.mockRestore();
      reads.mockRestore();
      opens.mockRestore();
      syncBuiltinESMExports();
    }
    await assert.rejects(async () => await runCost([file, '--window-agent', 'missing']), /No Agent launch found/);
    await assert.rejects(async () => await runCost([file, '--until-text', 'finding']), /requires --by-tool[.]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('window-agent uses structured launch identity before metadata and quoted text', async () => {
  const { root, file } = fixture();
  try {
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const launch = (id: string, call: string, minute: number) => ({
      type: 'assistant',
      timestamp: `2026-09-26T00:0${minute}:00Z`,
      message: {
        id,
        model: 'claude-opus-5',
        usage,
        content: [{ type: 'tool_use', id: call, name: 'Agent', input: { prompt: id } }],
      },
    });
    fs.writeFileSync(
      file,
      [
        launch('quoted', 'quoted-call', 1),
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'quoted-call', content: 'agentId: target\nagentId: fallback' },
            ],
          },
        },
        launch('structured', 'structured-call', 2),
        {
          type: 'user',
          toolUseResult: { agentId: 'target' },
          message: { content: [{ type: 'tool_result', tool_use_id: 'structured-call', content: 'done' }] },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const meta = path.join(path.dirname(file), 'session-1', 'subagents', 'agent-target.meta.json');
    fs.mkdirSync(path.dirname(meta), { recursive: true });
    fs.writeFileSync(meta, JSON.stringify({ toolUseId: 'quoted-call' }));
    const report = JSON.parse(await runCost([file, '--window-agent', 'target']));
    assert.equal(report.parentWindow.agentIdStartRequest, 'structured');
    fs.writeFileSync(
      path.join(path.dirname(meta), 'agent-fallback.meta.json'),
      JSON.stringify({ toolUseId: 'structured-call' }),
    );
    const fallback = JSON.parse(await runCost([file, '--window-agent', 'fallback']));
    assert.equal(fallback.parentWindow.agentIdStartRequest, 'structured');
    await sourceOnlyParity(file, ['--window-agent', 'target']);
    await sourceOnlyParity(file, ['--window-agent', 'fallback']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool report groups tools under their kind and the former flag name gives the same report', async () => {
  const { root, file } = fixture();
  try {
    const usage = (output: number) => ({
      input_tokens: 1000,
      output_tokens: output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const assistant = (
      id: string,
      second: number,
      output: number,
      tools: { id: string; name: string; input: object }[],
    ) => ({
      type: 'assistant',
      timestamp: `2026-09-26T00:00:0${second}Z`,
      message: {
        id,
        model: 'claude-opus-5',
        usage: usage(output),
        content: tools.map((tool) => ({ type: 'tool_use', ...tool })),
      },
    });
    const results = (...ids: string[]) => ({
      type: 'user',
      message: { content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'done' })) },
    });
    fs.writeFileSync(
      file,
      [
        assistant('search', 1, 10, [
          { id: 'grep-call', name: 'Grep', input: { pattern: 'x' } },
          { id: 'glob-call', name: 'Glob', input: { pattern: '*.ts' } },
          { id: 'second-grep-call', name: 'Grep', input: { pattern: 'y' } },
        ]),
        results('grep-call', 'glob-call', 'second-grep-call'),
        assistant('read', 2, 400, [{ id: 'git-call', name: 'Bash', input: { command: 'git status' } }]),
        results('git-call'),
        assistant('final', 3, 4000, []),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const report = JSON.parse(await runCost([file, '--by-tool']));
    const search = report.byTool.rows.find((row: { kind: string }) => row.kind === 'search');
    assert.deepEqual(
      search.tools.map((tool: { tool: string; requests: number }) => [tool.tool, tool.requests]),
      [
        ['Grep', 1],
        ['Glob', 1],
      ],
    );
    assert.equal(search.tools[0].costUsd, round(search.costUsd * (2 / 3)));
    for (const row of report.byTool.rows) {
      const toolShare = row.tools.reduce((sum: number, tool: { shareOfCost: number }) => sum + tool.shareOfCost, 0);
      assert.ok(Math.abs(toolShare - (row.tools.length ? row.shareOfCost : 0)) < 0.0002, row.kind);
    }
    assert.deepEqual(report.byTool.rows.find((row: { kind: string }) => row.kind === 'no tool result').tools, []);
    assert.equal(report.byTool.rows.find((row: { kind: string }) => row.kind === 'git').tools[0].tool, 'Bash git');
    const { buildCommit: _build, ...current } = report;
    const { buildCommit: _formerBuild, ...former } = JSON.parse(await runCost([file, '--by-tool-kind']));
    assert.deepEqual(former, current);
    const table = (await costOutput([file, '--by-tool'])).split('\n');
    const start = table.indexOf('By tool') + 1;
    const rows = table.slice(
      start,
      table.findIndex((line, index) => index > start && line.startsWith('Unpriced')),
    );
    assert.deepEqual(
      rows.map((line) => line.trim().split(/\s{2,}/)[0]),
      ['Tool', 'git', 'Bash git', 'search', 'Grep', 'Glob', 'no tool result'],
    );
    assert.ok(rows.filter((line) => line.startsWith('  ')).length === 3);
    assert.equal(new Set(rows.map((line) => line.length)).size, 1);
    for (const column of ['Requests', 'Attributed cost', 'Share']) {
      const end = rows[0].indexOf(column) + column.length;
      for (const line of rows) assert.notEqual(line[end - 1], ' ', `${column}: ${line}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool classification keeps redirected cat and its heredoc opening line', async () => {
  const { root, file } = fixture();
  try {
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    fs.writeFileSync(
      file,
      [
        {
          type: 'assistant',
          timestamp: '2026-09-26T00:00:01Z',
          message: {
            id: 'write',
            model: 'claude-opus-5',
            usage,
            content: [
              {
                type: 'tool_use',
                id: 'write-call',
                name: 'Bash',
                input: { command: "cat <<'EOF' > output.txt\nhello\nEOF" },
              },
            ],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-call', content: 'done' }] } },
        {
          type: 'assistant',
          timestamp: '2026-09-26T00:00:02Z',
          message: { id: 'next', model: 'claude-opus-5', usage, content: [] },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const report = JSON.parse(await runCost([file, '--by-tool']));
    assert.equal(report.byTool.rows.find((row: { kind: string }) => row.kind === 'other').requests, 1);
    assert.equal(
      report.byTool.rows.find((row: { kind: string }) => row.kind === 'file read'),
      undefined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost prices Bedrock Astra parent and native Plato without counting shared billing twice', async () => {
  const { root, projects, codex } = fixture();
  try {
    for (const [id, child] of [
      ['bedrock-astra-parent', false],
      ['bedrock-astra-plato', true],
    ] as const)
      fs.writeFileSync(
        path.join(codex, `rollout-${id}.jsonl`),
        bedrockAstraRecords(child)
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );
    const report = JSON.parse(
      await runCost(['bedrock-astra-parent', '--projects', projects, '--codex-sessions', codex, '--by-model']),
    );
    assert.equal(report.children.length, 1);
    for (const [row, count, cost] of [
      [report.parent, 33, 6.5229],
      [report.children[0], 11, 2.5627],
      [report.combined, 44, 9.0856],
    ]) {
      assert.equal(row.requests, count);
      assert.equal(row.pricedRequests, count);
      assert.equal(row.unpricedRequests, 0);
      assert.ok(Math.abs(row.costUsd - cost) < 1e-10);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
