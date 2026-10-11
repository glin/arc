import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { EXPORT_LIMITS } from './exportlimits';
import { ExportTransaction, ExportCancelled } from './exportwriter';
import { exportCard, exportTurn, exportScriptJson, projectSessionSite } from './exportsite';
import { type SessionStatChip, toCard } from './turncard';
import { turn, subagent, compaction, sessionSiteFixture, exportedSiteData } from './turnfixtures';
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
  assert.doesNotMatch(JSON.stringify(safe), /private|detailList|"record"|headlineHtml|resume/);
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
