import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir } from './temproot.ts';
import { claudeDispatchTranscript } from './turnfixtures.ts';
import {
  captureSessionExport,
  completeSessionExport,
  type ExportCaptureOptions,
  type ExportPage,
  type SessionExport,
} from './exportdata.ts';
import { ExportCancelled, ExportTransaction, withExportTransaction } from './exportwriter.ts';
import { ExportLimitError } from './exportlimits.ts';
import { projectSessionSite } from './exportsite.ts';
import { runInNewContext } from 'node:vm';
import type { SiteAsset, SiteManifest, SiteCard, SiteBlock, SiteText } from './webview/export-model.ts';
const CODEX_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const NATIVE_CODEX_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const at = (second: number) => new Date(Date.UTC(2026, 8, 29, 12, 0, second)).toISOString();
const record = (type: string, second: number, fields: object) => ({ type, timestamp: at(second), ...fields });
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
  const manifestFile = fs
    .readdirSync(directory)
    .find(
      (name) =>
        name.endsWith('.js') &&
        fs.readFileSync(path.join(directory, name), 'utf8').startsWith('window.__arcExportManifest='),
    )!;
  const window: { __arcExportManifest?: SiteManifest } = {};
  runInNewContext(fs.readFileSync(path.join(directory, manifestFile), 'utf8'), { window });
  const manifest = window.__arcExportManifest!;
  const load = (asset: SiteAsset): unknown => {
    let data: unknown;
    runInNewContext(fs.readFileSync(path.join(directory, asset.file), 'utf8'), {
      window: {
        __arcExportReceive(_id: string, value: unknown) {
          data = value;
        },
      },
    });
    return data;
  };
  const text: string[] = [];
  for (const session of manifest.sessions)
    for (const page of session.pages)
      for (const card of load(page) as SiteCard[])
        for (const body of card.bodies)
          for (const block of load(body) as SiteBlock[])
            text.push(block.chunks.map((chunk) => (load(chunk) as SiteText).raw).join(''));
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
      await transaction.writeIndex('<!doctype html>');
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
      if (agent === 'claude') assert.equal(captured.model.sessions[0].firstRequestCacheRead, 30);
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
  f.child('child');
  f.child('grandchild', 'child');
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
  await withExportTransaction(f.output, async (writer) => {
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
  });
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
  const result = await withExportTransaction(f.output, (writer) =>
    completeSessionExport(writer, f.options, async (capture, writer) => {
      projections++;
      if (projections === 1) f.write(f.root, claudeTurn('changed'));
      await writer.writeIndex('<!doctype html><title>capture</title>');
      await writer.writeAsset('json', JSON.stringify(capture.model));
    }),
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
        await writer.writeIndex('<!doctype html><title>capture</title>');
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
