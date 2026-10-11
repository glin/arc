import { createHash } from 'node:crypto';
import { withReadMetrics, type ReadMetrics } from './readmeter';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir } from './temproot.ts';
import {
  ADVISOR_EXECUTOR,
  ADVISOR_MODEL,
  advisorResponseRecords,
  advisorProbeRecords,
  MIXED_PASS_ITERATIONS,
  claudeCostState,
  claudeDispatchTranscript,
  exportedSiteData,
  subagent,
  turn,
} from './turnfixtures.ts';
import {
  captureSessionExport,
  completeSessionExport,
  projectTurn,
  type ExportCaptureOptions,
  type ExportPage,
  type SessionExport,
} from './exportdata.ts';
import { ExportCancelled, ExportTransaction, withExportTransaction } from './exportwriter.ts';
import { ExportLimitError } from './exportlimits.ts';
import { projectSessionSite, exportTurn } from './exportsite.ts';
import type { SiteManifest } from './webview/export-model.ts';
import type { SessionStatChip } from './turncard.ts';
import { readCodexSession } from './codex.ts';
import { toCard, turnCost, averageContextPerRequest } from './turncard.ts';
import { formatCost } from './pricing.ts';
import { readClaudeAgentSpend, readSessionMeta, scanForAgentRun, agentRunOfScan, readSession } from './transcript.ts';
import { needsAgentRunScan } from './derivedcache.ts';
const CODEX_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const NATIVE_CODEX_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const at = (second: number) => new Date(Date.UTC(2026, 8, 29, 12, 0, second)).toISOString();
const record = (type: string, second: number, fields: object) => ({ type, timestamp: at(second), ...fields });

test('per-pass pricing survives an export round trip with both bands and one executor request', () => {
  const f = fixture();
  const file = f.write(f.root, [
    advisorProbeRecords()[0],
    ...advisorResponseRecords({ iterations: MIXED_PASS_ITERATIONS, thinking: 3 }),
  ]);
  const original = readSession(file, 'root').turns[0];
  const saved = projectTurn(original, 'turn', { cwd: '/project' }, [], 'root', new Map());
  const restored = exportTurn(JSON.parse(JSON.stringify(saved)), 'claude', 'root');
  assert.ok(Math.abs(turnCost(restored).dollars! - 0.0600315) < 1e-12);
  assert.equal(averageContextPerRequest(restored.usage), 200001);
  assert.equal(restored.usage.requests, 1);
  assert.equal(saved.usageParts.length, 2);
  assert.deepEqual(
    saved.usageParts.map((part) => part.usage.requests),
    [0, 1],
  );
  assert.deepEqual(turnCost(restored), turnCost(original));
});

test('export capture retains child advisor usage origins beside executor spend', () => {
  const f = fixture();
  const child = readClaudeAgentSpend(f.write(f.child('advisor'), advisorResponseRecords({ sidechain: true })));
  const original = turn({ agents: [subagent({ model: child.ownModel, spend: child.models })] });
  const saved = projectTurn(original, 'turn', { cwd: '/project' }, [], 'root', new Map());
  assert.ok(saved.agents[0].spend);
  assert.deepEqual(
    saved.agents[0].spend.map((part) => [part.model, part.origin, part.usage.requests]),
    [
      [ADVISOR_EXECUTOR, 'recorded', 1],
      [ADVISOR_MODEL, 'claude-advisor', 1],
    ],
  );
  assert.equal(saved.agents[0].spend[1].usage.input, 44_807);
});
function claudeTurn(id: string, second = 0, finished = true, sidechain = false): object[] {
  return [
    record('user', second, {
      uuid: `${id}-p`,
      promptId: id,
      sessionId: 'root',
      cwd: '/private/project',
      isSidechain: sidechain,
      message: { role: 'user', content: `prompt ${id}` },
    }),
    record('assistant', second + 1, {
      uuid: `${id}-a`,
      isSidechain: sidechain,
      message: {
        id: `${id}-a`,
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        ...(finished ? { stop_reason: 'end_turn' } : {}),
        content: [{ type: 'text', text: `answer ${id}` }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30 },
      },
    }),
  ];
}
function codexTurn(id: string, second = 0, finished = true): object[] {
  return [
    record('event_msg', second, { payload: { type: 'task_started', turn_id: id } }),
    record('turn_context', second, {
      payload: { turn_id: id, model: 'gpt-5.4', cwd: '/private/external', effort: 'high' },
    }),
    record('response_item', second, {
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `prompt ${id}` }] },
    }),
    record('response_item', second + 1, {
      payload: {
        type: 'message',
        id: `${id}-a`,
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: `answer ${id}` }],
      },
    }),
    record('event_msg', second + 1, {
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 30,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 1,
            total_tokens: 105,
          },
        },
      },
    }),
    ...(finished ? [record('event_msg', second + 2, { payload: { type: 'task_complete', turn_id: id } })] : []),
  ];
}
function fixture() {
  const directory = tempDir('export-capture-');
  const claude = path.join(directory, 'projects');
  const codex = path.join(directory, 'sessions');
  fs.mkdirSync(path.join(claude, 'project'), { recursive: true });
  fs.mkdirSync(path.join(codex, '2026', '09', '29'), { recursive: true });
  const output = path.join(directory, 'output');
  fs.mkdirSync(output);
  const write = (file: string, records: object[], newline = true) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map((item) => JSON.stringify(item)).join('\n') + (newline ? '\n' : ''));
    return file;
  };
  const root = write(path.join(claude, 'project', 'root.jsonl'), claudeTurn('root'));
  const claudeSession = (id: string, records = claudeTurn(id), project = 'external') =>
    write(path.join(claude, project, `${id}.jsonl`), records);
  const codexSession = (id: string, parent?: string, records = codexTurn(id)) =>
    write(path.join(codex, '2026', '09', '29', `rollout-${id}.jsonl`), [
      record('session_meta', 0, {
        payload: {
          id,
          cwd: '/private/external',
          ...(parent
            ? {
                source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: `/root/${id}` } } },
                thread_source: 'subagent',
              }
            : {}),
        },
      }),
      ...records,
    ]);
  const child = (id: string, parentAgentId: string | null = null, parent = 'root') => {
    const directory = path.join(claude, 'project', parent, 'subagents');
    const file = write(path.join(directory, `agent-${id}.jsonl`), claudeTurn(id, 3, true, true));
    fs.writeFileSync(
      path.join(directory, `agent-${id}.meta.json`),
      JSON.stringify({ parentAgentId, toolUseId: `launch-${id}` }),
    );
    return file;
  };
  const options: ExportCaptureOptions = {
    root: {
      agent: 'claude',
      file: root,
      sessionId: 'root',
      size: fs.statSync(root).size,
      mtimeMs: fs.statSync(root).mtimeMs,
    },
    roots: { claude, codex },
    capturedAt: Date.UTC(2026, 8, 29),
  };
  return { directory, claude, codex, output, root, options, write, claudeSession, codexSession, child };
}
function largeCodexFixture() {
  const f = fixture();
  const body = 'large admitted commentary '.repeat(40000);
  const child = f.claudeSession(NATIVE_CODEX_ID);
  const rows = codexTurn('large');
  rows.splice(
    3,
    0,
    record('response_item', 1, {
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: body }],
      },
    }),
    record('event_msg', 1, {
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'late-dispatch',
          command: ['powershell.exe', '-Command', 'python dispatch.py --arc-dispatch --runner claude'],
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch --runner claude' }],
          cwd: 'file:///C:/repo',
          status: 'completed',
          exit_code: 0,
          stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${NATIVE_CODEX_ID}"}`,
        },
      },
    }),
  );
  const root = f.codexSession(CODEX_ID, undefined, rows);
  fs.utimesSync(root, 1700000000, 1700000000);
  const options: ExportCaptureOptions = {
    ...f.options,
    root: { ...f.options.root, file: root, agent: 'codex', sessionId: CODEX_ID },
    limits: { sliceBytes: 64 * 1024 },
  };
  return { ...f, root, child, body, options };
}

test('large Codex export retains following dispatch and hashes one sequential relationship pass', async () => {
  const f = largeCodexFixture();
  let metrics: ReadMetrics = {};
  await withReadMetrics(
    () =>
      withExportTransaction(f.output, async (writer) => {
        const capture = await captureSessionExport(f.options, writer);
        assert.equal(capture.model.sessions.length, 2);
        assert.equal(capture.model.relationships[0].kind, 'dispatched');
        assert.equal(capture.model.relationships[0].coverage, 'complete');
        const root = capture.model.sessions[0];
        assert.equal(root.provenance.sha256, createHash('sha256').update(fs.readFileSync(f.root)).digest('hex'));
        assert.ok(
          (await readPages(capture.model, writer))
            .flatMap((page) => page.turns.flatMap((turn) => turn.blocks))
            .some((block) => block.text === f.body),
        );
        await capture.recheck();
      }),
    (result) => {
      metrics = result;
    },
  );
  const sourceBytes = fs.statSync(f.root).size + fs.statSync(f.child).size;
  assert.ok(metrics.relationships.bytes <= sourceBytes + 16 * 1024);
  assert.equal(metrics.relationships.repeatedBytes, 0);
  assert.equal(metrics.relationships.cursorCopies, 0);
  assert.equal(metrics.digest?.bytes ?? 0, 0);
});

test('uncached admitted runs retain provider classification and reader dispatch overrides', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    for (const behavior of [
      'agent',
      'requested',
      'human',
      'headless',
      'retained',
      'retained-human',
      'retained-requested',
      'retained-started',
      'neutral',
      'retained-neutral',
    ] as const) {
      if (agent === 'claude' && behavior.endsWith('neutral')) continue;
      const f = fixture();
      const id = CODEX_ID;
      const opening = (source: string, second = 0) => record('session_meta', second, { payload: { id, source } });
      const headless =
        agent === 'claude'
          ? claudeTurn('launch').map((value) => ({ ...value, entrypoint: 'sdk-cli', promptSource: 'sdk' }))
          : [opening(behavior.endsWith('neutral') ? 'cli' : 'exec'), ...codexTurn('launch')];
      const extra = behavior.includes('human')
        ? agent === 'claude'
          ? claudeTurn('followup', 10).map((value) => ({ ...value, origin: { kind: 'human' } }))
          : [opening('cli', 10), ...codexTurn('followup', 11)]
        : behavior === 'headless'
          ? agent === 'claude'
            ? claudeTurn('followup', 10).map((value) => ({ ...value, promptSource: 'sdk' }))
            : codexTurn('followup', 10)
          : [];
      const file =
        agent === 'claude'
          ? f.claudeSession(id, [...headless, ...extra])
          : f.write(path.join(f.codex, 'rollout-worker.jsonl'), [...headless, ...extra]);
      f.write(
        f.root,
        claudeDispatchTranscript(
          'python dispatch.py --arc-dispatch',
          `ARC_DISPATCH_SESSION=${JSON.stringify({ agent, session_id: id, ...(behavior.includes('requested') ? { owned: true } : {}) })}`,
        ),
      );
      await withExportTransaction(f.output, async (writer) => {
        const state = {
          archived: [
            { agent, sessionId: id },
            { agent, sessionId: 'unrelated-private' },
          ],
          startedHere: behavior === 'retained-started' ? [{ agent, sessionId: id }] : [],
          agentRuns: behavior.startsWith('retained') ? [{ agent, sessionId: id }] : [],
        };
        const capture = await captureSessionExport(
          { ...f.options, readerState: state, limits: { sliceBytes: 32768 } },
          writer,
        );
        assert.equal(capture.model.sessions.length, 2, JSON.stringify(capture.model.relationships));
        const child = capture.model.sessions.find((session) => session.key !== capture.model.root)!;
        assert.equal(
          child.agentRun,
          !behavior.includes('requested') &&
            !behavior.includes('human') &&
            behavior !== 'retained-started' &&
            behavior !== 'neutral',
          `${agent} ${behavior}`,
        );
        assert.equal(capture.model.relationships[0].requestedByReader, behavior.includes('requested'));
        assert.equal(child.archived, true);
        assert.equal(capture.model.sessions[0].archived, false);
        assert.ok(!JSON.stringify(capture.model).includes('unrelated-private'));
        assert.equal(child.provenance.sha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
      });
      // With no dispatch relationship, source metadata still classifies an external root.
      await withExportTransaction(f.output, async (writer) => {
        const capture = await captureSessionExport(
          { ...f.options, root: { ...f.options.root, agent, file, sessionId: id } },
          writer,
        );
        assert.equal(
          capture.model.sessions[0].agentRun,
          agent === 'claude' ? !behavior.includes('human') : !behavior.endsWith('neutral'),
        );
      });
    }
  }
});

test('uncached complete Claude exports match production short and large source classification', async () => {
  for (const large of [false, true]) {
    const f = fixture();
    const records = claudeTurn('external');
    if (large) records.push(record('progress', 2, { data: 'x'.repeat(300 * 1024) }));
    const file = f.claudeSession('external', records);
    const source = { agent: 'claude', size: fs.statSync(file).size };
    const production = needsAgentRunScan(source)
      ? agentRunOfScan(scanForAgentRun(file, source.size), source.size)
      : readSessionMeta(file).agentRun;
    assert.equal(production, !large);
    await withExportTransaction(f.output, async (writer) => {
      const capture = await captureSessionExport(
        { ...f.options, root: { ...f.options.root, file, sessionId: 'external' } },
        writer,
      );
      assert.equal(capture.model.sessions[0].agentRun, production);
      await capture.recheck();
    });
  }
});

test('reader membership is provider and parent qualified and survives a source-change retry', async () => {
  const f = fixture();
  f.codexSession('root');
  f.claudeSession('peer', claudeTurn('peer'), 'project');
  f.child('same');
  f.child('same', null, 'peer');
  const readerState = {
    archived: [
      { agent: 'claude' as const, sessionId: 'root' },
      { agent: 'claude' as const, sessionId: 'same', parentSessionId: 'peer' },
    ],
    startedHere: [],
    agentRuns: [],
  };
  let projections = 0;
  await withExportTransaction(f.output, async (writer) => {
    const result = await completeSessionExport(
      writer,
      {
        ...f.options,
        readerState,
        readerLinks: [
          { parent: { agent: 'claude', sessionId: 'root' }, child: { agent: 'claude', sessionId: 'peer' } },
          { parent: { agent: 'claude', sessionId: 'root' }, child: { agent: 'codex', sessionId: 'root' } },
        ],
      },
      async (capture, transaction) => {
        if (++projections === 1) {
          readerState.archived.length = 0;
          fs.appendFileSync(f.root, '\n');
        }
        await projectSessionSite(capture.model, transaction, { script: '', stylesheet: '' });
      },
    );
    assert.equal(projections, 2);
    assert.equal(result.model.sessions.find((session) => session.key === result.model.root)!.archived, true);
    assert.equal(result.model.sessions.find((session) => session.agent === 'codex')!.archived, false);
    const children = result.model.relationships.filter((edge) => edge.kind === 'subagent');
    assert.equal(children.length, 2);
    for (const edge of children) {
      const owner = result.model.sessions.find((session) => session.key === edge.from)!;
      assert.equal(
        result.model.sessions.find((session) => session.key === edge.to)!.archived,
        owner.key !== result.model.root,
      );
    }
  });
});

test('an archived native selected root retains its parent-qualified membership', async () => {
  const f = fixture();
  const file = f.child('selected');
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(
      {
        ...f.options,
        root: { ...f.options.root, file, sessionId: 'selected', childTranscript: true, parentSessionId: 'root' },
        readerState: {
          archived: [{ agent: 'claude', sessionId: 'selected', parentSessionId: 'root' }],
          startedHere: [{ agent: 'claude', sessionId: 'selected', parentSessionId: 'root' }],
          agentRuns: [{ agent: 'claude', sessionId: 'selected', parentSessionId: 'root' }],
        },
      },
      writer,
    );
    assert.equal(capture.model.sessions[0].key, capture.model.root);
    assert.equal(capture.model.sessions[0].archived, true);
    assert.equal(capture.model.sessions[0].agentRun, true);
  });
});

test('Codex capture reads structural child lifecycle once across semantic reductions', async () => {
  const f = largeCodexFixture();
  fs.appendFileSync(
    f.root,
    codexTurn('unfinished', 3, false)
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const child = f.codexSession(NATIVE_CODEX_ID, CODEX_ID, [
    record('ignored', 0, { payload: 'x'.repeat(300 * 1024) }),
    ...codexTurn('native'),
  ]);
  let metrics: ReadMetrics = {};
  await withReadMetrics(
    () =>
      withExportTransaction(f.output, async (writer) => {
        const capture = await captureSessionExport(f.options, writer);
        assert.equal(capture.model.sessions.length, 3);
        const pages = await readPages(capture.model, writer);
        const edge = capture.model.relationships.find((edge) => edge.kind === 'subagent')!;
        const agent = pages
          .flatMap((page) => page.turns.flatMap((turn) => turn.agents))
          .find((agent) => agent.relationships?.includes(edge.key));
        assert.ok(agent);
        assert.equal(agent.status, 'completed');
      }),
    (value) => {
      metrics = value;
    },
  );
  assert.equal(metrics.text.childLifecycleReads, 1);
  const bytes = [f.root, f.child, child].reduce((sum, file) => sum + fs.statSync(file).size, 0);
  assert.ok(
    metrics.text.bytes <= 2 * bytes + fs.statSync(child).size + 128 * 1024,
    `semantic reads returned ${metrics.text.bytes} bytes`,
  );
});

test('large Codex assembly advances first-source progress and accepts queued cancellation', async () => {
  const f = largeCodexFixture();
  const controller = new AbortController();
  const samples: number[] = [];
  await assert.rejects(
    withExportTransaction(
      f.output,
      (writer) =>
        completeSessionExport(
          writer,
          {
            ...f.options,
            signal: controller.signal,
            progress(phase, sessions, work) {
              if (phase !== 'relationships' || !work || !work.bytes || work.completed !== 0) return;
              assert.equal(sessions, 0);
              assert.equal(work.discovered, 1);
              assert.ok(work.bytes < fs.statSync(f.root).size);
              samples.push(work.bytes);
              if (samples.length === 3) setImmediate(() => controller.abort());
            },
          },
          async () => assert.fail('cancelled assembly reached projection'),
        ),
      controller.signal,
    ),
    ExportCancelled,
  );
  assert.equal(samples.length, 3);
  assert.ok(samples[0] < samples[1] && samples[1] < samples[2]);
  assert.equal(fs.readdirSync(f.output).length, 0);
});

test('large Codex assembly rejects changed source before accepting linkage or provenance', async () => {
  const f = largeCodexFixture();
  let changed = false;
  await assert.rejects(
    withExportTransaction(f.output, (writer) =>
      captureSessionExport(
        {
          ...f.options,
          progress(phase, _sessions, work) {
            if (phase !== 'relationships' || !work?.bytes || changed) return;
            changed = true;
            fs.appendFileSync(f.root, JSON.stringify({ type: 'ignored' }) + '\n');
            fs.utimesSync(f.root, 1700000001, 1700000001);
          },
        },
        writer,
      ),
    ),
    /changed during export/,
  );
  assert.equal(changed, true);
  assert.equal(fs.readdirSync(f.output).length, 0);
});

async function readPages(
  model: SessionExport,
  writer: Parameters<typeof captureSessionExport>[1],
): Promise<ExportPage[]> {
  const pages: ExportPage[] = [];
  for (const session of model.sessions)
    for (const key of session.pages) pages.push(await writer.readSpool<ExportPage>(key));
  return pages;
}

async function artifactText(directory: string): Promise<{ manifest: SiteManifest; text: string[] }> {
  const blocks = exportedSiteData(directory);
  const manifest = blocks.manifest;
  const text = manifest.sessions.flatMap((session) =>
    session.pages.flatMap((page) =>
      (page.cards ?? []).flatMap((asset) =>
        (blocks.data.get(asset.id) as { blocks: { text: string }[] }).blocks.map((block) => block.text),
      ),
    ),
  );
  return { manifest, text };
}

test('capture preserves literal admitted prompts and hand-back reports through generated assets', async () => {
  const f = fixture();
  const opening = 'Keep <Widget> exactly.\n\n\n    indented  words\n';
  const later = 'Later <Code>\n\n\n  keep  spaces';
  const queued = 'Queued <Example>\n\n\n    preserve  indentation';
  const report = 'THE COMPLETE HAND-BACK REPORT';
  const injected =
    '<ide_selection>PRIVATE SELECTED CONTENTS</ide_selection>\n<system-reminder>PRIVATE SYSTEM CONTEXT</system-reminder>\n';
  const records = claudeTurn('literal', 0, false);
  (records[0] as { message: { content: string } }).message.content = injected + opening;
  records.splice(
    1,
    0,
    record('attachment', 1, {
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: injected + queued },
    }),
  );
  records.push(
    record('assistant', 2, {
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'handback', name: 'SubagentHandback', input: { message: report } }],
      },
    }),
  );
  records.push(
    record('user', 3, {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'handback', content: 'delivered' }] },
    }),
  );
  records.push(
    record('assistant', 4, {
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Report delivered.' }] },
    }),
  );
  records.push(...claudeTurn('later', 5));
  (records.at(-2) as { message: { content: string } }).message.content = injected + later;
  f.write(f.root, records);
  const codex = codexTurn('literal-codex');
  (codex[2] as { payload: { content: { text: string }[] } }).payload.content[0].text = opening;
  codex.splice(
    3,
    0,
    record('response_item', 1, {
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: later }] },
    }),
  );
  f.codexSession(CODEX_ID, undefined, codex);
  const result = await withExportTransaction(f.output, (writer) =>
    completeSessionExport(writer, { ...f.options, readerParents: { [CODEX_ID]: 'root' } }, (capture, transaction) =>
      projectSessionSite(capture.model, transaction, { script: '', stylesheet: '' }),
    ),
  );
  const artifact = await artifactText(result.directory);
  assert.equal(artifact.text.filter((text) => text === opening).length, 2);
  assert.equal(artifact.text.filter((text) => text === later).length, 2);
  assert.ok(artifact.text.includes(queued));
  assert.ok(
    artifact.text.every(
      (text) => !text.includes('PRIVATE SELECTED CONTENTS') && !text.includes('PRIVATE SYSTEM CONTEXT'),
    ),
  );
  assert.equal(artifact.text.filter((text) => text === report).length, 1);
  assert.ok(artifact.text.indexOf(report) < artifact.text.indexOf('Report delivered.'));
});

test('capture carries indexed Codex names and prompt fallback through the manifest', async () => {
  const f = fixture();
  const turns = codexTurn(CODEX_ID);
  turns.splice(
    3,
    0,
    record('response_item', 1, {
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'spawn-worker',
        arguments: JSON.stringify({ task_name: 'worker', message: 'Child named work' }),
      },
    }),
    record('event_msg', 1, {
      payload: {
        type: 'sub_agent_activity',
        event_id: 'spawn-worker',
        agent_thread_id: NATIVE_CODEX_ID,
        agent_path: '/root/worker',
        kind: 'running',
      },
    }),
  );
  const root = f.codexSession(CODEX_ID, undefined, turns);
  f.codexSession(NATIVE_CODEX_ID, CODEX_ID);
  fs.writeFileSync(
    path.join(path.dirname(f.codex), 'session_index.jsonl'),
    [
      { id: CODEX_ID, thread_name: 'Root named work' },
      { id: NATIVE_CODEX_ID, thread_name: 'Child named work' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  const result = await withExportTransaction(f.output, (writer) =>
    completeSessionExport(
      writer,
      { ...f.options, root: { ...f.options.root, agent: 'codex', file: root, sessionId: CODEX_ID } },
      (capture, transaction) => projectSessionSite(capture.model, transaction, { script: '', stylesheet: '' }),
    ),
  );
  const { manifest } = await artifactText(result.directory);
  assert.deepEqual(
    Array.from(manifest.sessions, (session) => session.title),
    ['Root named work', 'Child named work'],
  );
  assert.ok(manifest.relationships[0].turn);
  const writer = await ExportTransaction.create(f.output);
  try {
    const capture = await captureSessionExport(f.options, writer);
    assert.equal(capture.model.sessions[0].title, 'prompt root');
  } finally {
    await writer.dispose();
  }
});

test('captured names reject index revisions and retain long saved names', async () => {
  const f = fixture();
  const root = f.codexSession(CODEX_ID);
  const index = path.join(path.dirname(f.codex), 'session_index.jsonl');
  const title = 'Named work '.repeat(12).trim();
  fs.writeFileSync(index, JSON.stringify({ id: CODEX_ID, thread_name: title }));
  const writer = await ExportTransaction.create(f.output);
  try {
    const capture = await captureSessionExport(
      { ...f.options, root: { ...f.options.root, file: root, agent: 'codex', sessionId: CODEX_ID } },
      writer,
    );
    assert.equal(capture.model.sessions[0].title, title);
    fs.appendFileSync(index, '\n' + JSON.stringify({ id: CODEX_ID, thread_name: 'Renamed work' }));
    await assert.rejects(capture.recheck(), /changed during export/);
  } finally {
    await writer.dispose();
  }
});

test('hand-back capture removes overlapping closing replies and keeps the longer report once', async () => {
  for (const [closing, report, expected] of [
    ['report', 'Complete report', 'Complete report'],
    ['Complete report', 'report', 'Complete report'],
  ]) {
    const f = fixture();
    const records = claudeTurn('overlap');
    (records[1] as { message: { content: { text: string }[] } }).message.content[0].text = closing;
    records.push(
      record('assistant', 2, {
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'handback', name: 'SubagentHandback', input: { message: report } }],
        },
      }),
    );
    records.push(
      record('assistant', 3, {
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Receipt.' }] },
      }),
    );
    f.write(f.root, records);
    const result = await withExportTransaction(f.output, (writer) =>
      completeSessionExport(writer, f.options, (capture, transaction) =>
        projectSessionSite(capture.model, transaction, { script: '', stylesheet: '' }),
      ),
    );
    const artifact = await artifactText(result.directory);
    assert.deepEqual(
      artifact.text.filter((text) => text.includes('report')),
      [expected],
    );
    assert.ok(artifact.text.indexOf(expected) < artifact.text.indexOf('Receipt.'));
  }
});

test('inventory changes retain identity and native-parent checks without unrelated Claude body revisions', async () => {
  for (const change of ['append', 'add', 'remove', 'parent'] as const) {
    const f = fixture();
    const unrelated = f.claudeSession('unrelated');
    const rollout = f.codexSession(CODEX_ID);
    const writer = await ExportTransaction.create(f.output);
    try {
      const capture = await captureSessionExport(f.options, writer);
      if (change === 'append')
        fs.appendFileSync(
          unrelated,
          JSON.stringify(record('assistant', 20, { message: { role: 'assistant', content: 'Additional work' } })) +
            '\n',
        );
      if (change === 'add') f.claudeSession('new');
      if (change === 'remove') fs.unlinkSync(unrelated);
      if (change === 'parent') {
        const lines = fs.readFileSync(rollout, 'utf8').split('\n');
        const opening = JSON.parse(lines[0]);
        opening.payload.source = {
          subagent: { thread_spawn: { parent_thread_id: 'root', agent_path: '/root/child' } },
        };
        lines[0] = JSON.stringify(opening);
        fs.writeFileSync(rollout, lines.join('\n'));
      }
      if (change === 'append') await capture.recheck();
      else await assert.rejects(capture.recheck(), /changed during export/);
    } finally {
      await writer.dispose();
    }
  }
});

test('unrelated body appends preserve export while changed opening evidence rejects it', async () => {
  const f = fixture();
  const unrelated = f.codexSession(CODEX_ID);
  let projections = 0;
  await withExportTransaction(f.output, (writer) =>
    completeSessionExport(writer, f.options, async (_capture, transaction) => {
      projections++;
      fs.appendFileSync(
        unrelated,
        JSON.stringify(record('event_msg', 10, { payload: { type: 'task_started', turn_id: 'later' } })) + '\n',
      );
      await transaction.writeIndexChunks(
        (async function* () {
          yield '<!doctype html>';
        })(),
      );
    }),
  );
  assert.equal(projections, 1);
  const writer = await ExportTransaction.create(f.output);
  try {
    const capture = await captureSessionExport(f.options, writer);
    const text = fs.readFileSync(unrelated, 'utf8');
    fs.writeFileSync(unrelated, text.replace(CODEX_ID, NATIVE_CODEX_ID));
    await assert.rejects(capture.recheck(), /changed during export/);
  } finally {
    await writer.dispose();
  }
});

test('stable incomplete Codex EOF fails bounded capture and accepts event-loop cancellation', async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    const root = f.codexSession(CODEX_ID);
    fs.appendFileSync(root, '{"type":"event_msg","payload":');
    const controller = new AbortController();
    let phases = 0;
    await assert.rejects(
      withExportTransaction(
        f.output,
        (writer) =>
          completeSessionExport(
            writer,
            {
              ...f.options,
              root: { ...f.options.root, agent: 'codex', file: root, sessionId: CODEX_ID },
              signal: controller.signal,
              limits: { sliceBytes: 32 },
              progress(phase) {
                if (cancel && phase === 'relationships' && ++phases === 2) setImmediate(() => controller.abort());
              },
            },
            async () => {},
          ),
        controller.signal,
      ),
      cancel ? ExportCancelled : /incomplete saved data/,
    );
    assert.equal(fs.readdirSync(f.output).length, 0);
  }
});

test('saved reader parents find cross-provider children outside the panel catalog and retain missing or ambiguous evidence', async () => {
  const f = fixture();
  f.codexSession('reader');
  f.child('native');
  f.claudeSession('ambiguous');
  f.codexSession('ambiguous');
  const writer = await ExportTransaction.create(f.output);
  try {
    const capture = await captureSessionExport(
      { ...f.options, readerParents: { reader: 'native', missing: 'reader', ambiguous: 'root' } },
      writer,
    );
    assert.equal(capture.model.sessions.length, 3);
    const child = capture.model.sessions.find((session) => session.agent === 'codex')!;
    assert.ok(child);
    const native = capture.model.relationships.find((edge) => edge.kind === 'subagent')!.to;
    assert.ok(
      capture.model.relationships.some(
        (edge) =>
          edge.from === native &&
          edge.to === child.key &&
          edge.kind === 'reader-started' &&
          edge.ownership === 'navigation',
      ),
    );
    assert.ok(
      capture.model.omissions.some((omission) => omission.session === child.key && omission.reason === 'missing'),
    );
    assert.ok(capture.model.omissions.some((omission) => omission.reason === 'ambiguous'));
    assert.equal(capture.model.coverage.relationships, 'partial');
    await writer.reset();
    const bounded = await captureSessionExport(
      { ...f.options, readerParents: { reader: 'root' }, limits: { inventoryPaths: 1 } },
      writer,
    );
    assert.ok(
      bounded.model.relationships.some(
        (edge) => edge.kind === 'reader-started' && edge.to === null && edge.reason === 'inventory-incomplete',
      ),
    );
  } finally {
    await writer.dispose();
  }
});

// These fixtures catch lost bodies and edges, private metadata, and publication after a changed source.
for (const agent of ['claude', 'codex'] as const) {
  test(`${agent} complete capture keeps multiple pages, thirteen submissions, and the unfinished body`, async () => {
    const f = fixture();
    const open = agent === 'claude' ? claudeTurn('open', 20, false) : codexTurn('open', 20, false);
    const asks = Array.from({ length: 13 }, (_item, index) =>
      agent === 'claude'
        ? record('attachment', 21, {
            attachment: { type: 'queued_command', commandMode: 'prompt', prompt: `later ${index}` },
          })
        : record('response_item', 21, {
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `later ${index}` }] },
          }),
    );
    const commentary = 'Full commentary '.repeat(5000);
    const comment =
      agent === 'claude'
        ? record('assistant', 21, {
            uuid: 'comment',
            message: {
              id: 'comment',
              role: 'assistant',
              stop_reason: 'tool_use',
              content: [{ type: 'text', text: commentary }],
            },
          })
        : record('response_item', 21, {
            payload: {
              type: 'message',
              id: 'comment',
              role: 'assistant',
              phase: 'commentary',
              content: [{ type: 'output_text', text: commentary }],
            },
          });
    let file: string;
    if (agent === 'claude')
      file = f.write(f.root, [...claudeTurn('one'), ...claudeTurn('two', 10), open[0], ...asks, comment, open[1]]);
    else
      file = f.codexSession('codex', undefined, [
        ...codexTurn('one'),
        ...codexTurn('two', 10),
        ...open.slice(0, 3),
        ...asks,
        comment,
        ...open.slice(3),
      ]);
    await withExportTransaction(f.output, async (writer) => {
      const captured = await captureSessionExport(
        { ...f.options, root: { ...f.options.root, agent, file, sessionId: agent === 'claude' ? 'root' : 'codex' } },
        writer,
      );
      const pages = await readPages(captured.model, writer);
      const turns = pages.flatMap((page) => page.turns);
      assert.equal(turns.length, 3);
      assert.equal(new Set(turns.map((turn) => turn.key)).size, 3);
      assert.ok(pages.length >= 2);
      const unfinished = turns.find((turn) => !turn.finished)!;
      assert.ok(unfinished);
      assert.equal(unfinished.blocks.filter((block) => block.kind === 'prompt').length, 14);
      assert.equal(unfinished.blocks.find((block) => block.kind === 'commentary')!.text, commentary);
      assert.equal(unfinished.blocks.filter((block) => block.text === 'answer open').length, 1);
      assert.deepEqual(
        unfinished.blocks.slice(1, 14).map((block) => block.text),
        asks.map((_ask, index) => `later ${index}`),
      );
      assert.equal(captured.model.sessions[0].turnCount, 3);
      if (agent === 'claude') assert.equal(captured.model.sessions[0].firstRequestCachedTokens, 30);
      assert.ok(captured.model.sessions[0].numbers.parts.length > 0);
    });
    assert.deepEqual(fs.readdirSync(f.output), []);
  });
}

test('repeated Claude assistant records retain their original body exactly once across pages', async () => {
  const f = fixture();
  const first = claudeTurn('first');
  f.write(f.root, [...first, ...claudeTurn('second', 10), first[1], ...claudeTurn('open', 20, false)]);
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(f.options, writer);
    const text = (await readPages(capture.model, writer)).flatMap((page) =>
      page.turns.flatMap((turn) => turn.blocks.map((block) => block.text)),
    );
    assert.equal(text.filter((text) => text === 'answer first').length, 1);
    assert.equal(text.filter((text) => text === 'answer second').length, 1);
    assert.equal(text.filter((text) => text === 'answer open').length, 1);
    assert.equal(
      capture.model.sessions[0].numbers.parts
        .filter((part) => part.role === 'main')
        .reduce((sum, part) => sum + (part.usage.requests ?? 0), 0),
      3,
    );
  });
});

test('graph capture closes nested native children, external dispatch, and reader links without counting reader work', async () => {
  const f = fixture();
  const nativeChildren = [f.child('child'), f.child('grandchild', 'child')];
  const external = f.codexSession(CODEX_ID);
  f.codexSession(NATIVE_CODEX_ID, CODEX_ID);
  f.claudeSession('reader');
  f.claudeSession('unrelated');
  f.write(f.root, [
    ...claudeTurn('root'),
    ...claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${CODEX_ID}"}`,
    ),
    record('progress', 10, {}),
    claudeCostState(
      {
        'claude-sonnet-4-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 90 },
      },
      1,
      'root',
    ),
  ]);
  const readerLinks = [
    {
      parent: { agent: 'claude' as const, sessionId: 'root' },
      child: { agent: 'claude' as const, sessionId: 'reader' },
    },
    {
      parent: { agent: 'claude' as const, sessionId: 'reader' },
      child: { agent: 'claude' as const, sessionId: 'root' },
    },
  ];
  let metrics: ReadMetrics = {};
  await withReadMetrics(
    () =>
      withExportTransaction(f.output, async (writer) => {
        const capture = await captureSessionExport({ ...f.options, readerLinks }, writer);
        assert.equal(capture.model.sessions.length, 6, JSON.stringify(capture.model.relationships));
        assert.equal(capture.model.relationships.length, 6);
        assert.equal(capture.model.relationships.filter((edge) => edge.kind === 'subagent').length, 3);
        assert.equal(capture.model.coverage.relationships, 'complete');
        const own = capture.model.sessions[0].numbers;
        assert.ok(own.combined.dollars! > own.main.dollars!);
        assert.ok(own.delegated.dollars! > 0);
        assert.ok(!JSON.stringify(capture.model).includes(external));
        const reader = capture.model.relationships.find(
          (edge) => edge.kind === 'reader-started' && edge.from === capture.model.root,
        )!.to!;
        assert.ok(!own.parts.some((part) => part.scope === reader));
        assert.equal(capture.model.sessions.find((session) => session.key === reader)!.numbers.delegated.dollars, null);
        const text = (await readPages(capture.model, writer)).flatMap((page) =>
          page.turns.flatMap((turn) => turn.blocks.map((block) => block.text)),
        );
        assert.ok(text.includes('answer grandchild'));
        assert.ok(text.includes(`answer ${NATIVE_CODEX_ID}`));
        assert.ok(!text.includes('answer unrelated'));
      }),
    (value) => {
      metrics = value;
    },
  );
  assert.equal(
    metrics.figures.bytes,
    nativeChildren.reduce((sum, file) => sum + fs.statSync(file).size, 0),
  );
});

test('short Claude dispatch IDs require global configured uniqueness', async () => {
  const f = fixture();
  f.claudeSession('aaaaaaaa-one');
  f.claudeSession('aaaaaaaa-two', claudeTurn('two'), 'other-workspace');
  f.write(f.root, [
    ...claudeTurn('root'),
    ...claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa"}',
    ),
  ]);
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(f.options, writer);
    assert.equal(capture.model.sessions.length, 1);
    assert.equal(capture.model.relationships[0].to, null);
    assert.equal(capture.model.relationships[0].reason, 'ambiguous');
    assert.equal(capture.model.coverage.relationships, 'partial');
  });
});

test('distinct paired launches to one session retain their relationships without duplicating text or cost', async () => {
  const f = fixture();
  f.codexSession(CODEX_ID);
  f.write(f.root, [
    ...claudeTurn('root'),
    ...Array.from({ length: 4 }, (_entry, index) =>
      claudeDispatchTranscript(
        'python dispatch.py --arc-dispatch',
        `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${CODEX_ID}"}`,
        `launch-${index}`,
      ),
    ).flat(),
  ]);
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(f.options, writer);
    assert.equal(capture.model.sessions.length, 2);
    assert.equal(capture.model.relationships.length, 4);
    assert.equal(
      capture.model.sessions[0].numbers.parts
        .filter((part) => part.role === 'delegated')
        .reduce((sum, part) => sum + (part.usage.requests ?? 0), 0),
      1,
    );
    assert.equal(
      (await readPages(capture.model, writer))
        .flatMap((page) => page.turns.flatMap((turn) => turn.blocks))
        .filter((block) => block.text === `answer ${CODEX_ID}`).length,
      1,
    );
  });
});

test('recorded Codex compactions retain priced overhead and request averages through export', async () => {
  for (const input of [1000, 100_000]) {
    for (const identified of [true, false]) {
      const f = fixture();
      const records = codexTurn('parent');
      records.splice(
        records.length - 1,
        0,
        record('compacted', 1, {
          payload: {
            latest_token_usage_record: {
              ...(identified ? { response_id: 'compact' } : {}),
              usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0, total_tokens: input },
            },
          },
        }),
        record('event_msg', 1, {
          payload: {
            type: 'thread_settings_applied',
            thread_settings: { model: 'gpt-5.4', model_provider_id: 'openai' },
          },
        }),
      );
      const root = f.codexSession(CODEX_ID, undefined, records);
      const live = toCard(readCodexSession(root, CODEX_ID).turns[0], false, f.options.capturedAt).chips.find(
        (stat) => stat.metric === 'cost',
      )!;
      const result = await withExportTransaction(f.output, (writer) =>
        completeSessionExport(
          writer,
          { ...f.options, root: { ...f.options.root, agent: 'codex', file: root, sessionId: CODEX_ID } },
          (capture, transaction) => projectSessionSite(capture.model, transaction, { script: '', stylesheet: '' }),
        ),
      );
      const { manifest, data } = exportedSiteData(result.directory);
      const session = manifest.sessions.find((value) => value.key === manifest.root)!;
      const sessionCost = manifest.stats[manifest.root].find(
        (stat) => stat.metric === 'cost',
      )! as unknown as SessionStatChip;
      const card = [...data.values()]
        .map((value) => value as { card?: import('./webview/payload-contracts').CardView })
        .find((value) => value.card?.kind === 'turn')!.card!;
      const turnCost = card.chips!.find((stat) => stat.metric === 'cost')!;
      assert.equal(session.numbers.combined.partial, !identified);
      assert.equal(turnCost.label, live.label);
      assert.equal(turnCost.detail, live.detail);
      for (const cost of [sessionCost]) {
        assert.equal(
          cost.detailList!.entries.find((entry) => entry.label === '1 compaction')?.value,
          identified ? formatCost((input * 2.5) / 1_000_000) : 'cost unavailable',
        );
        if (identified) {
          assert.match(JSON.stringify(cost.detailList), /"requestScale":\[1,100\]/);
          assert.doesNotMatch(cost.detail, /usage.*incomplete|may be low/i);
        } else {
          assert.match(cost.detail, /usage.*incomplete|may be low/i);
        }
      }
      if (identified) {
        const recorded = session.numbers.parts.find((part) => part.compactionUsage)!;
        assert.equal(recorded.estimated, false);
        assert.equal(recorded.usage.requests, 1);
      }
    }
  }
});

test('linked Claude command dollars stay exact through exported session and turn totals', async () => {
  for (const provisional of [false, true]) {
    const f = fixture();
    const records = codexTurn('parent').filter(
      (item) => provisional || (item as { payload?: { type?: string } }).payload?.type !== 'token_count',
    );
    if (provisional)
      records.splice(
        records.length - 1,
        0,
        record('compacted', 1, {
          payload: {
            latest_token_usage_record: {
              usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 30, total_tokens: 3030 },
            },
          },
        }),
        record('event_msg', 1, {
          payload: {
            type: 'thread_settings_applied',
            thread_settings: { model: 'gpt-5.4', model_provider_id: 'openai' },
          },
        }),
      );
    records.splice(
      records.length - 1,
      0,
      record('event_msg', 1, {
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'linked-claude',
            command: ['claude', '-p', 'Read the recorded accounting.', '--output-format', 'json'],
            parsed_cmd: [{ type: 'unknown', cmd: 'claude -p review --output-format json' }],
            status: 'completed',
            exit_code: 0,
            stdout: JSON.stringify({
              type: 'result',
              session_id: 'cccccccc-3333-4333-8333-333333333333',
              total_cost_usd: 3.25,
              duration_ms: 100,
              is_error: false,
              modelUsage: {
                'claude-opus-5': {
                  inputTokens: 20,
                  outputTokens: 40,
                  cacheReadInputTokens: 300,
                  cacheCreationInputTokens: 0,
                  thinkingTokens: 0,
                  costUSD: 3.25,
                  contextWindow: 1_000_000,
                  canonicalModel: 'claude-opus-5',
                  costBasis: 'list',
                },
              },
            }),
          },
        },
      }),
    );
    const root = f.codexSession(CODEX_ID, undefined, records);
    const result = await withExportTransaction(f.output, (writer) =>
      completeSessionExport(
        writer,
        { ...f.options, root: { ...f.options.root, agent: 'codex', file: root, sessionId: CODEX_ID } },
        (capture, transaction) => projectSessionSite(capture.model, transaction, { script: '', stylesheet: '' }),
      ),
    );
    const { manifest, data } = exportedSiteData(result.directory);
    const session = manifest.sessions.find((session) => session.key === manifest.root)!;
    const cost = manifest.stats[manifest.root].find((stat) => stat.metric === 'cost')! as unknown as SessionStatChip;
    const card = [...data.values()]
      .map((value) => value as { card?: import('./webview/payload-contracts').CardView })
      .find((value) => value.card?.agents?.some((agent) => agent.description === 'Claude CLI'))!.card!;
    const turnCost = card.chips!.find((stat) => stat.metric === 'cost')!;
    const linked = session.numbers.parts.find((part) => part.recordedCost === 3.25)!;
    assert.equal(linked.requestCountExact, false);
    assert.equal(session.numbers.combined.partial, provisional);
    assert.equal(cost.label, provisional ? '$3.25+' : '$3.25');
    assert.equal(turnCost.label, provisional ? '$3.25+' : '$3.25');
    if (provisional) {
      assert.ok(session.numbers.combined.dollars! > 3.25);
      assert.match(cost.detail, /usage.*incomplete|may be low/i);
    } else {
      assert.equal(session.numbers.combined.dollars, 3.25);
      assert.doesNotMatch(cost.detail, /usage.*incomplete|may be low/i);
      assert.doesNotMatch(String(turnCost.detail), /usage.*incomplete|may be low/i);
    }
  }
});

test('missing native records retain each relationship and an explicit partial reason', async () => {
  const f = fixture();
  for (const id of ['missing-one', 'missing-two']) fs.unlinkSync(f.child(id));
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(f.options, writer);
    assert.equal(capture.model.sessions.length, 1);
    assert.equal(capture.model.relationships.length, 2);
    assert.ok(capture.model.relationships.every((edge) => edge.to === null && edge.reason === 'missing'));
    assert.equal(capture.model.coverage.relationships, 'partial');
    assert.equal(capture.model.sessions[0].numbers.combined.partial, true);
  });
});

test('selecting a native child preserves an outside parent without following its incoming link', async () => {
  const f = fixture();
  f.codexSession(CODEX_ID);
  const file = f.codexSession(NATIVE_CODEX_ID, CODEX_ID);
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(
      { ...f.options, root: { ...f.options.root, agent: 'codex', file, sessionId: NATIVE_CODEX_ID } },
      writer,
    );
    assert.equal(capture.model.sessions.length, 1);
    assert.equal(capture.model.sessions[0].parentOutsideExport, true);
    assert.deepEqual(capture.model.relationships, []);
  });
});

test('Claude native identity stays parent-qualified when two included parents reuse a child ID', async () => {
  const f = fixture();
  f.claudeSession('peer', claudeTurn('peer'), 'project');
  f.child('same');
  f.child('same', null, 'peer');
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(
      {
        ...f.options,
        readerLinks: [
          { parent: { agent: 'claude', sessionId: 'root' }, child: { agent: 'claude', sessionId: 'peer' } },
        ],
      },
      writer,
    );
    assert.equal(capture.model.sessions.length, 4);
    assert.equal(capture.model.relationships.filter((edge) => edge.kind === 'subagent').length, 2);
    assert.equal(
      (await readPages(capture.model, writer))
        .flatMap((page) => page.turns.flatMap((turn) => turn.blocks))
        .filter((block) => block.text === 'answer same').length,
      2,
    );
  });
});

test('capture admits a large native Codex opening through its frozen metadata without the panel opening cap', async () => {
  const f = fixture();
  const file = f.codexSession('codex');
  const records = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  records[0].payload.padding = 'metadata '.repeat(20000);
  f.write(file, records);
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(
      { ...f.options, root: { ...f.options.root, agent: 'codex', file, sessionId: 'codex' } },
      writer,
    );
    assert.equal(capture.model.sessions[0].turnCount, 1);
    assert.equal(capture.model.coverage.text, 'complete');
    assert.ok(!JSON.stringify(capture.model).includes('metadata metadata'));
  });
});

test('conflicting native and dispatched claims refuse the child instead of assigning ownership', async () => {
  const f = fixture();
  f.codexSession(CODEX_ID);
  f.codexSession(NATIVE_CODEX_ID, CODEX_ID);
  f.write(f.root, [
    ...claudeTurn('root'),
    ...claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${NATIVE_CODEX_ID}"}`,
      'direct',
    ),
    ...claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${CODEX_ID}"}`,
      'parent',
    ),
  ]);
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(f.options, writer);
    assert.equal(capture.model.sessions.length, 2);
    assert.equal(capture.model.relationships.filter((edge) => edge.reason === 'conflicting').length, 2);
    assert.equal(capture.model.coverage.relationships, 'partial');
  });
});

test('private tool and reasoning payloads and absolute metadata paths stay outside the model', async () => {
  const f = fixture();
  f.write(f.root, [
    claudeTurn('root')[0],
    record('assistant', 1, {
      message: {
        id: 'secret',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hidden secret reasoning' },
          {
            type: 'tool_use',
            id: 'write',
            name: 'Write',
            input: { file_path: '/private/project/src/app.ts', content: 'secret raw patch' },
          },
          {
            type: 'tool_use',
            id: 'external',
            name: 'Write',
            input: { file_path: '/private/other/secrets.txt', content: 'secret external patch' },
          },
        ],
      },
    }),
    record('user', 2, {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'write', content: 'secret raw tool' }] },
      toolUseResult: {
        type: 'create',
        filePath: '/private/project/src/app.ts',
        content: 'secret raw patch',
        structuredPatch: [],
      },
    }),
    record('user', 3, {
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'external', content: 'secret external result' }],
      },
      toolUseResult: {
        type: 'create',
        filePath: '/private/other/secrets.txt',
        content: 'secret external patch',
        structuredPatch: [],
      },
    }),
    claudeTurn('root')[1],
  ]);
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(f.options, writer);
    const pages = await readPages(capture.model, writer);
    const serialized = JSON.stringify({ model: capture.model, pages });
    for (const forbidden of [
      'hidden secret reasoning',
      'secret raw patch',
      'secret raw tool',
      'secret external',
      '/private/',
      f.root,
    ])
      assert.ok(!serialized.includes(forbidden), forbidden);
    assert.equal(pages[0].turns[0].files[0].path, 'src/app.ts');
    assert.ok(capture.model.omissions.some((omission) => omission.reason === 'external-path'));
  });
});

for (const [boundary, limits] of [
  ['source', { sourceBytes: 10 }],
  ['graph bytes', { totalSourceBytes: 10 }],
  ['turns', { turns: 1 }],
  ['sessions', { sessions: 1 }],
  ['relationships', { relationships: 1 }],
] as const) {
  test(`capture rejects the ${boundary} limit without publishing a directory`, async () => {
    const f = fixture();
    f.write(f.root, [...claudeTurn('one'), ...claudeTurn('two', 10)]);
    f.child('child');
    f.child('grandchild', 'child');
    await assert.rejects(
      withExportTransaction(f.output, async (writer) => {
        await captureSessionExport({ ...f.options, limits }, writer);
      }),
      (error) => error instanceof ExportLimitError && error.boundary === boundary,
    );
    assert.deepEqual(fs.readdirSync(f.output), []);
  });
}

test('bounded incomplete inventory refuses a shortened identity and keeps honest graph coverage', async () => {
  const f = fixture();
  f.claudeSession('aaaaaaaa-one');
  f.write(f.root, [
    ...claudeTurn('root'),
    ...claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa"}',
    ),
  ]);
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport({ ...f.options, limits: { inventoryPaths: 1 } }, writer);
    assert.equal(capture.model.coverage.inventory, 'partial');
    assert.equal(capture.model.sessions.length, 1);
    assert.equal(capture.model.relationships[0].reason, 'inventory-incomplete');
  });
});

test('source changes after rendering cause one whole capture retry before publication', async () => {
  const f = fixture();
  let projections = 0;
  let metrics: ReadMetrics = {};
  const result = await withReadMetrics(
    () =>
      withExportTransaction(f.output, (writer) =>
        completeSessionExport(writer, f.options, async (capture, writer) => {
          projections++;
          if (projections === 1) f.write(f.root, claudeTurn('changed'));
          await writer.writeIndexChunks(
            (async function* () {
              yield '<!doctype html><title>capture</title>';
            })(),
          );
          await writer.writeAsset('json', JSON.stringify(capture.model));
        }),
      ),
    (value) => {
      metrics = value;
    },
  );
  assert.equal(
    Object.values(metrics).reduce((sum, phase) => sum + phase.sourceChangeRetries, 0),
    1,
  );
  assert.equal(projections, 2);
  assert.ok(fs.existsSync(result.index));
  assert.ok(!fs.readdirSync(result.directory).some((name) => name.startsWith('s-')));
});

test('a second source change fails without publishing either capture', async () => {
  const f = fixture();
  let projections = 0;
  await assert.rejects(
    withExportTransaction(f.output, (writer) =>
      completeSessionExport(writer, f.options, async (_capture, writer) => {
        f.write(f.root, claudeTurn(`changed-${++projections}`));
        await writer.writeIndexChunks(
          (async function* () {
            yield '<!doctype html><title>capture</title>';
          })(),
        );
      }),
    ),
    /changed during export/,
  );
  assert.equal(projections, 2);
  assert.deepEqual(fs.readdirSync(f.output), []);
});

test('cancellation between graph reads removes owned staging and leaves unrelated files', async () => {
  const f = fixture();
  const controller = new AbortController();
  fs.writeFileSync(path.join(f.output, 'author.txt'), 'keep');
  await assert.rejects(
    withExportTransaction(
      f.output,
      async (writer) =>
        captureSessionExport(
          {
            ...f.options,
            signal: controller.signal,
            progress: (phase) => {
              if (phase === 'text') controller.abort();
            },
          },
          writer,
        ),
      controller.signal,
    ),
    ExportCancelled,
  );
  assert.deepEqual(fs.readdirSync(f.output), ['author.txt']);
  assert.equal(fs.readFileSync(path.join(f.output, 'author.txt'), 'utf8'), 'keep');
});

test('strong graph recheck rejects an interior rewrite with restored size and mtime', async () => {
  const f = fixture();
  await withExportTransaction(f.output, async (writer) => {
    const capture = await captureSessionExport(f.options, writer);
    const stat = fs.statSync(f.root);
    fs.writeFileSync(f.root, fs.readFileSync(f.root, 'utf8').replace('answer root', 'answer edit'));
    fs.utimesSync(f.root, stat.atime, stat.mtime);
    await assert.rejects(capture.recheck(), /changed during export/);
  });
});

test('capturing a Codex parent includes its recorded background review on the owning turn without unrelated review text', async () => {
  for (const threadSource of ['guardian_review', 'subagent']) {
    const f = fixture();
    const root = f.codexSession(CODEX_ID, undefined, codexTurn('parent'));
    const child = f.codexSession(NATIVE_CODEX_ID, CODEX_ID, codexTurn('review', 1));
    const records = fs
      .readFileSync(child, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    records[0].timestamp = at(1);
    records[0].payload = {
      ...records[0].payload,
      parent_thread_id: CODEX_ID,
      source: { subagent: { other: 'guardian' } },
      thread_source: threadSource,
    };
    f.write(child, records);
    f.codexSession('unrelated', 'different-parent', codexTurn('PRIVATE UNRELATED REVIEW'));
    const result = await withExportTransaction(f.output, (writer) =>
      completeSessionExport(
        writer,
        { ...f.options, root: { ...f.options.root, agent: 'codex', file: root, sessionId: CODEX_ID } },
        (capture, transaction) => projectSessionSite(capture.model, transaction, { script: '', stylesheet: '' }),
      ),
    );
    const data = exportedSiteData(result.directory);
    assert.equal(data.manifest.sessions.length, 2);
    const edge = data.manifest.relationships.find((edge) => edge.kind === 'subagent')!;
    assert.ok(edge.to);
    assert.ok(edge.turn);
    const card = [...data.data.values()]
      .map((value) => value as { card?: import('./webview/payload-contracts').CardView })
      .find((value) => value.card?.key === edge.turn)!.card!;
    assert.equal(card.agents?.length, 1);
    assert.equal(card.agents?.[0].description, 'Background review');
    assert.equal(card.agents?.[0].sessionId, edge.to);
    const artifact = await artifactText(result.directory);
    assert.ok(artifact.text.includes('answer review'));
    assert.ok(artifact.text.every((text) => !text.includes('PRIVATE UNRELATED REVIEW')));
  }
});
