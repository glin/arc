import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { EXPORT_LIMITS } from './exportlimits';
import { ExportTransaction, ExportCancelled } from './exportwriter';
import { exportCard, exportTurn, exportScriptJson, projectSessionSite } from './exportsite';
import { type SessionStatChip, toCard } from './turncard';
import { turn, subagent, compaction, recordCommit, sessionSiteFixture, exportedSiteData } from './turnfixtures';
import { tempDir } from './temproot';
import type { CardView } from './webview/payload-contracts';
import type { ExportBlock } from './exportdata';
import { exportBrowserAssets } from './panelbundle';
import { exportFactValue } from './view/export-facts';
import { demoPayload, demoSessionCostParts, DEMO_COMPACTIONS } from '../scripts/readme-fixture';
import { sessionCostProjection } from './turncard';
import { estimateCost, formatCost } from './pricing';
import { writeDemoExports } from '../scripts/web-demo-export';
import { costPartOf, costPartsOf, projectTurn, projectCompaction } from './exportdata';
import { railBuckets } from './view/rail';
import { createClaudeSessionReducer } from './transcript';
import { createCodexSessionReducer } from './codex';
import { AgentRow, agentFigureRecord, DetailRowList, detailRowsFor } from './webview/card-rows';
import { StaticStatChip } from './webview/stat-chip';
import type { StatDetailList, StatDetailRenderer } from './webview/stat-detail';
import type { VNode } from 'preact';

test('linked child figures open their captured files and commits through the production row consumer', async () => {
  for (const provider of ['claude', 'codex'] as const)
    for (const kind of ['unmatched-native', 'reader-started', 'matched-native', 'dispatched'] as const)
      for (const collidingPath of [false, true]) {
        const writer = await ExportTransaction.create(tempDir('arc-site-child-records-'));
        try {
          const model = await sessionSiteFixture(writer);
          model.sessions[0].agent = provider;
          model.sessions[1].agent = provider;
          const childPath = collidingPath ? 'src/shared.ts' : 'only-child.ts';
          const parentPath = collidingPath ? 'src/shared.ts' : 'only-parent.ts';
          const usage = {
            requests: 1,
            input: 100000,
            cacheRead: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            output: 1000,
            thinking: 0,
          };
          const childTurn = turn({
            sessionId: 'child',
            finished: true,
            model: 'claude-sonnet-4-5',
            usage,
            files: [{ path: `/child/${childPath}`, added: 7, removed: 3, isNew: false, edits: [] }],
            commits: [recordCommit('bbbbbbb1234567890', 'Child change', 1, { dir: '/child' })],
          });
          const child = projectTurn(childTurn, 'child-0', { cwd: '/child' }, [], 'child', new Map());
          model.sessions[1].pages = [
            await writer.spool({ key: 'child-page', session: 'child', turns: [child], compactions: [] }),
          ];
          model.sessions[1].numbers = {
            ...model.sessions[1].numbers,
            parts: [costPartOf({ model: childTurn.model!, provider: null, contextWindow: null, role: 'main', usage })],
          };
          const parentTurn = turn({
            sessionId: 'root',
            finished: true,
            model: 'claude-sonnet-4-5',
            usage,
            files: [{ path: `/parent/${parentPath}`, added: 2, removed: 1, isNew: false, edits: [] }],
            commits: [recordCommit('aaaaaaa1234567890', 'Parent change', 0, { dir: '/parent' })],
            agents:
              kind === 'matched-native'
                ? [subagent({ id: 'native', toolUseId: 'launch', description: 'Child task', status: 'completed' })]
                : [],
          });
          const parent = projectTurn(
            parentTurn,
            'root-21',
            { cwd: '/parent' },
            [],
            'root',
            new Map([['launch', ['reader-link']]]),
          );
          parent.relationships = ['reader-link'];
          model.sessions[0].pages = [
            await writer.spool({ key: 'root-page', session: 'root', turns: [parent], compactions: [] }),
          ];
          model.relationships = [
            {
              ...model.relationships[0],
              kind: kind === 'dispatched' ? 'dispatched' : kind === 'reader-started' ? 'reader-started' : 'subagent',
              ownership: kind === 'reader-started' ? 'navigation' : 'delegated',
              requestedByReader: kind === 'reader-started',
            },
          ];
          await projectSessionSite(model, writer, { script: '', stylesheet: '' });
          const { manifest, data } = exportedSiteData((await writer.publish(async () => {})).directory);
          const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
          const records = new Map<string, StatDetailList>();
          let metric = '';
          const figureDetails = {
            connect(_node, _detail, record) {
              assert.equal(typeof record, 'function');
              records.set(metric, (record as () => StatDetailList)());
            },
          } as StatDetailRenderer;
          const rows = detailRowsFor(card, kind === 'dispatched' ? 'dispatched' : 'agents')!;
          const children = DetailRowList({ rows, post: () => {}, figureDetails }).props.children as VNode<
            Parameters<typeof AgentRow>[0]
          >[];
          assert.equal(children.length, 1);
          const props = children[0].props;
          assert.equal(children[0].type, AgentRow);
          assert.equal(props.agent.sessionId, 'child');
          assert.equal(props.agent.kind ?? 'subagent', kind === 'dispatched' ? 'dispatch' : 'subagent');
          assert.equal(props.agent.figures.find((figure) => figure.metric === 'files')!.compactLabel, '1 file');
          const rowChildren = AgentRow(props).props.children as VNode<{ class?: string }>[];
          const facts = rowChildren.find((node) => node?.props?.class === 'agentfacts')!;
          for (const node of facts.props.children as VNode<Parameters<typeof StaticStatChip>[0]>[]) {
            if (node?.type !== StaticStatChip || !['files', 'commits'].includes(node.props.stat.metric)) continue;
            metric = node.props.stat.metric;
            const figure = StaticStatChip(node.props);
            (figure.ref as (node: HTMLElement) => void)({} as HTMLElement);
          }
          const files = records.get('files')!.rows;
          assert.equal(files?.kind, 'files');
          if (files?.kind !== 'files') throw new Error('Missing child file detail');
          assert.deepEqual(
            files.files.map((file) => ({ path: file.path, added: file.added, removed: file.removed })),
            [{ path: childPath, added: 7, removed: 3 }],
            `${provider}, ${kind}, collision ${collidingPath}`,
          );
          assert.equal(files.files[0].identity, child.files[0].identity);
          const commits = records.get('commits')!.rows;
          assert.equal(commits?.kind, 'commits');
          if (commits?.kind !== 'commits') throw new Error('Missing child commit detail');
          assert.deepEqual(
            commits.commits.map((commit) => commit.sha),
            ['bbbbbbb1234567890'],
          );
          const native = kind === 'matched-native';
          assert.equal(card.files!.length, native ? 2 : 1);
          assert.equal(card.chips!.find((chip) => chip.metric === 'files')!.label, native ? '2 files' : '1 file');
          assert.equal(card.files!.find((file) => file.identity === parent.files[0].identity)!.added, 2);
          assert.equal(card.commits!.length, native ? 2 : 1);
          if (kind === 'reader-started') {
            assert.equal(props.agent.figures.find((figure) => figure.metric === 'cost')!.compactLabel, '$0.32');
            assert.equal(
              card.chips!.find((chip) => chip.metric === 'cost')!.label,
              toCard(parentTurn, false, model.capturedAt).chips.find((chip) => chip.metric === 'cost')!.label,
            );
            assert.equal(manifest.stats.root.find((stat) => stat.metric === 'cost')!.dollars, 3);
          }
        } finally {
          await writer.dispose();
        }
      }
});

test('an admitted 150000-command source retains every command through card projection', () => {
  const reducer = createClaudeSessionReducer('root', {
    captureSessionText: true,
    exportTurnBytes: 16 * 1024 * 1024,
    maxTurns: 2,
  });
  let bytes = 0;
  const push = (value: object) => {
    const text = JSON.stringify(value);
    assert.ok(Buffer.byteLength(text) < 8 * 1024 * 1024);
    const end = bytes + Buffer.byteLength(text) + 1;
    reducer.pushLine({ text, start: bytes, end });
    bytes = end;
  };
  push({
    type: 'user',
    uuid: 'p',
    timestamp: '1970-01-01T00:00:00Z',
    message: { role: 'user', content: 'Run commands' },
  });
  for (let page = 0; page < 2; page++) {
    push({
      type: 'assistant',
      uuid: `a${page}`,
      timestamp: '1970-01-01T00:00:00Z',
      message: {
        id: `m${page}`,
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        content: Array.from({ length: 75000 }, (_, index) => ({
          type: 'tool_use',
          id: `c${page * 75000 + index}`,
          name: 'Bash',
          input: { command: 'true' },
        })),
      },
    });
  }
  assert.ok(bytes < 16 * 1024 * 1024);
  const original = reducer.read().turns[0];
  assert.equal(original.steps.length, 150000);
  const captured = projectTurn(original, 'large', { cwd: '/project' }, [], 'root', new Map());
  const card = exportCard(toCard(exportTurn(captured, 'claude', 'root'), false, 10000));
  const commands = card.activity!.flatMap((row) =>
    row.kind === 'run' ? row.steps! : row.kind === 'step' ? [row] : [],
  );
  assert.equal(commands.length, 150000);
  assert.equal(commands[0].id, 'step:1');
  assert.equal(commands.at(-1)!.id, 'step:150000');
  assert.ok(commands.every((row) => row.code === 'true'));
}, 60000);

test('recorded aborted and failed unfinished children retain terminal figures', async () => {
  for (const state of ['interrupted', 'failed'] as const) {
    for (const native of [false, true]) {
      const writer = await ExportTransaction.create(tempDir('arc-site-terminal-child-'));
      try {
        const model = await sessionSiteFixture(writer);
        const child = model.sessions[1];
        child.agent = state === 'interrupted' ? 'codex' : 'claude';
        const childPage = await writer.readSpool<import('./exportdata').ExportPage>(child.pages[0]);
        if (state === 'interrupted') {
          const reducer = createCodexSessionReducer('child');
          for (const [at, payload] of [
            [model.capturedAt - 124000, { type: 'task_started', turn_id: 'aborted' }],
            [model.capturedAt - 124000, { type: 'user_message', message: 'Run the child task' }],
            [model.capturedAt - 1000, { type: 'turn_aborted', turn_id: 'aborted', reason: 'interrupted' }],
          ] as const)
            reducer.pushLine(JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload }));
          const aborted = reducer.read().turns[0];
          assert.equal(aborted.finished, false);
          assert.equal(aborted.interrupted, true);
          childPage.turns[0] = projectTurn(
            { ...aborted, files: [{ path: '/project/src/child.ts', added: 5, removed: 2, isNew: false, edits: [] }] },
            'child-0',
            { cwd: '/project' },
            [],
            'child',
            new Map(),
          );
        }
        Object.assign(childPage.turns[0], {
          finished: false,
          interrupted: state === 'interrupted',
          error: state === 'failed' ? 'Command failed' : null,
          startedAt: model.capturedAt - 124000,
          endedAt: model.capturedAt - 1000,
        });
        child.pages = [await writer.spool(childPage)];
        const root = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
        model.relationships[0].kind = native ? 'subagent' : 'dispatched';
        model.relationships[0].ownership = 'delegated';
        if (native)
          root.turns[0].agents = [
            {
              key: 'native',
              relationships: ['reader-link'],
              description: 'Native task',
              agentType: null,
              model: null,
              effort: null,
              status: 'launched',
              startedAt: null,
              durationMs: null,
              tokens: null,
              toolUses: null,
              partial: false,
            },
          ];
        model.sessions[0].pages[0] = await writer.spool(root);
        await projectSessionSite(model, writer, { script: '', stylesheet: '' });
        const { manifest, data } = exportedSiteData((await writer.publish(async () => {})).directory);
        const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
        const row = native ? card.agents![0] : card.dispatched![0];
        assert.equal(row.state, state);
        assert.equal(row.figures.find((figure) => figure.metric === 'duration')?.compactLabel, '2m');
        assert.equal(row.figures.find((figure) => figure.metric === 'files')?.compactLabel, '1 file');
      } finally {
        await writer.dispose();
      }
    }
  }
});

test('repeated dispatch receipts charge the first chronological turn across spooled pages', async () => {
  for (const separatePages of [false, true]) {
    const writer = await ExportTransaction.create(tempDir('arc-site-dispatch-owner-'));
    try {
      const model = await sessionSiteFixture(writer);
      const root = model.sessions[0];
      const newest = await writer.readSpool<import('./exportdata').ExportPage>(root.pages[0]);
      const oldest = await writer.readSpool<import('./exportdata').ExportPage>(root.pages.at(-1)!);
      const cost = costPartOf({
        model: 'claude-sonnet-4-5',
        provider: null,
        contextWindow: null,
        role: 'main',
        usage: {
          requests: 1,
          input: 100000,
          cacheRead: 0,
          cacheWrite1h: 0,
          cacheWrite5m: 0,
          output: 1000,
          thinking: 0,
        },
      });
      model.sessions[1].numbers.parts = [cost];
      model.relationships[0].kind = 'dispatched';
      model.relationships[0].ownership = 'delegated';
      model.relationships.push({ ...model.relationships[0], key: 'first-dispatch', turn: oldest.turns[0].key });
      oldest.turns[0].relationships = ['first-dispatch'];
      root.pages = separatePages
        ? [await writer.spool(newest), await writer.spool(oldest)]
        : [await writer.spool({ ...newest, turns: [newest.turns[0], oldest.turns[0]] })];
      await projectSessionSite(model, writer, { script: '', stylesheet: '' });
      const { manifest, data } = exportedSiteData((await writer.publish(async () => {})).directory);
      const cards = manifest.sessions[0].pages.flatMap((page) =>
        page.cards!.map((asset) => (data.get(asset.id) as { card: CardView }).card),
      );
      const own = estimateCost(newest.turns[0].usage as import('./transcript').TurnUsage, newest.turns[0].model)!;
      assert.equal(
        cards.find((card) => card.key === 'root-21')!.chips!.find((chip) => chip.metric === 'cost')!.label,
        formatCost(own),
      );
      assert.equal(
        cards.find((card) => card.key === 'root-0')!.chips!.find((chip) => chip.metric === 'cost')!.label,
        formatCost(0.315 + own),
      );
      assert.equal(manifest.stats.root.find((stat) => stat.metric === 'cost')!.dollars, 3);
    } finally {
      await writer.dispose();
    }
  }
});

test('delegated file identities distinguish relative-name collisions and deduplicate physical paths', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    vi.stubGlobal('process', { ...process, platform });
    try {
      const files = ['C:/Repo/Src/Shared.ts', 'c:\\repo\\src\\shared.ts', '/one/Src/Shared.ts', 'src/shared.ts'].map(
        (file, index) =>
          projectTurn(
            turn({ files: [{ path: file, added: 1, removed: 0, isNew: false, edits: [] }] }),
            'case',
            { cwd: index < 2 ? 'C:/Repo' : '/one' },
            [],
            'case',
            new Map(),
          ).files[0],
      );
      assert.equal(files[0].identity, files[1].identity, platform);
      assert.equal(files[2].identity === files[3].identity, platform === 'win32', platform);
    } finally {
      vi.unstubAllGlobals();
    }
  }
  for (const kind of ['subagent', 'dispatched'] as const)
    for (const sharedPath of [false, true]) {
      const writer = await ExportTransaction.create(tempDir('arc-site-file-identities-'));
      try {
        const model = await sessionSiteFixture(writer);
        const child = model.sessions[1];
        const original = turn({
          finished: true,
          files: [{ path: '/one/src/shared.ts', added: 3, removed: 1, isNew: false, edits: [] }],
        });
        const captured = projectTurn(original, 'child-0', { cwd: '/one' }, [], 'child', new Map());
        captured.relationships = ['nested-link'];
        child.pages = [await writer.spool({ key: 'child-page', session: 'child', turns: [captured], compactions: [] })];
        const nested = { ...child, key: 'nested', title: 'Nested task' };
        const cwd = sharedPath ? '/one' : '/two';
        const nestedTurn = projectTurn(
          turn({
            finished: true,
            files: [{ path: `${cwd}/src/shared.ts`, added: 7, removed: 2, isNew: false, edits: [] }],
          }),
          'nested-0',
          { cwd },
          [],
          'nested',
          new Map(),
        );
        assert.equal(captured.files[0].identity === nestedTurn.files[0].identity, sharedPath);
        assert.match(captured.files[0].identity!, /^[a-f0-9]{64}$/);
        nested.pages = [
          await writer.spool({ key: 'nested-page', session: 'nested', turns: [nestedTurn], compactions: [] }),
        ];
        model.sessions.push(nested);
        model.relationships[0].kind = kind;
        model.relationships[0].ownership = 'delegated';
        model.relationships.push({
          key: 'nested-link',
          from: 'child',
          to: 'nested',
          kind: 'subagent',
          ownership: 'delegated',
          requestedByReader: false,
          coverage: 'complete',
        });
        const root = model.sessions[0];
        const rootPage = await writer.readSpool<import('./exportdata').ExportPage>(root.pages[0]);
        rootPage.turns[0].files = projectTurn(
          turn({ files: [{ path: '/root/src/shared.ts', added: 2, removed: 1, isNew: false, edits: [] }] }),
          'root',
          { cwd: '/root' },
          [],
          'root',
          new Map(),
        ).files;
        rootPage.turns[0].agents =
          kind === 'subagent'
            ? [
                {
                  key: 'native',
                  relationships: ['reader-link'],
                  description: 'Native task',
                  agentType: null,
                  model: null,
                  effort: null,
                  status: 'completed',
                  startedAt: null,
                  durationMs: null,
                  tokens: null,
                  toolUses: null,
                  partial: false,
                },
              ]
            : [];
        root.pages = [await writer.spool(rootPage)];
        await projectSessionSite(model, writer, { script: '', stylesheet: '' });
        const published = await writer.publish(async () => {});
        const { manifest, data } = exportedSiteData(published.directory);
        const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
        const row = kind === 'subagent' ? card.agents![0] : card.dispatched!.find((row) => row.sessionId === 'child')!;
        const files = row.figures.find((figure) => figure.metric === 'files')!;
        assert.equal(files.compactLabel, sharedPath ? '1 file' : '2 files');
        assert.equal(files.added, 10);
        assert.equal(files.removed, 3);
        assert.deepEqual(files.paths, Array(sharedPath ? 1 : 2).fill('src/shared.ts'));
        const rows = detailRowsFor(card, kind === 'subagent' ? 'agents' : 'dispatched')!;
        const props = (
          DetailRowList({ rows, post: () => {} }).props.children as VNode<Parameters<typeof AgentRow>[0]>[]
        ).find((node) => node.props.agent.sessionId === row.sessionId)!.props;
        const record = agentFigureRecord(files, card.key, props.files!, props.commits!)!();
        assert.equal(record.rows?.kind, 'files');
        if (record.rows?.kind !== 'files') throw new Error('Missing delegated files');
        assert.deepEqual(
          record.rows.files.map((file) => file.added),
          sharedPath ? [10] : [3, 7],
        );
        assert.equal(card.files!.length, kind === 'subagent' ? (sharedPath ? 2 : 3) : 1);
        assert.equal(
          card.chips!.find((chip) => chip.metric === 'files')!.label,
          kind === 'subagent' ? (sharedPath ? '2 files' : '3 files') : '1 file',
        );
        const html = await fs.readFile(published.index, 'utf8');
        const decoded = JSON.stringify([...data.values()]);
        for (const directory of ['/one/', '/two/', '/root/'])
          assert.ok(!html.includes(directory) && !decoded.includes(directory));
      } finally {
        await writer.dispose();
      }
    }
});

test('omitted child file identities and native hydration retain incomplete qualification separately from line counts', async () => {
  for (const kind of ['dispatched', 'native', 'native-captured', 'partial-lines'] as const) {
    const writer = await ExportTransaction.create(tempDir('arc-site-child-file-coverage-'));
    try {
      const model = await sessionSiteFixture(writer);
      const child = model.sessions[1];
      const partialLines = kind === 'partial-lines';
      const original = turn({
        finished: true,
        files: [
          {
            path: '/one/src/kept.ts',
            added: 3,
            removed: 1,
            isNew: false,
            edits: [],
            ...(partialLines ? { countsUnknown: true as const, unknownReason: 'write' as const } : {}),
          },
          ...(!partialLines && kind !== 'native-captured'
            ? [{ path: '/outside/omitted.ts', added: 7, removed: 2, isNew: false, edits: [] }]
            : []),
        ],
      });
      const omissions: import('./exportdata').ExportOmission[] = [];
      const captured = projectTurn(original, 'child-0', { cwd: '/one' }, omissions, 'child', new Map());
      assert.equal(captured.filesComplete, partialLines || kind === 'native-captured');
      if (!partialLines && kind !== 'native-captured') assert.equal(omissions[0].reason, 'external-path');
      child.pages = [await writer.spool({ key: 'child-page', session: 'child', turns: [captured], compactions: [] })];
      const native = kind.startsWith('native');
      model.relationships[0].kind = native ? 'subagent' : 'dispatched';
      model.relationships[0].ownership = 'delegated';
      const root = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
      if (native)
        root.turns[0].agents = [
          {
            key: 'native',
            relationships: ['reader-link'],
            description: 'Native task',
            agentType: null,
            model: null,
            effort: null,
            status: 'completed',
            startedAt: null,
            durationMs: null,
            tokens: null,
            toolUses: null,
            partial: false,
            artifacts: { files: [], commits: [], complete: kind !== 'native-captured' },
          },
        ];
      model.sessions[0].pages[0] = await writer.spool(root);
      await projectSessionSite(model, writer, { script: '', stylesheet: '' });
      const { manifest, data } = exportedSiteData((await writer.publish(async () => {})).directory);
      const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
      const row = native ? card.agents![0] : card.dispatched![0];
      const files = row.figures.find((figure) => figure.metric === 'files')!;
      assert.equal(files.compactLabel, partialLines ? '1 file' : '1+ file');
      assert.equal(files.added, 3);
      assert.equal(files.removed, 1);
      assert.ok(files.record?.footer);
      assert.ok(Array.isArray(files.record.footer) && files.record.footer.length > 0);
    } finally {
      await writer.dispose();
    }
  }
});

test('child and dispatch recorded costs exclude lifetime supplements and retain advisor and compaction usage', async () => {
  for (const extraRecorded of [false, true]) {
    const writer = await ExportTransaction.create(tempDir('arc-site-recorded-cost-'));
    try {
      const model = await sessionSiteFixture(writer);
      const amount = costPartOf({
        role: 'main',
        model: 'claude-sonnet-4-5',
        provider: null,
        contextWindow: null,
        usage: {
          requests: 1,
          input: 100000,
          cacheRead: 0,
          cacheWrite1h: 0,
          cacheWrite5m: 0,
          output: 1000,
          thinking: 0,
        },
      });
      const recorded = extraRecorded ? 0.315 * 3 : 0.315;
      const child = model.sessions[1];
      child.numbers = {
        parts: [
          amount,
          { ...amount, origin: 'claude-cost-state' },
          ...(extraRecorded
            ? [
                { ...amount, origin: 'claude-advisor' as const },
                { ...amount, compactionUsage: true as const },
              ]
            : []),
        ],
        main: { dollars: recorded + 0.315, partial: false },
        delegated: { dollars: 0, partial: false },
        combined: { dollars: recorded + 0.315, partial: false },
        coverage: { usage: 'complete', cost: 'complete' },
      };
      const childPage = await writer.readSpool<import('./exportdata').ExportPage>(child.pages[0]);
      childPage.turns[0].finished = true;
      child.pages = [await writer.spool(childPage)];
      model.relationships[0].kind = 'dispatched';
      model.relationships[0].ownership = 'delegated';
      await projectSessionSite(model, writer, { script: '', stylesheet: '' });
      const { manifest, data } = exportedSiteData((await writer.publish(async () => {})).directory);
      const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
      assert.equal(
        card.dispatched![0].figures.find((figure) => figure.metric === 'cost')?.compactLabel,
        formatCost(recorded),
      );
      const own = estimateCost(childPage.turns[0].usage as import('./transcript').TurnUsage, childPage.turns[0].model)!;
      assert.equal(card.chips!.find((chip) => chip.metric === 'cost')!.label, formatCost(recorded + own));
      assert.equal(manifest.stats.child.find((stat) => stat.metric === 'cost')!.dollars, recorded + 0.315);
    } finally {
      await writer.dispose();
    }
  }
});

test('an exported Dispatched Claude row shows no speed from request-timed child turns', async () => {
  const writer = await ExportTransaction.create(tempDir('arc-site-dispatch-rate-'));
  try {
    const model = await sessionSiteFixture(writer);
    const child = model.sessions[1];
    child.agent = 'claude';
    const part = costPartOf({
      role: 'main',
      model: 'claude-opus-5',
      provider: null,
      contextWindow: null,
      usage: { requests: 1, input: 1000, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, output: 300, thinking: 0 },
    });
    child.numbers = {
      parts: [part],
      main: { dollars: 0.1, partial: false },
      delegated: { dollars: 0, partial: false },
      combined: { dollars: 0.1, partial: false },
      coverage: { usage: 'complete', cost: 'complete' },
    };
    const childPage = await writer.readSpool<import('./exportdata').ExportPage>(child.pages[0]);
    const timed = childPage.turns[0];
    timed.finished = true;
    timed.model = 'claude-opus-5';
    timed.outputRate = { output: 300, milliseconds: 2000 };
    timed.outputRateModel = 'claude-opus-5';
    timed.outputRateBasis = 'request';
    child.pages = [await writer.spool(childPage)];
    model.relationships[0].kind = 'dispatched';
    model.relationships[0].ownership = 'delegated';
    await projectSessionSite(model, writer, { script: '', stylesheet: '' });
    const { manifest, data } = exportedSiteData((await writer.publish(async () => {})).directory);
    const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
    assert.ok(card.dispatched?.[0]);
    assert.doesNotMatch(JSON.stringify(card.dispatched[0]), /tok\/s/);
  } finally {
    await writer.dispose();
  }
});

test('an exported Claude turn keeps the interval that timed its output speed', () => {
  const original = turn({
    agent: 'claude',
    usage: { requests: 1, input: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, output: 300, thinking: 0 },
    outputRate: { output: 300, milliseconds: 2000 },
    outputRateModel: 'claude-opus-5',
    outputRateBasis: 'request',
  });
  const restored = exportTurn(
    projectTurn(original, 'turn', { cwd: '/project' }, [], 'root', new Map()),
    'claude',
    'root',
  );
  const speed = (card: ReturnType<typeof toCard>) =>
    card.chips.find((chip) => chip.metric === 'tokens')?.detailList?.entries.find((entry) => entry.label === 'Output')
      ?.lines?.[0];
  assert.deepEqual(speed(toCard(restored, false, 200_000)), speed(toCard(original, false, 200_000)));
  assert.match(JSON.stringify(speed(toCard(restored, false, 200_000))), /Request time includes the wait/);
});

test('exported turn figures retain production records, warnings and counted partial lines', () => {
  for (const agent of ['claude', 'codex'] as const) {
    const original = turn({
      agent,
      files: [
        {
          path: '/project/src/change.ts',
          added: 9,
          removed: 4,
          isNew: false,
          edits: [],
          countsUnknown: true,
          unknownReason: 'write',
        },
      ],
      usage: {
        requests: 6,
        input: 0,
        cacheRead: 0,
        cacheWrite1h: 2_000_000,
        cacheWrite5m: 0,
        output: 300,
        thinking: 0,
      },
      contextTokens: 34_000,
      contextWindow: 200_000,
      outputRate: { output: 300, milliseconds: 2000 },
      agents: [
        subagent({
          durationMs: 123_000,
          spendFound: true,
          spend: [
            {
              model: 'claude-sonnet-4-5',
              usage: {
                requests: 1,
                input: 100_000,
                cacheRead: 0,
                cacheWrite1h: 0,
                cacheWrite5m: 0,
                output: 1000,
                thinking: 0,
              },
            },
          ],
        }),
      ],
    });
    const captured = projectTurn(original, 'turn', { cwd: '/project' }, [], 'root', new Map());
    assert.equal(captured.files[0].added, 9);
    assert.equal(captured.files[0].removed, 4);
    assert.equal(captured.files[0].reason, 'write');
    const restored = exportTurn(captured, agent, 'root');
    const production = toCard(
      { ...original, files: original.files.map((file) => ({ ...file, path: 'src/change.ts' })) },
      false,
      200_000,
    );
    const card = exportCard(toCard(restored, false, 200_000));
    assert.deepEqual(JSON.parse(JSON.stringify(card.chips)), JSON.parse(JSON.stringify(exportCard(production).chips)));
    for (const metric of ['cost', 'files', 'context', 'tokens', 'agents']) {
      const chip = card.chips!.find((chip) => chip.metric === metric)!;
      assert.ok(chip.detailList?.entries, metric);
      assert.deepEqual(chip.detailList, production.chips.find((chip) => chip.metric === metric)!.detailList);
    }
    const files = card.chips!.find((chip) => chip.metric === 'files')!;
    assert.equal(files.added, 9);
    assert.equal(files.removed, 4);
    assert.ok(files.detailList!.footer?.some((line) => line.includes('partial')));
    const child = card.agents![0];
    assert.equal(child.figures.find((figure) => figure.metric === 'duration')?.compactLabel, '2m');
    assert.equal(child.figures.find((figure) => figure.metric === 'cost')?.compactLabel, '$0.32');
    assert.deepEqual(
      JSON.parse(JSON.stringify(child.figures)),
      JSON.parse(JSON.stringify(production.agents[0].figures)),
    );
  }
  const warningUsage = {
    requests: 6,
    input: 0,
    cacheRead: 0,
    cacheWrite1h: 2_000_000,
    cacheWrite5m: 0,
    output: 300,
    thinking: 0,
  };
  const warned = exportCard(
    toCard(
      turn({
        model: 'claude-opus-5-5',
        usage: warningUsage,
        usageParts: [
          {
            model: 'claude-opus-5-5',
            provider: null,
            contextWindow: 1_000_000,
            contextBand: null,
            inferenceClass: null,
            serviceTier: null,
            usage: warningUsage,
          },
        ],
      }),
      false,
      200_000,
    ),
  ).chips!.find((chip) => chip.metric === 'cost')!;
  assert.ok(warned.warnings?.length);
});

test('linked Subagents and Dispatched rows retain recorded child cost and duration without repeated delegated totals', async () => {
  for (const kind of ['subagent', 'dispatched', 'printed', 'native-codex'] as const) {
    const writer = await ExportTransaction.create(tempDir('arc-site-child-figures-'));
    try {
      const model = await sessionSiteFixture(writer);
      const childSession = model.sessions[1];
      childSession.agent = kind === 'native-codex' ? 'codex' : 'claude';
      const childPage = await writer.readSpool<import('./exportdata').ExportPage>(childSession.pages[0]);
      const child = childPage.turns[0];
      child.finished = true;
      child.startedAt = model.capturedAt - 124_000;
      child.endedAt = model.capturedAt - 1000;
      const amount = {
        ...demoSessionCostParts('arc-demo-review')[0],
        role: 'main' as const,
        model: 'claude-sonnet-4-5',
        usage: {
          requests: 1,
          input: 100_000,
          cacheRead: 0,
          cacheWrite1h: 0,
          cacheWrite5m: 0,
          output: 1000,
          thinking: 0,
        },
      };
      childSession.numbers = {
        parts: [costPartOf(amount), costPartOf({ ...amount, role: 'delegated' }, 'nested')],
        main: { dollars: 0.315, partial: false },
        delegated: { dollars: 0.315, partial: false },
        combined: { dollars: 0.63, partial: false },
        coverage: { usage: 'complete', cost: 'complete' },
      };
      childSession.pages = [await writer.spool(childPage)];
      const root = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
      root.turns[0].startedAt = model.capturedAt - 180_000;
      root.turns[0].agents =
        kind !== 'dispatched'
          ? [
              {
                key: 'native',
                relationships: ['reader-link'],
                description: 'Native task',
                agentType: kind === 'printed' ? 'claude-cli' : null,
                ...(kind === 'printed' ? { spend: [costPartOf(amount)], spendFound: true } : {}),
                model: kind === 'native-codex' ? 'gpt-5.4' : null,
                effort: null,
                status: 'completed',
                startedAt: null,
                durationMs: null,
                tokens: null,
                toolUses: null,
                partial: kind !== 'printed',
              },
            ]
          : [];
      model.relationships[0].kind = kind === 'printed' ? 'dispatched' : kind === 'native-codex' ? 'subagent' : kind;
      model.relationships[0].ownership = 'delegated';
      if (kind === 'dispatched') {
        model.relationships.push({ ...model.relationships[0], key: 'same-dispatch' });
        root.turns[0].relationships.push('same-dispatch');
      }
      model.sessions[0].pages[0] = await writer.spool(root);
      await projectSessionSite(model, writer, { script: '', stylesheet: '' });
      const { manifest, data } = exportedSiteData((await writer.publish(async () => {})).directory);
      const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
      const row = kind === 'subagent' || kind === 'native-codex' ? card.agents![0] : card.dispatched![0];
      if (kind === 'native-codex')
        assert.equal(
          row.model,
          toCard(turn({ agents: [subagent({ model: 'gpt-5.4' })] }), false, model.capturedAt).agents[0].model,
        );
      assert.equal(row.figures.find((figure) => figure.metric === 'cost')?.compactLabel, '$0.63');
      assert.equal(row.figures.find((figure) => figure.metric === 'duration')?.compactLabel, '2m');
      assert.equal(row.sessionId, 'child');
      assert.ok(row.figures.find((figure) => figure.metric === 'cost')?.record);
      assert.equal(
        card.chips!.find((chip) => chip.metric === 'cost')!.label,
        formatCost(0.63 + estimateCost(root.turns[0].usage as import('./transcript').TurnUsage, root.turns[0].model)!),
      );
      assert.equal(manifest.stats.root.find((stat) => stat.metric === 'cost')!.dollars, 3);
    } finally {
      await writer.dispose();
    }
  }
});

test('nested child artifacts and unavailable or unfinished figures retain their qualifications', async () => {
  for (const unfinished of [true, false]) {
    const writer = await ExportTransaction.create(tempDir('arc-site-nested-figures-'));
    try {
      const model = await sessionSiteFixture(writer);
      const child = model.sessions[1];
      const childPage = await writer.readSpool<import('./exportdata').ExportPage>(child.pages[0]);
      childPage.turns[0].finished = !unfinished;
      childPage.turns[0].files = [{ path: 'child.ts', added: 3, removed: 1, isNew: false, reason: null }];
      childPage.turns[0].relationships = ['nested-link'];
      child.pages = [await writer.spool(childPage)];
      const nested = { ...child, key: 'nested', title: 'Nested task', numbers: { ...child.numbers, parts: [] } };
      const nestedPage = structuredClone(childPage);
      nestedPage.session = 'nested';
      nestedPage.turns[0].key = 'nested-0';
      nestedPage.turns[0].finished = true;
      nestedPage.turns[0].relationships = [];
      nestedPage.turns[0].files = [{ path: 'nested.ts', added: 7, removed: 2, isNew: false, reason: null }];
      nested.pages = [await writer.spool(nestedPage)];
      model.sessions.push(nested);
      model.relationships.push({
        key: 'nested-link',
        from: 'child',
        to: 'nested',
        kind: 'subagent',
        ownership: 'delegated',
        requestedByReader: false,
        coverage: 'complete',
        turn: childPage.turns[0].key,
      });
      model.relationships[0].kind = 'dispatched';
      model.relationships[0].ownership = 'delegated';
      const unknown = costPartOf({
        role: 'main',
        model: 'unknown-model',
        provider: null,
        contextWindow: null,
        usage: { requests: 1, input: 1000, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, output: 2000, thinking: 0 },
      });
      child.numbers = {
        parts: [unknown],
        main: { dollars: null, partial: true },
        delegated: { dollars: null, partial: true },
        combined: { dollars: null, partial: true },
        coverage: { usage: 'partial', cost: 'unpriced' },
      };
      await projectSessionSite(model, writer, { script: '', stylesheet: '' });
      const { manifest, data } = exportedSiteData((await writer.publish(async () => {})).directory);
      const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
      const row = card.dispatched!.find((row) => row.sessionId === 'child')!;
      assert.equal(row.state, unfinished ? 'open' : 'done');
      assert.equal(
        row.figures.some((figure) => figure.metric === 'cost'),
        false,
      );
      assert.equal(
        row.figures.find((figure) => figure.metric === 'tokens')?.compactLabel,
        unfinished ? '3k+ tokens' : '3k tokens',
      );
      if (unfinished) {
        const footer = row.figures.find((figure) => figure.metric === 'tokens')?.record?.footer;
        assert.ok(Array.isArray(footer) && footer.length > 0);
      }
      const paths = row.figures.find((figure) => figure.metric === 'files')?.paths;
      if (unfinished) assert.equal(paths, undefined);
      else {
        assert.deepEqual(paths, ['child.ts', 'nested.ts']);
        assert.equal(row.figures.find((figure) => figure.metric === 'files')?.added, 10);
      }
      const missing = card.dispatched!.find((row) => !row.sessionId)!;
      assert.deepEqual(missing.figures, []);
      assert.match(missing.description, /missing/);
    } finally {
      await writer.dispose();
    }
  }
});

test('serialized compactions keep their timestamp and only recorded summaries', async () => {
  const writer = await ExportTransaction.create(tempDir('arc-site-compaction-'));
  try {
    const model = await sessionSiteFixture(writer);
    const page = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
    const at = model.capturedAt - 120_000;
    page.compactions = ['', 'Recorded carryover'].map((summary, index) =>
      projectCompaction(compaction({ at: at + index, summary }), `compact-${index}`),
    );
    model.sessions[0].pages[0] = await writer.spool(page);
    model.sessions[0].archived = true;
    model.sessions[1].agentRun = true;
    await projectSessionSite(model, writer, { script: '', stylesheet: '' });
    const { manifest, data } = exportedSiteData((await writer.publish(async () => {})).directory);
    const cards = [...data.values()].map((value) => (value as { card: CardView }).card);
    const empty = cards.find((card) => card.key === 'compact-0')!;
    const real = cards.find((card) => card.key === 'compact-1')!;
    assert.equal(empty.at, at);
    assert.equal(empty.relative, '2 mins ago');
    assert.equal(empty.summaryHtml, '');
    assert.equal(real.at, at + 1);
    assert.match(real.summaryHtml!, /Recorded carryover/);
    assert.equal(manifest.rail.find((row) => row.id === 'root')!.archived, true);
    assert.equal(manifest.rail.find((row) => row.id === 'child')!.agentRun, true);
    assert.deepEqual(
      railBuckets(manifest.rail, model.capturedAt).buckets.map((bucket) => bucket.id),
      ['agent', 'archived'],
    );
  } finally {
    await writer.dispose();
  }
});

test('captured Date retains constructor arity and local calendar boundaries', async () => {
  const host = await fs.readFile(path.join(__dirname, 'webview', 'export-host.ts'), 'utf8');
  const clock = host.slice(host.indexOf('const RealDate = Date;'), host.indexOf('const archived ='));
  const capturedAt = Date.parse('2026-11-02T18:00:00Z');
  const sandbox = { Date, window: { Date }, catalog: { capturedAt } };
  runInNewContext(clock, sandbox);
  const CapturedDate = sandbox.window.Date;
  assert.equal(new CapturedDate().getTime(), capturedAt);
  assert.equal(CapturedDate.now(), capturedAt);
  assert.equal(CapturedDate(), new Date(capturedAt).toString());
  const cases = [
    [undefined],
    [null],
    ['invalid'],
    [123],
    ['2026-10-09T12:00:00Z'],
    [new Date(123)],
    [2026, 9],
    [2026, 9, 9],
    [2026, 9, 9, undefined],
    [2026, 9, 9, 12, 34, 56, 789],
  ];
  for (const args of cases)
    assert.equal(Reflect.construct(CapturedDate, args).getTime(), Reflect.construct(Date, args).getTime());
  assert.equal(CapturedDate.parse('2026-10-09'), Date.parse('2026-10-09'));
  assert.equal(CapturedDate.UTC(2026, 9, 9), Date.UTC(2026, 9, 9));
  assert.ok(new CapturedDate(123) instanceof Date);
  for (const timezone of ['America/Chicago', 'Pacific/Auckland', 'UTC']) {
    const previous = process.env.TZ;
    try {
      process.env.TZ = timezone;
      const day = new Date(capturedAt);
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
      const yesterday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1).getTime();
      const rows = [start, start - 1, yesterday - 1, start - 12 * 86400_000].map((at) => ({
        at,
        archived: false,
        pinnedTop: false,
        current: false,
      }));
      const bucket = runInNewContext(`(${railBuckets.toString()})(rows, now)`, {
        Date: CapturedDate,
        rows,
        now: capturedAt,
      });
      assert.deepEqual(
        Array.from(bucket.buckets, (value: { id: string }) => value.id),
        ['today', 'yesterday', 'week', 'older'],
      );
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }
});

test('export site projection retains advisor origins in child cost and cache detail', () => {
  const advisor = {
    model: 'claude-sonnet-5-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usageOrigin: 'claude-advisor' as const,
    usage: { requests: 1, input: 44_807, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, output: 492, thinking: 0 },
  };
  const original = turn({
    agents: [subagent({ model: advisor.model, spend: [{ ...advisor, usageParts: [advisor] }] })],
  });
  const saved = projectTurn(original, 'turn', { cwd: '/project' }, [], 'root', new Map());
  saved.agents[0].spend = [costPartOf({ ...advisor, role: 'delegated' })];
  const restored = exportTurn(saved, 'claude', 'root');
  assert.equal(restored.agents[0].spend[0].usageParts?.[0].usageOrigin, 'claude-advisor');
  const originalCost = toCard(original, false, 1).chips.find((chip) => chip.metric === 'cost')!;
  const restoredCost = toCard(restored, false, 1).chips.find((chip) => chip.metric === 'cost')!;
  assert.equal(restoredCost.label, originalCost.label);
  assert.deepEqual(restoredCost.detailList, originalCost.detailList);
  assert.doesNotMatch(restoredCost.detail, /of input|avg input|Average input per request/);
});

test('exported turn cost parts retain recorded compactions across request bands', () => {
  const usage = { requests: 1, input: 1000, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, output: 0, thinking: 0 };
  const original = turn({
    agent: 'codex',
    usageParts: [
      {
        model: 'gpt-5.4',
        provider: 'openai',
        contextWindow: null,
        contextBand: null,
        inferenceClass: null,
        serviceTier: null,
        compactionUsage: true,
        usage: { ...usage, byContextBand: { short: usage } },
      },
    ],
  });
  const parts = costPartsOf(original.usageParts![0]);
  assert.equal(parts[0].compactionUsage, true);
  assert.equal(parts[0].estimated, false);
  const exported = projectTurn(original, 'recorded-turn', { cwd: '/project' }, [], 'session', new Map());
  assert.equal(exportTurn(exported, 'codex', 'session').usageParts![0].compactionUsage, true);
  delete exported.usageParts[0].compactionUsage;
  const legacy = exportTurn(exported, 'codex', 'session').usageParts![0];
  assert.equal(legacy.compactionUsage, undefined);
  assert.equal(legacy.compactionEstimate, undefined);
});

test('linked Claude usage parts retain exact dollars through exported turns', () => {
  const original = turn({
    agent: 'codex',
    usageParts: [
      {
        model: 'claude-opus-5',
        provider: null,
        contextWindow: 1_000_000,
        contextBand: null,
        inferenceClass: null,
        serviceTier: null,
        linkedInvocationId: 'printed-result',
        requestCountExact: false,
        usage: {
          requests: 1,
          input: 1_000_000,
          cacheRead: 0,
          cacheWrite1h: 0,
          cacheWrite5m: 0,
          output: 0,
          thinking: 0,
        },
      },
    ],
  });
  const exported = projectTurn(original, 'linked-turn', { cwd: '/project' }, [], 'session', new Map());
  const restored = exportTurn(exported, 'codex', 'session');
  assert.equal(restored.usageParts![0].requestCountExact, false);
  const cost = exportCard(toCard(restored, false, 1)).chips!.find((stat) => stat.metric === 'cost')!;
  assert.equal(cost.label, toCard(original, false, 1).chips.find((stat) => stat.metric === 'cost')!.label);
  assert.ok(!cost.label.endsWith('+'));
  assert.doesNotMatch(String(cost.detail), /usage.*incomplete|may be low/i);
  original.usageParts!.push({
    model: 'gpt-5.4',
    provider: 'openai',
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    incomplete: true,
    requestCountExact: false,
    usage: { requests: 1, input: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, output: 0, thinking: 0 },
  });
  const incomplete = projectTurn(original, 'incomplete-turn', { cwd: '/project' }, [], 'session', new Map());
  const partial = exportCard(toCard(exportTurn(incomplete, 'codex', 'session'), false, 1)).chips!.find(
    (stat) => stat.metric === 'cost',
  )!;
  assert.equal(partial.label, `${cost.label}+`);
  assert.match(String(partial.detail), /usage record incomplete/);
});

test('exported named response links retain labels without live session navigation', () => {
  const summary = '[Claude cache controls](arc-session:7390194c-8fea-4b6d-80be-e7e8c7684426)';
  const card = exportCard(toCard(turn({ summary }), false, 1));
  assert.match(card.summaryHtml ?? '', /Claude cache controls/);
  assert.doesNotMatch(card.summaryHtml ?? '', /arc-session:|<a|data-link/);
});

test('export citations preserve source bodies and identify every response surface without file actions', () => {
  const file = process.platform === 'win32' ? 'C:/outside/report%20.csv#L10' : '/outside/report%20.csv#L10';
  const source = `:codex-file-citation{path='${file}' purpose=output}`;
  const original = turn({
    summary: source,
    answers: [{ text: 'Earlier ' + source, at: 2, stepsBefore: 0 }],
    updates: [
      { sourceId: 'commentary', kind: 'commentary', text: source, at: 3, stepsBefore: 0, status: 'done' },
      { sourceId: 'reasoning', kind: 'reasoning', text: source, at: 4, stepsBefore: 0, status: 'done' },
    ],
  });
  const card = exportCard(toCard(original, false, 1));
  const surfaces = [
    card.summaryHtml,
    ...(card.earlierAnswers ?? []).map((answer) => answer.summaryHtml),
    ...(card.saidMessages ?? []).map((message) => message.summaryHtml),
    ...(card.activity ?? []).filter((row) => row.kind === 'message').map((row) => row.summaryHtml),
  ];
  assert.ok(surfaces.length >= 4);
  for (const html of surfaces) {
    assert.ok(html?.includes(`Output: ${file}`), html);
    assert.doesNotMatch(html ?? '', /<a|data-link|<button|codex-file-citation/);
  }
  assert.equal(card.summary, source);
  assert.equal(original.answers[0].text, 'Earlier ' + source);
  assert.equal(card.saidMessages!.find((message) => message.kind === 'commentary')!.text, source);
});

test('export cost details distinguish missing prices from missing usage', async () => {
  for (const role of ['main', 'delegated'] as const) {
    const directory = tempDir('arc-export-unpriced-usage-');
    const writer = await ExportTransaction.create(directory);
    try {
      const model = await sessionSiteFixture(writer);
      model.relationships = [];
      model.sessions[0].coverage.relationships = 'complete';
      const known = { ...demoSessionCostParts('arc-demo-review')[0], role, scopeId: 'child' };
      const unknown = { ...known, model: 'unlisted-model' };
      const total = sessionCostProjection([known, unknown]).total;
      model.sessions[0].numbers = {
        parts: [costPartOf(known, 'child'), costPartOf(unknown, 'child')],
        main: role === 'main' ? total : { dollars: 0, partial: false },
        delegated: role === 'delegated' ? total : { dollars: 0, partial: false },
        combined: total,
        coverage: { usage: 'complete', cost: 'partial' },
      };
      await projectSessionSite(model, writer, { script: '', stylesheet: '' });
      const result = await writer.publish(async () => {});
      const { manifest } = exportedSiteData(result.directory);
      const cost = manifest.stats.root.find((stat) => stat.metric === 'cost')! as unknown as SessionStatChip;
      assert.equal(cost.dollars, total.dollars);
      assert.equal(cost.partial, true);
      assert.match(cost.detail, /Some usage could not be priced/);
      assert.doesNotMatch(cost.detail, /(?:Main agent|Delegated work) usage is incomplete/);
      assert.match(cost.detail, /requests/);
    } finally {
      await writer.dispose();
    }
  }
});

test('export cost details qualify safe child usage when other child usage is missing', async () => {
  for (const identified of [true, false]) {
    const directory = tempDir('arc-export-missing-child-usage-');
    const writer = await ExportTransaction.create(directory);
    try {
      const model = await sessionSiteFixture(writer);
      model.relationships = [];
      model.sessions[0].coverage.relationships = 'complete';
      const safe = {
        ...demoSessionCostParts('arc-demo-review')[0],
        role: 'delegated' as const,
        scopeId: 'child',
        model: 'claude-opus-5-5',
        usage: {
          requests: 6,
          input: 0,
          cacheRead: 0,
          cacheWrite1h: 2_000_000,
          cacheWrite5m: 0,
          cacheWrite30m: 0,
          output: 300,
          thinking: 0,
        },
      };
      const total = sessionCostProjection([safe]).total;
      assert.ok(total.dollars! > 5);
      assert.ok(sessionCostProjection([safe]).stats[0].warnings?.length);
      model.sessions[0].numbers = {
        parts: [costPartOf(safe, 'child')],
        main: { dollars: 0, partial: false },
        delegated: { ...total, partial: true },
        combined: { ...total, partial: true },
        coverage: { usage: 'partial', cost: 'partial' },
      };
      model.sessions[1].numbers.coverage.usage = identified ? 'partial' : 'complete';
      await projectSessionSite(model, writer, { script: '', stylesheet: '' });
      const result = await writer.publish(async () => {});
      const { manifest } = exportedSiteData(result.directory);
      const cost = manifest.stats.root.find((stat) => stat.metric === 'cost')! as unknown as SessionStatChip;
      assert.equal(cost.dollars, total.dollars);
      assert.equal(cost.partial, true);
      assert.ok(cost.label.endsWith('+'));
      assert.equal(cost.warnings?.length ?? 0, 0);
      assert.doesNotMatch(cost.detail, /6 requests|avg input|Low cache reuse/);
      assert.match(cost.detail, /Delegated work usage is incomplete/);
    } finally {
      await writer.dispose();
    }
  }
});

test('export cost details retain missing main and unresolved child coverage beside an incomplete child', async () => {
  const directory = tempDir('arc-export-mixed-missing-usage-');
  const writer = await ExportTransaction.create(directory);
  try {
    const model = await sessionSiteFixture(writer);
    model.relationships = [];
    model.sessions[0].coverage.relationships = 'complete';
    const main = {
      ...demoSessionCostParts('arc-demo-review')[0],
      role: 'main' as const,
      model: 'claude-opus-5-5',
      usage: {
        requests: 6,
        input: 0,
        cacheRead: 0,
        cacheWrite1h: 2_000_000,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        output: 300,
        thinking: 0,
      },
    };
    const child = { ...main, role: 'delegated' as const, scopeId: 'child' };
    const unresolved = { ...child, scopeId: 'unresolved-child' };
    const parts = [main, child, unresolved];
    const total = sessionCostProjection(parts).total;
    assert.equal(sessionCostProjection(parts).stats[0].warnings?.length, 3);
    // Incomplete main buckets are omitted from captured parts.
    model.sessions[0].numbers = {
      parts: [costPartOf(main), costPartOf(child, 'child'), costPartOf(unresolved, 'unresolved-child')],
      main: { ...sessionCostProjection([main]).total, partial: true },
      delegated: { ...sessionCostProjection([child, unresolved]).total, partial: true },
      combined: { ...total, partial: true },
      coverage: { usage: 'partial', cost: 'partial' },
    };
    model.sessions[1].numbers.coverage.usage = 'partial';
    await projectSessionSite(model, writer, { script: '', stylesheet: '' });
    const result = await writer.publish(async () => {});
    const { manifest } = exportedSiteData(result.directory);
    const cost = manifest.stats.root.find((stat) => stat.metric === 'cost')! as unknown as SessionStatChip;
    assert.equal(cost.dollars, total.dollars);
    assert.equal(cost.partial, true);
    assert.ok(cost.label.endsWith('+'));
    assert.equal(cost.warnings?.length ?? 0, 0);
    assert.doesNotMatch(cost.detail, /6 requests|avg input|Low cache reuse/);
    assert.match(cost.detail, /Main agent usage is incomplete/);
    assert.match(cost.detail, /Delegated work usage is incomplete/);
  } finally {
    await writer.dispose();
  }
});

test('demo HTML downloads retain recorded files and incomplete delegated cost', async () => {
  const directory = tempDir('arc-demo-export-content-');
  await writeDemoExports(directory);
  for (const root of ['arc-read-state', 'delegated-cost', 'arc-demo-dispatch']) {
    const html = await fs.readFile(path.join(directory, `export-${root}.html`), 'utf8');
    await fs.writeFile(path.join(directory, 'index.html'), html);
    const { manifest, data } = exportedSiteData(directory);
    assert.equal(JSON.stringify([...data.values()]).includes('C:/sample/arc'), false);
    if (root === 'arc-demo-dispatch') {
      const numbers = manifest.sessions.find((session) => session.key === root)!.numbers;
      assert.ok(numbers.parts.every((part) => part.scope !== 'arc-demo-continuation'));
      continue;
    }
    const expected =
      root === 'arc-read-state'
        ? ([
            ['arc-sol-read-state', 'extension/src/webview/read-state.ts', 38, 12],
            ['arc-sol-read-state', 'extension/src/webview/session-state.ts', 21, 7],
            ['arc-luna-read-state-tests', 'extension/src/webview/read-state.test.ts', 44, 6],
          ] as const)
        : ([['delegated-cost', 'extension/src/turncard.ts', 28, 6]] as const);
    for (const [session, file, added, removed] of expected) {
      const page = manifest.sessions.find((item) => item.key === session)!.pages[0];
      const { card } = data.get(page.cards![0].id) as { card: CardView };
      const recorded = card.files!.find((item) => item.path === file);
      assert.ok(recorded, `${session} has no recorded ${file}`);
      assert.equal(recorded.added, added);
      assert.equal(recorded.removed, removed);
    }
    assert.ok(manifest.omissions.every((omission) => omission.reason !== 'external-path'));
    if (root === 'arc-read-state') {
      const numbers = manifest.sessions.find((session) => session.key === root)!.numbers;
      assert.ok(
        Math.abs(numbers.combined.dollars! - sessionCostProjection(demoSessionCostParts(root)).total.dollars!) < 1e-10,
      );
      assert.equal(numbers.main.partial, false);
      assert.equal(numbers.delegated.partial, true);
      assert.equal(numbers.combined.partial, true);
      assert.deepEqual(numbers.coverage, { usage: 'partial', cost: 'partial' });
      assert.ok(numbers.parts.some((part) => part.scope === 'arc-sol-read-state' && part.incomplete));
      const cost = manifest.stats[root].find((stat) => stat.metric === 'cost')! as unknown as SessionStatChip;
      assert.equal(
        cost.label,
        (demoPayload(root) as { stats: Record<string, { label: string; metric?: string }[]> }).stats[root].find(
          (stat) => stat.metric === 'cost',
        )!.label,
      );
      assert.ok(manifest.rail.find((session) => session.id === root)!.costAtLeast);
    }
  }
});

test('demo downloads retain production cost categories and compaction overhead', async () => {
  const directory = tempDir('arc-demo-export-cost-');
  await writeDemoExports(directory);
  for (const root of [
    'arc-read-state',
    'delegated-cost',
    'arc-demo-review',
    'arc-demo-continuation',
    'arc-sol-read-state',
  ]) {
    await fs.copyFile(path.join(directory, `export-${root}.html`), path.join(directory, 'index.html'));
    const { manifest, data } = exportedSiteData(directory);
    const session = manifest.sessions.find((session) => session.key === root)!;
    const cost = manifest.stats[root].find((stat) => stat.metric === 'cost')! as unknown as SessionStatChip;
    assert.ok(
      cost.detailList?.entries.some((entry) => entry.lines?.length),
      root,
    );
    const live = (demoPayload(root) as { stats: Record<string, SessionStatChip[]> }).stats[root].find(
      (stat) => stat.metric === 'cost',
    )!;
    assert.equal(cost.label, live.label);
    assert.equal(session.numbers.combined.dollars, live.dollars);
    assert.equal(cost.detailList!.heading!.value, live.label);
    assert.ok(cost.detail.startsWith(`Estimated total: ${live.label}`), cost.detail);
    for (const role of ['main', 'delegated'] as const) {
      const captured = session.numbers[role];
      const entry = cost.detailList!.entries.find((entry) =>
        entry.label.startsWith(role === 'main' ? 'Main agent' : 'Delegated work'),
      );
      if (entry) assert.equal(entry.value, `${formatCost(captured.dollars)}${captured.partial ? '+' : ''}`, root);
    }
    for (const child of manifest.sessions.filter((child) => child.key !== root)) {
      const expected = sessionCostProjection(demoSessionCostParts(child.key)).total;
      assert.equal(child.numbers.combined.dollars, expected.dollars, child.key);
      const retained = session.numbers.parts.filter((part) => part.scope === child.key);
      if (!retained.length) continue;
      const priced = sessionCostProjection(
        retained.map((part) => ({
          ...part,
          scopeId: part.scope ?? undefined,
          recordedCost: part.recordedCost ?? undefined,
          costBasis: part.costBasis ?? undefined,
          requestCountExact: part.requestCountExact ? undefined : (false as const),
          usage: {
            ...part.usage,
            requests: part.usage.requests ?? undefined,
            input: part.usage.input ?? 0,
            cacheRead: part.usage.cacheRead ?? 0,
            cacheWrite1h: part.usage.cacheWrite1h ?? 0,
            cacheWrite5m: part.usage.cacheWrite5m ?? 0,
            cacheWrite30m: part.usage.cacheWrite30m ?? 0,
            output: part.usage.output ?? 0,
            thinking: part.usage.thinking ?? 0,
          },
        })),
      ).total;
      assert.equal(priced.dollars, expected.dollars, child.key);
    }
    if (root === 'delegated-cost') {
      assert.deepEqual(session.numbers.coverage, { usage: 'complete', cost: 'complete' });
      assert.doesNotMatch(cost.detail, /usage is incomplete|cost unavailable/);
      assert.deepEqual(cost.detailList!.entries, live.detailList!.entries);
    }
    if (root === 'arc-sol-read-state') assert.ok(cost.partial);
    if (root !== 'arc-demo-continuation') continue;
    assert.equal(session.compactionCount, 1);
    const estimates = session.numbers.parts.filter((part) => part.estimated);
    assert.equal(estimates.length, 1);
    const estimate = demoSessionCostParts(root).find((part) => part.compactionEstimate)!;
    const amount = estimateCost(estimate.usage, estimate.model)!;
    assert.ok(amount > 0);
    assert.equal(
      cost.detailList!.entries.find((entry) => entry.label === '1 compaction')!.value,
      live.detailList!.entries.find((entry) => entry.label === '1 compaction')!.value,
    );
    assert.ok(cost.detailList!.footer?.length);
    assert.equal(DEMO_COMPACTIONS[root].length, 1);
    assert.ok(
      session.pages.some((page) =>
        page.cards?.some((ref) => (data.get(ref.id) as { card: CardView }).card.kind === 'compaction'),
      ),
    );
  }
});

test('portable projection retains every body beyond previews and removes post-builder action metadata', async () => {
  const directory = tempDir('arc-export-site-');
  const writer = await ExportTransaction.create(directory);
  const model = await sessionSiteFixture(writer);
  const assets = exportBrowserAssets();
  await projectSessionSite(model, writer, assets);
  const result = await writer.publish(async () => {});
  const { manifest, data } = exportedSiteData(result.directory);
  assert.equal((await fs.readdir(result.directory)).length, 2);
  assert.ok(manifest);
  assert.equal(manifest.sessions[0].pages.length, 2);
  assert.equal(manifest.sessions[0].pages[0].keys.length, 20);
  assert.equal(JSON.stringify(manifest.relationships), JSON.stringify(model.relationships));
  assert.equal(JSON.stringify(manifest.omissions), JSON.stringify(model.omissions));
  const cards = manifest.sessions[0].pages[0].cards!.map(
    (asset) => data.get(asset.id) as { card: CardView; blocks: ExportBlock[] },
  );
  assert.equal(cards[0].card.statusWord, 'Unfinished at capture');
  assert.equal(cards[0].card.fileCount, 1);
  assert.match(cards[0].card.dispatched![0].description, /Work is not included: missing/);
  assert.equal(cards[0].card.added, 5);
  assert.equal(cards[0].card.removed, 2);
  const blocks = cards[0].blocks;
  assert.equal(blocks.filter((block) => block.kind === 'prompt').length, 14);
  const answer = blocks.find((block) => block.kind === 'answer')!;
  assert.ok(answer.text.endsWith('![image](https://example.invalid/image)'));
  assert.ok(cards[0].card.summary.includes('final sentinel'));
  assert.equal(cards[0].card.laterPrompts?.length, 13);
  assert.equal(cards[0].card.saidMessages?.[0].text, 'Commentary 21');
  for (const html of [
    cards[0].card.summaryHtml,
    ...(cards[0].card.saidMessages ?? []).map((message) => message.summaryHtml),
  ])
    assert.doesNotMatch(html ?? '', /<(?:a|button|img|script|iframe)\b|data-(?:link|image|visualization)|on\w+=/i);
  const unsafe = {
    ...toCard(turn(), false, model.capturedAt),
    headlineHtml: '<a href="file:///private">x</a>',
    resume: '/private',
    activity: [{ title: '/private/raw-tool' }],
    chips: [{ kind: 'plain', label: '$1', detail: 'Numeric fact', detailList: { actions: true }, record: '/private' }],
  };
  const safe = exportCard(unsafe as unknown as ReturnType<typeof toCard>);
  assert.doesNotMatch(JSON.stringify(safe), /private|"record"|headlineHtml|resume/);
  await writer.dispose();
});

test('script JSON preserves literal content', () => {
  const text = '</script><img src=x onerror=alert(1)>\u2028\u2029' + '\u{1f642}\u{1f680}\u20ac'.repeat(20000);
  assert.doesNotMatch(exportScriptJson(text), /<|\u2028|\u2029/);
  assert.equal(JSON.parse(exportScriptJson(text)), text);
});

test('projection cancellation stops before publication and removes its staging assets', async () => {
  const directory = tempDir('arc-export-cancel-');
  const controller = new AbortController();
  const writer = await ExportTransaction.create(directory, controller.signal);
  const model = await sessionSiteFixture(writer);
  const original = writer.readSpool.bind(writer);
  let writes = 0;
  writer.readSpool = async <T>(...args: Parameters<typeof writer.readSpool>) => {
    const result = await original(...args);
    if (++writes === 3) controller.abort();
    return result as T;
  };
  await assert.rejects(projectSessionSite(model, writer, { script: '', stylesheet: '' }), ExportCancelled);
  await writer.dispose();
  assert.deepEqual(await fs.readdir(directory), []);
});

test('static bundle uses the production panel entry and an exhaustive local host policy', () => {
  const assets = exportBrowserAssets();
  for (const owner of ['main.ts', 'bootstrap.ts', 'panel.ts', 'export-host.ts'])
    assert.ok(
      assets.inputs.some((file) => file.endsWith(path.join('webview', owner))),
      owner,
    );
  assert.ok(!assets.inputs.some((file) => file.endsWith(path.join('webview', 'export-main.ts'))));
});

test('recorded opening prompts remain complete and later non-response answers cannot replace the response', async () => {
  const writer = await ExportTransaction.create(tempDir('arc-site-response-'));
  try {
    const model = await sessionSiteFixture(writer);
    const page = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
    const value = page.turns[0];
    value.blocks = [
      {
        key: 'p1',
        kind: 'prompt',
        text: 'opening '.repeat(8000),
        at: 1,
        sourceOrder: 0,
        opening: true,
        notResponse: null,
      },
      { key: 'p2', kind: 'prompt', text: 'second opening', at: 1, sourceOrder: 1, opening: true, notResponse: null },
      { key: 'a1', kind: 'answer', text: 'response '.repeat(10000), at: 2, sourceOrder: 2, notResponse: null },
      {
        key: 'a2',
        kind: 'answer',
        text: 'interrupted answer',
        at: 3,
        sourceOrder: 3,
        notResponse: 'no-response-requested',
      },
    ];
    const projected = exportTurn(value, 'codex', 'root');
    assert.equal(projected.prompt, value.blocks[0].text + '\n\nsecond opening');
    assert.equal(projected.summary, value.blocks[2].text);
    assert.deepEqual(
      projected.answers.map((answer) => answer.sourceOrder),
      [2, 3],
    );
    assert.equal(projected.answers[1].notResponse, 'no-response-requested');
    const card = exportCard(toCard(projected, false, model.capturedAt));
    assert.equal(card.prompt, projected.prompt);
    assert.equal(card.summary, projected.summary);
  } finally {
    await writer.dispose();
  }
});

test('readable exported facts preserve literal source values that match classification names', () => {
  for (const key of ['title', 'model', 'subject', 'description', 'scope', 'path', 'sha256', 'error']) {
    for (const value of ['main', 'partial', 'recorded', 'missing', 'reader-started'])
      assert.equal(exportFactValue(key, value), value);
  }
  assert.equal(exportFactValue('role', 'main'), 'Main agent');
  assert.equal(exportFactValue('ownership', 'navigation'), 'Navigation only, no delegated cost');
  assert.equal(exportFactValue('origin', 'claude-advisor'), 'claude-advisor');
  assert.match(exportFactValue('dollars', 1.23456789), /1\.23456789 USD/);
});

test('one admitted large card keeps its full text on a separate decoded page', async () => {
  const writer = await ExportTransaction.create(tempDir('arc-site-large-'));
  try {
    const model = await sessionSiteFixture(writer);
    const page = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
    const answer = page.turns[0].blocks.find((block) => block.kind === 'answer')!;
    const commentary = page.turns[0].blocks.find((block) => block.kind === 'commentary')!;
    answer.text = 'x'.repeat(4 * 1024 * 1024) + 'answer end';
    commentary.text = 'y'.repeat(4 * 1024 * 1024) + 'commentary end';
    assert.ok(
      page.turns[0].blocks.reduce((bytes, block) => bytes + Buffer.byteLength(block.text), 0) < EXPORT_LIMITS.turnBytes,
    );
    model.sessions[0].pages = [await writer.spool(page), model.sessions[0].pages[1]];
    model.sessions = [model.sessions[0]];
    await projectSessionSite(model, writer, { script: '', stylesheet: '' });
    const { directory } = await writer.publish(async () => {});
    const { manifest, data } = exportedSiteData(directory);
    const first = manifest.sessions[0].pages[0];
    assert.equal(first.cards!.length, 1);
    assert.ok(first.bytes > EXPORT_LIMITS.retainedBytes);
    assert.equal(manifest.sessions[0].pages.length, 2);
    const retained = data.get(first.cards![0].id) as { card: CardView; blocks: ExportBlock[] };
    assert.equal(retained.card.summary, answer.text);
    assert.equal(retained.card.saidMessages![0].text, commentary.text);
  } finally {
    await writer.dispose();
  }
});

test('matched native agent rows retain completion and figures with missing or ambiguous child qualifications', async () => {
  for (const reason of ['missing', 'ambiguous', 'unreadable', 'conflicting'] as const) {
    const writer = await ExportTransaction.create(tempDir('arc-site-child-'));
    try {
      const model = await sessionSiteFixture(writer);
      const page = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
      const value = page.turns[0];
      value.agents = [
        {
          key: 'tool-use-launch',
          relationships: ['missing-link'],
          description: 'Native task',
          agentType: null,
          model: 'claude-sonnet-4-5',
          effort: 'high',
          status: 'completed',
          startedAt: 1,
          durationMs: 1000,
          tokens: 30,
          toolUses: 2,
          partial: false,
        },
      ];
      const expected = exportCard(toCard(exportTurn(value, 'claude', 'root'), false, model.capturedAt)).agents![0];
      model.relationships[1] = { ...model.relationships[1], kind: 'subagent', reason };
      model.sessions[0].pages[0] = await writer.spool(page);
      await projectSessionSite(model, writer, { script: '', stylesheet: '' });
      const { directory } = await writer.publish(async () => {});
      const { manifest, data } = exportedSiteData(directory);
      const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
      assert.equal(card.agents!.length, 2);
      const native = card.agents![0];
      assert.equal(native.description, expected.description);
      assert.equal(native.state, expected.state);
      assert.equal(native.stateWord, expected.stateWord);
      assert.deepEqual(native.figures, JSON.parse(JSON.stringify(expected.figures)));
      assert.equal(native.sessionId, null);
      assert.ok(native.hintDetail?.includes(`Work is not included: ${reason}.`));
    } finally {
      await writer.dispose();
    }
  }
});
