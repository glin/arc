import { test } from 'vitest';
import assert from 'node:assert/strict';
import { cacheWriteWarnings, sessionCostProjection, waitShareWarnings } from './turncard.ts';
import type { CacheWriteScope, SessionCostUsage, StatDetailLine } from './turncard.ts';
import { emptyUsage } from './agentspend.ts';
import type { TurnUsage } from './transcript.ts';

import { cacheHitPercent, formatCost } from './pricing.ts';

const counts = (over: Partial<TurnUsage> = {}): TurnUsage => ({ ...emptyUsage(), ...over });

const part = (over: Partial<SessionCostUsage> = {}): SessionCostUsage => ({
  model: 'claude-sonnet-5',
  provider: null,
  contextWindow: null,
  usage: counts({ requests: 5, cacheWrite1h: 2_000_000 }),
  ...over,
});
const main = (...parts: SessionCostUsage[]): CacheWriteScope => ({ scope: 'main', parts });
const flagged = (usage: Parameters<typeof counts>[0]) => cacheWriteWarnings([main(part({ usage: counts(usage) }))]);
const allLines = (lines: readonly StatDetailLine[]): StatDetailLine[] =>
  lines.flatMap((line) => [line, ...(typeof line === 'object' && 'text' in line ? allLines(line.lines ?? []) : [])]);

test('cache-write warning requires five requests, a majority of input, and more than five dollars', () => {
  assert.equal(flagged({ requests: 4, cacheWrite1h: 2_000_000 }).length, 0);
  assert.equal(flagged({ requests: 5, cacheWrite1h: 2_000_000 }).length, 1);
  assert.equal(flagged({ requests: 5, cacheWrite1h: 2_000_000, cacheRead: 2_000_000 }).length, 0);
  assert.equal(flagged({ requests: 5, cacheWrite1h: 2_000_001, cacheRead: 2_000_000 }).length, 1);
  assert.equal(flagged({ requests: 5, cacheWrite1h: 1_250_000 }).length, 0);
  assert.equal(flagged({ requests: 5, cacheWrite1h: 1_250_001 }).length, 1);
  assert.equal(flagged({ requests: 100, cacheWrite1h: 1_000 }).length, 0);
});

test('cache-write warning suppresses incomplete, unpriced, and unsplittable usage', () => {
  for (const value of [
    part({ incomplete: true }),
    part({ model: 'unknown' }),
    part({ costBasis: 'list', recordedCost: 10 }),
    part({ unclassifiedCacheWrite: 100 }),
    part({ serviceTier: 'priority' }),
    part({ usage: counts({ requests: 5, cacheWrite30m: 2_000_000 }) }),
    part({ usage: { ...counts({ cacheWrite1h: 2_000_000 }), requests: undefined } }),
  ]) {
    assert.deepEqual(cacheWriteWarnings([main(value)]), []);
  }
  assert.deepEqual(cacheWriteWarnings([{ ...main(part()), incomplete: true }]), []);
  assert.deepEqual(cacheWriteWarnings([main()]), []);
});

test('cache-write scopes never pool requests, token shares, or dollars', () => {
  const expensive = main(part());
  const reads = part({ usage: counts({ requests: 100, cacheRead: 20_000_000 }) });
  const delegated: CacheWriteScope = { scope: 'delegated', id: 'child', parts: [part()] };
  const baseline = cacheWriteWarnings([expensive])[0];
  assert.deepEqual(cacheWriteWarnings([expensive, { ...delegated, parts: [reads] }]), [baseline]);
  assert.deepEqual(cacheWriteWarnings([main(reads), delegated]), cacheWriteWarnings([delegated]));
  assert.deepEqual(
    cacheWriteWarnings([delegated, expensive]).map((warning) => warning.scope),
    ['main', 'delegated'],
  );
  assert.deepEqual(
    cacheWriteWarnings(
      Array.from({ length: 12 }, (_, id) => ({
        scope: 'delegated',
        id: String(id),
        parts: [part({ usage: counts({ requests: 1, cacheWrite1h: 2_000_000 }) })],
      })),
    ),
    [],
  );
});

test('output and thinking do not change either input share', () => {
  const usage = { requests: 5, cacheWrite1h: 2_000_000, cacheRead: 100_000 };
  const plain = flagged(usage)[0];
  const output = flagged({ ...usage, output: 3_000_000, thinking: 2_000_000 })[0];
  assert.equal(output.cacheWriteShare, plain.cacheWriteShare);
  assert.equal(output.cachedInputShare, plain.cachedInputShare);
  assert.equal(output.cachedInputPercent, plain.cachedInputPercent);
  assert.equal(output.cacheWriteCost, plain.cacheWriteCost);
  assert.ok(Math.abs(output.scopeCost - plain.scopeCost - 30) < 1e-10);
});

test('each usage part retains its provider, model, band, inference class, tier, and cache lifetime', () => {
  const warning = cacheWriteWarnings([
    main(
      part({
        usage: counts({ requests: 5, cacheWrite1h: 1_000_000 }),
        inferenceClass: 'in-region',
        serviceTier: 'standard',
      }),
      part({ model: 'claude-haiku-4-5', usage: counts({ requests: 5, cacheWrite5m: 1_000_000 }) }),
      part({
        model: 'gpt-5.6-sol',
        provider: 'openai',
        contextBand: 'long',
        serviceTier: 'default',
        usage: counts({ requests: 5, cacheWrite30m: 1_000_000 }),
      }),
      part({
        model: 'openai.gpt-5.6-sol',
        provider: 'amazon-bedrock',
        contextBand: 'short',
        usage: counts({ requests: 5, cacheWrite30m: 1_000_000 }),
      }),
    ),
  ])[0];
  assert.equal(warning.requests, 20);
  assert.equal(warning.cacheWriteCost, 4.4 + 1.25 + 10 + 5.5);
  assert.equal(warning.scopeCost, warning.cacheWriteCost);
});

test('post-fix Bedrock controls remain below the write-share boundary even with high cost and enough requests', () => {
  for (const [cacheWrite30m, cacheRead] of [
    [113_694, 362_506],
    [181_169, 1_109_820],
    [106_068, 1_378_394],
  ]) {
    assert.ok(cacheWrite30m / (cacheWrite30m + cacheRead) < 0.5);
    for (const scale of [1, 100]) {
      assert.deepEqual(
        cacheWriteWarnings([
          main(
            part({
              model: 'openai.gpt-5.6-sol',
              provider: 'amazon-bedrock',
              contextBand: 'short',
              usage: counts({ requests: 5, cacheWrite30m: cacheWrite30m * scale, cacheRead: cacheRead * scale }),
            }),
          ),
        ]),
        [],
      );
    }
  }
});

test('aggregate Bedrock usage without request bands cannot establish a priced warning', () => {
  const usage = counts({
    requests: 600,
    input: 1_494,
    cacheWrite30m: 91_406_802,
    cacheRead: 3_156_715,
    output: 174_010,
    thinking: 62_693,
  });
  assert.equal(cacheHitPercent(usage), 3);
  const incident = part({ model: 'openai.gpt-5.6-sol', provider: 'amazon-bedrock', usage });
  assert.deepEqual(cacheWriteWarnings([main(incident)]), []);
  const shortBand = cacheWriteWarnings([main({ ...incident, contextBand: 'short' })])[0];
  assert.equal(formatCost(shortBand.cacheWriteCost), '$503');
  assert.equal(formatCost(shortBand.scopeCost), '$508');
});

test('whole-session cost metadata nests warnings under their owning scopes even when subagents share a model', () => {
  const writeHeavy = counts({ requests: 5, cacheWrite1h: 2_000_000, cacheRead: 100_000 });
  const projection = sessionCostProjection([
    part({ role: 'main', usage: writeHeavy }),
    part({ role: 'delegated', scopeId: 'child-a', usage: writeHeavy }),
    part({ role: 'delegated', scopeId: 'child-b', usage: counts({ requests: 4, cacheWrite1h: 2_000_000 }) }),
  ]);
  const chip = projection.stats[0];
  assert.deepEqual(
    chip.warnings?.map((warning) => [warning.scope, 'id' in warning ? warning.id : undefined]),
    [
      ['main', undefined],
      ['delegated', 'child-a'],
    ],
  );
  const entries = chip.detailList!.entries;
  assert.equal(entries.length, 3);
  assert.equal(entries[0].label, 'Main agent · sonnet-5');
  assert.match(entries[1].label, /^Subagent 1/);
  assert.match(entries[2].label, /^Subagent 2/);
  assert.deepEqual(entries[0].lines?.[0], {
    text: 'Low cache reuse in this session: $8.00 of $8.02 went to cache writes',
    warning: true,
  });
  assert.deepEqual(entries[1].lines?.[0], {
    text: 'Low cache reuse in delegated work: $8.00 of $8.02 went to cache writes',
    warning: true,
  });
  assert.equal(
    entries[2].lines?.some((line) => typeof line === 'object' && 'warning' in line),
    false,
  );
  assert.equal((chip.name ?? '').match(/Low cache reuse in this session/g)?.length, 1);
  assert.equal((chip.name ?? '').match(/Low cache reuse in delegated work/g)?.length, 1);
  assert.equal(
    entries.some((entry) => entry.warning),
    false,
  );
  // The tabbed popover names no child, so a delegated warning names its own child.
  const named = sessionCostProjection([
    part({ role: 'main', usage: writeHeavy }),
    part({ role: 'delegated', scopeId: 'child-a', usage: writeHeavy, agentName: 'explorer' }),
    part({ role: 'delegated', scopeId: 'child-b', usage: counts({ requests: 4, cacheWrite1h: 2_000_000 }) }),
  ]).stats[0].detailList!.cost!;
  assert.deepEqual(
    named.warnings.map((warning) => warning.text),
    [
      'Low cache reuse in this session: $8.00 of $8.02 went to cache writes',
      'explorer: Low cache reuse in delegated work: $8.00 of $8.02 went to cache writes',
    ],
  );
  assert.deepEqual(
    named.tabs[0].parts[1].rows.map((row) => [row.label, row.count]),
    [['Sonnet 5', '2 agents']],
  );
});

test('short delegated scopes do not become eligible when their indexed costs share a model', () => {
  const projection = sessionCostProjection([
    part({ role: 'delegated', scopeId: 'child-a', usage: counts({ requests: 3, cacheWrite1h: 2_000_000 }) }),
    part({ role: 'delegated', scopeId: 'child-b', usage: counts({ requests: 3, cacheWrite1h: 2_000_000 }) }),
  ]);
  assert.equal(projection.stats[0].warnings, undefined);
  assert.equal(
    projection.stats[0].detailList?.entries.some((entry) => entry.warning),
    false,
  );
  const unidentified = sessionCostProjection([
    part({ role: 'delegated', usage: counts({ requests: 3, cacheWrite1h: 2_000_000 }) }),
    part({ role: 'delegated', usage: counts({ requests: 3, cacheWrite1h: 2_000_000 }) }),
  ]);
  assert.equal(unidentified.stats[0].warnings, undefined);
});

test('the corrected incident stays silent without request bands and renders its accepted figures with them', () => {
  const usage = counts({
    requests: 594,
    input: 1_494,
    cacheWrite30m: 91_406_802,
    cacheRead: 3_156_715,
    output: 174_010,
    thinking: 62_693,
  });
  const incident = part({ role: 'main', model: 'openai.gpt-5.6-sol', provider: 'amazon-bedrock', usage });
  assert.deepEqual(sessionCostProjection([incident]).stats, []);
  const chip = sessionCostProjection([{ ...incident, contextBand: 'short' }]).stats[0];
  assert.deepEqual(chip.detailList?.entries[0].lines?.[0], {
    text: 'Low cache reuse in this session: $503 of $508 went to cache writes',
    warning: true,
  });
});

test('routine cache rates use each scope input totals and leave short or unknown usage uncolored', () => {
  for (const [requests, cacheRead, input, percent, warning, average] of [
    [5, 790000, 210000, 79, true, 200000],
    [5, 800000, 200000, 80, false, 200000],
    [4, 500000, 500000, 50, false, 250000],
    [5, 0, 100, 0, false, 20],
  ] as const) {
    const chip = sessionCostProjection([part({ role: 'main', usage: counts({ requests, cacheRead, input }) })])
      .stats[0];
    const line = allLines(chip.detailList!.entries[0].lines!).find(
      (held) => typeof held === 'object' && 'cacheHit' in held,
    );
    const hit = typeof line === 'object' && 'cacheHit' in line ? line.cacheHit : undefined;
    assert.deepEqual(hit, { percent, warning, requestScale: [requests, average] });
    assert.equal(chip.warnings, undefined);
  }
  const chip = sessionCostProjection([
    part({ role: 'main', usage: counts({ requests: 100, cacheRead: 900, input: 100 }) }),
    part({ role: 'delegated', usage: counts({ requests: 5, cacheRead: 10, input: 90 }) }),
  ]).stats[0];
  assert.match(chip.detail, /90% cached/);
  const delegated = chip.detailList!.entries[1].lines![0];
  assert.deepEqual(delegated, {
    text: 'sonnet-5 · provider not recorded: <$0.01',
    cacheHit: { percent: 10, warning: false, requestScale: [5, 20] },
  });
  const incomplete = sessionCostProjection([
    part({ incomplete: true, usage: counts({ requests: 5, cacheRead: 10, input: 90 }) }),
  ]).stats[0];
  assert.doesNotMatch(incomplete.detail, /% cached/);
});

test('cache-rate color requires material priced input within its own scope', () => {
  const rate = (parts: SessionCostUsage[]) => {
    const chip = sessionCostProjection(parts).stats[0];
    return allLines(chip.detailList!.entries.flatMap((entry) => entry.lines ?? []))
      .filter((line) => typeof line === 'object' && 'cacheHit' in line)
      .map((line) => (line as { cacheHit: { warning: boolean } }).cacheHit.warning);
  };
  const scope = (input: number, output = 0) => part({ usage: counts({ requests: 5, input, output }) });
  // Sonnet input is $2 per million in this repository's current price table.
  assert.deepEqual(rate([scope(249999)]), [false]);
  assert.deepEqual(rate([scope(250000)]), [true]);
  assert.deepEqual(rate([scope(100, 1000000)]), [false]);
  assert.deepEqual(rate([{ ...scope(250000), costBasis: 'list', recordedCost: 20, role: 'delegated' }]), [false]);
  assert.deepEqual(
    rate([
      { ...scope(100), role: 'delegated' },
      { ...scope(1000000), role: 'main' },
    ]),
    [true, false],
  );
  assert.deepEqual(rate([scope(250000), { ...scope(100), serviceTier: 'priority' }]), []);
});

test('same-model delegated scopes cannot pool input cost or requests into a warning', () => {
  const flags = (parts: SessionCostUsage[]) =>
    allLines(sessionCostProjection(parts).stats[0].detailList!.entries.flatMap((entry) => entry.lines ?? []))
      .filter((line) => typeof line === 'object' && 'cacheHit' in line)
      .map((line) => (line as { cacheHit: { warning: boolean } }).cacheHit.warning);
  const child = (scopeId: string | undefined, input: number, requests = 5) =>
    part({
      role: 'delegated',
      scopeId,
      usage: counts({ input, requests }),
    });
  assert.deepEqual(flags([child('a', 200000), child('b', 200000)]), [false]);
  assert.deepEqual(flags([child('a', 300000, 3), child('b', 300000, 3)]), [false]);
  assert.deepEqual(flags([child('a', 250000), child('b', 100)]), [true]);
  assert.deepEqual(flags([child(undefined, 500000)]), [false]);
});

test('cache-write warning leaves advisor consultations out of its shares', () => {
  // Advisor consultations can record cache reads and writes outside executor cache figures.
  const advisor = part({
    model: 'claude-opus-5',
    usageOrigin: 'claude-advisor',
    usage: counts({ requests: 5, input: 3_000_000, output: 20_000 }),
  });
  const baseline = cacheWriteWarnings([main(part())]);
  assert.equal(baseline.length, 1);
  assert.deepEqual(cacheWriteWarnings([main(part(), advisor)]), baseline);
});

// claude-sonnet-5 input costs $2 per million tokens, so these fixtures price in whole dollars.
const waited = (requests: number, input: number, timedOut = 0) => ({
  requests,
  timedOut,
  usage: counts({ requests, input }),
});

test('wait-share warning requires five waits, one dollar, and a fifth of the main agent cost', () => {
  const flaggedWaits = (waits: ReturnType<typeof waited>, mainInput: number) =>
    waitShareWarnings(main(part({ role: 'main', usage: counts({ requests: 20, input: mainInput }), waits })));
  assert.equal(flaggedWaits(waited(4, 1_000_000), 2_000_000).length, 0);
  assert.deepEqual(flaggedWaits(waited(5, 1_000_000, 3), 2_000_000), [
    { scope: 'wait', requests: 5, timedOut: 3, waitCost: 2, mainCost: 4, share: 0.5 },
  ]);
  assert.equal(flaggedWaits(waited(5, 495_000), 1_000_000).length, 0);
  assert.equal(flaggedWaits(waited(5, 500_000), 1_000_000).length, 1);
  assert.equal(flaggedWaits(waited(5, 1_000_000), 5_100_000).length, 0);
  assert.equal(flaggedWaits(waited(5, 1_000_000), 5_000_000).length, 1);
});

test('delegated work does not dilute the wait-share warning on the session cost figure', () => {
  // The waits are a fifth of the main agent's cost and a tenth of the whole session's cost.
  const owner = part({ role: 'main', usage: counts({ requests: 20, input: 5_000_000 }), waits: waited(5, 1_000_000) });
  const child = part({ role: 'delegated', scopeId: 'child', usage: counts({ requests: 1, input: 5_000_000 }) });
  const chip = sessionCostProjection([owner, child]).stats[0];
  assert.equal(chip.label, '$20');
  assert.deepEqual(
    chip.warnings?.map((warning) => warning.scope),
    ['wait'],
  );
  assert.deepEqual(chip.detailList!.entries[0].lines?.[0], {
    text: "Waiting on subagents took 20% of the main agent's cost: $2.00 of $10 went to 5 waits, 0 of them timed out",
    warning: true,
  });
});

test('wait-share warning stays silent unless the main scope is complete and priced', () => {
  const owner = part({ role: 'main', usage: counts({ requests: 20, input: 2_000_000 }), waits: waited(5, 1_000_000) });
  assert.equal(waitShareWarnings(main(owner)).length, 1);
  assert.deepEqual(waitShareWarnings({ ...main(owner), incomplete: true }), []);
  assert.deepEqual(waitShareWarnings(main({ ...owner, incomplete: true })), []);
  assert.deepEqual(waitShareWarnings(main(owner, part({ role: 'main', model: 'unknown' }))), []);
  assert.deepEqual(waitShareWarnings(main()), []);
  const unsplit = sessionCostProjection([owner], { main: true, delegated: false, delegatedScopeIds: new Set() })
    .stats[0];
  assert.equal(unsplit.warnings, undefined);
});

test('unpriced or incomplete delegated work keeps the wait-share warning on a partial session cost', () => {
  const owner = part({ role: 'main', usage: counts({ requests: 20, input: 2_000_000 }), waits: waited(5, 1_000_000) });
  const child = part({ role: 'delegated', scopeId: 'child', usage: counts({ requests: 1, input: 1_000_000 }) });
  const sentence =
    "Waiting on subagents took 50% of the main agent's cost: $2.00 of $4.00 went to 5 waits, 0 of them timed out";
  for (const projection of [
    sessionCostProjection([owner, { ...child, model: 'unknown' }]),
    sessionCostProjection([owner, child], { main: false, delegated: true, delegatedScopeIds: new Set(['child']) }),
  ]) {
    const chip = projection.stats[0];
    assert.equal(projection.total.partial, true);
    assert.match(chip.label, /\+$/);
    assert.deepEqual(
      chip.warnings?.map((warning) => warning.scope),
      ['wait'],
    );
    assert.deepEqual(chip.detailList!.entries[0].lines?.[0], { text: sentence, warning: true });
  }
  // Each delegated model row keeps the state the Delegated heading shows: unavailable, or a lower bound.
  const rows = (projection: ReturnType<typeof sessionCostProjection>) => {
    const cost = projection.stats[0].detailList!.cost!;
    const models = cost.tabs[0].parts[1].rows;
    return [cost.sections[1]?.value, ...models.map((row) => [row.value, row.percent, row.share, row.title])];
  };
  assert.deepEqual(rows(sessionCostProjection([owner, { ...child, model: 'unknown' }])), [
    'cost unavailable',
    ['cost unavailable', '', 0, 'unknown, 1 agent. Cost unavailable.'],
  ]);
  assert.deepEqual(
    rows(
      sessionCostProjection([owner, child], { main: false, delegated: true, delegatedScopeIds: new Set(['child']) }),
    ),
    ['$2.00+', ['$2.00+', '100%', 1, 'claude-sonnet-5, 1 agent. At least $2.00, 100% of delegated work.']],
  );
});

test('the wait-share line sits under the main agent entry after the cache line and signs the figure', () => {
  const writeHeavy = counts({ requests: 5, cacheWrite1h: 2_000_000, cacheRead: 100_000 });
  const waits = { requests: 5, timedOut: 2, usage: counts({ requests: 5, cacheWrite1h: 1_000_000 }) };
  const plain = sessionCostProjection([part({ role: 'main', usage: writeHeavy })]).stats[0];
  const chip = sessionCostProjection([part({ role: 'main', usage: writeHeavy, waits })]).stats[0];
  const entry = chip.detailList!.entries[0];
  assert.equal(entry.label, 'Main agent · sonnet-5');
  assert.deepEqual(entry.lines?.slice(0, 2), [
    { text: 'Low cache reuse in this session: $8.00 of $8.02 went to cache writes', warning: true },
    {
      text: "Waiting on subagents took 50% of the main agent's cost: $4.00 of $8.02 went to 5 waits, 2 of them timed out",
      warning: true,
    },
  ]);
  assert.deepEqual(entry.lines?.slice(2), plain.detailList!.entries[0].lines?.slice(1));
  // The figure keeps its label and adds the wait warning. Its accessible name reads the detail, line included.
  assert.equal(chip.label, plain.label);
  assert.deepEqual(
    chip.warnings?.map((warning) => warning.scope),
    ['main', 'wait'],
  );
  assert.ok(chip.name?.includes('Waiting on subagents took 50%'));
  const alone = sessionCostProjection([
    part({ role: 'main', usage: counts({ requests: 20, input: 2_000_000 }), waits: waited(5, 1_000_000, 1) }),
  ]).stats[0];
  assert.equal(alone.detailList!.entries[0].label, 'Cost by usage · sonnet-5');
  assert.deepEqual(alone.detailList!.entries[0].lines?.[0], {
    text: "Waiting on subagents took 50% of the main agent's cost: $2.00 of $4.00 went to 5 waits, 1 of them timed out",
    warning: true,
  });
  assert.deepEqual(
    alone.warnings?.map((warning) => warning.scope),
    ['wait'],
  );
  assert.equal(alone.headDetail, true);
  assert.ok(alone.name?.includes('Waiting on subagents took 50%'));
  const under = sessionCostProjection([
    part({ role: 'main', usage: counts({ requests: 20, input: 2_000_000 }), waits: waited(4, 1_000_000) }),
  ]).stats[0];
  assert.equal(under.warnings, undefined);
  assert.equal(under.name, undefined);
});

test('a wait-share line without a cache warning keeps the delegated work entry', () => {
  const owner = part({ role: 'main', usage: counts({ requests: 20, input: 2_000_000 }), waits: waited(5, 1_000_000) });
  const child = part({ role: 'delegated', scopeId: 'child', usage: counts({ requests: 1, input: 1_000_000 }) });
  const entries = sessionCostProjection([owner, child]).stats[0].detailList!.entries;
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ['Main agent · sonnet-5', 'Delegated work'],
  );
  assert.deepEqual(entries[0].lines?.[0], {
    text: "Waiting on subagents took 50% of the main agent's cost: $2.00 of $4.00 went to 5 waits, 0 of them timed out",
    warning: true,
  });
});

test('without a cache warning, the wait-share line is the only change to the session cost detail', () => {
  const owner = part({ role: 'main', usage: counts({ requests: 20, input: 2_000_000 }) });
  const waits = waited(5, 1_000_000);
  const child = part({ role: 'delegated', scopeId: 'child', usage: counts({ requests: 1, input: 1_000_000 }) });
  const review = part({
    role: 'delegated',
    model: 'codex-auto-review',
    provider: 'openai',
    usage: counts({ requests: 1, input: 200_000 }),
  });
  const isWaitLine = (line: StatDetailLine) =>
    typeof line === 'object' && 'text' in line && line.text.startsWith('Waiting on subagents');
  for (const others of [[], [child], [review], [{ ...child, scopeId: undefined }]]) {
    const plain = sessionCostProjection([owner, ...others]).stats[0].detailList!;
    const waited = sessionCostProjection([{ ...owner, waits }, ...others]).stats[0].detailList!;
    assert.equal(waited.entries.flatMap((entry) => allLines(entry.lines ?? [])).filter(isWaitLine).length, 1);
    assert.ok(waited.entries[0].lines?.some(isWaitLine));
    // The tabbed form adds the warning line and a Tools tab. The flat entries change only by the line.
    const { cost: waitedCost, ...waitedFlat } = waited;
    const { cost: _plainCost, ...plainFlat } = plain;
    assert.ok(waitedCost?.warnings.some((warning) => warning.text.startsWith('Waiting on subagents')));
    const stripped = {
      ...waitedFlat,
      entries: waitedFlat.entries.map((entry) =>
        entry.lines ? { ...entry, lines: entry.lines.filter((line) => !isWaitLine(line)) } : entry,
      ),
    };
    assert.deepEqual(stripped, plainFlat);
  }
});
