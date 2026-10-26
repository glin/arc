// Turn-card tests keep local builders here. Shared builders live in turnfixtures.ts, and cross-module tests live in turnview.test.ts.

import { test, vi } from 'vitest';
import { ChildCacheExpiryAttribution } from './childcacheexpiry.ts';
import { turnKey } from './domain/read.ts';
import {
  CacheExpiryScan,
  emptyCacheExpiryFacts,
  publicProjectSpendPrice,
  type NativeChildCacheFacts,
} from './projectspend.ts';
import { turnCacheExpiryWarning, turnFileContributors, type CacheExpiryWarning } from './turncard.ts';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { readCodexAgentSpend, refreshCodexStructuralAgents } from './codex.ts';
import { AgentSpendCache, emptyUsage, readChildSpend, spendFileVersion } from './agentspend.ts';
import { tempDir } from './temproot.ts';
import * as pricing from './pricing.ts';
import * as richtext from './richtext.ts';
import {
  Compaction,
  NARRATION_DETAIL_LIMIT,
  SessionStatFacts,
  STEP_DETAIL_LIMIT,
  Turn,
  TurnAgent,
  TurnCommit,
  TurnLanding,
  cleanPrompt,
  readClaudeAgentSpend,
  readSession,
  refreshClaudeAgentFacts,
  refreshRetainedClaudeAgentFacts,
  sessionStatFactsOf,
  stepDetail,
} from './transcript.ts';
import {
  CACHED_INPUT_READ_EXPLANATION,
  CARD_ACTIONS,
  CARD_CONTENT_FIELDS,
  CARD_TIME_FIELDS,
  CONTEXT_BANDS,
  MARKS,
  TITLE_HEADLINE_LIMIT,
  TURN_MENU_SECTIONS,
  TURN_QUIET_MS,
  statusMoved,
  logOf,
  agentTokensOf,
  askLine,
  averageContextPerRequest,
  canMarkRead,
  cardPrint,
  commitCard,
  costDetail,
  currentContextOf,
  diffTitle,
  nextTurnBasisOf,
  distinctNames,
  dispatchedAgentCard,
  dispatchedCostPrint,
  movedDispatchedCards,
  dispatchedState,
  doingOf,
  durationWord,
  enumeratedCount,
  fileRowNames,
  foldedChips,
  headlineFor,
  landingCard,
  leadingSymbol,
  pendingAskOf,
  cacheExpiryReturnCount,
  sessionCacheExpiryStats,
  CACHE_EXPIRY_COST_ADDED_HINT,
  sessionCompactionContextDetail,
  sessionCostProjection,
  sessionCostUsageOf,
  sessionCostStats,
  turnCacheExpiryReturn,
  cacheExpiryWarningText,
  CACHE_EXPIRY_SIGN_DOLLARS,
  sessionStats,
  sessionStatsFromFacts,
  saidMessagesOf,
  sessionTurnStats,
  statusOf,
  stepCode,
  stepFigure,
  stepLine,
  toCard,
  commitRowsOf,
  toCompactionCard,
  tokenLines,
  toolCategoriesOf,
  toolMixOf,
  countedDispatchReferences,
  priceDispatchedParts,
  turnCardCost,
  turnCost,
  type DispatchedCostUsage,
  type DispatchedTurnCost,
  turnMenuSection,
  waitingOn,
  wholePercent,
  withLiveActivity,
  withSessionContextDetail,
  withoutLeadingSymbol,
} from './turncard.ts';
import { turnMenuContext } from './view/card-menu.ts';
import type {
  SessionCostUsage,
  SessionOverheads,
  SessionStatChip,
  StatDetailLine,
  StatDetailList,
  WaitShareWarning,
  TurnCard,
} from './turncard.ts';
import type { TurnStep } from './transcript.ts';
import { answerPart, commentAnchorText } from './turncomments.ts';
import { formatTokens, formatWhen } from './turnformat.ts';
import {
  COMPACTION_SAMPLES,
  SESSION_LINK_RESPONSE,
  NOW,
  advisorProbeRecords,
  advisorResponseRecords,
  advisorIteration,
  PER_PASS_ITERATIONS,
  MIXED_PASS_ITERATIONS,
  claudeCompactionTranscript,
  compaction,
  counts,
  recordCommit,
  recordLanding,
  skillUse,
  subagent,
  subagentCommitTurn,
  turn,
} from './turnfixtures.ts';
import { commitRowSpoken, commitRowTitle } from './webview/card-rows.ts';
import { reduceChildArtifacts } from './childartifacts.ts';
import { applyHiddenTurnFields, hiddenTurnFields } from './parserstate.ts';
import type { ChildArtifacts } from './childartifacts.ts';
import { normalizeFsPath, sameCommitSha } from './transcript.ts';
// Shared panel fixture for screenshots and measurements.
import { FIXTURE_CLOCK, FIXTURE_TURNS, LONG_TURN_INDEX, waitWarningPayload } from './panelfixture.ts';

test('turn token detail places qualified measurement under Output before Thinking', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const subject = {
      ...FIXTURE_TURNS[0],
      agent: provider,
      usage: { ...FIXTURE_TURNS[0].usage, output: 168, thinking: 40 },
      outputRate: { output: 84, milliseconds: 10000 },
    };
    const entries = toCard(subject, false, NOW).chips.find((chip) => chip.metric === 'tokens')!.detailList!.entries;
    const output = entries.find((entry) => entry.label === 'Output')!;
    const line = output.lines![0];
    assert.ok(typeof line === 'object' && 'text' in line);
    assert.equal(line.text, '8.4 tok/s');
    assert.ok(line.title?.includes(provider === 'claude' ? 'Observed response' : 'Request time'));
    assert.ok(typeof output.lines![1] === 'string');
    assert.ok(!entries.some((entry) => entry.label === 'Speed'));
    const flat = tokenLines(subject);
    assert.ok(
      flat.findIndex((text) => text.includes('Output:')) < flat.findIndex((text) => text.includes('8.4 tok/s')),
    );
    assert.ok(
      flat.findIndex((text) => text.includes('8.4 tok/s')) < flat.findIndex((text) => text.includes('Thinking:')),
    );
    for (const outputRate of [
      undefined,
      { output: 84, milliseconds: 0 },
      { output: 0, milliseconds: 1000 },
      { output: -1, milliseconds: 1000 },
      { output: 1, milliseconds: Infinity },
      { output: NaN, milliseconds: 1000 },
      { output: Number.MAX_SAFE_INTEGER + 1, milliseconds: 1000 },
      { output: 1, milliseconds: Number.MIN_VALUE },
    ]) {
      assert.ok(!tokenLines({ ...subject, outputRate }).some((text) => text.includes('tok/s')));
    }
    assert.ok(!tokenLines({ ...subject, interrupted: true }).some((text) => text.includes('tok/s')));
    assert.ok(
      !tokenLines({ ...subject, usage: { ...subject.usage, output: 0 } }).some((text) => text.includes('tok/s')),
    );
  }
});

test('child usage measurement keeps measured identity separate from its displayed model', () => {
  for (const priced of [false, true]) {
    const child = agent({
      model: null,
      spendFound: true,
      outputRate: { output: 168, milliseconds: 20000 },
      outputRateModel: 'gpt-6.1-sol',
      spend: [
        {
          model: priced ? 'gpt-6.1-sol' : 'unknown-sol',
          usage: { ...emptyUsage(), input: 1000, output: 168, thinking: 40 },
        },
        { model: priced ? 'gpt-6-astra' : 'unknown-astra', usage: { ...emptyUsage(), input: 100000, output: 1000 } },
      ],
    });
    const row = toCard(turn({ agent: 'codex', agents: [child] }), false, NOW).agents[0];
    if (priced) assert.equal(row.model?.toLowerCase(), 'gpt-6-astra');
    const figure = row.figures.find((value) => value.metric === (priced ? 'cost' : 'tokens'))!;
    const line = figure.record!.entries.find((entry) => entry.label === 'Output')!.lines![0];
    assert.ok(typeof line === 'object' && 'text' in line);
    assert.equal(line.text, '8.4 tok/s');
    assert.ok(line.title?.includes('gpt-6.1-sol'));
    assert.ok(line.title?.includes('Only this subagent'));
    assert.ok(figure.detail?.includes('8.4 tok/s'));
    assert.ok(
      !JSON.stringify(toCard(turn({ agents: [{ ...child, outputRateModel: undefined }] }), false, NOW)).includes(
        'tok/s',
      ),
    );
  }
});

test('dispatched Codex usage retains qualified measurement in priced and unpriced detail', () => {
  for (const priced of [false, true]) {
    const spend = {
      found: true,
      partial: false,
      effort: 'high',
      outputRate: { output: 168, milliseconds: 20000 },
      outputRateModel: 'gpt-6.1-sol',
      models: [{ model: priced ? 'gpt-6.1-sol' : 'unknown-sol', usage: { ...emptyUsage(), output: 168 } }],
    };
    const row = dispatchedAgentCard('child', 'Review the card', spend, 'done', 1000, 65000, 2, [], NOW, 'codex');
    const figure = row.figures.find((value) => value.metric === (priced ? 'cost' : 'tokens'))!;
    const line = figure.record!.entries.find((entry) => entry.label === 'Output')!.lines![0];
    assert.ok(typeof line === 'object' && 'text' in line);
    assert.equal(line.text, '8.4 tok/s');
    assert.equal(
      line.title,
      '8.4 tok/s. Output tokens per second. Actual output includes reasoning. Request time includes preparation and hooks. Blocking local tool waits and untimed responses are excluded. Measured model: gpt-6.1-sol. Only this dispatched session is timed. Usage totals include any delegated work.',
    );
    assert.ok(figure.detail?.includes('8.4 tok/s'));
    const unqualified = dispatchedAgentCard(
      'child',
      'Review the card',
      { ...spend, outputRateModel: undefined },
      'done',
      1000,
      65000,
      2,
      [],
      NOW,
      'codex',
    );
    assert.ok(!JSON.stringify(unqualified).includes('tok/s'));
  }
});
import type { CacheExpiryFacts, CompactionFact, ProjectUsageBucket, SessionTurnStats } from './projectspend.ts';

test('a dispatched child row carries its own figures and full session target', () => {
  const spend = {
    found: true,
    partial: false,
    effort: 'high',
    models: [
      {
        model: 'claude-sonnet-5',
        usage: {
          requests: 1,
          input: 1000,
          cacheWrite1h: 0,
          cacheWrite5m: 0,
          cacheRead: 10000,
          output: 500,
          thinking: 0,
        },
      },
    ],
    artifacts: {
      complete: false,
      revision: 'one',
      files: [{ path: 'C:/repo/src/card.ts', added: 8, removed: 2, isNew: false }],
      commits: ['abc1234'],
    },
    commits: [
      {
        sha: 'abc1234',
        subject: 'Render the dispatched row',
        at: 2000,
        files: 1,
        added: 8,
        removed: 2,
        place: null,
        dir: 'C:/repo',
      },
    ],
  };
  const id = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const row = dispatchedAgentCard(id, 'Review the card', spend, 'done', 1000, 65000, 9);
  assert.equal(row.kind, 'dispatch');
  assert.equal(row.sessionId, id);
  assert.deepEqual(
    row.figures.map((figure) => figure.metric),
    ['cost', 'duration', 'commits', 'files'],
  );
  assert.deepEqual(row.figures.find((figure) => figure.metric === 'files')?.paths, ['C:/repo/src/card.ts']);
  assert.deepEqual(row.figures.find((figure) => figure.metric === 'commits')?.shas, ['abc1234']);
  assert.deepEqual(
    row.files?.map((file) => [file.path, file.added, file.removed]),
    [['C:/repo/src/card.ts', 8, 2]],
  );
  assert.deepEqual(
    row.commits?.map((commit) => [commit.sha, commit.dir]),
    [['abc1234', 'C:/repo']],
  );
  assert.deepEqual(row.figures.find((figure) => figure.metric === 'files')?.record?.footer, [
    "This child session's record ended early, so this list holds only what Arc read.",
  ]);
  const unfinished = dispatchedAgentCard(
    id,
    'Review the card',
    { ...spend, unfinished: true },
    'stopped',
    1000,
    65000,
    9,
  );
  assert.match(unfinished.figures.find((figure) => figure.metric === 'cost')?.name ?? '', /^At least /);
  assert.doesNotMatch(JSON.stringify(unfinished.figures), /Some nested subagents are still running or left no record/);
  const running = dispatchedAgentCard(id, 'Review the card', spend, 'running', 1000, null, 9);
  assert.deepEqual([running.state, running.since, running.stateWord], ['running', 1000, 'running']);
  assert.deepEqual([running.files, running.commits], [[], []]);
  // A running dispatched session draws its cost so far, as a lower bound, and nothing else.
  assert.deepEqual(
    running.figures.map((figure) => [figure.metric, figure.compactLabel, figure.name]),
    [['cost', '<$0.01+', 'At least <$0.01 spent']],
  );
});

const economicRequest = (over: Partial<ProjectUsageBucket> = {}): ProjectUsageBucket => ({
  localDate: '2026-09-01',
  agent: 'codex',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  contextWindow: 272000,
  contextBand: 'short',
  billingClass: 'metered',
  inferenceClass: null,
  serviceTier: null,
  reportedCost: null,
  reportedCostBasis: null,
  linkedSessionId: null,
  linkedInvocationId: null,
  incomplete: false,
  usage: {
    requests: 1,
    input: 100000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
  },
  requests: 1,
  ...over,
});

const compactionFact = (over: Partial<CompactionFact> = {}): CompactionFact => ({
  ordinal: 1,
  at: NOW,
  trigger: 'manual',
  contextBefore: null,
  contextAfter: null,
  requestsAfter: 0,
  firstRequestAfter: null,
  requestUsage: null,
  requestModel: null,
  requestProvider: null,
  requestServiceTier: null,
  requestContextWindow: null,
  ...over,
});

test('cache expiry presentation keeps exact, lower-bound, and recording-limit facts distinct', () => {
  const exact: CacheExpiryFacts = {
    counts: { '5m': 0, '30m': 2, '1h': 1 },
    longestGapMs: 26 * 60 * 60 * 1000,
    returns: [
      {
        lifetime: '30m',
        gapMs: 31 * 60 * 1000,
        request: economicRequest(),
        visibleTurnId: 'turn-b',
        requestKey: null,
        previousInputSide: 100_000,
      },
    ],
    excluded: 2,
    unavailable: 0,
    truncated: false,
  };
  const chip = sessionCacheExpiryStats(exact)[0];
  assert.equal(chip.label, '3 cache expiries');
  assert.equal(chip.focusable, true);
  assert.deepEqual(chip.detailList?.heading, { label: 'Cache expiry', value: '3 affected requests' });
  assert.deepEqual(
    chip.detailList?.entries.map((entry) => entry.label),
    ['Cache lifetimes', 'Cost added', 'Longest qualifying gap', 'Excluded ambiguous events'],
  );
  assert.match(chip.detail, /Longest qualifying gap: 1d 2h/);
  assert.ok(chip.detail.includes('The record does not identify every cache-key change.'));
  // The Codex caveat explains the count, so it folds into the notes.
  assert.deepEqual(chip.detailList?.notes, ['The record does not identify every cache-key change.']);
  assert.deepEqual(chip.detailList?.footer, []);
  const lower = sessionCacheExpiryStats({
    ...exact,
    returns: [
      ...exact.returns,
      {
        lifetime: '1h',
        gapMs: 61 * 60 * 1000,
        request: economicRequest({ reportedCost: 4.1 }),
        visibleTurnId: 'turn-c',
        requestKey: null,
        previousInputSide: 100_000,
      },
    ],
  })[0];
  assert.match(lower.detail, /Cost added: At least \$/);
  // The row prices the resent context only, and its hover says so.
  const added = chip.detailList?.entries.find((entry) => entry.label === 'Cost added');
  assert.equal(added?.valueTitle, CACHE_EXPIRY_COST_ADDED_HINT);
  assert.ok(Number(String(added?.value).replace('$', '')) > 0);
  const unknownPrefix = sessionCacheExpiryStats({
    ...exact,
    returns: [{ ...exact.returns[0], previousInputSide: null }],
  })[0];
  assert.match(unknownPrefix.detail, /Cost added: Unavailable/);
  assert.deepEqual(unknownPrefix.detailList?.footer, [
    'One or more affected requests follow a compaction whose cached size is not recorded. Cost added is not available for them.',
  ]);
  // A return saved by an older ledger names neither its turn nor its reusable size, and no compaction.
  const olderSaved = sessionCacheExpiryStats({
    ...exact,
    returns: [{ ...exact.returns[0], visibleTurnId: null, requestKey: null, previousInputSide: null }],
  })[0];
  assert.match(olderSaved.detail, /Cost added: Unavailable/);
  assert.deepEqual(olderSaved.detailList?.footer, [
    'One or more affected requests were recorded before Arc measured cost added. Cost added is not available for them.',
  ]);
  assert.ok(!lower.detail.includes('recommend'));
});

const tokenUsage = (over: Partial<Turn['usage']> = {}): Turn['usage'] => ({
  requests: 1,
  input: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWrite30m: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
  ...over,
});

const sonnetPart = {
  agent: 'claude' as const,
  role: 'main' as const,
  model: 'claude-sonnet-5',
  provider: null,
  contextWindow: null,
  contextBand: null,
  inferenceClass: null,
  serviceTier: null,
};

const oneExpiry = (over: Partial<CacheExpiryFacts> = {}): CacheExpiryFacts => ({
  counts: { '5m': 0, '30m': 0, '1h': 1 },
  longestGapMs: 72 * 60 * 1000,
  returns: [
    {
      lifetime: '1h',
      gapMs: 72 * 60 * 1000,
      request: economicRequest(),
      visibleTurnId: 'codex-turn:turn-b',
      requestKey: 'codex:turn-b:1',
      previousInputSide: 100_000,
    },
  ],
  excluded: 0,
  unavailable: 0,
  truncated: false,
  ...over,
});

test('the session cost popover names compactions and cache expiries under Included above', () => {
  const parts = [
    { ...sonnetPart, usage: tokenUsage({ requests: 20, input: 50_000, cacheRead: 2_000_000, output: 40_000 }) },
    {
      ...sonnetPart,
      compactionEstimate: true as const,
      usage: tokenUsage({ requests: 3, cacheRead: 600_000, output: 30_000 }),
    },
  ];
  const expiry = oneExpiry();
  const list = sessionCostProjection(parts, false, { compactionCount: 3, expiry }).stats[0].detailList!;
  const group = list.entries.slice(-3);
  assert.deepEqual(
    group.map((entry) => entry.label),
    ['Included above', '3 compactions', '1 cache expiry'],
  );
  assert.deepEqual(group[0], { label: 'Included above', group: true, separateBefore: true });
  // The value column holds plain money, and every estimated compaction is priced.
  assert.match(String(group[1].value), /^\$\d+\.\d\d$/);
  // The row and the heading cache-expiry figure read one source.
  const heading = sessionCacheExpiryStats(expiry)[0].detailList!.entries.find((entry) => entry.label === 'Cost added');
  assert.equal(group[2].value, heading?.value);
  assert.equal(group[2].valueTitle, CACHE_EXPIRY_COST_ADDED_HINT);
  assert.equal(list.footer?.[0], 'Compaction costs are estimates. Claude Code records no usage for a compaction.');
  assert.ok(
    list.notes?.includes(
      "A cache expiry's cost is what resending the context cost above a cache read of the same tokens.",
    ),
  );
  // Without the counts there is no group, and the estimate note keeps its count and dollars.
  const bare = sessionCostProjection(parts).stats[0].detailList!;
  assert.ok(!bare.entries.some((entry) => entry.group));
  assert.match(bare.footer?.[0] ?? '', /^Includes an estimated \$\d+\.\d\d for 3 compactions\./);
});

test('beside a compactions row the session popover keeps the delegated compaction estimate', () => {
  const main = {
    ...sonnetPart,
    usage: tokenUsage({ requests: 20, input: 50_000, cacheRead: 2_000_000, output: 40_000 }),
  };
  const delegatedEstimate = {
    ...sonnetPart,
    role: 'delegated' as const,
    scopeId: 'agent-1',
    compactionEstimate: true as const,
    usage: tokenUsage({ requests: 2, cacheRead: 400_000, output: 20_000 }),
  };
  const footer = (parts: SessionCostUsage[]) =>
    sessionCostProjection(parts, false, { compactionCount: 1 }).stats[0].detailList!.footer ?? [];
  // The main compaction has no estimate, so only the delegated amount and its count show.
  const delegatedOnly = footer([main, delegatedEstimate]);
  assert.ok(!delegatedOnly.includes('Compaction costs are estimates. Claude Code records no usage for a compaction.'));
  assert.ok(delegatedOnly.some((line) => /^Includes an estimated \$\d+\.\d\d for 2 compactions\./.test(line)));
  const both = footer([
    main,
    {
      ...sonnetPart,
      compactionEstimate: true as const,
      usage: tokenUsage({ requests: 1, cacheRead: 300_000, output: 10_000 }),
    },
    delegatedEstimate,
  ]);
  assert.equal(both[0], 'Compaction costs are estimates. Claude Code records no usage for a compaction.');
  assert.match(both[1] ?? '', /^Includes an estimated \$\d+\.\d\d for 2 compactions\./);
});

test('a session row prices only the compactions its total contains', () => {
  const codex = {
    agent: 'codex' as const,
    role: 'main' as const,
    model: 'gpt-5.6-sol',
    provider: 'openai',
    contextWindow: 272_000,
    contextBand: 'short' as const,
    inferenceClass: null,
    serviceTier: null,
  };
  // Retained Codex facts carry recorded usage that the total does not hold.
  const facts = Array.from({ length: 16 }, (_, index) =>
    compactionFact({
      ordinal: index + 5,
      trigger: 'auto',
      requestUsage: tokenUsage({ input: 100_000, output: 4_000 }),
      requestModel: 'gpt-5.6-sol',
      requestProvider: 'openai',
      requestContextWindow: 272_000,
    }),
  );
  const codexUsage = { ...codex, usage: tokenUsage({ requests: 40, input: 900_000, output: 50_000 }) };
  const list = sessionCostProjection([codexUsage], false, {
    compactionCount: 20,
    compactions: facts,
  } as SessionOverheads).stats[0].detailList!;
  assert.equal(list.entries.find((entry) => entry.label === '20 compactions')?.value, 'cost unavailable');
  assert.ok(!(list.footer ?? []).some((line) => line.includes('estimate')));
  // Claude estimates are in the total, so they price the row, and the unpriced rest makes it a lower bound.
  const mixed = sessionCostProjection(
    [
      codexUsage,
      {
        ...sonnetPart,
        compactionEstimate: true as const,
        usage: tokenUsage({ requests: 1, cacheRead: 300_000, output: 10_000 }),
      },
    ],
    false,
    { compactionCount: 3 },
  ).stats[0].detailList!;
  assert.match(String(mixed.entries.find((entry) => entry.label === '3 compactions')?.value), /^\$\d+\.\d\d\+$/);
});

test('a turn card finds the cache-expiry return that opened it', () => {
  const claudeReturn = { ...oneExpiry().returns[0], request: economicRequest({ agent: 'claude' }) };
  const claude = turn({ agent: 'claude', responseIds: ['m1', 'm2'] });
  assert.equal(turnCacheExpiryReturn(claude, [{ ...claudeReturn, requestKey: 'claude:m1' }])?.requestKey, 'claude:m1');
  assert.equal(turnCacheExpiryReturn(claude, [{ ...claudeReturn, requestKey: 'claude:m9' }]), null);
  // A saved return without a request key never matches a Claude turn.
  assert.equal(turnCacheExpiryReturn(claude, [{ ...claudeReturn, requestKey: null }]), null);
  const codex = turn({ agent: 'codex', promptId: 'turn-b' });
  assert.equal(turnCacheExpiryReturn(codex, oneExpiry().returns)?.visibleTurnId, 'codex-turn:turn-b');
  assert.equal(turnCacheExpiryReturn(turn({ agent: 'codex', promptId: 'turn-c' }), oneExpiry().returns), null);
});

test('child expiry attribution sums its own threshold and retains disjoint recorded history', () => {
  const start = NOW - 60_000;
  const usage = tokenUsage({ input: 10_000 });
  const parent = turn({
    startedAt: start,
    endedAt: start + 1_000,
    finished: true,
    model: sonnetPart.model,
    usage,
    usageParts: [{ ...sonnetPart, usage }],
  });
  const entry = (timestamp: number) => ({ ...oneExpiry().returns[0], timestamp });
  const source = (returns: ReturnType<typeof entry>[]): NativeChildCacheFacts => ({
    source: 'agent-child.jsonl',
    revision: {} as NativeChildCacheFacts['revision'],
    facts: { ...emptyCacheExpiryFacts(), counts: { '5m': returns.length, '30m': 0, '1h': 0 }, returns },
    endedAt: null,
    outcome: null,
  });
  const facts = (returns: ReturnType<typeof entry>[]) => ({
    [parent.sessionId]: {
      ...emptyCacheExpiryFacts(),
      counts: { '5m': returns.length, '30m': 0, '1h': 0 },
      childSources: [source(returns)],
    },
  });
  const quote = (dollars: number) => (bucket: { usage: { cacheRead: number } }) => ({
    dollars: bucket.usage.cacheRead ? 0 : dollars,
  });
  for (const [count, dollars] of [
    [2, 0.004],
    [2, 0.495],
    [2, 0.5],
    [2, 0.6],
  ]) {
    const cache = facts(Array.from({ length: count }, (_, at) => entry(start + at * 10_000)));
    const result = new ChildCacheExpiryAttribution().read(
      [parent],
      cache,
      NOW,
      new Map(),
      new Set(),
      quote(dollars) as never,
    );
    const cost = result.get(turnKey(parent))!;
    assert.equal(cost.count, count);
    assert.equal(cost.dollars, dollars * count);
    const retained = JSON.stringify(cache);
    const session = sessionCacheExpiryStats(cache[parent.sessionId]);
    const warning = turnCacheExpiryWarning(parent, cache[parent.sessionId], cost);
    const card = toCard(parent, false, NOW, [], null, false, new Set(), [], warning);
    assert.equal(
      Boolean(
        card.chips.find((chip) => chip.metric === 'cost')?.warnings?.some((item) => item.scope === 'cache-expiry'),
      ),
      dollars * count >= 1,
    );
    const chip = card.chips.find((chip) => chip.metric === 'cost')!;
    assert.equal(
      chip.detailList?.entries.some((item) => item.warning),
      dollars * count >= CACHE_EXPIRY_SIGN_DOLLARS,
    );
    assert.equal(chip.detail.includes('Cache expiry affected'), dollars * count >= CACHE_EXPIRY_SIGN_DOLLARS);
    assert.equal(chip.label, toCard(parent, false, NOW).chips.find((chip) => chip.metric === 'cost')?.label);
    assert.deepEqual(sessionCacheExpiryStats(cache[parent.sessionId]), session);
    assert.equal(JSON.stringify(cache), retained);
    assert.equal(
      new ChildCacheExpiryAttribution().read([parent], cache, NOW + 1_000_000).get(turnKey(parent))?.count,
      count,
      'quiet expiry contracted recorded child history',
    );
  }
  const cache = facts([entry(start + 10_000), entry(start + 20_000), entry(start + 30_000)]);
  const next = turn({ startedAt: start + 20_000, endedAt: start + 30_000 });
  const result = new ChildCacheExpiryAttribution().read([parent, next], cache, NOW);
  assert.equal(result.get(turnKey(parent))?.count, 1);
  assert.equal(result.get(turnKey(next))?.count, 2, 'the later prompt must own start equality');
  const capped = { ...parent, processEndedAt: start + 10_000 };
  assert.equal(
    new ChildCacheExpiryAttribution().read([capped], cache, NOW).get(turnKey(parent))?.count,
    1,
    'recorded process-end equality must remain included',
  );
  const reversed = { ...parent, endedAt: start - 1 };
  assert.equal(new ChildCacheExpiryAttribution().read([reversed], cache, NOW).size, 0);
  assert.equal(new ChildCacheExpiryAttribution().read([parent, { ...parent }], cache, NOW).size, 0);
  const unknown = source([{ ...entry(start), previousInputSide: null }]);
  assert.equal(
    new ChildCacheExpiryAttribution()
      .read([parent], { [parent.sessionId]: { ...emptyCacheExpiryFacts(), childSources: [unknown] } }, NOW)
      .get(turnKey(parent))?.status,
    'unknown',
  );
});

test('parent warnings respect child closure margins before and after main completion and across prompts', () => {
  const start = NOW - 60_000;
  const closedAt = start + 10_000;
  const usage = tokenUsage({ input: 10_000 });
  const priced = { model: sonnetPart.model, usage, usageParts: [{ ...sonnetPart, usage }] };
  for (const endedAt of [closedAt - 1_000, closedAt + 3_000]) {
    for (const offset of [-500, 0, 500, 1_000, 1_001]) {
      for (const nextPrompt of [false, true]) {
        if (nextPrompt && endedAt > closedAt) continue;
        const parent = turn({ ...priced, startedAt: start, endedAt, finished: true });
        const next = turn({ ...priced, startedAt: closedAt + 250, endedAt: closedAt + 2_000, finished: true });
        const timestamp = closedAt + offset;
        const source: NativeChildCacheFacts = {
          source: 'agent-child.jsonl',
          childId: 'child',
          revision: {} as NativeChildCacheFacts['revision'],
          facts: { ...emptyCacheExpiryFacts(), returns: [{ ...oneExpiry().returns[0], timestamp }] },
          endedAt: timestamp,
          outcome: null,
        };
        const facts = { [parent.sessionId]: { ...emptyCacheExpiryFacts(), childSources: [source] } };
        const outcome = {
          startedAt: parent.startedAt,
          endedAt,
          finished: true,
          error: false,
          interrupted: false,
          closedChildren: [{ id: 'child', closedAt }],
        };
        const attribution = new ChildCacheExpiryAttribution().read(
          nextPrompt ? [parent, next] : [parent],
          facts,
          NOW,
          new Map([[parent.sessionId, outcome]]),
          new Set(),
          ((bucket) => ({ dollars: bucket.usage.cacheRead ? 0 : 1.2 })) as typeof publicProjectSpendPrice,
        );
        const target = nextPrompt && timestamp >= next.startedAt ? next : parent;
        const warning = turnCacheExpiryWarning(target, facts[parent.sessionId], attribution.get(turnKey(target)));
        const card = toCard(target, false, NOW, [], null, false, new Set(), [], warning);
        const signed = Boolean(card.chips.find((chip) => chip.metric === 'cost')?.warnings?.length);
        assert.equal(
          signed,
          offset <= 0 || offset > 1_000,
          `child closure +${offset}ms signed the parent with main end ${endedAt - closedAt}ms and next prompt ${nextPrompt}`,
        );
      }
    }
  }
});

test('a card batch inspects native child returns once and prices only changed source revisions', () => {
  for (const count of [100, 1000]) {
    const cards = Array.from({ length: 40 }, (_, at) =>
      turn({ startedAt: NOW - (40 - at) * 60_000, endedAt: NOW - (40 - at) * 60_000 + 30_000 }),
    );
    const sources: NativeChildCacheFacts[] = Array.from({ length: count }, (_, at) => ({
      source: `agent-${at}.jsonl`,
      revision: {} as NativeChildCacheFacts['revision'],
      endedAt: null,
      outcome: null,
      facts: {
        ...emptyCacheExpiryFacts(),
        counts: { '5m': 32, '30m': 0, '1h': 0 },
        returns: Array.from({ length: 32 }, (_, request) => ({
          ...oneExpiry().returns[0],
          timestamp: NOW - (request + 1) * 60_000 + 10_000,
        })),
      },
    }));
    const session = cards[0].sessionId;
    const facts = { [session]: { ...emptyCacheExpiryFacts(), childSources: sources } };
    const quote = vi.fn<typeof publicProjectSpendPrice>(publicProjectSpendPrice);
    let inspections = 0;
    const inspect = () => {
      inspections++;
    };
    const cache = new ChildCacheExpiryAttribution();
    cache.read(cards, facts, NOW, new Map(), new Set(), quote, inspect);
    assert.equal(inspections, count * 32, 'initial cards rescanned child returns');
    assert.equal(quote.mock.calls.length, count * 32 * 2);
    inspections = 0;
    quote.mockClear();
    cache.read(cards, facts, NOW + 1, new Map(), new Set(), quote, inspect);
    assert.equal(inspections, count * 32, 'warning-change cards rescanned child returns');
    assert.equal(quote.mock.calls.length, 0, 'unchanged source revisions repriced child returns');
    facts[session].childSources[0] = { ...sources[0], revision: {} as NativeChildCacheFacts['revision'] };
    quote.mockClear();
    cache.read(cards, facts, NOW, new Map(), new Set(), quote);
    assert.equal(quote.mock.calls.length, 64, 'one source revision repriced other sources');
  }
});

test('a turn that returned to an expired cache warns in its cost popover and figure from $1', () => {
  const usage = tokenUsage({ requests: 2, input: 40_000, cacheWrite1h: 300_000, output: 2_000 });
  const ran = turn({
    model: 'claude-sonnet-5',
    usage,
    usageParts: [{ ...sonnetPart, usage }],
  });
  const cost = (dollars: number | null, over: Partial<CacheExpiryWarning> = {}) =>
    toCard(ran, false, NOW, [], null, false, new Set(), [], {
      scope: 'cache-expiry',
      gapMs: 72 * 60 * 1000,
      dollars,
      ...over,
    }).chips.find((chip) => chip.metric === 'cost')!;
  const signed = cost(2.34);
  const sentence = 'Cache expired after a 1h 12m gap and added $2.34';
  assert.deepEqual(signed.detailList?.entries[0], { label: sentence, warning: true });
  assert.deepEqual(
    signed.warnings?.map((warning) => warning.scope),
    ['cache-expiry'],
  );
  assert.ok(signed.name?.includes(sentence), 'the accessible name carries the full sentence');
  const atLimit = cost(CACHE_EXPIRY_SIGN_DOLLARS);
  assert.equal(atLimit.warnings?.length, 1);
  const plain = toCard(ran, false, NOW).chips.find((chip) => chip.metric === 'cost')!;
  const child = (dollars: number | null, status: 'exact' | 'atLeast' | 'unknown' = 'exact', count = 1) => ({
    count,
    dollars,
    status,
    longestGapMs: 72 * 60 * 1000,
  });
  for (const dollars of [0, 0.004, 0.5, 0.999, 1, 1.2]) {
    const visible = dollars >= CACHE_EXPIRY_SIGN_DOLLARS;
    for (const children of [undefined, child(dollars)]) {
      const chip = cost(dollars, { children });
      assert.equal(
        chip.detailList?.entries.some((item) => item.warning),
        visible,
      );
      assert.equal(chip.detail.includes(children ? 'Cache expiry affected' : 'Cache expired'), visible);
      assert.equal(Boolean(chip.warnings?.length), visible, 'the text and figure sign disagree');
      assert.equal(chip.label, plain.label, 'warning visibility changed the total');
      if (visible) assert.ok(chip.name?.includes(children ? 'Cache expiry affected' : 'Cache expired'));
      if (!visible) {
        assert.deepEqual(chip.detailList, plain.detailList);
        assert.equal(chip.name, plain.name, 'a hidden warning remained in the accessible name');
      }
    }
    for (const mainDollars of [0.004, 0.5, 1, 1.2]) {
      const chip = cost(dollars, {
        children: child(dollars),
        main: { dollars: mainDollars, status: 'exact', gapMs: 72 * 60 * 1000 },
      });
      assert.equal(chip.detail.includes('Cache expired'), mainDollars >= CACHE_EXPIRY_SIGN_DOLLARS);
      assert.equal(chip.detail.includes('Cache expiry affected'), visible);
      assert.equal(Boolean(chip.warnings?.length), visible || mainDollars >= CACHE_EXPIRY_SIGN_DOLLARS);
      assert.equal(chip.name?.includes('Cache expired') ?? false, mainDollars >= CACHE_EXPIRY_SIGN_DOLLARS);
      assert.equal(chip.name?.includes('Cache expiry affected') ?? false, visible);
      assert.doesNotMatch(chip.detail, /^\.|\. \n/);
    }
  }
  for (const status of ['atLeast', 'unknown'] as const) {
    for (const dollars of [null, 0, 0.004, 0.5, 0.999, 1, 1.2]) {
      for (const children of [undefined, child(dollars, status)]) {
        const chip = cost(dollars, { status, children });
        const visible = dollars !== null && dollars >= CACHE_EXPIRY_SIGN_DOLLARS;
        assert.equal(
          chip.detailList?.entries.some((item) => item.warning),
          visible,
        );
        assert.equal(Boolean(chip.warnings?.length), visible, 'uncertain text and figure sign disagree');
        assert.equal(chip.name?.includes(children ? 'Cache expiry affected' : 'Cache expired') ?? false, visible);
        assert.equal(chip.label, plain.label);
        if (!visible) assert.deepEqual(chip.detailList, plain.detailList);
        if (status === 'atLeast' && visible) assert.match(chip.detail, /added at least /);
      }
    }
  }
  assert.equal(
    cost(1.2, { children: child(1.2) }).detailList?.entries[0]?.label,
    'Cache expiry affected 1 subagent request and added $1.20',
  );
  assert.equal(
    cost(1.2, { children: child(1.2, 'exact', 3) }).detailList?.entries[0]?.label,
    'Cache expiry affected 3 subagent requests and added $1.20',
  );
  for (const [main, delegated, signed] of [
    [0.6, 0.6, false],
    [1, 0.004, true],
    [0.004, 1, true],
  ] as const) {
    const chip = cost(delegated, {
      children: child(delegated),
      main: { dollars: main, status: 'exact', gapMs: 72 * 60 * 1000 },
    });
    assert.equal(Boolean(chip.warnings?.length), signed);
    assert.equal(chip.name?.includes('Cache expired') ?? false, signed && main >= CACHE_EXPIRY_SIGN_DOLLARS);
    assert.equal(
      chip.name?.includes('Cache expiry affected') ?? false,
      signed && delegated >= CACHE_EXPIRY_SIGN_DOLLARS,
    );
  }
  assert.ok(
    !toCard(ran, false, NOW)
      .chips.find((chip) => chip.metric === 'cost')
      ?.detail.includes('Cache expired'),
  );
  const gap = (minutes: number) =>
    cacheExpiryWarningText({ scope: 'cache-expiry', gapMs: minutes * 60 * 1000, dollars: 1 });
  assert.equal(gap(8 * 60), 'Cache expired after an 8h 0m gap and added $1.00');
  assert.equal(gap(11), 'Cache expired after an 11m gap and added $1.00');
  assert.equal(gap(18 * 60), 'Cache expired after an 18h 0m gap and added $1.00');
  assert.equal(gap(61), 'Cache expired after a 1h 1m gap and added $1.00');
});

test('a Codex turn whose main agent spent a fifth of its cost on waits warns in its cost popover and figure', () => {
  // claude-sonnet-5 input costs $2 per million tokens, so these fixtures price in whole dollars.
  const waited = (requests: number, input: number, mainInput: number, over: Partial<Turn> = {}) => {
    const usage = tokenUsage({ requests: 20, input: mainInput });
    const waits = { requests, timedOut: 1, usage: tokenUsage({ requests, input }) };
    return turn({
      agent: 'codex',
      finished: true,
      model: 'claude-sonnet-5',
      usage,
      usageParts: [{ ...sonnetPart, usage, waits }],
      ...over,
    });
  };
  const cost = (ran: Turn, expiry: CacheExpiryWarning | null = null) =>
    toCard(ran, false, NOW, [], null, false, new Set(), [], expiry).chips.find((chip) => chip.metric === 'cost')!;
  const sentence =
    "Waiting on subagents took 20% of this turn's main agent cost: $2.00 of $10 went to 5 waits, 1 of them timed out";
  const signed = cost(waited(5, 1_000_000, 5_000_000));
  assert.deepEqual(signed.detailList?.entries[0], { label: sentence, warning: true });
  assert.deepEqual(
    signed.warnings?.map((warning) => warning.scope),
    ['wait'],
  );
  assert.ok(signed.name?.includes(sentence), 'the accessible name carries the full sentence');
  const plainUsage = tokenUsage({ requests: 20, input: 5_000_000 });
  const plain = cost(
    turn({
      agent: 'codex',
      finished: true,
      model: 'claude-sonnet-5',
      usage: plainUsage,
      usageParts: [{ ...sonnetPart, usage: plainUsage }],
    }),
  );
  assert.equal(signed.label, plain.label, 'the warning changed the total');
  assert.deepEqual(signed.detailList?.entries.slice(1), plain.detailList?.entries);
  // Under any one floor, the turn shows neither the sentence nor the sign.
  for (const under of [
    waited(4, 1_000_000, 5_000_000),
    waited(5, 495_000, 1_000_000),
    waited(5, 1_000_000, 5_100_000),
    waited(5, 1_000_000, 5_000_000, { finished: false }),
  ]) {
    const chip = cost(under);
    assert.equal(chip.warnings, undefined);
    assert.ok(!chip.detail.includes('Waiting on subagents'));
    assert.ok(!chip.detailList?.entries.some((entry) => entry.warning));
  }
  // A cache-expiry sentence leads, and the wait sentence follows as its own entry.
  const both = cost(waited(5, 1_000_000, 5_000_000), { scope: 'cache-expiry', gapMs: 72 * 60 * 1000, dollars: 2.34 });
  assert.deepEqual(both.detailList?.entries.slice(0, 2), [
    { label: 'Cache expired after a 1h 12m gap and added $2.34', warning: true },
    { label: sentence, warning: true },
  ]);
  assert.deepEqual(
    both.warnings?.map((warning) => warning.scope),
    ['cache-expiry', 'wait'],
  );
});

// The Tools tab and the wait warning read one wait definition, so the Waits row names the
// warning's request count. The tab merges the CLI's kinds into the board's five rows.
test('the cost popovers lead with the wait warning, and their Waits rows count the warning requests', () => {
  const payload = waitWarningPayload() as {
    cards: TurnCard[];
    stats: Record<string, SessionStatChip[]>;
  };
  const session = payload.stats.s1.find((chip) => chip.metric === 'cost')!;
  const turn = payload.cards[0].chips.find((chip) => chip.metric === 'cost')!;
  for (const [figure, tabs, of] of [
    [session, ['Usage', 'Tools', 'Subagents'], "the main agent's cost"],
    [turn, ['Usage', 'Tools'], 'this turn'],
  ] as const) {
    const warning = figure.warnings?.find((held) => held.scope === 'wait') as WaitShareWarning;
    const cost = figure.detailList!.cost!;
    assert.match(cost.warnings[0].text, /^Waiting on subagents took \$1\.51, 21% of /);
    assert.equal(
      cost.warnings[0].title,
      `$1.51 of $7.20 went to ${warning.requests} waits, ${warning.timedOut} of them timed out`,
    );
    assert.deepEqual(
      cost.tabs.map((tab) => tab.name),
      tabs,
    );
    const tools = cost.tabs[1];
    assert.match(tools.base, /^Main agent cost by the tool result each request read\. Shares of /);
    assert.deepEqual(
      tools.rows.map((row) => [row.label, row.percent]),
      [
        ['No tool result', '32%'],
        ['Waits', '21%'],
        ['Other tool results', '18%'],
        ['File read', '17%'],
        ['Test or build', '13%'],
      ],
    );
    const waits = tools.rows.find((row) => row.label === 'Waits')!;
    assert.equal(waits.title, `$1.51, ${warning.requests} requests, 21% of ${of} (wait_agent 36, write_stdin 6)`);
    assert.equal(waits.percent, `${Math.round(warning.share * 100)}%`);
    assert.match(tools.rows[2].title, /, 28 requests, 18% of .* \(other 12, git 10, search 6\)$/);
  }
  // The session hero sets the main agent against delegated work. The turn delegated nothing.
  const hero = session.detailList!.cost!;
  assert.deepEqual(
    [hero.main.label, hero.delegated?.label, hero.delegated?.model],
    ['Main agent', 'Delegated', '2 × sol, 1 × astra'],
  );
  assert.equal(turn.detailList!.cost!.delegated, undefined);
  assert.equal(turn.detailList!.cost!.main.value, undefined);
  // Each child reads as its agent path, breaking only after an underscore, with its model under it.
  const children = hero.tabs[2].rows;
  assert.deepEqual(
    children.map((row) => [row.label.replaceAll('\u200b', '|'), row.detail]),
    [
      ['code_|implement_|1_|npm_|tests_|sol', 'gpt-6.1-sol'],
      ['code_|fix_|1_|npm_|tests_|sol_|deadlines', 'gpt-6.1-sol'],
      ['code_|review_|1_|npm_|tests_|astra', 'gpt-6-astra'],
    ],
  );
  assert.match(
    children[2].title,
    /^code_review_1_npm_tests_astra, gpt-6-astra, session 01a1535a-e7c6-7cc3-a9aa-9552803efb51\. \$[0-9.]+, \d+% of delegated work\.$/,
  );
});

test('wait warning fixture signs the turn and session cost figures under a quarter of the session total', () => {
  const payload = waitWarningPayload() as { cards: TurnCard[]; stats: Record<string, SessionStatChip[]> };
  const turnFigure = payload.cards[0].chips.find((chip) => chip.metric === 'cost')!;
  assert.deepEqual(
    turnFigure.warnings?.map((warning) => warning.scope),
    ['wait'],
  );
  assert.match(
    String(turnFigure.detailList?.entries[0].label),
    /^Waiting on subagents took 21% of this turn's main agent cost/,
  );
  const sessionCost = payload.stats.s1.find((chip) => chip.metric === 'cost')!;
  const wait = sessionCost.warnings?.find((warning) => warning.scope === 'wait');
  assert.ok(wait?.scope === 'wait' && wait.waitCost / Number(sessionCost.dollars) < 0.25);
});

test('a turn that holds a compaction names it under Included above', () => {
  const plain = tokenUsage({ requests: 4, input: 20_000, cacheRead: 400_000, output: 3_000 });
  const estimated = tokenUsage({ requests: 1, cacheRead: 300_000, output: 12_000 });
  const ran = turn({
    model: 'claude-sonnet-5',
    usage: tokenUsage({ requests: 5, input: 20_000, cacheRead: 700_000, output: 15_000 }),
    usageParts: [
      { ...sonnetPart, usage: plain },
      { ...sonnetPart, compactionEstimate: true, usage: estimated },
    ],
  });
  const list = toCard(ran, false, NOW).chips.find((chip) => chip.metric === 'cost')!.detailList!;
  assert.deepEqual(
    list.entries.slice(-2).map((entry) => entry.label),
    ['Included above', '1 compaction'],
  );
  assert.match(String(list.entries.at(-1)?.value), /^\$\d+\.\d\d$/);
  assert.deepEqual(list.footer, ['Compaction costs are estimates. Claude Code records no usage for a compaction.']);
  const none = toCard(
    turn({ model: 'claude-sonnet-5', usage: plain, usageParts: [{ ...sonnetPart, usage: plain }] }),
    false,
    NOW,
  );
  assert.ok(!none.chips.find((chip) => chip.metric === 'cost')?.detailList?.entries.some((entry) => entry.group));
});

// Cache-expiry counts are lower bounds when any adjacent pair remains unavailable.

test('a cache-expiry count with unavailable pairs is marked as a floor', () => {
  const judged: CacheExpiryFacts = {
    counts: { '5m': 0, '30m': 2, '1h': 1 },
    longestGapMs: null,
    returns: [],
    excluded: 0,
    unavailable: 0,
    truncated: false,
  };
  assert.deepEqual(cacheExpiryReturnCount(judged), { count: 3, atLeast: false });
  assert.deepEqual(cacheExpiryReturnCount({ ...judged, unavailable: 2 }), { count: 3, atLeast: true });
});

test('latest compaction selection follows ordinal when the array is reversed', () => {
  const detail = sessionCompactionContextDetail([
    compactionFact({ ordinal: 2, at: NOW - 60_000, trigger: 'auto' }),
    compactionFact({ ordinal: 1, at: NOW, trigger: 'manual' }),
  ]);
  assert.deepEqual(detail, { entries: [{ label: 'Latest compaction', value: 'Automatic' }] });
});

test('latest compaction selection ignores backward timestamps', () => {
  const detail = sessionCompactionContextDetail([
    compactionFact({ ordinal: 1, at: NOW, trigger: 'auto' }),
    compactionFact({ ordinal: 2, at: NOW - 60_000, trigger: 'manual' }),
  ]);
  assert.deepEqual(detail, { entries: [{ label: 'Latest compaction', value: 'Manual' }] });
});

test('latest compaction selection keeps a null timestamp on the greatest ordinal', () => {
  const detail = sessionCompactionContextDetail([
    compactionFact({ ordinal: 1, at: NOW, trigger: 'auto' }),
    compactionFact({ ordinal: 2, at: null, trigger: 'manual' }),
  ]);
  assert.deepEqual(detail, { entries: [{ label: 'Latest compaction', value: 'Manual' }] });
});

test('latest compaction shows a trigger Arc does not know as its recorded word', () => {
  const value = (trigger: string | null) =>
    sessionCompactionContextDetail([compactionFact({ trigger })])?.entries[0].value;
  assert.equal(value('manual'), 'Manual');
  assert.equal(value('auto'), 'Automatic');
  assert.equal(value('refusal'), 'After a refusal');
  assert.equal(value('scheduled'), 'Scheduled');
  assert.equal(value(''), 'Unknown');
  assert.equal(value(null), 'Unknown');
});

test('indexed compaction detail attaches to context and preserves its existing content', () => {
  const context = {
    metric: 'context' as const,
    compactLabel: '44% ctx',
    kind: 'plain' as const,
    label: '44% ctx',
    detail: 'Context: 12k\nLatest turn cached input reads: $0.39\nExisting caveat.',
    detailList: {
      entries: [
        { label: 'Context', value: '12k' },
        { label: 'Latest turn cached input reads', value: '$0.39' },
      ],
      footer: ['Existing caveat.'],
    },
  };
  const turns = sessionTurnStats({ turnCount: 22, compactionCount: 3, firstTurnAt: NOW - 60_000, lastTurnAt: NOW })[0];
  const merged = withSessionContextDetail(
    [turns, context],
    sessionCompactionContextDetail([compactionFact({ trigger: 'manual' })]),
  );
  assert.deepEqual(merged[1].detailList?.entries, [
    { label: 'Context', value: '12k' },
    { label: 'Latest turn cached input reads', value: '$0.39' },
    { label: 'Latest compaction', value: 'Manual' },
  ]);
  assert.deepEqual(merged[1].detailList?.footer, ['Existing caveat.']);
  assert.equal(
    merged[1].detail,
    'Context: 12k\nLatest turn cached input reads: $0.39\nLatest compaction: Manual\nExisting caveat.',
  );
  assert.deepEqual(merged[0], turns);
});

test('indexed compaction detail falls back to turns and preserves lifetime turn facts', () => {
  const turns = sessionTurnStats({ turnCount: 22, compactionCount: 3, firstTurnAt: NOW - 60_000, lastTurnAt: NOW })[0];
  const [merged] = withSessionContextDetail(
    [turns],
    sessionCompactionContextDetail([compactionFact({ trigger: 'auto' })]),
  );
  assert.deepEqual(
    merged.detailList?.entries.map((entry) => entry.label),
    ['Turns in the main session', 'First to last turn', 'Compactions', 'Latest compaction'],
  );
  assert.equal(merged.detailList?.entries.at(-1)?.value, 'Automatic');
  assert.deepEqual(merged.detailList?.notes, [
    'The turn count excludes delegated work.',
    'Elapsed time includes gaps between turns.',
  ]);
  assert.equal(
    merged.detail,
    [
      'Turns in the main session: 22',
      'First to last turn: 1m',
      'Compactions: 3',
      'Latest compaction: Automatic',
      'The turn count excludes delegated work.',
      'Elapsed time includes gaps between turns.',
    ].join('\n'),
  );
  assert.match(merged.detail, /The turn count excludes delegated work\./);
  assert.match(merged.detail, /Elapsed time includes gaps between turns\./);
});

test('absent indexed compaction evidence adds no row or fallback detail', () => {
  const turns = sessionTurnStats({ turnCount: 1, compactionCount: 7, firstTurnAt: null, lastTurnAt: null })[0];
  assert.equal(sessionCompactionContextDetail([]), null);
  assert.deepEqual(withSessionContextDetail([turns], sessionCompactionContextDetail([])), [turns]);
});

// Join the step label and code in their spoken order.

const said = (s: TurnStep): string => [stepLine(s), stepCode(s)].filter(Boolean).join(' ');
const costLines = (...texts: string[]) =>
  texts.map((text) => {
    const rate = text.match(/^(.*)( [(]([0-9]+)% cached(?: · [^)]+)?[)])$/);
    const scale = rate?.[2].match(/ · ([0-9]+) requests? · ([0-9,.]+)([kMB]?) avg input/);
    const multipliers: Record<string, number> = { '': 1, k: 1_000, M: 1_000_000, B: 1_000_000_000 };
    return rate
      ? {
          text: rate[1],
          cost: true as const,
          cacheHit: {
            percent: Number(rate[3]),
            warning: false,
            ...(scale
              ? {
                  requestScale: [Number(scale[1]), Number(scale[2].replace(',', '')) * multipliers[scale[3]]] as [
                    number,
                    number,
                  ],
                }
              : {}),
          },
        }
      : { text, cost: true as const };
  });

const agent = (over: Partial<TurnAgent> = {}): TurnAgent => ({
  id: null,
  description: 'Audit the parser',
  agentType: 'Explore',
  model: 'claude-haiku-4-5-20251001',
  effort: null,
  spend: [],
  spendFound: false,
  spendPartial: false,
  durationMs: null,
  tokens: null,
  toolUses: null,
  status: 'completed',
  ...over,
});

// Read the card's cost figure label.
const costChip = (card: TurnCard): string | undefined => card.chips.find((c) => c.label.startsWith('$'))?.label;

// Read the card's context figure.
const ctxChip = (card: TurnCard) => card.chips.find((c) => c.label.includes('ctx'));

test('a child commit stays attributed while the turn counts each sha once', () => {
  const card = toCard(subagentCommitTurn(), false, NOW);
  const commits = card.chips.find((chip) => chip.metric === 'commits');
  assert.equal(card.agents[0].figures.find((figure) => figure.metric === 'commits')?.compactLabel, '2 commits');
  assert.deepEqual([commits?.label, commits?.name], ['2 commits', '2 commits, 2 made by a subagent']);
  assert.deepEqual(
    card.commits.map((commit) => [commit.sha, commit.madeBy]),
    [
      ['abc1234a', 'Parser reviewer'],
      ['def5678', 'Parser reviewer'],
    ],
  );
  assert.doesNotMatch(card.commits[0].detail, /made by/, 'the maker line leaves the hover to the name on the row');
  assert.doesNotMatch(
    commitRowSpoken(card.commits[0]),
    /made by Parser reviewer/,
    'the hidden time text repeats attribution that the visible facts already announce',
  );
  assert.equal(sessionStats([subagentCommitTurn()], []).find((chip) => chip.metric === 'commits')?.label, '2 commits');
  const childOnly = subagentCommitTurn();
  childOnly.commits = [];
  assert.equal(sessionStats([childOnly], []).find((chip) => chip.metric === 'commits')?.label, '2 commits');
  const parentOnly = subagentCommitTurn();
  parentOnly.agents = [];
  assert.equal(toCard(parentOnly, false, NOW).chips.find((chip) => chip.metric === 'commits')?.name, '1 commit');
});

test('commit-row projection preserves child attribution and landing order without reading response or activity', () => {
  const subject = subagentCommitTurn();
  subject.landings = [
    {
      id: 'merge:landing',
      sha: 'bbbb2222',
      subject: 'Land topic',
      from: 'topic',
      head: { kind: 'branch', name: 'main' },
      at: Math.max(...toCard(subject, false, NOW).commits.map((row) => row.at)) + 1,
      place: null,
      dir: 'c:/repo',
    },
  ];
  const expected = toCard(subject, false, NOW, ['c:/repo']).commits;
  for (const field of ['summary', 'steps', 'files'])
    Object.defineProperty(subject, field, {
      get() {
        throw new Error(`commit projection read ${field}`);
      },
    });
  assert.deepEqual(commitRowsOf(subject, NOW, ['c:/repo']).rows, expected);
  assert.equal(expected.at(-1)?.kind, 'landing');
  assert.ok(expected.some((row) => row.madeBy));
});

test('a native Codex child supplies both commit rows behind its two-commit figure', () => {
  const file = path.join(tempDir('codex-child-commits-'), 'child.jsonl');
  const record = (type: string, second: number, payload: Record<string, unknown>) => ({
    timestamp: new Date(NOW - 60_000 + second * 1000).toISOString(),
    type,
    payload,
  });
  const records = [
    record('session_meta', 0, { id: 'child', cwd: 'C:/repo', source: 'vscode' }),
    record('event_msg', 1, { type: 'task_started', turn_id: 'child-turn' }),
    record('turn_context', 2, { turn_id: 'child-turn', cwd: 'C:/repo', model: 'gpt-6.1-sol' }),
    record('event_msg', 3, { type: 'user_message', message: 'Fix the parser.' }),
    ...['abc1234', 'def5678'].map((sha, index) =>
      record('event_msg', 4 + index, {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: `commit-${index}`,
          command: 'git commit -m fix',
          status: 'completed',
          exit_code: 0,
          cwd: 'C:/repo',
          stdout: `[main ${sha}] ${index === 0 ? 'Fix the parser' : 'Cover child commits'}\n 1 file changed, 1 insertion(+)`,
        },
      }),
    ),
    record('event_msg', 8, { type: 'task_complete', turn_id: 'child-turn', last_agent_message: 'Finished.' }),
  ];
  fs.writeFileSync(file, records.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const cache = new AgentSpendCache();
  const parent = turn({ agent: 'codex', commits: [], agents: [agent({ id: 'child', description: 'Parser fixer' })] });
  refreshCodexStructuralAgents([parent], 'parent', [], () =>
    readChildSpend(cache, file, 'completed', spendFileVersion(file), readCodexAgentSpend, 'native', false, NOW),
  );
  const card = toCard(parent, false, NOW);
  assert.equal(card.agents[0].figures.find((figure) => figure.metric === 'commits')?.compactLabel, '2 commits');
  assert.equal(card.chips.find((figure) => figure.metric === 'commits')?.label, '2 commits');
  assert.equal(sessionStats([parent], []).find((figure) => figure.metric === 'commits')?.label, '2 commits');
  assert.deepEqual(
    card.commits.map(({ sha, subject, madeBy }) => [sha, subject, madeBy]),
    [
      ['abc1234', 'Fix the parser', 'Parser fixer'],
      ['def5678', 'Cover child commits', 'Parser fixer'],
    ],
  );
  parent.commits.push({ ...parent.agents[0].commits![0], sha: 'abc1234a' });
  assert.equal(toCard(parent, false, NOW).commits.length, 2);
  assert.equal(sessionStats([parent], []).find((figure) => figure.metric === 'commits')?.label, '2 commits');
});

test('the opening card text distinguishes reader prompts from subagent assignments', () => {
  const prompt = toCard(turn({ prompt: 'Check the parser.' }), false, NOW);
  assert.deepEqual(
    [prompt.prompt, prompt.delegation, prompt.promptHeading, prompt.promptNotice],
    ['Check the parser.', '', 'You asked', ''],
  );

  const complete = toCard(turn({ prompt: '', delegation: { text: 'Review the parser.', complete: true } }), false, NOW);
  assert.deepEqual(
    [complete.prompt, complete.delegation, complete.promptHeading, complete.promptNotice],
    ['', 'Review the parser.', 'Assigned task', ''],
  );

  const incomplete = toCard(
    turn({
      prompt: '',
      delegation: { text: '/root/review_parser', complete: false },
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    [incomplete.prompt, incomplete.delegation, incomplete.promptHeading, incomplete.promptNotice],
    ['', '/root/review_parser', 'Assigned task', 'Full instructions unavailable in this session'],
  );

  const mixed = toCard(
    turn({
      prompt: 'Check the reader-visible result.',
      delegation: { text: '/root/review_parser', complete: false },
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    [mixed.prompt, mixed.delegation, mixed.promptHeading, mixed.promptNotice],
    ['Check the reader-visible result.', '/root/review_parser', 'You asked', ''],
  );
});

test('a completed write-heavy turn carries warning metadata beneath its main-agent cost entry', () => {
  const usage = {
    requests: 5,
    input: 0,
    cacheWrite1h: 2_000_000,
    cacheWrite5m: 0,
    cacheRead: 100_000,
    output: 0,
    thinking: 0,
  };
  const card = toCard(
    turn({
      model: 'claude-sonnet-5',
      usage,
      usageParts: [
        {
          model: 'claude-sonnet-5',
          provider: null,
          contextWindow: null,
          contextBand: null,
          inferenceClass: null,
          serviceTier: null,
          usage,
        },
      ],
    }),
    false,
    NOW,
  );
  const cost = card.chips.find((chip) => chip.metric === 'cost')!;
  assert.equal(cost.warnings?.length, 1);
  assert.deepEqual(cost.detailList?.entries[0].lines?.[0], {
    text: 'Low cache reuse in this session: $8.00 of $8.02 went to cache writes',
    warning: true,
  });
  assert.match(cost.name ?? '', /Low cache reuse in this session/);
});

test('one completed write-heavy child lights the turn cost chip without pooling child scopes', () => {
  const usage = {
    requests: 5,
    input: 0,
    cacheWrite1h: 2_000_000,
    cacheWrite5m: 0,
    cacheRead: 100_000,
    output: 0,
    thinking: 0,
  };
  const usagePart = {
    model: 'claude-sonnet-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const card = toCard(
    turn({
      usage: { requests: 1, input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
      usageParts: [],
      agents: [
        agent({
          description: 'Audit the parser',
          spendFound: true,
          spend: [{ model: 'claude-sonnet-5', usage, usageParts: [usagePart] }],
        }),
        agent({
          description: 'Check the renderer',
          spendFound: true,
          spend: [
            {
              model: 'claude-sonnet-5',
              usage: { ...usage, requests: 4 },
              usageParts: [{ ...usagePart, usage: { ...usage, requests: 4 } }],
            },
          ],
        }),
      ],
    }),
    false,
    NOW,
  );
  const cost = card.chips.find((chip) => chip.metric === 'cost')!;
  assert.deepEqual(
    cost.warnings?.map((warning) => warning.scope),
    ['delegated'],
  );
  assert.match(cost.detailList?.entries[1].label ?? '', /Audit the parser/);
  assert.match((cost.detailList!.entries[1].lines![0] as { text: string }).text, /Low cache reuse in delegated work/);
  assert.match(cost.detailList?.entries[2].label ?? '', /Check the renderer/);
  assert.equal(
    cost.detailList?.entries[2].lines?.some((line) => typeof line === 'object' && 'warning' in line),
    false,
  );
});

test('mixed exact main and child identities keep the cost chip and warning evidence consistent', () => {
  const heavy = {
    requests: 5,
    input: 0,
    cacheWrite1h: 2_000_000,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 100_000,
    output: 0,
    thinking: 0,
  };
  const light = {
    requests: 1,
    input: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 1_000_000,
    output: 0,
    thinking: 0,
  };
  const heavyPart = {
    model: 'claude-sonnet-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: 'in-region' as const,
    serviceTier: 'standard',
    usage: heavy,
  };
  const lightPart = {
    model: 'claude-haiku-4-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage: light,
  };
  const combined = {
    requests: 6,
    input: 0,
    cacheWrite1h: 2_000_000,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 1_100_000,
    output: 0,
    thinking: 0,
  };
  const card = toCard(
    turn({
      model: 'claude-haiku-4-5',
      usage: combined,
      usageParts: [heavyPart, lightPart],
      agents: [
        agent({
          spendFound: true,
          spend: [{ model: 'claude-haiku-4-5', usage: combined, usageParts: [heavyPart, lightPart] }],
        }),
      ],
    }),
    false,
    NOW,
  );
  const cost = card.chips.find((chip) => chip.metric === 'cost')!;
  assert.equal(cost.label, '$18');
  assert.deepEqual(
    cost.warnings
      ?.filter((warning) => 'cacheWriteCost' in warning)
      .map((warning) => [warning.scope, warning.cacheWriteCost, warning.scopeCost]),
    [
      ['main', 8.8, 8.922],
      ['delegated', 8.8, 8.922],
    ],
  );
  assert.match(cost.detail, /Main agent · sonnet-5, haiku-4-5: \$8\.92/);
  assert.match(cost.detail, /Audit the parser · sonnet-5, haiku-4-5: \$8\.92/);
});

test('nested delegated costs keep the direct child warning eligible while the total remains a floor', () => {
  const usage = {
    requests: 5,
    input: 0,
    cacheWrite1h: 2_000_000,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 100_000,
    output: 0,
    thinking: 0,
  };
  const usagePart = {
    model: 'claude-sonnet-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const card = toCard(
    turn({
      agents: [
        agent({
          spendFound: true,
          spendPartial: true,
          spend: [{ model: 'claude-sonnet-5', usage, usageParts: [usagePart] }],
        }),
      ],
    }),
    false,
    NOW,
  );
  const cost = card.chips.find((chip) => chip.metric === 'cost')!;
  assert.equal(cost.label, '$8.02+');
  assert.deepEqual(
    cost.warnings?.map((warning) => warning.scope),
    ['delegated'],
  );
});

test('an incomplete direct child request suppresses its cache-write warning', () => {
  const usage = {
    requests: 5,
    input: 0,
    cacheWrite1h: 2_000_000,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 100_000,
    output: 0,
    thinking: 0,
  };
  const usagePart = {
    model: 'claude-sonnet-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const card = toCard(
    turn({
      agents: [
        agent({
          spendFound: true,
          spendIncomplete: true,
          spend: [{ model: 'claude-sonnet-5', usage, usageParts: [usagePart] }],
        }),
      ],
    }),
    false,
    NOW,
  );
  const cost = card.chips.find((chip) => chip.metric === 'cost');
  assert.equal(cost?.warnings, undefined);
  assert.equal(cost?.label, '$8.02+');
});

test('an inexact linked invocation does not suppress a complete direct child warning', () => {
  const usage = {
    requests: 5,
    input: 0,
    cacheWrite1h: 2_000_000,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 100_000,
    output: 0,
    thinking: 0,
  };
  const direct = {
    model: 'claude-sonnet-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const linked = { ...direct, linkedInvocationId: 'nested', requestCountExact: false as const };
  const card = toCard(
    turn({
      agents: [
        agent({
          spendFound: true,
          spend: [
            {
              model: 'claude-sonnet-5',
              usage: { ...usage, requests: 10, cacheWrite1h: 4_000_000, cacheRead: 200_000 },
              usageParts: [direct, linked],
            },
          ],
        }),
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    card.chips
      .find((chip) => chip.metric === 'cost')
      ?.warnings?.map((warning) => ('id' in warning ? warning.id : undefined)),
    ['0:direct'],
  );
});

test('exact direct child detail stays consistent beside a recorded nested result', () => {
  const usage = {
    requests: 5,
    input: 0,
    cacheWrite1h: 2_000_000,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 100_000,
    output: 0,
    thinking: 0,
  };
  const direct = {
    model: 'claude-sonnet-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const card = toCard(
    turn({
      agents: [
        agent({
          spendFound: true,
          spend: [
            { model: 'claude-haiku-4-5', usage, usageParts: [direct] },
            {
              model: 'claude-opus-5',
              recordedCost: 3.24,
              costBasis: 'list',
              usage: {
                requests: 1,
                input: 0,
                cacheWrite1h: 0,
                cacheWrite5m: 0,
                cacheWrite30m: 0,
                cacheRead: 0,
                output: 0,
                thinking: 0,
              },
            },
          ],
        }),
      ],
    }),
    false,
    NOW,
  );
  const cost = card.chips.find((chip) => chip.metric === 'cost')!;
  assert.equal(cost.label, '$11');
  assert.match(cost.detail, /Audit the parser · sonnet-5: \$8\.02/);
  assert.match(cost.detail, /Audit the parser .* opus-5: \$3\.24/);
});

// Context bands carry a level, a word, and tooltip text because color alone conveys no accessible information.

const bandAt = (share: number) => {
  const window = 1_000_000; // opus-5
  const chip = ctxChip(toCard(turn({ contextTokens: Math.round(window * share) }), false, NOW))!;
  return { level: chip.level, word: chip.word, kind: chip.kind, detail: chip.detail };
};

// Card mark IDs preserve the MARKS table order.

const markIds = (over: Partial<Turn>) => toCard(turn(over), false, NOW).marks.map((m) => m.id);

const changed = (path: string, added: number, removed: number) => ({ path, added, removed, isNew: false, edits: [] });

// Read figures and marks from a summary containing both closing rows.

const closingCard = (rows: string[]) => {
  const card = toCard(turn({ summary: ['- The work landed.', '', ...rows].join('\n'), toolUses: 1 }), false, NOW);
  return {
    labels: card.chips.map((c) => c.label),
    kinds: card.chips.map((c) => c.kind),
    marks: card.marks.map((m) => m.id),
  };
};

// Find a session-heading figure by its label prefix.

const statOf = (chips: { label: string; detail: string; added?: number; removed?: number }[], starts: string) =>
  chips.find((c) => c.label.startsWith(starts));

// Read the session-heading context detail.

const ctxDetail = (turns: Turn[], compactions: Compaction[] = []) =>
  sessionStats(turns, compactions).find((c) => c.label.includes('ctx'))?.detail ?? '';

const hoverLines = (turns: Turn[], compactions: Compaction[] = []) =>
  ctxDetail(turns, compactions)
    .split('\n')
    .map((line) => line.trim());

const step = (over: Partial<TurnStep> = {}): TurnStep => ({
  ordinal: 1,
  name: 'Read',
  detail: 'extension/src/store.ts',
  at: 1_700_000_000_000,
  status: 'done',
  ...over,
});

test('a share is rounded to nearest, with neither end reached by a figure short of it', () => {
  // Interior percentages round to the nearest whole number.

  assert.equal(wholePercent(0.4989), 50);
  assert.equal(wholePercent(0.735), 74);
  assert.equal(wholePercent(0.104), 10);
  // Only an empty or full window reports 0% or 100%.

  assert.equal(wholePercent(0.999), 99);
  assert.equal(wholePercent(1), 100);
  assert.equal(wholePercent(0.0004), 1);
  assert.equal(wholePercent(0), 0);
  // A share past the window passes through: an overrun says so rather than reading as full.
  assert.equal(wholePercent(1.5), 150);
  // Negative shares report zero.
  assert.equal(wholePercent(-0.2), 0);
});

test('every mark is one character and one id, and no two share either', () => {
  // Each mark needs a distinct ID and character.

  assert.equal(new Set(MARKS.map((m) => m.id)).size, MARKS.length);
  assert.equal(new Set(MARKS.map((m) => m.character)).size, MARKS.length);
  assert.ok(
    MARKS.every((m) => m.word.trim().length),
    'a mark with no word is silent to a screen reader',
  );
});

test('a symbol is read as one character, joined sequence and all, and taken off whole', () => {
  // Symbol parsing preserves Unicode code points instead of splitting surrogate pairs.

  assert.equal(leadingSymbol('\u{1F64B} Your turn.'), '\u{1F64B}');
  assert.equal(withoutLeadingSymbol('\u{1F64B} Your turn.'), 'Your turn.');
  // The selector after a symbol belongs to it and goes with it.
  assert.equal(leadingSymbol('⚠️ Careful.'), '⚠');
  assert.equal(withoutLeadingSymbol('⚠️ Careful.'), 'Careful.');
  // Removing a joined symbol also removes its trailing joiners, modifiers, and variation selectors.

  assert.equal(leadingSymbol('\u{1F64B}‍♂️ Your turn.'), '\u{1F64B}');
  assert.equal(withoutLeadingSymbol('\u{1F64B}‍♂️ Your turn.'), 'Your turn.');
  // A line that opens with anything else is left exactly as it is.
  assert.equal(leadingSymbol('Ordinary prose.'), null);
  assert.equal(withoutLeadingSymbol('Ordinary prose.'), 'Ordinary prose.');
  assert.equal(leadingSymbol(''), null);
  assert.equal(withoutLeadingSymbol('\u{1F984} An invented one.'), '\u{1F984} An invented one.');
});

test('a diff title says nothing extra when every file is an exact record of the turn', () => {
  assert.equal(diffTitle('Add the picker', 0, 0), 'Changes · Add the picker');
});

test('a diff title names the count of each file it cannot show exactly', () => {
  assert.equal(diffTitle('Add the picker', 2, 0), 'Changes · Add the picker · 2 may include earlier edits');
  assert.equal(diffTitle('Add the picker', 0, 3), 'Changes · Add the picker · 3 as hunks only');
  assert.equal(
    diffTitle('Add the picker', 1, 1),
    'Changes · Add the picker · 1 may include earlier edits, 1 as hunks only',
  );
});

test('a headline too long for a tab title is cut to fit, and one that fits is left alone', () => {
  const exact = 'x'.repeat(TITLE_HEADLINE_LIMIT);
  assert.equal(diffTitle(exact, 0, 0), 'Changes · ' + exact);
  const over = 'y'.repeat(TITLE_HEADLINE_LIMIT + 1);
  const cut = diffTitle(over, 0, 0).slice('Changes · '.length);
  assert.equal(cut.length, TITLE_HEADLINE_LIMIT, 'the cut title must not be longer than the limit');
  assert.equal(cut, 'y'.repeat(TITLE_HEADLINE_LIMIT - 1) + '…');
});

test('a headline is cut between characters, so a tab title never shows half an emoji', () => {
  // A title must not end with an unmatched high surrogate.

  const halfACharacter = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  const title = (headline: string) => diffTitle(headline, 0, 0).slice('Changes · '.length);

  // The emoji straddles the cut, so a count of code units ends on its first half.
  const straddling = 'y'.repeat(TITLE_HEADLINE_LIMIT - 2) + '\u{1F6A7} and the rest of it';
  assert.ok(!halfACharacter.test(title(straddling)), 'the tab title carries half a character');
  assert.equal(title(straddling), 'y'.repeat(TITLE_HEADLINE_LIMIT - 2) + '…');

  // One place earlier the emoji is whole, and is kept whole.
  const whole = 'y'.repeat(TITLE_HEADLINE_LIMIT - 3) + '\u{1F6A7} and the rest of it';
  assert.equal(title(whole), 'y'.repeat(TITLE_HEADLINE_LIMIT - 3) + '\u{1F6A7}…');
  assert.ok(title(whole).length <= TITLE_HEADLINE_LIMIT, 'the cut title is longer than the limit');
});

test('a file row is named by its basename, until two of them collide', () => {
  assert.deepEqual(distinctNames(['c:/repo/src/store.ts', 'c:/repo/docs/plan.md']), ['store.ts', 'plan.md']);
  // Both grow, and only as far as they have to: the third row is already distinct.
  assert.deepEqual(distinctNames(['c:/repo/a/index.ts', 'c:/repo/b/index.ts', 'c:/repo/one.ts']), [
    'a/index.ts',
    'b/index.ts',
    'one.ts',
  ]);
  // One segment is not always enough.
  assert.deepEqual(distinctNames(['c:/repo/x/src/index.ts', 'c:/repo/y/src/index.ts']), [
    'x/src/index.ts',
    'y/src/index.ts',
  ]);
  // Paths accept both slash spellings.

  assert.deepEqual(distinctNames(['c:\\repo\\a\\index.ts', 'c:/repo/b/index.ts']), ['a/index.ts', 'b/index.ts']);
  // Identical paths retain their full names because no directory suffix distinguishes them.

  assert.deepEqual(distinctNames(['c:/repo/a.ts', 'c:/repo/a.ts']), ['c:/repo/a.ts', 'c:/repo/a.ts']);
  assert.deepEqual(distinctNames([]), []);
});

test('a file no open folder holds is drawn by its whole path, and said as one too', () => {
  const inside = 'c:/repo/src/store.ts';
  const outside = 'c:/Users/dev/AppData/Local/Temp/scratch/notes.md';
  // Outside files retain their full paths even when their basenames match files inside the workspace.

  assert.deepEqual(fileRowNames([inside, outside], ['c:/repo']), [
    { name: 'store.ts', spoken: 'store.ts' },
    { lead: 'c:/Users/dev/AppData/Local/Temp/scratch/', name: 'notes.md', spoken: outside },
  ]);
  // Colliding basenames grow across all open folders.

  assert.deepEqual(fileRowNames(['c:/repo/src/index.ts', 'c:/other/src/index.ts', outside], ['c:/repo', 'c:/other']), [
    { name: 'index.ts', spoken: 'repo/src/index.ts' },
    { name: 'index.ts', spoken: 'other/src/index.ts' },
    { lead: 'c:/Users/dev/AppData/Local/Temp/scratch/', name: 'notes.md', spoken: outside },
  ]);
  // A folder path counts as inside that folder.

  assert.deepEqual(fileRowNames(['c:/repo'], ['c:/repo']), [{ name: 'repo', spoken: 'repo' }]);
  // A sibling folder whose name starts with the open one's is not inside it.
  assert.deepEqual(fileRowNames(['c:/repo-two/a.ts'], ['c:/repo']), [
    { lead: 'c:/repo-two/', name: 'a.ts', spoken: 'c:/repo-two/a.ts' },
  ]);
  // Without open folders, file rows use basename labels.

  assert.deepEqual(fileRowNames([inside, outside], []), [
    { name: 'store.ts', spoken: 'store.ts' },
    { name: 'notes.md', spoken: 'notes.md' },
  ]);
});

test('the inside test reads a path in either spelling, and the drive letter in either case', () => {
  // Folder membership accepts both slash spellings and drive-letter case differences.

  assert.deepEqual(fileRowNames(['c:\\repo\\src\\store.ts'], ['c:/repo']), [{ name: 'store.ts', spoken: 'store.ts' }]);
  assert.deepEqual(fileRowNames(['c:/repo/src/store.ts'], ['c:\\repo']), [{ name: 'store.ts', spoken: 'store.ts' }]);
  assert.deepEqual(fileRowNames(['C:/repo/src/store.ts'], ['c:/repo']), [{ name: 'store.ts', spoken: 'store.ts' }]);
  // Outside paths use forward slashes in their visible and spoken names.

  const outside = 'c:\\Users\\dev\\AppData\\Local\\Temp\\notes.md';
  assert.deepEqual(fileRowNames([outside], ['c:/repo']), [
    { lead: 'c:/Users/dev/AppData/Local/Temp/', name: 'notes.md', spoken: 'c:/Users/dev/AppData/Local/Temp/notes.md' },
  ]);
});

test('only the rows that will draw a basename are told apart from one another', () => {
  // An outside path does not force a workspace file's basename to grow.

  assert.deepEqual(fileRowNames(['c:/repo/notes.md', 'c:/temp/notes.md'], ['c:/repo']), [
    { name: 'notes.md', spoken: 'notes.md' },
    { lead: 'c:/temp/', name: 'notes.md', spoken: 'c:/temp/notes.md' },
  ]);
  // Outside rows preserve the positions of disambiguated workspace names.

  assert.deepEqual(fileRowNames(['c:/repo/a/index.ts', 'c:/temp/index.ts', 'c:/repo/b/index.ts'], ['c:/repo']), [
    { name: 'index.ts', spoken: 'a/index.ts' },
    { lead: 'c:/temp/', name: 'index.ts', spoken: 'c:/temp/index.ts' },
    { name: 'index.ts', spoken: 'b/index.ts' },
  ]);
});

test('a row drawn by its whole path hands over the directory and the filename separately', () => {
  const outside = 'c:/Users/dev/AppData/Local/Temp/scratch/notes.md';
  // Separate directory and filename fields let the row truncate the directory while retaining the filename.

  assert.deepEqual(fileRowNames([outside], ['c:/repo']), [
    { lead: 'c:/Users/dev/AppData/Local/Temp/scratch/', name: 'notes.md', spoken: outside },
  ]);
  // Backslash paths normalize before their directory and filename fields are split.

  const back = 'c:\\Users\\dev\\AppData\\Local\\Temp\\notes.md';
  assert.deepEqual(fileRowNames([back], ['c:/repo']), [
    { lead: 'c:/Users/dev/AppData/Local/Temp/', name: 'notes.md', spoken: 'c:/Users/dev/AppData/Local/Temp/notes.md' },
  ]);
  // Workspace rows have no separate directory prefix.
  assert.deepEqual(fileRowNames(['c:/repo/src/store.ts'], ['c:/repo']), [{ name: 'store.ts', spoken: 'store.ts' }]);
  // And so is a path with no directory in front of the filename.
  assert.deepEqual(fileRowNames(['notes.md'], ['c:/repo']), [{ name: 'notes.md', spoken: 'notes.md' }]);
});

test('every control the panel can be operated with has something to be called', () => {
  // Nested action tables contain labels at their leaves.

  const leaves: [string, unknown][] = [];
  const walk = (name: string, value: unknown): void => {
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        walk(`${name}.${key}`, inner);
      }
      return;
    }
    leaves.push([name, value]);
  };
  for (const [key, value] of Object.entries(CARD_ACTIONS)) {
    walk(key, value);
  }
  assert.ok(leaves.length > 0, 'the label table is empty');
  for (const [key, label] of leaves) {
    assert.equal(typeof label, 'string', `${key} is not a string`);
    if (typeof label !== 'string') {
      continue;
    }
    assert.match(label, /\S/, `${key} would be read out as nothing`);
  }
  assert.equal(CARD_ACTIONS.expandShownDetail, 'Shift+click or Shift+Enter expands every shown turn');
  assert.equal(CARD_ACTIONS.collapseShownDetail, 'Shift+click or Shift+Enter collapses every shown turn');
});

// Closing rows distinguish reader actions from explicit statements that nothing remains open.

test('a row that says it holds nothing is not something waiting on the reader', () => {
  // Explicit negations describe a closing row with no reader action.

  const nothing = [
    'none blocking. Items 1 and 2 can start whenever the other session frees turnview.ts.',
    'None for me. Both decisions are settled and recorded.',
    'nothing right now; I will report when the icons land.',
    'none open.',
  ];
  for (const text of nothing) {
    assert.equal(waitingOn(`- 🙋 **Your actions** — ${text}`).needsYou, false, text);
  }
  // A row with an action remains actionable even when it also describes work that is unblocked.

  const waiting = [
    'reload the window, then open a turn and confirm the badge.',
    'decide the icon question above; nothing else is blocked on you.',
    'answer the two open questions below so phase 1 can start',
  ];
  for (const text of waiting) {
    assert.equal(waitingOn(`- 🙋 **Your actions** — ${text}`).needsYou, true, text);
  }
  // Negation words require a word boundary.

  assert.equal(waitingOn('- 🙋 **Your actions** — Nonetheless, decide the icon set.').needsYou, true);
  assert.equal(waitingOn('- 🙋 **Your actions** — Note the two questions below.').needsYou, true);
});

test('a summary with no closing row at all is waiting on nothing', () => {
  assert.deepEqual(waitingOn('- Done, and the suite is green.'), {
    needsYou: false,
    questions: false,
    questionCount: null,
  });
});

test('questions are counted from the numbering the row was written with', () => {
  assert.equal(enumeratedCount('(1) keep the store? (2) rename the view?'), 2);
  assert.equal(enumeratedCount('(1) first (2) second (3) third (4) fourth'), 4);
  // Unnumbered questions have no inferred count.
  assert.equal(enumeratedCount('whether to keep the store, and what to call it.'), null);
  assert.equal(enumeratedCount('the three above.'), null);
  // A single numbering marker does not establish a question list.
  assert.equal(enumeratedCount('only one thing: (1) the store.'), null);
  // Question counts require consecutive numbering starting at one.
  assert.equal(enumeratedCount('as in (2) and (3) above'), null);
  assert.equal(enumeratedCount('(1) first (3) third'), null);
});

test('a session with no turns read has nothing to say about itself', () => {
  assert.deepEqual(sessionStats([], []), []);
});

test('the log names a mid-turn prompt without printing the whole of it twice', () => {
  // The Activity row uses the prompt's first line and limits its length.

  const long = 'a'.repeat(STEP_DETAIL_LIMIT + 40);
  const row = askLine({
    stepsBefore: 0,
    text: `${long}
and a second line`,
    at: 1,
  });
  assert.ok(row.startsWith('You asked: '), 'the row never says whose it is');
  assert.ok(
    row.length <= STEP_DETAIL_LIMIT + 'You asked: '.length,
    'a long prompt was drawn at full length in the log',
  );
  assert.ok(!row.includes('and a second line'), 'the row took more than the first line of the prompt');
});

test('a card names the agent that recorded it, in the badge and in what it is announced by', () => {
  const claude = toCard(turn(), false, NOW);
  const codex = toCard(turn({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }), false, NOW);
  assert.equal(claude.agent, 'Claude');
  assert.equal(codex.agent, 'Codex');
  // The card's accessible name includes the agent word alongside its model.

  assert.match(codex.label, /Codex gpt-5\.6-sol high/);
  assert.match(claude.label, /Claude opus-5/);
});

test('a Codex turn that ran commands and recorded no files is marked as a gap, and a Claude one is not', () => {
  const ran = { toolCounts: counts({ commands: 6 }), files: [] };
  const gap = (t: Turn) => toCard(t, false, NOW).marks.some((m) => m.id === 'gap');
  assert.equal(gap(turn({ agent: 'codex', ...ran })), true);
  // A Claude turn with commands and no recorded files carries no gap mark.

  assert.equal(gap(turn({ agent: 'claude', ...ran })), false);
  // A Codex turn that did record a change has no gap to report.
  assert.equal(
    gap(
      turn({
        agent: 'codex',
        toolCounts: counts({ commands: 6 }),
        files: [{ path: 'c:/repo/a.ts', added: 1, removed: 0, isNew: false, edits: [] }],
      }),
    ),
    false,
  );
  // A Codex turn with no commands carries no command-related gap mark.
  assert.equal(gap(turn({ agent: 'codex', toolCounts: counts({ edits: 2 }), files: [] })), false);
  // The gap mark includes an accessible word.
  const mark = MARKS.find((m) => m.id === 'gap');
  assert.equal(mark?.word, 'a gap in what it recorded');
});

test('the window a turn recorded beats the one the price table would have guessed', () => {
  // The recorded 258,400-token window puts 200,000 tokens at 77%. The 272,000-token fallback puts them at 74%, in a different band.

  const recorded = toCard(
    turn({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      contextTokens: 200_000,
      contextWindow: 258_400,
    }),
    false,
    NOW,
  );
  const chip = recorded.chips.find((c) => c.label.includes(' ctx '));
  assert.equal(chip?.label, '77% of 258k ctx (200k)');
  assert.equal(chip?.level, 'gettingFull');
  // The tooltip identifies the recorded window separately from the model fallback.

  assert.match(chip?.detail ?? '', /77% of 258k[\s\S]*Recorded context window size/);
  // An absent recorded window uses the pricing table's model window.

  const tabled = toCard(
    turn({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      contextTokens: 200_000,
      contextWindow: null,
    }),
    false,
    NOW,
  );
  const fallback = tabled.chips.find((c) => c.label.includes(' ctx '));
  assert.equal(fallback?.label, '74% of 272k ctx (200k)');
  assert.equal(fallback?.level, 'filling', 'the two windows no longer put the share in two bands');
  assert.match(fallback?.detail ?? '', /74% of 272k[\s\S]*model fallback for gpt-5\.6-sol/);
});

// Quiet-window checks use the fixture turn's end time.

const TURN_END = turn().endedAt;

test('status separates a finished turn from a failed, stopped, running or cut-short one', () => {
  assert.equal(statusOf(turn({ summary: 'Done.' }), false), 'done');
  assert.equal(statusOf(turn({ error: 'Overloaded.' }), false), 'failed');
  assert.equal(statusOf(turn({ finished: false, interrupted: true }), false), 'interrupted');
  // A stopped turn with a closing response counts as answered.
  assert.equal(statusOf(turn({ interrupted: true }), false), 'done');
  // Mid-turn text leaves the newest unfinished turn running.
  assert.equal(statusOf(turn({ finished: false, summary: 'Working on it.' }), true, TURN_END), 'running');
  assert.equal(statusOf(turn({ finished: false }), false, TURN_END), 'stopped');
  const processEndedAt = TURN_END + 4 * 60_000;
  const stopped = turn({ startedAt: TURN_END, endedAt: TURN_END + 60_000, processEndedAt, finished: false });
  assert.equal(statusOf(stopped, true, TURN_END + 90_000), 'stopped');
  const card = toCard(stopped, true, TURN_END + 90_000);
  assert.equal(card.duration, '4m');
  assert.equal(card.endedAt, stopped.endedAt, 'the process boundary must not replace the turn activity time');
  assert.equal(statusOf({ ...stopped, finished: true }, true), 'done');
  assert.equal(statusOf({ ...stopped, interrupted: true }, true), 'interrupted');
});

test('a turn that has recorded nothing for an hour has been left unfinished, not left running', () => {
  // An unfinished newest turn stays running through its quiet deadline and stops after it.

  const abandoned = turn({ finished: false, interrupted: false, error: null });
  assert.equal(
    statusOf(abandoned, true, TURN_END + TURN_QUIET_MS),
    'running',
    'a turn goes quiet inside the window and is still the one running',
  );
  assert.equal(
    statusOf(abandoned, true, TURN_END + TURN_QUIET_MS + 1),
    'stopped',
    'a turn nothing has written to for an hour is still drawn as running',
  );
  // A stopped card accepts read state and exposes the unread menu section.

  const dead = toCard(abandoned, true, TURN_END + TURN_QUIET_MS + 1);
  assert.equal(dead.live, false, 'the card still counts its duration up from a dead agent');
  assert.equal(canMarkRead(dead), true, 'the reader still has no way to mark the session read');
  assert.equal(
    turnMenuSection(dead, false),
    TURN_MENU_SECTIONS.unread,
    'the card still offers no entry for marking it read',
  );
  // Recent unfinished turns remain live and cannot be marked read.
  const busy = toCard(abandoned, true, TURN_END + 60_000);
  assert.equal(busy.live, true);
  assert.equal(canMarkRead(busy), false);
});

test('a turn cut off in the middle of a call stops saying it is on that call', () => {
  // A running step supplies both card clocks until the unfinished turn passes its quiet deadline.

  const cut = turn({
    finished: false,
    steps: [step({ name: 'Bash', detail: 'npm test', status: 'running' })],
    stepCount: 1,
  });
  const working = toCard(cut, true, TURN_END + 60_000);
  assert.equal(working.doing, 'Running');
  assert.equal(working.doingCode, 'npm test');
  assert.equal(working.doingSince, cut.steps[0].at, 'the folded card has stopped naming the call in flight');
  assert.equal(working.activity[0].since, cut.steps[0].at, 'the log has stopped counting the call in flight');

  const dead = toCard(cut, true, TURN_END + TURN_QUIET_MS + 1);
  assert.equal(dead.status, 'stopped');
  assert.equal(dead.doing, '', 'the card says the turn was left unfinished and names a command it is still on');
  assert.equal(dead.doingSince, null, 'the folded clock counts up from a process that is gone');
  assert.equal(dead.activity[0].since, null, 'the log counts up from a process that is gone');
  assert.equal(dead.activity[0].line, 'Running', 'the call left the log with the clock');
});

test('the poll is woken by a turn going quiet, and by nothing else about it', () => {
  // Crossing the quiet deadline triggers a refresh even when the source listing is unchanged.

  const dying = [turn({ finished: false })];
  const deadline = TURN_END + TURN_QUIET_MS;

  assert.equal(
    statusMoved(dying, deadline, deadline + 1),
    true,
    'the turn crossed the window between two polls and the poll slept through it',
  );
  assert.equal(
    statusMoved(dying, deadline - 2, deadline - 1),
    false,
    'a poll inside the window rebuilds every card for nothing',
  );
  assert.equal(
    statusMoved(dying, deadline + 1, deadline + 60_000),
    false,
    'a turn already past the window wakes the poll again on every tick',
  );
  const metadataOnly = [{ finished: false, error: false, interrupted: false, endedAt: TURN_END }];
  assert.equal(
    statusMoved(metadataOnly, deadline, deadline + 1),
    true,
    'a session outside the parse cut crosses the quiet window without waking the rail',
  );

  // The first refresh has no previous clock to compare.
  assert.equal(statusMoved(dying, 0, deadline + 1), false, 'the first refresh compares against a clock nobody set');

  // A clock moving backward across the deadline also changes status.

  assert.equal(statusMoved(dying, deadline + 1, deadline), true);

  // A session whose turn already ended is not woken by the clock at all.
  assert.equal(statusMoved([turn({ summary: 'Done.' })], deadline, deadline + 60_000), false);
  assert.equal(statusMoved([], 0, deadline + 1), false, 'a panel with nothing parsed still asks for a repaint');
});

test('a turn whose end time could not be read keeps the word it had', () => {
  // An unreadable timestamp is zero, which must not expire a newest unfinished turn.

  const untimed = turn({ finished: false, endedAt: 0 });
  assert.equal(
    statusOf(untimed, true, TURN_END + TURN_QUIET_MS + 1),
    'running',
    'a turn with no readable end time is aged out of running on sight',
  );
  assert.equal(statusOf(untimed, false, TURN_END), 'stopped', 'the zero now outranks the turn not being the newest');
  // A clock behind the turn is the other direction, and it must not read as old either.
  const ahead = turn({ finished: false, endedAt: TURN_END + TURN_QUIET_MS * 2 });
  assert.equal(statusOf(ahead, true, TURN_END), 'running');
});

test('the tool mix is ordered by how much of the turn each kind was', () => {
  assert.equal(toolMixOf(counts({ edits: 3, commands: 12, reads: 5 })), '12 run · 5 read · 3 edit');
  assert.equal(
    toolMixOf(counts({ agents: 2, coordination: 3, other: 1 })),
    ['3 coordinate', '2 agent', '1 other'].join(' \u00b7 '),
  );
  assert.equal(toolMixOf(counts()), '');
  assert.deepEqual(toolCategoriesOf(counts({ edits: 3, commands: 12, reads: 5 })), [
    { key: 'commands', label: 'run', count: 12 },
    { key: 'reads', label: 'read', count: 5 },
    { key: 'edits', label: 'edit', count: 3 },
  ]);
});

test('a launch row carries the outcome recorded for its subagent', () => {
  const rows = logOf(
    turn({
      steps: [step({ name: 'Agent', id: 'agent-1', detail: 'Review the diff' })],
      stepCount: 1,
      agents: [
        agent({
          toolUseId: 'agent-1',
          description: 'Review the diff',
          agentType: 'Explore',
          model: 'gpt-5.6-sol',
          durationMs: 252_000,
          tokens: 38_000,
          toolUses: 38,
          status: 'completed',
        }),
      ],
    }),
  ).rows;
  assert.equal(rows[0].figure, ['gpt-5.6-sol', '4m', '38 tools', '38k'].join(' \u00b7 '));
});

test('a launch row omits a zero tool count rather than drawing it', () => {
  const rows = logOf(
    turn({
      steps: [step({ name: 'Agent', id: 'agent-1', detail: 'Review the diff' })],
      stepCount: 1,
      agents: [
        agent({
          toolUseId: 'agent-1',
          description: 'Review the diff',
          agentType: 'Explore',
          model: 'gpt-5.6-sol',
          durationMs: 252_000,
          tokens: 38_000,
          toolUses: 0,
          status: 'completed',
        }),
      ],
    }),
  ).rows;
  assert.equal(rows[0].figure, ['gpt-5.6-sol', '4m', '38k'].join(' \u00b7 '));
});

test('the card tally includes calls beyond the activity step window', () => {
  const tally = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`tool-${i}`, 1]));
  const card = toCard(turn({ toolTally: tally }), false, NOW);
  assert.equal(
    card.toolTally.reduce((sum, row) => sum + row.count, 0),
    80,
  );
  assert.deepEqual(
    card.toolTally.slice(0, 3).map((row) => row.name),
    ['tool-0', 'tool-1', 'tool-10'],
  );
  assert.deepEqual(new Set(card.toolTally.map((row) => row.category)), new Set(['other']));
});

test('the card tally keeps each provider tool category', () => {
  const card = toCard(
    turn({
      agent: 'codex',
      toolTally: { exec: 17, apply_patch: 1, wait_agent: 1, Bash: 1 },
    }),
    false,
    NOW,
  );
  assert.deepEqual(card.toolTally, [
    { name: 'exec', count: 17, category: 'commands' },
    { name: 'apply_patch', count: 1, category: 'edits' },
    { name: 'Bash', count: 1, category: 'other' },
    { name: 'wait_agent', count: 1, category: 'coordination' },
  ]);
});

test('the headline is the summary, the error, or what the turn ended up doing', () => {
  assert.equal(
    headlineFor(turn({ summary: '## TLDR\n\n- Review findings addressed (11/11)' }), 'done'),
    'Review findings addressed (11/11)',
  );
  assert.equal(
    headlineFor(turn({ error: 'Usage credits are required for this model.' }), 'failed'),
    'Usage credits are required for this model.',
  );
  // A running turn without response text uses the prompt's first line, or the empty-prompt fallback.

  assert.equal(headlineFor(turn({ prompt: 'take the sandbox off' }), 'running'), 'take the sandbox off');
  assert.equal(headlineFor(turn({ prompt: 'first line\nand a second' }), 'running'), 'first line');
  assert.equal(headlineFor(turn({ prompt: '' }), 'running'), 'Still working.');
  assert.equal(headlineFor(turn(), 'interrupted'), 'Stopped by you before it answered.');
  assert.equal(headlineFor(turn(), 'stopped'), 'Ended without a closing message.');
});

// The plain and formatted headlines read one selected source. A second selection would parse the whole response again.
test('a card parses its response once to select the plain and formatted headlines', () => {
  const parses = vi.spyOn(richtext, 'markdownCodeBlocks');
  try {
    for (const summary of ['**Done.** The `build` passes.\n\n```ts\nconst a = 1;\n```', '## Summary']) {
      parses.mockClear();
      toCard(turn({ summary }), false, NOW);
      assert.equal(
        parses.mock.calls.length,
        1,
        `a card for ${JSON.stringify(summary)} parsed its response ${parses.mock.calls.length} times`,
      );
    }
  } finally {
    parses.mockRestore();
  }
});

test('the collapsed headline keeps an inline-code identifier intact', () => {
  // headlineFor preserves the leading symbol. The card removes it separately after stripping Markdown.

  const summary =
    '✅ **Phase 0 is done and folded into the plan.** Codex publishes ' +
    '`CODEX_SESSION_ID`, so both agents can name themselves and no step in the plan is ' +
    'unsolved now. Phase 1 is next and needs your go.';
  const headline = headlineFor(turn({ summary }), 'done');
  assert.equal(
    headline,
    '✅ Phase 0 is done and folded into the plan. Codex publishes ' +
      'CODEX_SESSION_ID, so both agents can name themselves and no step in the plan is ' +
      'unsolved now. Phase 1 is next and needs your go.',
  );
  assert.equal(
    withoutLeadingSymbol(headline),
    'Phase 0 is done and folded into the plan. ' +
      'Codex publishes CODEX_SESSION_ID, so both agents can name themselves and no step in ' +
      'the plan is unsolved now. Phase 1 is next and needs your go.',
  );
});

test('a headline with inline markup carries headlineHtml, and a plain one carries none', () => {
  const summary =
    '✅ **Phase 0 is done and folded into the plan.** Codex publishes ' +
    '`CODEX_SESSION_ID`, so both agents can name themselves and no step in the plan is ' +
    'unsolved now. Phase 1 is next and needs your go.';
  const card = toCard(turn({ summary }), false, NOW);
  assert.equal(
    card.headline,
    'Phase 0 is done and folded into the plan. Codex publishes ' +
      'CODEX_SESSION_ID, so both agents can name themselves and no step in the plan is ' +
      'unsolved now. Phase 1 is next and needs your go.',
  );
  assert.match(card.headlineHtml ?? '', /<code>CODEX_SESSION_ID<\/code>/);
  assert.match(card.headlineHtml ?? '', /<strong>Phase 0 is done and folded into the plan\.<\/strong>/);
  assert.doesNotMatch(card.headlineHtml ?? '', /✅/, 'the checkmark is a mark, not a headline character');

  const plain = toCard(turn({ summary: '## TLDR\n\n- Review findings addressed (11/11)' }), false, NOW);
  assert.equal(plain.headlineHtml, undefined);

  const errored = toCard(turn({ error: 'Usage credits are required for this model.' }), false, NOW);
  assert.equal(errored.headlineHtml, undefined);

  const running = toCard(turn({ prompt: 'take the sandbox off', finished: false, endedAt: NOW - 60_000 }), true, NOW);
  assert.equal(running.statusWord, 'running');
  assert.equal(running.headlineHtml, undefined);

  // A symbol inside emphasis prevents headlineHtml when the rendered and plain headlines disagree.

  const markedSymbol = toCard(turn({ summary: '**✅ Done**' }), false, NOW);
  assert.equal(markedSymbol.headlineHtml, undefined);

  // An unmatched backtick prevents headlineHtml when rendered and plain headlines disagree.

  const unclosedBacktick = toCard(turn({ summary: 'Ran `npm test' }), false, NOW);
  assert.equal(unclosedBacktick.headlineHtml, undefined);

  // An underscore inside a word remains literal. A headline without rendered markup carries no headlineHtml.

  const strayUnderscore = toCard(turn({ summary: 'calc_total is a function' }), false, NOW);
  assert.equal(strayUnderscore.headline, 'calc_total is a function');
  assert.equal(strayUnderscore.headlineHtml, undefined);

  // Strikethrough prevents headlineHtml because plain stripping retains the tildes.

  const strikethrough = toCard(turn({ summary: '~~old~~ `new`' }), false, NOW);
  assert.equal(strikethrough.headlineHtml, undefined);

  // Nested and tripled emphasis produce matching rendered and plain headline text.

  const nested = toCard(turn({ summary: 'nested **bold *em* inside** text' }), false, NOW);
  assert.equal(nested.headline, 'nested bold em inside text');
  assert.equal(nested.headlineHtml, 'nested <strong>bold <em>em</em> inside</strong> text');

  const tripled = toCard(turn({ summary: 'a ***bold em*** line' }), false, NOW);
  assert.equal(tripled.headline, 'a bold em line');
  assert.equal(tripled.headlineHtml, 'a <em><strong>bold em</strong></em> line');
});

test('the reported escaped session response retains a collapsed session anchor', () => {
  const card = toCard(turn({ summary: SESSION_LINK_RESPONSE }), false, NOW);
  assert.equal(card.headline, 'Launched code-coordinate-1-native-session-skills-sol, pinned under packaging.');
  assert.match(card.headlineHtml ?? '', /<a href="#" data-link="arc-session:01a137a5-3d93-71d0-9492-965abeb0fa32"/);
  assert.match(card.headlineHtml ?? '', />code-coordinate-1-native-session-skills-sol<\/a>/);
  assert.match(card.headlineHtml ?? '', /<strong>packaging<\/strong>/);
});

test('collapsed fenced and inline session examples remain literal', () => {
  const line = String.raw`[code\-example](arc-session:01a137a5-3d93-71d0-9492-965abeb0fa32)`;
  for (const fence of ['```markdown', '~~~~text']) {
    const card = toCard(
      turn({ summary: `${fence}\n${line}\n${fence.slice(0, fence.startsWith('`') ? 3 : 4)}` }),
      false,
      NOW,
    );
    assert.equal(card.headline, line);
    assert.equal(card.headlineHtml, undefined);
  }
  for (const summary of [
    `- \`\`\`\n\t${line}\n\t\`\`\``,
    `1. \`\`\`\n\t${line}\n\t\`\`\``,
    `- \`\`\`\n  ${line}\n  \`\`\``,
    `> - \`\`\`\n>   ${line}\n>   \`\`\``,
    `> 1. > ~~~~text\n>    > ${line}\n>    > ~~~~`,
    `- \`\`\`\`markdown\n  ${line}\n  \`\`\``,
  ]) {
    const card = toCard(turn({ summary }), false, NOW);
    assert.equal(card.headline, line, summary);
    assert.equal(card.headlineHtml, undefined, summary);
  }
  const inline = toCard(turn({ summary: `Example: \`${line}\`` }), false, NOW);
  assert.equal(inline.headline, `Example: ${line}`);
  assert.doesNotMatch(inline.headlineHtml ?? '', /<a /);
  const after = toCard(turn({ summary: `~~~\n\n~~~\n${SESSION_LINK_RESPONSE}` }), false, NOW);
  assert.match(after.headlineHtml ?? '', /<a /);
});

test("a folded headline keeps a file name's underscore and gets headlineHtml", () => {
  // Filename underscores remain intact in the plain headline and its rendered HTML.

  const card = toCard(turn({ summary: 'Renamed `a` in my_file.py' }), false, NOW);
  assert.equal(card.headline, 'Renamed a in my_file.py');
  assert.equal(card.headlineHtml, 'Renamed <code>a</code> in my_file.py');
});

test('the collapsed headline translates a visualization reference like the full response', () => {
  const file = path.resolve('fixtures', 'session-rail-details.html');
  const reference = `\uE200visualize\uE202${JSON.stringify({
    path: file,
    title: 'Roadmap [phase one]',
  })}\uE201`;
  const headline = headlineFor(turn({ summary: reference }), 'done');

  assert.equal(headline, 'Open interactive visualization: Roadmap [phase one]');
  assert.doesNotMatch(headline, /[\uE200-\uE202]/);
});

test('a card carries the figures the panel shows, and omits the ones with nothing in them', () => {
  const card = toCard(
    turn({
      summary: 'Done and committed.',
      effort: 'xhigh',
      files: [
        { path: 'c:/repo/a.ts', added: 80, removed: 12, isNew: false, edits: [] },
        { path: 'c:/repo/new.md', added: 5, removed: 0, isNew: true, edits: [] },
      ],
      toolUses: 68,
      toolCounts: counts({ edits: 20, commands: 40, reads: 8 }),
      failures: [
        { tool: 'Bash', message: 'exit code 1' },
        { tool: 'Edit', message: 'old_string not found' },
      ],
      usage: {
        input: 200,
        cacheWrite1h: 40_000,
        cacheWrite5m: 0,
        cacheRead: 3_000_000,
        output: 206_000,
        thinking: 120_000,
      },
      contextTokens: 160_000,
      commits: [
        {
          sha: '00facf2a',
          subject: 'Add the timeline',
          files: 3,
          added: 12,
          removed: 0,
          at: NOW,
          place: null,
          dir: null,
        },
      ],
      agents: [agent({ durationMs: 109_000, toolUses: 20, tokens: 70_000 })],
    }),
    false,
    NOW,
  );

  assert.equal(card.duration, '12m');
  assert.equal(card.model, 'opus-5');
  assert.equal(card.effort, 'xhigh');
  // Commit rows carry the navigation and display fields consumed by the panel.

  assert.deepEqual(card.commits, [
    {
      kind: 'commit',
      key: 'commit:00facf2a',
      sha: '00facf2a',
      subject: 'Add the timeline',
      added: 12,
      removed: 0,
      at: NOW,
      repository: null,
      branch: null,
      headKind: null,
      madeBySession: null,
      dir: null,
      where: null,
      absolute: formatWhen(NOW, NOW),
      detail: 'Add the timeline\n3 files changed',
    },
  ]);
  assert.equal(card.status, 'done');
  assert.equal(card.headline, 'Done and committed.');
  assert.deepEqual([card.fileCount, card.added, card.removed], [2, 85, 12]);
  assert.deepEqual(
    card.files.map((f) => f.name),
    ['a.ts', 'new.md'],
  );
  assert.equal(card.toolMix, '40 run · 20 edit · 8 read');
  assert.deepEqual(card.agents[0], {
    description: 'Audit the parser',
    model: 'haiku-4-5',
    effort: null,
    // A child without spend detail shows duration followed by its recorded token count.

    figures: [
      { metric: 'duration', compactLabel: '2m', name: 'Ran for 2m' },
      { metric: 'tokens', compactLabel: '70k tokens', name: '70k tokens' },
    ],
    state: 'done',
    stateWord: '',
    since: null,
    hintDetail: '20 tools',
    sessionId: null,
  });
  // Parent usage costs $0.001 + $0.40 + $1.50 + $5.15. Missing child spend makes the displayed total a lower bound.
  // Two tool failures add no figure or mark.
  assert.deepEqual(
    card.chips.map((c) => c.label),
    ['$7.05+', '16% of 1M ctx (160k)', '2 files', '3M in · 206k out', '1 commit', '1 subagent'],
  );
  assert.deepEqual(
    foldedChips(card.chips).map((c) => c.label),
    ['$7.05+', '16% of 1M ctx (160k)', '2 files', '3M in · 206k out', '1 commit', '1 subagent'],
  );
  // The files figure tooltip includes file and line totals.

  assert.deepEqual(card.chips[2].detail.split('\n'), [
    // A file with no removals omits that count.
    '2 files: +85 −12',
    '',
    'a.ts: +80 −12',
    'new.md: +5 new',
  ]);
  // The Activity heading carries the tool mix without a separate tool-count figure.

  assert.equal(
    card.chips.some((c) => c.label.endsWith(' tools')),
    false,
    'the tool count is drawn twice on one open card, once as a chip and once as a heading',
  );
  assert.equal(card.toolMix, '40 run · 20 edit · 8 read', 'the heading has no mix left to draw');
  assert.deepEqual(card.chips[5].detail.split('\n'), ['Audit the parser', '  haiku-4-5 · 2m · 20 tools · 70k']);
  // The commits figure tooltip lists the same commits as its popover.

  assert.equal(card.chips[4].detail, ['1 commit: +12', '', '00facf2a: Add the timeline'].join('\n'));

  // A turn that answered in text with no file changes carries the no-change figure, its cost, and its output.

  const empty = toCard(
    turn({ summary: 'Answered your question.', usage: { ...turn().usage, output: 50 } }),
    false,
    NOW,
  );
  assert.deepEqual(
    empty.chips.map((c) => c.label),
    ['<$0.01', 'no file changes', '50 out'],
  );
  assert.deepEqual(
    foldedChips(empty.chips).map((c) => c.label),
    ['<$0.01', 'no file changes', '50 out'],
  );
});

test('a shell edit named without hunks reports no counts, and the chip says how many', () => {
  const card = toCard(
    turn({
      files: [
        { path: 'c:/repo/a.ts', added: 2, removed: 1, isNew: false, edits: [] },
        { path: 'c:/repo/unlisted.ts', added: 0, removed: 0, isNew: false, edits: [], countsUnknown: true },
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    [card.fileCount, card.added, card.removed],
    [2, 2, 1],
    'the unhunked row counts toward the file total but not the line totals',
  );
  const files = card.chips.find((c) => c.metric === 'files')!;
  assert.equal(files.label, '2 files');
  // The files figure keeps unknown line-count details in its footer, separate from its label and accessible name.

  assert.equal(files.name, '2 files, 2 lines added, 1 removed');
  assert.deepEqual(files.detail.split('\n'), ['2 files: +2 −1', '', 'a.ts: +2 −1', 'unlisted.ts']);
  assert.deepEqual(files.detailList?.footer, ['1 file carries no line counts.']);
});

test('an Edit and then a whole-file Write keeps the lines and says the file was written whole', () => {
  // A whole-file write retains counted lines and marks their coverage partial in both turn and session figures.

  const written = turn({
    files: [
      {
        path: 'c:/repo/src/config.ts',
        added: 4,
        removed: 3,
        isNew: false,
        edits: [],
        countsUnknown: true,
        unknownReason: 'write',
      },
    ],
  });
  const card = toCard(written, false, NOW);
  assert.deepEqual([card.added, card.removed], [4, 3], 'the turn dropped the lines the Edit counted');
  const files = card.chips.find((c) => c.metric === 'files')!;
  assert.equal(files.name, '1 file, 4 lines added, 3 removed');
  assert.deepEqual(files.detailList?.footer, ['1 file was written whole, so its line counts are partial.']);
  const heading = sessionStats([written], []).find((c) => c.metric === 'files')!;
  assert.equal(heading.name, files.name, 'the session heading names the file apart from the turn figure');
  assert.deepEqual(heading.detailList?.footer, ['1 file was written whole, so its line counts are partial.']);
});

test('the files figure names a Write and a shell edit apart, and folds a subagent write in too', () => {
  // The files footer names whole-file writes before shell edits. Neither cause changes the figure's label or accessible name.

  const card = toCard(
    turn({
      files: [
        changed('c:/repo/src/kept.ts', 3, 0),
        {
          path: 'c:/repo/src/shelled.ts',
          added: 0,
          removed: 0,
          isNew: false,
          edits: [],
          countsUnknown: true,
          unknownReason: 'shell',
        },
      ],
      agents: [
        agent({
          description: 'Rewrite the config',
          artifacts: {
            files: [
              {
                path: 'c:/repo/src/written.ts',
                added: 0,
                removed: 0,
                isNew: false,
                countsUnknown: true,
                unknownReason: 'write',
              },
            ],
            commits: [],
            complete: true,
            revision: 'child-write',
          },
        }),
      ],
    }),
    false,
    NOW,
  );
  const files = card.chips.find((c) => c.metric === 'files')!;
  assert.equal(files.label, '3 files');
  assert.equal(files.name, '3 files, 3 lines added, 1 changed by a subagent');
  // The flat run names the three files and does not repeat the causes its own footer carries.
  assert.deepEqual(files.detail.split('\n'), ['3 files: +3', '', 'kept.ts: +3', 'shelled.ts', 'written.ts']);
  assert.deepEqual(files.detailList?.footer, [
    '1 file was written whole, so its old lines are unknown.',
    '1 file was named by the shell without its lines, so its line counts are unknown.',
  ]);
  // The child file row retains its maker attribution independently of the files figure's footer.

  const written = card.files.find((file) => file.name === 'written.ts');
  assert.equal(written?.detail, 'c:/repo/src/written.ts\nchanged by Rewrite the config');
});

test('the files figure names the replaceAll, notebook and zero causes in their own sentences', () => {
  const card = toCard(
    turn({
      files: [
        changed('c:/repo/src/kept.ts', 3, 0),
        {
          path: 'c:/repo/src/all.ts',
          added: 0,
          removed: 0,
          isNew: false,
          edits: [],
          countsUnknown: true,
          unknownReason: 'replaceAll',
        },
        {
          path: 'c:/repo/notebook.ipynb',
          added: 0,
          removed: 0,
          isNew: false,
          edits: [],
          countsUnknown: true,
          unknownReason: 'notebook',
        },
        {
          path: 'c:/repo/other.ipynb',
          added: 0,
          removed: 0,
          isNew: false,
          edits: [],
          countsUnknown: true,
          unknownReason: 'notebook',
        },
        {
          path: 'c:/repo/src/same.ts',
          added: 0,
          removed: 0,
          isNew: false,
          edits: [],
          countsUnknown: true,
          unknownReason: 'zero',
        },
      ],
    }),
    false,
    NOW,
  );
  const files = card.chips.find((c) => c.metric === 'files')!;
  // Two notebooks share one sentence, which stays true in the plural.
  assert.deepEqual(files.detailList?.footer, [
    '1 file was edited with replace_all, which does not say how many times it matched, so its line counts are unknown.',
    '2 files were notebooks edited with no record of what their cells held before, so their line counts are unknown.',
    '1 file was edited with nothing a line count can see, so its line counts are unknown.',
  ]);
});

test('the card draws one ordered row in both its open and folded states', () => {
  // Open and folded cards preserve figure order. Closing action and question rows add no figures.

  const loaded = toCard(
    turn({
      summary: [
        '- Landed it.',
        '',
        '- 🙋 **Your actions** — reload the window and confirm.',
        '- ❓ **Open questions / follow-ups** — (1) keep the store? (2) rename the view?',
      ].join('\n'),
      files: [{ path: 'c:/repo/a.ts', added: 80, removed: 12, isNew: false, edits: [] }],
      toolUses: 68,
      toolCounts: counts({ edits: 20, commands: 40, reads: 8 }),
      usage: {
        input: 200,
        cacheWrite1h: 40_000,
        cacheWrite5m: 0,
        cacheRead: 3_000_000,
        output: 206_000,
        thinking: 120_000,
      },
      contextTokens: 160_000,
      failures: [
        { tool: 'Bash', message: 'exit code 1' },
        { tool: 'Edit', message: 'no match' },
        { tool: 'Read', message: 'missing' },
      ],
      agents: [agent({ durationMs: 109_000, toolUses: 20, tokens: 70_000 })],
      commits: [
        {
          sha: '00facf2a',
          subject: 'Add the timeline',
          files: 3,
          added: 12,
          removed: 0,
          at: NOW,
          place: null,
          dir: null,
        },
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    loaded.chips.map((c) => c.label),
    ['$7.05+', '16% of 1M ctx (160k)', '1 file', '3M in · 206k out', '1 commit', '1 subagent'],
  );
  assert.deepEqual(
    foldedChips(loaded.chips).map((c) => c.label),
    ['$7.05+', '16% of 1M ctx (160k)', '1 file', '3M in · 206k out', '1 commit', '1 subagent'],
  );
  // The files figure carries both added and removed line counts.

  assert.deepEqual([loaded.chips[2].kind, loaded.chips[2].added, loaded.chips[2].removed], ['diff', 80, 12]);
  // The tones travel with the chips, so each remaining figure keeps its role in the row.
  assert.deepEqual(
    loaded.chips.map((c) => c.kind),
    ['plain', 'plain', 'diff', 'plain', 'plain', 'plain'],
  );

  // Absent cost and context figures leave no gap before the file count.

  const cheap = toCard(
    turn({
      files: [{ path: 'c:/repo/a.ts', added: 1, removed: 0, isNew: false, edits: [] }],
      toolUses: 4,
      toolCounts: counts({ reads: 4 }),
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    cheap.chips.map((c) => c.label),
    ['1 file'],
  );
  assert.deepEqual(
    foldedChips(cheap.chips).map((c) => c.label),
    ['1 file'],
  );
});

test('the files and the lines are one chip, and it is announced in words', () => {
  // One files figure announces added and removed line counts in words.

  const card = toCard(
    turn({
      files: [
        { path: 'c:/repo/a.ts', added: 80, removed: 12, isNew: false, edits: [] },
        { path: 'c:/repo/new.md', added: 5, removed: 0, isNew: true, edits: [] },
      ],
    }),
    false,
    NOW,
  );
  assert.equal(card.chips.filter((c) => c.kind === 'diff').length, 1, 'the lines are a chip of their own again');
  const chip = card.chips.find((c) => c.kind === 'diff')!;
  assert.equal(chip.label, '2 files');
  assert.equal(chip.name, '2 files, 85 lines added, 12 removed');
  assert.equal(
    card.chips.some((c) => !c.label),
    false,
    'a chip is drawn with nothing on its face, which is what the lines used to be',
  );

  // One file and one line, so the name is not `1 files, 1 lines added`.
  const one = toCard(
    turn({
      files: [{ path: 'c:/repo/a.ts', added: 1, removed: 1, isNew: false, edits: [] }],
    }),
    false,
    NOW,
  );
  assert.equal(one.chips.find((c) => c.kind === 'diff')!.name, '1 file, 1 line added, 1 removed');

  // Session headings use the same file-count wording as turn cards.

  const heading = sessionStats(
    [
      turn({
        files: [{ path: '/w/a.ts', added: 4, removed: 0, isNew: false, edits: [] }],
      }),
    ],
    [],
  ).find((c) => c.kind === 'diff')!;
  assert.equal(heading.label, '1 file');
  assert.equal(heading.name, '1 file, 4 lines added');
  assert.match(heading.detail, /Lines changed: \+4\n/);
  // The session-heading detail states its coverage once.
  assert.equal(
    heading.detail.split('\n').filter((l) => l.trim().startsWith('Across the ')).length,
    1,
    'the session heading says what window its figures cover more than once',
  );
});

test('the context chip leads with the share of the window, once that window is known', () => {
  const card = toCard(turn({ contextTokens: 204_000, model: 'claude-opus-5' }), false, NOW);
  const chip = ctxChip(card)!;
  assert.equal(chip.label, '20% of 1M ctx (204k)');
  assert.equal(chip.kind, 'plain');
  assert.deepEqual(chip.detail.split('\n'), [
    'Context window used: 20% of 1M',
    'Context at the end of the turn: 204,000 tokens',
    'Window size from the model fallback for opus-5.',
  ]);
});

test('the share is rounded down, so 100% is not claimed while the window has room left', () => {
  const nearly = ctxChip(toCard(turn({ contextTokens: 996_000, model: 'claude-opus-5' }), false, NOW))!;
  assert.equal(nearly.label, '99% of 1M ctx (996k)', '4,000 tokens are still free');
  assert.match(nearly.detail, /99% of 1M/);
  const full = ctxChip(toCard(turn({ contextTokens: 1_000_000, model: 'claude-opus-5' }), false, NOW))!;
  assert.equal(full.label, '100% of 1M ctx (1M)', 'a turn exactly at the window is full');
  assert.match(full.detail, /100% of 1M/);
  // A full window keeps the highest context band and changes its accessible name.

  assert.equal(full.level, 'nearlyFull', 'the full window changed band as well as wording');
  assert.equal(full.word, 'context full');
  assert.equal(nearly.word, 'context nearly full', '99% is not full, and must not be worded as it');
});

test('the context chip stays a bare count when the model has no known window', () => {
  const card = toCard(turn({ contextTokens: 160_000, model: 'some-other-model' }), false, NOW);
  const chip = ctxChip(card)!;
  assert.equal(chip.label, '160k ctx');
  assert.equal(chip.kind, 'plain');
  assert.equal(chip.detail, 'Context at the end of the turn: 160,000 tokens');
});

test('the context chip takes its band at each threshold, and stays plain under the first', () => {
  // Context thresholds preserve their order, levels, and words.

  assert.deepEqual(
    CONTEXT_BANDS.map((b) => [b.at, b.level, b.word]),
    [
      [0.5, 'filling', 'context filling up'],
      [0.75, 'gettingFull', 'context getting full'],
      [0.9, 'nearlyFull', 'context nearly full'],
    ],
  );

  // Below the first band, context figures carry no level, band word, or fullness sentence.

  for (const share of [0.1, 0.49]) {
    const quiet = bandAt(share);
    assert.equal(quiet.level, undefined, `${share} of the window is toned`);
    assert.equal(quiet.word, undefined, `${share} of the window is worded as a band`);
    assert.doesNotMatch(quiet.detail, /The window is/, `${share} of the window says how full it is`);
  }

  // A share rounded to a threshold receives that threshold's band.

  const carried = bandAt(CONTEXT_BANDS[0].at - 0.0004);
  assert.equal(carried.level, CONTEXT_BANDS[0].level, 'a figure printed at the threshold was left untoned');
  assert.equal(carried.word, CONTEXT_BANDS[0].word);

  // Context bands travel in level while the figure's kind remains plain.

  const edges: [number, string, string][] = [
    [0.5, 'filling', 'context filling up'],
    [0.75, 'gettingFull', 'context getting full'],
    [0.9, 'nearlyFull', 'context nearly full'],
  ];
  const below = ['filling', 'gettingFull'];
  for (let i = 0; i < edges.length; i += 1) {
    const [at, level, word] = edges[i];
    const on = bandAt(at);
    assert.equal(on.level, level, `${at} of the window is not in the ${level} band`);
    assert.equal(on.word, word, `${at} of the window is worded wrong`);
    assert.equal(on.kind, 'plain', 'the band reached kind, which every other chip is drawn from');
    // One point under, which is the band below, or none at all under the first.
    const under = bandAt(at - 0.01);
    assert.equal(
      under.level,
      i === 0 ? undefined : below[i - 1],
      `a share one point under ${at} takes the band above it`,
    );
  }

  // And the top band runs to the ceiling rather than stopping at a fourth threshold.
  assert.equal(bandAt(0.99).level, 'nearlyFull');
});

test('a context size past the window falls back rather than claiming an impossible share', () => {
  // Context exceeding the model window displays its token count without a percentage.

  const card = toCard(turn({ contextTokens: 1_200_000, model: 'claude-opus-5' }), false, NOW);
  const chip = ctxChip(card)!;
  assert.equal(chip.label, '1.2M ctx');
  assert.equal(chip.kind, 'plain');
  assert.equal(chip.detail, 'Context at the end of the turn: 1,200,000 tokens');
});

test('a chip with no share behind it wears no band, whichever way the share went unknown', () => {
  // An unknown model window or an overrun leaves the context figure without a band.

  for (const [why, held] of [
    ['a model the table does not name', turn({ contextTokens: 160_000, model: 'some-other-model' })],
    ['a turn past the window it was measured against', turn({ contextTokens: 1_200_000, model: 'claude-opus-5' })],
  ] as [string, Turn][]) {
    const chip = ctxChip(toCard(held, false, NOW))!;
    assert.equal(chip.level, undefined, `${why} still carries a band`);
    assert.equal(chip.word, undefined, `${why} still carries a band word`);
    assert.doesNotMatch(chip.detail, /The window is/, `${why} still says how full the window is`);
  }
});

test('a subagent still running says so instead of showing blank figures', () => {
  const card = toCard(
    turn({ finished: false, endedAt: NOW, agents: [agent({ model: null, status: 'running' })] }),
    true,
    NOW,
  );
  assert.deepEqual(card.agents[0], {
    description: 'Audit the parser',
    model: null,
    effort: null,
    figures: [],
    state: 'running',
    stateWord: 'running',
    since: null,
    hintDetail: '',
    sessionId: null,
  });
  assert.deepEqual(card.chips.find((chip) => chip.metric === 'agents')?.detailList?.entries, [
    { label: 'Audit the parser', lines: ['running'] },
  ]);
});

test('a live session keeps only a background child of a finished turn running', () => {
  const launched = NOW - 21 * 60_000;
  const base = turn({
    steps: [step({ name: 'Agent', id: 'agent-1', at: launched, status: 'done' })],
    stepCount: 1,
    agents: [agent({ toolUseId: 'agent-1', status: 'async_launched' })],
  });
  const live = toCard(base, false, NOW, [], null, true);
  const liveAgent = live.agents[0];
  assert.ok(liveAgent);
  assert.deepEqual([liveAgent.state, liveAgent.since], ['running', launched]);
  assert.equal(live.chips.find((chip) => chip.metric === 'agents')?.detailList?.heading?.busyValue, true);

  const idle = toCard(base, false, NOW);
  const idleAgent = idle.agents[0];
  assert.ok(idleAgent);
  assert.deepEqual([idleAgent.state, idleAgent.since], ['open', null]);
  assert.equal(idle.chips.find((chip) => chip.metric === 'agents')?.detailList?.heading?.busyValue, undefined);

  const synchronous = toCard(
    turn({
      steps: base.steps,
      stepCount: 1,
      agents: [agent({ toolUseId: 'agent-1', status: 'running' })],
    }),
    false,
    NOW,
    [],
    null,
    true,
  );
  assert.deepEqual([synchronous.agents[0].state, synchronous.agents[0].since], ['open', null]);
});

test('an open child cost hint makes no live-process claim', () => {
  const usage = { requests: 1, input: 1_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 100, thinking: 0 };
  const card = toCard(
    turn({
      agents: [
        agent({
          status: 'async_launched',
          spendFound: true,
          spend: [{ model: 'claude-haiku-4-5', usage }],
        }),
      ],
    }),
    false,
    NOW,
  );
  assert.doesNotMatch(card.agents[0].hintDetail, /Still running/);
});

test('a subagent row draws model, effort and its figures, and leaves the tool uses to its hint', () => {
  const launched = NOW - 21 * 60_000;
  const usage = {
    requests: 6,
    input: 41_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 0,
    output: 7_000,
    thinking: 0,
  };
  const card = toCard(
    turn({
      finished: false,
      endedAt: NOW,
      steps: [
        step({ name: 'Agent', id: 'agent-1', at: launched, status: 'running' }),
        step({ ordinal: 2, name: 'Agent', id: 'agent-2', at: launched + 60_000, status: 'running' }),
      ],
      stepCount: 2,
      agents: [
        agent({
          effort: 'high',
          durationMs: 240_000,
          toolUses: 23,
          spendFound: true,
          spend: [{ model: 'claude-haiku-4-5', usage }],
        }),
        agent({ toolUseId: 'agent-1', status: 'running', toolUses: 4 }),
        agent({ toolUseId: 'agent-unknown', status: 'async_launched' }),
        agent({
          toolUseId: 'agent-2',
          status: 'running',
          toolUses: 31,
          spendFound: true,
          spendPartial: true,
          spend: [{ model: 'claude-haiku-4-5', usage }],
        }),
      ],
    }),
    true,
    NOW,
  );
  assert.equal(card.status, 'running');
  // The child row's hint carries tool counts. Cost and duration have separate figures.

  assert.deepEqual(
    card.agents.map((held) => [
      held.model,
      held.effort,
      held.figures.map((figure) => [figure.metric, figure.compactLabel]),
      held.state,
      held.stateWord,
      held.since,
      held.hintDetail,
    ]),
    [
      [
        'haiku-4-5',
        'high',
        [
          ['cost', '$0.08'],
          ['duration', '4m'],
        ],
        'done',
        '',
        null,
        '23 tools',
      ],
      // A running child's time is the running word's figure, taken from its launch step.
      ['haiku-4-5', null, [], 'running', 'running', launched, '4 tools'],
      ['haiku-4-5', null, [], 'running', 'running', null, ''],
      // A running child with recorded spend draws its cost so far, marked as a lower bound.
      ['haiku-4-5', null, [['cost', '$0.08+']], 'running', 'running', launched + 60_000, '31 tools'],
    ],
  );
  assert.deepEqual(
    card.agents[0].figures[0].record?.entries.slice(0, 1).map((entry) => [entry.label, entry.value]),
    [['Cost by usage · haiku-4-5', '$0.08']],
  );
});

// Extract detail-line text without its adjacent cost and cache fields.

const lineText = (line: StatDetailLine): string =>
  typeof line === 'string' ? line : 'text' in line ? line.text : `${line.lead}${line.trail}`;

// Each child figure carries its own detail. The row tooltip retains the run information.

test('each subagent figure carries its own record and the row keeps the run line', () => {
  const made = (sha: string, subject: string): TurnCommit => ({
    sha,
    subject,
    files: 1,
    added: 2,
    removed: 0,
    at: NOW,
    place: null,
    dir: 'c:/repo',
  });
  const commits = [
    made('9d7be30', 'test(card): measure the open card at the three panel widths'),
    made('b83e0d1', 'fix(rail): keep the pinned row in view when the rail narrows'),
  ];
  const card = toCard(
    turn({
      agents: [
        agent({
          model: 'claude-sonnet-5',
          effort: 'high',
          durationMs: 214_000,
          toolUses: 23,
          spendFound: true,
          spend: [
            {
              model: 'claude-sonnet-5',
              usage: {
                requests: 18,
                input: 6_000,
                cacheWrite1h: 0,
                cacheWrite5m: 42_000,
                cacheRead: 610_000,
                output: 9_400,
                thinking: 0,
              },
            },
          ],
          commits,
          artifacts: {
            files: [
              { path: 'extension/src/a.ts', added: 10, removed: 2, isNew: false },
              { path: 'extension/src/b.ts', added: 6, removed: 2, isNew: false },
              { path: 'extension/src/c.ts', added: 2, removed: 0, isNew: false },
            ],
            commits: commits.map((held) => held.sha),
            complete: true,
            revision: 'child-r1',
          },
        }),
      ],
    }),
    false,
    NOW,
  );
  const drawn = card.agents[0].figures;
  // Each child figure's detail heading uses its own accessible wording.

  assert.deepEqual(
    drawn.map((figure) => [figure.metric, figure.record?.heading?.label]),
    [
      ['cost', '$0.33 spent'],
      ['duration', undefined],
      ['commits', '2 commits'],
      ['files', '3 files, 18 lines added, 4 removed'],
    ],
  );
  // The cost detail separates values from their breakdown and ends with usage totals.

  assert.deepEqual(
    drawn[0].record?.entries.map((entry) => [entry.label, entry.value]),
    [
      ['Cost by usage · sonnet-5', '$0.33'],
      ['Input', '658k tokens'],
      ['Output', '9,400 tokens'],
      ['Model requests', '18'],
      ['Input breakdown', undefined],
    ],
  );
  assert.deepEqual((drawn[0].record?.entries[0].lines ?? []).map(lineText), [
    'Output: $0.09',
    'Cached input reads: $0.12',
    'Uncached input: $0.01',
    '5-minute cache writes: $0.10',
  ]);
  // Cached-read detail retains its structured cache share.

  assert.equal(
    (drawn[0].record?.entries[0].lines ?? []).filter((line) => typeof line === 'object' && 'cacheHit' in line).length,
    1,
  );
  // Commit and file figures select card rows by their SHAs and paths.

  assert.deepEqual(
    [drawn[2].record?.layout, drawn[2].record?.entries, drawn[2].shas],
    ['commits', [], ['9d7be30', 'b83e0d1']],
  );
  assert.deepEqual(
    [drawn[3].record?.layout, drawn[3].record?.entries, drawn[3].paths],
    ['files', [], ['extension/src/a.ts', 'extension/src/b.ts', 'extension/src/c.ts']],
  );
  // The child row tooltip contains tool counts without duplicating figure detail.

  assert.equal(card.agents[0].hintDetail, '23 tools');
  // An unpriced child without commits retains its tool tooltip and duration figure.

  const bare = toCard(turn({ agents: [agent({ durationMs: 60_000, toolUses: 4 })] }), false, NOW);
  assert.equal(bare.agents[0].hintDetail, '4 tools');
  assert.deepEqual(
    bare.agents[0].figures.map((figure) => [figure.metric, figure.compactLabel]),
    [['duration', '1m']],
  );
  // A finished child with no tools has no tool-count tooltip.

  const noToolsYet = toCard(turn({ agents: [agent({ durationMs: 60_000, toolUses: 0 })] }), false, NOW);
  assert.equal(noToolsYet.agents[0].hintDetail, '');

  // An unpriced child has no cost figure or empty cost section in its tooltip.

  const unpriced = toCard(
    turn({
      agents: [
        agent({
          durationMs: 60_000,
          toolUses: 4,
          spendFound: true,
          spend: [
            {
              model: 'unlisted-model-v7',
              provider: 'private-gateway',
              usage: {
                requests: 2,
                input: 1_000,
                cacheWrite1h: 0,
                cacheWrite5m: 0,
                cacheRead: 0,
                output: 500,
                thinking: 0,
              },
            },
          ],
        }),
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    unpriced.agents[0].figures.filter((figure) => figure.metric === 'cost'),
    [],
  );
  // Unpriced usage retains its token figure and detail.

  const unpricedTokens = unpriced.agents[0].figures.find((figure) => figure.metric === 'tokens');
  assert.deepEqual(
    unpricedTokens?.record?.entries.map((entry) => entry.label),
    ['Input', 'Output', 'Model requests', 'Input breakdown'],
    'a child whose spend carried no price lost the usage it recorded',
  );
  assert.deepEqual(
    unpriced.agents[0].hintDetail.split('\n').slice(1),
    [],
    'the row hover opens a block of its own again',
  );

  // Partial spend places its explanation under the priced detail.

  const partialSpend = toCard(
    turn({
      agents: [
        agent({
          durationMs: 60_000,
          toolUses: 4,
          spendFound: true,
          spendPartial: true,
          spend: [
            {
              model: 'claude-sonnet-5',
              usage: {
                requests: 2,
                input: 1_000,
                cacheWrite1h: 0,
                cacheWrite5m: 0,
                cacheRead: 0,
                output: 500,
                thinking: 0,
              },
            },
            {
              model: 'unlisted-model-v7',
              provider: 'private-gateway',
              usage: {
                requests: 2,
                input: 1_000,
                cacheWrite1h: 0,
                cacheWrite5m: 0,
                cacheRead: 0,
                output: 500,
                thinking: 0,
              },
            },
          ],
        }),
      ],
    }),
    false,
    NOW,
  );
  const partialCost = partialSpend.agents[0].figures.find((figure) => figure.metric === 'cost');
  // Usage totals include both priced and unpriced parts.

  assert.deepEqual(
    partialCost?.record?.entries.map((entry) => [entry.label, entry.value]),
    [
      ['Cost by usage · sonnet-5', '<$0.01'],
      ['Some nested subagents are still running or left no record. This is the cost so far.', undefined],
      ['Input', '2,000 tokens'],
      ['Output', '1,000 tokens'],
      ['Model requests', '4'],
      ['Input breakdown', undefined],
    ],
    'a block with nothing priced under it heads a lone note',
  );

  // The scrollable commits popover includes every recorded commit.

  const listed = (count: number) =>
    Array.from({ length: count }, (_, at) => made(`sha${at}`, `fix(card): the ${at} change`));
  const withCommits = (count: number) =>
    toCard(
      turn({
        agents: [
          agent({
            durationMs: 60_000,
            toolUses: 4,
            commits: listed(count),
            artifacts: {
              files: [],
              commits: listed(count).map((held) => held.sha),
              complete: true,
              revision: 'child-r1',
            },
          }),
        ],
      }),
      false,
      NOW,
    );
  const commitFigure = (built: ReturnType<typeof withCommits>) =>
    built.agents[0].figures.find((figure) => figure.metric === 'commits');
  assert.equal(commitFigure(withCommits(8))?.shas?.length, 8);
  assert.deepEqual(commitFigure(withCommits(8))?.detail?.split('\n').slice(-1), ['sha7 fix(card): the 7 change']);

  // A running child's figures include cost alone. Its tooltip omits commits.

  const live = toCard(
    turn({
      finished: false,
      agents: [
        agent({
          status: 'running',
          durationMs: 60_000,
          toolUses: 4,
          spendFound: true,
          spend: [
            {
              model: 'claude-sonnet-5',
              usage: {
                requests: 18,
                input: 6_000,
                cacheWrite1h: 0,
                cacheWrite5m: 42_000,
                cacheRead: 610_000,
                output: 9_400,
                thinking: 0,
              },
            },
          ],
          commits: [made('9d7be30', 'test(card): measure the open card at the three panel widths')],
        }),
      ],
    }),
    true,
    NOW,
  );
  assert.deepEqual(
    live.agents[0].figures.map((figure) => figure.metric),
    ['cost'],
  );
  assert.equal(live.agents[0].hintDetail, '1m · 4 tools');
  // A running child with no tools retains its duration tooltip without a zero tool count.

  const liveNoToolsYet = toCard(
    turn({
      finished: false,
      agents: [
        agent({
          status: 'running',
          durationMs: 60_000,
          toolUses: 0,
        }),
      ],
    }),
    true,
    NOW,
  );
  assert.equal(liveNoToolsYet.agents[0].hintDetail, '1m');
});

// Retained worker reads clone turns before refreshing child facts and clone the refreshed result before returning it.

// The host sends the retained pages first and the newest window last, the way `refreshAgentFacts` sends them.
function retainedWorkerPages(held: Turn[][], spend: Parameters<typeof refreshClaudeAgentFacts>[1]): Turn[][] {
  const pages = held.map((turns) => {
    const hidden = turns.map(hiddenTurnFields);
    const page = structuredClone(turns);
    page.forEach((turn, index) => applyHiddenTurnFields(turn, hidden[index], false));
    return { turns: page };
  });
  refreshRetainedClaudeAgentFacts(pages, spend, undefined, true);
  return pages.map(({ turns }) => {
    const refreshed = turns.map(hiddenTurnFields);
    const result = structuredClone(turns);
    result.forEach((turn, index) => applyHiddenTurnFields(turn, refreshed[index], false));
    return result;
  });
}

function retainedWorkerRead(held: Turn[], spend: Parameters<typeof refreshClaudeAgentFacts>[1]): Turn[] {
  return retainedWorkerPages([held], spend)[0];
}

// A growing finished child's transcript replaces its earlier fallback tool count.

test('a finished background subagent refills its shown tool count when a later read finds more calls', () => {
  const artifactsOf = (tools: Record<string, number>, revision: string): ChildArtifacts => ({
    files: [],
    commits: [],
    tools,
    complete: true,
    revision,
  });
  const lookupOf = (artifacts: ChildArtifacts) => () => ({
    models: [],
    found: true,
    partial: false,
    effort: null,
    artifacts,
  });
  let turns = [
    turn({
      agents: [
        agent({
          id: 'child-bg9',
          toolUseId: 'toolu_bg9',
          status: 'completed',
          toolUses: null,
        }),
      ],
    }),
  ];

  turns = retainedWorkerRead(turns, lookupOf(artifactsOf({ Bash: 2 }, 'child-r1')));
  assert.equal(toCard(turns[0], false, NOW).agents[0].hintDetail, '2 tools');

  turns = retainedWorkerRead(turns, lookupOf(artifactsOf({ Bash: 2, Edit: 3 }, 'child-r2')));
  assert.equal(toCard(turns[0], false, NOW).agents[0].hintDetail, '5 tools');
});

// A later child read replaces a zero fallback tool count when it finds calls.

test('a finished background subagent with a zero tool count fills in once a later read finds calls', () => {
  const artifactsOf = (tools: Record<string, number>, revision: string): ChildArtifacts => ({
    files: [],
    commits: [],
    tools,
    complete: true,
    revision,
  });
  const lookupOf = (artifacts: ChildArtifacts) => () => ({
    models: [],
    found: true,
    partial: false,
    effort: null,
    artifacts,
  });
  let turns = [
    turn({
      agents: [
        agent({
          id: 'child-bg9',
          toolUseId: 'toolu_bg9',
          status: 'completed',
          toolUses: null,
        }),
      ],
    }),
  ];

  turns = retainedWorkerRead(turns, lookupOf(artifactsOf({}, 'child-r1')));
  assert.equal(turns[0].agents[0].toolUses, 0);
  assert.equal(toCard(turns[0], false, NOW).agents[0].hintDetail, '');

  turns = retainedWorkerRead(turns, lookupOf(artifactsOf({ Bash: 3 }, 'child-r2')));
  assert.equal(toCard(turns[0], false, NOW).agents[0].hintDetail, '3 tools');
});

// A result or notification count outranks the artifact fallback even when their initial values match.

test('a genuine tool count survives a later artifacts read that recomputes the same figure', () => {
  const artifactsOf = (tools: Record<string, number>, revision: string): ChildArtifacts => ({
    files: [],
    commits: [],
    tools,
    complete: true,
    revision,
  });
  const lookupOf = (artifacts: ChildArtifacts) => () => ({
    models: [],
    found: true,
    partial: false,
    effort: null,
    artifacts,
  });
  const turns = [turn({ agents: [agent({ id: 'child-bg9', status: 'completed', toolUses: null })] })];

  // Artifacts supply a fallback tool count when the child has no result or notification count.

  refreshClaudeAgentFacts(turns, lookupOf(artifactsOf({ Bash: 5 }, 'child-r1')), undefined);
  assert.equal(turns[0].agents[0].toolUses, 5);

  // A notification count matching the fallback still changes the count's source.

  turns[0].agents[0].toolUses = 5;
  delete turns[0].agents[0].toolUsesFromArtifacts;

  // A larger artifact count must not replace the notification count.

  refreshClaudeAgentFacts(turns, lookupOf(artifactsOf({ Bash: 5, Edit: 4 }, 'child-r2')), undefined);
  assert.equal(turns[0].agents[0].toolUses, 5);
});

// A priced child keeps request and token totals in cost detail. Duration remains a separate figure.

test('a subagent cost record folds its compaction note, and the turn cost keeps it visible', () => {
  const usage = {
    requests: 2,
    input: 1_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 100_000,
    output: 2_000,
    thinking: 0,
  };
  const recorded = {
    model: 'claude-sonnet-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const estimate = { ...recorded, compactionEstimate: true as const, usage: { ...usage, requests: 1 } };
  const card = toCard(
    turn({
      agents: [
        agent({
          spendFound: true,
          spend: [{ model: 'claude-sonnet-5', usage, usageParts: [recorded, estimate] }],
        }),
      ],
    }),
    false,
    NOW,
  );
  const record = card.agents[0].figures.find((figure) => figure.metric === 'cost')?.record;
  const note = /Includes an estimated \$[\d.]+ for 1 compaction\./;
  assert.ok(
    record?.notes?.some((line) => note.test(line)),
    `the subagent record notes are ${JSON.stringify(record?.notes)}`,
  );
  assert.ok(
    !record?.entries.some((entry) =>
      (entry.lines ?? []).some((line) => note.test(typeof line === 'string' ? line : JSON.stringify(line))),
    ),
    'the subagent record still draws the compaction note as a visible line',
  );
  const turnCost = card.chips.find((chip) => chip.metric === 'cost')?.detailList;
  assert.ok(
    turnCost?.footer?.some((line) => note.test(line)),
    `the turn cost footer is ${JSON.stringify(turnCost?.footer)}`,
  );
});

test('a priced child keeps its requests and its token totals in the cost record', () => {
  const card = toCard(
    turn({
      agents: [
        agent({
          durationMs: 60_000,
          toolUses: 4,
          spendFound: true,
          spend: [
            {
              model: 'claude-sonnet-5',
              usage: {
                requests: 18,
                input: 6_000,
                cacheWrite1h: 0,
                cacheWrite5m: 42_000,
                cacheRead: 610_000,
                output: 9_400,
                thinking: 0,
              },
            },
          ],
          artifacts: {
            files: [{ path: 'extension/src/a.ts', added: 2, removed: 0, isNew: false }],
            commits: ['9d7be30'],
            complete: true,
            revision: 'child-r1',
          },
          commits: [
            {
              sha: '9d7be30',
              subject: 'fix(card): one change',
              files: 1,
              added: 2,
              removed: 0,
              at: NOW,
              place: null,
              dir: 'c:/repo',
            },
          ],
        }),
      ],
    }),
    false,
    NOW,
  );
  const figures = card.agents[0].figures;
  assert.deepEqual(
    figures.map((figure) => [figure.metric, figure.compactLabel]),
    [
      ['cost', '$0.33'],
      ['duration', '1m'],
      ['commits', '1 commit'],
      ['files', '1 file'],
    ],
  );
  const cost = figures[0];
  // The usage blocks close the cost record, parted from the money by one rule.
  assert.deepEqual(
    cost.record?.entries.slice(-4).map((entry) => [entry.label, entry.value]),
    [
      ['Input', '658k tokens'],
      ['Output', '9,400 tokens'],
      ['Model requests', '18'],
      ['Input breakdown', undefined],
    ],
  );
  assert.equal(cost.record?.entries.at(-4)?.separateBefore, true);
  assert.deepEqual(cost.record?.entries.at(-1)?.lines, [
    'Cached input reads: 610k tokens (93% of input)',
    'Uncached input: 6,000 tokens',
    '5-minute cache writes: 42k tokens',
  ]);
  // Without spend detail, the child's recorded token count has no popover.

  const counted = toCard(turn({ agents: [agent({ durationMs: 60_000, toolUses: 4, tokens: 12_400 })] }), false, NOW);
  assert.deepEqual(
    counted.agents[0].figures.map((figure) => [figure.metric, figure.compactLabel, !!figure.record]),
    [
      ['duration', '1m', false],
      ['tokens', '12k tokens', false],
    ],
  );
});

test("a child's duration figure opens what it ran and when, from its own record", () => {
  const artifacts = {
    files: [],
    commits: [],
    complete: true,
    revision: 'child-run',
    tools: { Edit: 24, Bash: 71, PowerShell: 1, Read: 1 },
    failed: { count: 3, byTool: { Bash: 2, Edit: 1 } },
    startedAt: NOW - 300_000,
    endedAt: NOW - 60_000,
  };
  const ran = (over: Partial<typeof artifacts> & { complete?: boolean; turnCount?: number }) =>
    toCard(
      turn({
        agents: [agent({ durationMs: 240_000, toolUses: 97, artifacts: { ...artifacts, ...over } })],
      }),
      false,
      NOW,
    ).agents[0].figures.find((figure) => figure.metric === 'duration');
  const figure = ran({});
  assert.deepEqual(figure?.record, {
    heading: { label: 'Ran for 4m' },
    entries: [
      // Tool counts sort by descending count, then name. Their detail omits the total carried by the row tooltip.

      { label: 'Calls by tool', lines: ['71 Bash', '24 Edit', '1 PowerShell', '1 Read'] },
      { label: 'Failed calls', value: '3', lines: ['2 Bash', '1 Edit'] },
      { label: 'Started', value: formatWhen(NOW - 300_000, NOW), separateBefore: true },
      { label: 'Ended', value: formatWhen(NOW - 60_000, NOW) },
    ],
  });
  // The plain reading is the same record in the same order.
  assert.deepEqual(figure?.detail?.split('\n').slice(0, 4), ['Ran for 4m', '', 'Calls by tool', '  71 Bash']);
  // A child none of whose calls failed draws no failure line at all.
  const { failed: _failed, ...clean } = artifacts;
  const quiet = toCard(
    turn({ agents: [agent({ durationMs: 240_000, artifacts: clean })] }),
    false,
    NOW,
  ).agents[0].figures.find((entry) => entry.metric === 'duration');
  assert.deepEqual(
    quiet?.record?.entries.map((entry) => entry.label),
    ['Calls by tool', 'Started', 'Ended'],
  );
  // A child that ran no tool opens on its span, with no rule above it.
  const { tools: _tools, ...idle } = clean;
  const still = toCard(
    turn({ agents: [agent({ durationMs: 240_000, artifacts: idle })] }),
    false,
    NOW,
  ).agents[0].figures.find((entry) => entry.metric === 'duration');
  assert.deepEqual(still?.record?.entries, [
    { label: 'Started', value: formatWhen(NOW - 300_000, NOW) },
    { label: 'Ended', value: formatWhen(NOW - 60_000, NOW) },
  ]);
  // Turn count precedes the child's start and end times.

  const again = ran({ turnCount: 3 });
  assert.deepEqual(again?.record?.entries.slice(-3), [
    { label: 'Turns', value: '3', separateBefore: true },
    { label: 'Started', value: formatWhen(NOW - 300_000, NOW) },
    { label: 'Ended', value: formatWhen(NOW - 60_000, NOW) },
  ]);
  // A record cut short says so under the facts it did hold.
  assert.deepEqual(ran({ complete: false })?.record?.footer, [
    "This child session's record ended early, so this list holds only what Arc read.",
  ]);
  // A child whose own transcript Arc never read keeps a figure with nothing behind it.
  const unread = toCard(turn({ agents: [agent({ durationMs: 240_000 })] }), false, NOW);
  assert.equal(unread.agents[0].figures.find((entry) => entry.metric === 'duration')?.record, undefined);
});

test("a Codex child's rollout reaches its duration figure's record", () => {
  const stamp = (second: number) => new Date(NOW - 60_000 + second * 1000).toISOString();
  const record = (type: string, second: number, payload: Record<string, unknown>) => ({
    timestamp: stamp(second),
    type,
    payload,
  });
  const call = (second: number, id: string) =>
    record('response_item', second, {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: id,
      input: 'await tools.shell_command({command:"npm test"});',
    });
  const output = (second: number, id: string, text: string) =>
    record('response_item', second, {
      type: 'custom_tool_call_output',
      call_id: id,
      output: [{ type: 'input_text', text }],
    });
  const turnId = '01a032c9-1e07-78b2-ae0c-dc76f2dd7901';
  // A second prompt adds another task_started and task_complete pair under a distinct turn ID.

  const turnId2 = '01a032c9-1e07-78b2-ae0c-dc76f2dd7902';
  const rollout = [
    record('session_meta', 0, { id: '01a032c9-1a92-7931-845c-723117d24dbe', cwd: 'c:\\repo', source: 'vscode' }),
    record('event_msg', 1, { type: 'task_started', turn_id: turnId }),
    record('turn_context', 2, { turn_id: turnId, cwd: 'c:\\repo', model: 'gpt-5.6-sol', effort: 'high' }),
    record('event_msg', 3, { type: 'user_message', message: 'run the tests' }),
    call(4, 'call_a'),
    output(5, 'call_a', 'Script completed\nExit code: 0\nOutput:\nok'),
    call(6, 'call_b'),
    output(7, 'call_b', 'Script error:\nnpm is not installed'),
    // An output whose call the rollout never recorded still fails, under no tool name.
    output(8, 'call_lost', 'Script error:\nthe shell closed'),
    record('event_msg', 9, { type: 'task_complete', turn_id: turnId, last_agent_message: 'The tests fail.' }),
    record('event_msg', 10, { type: 'task_started', turn_id: turnId2 }),
    record('turn_context', 11, { turn_id: turnId2, cwd: 'c:\\repo', model: 'gpt-5.6-sol', effort: 'high' }),
    record('event_msg', 12, { type: 'user_message', message: 'install npm and run them again' }),
    record('event_msg', 13, { type: 'task_complete', turn_id: turnId2, last_agent_message: 'Still failing.' }),
  ];
  const file = path.join(
    tempDir('codex-child-run-'),
    'rollout-2026-08-25T12-00-00-01a032c9-1a92-7931-845c-723117d24dbe.jsonl',
  );
  fs.writeFileSync(file, `${rollout.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const { artifacts } = readCodexAgentSpend(file);
  const figure = toCard(turn({ agents: [agent({ durationMs: 5_000, artifacts })] }), false, NOW).agents[0].figures.find(
    (entry) => entry.metric === 'duration',
  );
  assert.deepEqual(figure?.record?.entries, [
    { label: 'Calls by tool', lines: ['2 exec'] },
    { label: 'Failed calls', value: '2', lines: ['1 exec'] },
    // The parent's second prompt to this child shows as a second turn, next to when it ran.
    { label: 'Turns', value: '2', separateBefore: true },
    { label: 'Started', value: formatWhen(Date.parse(stamp(1)), NOW) },
    { label: 'Ended', value: formatWhen(Date.parse(stamp(13)), NOW) },
  ]);
  // A Codex parent records no tool count for its child, so the row's hint counts the child's own calls.
  const parent = turn({ agents: [agent()] });
  refreshCodexStructuralAgents([parent], 'parent-thread', [], () => ({
    models: [],
    effort: null,
    found: true,
    partial: false,
    artifacts,
  }));
  assert.equal(toCard(parent, false, NOW).agents[0].hintDetail, '2 tools');
});

// Read dispatched Claude sessions with childTranscript disabled so later prompts count as separate turns.

function dispatchedClaudeSessionSpend(prompts: string[]) {
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const folder = tempDir('claude-dispatch-turns-');
  const session = path.join(folder, 'sess.jsonl');
  const records: object[] = [];
  prompts.forEach((text, index) => {
    const second = index * 2;
    records.push({
      type: 'user',
      promptId: `p${index}`,
      timestamp: at(second),
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    records.push({
      type: 'assistant',
      timestamp: at(second + 1),
      message: {
        role: 'assistant',
        id: `m${index}`,
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 1000, output_tokens: 0 },
      },
    });
  });
  fs.writeFileSync(session, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return readClaudeAgentSpend(session, [], false);
}

test('a dispatched Claude session someone resumed and prompted again counts its turns', () => {
  const spend = dispatchedClaudeSessionSpend(['do the first thing', 'now do the second thing']);
  const row = dispatchedAgentCard('sess', 'Review the card', spend, 'done', 1000, 65000, 2);
  const entries = row.figures.find((figure) => figure.metric === 'duration')?.record?.entries ?? [];
  assert.deepEqual(
    entries.find((entry) => entry.label === 'Turns'),
    { label: 'Turns', value: '2' },
  );

  const once = dispatchedClaudeSessionSpend(['do the only thing']);
  const singleRow = dispatchedAgentCard('sess2', 'Review the card', once, 'done', 1000, 65000, 1);
  const singleEntries = singleRow.figures.find((figure) => figure.metric === 'duration')?.record?.entries ?? [];
  assert.equal(
    singleEntries.some((entry) => entry.label === 'Turns'),
    false,
  );
});

test('a completed subagent carries cost, commits, and files while a running one carries its cost so far alone', () => {
  const usage = { requests: 1, input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 };
  const artifacts = {
    files: [
      { path: 'extension/src/a.ts', added: 10, removed: 2, isNew: false },
      { path: 'extension/src/b.ts', added: 6, removed: 2, isNew: false },
      { path: 'extension/src/c.ts', added: 2, removed: 0, isNew: false },
    ],
    commits: ['1234567', '89abcde'],
    complete: true,
    revision: 'child-r1',
  };
  const card = toCard(
    turn({
      finished: false,
      endedAt: NOW,
      agents: [
        agent({
          effort: 'high',
          spendFound: true,
          spend: [{ model: 'claude-haiku-4-5', recordedCost: 1.23, costBasis: 'list', usage }],
          artifacts,
        }),
        agent({
          status: 'running',
          spendFound: true,
          spend: [{ model: 'claude-haiku-4-5', recordedCost: 1.23, costBasis: 'list', usage }],
          artifacts,
        }),
      ],
    }),
    true,
    NOW,
  );
  assert.deepEqual(card.agents[0], {
    description: 'Audit the parser',
    model: 'haiku-4-5',
    effort: 'high',
    state: 'done',
    stateWord: '',
    since: null,
    figures: [
      // Recorded list-price totals state their basis without a usage-cost breakdown. Request count follows a separator.

      {
        metric: 'cost',
        compactLabel: '$1.23',
        name: '$1.23 spent',
        record: {
          heading: { label: '$1.23 spent' },
          entries: [
            {
              label: 'Cost by usage · haiku-4-5',
              value: '$1.23',
              lines: ['Total recorded by Claude CLI at list price'],
            },
            { label: 'Model requests', separateBefore: true, value: '1' },
          ],
        },
        detail: [
          '$1.23 spent',
          '',
          'Cost by usage · haiku-4-5: $1.23',
          '  Total recorded by Claude CLI at list price',
          '',
          'Model requests: 1',
        ].join('\n'),
      },
      // Commit figures retain SHAs without subjects. Their row layout enables actions so the popover exposes commit controls.

      {
        metric: 'commits',
        compactLabel: '2 commits',
        name: '2 commits made',
        shas: ['1234567', '89abcde'],
        record: { heading: { label: '2 commits' }, layout: 'commits', actions: true, entries: [] },
        detail: ['2 commits made', '1234567', '89abcde'].join('\n'),
      },
      {
        metric: 'files',
        compactLabel: '3 files',
        name: '3 files, 18 lines added, 4 removed',
        added: 18,
        removed: 4,
        paths: ['extension/src/a.ts', 'extension/src/b.ts', 'extension/src/c.ts'],
        record: {
          heading: { label: '3 files, 18 lines added, 4 removed' },
          layout: 'files',
          actions: true,
          entries: [],
        },
        detail: [
          '3 files, 18 lines added, 4 removed',
          'extension/src/a.ts',
          'extension/src/b.ts',
          'extension/src/c.ts',
        ].join('\n'),
      },
      // Absent token and duration counts add no figures.
    ],
    hintDetail: '',
    sessionId: null,
  });
  assert.deepEqual(
    card.agents[1].figures.map((figure) => [figure.metric, figure.compactLabel, figure.name]),
    [['cost', '$1.23+', 'At least $1.23 spent']],
  );

  // Zero commit and file counts add no figures, even beside a nonzero cost.

  const none = { files: [], commits: [], complete: true, revision: 'child-r2' };
  const costOnly = toCard(
    turn({
      agents: [
        agent({
          spendFound: true,
          spend: [{ model: 'claude-haiku-4-5', recordedCost: 1.23, costBasis: 'list', usage }],
          artifacts: none,
        }),
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    costOnly.agents[0].figures.map((figure) => figure.compactLabel),
    ['$1.23'],
  );
  const nothing = toCard(turn({ agents: [agent({ artifacts: none })] }), false, NOW);
  assert.deepEqual(nothing.agents[0].figures, []);
  // Incomplete evidence still omits zero commit and file counts.

  const partialZeros = toCard(turn({ agents: [agent({ artifacts: { ...none, complete: false } })] }), false, NOW);
  assert.deepEqual(partialZeros.agents[0].figures, []);
  // A child that only removed lines names them in the figure it speaks.
  const removedOnly = toCard(
    turn({
      agents: [
        agent({
          artifacts: {
            ...none,
            files: [{ path: 'extension/src/a.ts', added: 0, removed: 3, isNew: false }],
          },
        }),
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(removedOnly.agents[0].figures, [
    {
      metric: 'files',
      compactLabel: '1 file',
      name: '1 file, 3 lines removed',
      added: 0,
      removed: 3,
      paths: ['extension/src/a.ts'],
      record: { heading: { label: '1 file, 3 lines removed' }, layout: 'files', actions: true, entries: [] },
      detail: ['1 file, 3 lines removed', 'extension/src/a.ts'].join('\n'),
    },
  ]);
});

test("a child's file changes reach the card as rows its record can draw", () => {
  // Parent and child artifacts supply separate file lists, including different spellings of their shared path.

  const card = toCard(
    turn({
      files: [changed('c:/repo/src/parent.ts', 4, 1)],
      agents: [
        agent({
          artifacts: {
            files: [
              { path: String.raw`C:\repo\src\parent.ts`, added: 3, removed: 0, isNew: false },
              { path: 'c:/repo/src/child.ts', added: 7, removed: 2, isNew: true },
            ],
            commits: [],
            complete: true,
            revision: 'child-r4',
          },
        }),
      ],
    }),
    false,
    NOW,
  );
  const figure = card.agents[0].figures.find((entry) => entry.metric === 'files');
  // Shared parent and child paths combine line counts. Child-only paths retain child attribution.

  assert.deepEqual(
    card.files.map((file) => [file.path, file.added, file.removed, file.detail ?? null, file.label]),
    [
      ['c:/repo/src/parent.ts', 7, 1, null, 'File parent.ts'],
      [
        'c:/repo/src/child.ts',
        7,
        2,
        'c:/repo/src/child.ts\nchanged by Audit the parser',
        'File child.ts, new, changed by Audit the parser',
      ],
    ],
  );
  // Each path selected by the child figure matches a card file row.

  assert.deepEqual(figure?.paths, ['c:/repo/src/parent.ts', 'c:/repo/src/child.ts']);
  assert.deepEqual(card.files.filter((file) => figure?.paths?.includes(file.path)).length, 2);
  // The turn's files figure includes child changes and names how many files only a child changed.

  const chip = card.chips.find((held) => held.metric === 'files');
  assert.deepEqual(
    [chip?.label, chip?.name],
    ['2 files', '2 files, 14 lines added, 3 removed, 1 changed by a subagent'],
  );
  assert.equal(card.fileCount, 2);

  // Two children changing one path combine their counts without attributing the shared row to a single child.

  const child = (description: string, added: number, revision: string) =>
    agent({
      description,
      artifacts: {
        files: [{ path: 'c:/repo/src/both.ts', added, removed: 1, isNew: false }],
        commits: [],
        complete: true,
        revision,
      },
    });
  const shared = toCard(turn({ agents: [child('First child', 2, 'r1'), child('Second child', 5, 'r2')] }), false, NOW);
  assert.deepEqual(
    shared.files.map((file) => [file.path, file.added, file.removed, file.detail ?? null]),
    [['c:/repo/src/both.ts', 7, 2, null]],
  );
  assert.deepEqual(
    shared.agents.map((held) => held.figures.find((entry) => entry.metric === 'files')?.paths),
    [['c:/repo/src/both.ts'], ['c:/repo/src/both.ts']],
  );
});

test("a child's uncounted mention keeps the lines the turn counted on the same path", () => {
  // An uncounted child mention preserves the parent's measured lines. The files footer marks their coverage partial.

  const card = toCard(
    turn({
      files: [changed('c:/repo/src/parent.ts', 4, 1)],
      agents: [
        agent({
          artifacts: {
            files: [
              { path: String.raw`C:\repo\src\parent.ts`, added: 0, removed: 0, isNew: false, countsUnknown: true },
            ],
            commits: [],
            complete: true,
            revision: 'child-r5',
          },
        }),
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    [card.fileCount, card.added, card.removed],
    [1, 4, 1],
    'the turn total dropped lines the turn counted because a child named the path',
  );
  assert.deepEqual(
    card.files.map((file) => [file.path, file.added, file.removed, file.countsUnknown ?? null]),
    [['c:/repo/src/parent.ts', 4, 1, null]],
    'the row lost the lines the turn counted, or it reads as a file with no counts at all',
  );
  const chip = card.chips.find((held) => held.metric === 'files');
  assert.deepEqual([chip?.added, chip?.removed], [4, 1]);
  assert.deepEqual(chip?.detail.split('\n'), ['1 file: +4 −1', '', 'parent.ts: +4 −1']);
  assert.deepEqual(chip?.detailList?.footer, ['1 file carries partial line counts.']);

  // A child-only uncounted path contributes a file row without line totals.

  const mentioned = toCard(
    turn({
      agents: [
        agent({
          artifacts: {
            files: [{ path: 'c:/repo/src/child.ts', added: 0, removed: 0, isNew: false, countsUnknown: true }],
            commits: [],
            complete: true,
            revision: 'child-r6',
          },
        }),
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual([mentioned.files[0].countsUnknown ?? null, mentioned.added, mentioned.removed], [true, 0, 0]);

  // Two children on one path, one carrying its hunks and one naming the file without them. The
  // counted child's lines reach the row and the total whichever child is read first.
  const child = (description: string, revision: string, counted: boolean) =>
    agent({
      description,
      artifacts: {
        files: [
          counted
            ? { path: 'c:/repo/src/both.ts', added: 5, removed: 1, isNew: false }
            : { path: 'c:/repo/src/both.ts', added: 0, removed: 0, isNew: false, countsUnknown: true },
        ],
        commits: [],
        complete: true,
        revision,
      },
    });
  for (const order of [
    [true, false],
    [false, true],
  ]) {
    const shared = toCard(
      turn({
        agents: order.map((counted, index) => child(`Child ${index}`, `r${index}`, counted)),
      }),
      false,
      NOW,
    );
    assert.deepEqual(
      [
        shared.files.map((file) => [file.added, file.removed, file.countsUnknown ?? null]),
        shared.added,
        shared.removed,
      ],
      [[[5, 1, null]], 5, 1],
      'the order the children were read in changed what the turn counted',
    );
  }
});

test('one child that both counted and mentioned a path keeps the floor on its own row', () => {
  // Child edits and whole-file writes retain measured lines and their partial-coverage cause, within one turn or across separate turns.

  const counted = { path: 'c:/repo/src/both.ts', added: 5, removed: 1, isNew: false, edits: [] };
  const mentioned = {
    path: 'c:/repo/src/both.ts',
    added: 0,
    removed: 0,
    isNew: false,
    edits: [],
    countsUnknown: true as const,
    unknownReason: 'write' as const,
  };
  for (const turns of [
    [{ files: [{ ...counted, countsUnknown: true as const, unknownReason: 'write' as const }], commits: [] }],
    [
      { files: [counted], commits: [] },
      { files: [mentioned], commits: [] },
    ],
  ]) {
    const artifacts = reduceChildArtifacts(
      { turns },
      {
        revision: 'child-r7',
        complete: true,
        pathKey: normalizeFsPath,
        sameCommit: sameCommitSha,
      },
    );
    const card = toCard(turn({ agents: [agent({ artifacts })] }), false, NOW);
    // The child file row retains its measured lines.

    assert.deepEqual(
      card.files.map((file) => [file.added, file.removed, file.countsUnknown ?? null]),
      [[5, 1, null]],
    );
    // Partial line counts remain included in turn totals.
    assert.deepEqual([card.added, card.removed], [5, 1]);
    const figure = card.agents[0].figures.find((entry) => entry.metric === 'files');
    assert.deepEqual([figure?.compactLabel, figure?.added, figure?.removed], ['1 file', 5, 1]);
    // The accessible figure name reports measured counts without the partial-coverage explanation.
    assert.equal(figure?.name, '1 file, 5 lines added, 1 removed');
    // Flat file detail omits the footer's coverage explanation.
    assert.deepEqual((figure?.detail ?? '').split('\n'), ['1 file, 5 lines added, 1 removed', 'c:/repo/src/both.ts']);
    // The footer identifies the whole-file write as the cause of partial line coverage.

    assert.deepEqual(figure?.record?.footer, ['1 file was written whole, so its line counts are partial.']);
  }
});

test("a child's written-whole row keeps its cause where the turn already holds the path", () => {
  // A shared parent path retains the child's counted lines and whole-file-write cause in the turn figure's footer.

  const artifacts = reduceChildArtifacts(
    {
      turns: [
        {
          files: [
            { path: 'c:/repo/src/app.ts', added: 3, removed: 0, isNew: false, edits: [] },
            {
              path: 'c:/repo/src/app.ts',
              added: 0,
              removed: 0,
              isNew: false,
              edits: [],
              countsUnknown: true,
              unknownReason: 'write',
            },
          ],
          commits: [],
        },
      ],
    },
    { revision: 'child-r8', complete: true, pathKey: normalizeFsPath, sameCommit: sameCommitSha },
  );
  const card = toCard(
    turn({
      files: [changed('c:/repo/src/app.ts', 2, 0)],
      agents: [agent({ description: 'Rewrite app', artifacts })],
    }),
    false,
    NOW,
  );
  const said = '1 file was written whole, so its line counts are partial.';
  assert.deepEqual(card.agents[0].figures.find((entry) => entry.metric === 'files')?.record?.footer, [said]);
  assert.deepEqual([card.added, card.removed], [5, 0]);
  assert.deepEqual(
    card.chips.find((chip) => chip.metric === 'files')?.detailList?.footer,
    [said],
    "the turn's record lost the cause the subagent's record gives for the same file",
  );
});

test("a child's files record names the card's own spelling of a path the child recorded another way", () => {
  // The child figure uses the card's path spelling so exact row selection still finds the shared file.

  const card = toCard(
    turn({
      files: [{ path: 'C:\\repo\\src\\A.ts', added: 2, removed: 0, isNew: false, edits: [] }],
      agents: [
        agent({
          artifacts: {
            files: [{ path: 'c:/repo/src/a.ts', added: 2, removed: 0, isNew: false }],
            commits: [],
            complete: true,
            revision: 'child-r3',
          },
        }),
      ],
    }),
    false,
    NOW,
  );
  const figure = card.agents[0].figures.find((entry) => entry.metric === 'files');
  assert.deepEqual(figure?.paths, [card.files[0].path]);
});

// Footer text for incomplete child evidence.

const CUT_SHORT = "This child session's record ended early, so this list holds only what Arc read.";

test('a completed subagent marks incomplete commit and file evidence without obscuring line counts', () => {
  const artifacts = {
    files: [
      { path: 'extension/src/a.ts', added: 10, removed: 2, isNew: false },
      { path: 'extension/src/b.ts', added: 6, removed: 2, isNew: false },
      { path: 'extension/src/c.ts', added: 2, removed: 0, isNew: false },
    ],
    commits: ['1234567', '89abcde'],
    complete: false,
    revision: 'child-r1',
  };
  const card = toCard(turn({ agents: [agent({ artifacts })] }), false, NOW);
  // Incomplete child figures show lower-bound wording and explain their coverage in the footer.

  assert.deepEqual(card.agents[0].figures, [
    {
      metric: 'commits',
      compactLabel: '2+ commits',
      name: 'At least 2 commits made',
      shas: ['1234567', '89abcde'],
      record: {
        heading: { label: 'At least 2 commits' },
        layout: 'commits',
        actions: true,
        entries: [],
        footer: [CUT_SHORT],
      },
      detail: ['At least 2 commits made', '1234567', '89abcde'].join('\n'),
    },
    {
      metric: 'files',
      compactLabel: '3+ files',
      name: 'At least 3 files, 18 lines added, 4 removed',
      added: 18,
      removed: 4,
      paths: ['extension/src/a.ts', 'extension/src/b.ts', 'extension/src/c.ts'],
      record: {
        heading: { label: 'At least 3 files, 18 lines added, 4 removed' },
        layout: 'files',
        actions: true,
        entries: [],
        footer: [CUT_SHORT],
      },
      detail: [
        'At least 3 files, 18 lines added, 4 removed',
        'extension/src/a.ts',
        'extension/src/b.ts',
        'extension/src/c.ts',
      ].join('\n'),
    },
  ]);
  // The incomplete-coverage sentence appears only in the footer.

  for (const figure of card.agents[0].figures) {
    const count = (text: string) => text.split(CUT_SHORT).length - 1;
    assert.equal(count(figure.detail ?? '') + count((figure.record?.footer ?? []).join('\n')), 1);
  }
});

test('an incomplete subagent runs the record-cut-short sentence once on its duration figure too', () => {
  const artifacts = {
    files: [],
    commits: [],
    complete: false,
    revision: 'child-r2',
    startedAt: NOW - 120_000,
    endedAt: NOW - 60_000,
  };
  const card = toCard(turn({ agents: [agent({ artifacts, durationMs: 60_000 })] }), false, NOW);
  const figure = card.agents[0].figures.find((entry) => entry.metric === 'duration');
  assert.ok(figure?.record, 'the duration figure drew no record for a child with a recorded span');
  // Duration detail also keeps the incomplete-coverage sentence in its footer alone.

  const count = (text: string) => text.split(CUT_SHORT).length - 1;
  assert.equal(count(figure?.detail ?? '') + count((figure?.record?.footer ?? []).join('\n')), 1);
});

test('every status a reader records draws its own state, and only a real failure draws failed', () => {
  // running, async_launched, and launched map to running. completed maps to done. failed and interrupted retain their names. Other terminal statuses become stopped.

  const statuses = [
    'running',
    'async_launched',
    'launched',
    'completed',
    'failed',
    'interrupted',
    'killed',
    'stopped',
    'shutdown',
  ];
  const card = toCard(
    turn({ finished: false, endedAt: NOW, agents: statuses.map((status) => agent({ model: null, status })) }),
    true,
    NOW,
  );
  assert.equal(card.status, 'running');
  assert.deepEqual(
    card.agents.map((held) => [held.state, held.stateWord]),
    [
      ['running', 'running'],
      ['running', 'running'],
      ['running', 'running'],
      ['done', ''],
      ['failed', 'failed'],
      ['interrupted', 'interrupted'],
      ['stopped', 'stopped'],
      ['stopped', 'stopped'],
      ['stopped', 'stopped'],
    ],
  );
  assert.deepEqual(card.chips.find((chip) => chip.metric === 'agents')?.detailList?.heading, {
    label: '9 subagents in this turn',
    value: '3 running',
    busyValue: true,
  });
});

// The agents heading includes carried running children. Its footer counts children started before this turn, independent of their launching turns.

test('the agents popover heading counts every subagent its running figure counts', () => {
  const finished = turn({
    finished: true,
    endedAt: NOW - 60_000,
    agents: [agent({ id: 'own-1', status: 'completed' })],
  });
  const popover = (children: string[], held = finished) =>
    toCard(held, true, NOW, [], null, false, new Set(children)).chips.find((chip) => chip.metric === 'agents')
      ?.detailList;
  const read = (list: ReturnType<typeof popover>) => ({ heading: list?.heading, footer: list?.footer });
  assert.deepEqual(
    read(popover([])),
    { heading: { label: '1 subagent in this turn' }, footer: undefined },
    'a card with no carried subagent lost its own wording',
  );
  const resumed = toCard(finished, true, NOW, [], null, false, new Set(['own-1']));
  assert.deepEqual(
    {
      row: [resumed.agents[0].state, resumed.agents[0].stateWord],
      heading: resumed.chips.find((chip) => chip.metric === 'agents')?.detailList?.heading,
      footer: resumed.chips.find((chip) => chip.metric === 'agents')?.detailList?.footer,
    },
    {
      row: ['running', 'running'],
      heading: { label: '1 subagent in this turn', value: '1 running', busyValue: true },
      footer: undefined,
    },
    'a resumed completed row was duplicated as a carried child instead of becoming live',
  );
  assert.deepEqual(read(popover(['carried-1'])), {
    heading: { label: '2 subagents', value: '1 running', busyValue: true },
    footer: ['1 subagent started before this turn'],
  });
  assert.deepEqual(read(popover(['carried-1', 'carried-2'])), {
    heading: { label: '3 subagents', value: '2 running', busyValue: true },
    footer: ['2 subagents started before this turn'],
  });
  // Without launches in this turn, the agents heading names the carried children directly.

  assert.deepEqual(read(popover(['carried-1', 'carried-2'], turn({ finished: true, endedAt: NOW - 60_000 }))), {
    heading: { label: '2 subagents started before this turn', value: '2 running', busyValue: true },
    footer: undefined,
  });
});

test('an open subagent counts up only while its own turn runs', () => {
  const launched = NOW - 3 * 24 * 60 * 60_000;
  const record = {
    endedAt: launched + 5_000,
    steps: [step({ name: 'spawn_agent', id: 'spawn-1', at: launched, status: 'done' })],
    stepCount: 1,
    agents: [agent({ toolUseId: 'spawn-1', status: 'launched' })],
  };
  const drawn = (over: Partial<Turn>, isLatest = true) => {
    const card = toCard(turn({ ...record, ...over }), isLatest, NOW);
    const heading = card.chips.find((chip) => chip.metric === 'agents')?.detailList?.heading;
    return [
      card.status,
      card.agents[0].state,
      card.agents[0].stateWord,
      card.agents[0].since,
      heading?.value,
      heading?.busyValue ?? false,
    ];
  };
  // A child of a running turn counts up from its launch, in the busy tone.
  assert.deepEqual(drawn({ finished: false, endedAt: NOW - 1_000 }), [
    'running',
    'running',
    'running',
    launched,
    '1 running',
    true,
  ]);
  // Outside a running parent turn, an unfinished child reports no recorded ending and carries no live clock or running count.

  const open = ['open', 'no ending recorded', null, undefined, false];
  assert.deepEqual(drawn({ finished: true }), ['done', ...open]);
  assert.deepEqual(drawn({ finished: true }, false), ['done', ...open]);
  assert.deepEqual(drawn({ finished: true, processEndedAt: launched + 10_000 }), ['done', ...open]);
  assert.deepEqual(drawn({ finished: false }), ['stopped', ...open]);
  assert.deepEqual(drawn({ finished: false, error: 'API error' }), ['failed', ...open]);
  assert.deepEqual(drawn({ finished: false, interrupted: true }), ['interrupted', ...open]);
});

test('a completed subagent detail puts its recorded effort before its usage', () => {
  const card = toCard(
    turn({
      agents: [
        agent({
          model: 'gpt-5.6-sol',
          effort: 'high',
          spend: [
            {
              model: 'gpt-5.6-sol',
              usage: {
                requests: 69,
                input: 8_400_000,
                cacheWrite1h: 0,
                cacheWrite5m: 0,
                cacheRead: 0,
                output: 17_000,
                thinking: 0,
              },
            },
          ],
        }),
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(card.chips.find((chip) => chip.metric === 'agents')?.detailList, {
    layout: 'agents',
    actions: true,
    heading: { label: '1 subagent in this turn' },
    entries: [
      {
        label: 'Audit the parser',
        lines: ['gpt-5.6-sol \u00b7 high \u00b7 69 requests \u00b7 8.4M in \u00b7 17k out'],
      },
    ],
  });
});

test('a subagent status is not repeated inside its detail, and a finished one names no state', () => {
  const running = toCard(
    turn({ finished: false, endedAt: NOW, agents: [agent({ model: null, status: 'running' })] }),
    true,
    NOW,
  );
  const completed = toCard(turn({ agents: [agent({ model: null, status: 'completed' })] }), true, NOW);
  const failed = toCard(turn({ agents: [agent({ model: null, status: 'failed' })] }), true, NOW);
  assert.deepEqual(
    [running, completed, failed].map((held) => [
      held.agents[0].figures,
      held.agents[0].state,
      held.agents[0].stateWord,
    ]),
    [
      [[], 'running', 'running'],
      [[], 'done', ''],
      [[], 'failed', 'failed'],
    ],
  );
  // The chip's text and the popover entries drawn without the record rows name no state either.
  const chip = completed.chips.find((held) => held.metric === 'agents');
  assert.deepEqual(
    [chip?.detail, chip?.detailList?.entries],
    ['Audit the parser', [{ label: 'Audit the parser', lines: [] }]],
  );
  const failedChip = failed.chips.find((held) => held.metric === 'agents');
  assert.deepEqual(
    [failedChip?.detail, failedChip?.detailList?.entries],
    ['Audit the parser\n  failed', [{ label: 'Audit the parser', lines: ['failed'] }]],
  );
});

// Child usage fixture with only input tokens populated.

const ran = (model: string | null, input: number) => ({
  model,
  usage: { input, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
});

test('a subagent whose call named no model takes it from what the child billed', () => {
  const card = toCard(
    turn({
      agents: [
        agent({
          model: null,
          spend: [ran('claude-opus-5', 66_000)],
        }),
      ],
    }),
    true,
    NOW,
  );
  assert.equal(card.agents[0].model, 'opus-5');
});

test('a subagent that changed model names the one it spent most under', () => {
  const card = toCard(
    turn({
      agents: [
        agent({
          model: null,
          spend: [ran('claude-haiku-4-5', 10_000), ran('claude-opus-5', 90_000)],
        }),
      ],
    }),
    true,
    NOW,
  );
  assert.equal(card.agents[0].model, 'opus-5');
});

test('a subagent row names the model the child ran, not the alias on the call or a nested model', () => {
  // The spend includes a nested subagent that read more under haiku than the child did under opus.
  const launched = turn({
    steps: [step({ name: 'Agent', id: 'agent-1', detail: 'Audit the parser' })],
    stepCount: 1,
    agents: [
      agent({
        toolUseId: 'agent-1',
        model: 'opus',
        ownModel: 'claude-opus-5-5',
        effort: 'high',
        spend: [ran('claude-opus-5-5', 30_000), ran('claude-haiku-4-5', 60_000)],
      }),
    ],
  });
  const card = toCard(launched, true, NOW);
  assert.equal(card.agents[0].model, 'opus-5-5');
  assert.equal(logOf(launched).rows[0].figure, 'opus-5-5 · high');
  assert.equal(
    card.chips.find((chip) => chip.metric === 'agents')?.detail.split('\n')[1],
    '  opus-5-5 · high · 90k in',
  );
  // A child with no recorded spend keeps the model named on the call.
  const unpriced = toCard(turn({ agents: [agent({ model: 'opus', spend: [] })] }), true, NOW);
  assert.equal(unpriced.agents[0].model, 'opus');
});

test('billed usage that names no model never outweighs usage that does', () => {
  const card = toCard(
    turn({
      agents: [
        agent({
          model: null,
          spend: [ran(null, 90_000), ran('claude-opus-5', 10_000)],
        }),
      ],
    }),
    true,
    NOW,
  );
  assert.equal(card.agents[0].model, 'opus-5');
});

test('a launch row reads the model the same way the card does', () => {
  const rows = logOf(
    turn({
      steps: [step({ name: 'Agent', id: 'agent-1', detail: 'Audit the parser' })],
      stepCount: 1,
      agents: [
        agent({
          toolUseId: 'agent-1',
          model: null,
          spend: [ran('claude-opus-5', 66_000)],
        }),
      ],
    }),
  ).rows;
  assert.equal(rows[0].figure, 'opus-5');
});

test('a running turn counts from its start to now, a finished one to its last activity', () => {
  const running = toCard(turn({ finished: false, endedAt: NOW - 60_000 }), true, NOW);
  assert.equal(running.live, true);
  assert.equal(running.duration, '5h 28m'); // 2:32 PM to the 8:00 PM "now"
  const done = toCard(turn(), false, NOW);
  assert.equal(done.live, false);
  assert.equal(done.duration, '12m');
});

test('the card key is stable for one turn and distinct between sessions', () => {
  const a = toCard(turn(), false, NOW);
  const b = toCard(turn({ sessionId: 'other' }), false, NOW);
  assert.equal(a.key, toCard(turn(), false, NOW).key);
  assert.notEqual(a.key, b.key);
});

test('the token detail reconciles output, thinking, input and cache volume', () => {
  const t = turn({
    usage: {
      requests: 1,
      input: 3000,
      cacheWrite1h: 10_000,
      cacheWrite5m: 20_000,
      cacheWrite30m: 30_000,
      cacheRead: 60_000,
      output: 1440,
      thinking: 1037,
    },
  });
  assert.deepEqual(tokenLines(t), [
    'Input: 123k tokens',
    'Output: 1,440 tokens',
    '  Thinking: 1,037 tokens (72% of output), included in output',
    'Model requests: 1',
    '',
    'Input breakdown',
    '  Cached input reads: 60k tokens (49% of input)',
    '  Uncached input: 3,000 tokens',
    '  1-hour cache writes: 10k tokens',
    '  5-minute cache writes: 20k tokens',
    '  30-minute cache writes: 30k tokens',
  ]);
});

test('turn token detail keeps advisor billing and executor cache percentages and averages', () => {
  const file = path.join(tempDir('advisor-token-detail-'), 'session.jsonl');
  fs.writeFileSync(
    file,
    [advisorProbeRecords()[0], ...advisorResponseRecords(), ...advisorResponseRecords({ id: 'second', at: 30 })]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const subject = readSession(file, 'advisor-probe').turns[0];
  assert.equal(subject.usage.requests, 4);
  assert.equal(subject.usage.input, 89_622);
  assert.equal(subject.usage.output, 1_066);
  const detail = tokenLines(subject).join('\n');
  assert.match(detail, /Model requests: 4/);
  assert.match(detail, /Cached input reads: .*\(50% of input\)/);
  assert.ok(detail.includes(`Average input per request: ${formatTokens(86_702)} tokens`));
  assert.ok(detail.includes(`Input: ${formatTokens(263_018)} tokens`));
});

test('per-pass pricing corrects turn cost and executor input facts without an advisor entry', () => {
  const file = path.join(tempDir('pass-cost-'), 'session.jsonl');
  fs.writeFileSync(
    file,
    [advisorProbeRecords()[0], ...advisorResponseRecords({ iterations: PER_PASS_ITERATIONS, thinking: 152 })]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const subject = readSession(file, 'advisor-probe').turns[0];
  assert.ok(Math.abs(turnCost(subject).dollars! - 0.153730325) < 1e-12);
  assert.ok(Math.abs(pricing.estimateCost(subject.usageParts![0].usage, subject.model)! - 0.013920325) < 1e-12);
  assert.equal(averageContextPerRequest(subject.usageParts![0].usage), 131617);
  const detail = costDetail(subject).join('\n');
  assert.match(detail, /50% cached · 1 request · 132k avg input/);
  assert.doesNotMatch(detail, /advisor/i);
  assert.equal(subject.usage.requests, 2);
  assert.equal(subject.usage.cacheRead, 65580);
});

test('per-pass pricing keeps both threshold bands on a turn without an advisor', () => {
  const file = path.join(tempDir('pass-bands-'), 'session.jsonl');
  fs.writeFileSync(
    file,
    [advisorProbeRecords()[0], ...advisorResponseRecords({ iterations: MIXED_PASS_ITERATIONS, thinking: 3 })]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const subject = readSession(file, 'advisor-probe').turns[0];
  assert.ok(Math.abs(turnCost(subject).dollars! - 0.0600315) < 1e-12);
  assert.equal(subject.usage.requests, 1);
  assert.equal(subject.usageParts?.[0].contextBand, null);
  assert.deepEqual([subject.usage.byContextBand?.short?.requests, subject.usage.byContextBand?.long?.requests], [0, 1]);
  assert.equal(subject.usage.byContextBand?.long?.thinking, 3);
});

test('per-pass pricing uses only the final answer for the next-turn starting price', () => {
  const file = path.join(tempDir('pass-next-'), 'session.jsonl');
  const iterations = [
    advisorIteration({ input_tokens: 99800, output_tokens: 150 }),
    advisorIteration({ cache_read_input_tokens: 99980, output_tokens: 10 }),
  ];
  fs.writeFileSync(
    file,
    [advisorProbeRecords()[0], ...advisorResponseRecords({ iterations })]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const subject = readSession(file, 'advisor-probe').turns[0];
  const basis = nextTurnBasisOf(subject, null)!;
  assert.equal(basis.tokens, 99980);
  assert.equal(basis.outputTokens, 10);
  assert.equal(subject.contextRequest?.readBack, true);
  const price = pricing.nextTurnFloor({
    contextTokens: basis.tokens,
    freshTokens: basis.outputTokens,
    model: basis.model,
    tier: '5m',
  })!;
  assert.ok(Math.abs(price.cold - 0.01249875) < 1e-12);
  fs.appendFileSync(
    file,
    advisorResponseRecords({
      id: 'cold-final',
      at: 30,
      iterations: [advisorIteration({ cache_read_input_tokens: 4500 }), advisorIteration({ input_tokens: 99990 })],
    })
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  assert.equal(readSession(file, 'advisor-probe').turns[0].contextRequest?.readBack, false);
});

test('token and cost details keep shared usage labels in one relative order', () => {
  const t = turn({
    agent: 'codex',
    model: 'gpt-5.6-sol',
    provider: 'openai',
    usage: {
      requests: 1,
      input: 200,
      cacheWrite1h: 40_000,
      cacheWrite5m: 8000,
      cacheWrite30m: 5000,
      cacheRead: 100_000,
      output: 10_000,
      thinking: 0,
    },
  });
  const labelOf = (line: string) => line.trim().split(':', 1)[0];
  const costLabels = costDetail(t)
    .filter((line) => /^ {2}\S/.test(line))
    .map(labelOf);
  const tokenLabels = tokenLines(t).map(labelOf);

  assert.equal(costLabels.length, 6, 'the all-category turn did not print every cost category');
  assert.deepEqual(
    tokenLabels.filter((label) => costLabels.includes(label)),
    costLabels,
  );
});

test('the token detail keeps request counts when no input volume was recorded', () => {
  const usage = { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 500, thinking: 0 };
  assert.deepEqual(tokenLines(turn({ usage: { ...usage, requests: 1 } })), ['Output: 500 tokens', 'Model requests: 1']);
  assert.deepEqual(tokenLines(turn({ usage: { ...usage, requests: 2 } })), ['Output: 500 tokens', 'Model requests: 2']);
});

test('a turn explains its priced cached input reads once', () => {
  const card = toCard(
    turn({
      usage: { requests: 1, input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 1_000_000, output: 0, thinking: 0 },
    }),
    false,
    NOW,
  );
  const cost = card.chips[0];
  assert.equal(cost.label, '$0.50');
  assert.match(cost.detail, /Cached input reads: \$0\.50/);
  assert.equal(cost.detail.split(CACHED_INPUT_READ_EXPLANATION).length - 1, 1);
  assert.match(cost.detail, /Estimated from published model rates\. Your actual charge may differ/);
  assert.equal(
    card.chips.some((chip) => chip.label.endsWith(' reread')),
    false,
    'the reread amount is still presented as a second cost',
  );
  assert.doesNotMatch(
    costDetail(turn()).join('\n'),
    new RegExp(CACHED_INPUT_READ_EXPLANATION),
    'a turn with no priced cached input category gets no cache explanation',
  );
});

test('a cached-read cost shows its cache share and request scale on one line', () => {
  const card = toCard(
    turn({
      usage: {
        requests: 206,
        input: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheRead: 100_528_000,
        output: 0,
        thinking: 0,
      },
    }),
    false,
    NOW,
  );
  const entry = card.chips[0].detailList!.entries[0];
  // Request scale carries the request count and average input rounded to whole tokens.

  assert.deepEqual(entry.lines, [
    {
      text: 'Cached input reads: $50',
      cost: true,
      cacheHit: { percent: 100, warning: false, requestScale: [206, 488_000] },
    },
  ]);
  assert.match(card.chips[0].detail, /Cached input reads: \$50 \(100% cached · 206 requests · 488k avg input\)/);
});

test('aggregate and exact turn cost detail keep the same cached-read facts', () => {
  const usage = {
    requests: 11,
    input: 132_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 2_068_000,
    output: 0,
    thinking: 0,
  };
  const usagePart = {
    model: 'claude-opus-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const turnChip = toCard(turn({ model: 'claude-opus-5', usage, usageParts: [usagePart] }), false, NOW).chips.find(
    (chip) => chip.metric === 'cost',
  )!;
  const aggregateTurnChip = toCard(turn({ model: 'claude-opus-5', usage }), false, NOW).chips.find(
    (chip) => chip.metric === 'cost',
  )!;
  const sessionChip = sessionCostStats([{ agent: 'claude', role: 'main', ...usagePart }])[0];
  const cachedRead = (chip: typeof turnChip) =>
    chip.detailList!.entries[0].lines!.find(
      (line) => typeof line === 'object' && 'text' in line && line.text.startsWith('Cached input reads:'),
    );

  assert.deepEqual(cachedRead(turnChip), cachedRead(aggregateTurnChip));
  assert.deepEqual(cachedRead(turnChip), cachedRead(sessionChip));
  assert.deepEqual(cachedRead(turnChip), {
    text: 'Cached input reads: $1.03',
    cost: true,
    cacheHit: { percent: 94, warning: false, requestScale: [11, 200_000] },
  });

  const zeroReadUsage = { ...usage, input: 2_200_000, cacheRead: 0 };
  const zeroReadPart = { ...usagePart, usage: zeroReadUsage };
  const zeroReadTurnChip = toCard(
    turn({ model: 'claude-opus-5', usage: zeroReadUsage, usageParts: [zeroReadPart] }),
    false,
    NOW,
  ).chips.find((chip) => chip.metric === 'cost')!;
  const zeroReadAggregateChip = toCard(turn({ model: 'claude-opus-5', usage: zeroReadUsage }), false, NOW).chips.find(
    (chip) => chip.metric === 'cost',
  )!;
  const zeroReadSessionChip = sessionCostStats([{ agent: 'claude', role: 'main', ...zeroReadPart }])[0];
  assert.deepEqual(cachedRead(zeroReadTurnChip), cachedRead(zeroReadAggregateChip));
  assert.deepEqual(cachedRead(zeroReadTurnChip), cachedRead(zeroReadSessionChip));
  assert.deepEqual(cachedRead(zeroReadTurnChip), {
    text: 'Cached input reads: $0',
    cost: true,
    cacheHit: { percent: 0, warning: true, requestScale: [11, 200_000] },
  });
});

test('a Bedrock Codex turn shows recorded usage and its list-price estimate', () => {
  const card = toCard(
    turn({
      agent: 'codex',
      model: 'openai.gpt-5.6-sol',
      provider: 'amazon-bedrock',
      usage: {
        requests: 1,
        input: 292,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 20562,
        cacheRead: 35714,
        output: 807,
        thinking: 190,
      },
    }),
    false,
    NOW,
  );
  assert.equal(costChip(card), '$0.15');
  const cost = card.chips.find((chip) => chip.label === '$0.15')!;
  assert.match(cost.detail, /30-minute cache writes: \$0\.11/);
  assert.match(cost.detail, /Estimated from published model rates\. Your actual charge may differ/);
  const token = card.chips.find((chip) => chip.label.includes(' in'))!;
  assert.equal(token.label, '57k in · 807 out');
  assert.match(token.detail, /30-minute cache writes: 21k tokens/);
  assert.match(token.detail, /Uncached input: 292 tokens/);
});

test('a single legacy Bedrock request can recover its context band from token volume', () => {
  const card = toCard(
    turn({
      agent: 'codex',
      model: 'openai.gpt-5.6-sol',
      provider: 'amazon-bedrock',
      contextWindow: 1_000_000,
      usage: {
        requests: 1,
        input: 300_000,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead: 0,
        output: 1000,
        thinking: 0,
      },
    }),
    false,
    NOW,
  );
  assert.equal(costChip(card), '$2.67');
  assert.ok(card.chips.some((chip) => chip.label === '300k in · 1k out'));
});

test('a direct OpenAI turn prices mixed request bands together', () => {
  const card = toCard(
    turn({
      agent: 'codex',
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      usage: {
        requests: 2,
        input: 400_000,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead: 0,
        output: 30_000,
        thinking: 0,
        byContextBand: {
          short: {
            requests: 1,
            input: 100_000,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheWrite30m: 0,
            cacheRead: 0,
            output: 10_000,
            thinking: 0,
          },
          long: {
            requests: 1,
            input: 300_000,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheWrite30m: 0,
            cacheRead: 0,
            output: 20_000,
            thinking: 0,
          },
        },
      },
    }),
    false,
    NOW,
  );
  assert.equal(costChip(card), '$4.70');
  assert.match(
    card.chips.find((chip) => chip.label === '$4.70')!.detail,
    /Estimated from published model rates\. Your actual charge may differ/,
  );
});

test('a direct OpenAI turn stays unpriced when it records a cache write with no published rate', () => {
  const card = toCard(
    turn({
      agent: 'codex',
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 258_400,
      usage: {
        requests: 1,
        input: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 100_000,
        cacheRead: 0,
        output: 0,
        thinking: 0,
        byContextBand: {
          short: {
            requests: 1,
            input: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheWrite30m: 100_000,
            cacheRead: 0,
            output: 0,
            thinking: 0,
          },
        },
      },
    }),
    false,
    NOW,
  );
  assert.equal(costChip(card), undefined);
  assert.ok(card.chips.some((chip) => chip.label.includes('100k in')));
});

test('a mixed-band cached reread keeps its long-context price in the cost detail', () => {
  const card = toCard(
    turn({
      agent: 'codex',
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      usage: {
        requests: 2,
        input: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead: 400_000,
        output: 0,
        thinking: 0,
        byContextBand: {
          short: {
            requests: 1,
            input: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheWrite30m: 0,
            cacheRead: 100_000,
            output: 0,
            thinking: 0,
          },
          long: {
            requests: 1,
            input: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheWrite30m: 0,
            cacheRead: 300_000,
            output: 0,
            thinking: 0,
          },
        },
      },
    }),
    false,
    NOW,
  );
  assert.equal(costChip(card), '$0.35');
  assert.match(card.chips.find((chip) => chip.label === '$0.35')!.detail, /Cached input reads: \$0\.35/);
});

// Cached-read cost detail includes request count and average input.

test('the cached-input-reads money line says how many requests bought the reads', () => {
  const many = costDetail(
    turn({
      usage: {
        requests: 206,
        input: 528_000,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheRead: 100_000_000,
        output: 0,
        thinking: 0,
      },
    }),
  ).join('\n');
  assert.match(
    many,
    /Cached input reads: \$[\d,.]+ \(99% cached · 206 requests · 488k avg input\)/,
    `the money list drops the scale behind the reads: ${many}`,
  );
  // Request scale belongs to the cached-read line, not uncached-input or output lines.

  assert.doesNotMatch(many, /Uncached input: [^\n]*requests/);
  // A single request retains its request count and average input.
  const one = costDetail(
    turn({
      usage: {
        requests: 1,
        input: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheRead: 3_000_000,
        output: 0,
        thinking: 0,
      },
    }),
  ).join('\n');
  assert.match(
    one,
    /Cached input reads: \$1\.50 \(100% cached · 1 request · 3M avg input\)$/m,
    `a single request loses its scale: ${one}`,
  );
});

// High cache share retains request-scale detail independently of the priced total.

test('the cached-read line keeps request scale when the cache share is high', () => {
  const usage = {
    requests: 200,
    input: 1_000_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 99_000_000,
    output: 400_000,
    thinking: 0,
  };
  const part = {
    agent: 'claude',
    role: 'main' as const,
    model: 'claude-opus-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const priced = sessionCostStats([part])[0];
  assert.match(
    priced.detail,
    /Cached input reads: \$50 \(99% cached · 200 requests · 500k avg input\)/,
    `a 99% cached session loses its request scale: ${priced.detail}`,
  );
  // High cached-input share adds no cost warning.
  assert.equal(priced.warnings, undefined);

  // An inexact request count omits average input.
  const counted = sessionCostStats([{ ...part, requestCountExact: false }])[0];
  assert.equal(counted.label, priced.label);
  const linked = {
    ...part,
    role: 'delegated' as const,
    linkedInvocationId: 'printed',
    requestCountExact: false as const,
  };
  assert.equal(sessionCostProjection([linked]).total.partial, false);
  assert.doesNotMatch(
    counted.detail,
    /avg input/,
    `an estimated request count still reports an exact scale: ${counted.detail}`,
  );

  // An incomplete usage scope omits average input.
  const open = sessionCostStats([{ ...part, incomplete: true }])[0];
  assert.doesNotMatch(open.detail, /avg input/);

  // An unpriced part retains recorded request scale alongside priced cached-read detail.
  const unpriced = sessionCostStats([
    part,
    {
      ...part,
      model: 'a-model-with-no-published-price',
      usage: { ...usage, requests: 4, cacheRead: 1_000_000 },
    },
  ])[0];
  assert.match(unpriced.detail, /Cached input reads:/, `the priced part lost its cached-read line: ${unpriced.detail}`);
  assert.match(unpriced.detail, /204 requests · 500k avg input/);
});

// Running turns and children retain request scale for their recorded usage.
test('a running turn and child keep recorded request scale', () => {
  const usage = {
    requests: 8,
    input: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 4_000_000,
    output: 0,
    thinking: 0,
  };
  const usagePart = {
    model: 'claude-opus-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const priced = (over: Partial<Turn>) =>
    costDetail(turn({ model: 'claude-opus-5', usage, usageParts: [usagePart], ...over })).join('\n');

  assert.match(priced({}), /8 requests · 500k avg input/);
  assert.match(priced({ finished: false }), /8 requests · 500k avg input/);

  // Child run state leaves its recorded request scale available.
  const withChild = (status: string) =>
    costDetail(
      turn({
        model: 'claude-opus-5',
        usage,
        usageParts: [usagePart],
        agents: [
          agent({
            status,
            spendFound: true,
            spend: [{ model: 'claude-opus-5', provider: null, usage, usageParts: [usagePart] }],
          }),
        ],
      }),
    ).join('\n');
  assert.equal((withChild('completed').match(/8 requests · 500k avg input/g) ?? []).length, 2);
  assert.equal((withChild('running').match(/8 requests · 500k avg input/g) ?? []).length, 2);
});

// A cost record permits at most two full-usage pricing calls per main or child part. Reference-based counts require at least one call. Per-category pricing uses separate usage objects and is excluded.

const PRICINGS_PER_COST_RECORD = { mainOnly: 2, childPart: 2 };

test('building one cost record prices a usage no more times than the bound allows', () => {
  const usage = {
    requests: 6,
    input: 40_000,
    cacheWrite1h: 0,
    cacheWrite5m: 9_000,
    cacheWrite30m: 0,
    cacheRead: 300_000,
    output: 8_000,
    thinking: 2_000,
  };
  const childUsage = {
    requests: 12,
    input: 40_000,
    cacheWrite1h: 0,
    cacheWrite5m: 9_000,
    cacheWrite30m: 0,
    cacheRead: 300_000,
    output: 8_000,
    thinking: 2_000,
  };
  const spy = vi.spyOn(pricing, 'estimateCost');
  const pricingsOf = (counted: object): number =>
    spy.mock.calls.filter(([calledUsage]) => calledUsage === counted).length;

  spy.mockClear();
  costDetail(turn({ model: 'claude-opus-5', usage }));
  const mainOnly = pricingsOf(usage);

  spy.mockClear();
  costDetail(
    turn({
      model: 'claude-opus-5',
      usage,
      agents: [agent({ spendFound: true, spend: [{ model: 'claude-opus-5', usage: childUsage }] })],
    }),
  );
  const childPart = pricingsOf(childUsage);
  spy.mockRestore();

  assert.ok(
    mainOnly >= 1 &&
      mainOnly <= PRICINGS_PER_COST_RECORD.mainOnly &&
      childPart >= 1 &&
      childPart <= PRICINGS_PER_COST_RECORD.childPart,
    `one cost record priced a usage outside the bound: a turn with no subagent priced ` +
      `its own usage ${mainOnly} times against a bound of 1 to ${PRICINGS_PER_COST_RECORD.mainOnly}, and a ` +
      `subagent's spend part priced its own usage ${childPart} times against a bound of 1 to ` +
      `${PRICINGS_PER_COST_RECORD.childPart}`,
  );
});

// Recorded Claude CLI totals retain request scale in child cost detail.
test('a recorded Claude CLI total keeps request scale on the turn card and in session detail', () => {
  const usage = {
    requests: 4,
    input: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 1_000_000,
    output: 0,
    thinking: 0,
  };
  const card = costDetail(
    turn({
      agents: [
        agent({
          description: 'Audit the parser',
          model: 'claude-opus-5',
          spendFound: true,
          spend: [{ model: 'claude-opus-5', provider: null, usage, recordedCost: 2, costBasis: 'list' }],
        }),
      ],
    }),
  ).join('\n');
  assert.match(card, /Total recorded by Claude CLI at list price/);
  assert.match(card, /4 requests · 250k avg input/);
});

test('an ambiguous legacy aggregate leaves both its total and tier costs unavailable', () => {
  const lines = costDetail(
    turn({
      agent: 'codex',
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      usage: {
        requests: 2,
        input: 200_000,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead: 200_000,
        output: 1_000,
        thinking: 0,
      },
    }),
  );
  assert.match(lines.join('\n'), /Estimated total: cost unavailable/);
  assert.doesNotMatch(lines.join('\n'), /Uncached input:|Cached input reads:|Output:/);
});

test('a turn labels model requests separately from tool calls in its usage details', () => {
  const usage = {
    requests: 206,
    input: 528_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 100_000_000,
    output: 0,
    thinking: 0,
  };
  assert.equal(
    averageContextPerRequest(usage),
    488_000,
    'the average omits one input-side tier or divides by something other than model requests',
  );
  const card = toCard(turn({ usage }), false, NOW);
  const token = card.chips.find((chip) => chip.label.includes(' in'))!;
  assert.match(token.detail, /Input: 100\.5M tokens\nModel requests: 206/);
  assert.match(token.detail, /Average input per request: 488k tokens/);
  assert.match(
    card.chips[0].detail,
    /206 requests · 488k avg input/,
    'the cached-read scale does not distinguish model requests from tool calls',
  );
  assert.equal(
    card.chips.some((chip) => chip.label.includes('request') || chip.label.includes('avg ctx')),
    false,
    'request diagnostics still occupy their own chip',
  );
  assert.equal(
    averageContextPerRequest({ ...usage, requests: 0 }),
    null,
    'a turn with no counted request invents an average',
  );
});

test('what a subagent spent is reported beside the cost, never inside it', () => {
  // A combined child token total has no input/output breakdown or model-specific price.

  const t = turn({
    usage: { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 100_000, output: 5000, thinking: 0 },
    agents: [agent({ tokens: 176_721 }), agent({ tokens: null })],
  });
  assert.equal(agentTokensOf(t), 176_721, 'an agent still running contributes nothing yet');
  const card = toCard(t, false, NOW);
  assert.doesNotMatch(
    tokenLines(t).join('\n'),
    /subagent/,
    'subagent usage is repeated in the main agent token detail',
  );
  assert.match(costDetail(t).join('\n'), /Audit the parser: cost unavailable\n  177k tokens recorded/);
  assert.equal(costChip(card), '$0.17+', 'a partial dollar figure claims to cover the whole turn');
});

// A cost popover's flat entries, without the tabbed form the popover draws from them.
const flatForm = (list: StatDetailList | undefined): Omit<StatDetailList, 'cost'> | undefined => {
  if (!list) return list;
  const { cost: _cost, ...flat } = list;
  return flat;
};

test('the cost chip includes child transcripts and its hover breaks the total down by agent', () => {
  const t = turn({
    usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    agents: [
      agent({
        tokens: 70_000,
        spendFound: true,
        spend: [
          {
            model: 'claude-haiku-4-5',
            usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
          },
        ],
      }),
    ],
  });
  const card = toCard(t, false, NOW);
  assert.equal(costChip(card), '$6.00');
  const expectedDetail = [
    'Estimated total: $6.00',
    '',
    'Main agent · opus-5: $5.00',
    '  Cached input reads: $0 (0% cached)',
    '  Uncached input: $5.00',
    'Audit the parser · haiku-4-5: $1.00',
    '  Cached input reads: $0 (0% cached)',
    '  Uncached input: $1.00',
    'Estimated from published model rates. Your actual charge may differ.',
  ];
  assert.deepEqual(costDetail(t), expectedDetail);
  const cost = card.chips.find((chip) => chip.label.startsWith('$'));
  assert.deepEqual(flatForm(cost?.detailList), {
    heading: { label: 'Estimated total', value: '$6.00' },
    entries: [
      {
        label: 'Main agent · opus-5',
        value: '$5.00',
        lines: costLines('Cached input reads: $0 (0% cached)', 'Uncached input: $5.00'),
      },
      {
        label: 'Audit the parser · haiku-4-5',
        value: '$1.00',
        lines: costLines('Cached input reads: $0 (0% cached)', 'Uncached input: $1.00'),
      },
    ],
    notes: ['Estimated from published model rates. Your actual charge may differ.'],
  });
  assert.equal(cost?.headDetail, true);
  assert.match(cost!.name!, /Audit the parser .* haiku-4-5: \$1\.00/);
  assert.match(
    card.label,
    /Audit the parser .* haiku-4-5: \$1\.00/,
    'the existing roving card control does not announce the child breakdown',
  );
  assert.equal(agentTokensOf(t), 1_000_000, 'the child row kept the final-context count instead of its billed usage');
  assert.deepEqual(tokenLines(t), [
    'Main agent only',
    'Input: 1M tokens',
    '',
    'Input breakdown',
    '  Uncached input: 1M tokens',
  ]);
  const agents = card.chips.find((chip) => chip.label === '1 subagent');
  assert.deepEqual(flatForm(agents?.detailList), {
    layout: 'agents',
    actions: true,
    heading: { label: '1 subagent in this turn' },
    entries: [{ label: 'Audit the parser', lines: ['haiku-4-5 · 1M in'] }],
  });
});

test('turn and compaction chips keep semantic identities while optional roles change', () => {
  const card = toCard(
    turn({
      contextTokens: 200_000,
      files: [changed('src/cost.ts', 3, 1)],
      usage: { input: 10_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 100, thinking: 0 },
      agents: [agent()],
      commits: [
        {
          sha: 'abc1234',
          subject: 'Record cost detail',
          files: 1,
          added: 1,
          removed: 0,
          at: NOW,
          place: null,
          dir: null,
        },
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    card.chips.map((chip) => chip.metric),
    ['cost', 'context', 'files', 'tokens', 'commits', 'agents'],
  );
  assert.deepEqual(
    toCompactionCard(compaction(), NOW).chips.map((chip) => chip.metric),
    ['cost', 'dropped-context'],
  );
});

test('a compaction cost figure keeps its usage visible and folds its pricing basis into the notes', () => {
  const cost = toCompactionCard(compaction(), NOW).chips.find((chip) => chip.metric === 'cost')!;
  assert.match(cost.detailList?.entries[0]?.label ?? '', /of context sent, .* summary written\.$/);
  // The reader sees that a Claude compaction cost is modelled without opening the notes.
  assert.deepEqual(cost.detailList?.footer, [
    'Claude Code records no usage for a compaction, so this cost is an estimate.',
  ]);
  assert.equal(cost.detailList?.notes?.at(-1), 'Estimated from published model rates. Your actual charge may differ.');
  assert.match(cost.detailList?.notes?.[0] ?? '', /^Estimated as /, 'the estimate basis joins the notes');
  assert.equal(
    cost.detail,
    [cost.detailList!.entries[0].label, ...cost.detailList!.footer!, ...cost.detailList!.notes!].join('\n'),
  );
});

// The long-turn fixture supplies file, subagent, and commit detail layouts.

test('the record chips name the record their popovers draw', () => {
  const card = toCard(FIXTURE_TURNS[LONG_TURN_INDEX], false, FIXTURE_CLOCK);
  const listFor = (metric: string) => card.chips.find((chip) => chip.metric === metric)?.detailList;

  const files = listFor('files');
  assert.deepEqual([files?.layout, files?.actions], ['files', true]);
  assert.deepEqual(files?.heading, { label: '8 files', diff: { added: 594, removed: 118 } });
  // Seven files the turn recorded itself, and one its fold child changed and it did not.
  assert.deepEqual(
    card.files.map((file) => file.name),
    [
      'card.ts',
      'panel.css',
      'turncard.ts',
      'section-fold-memory.ts',
      'section-fold.test.ts',
      'architecture.md',
      'README.md',
      'panel.layout.cards.test.ts',
    ],
  );
  assert.equal(
    card.files[7].detail,
    [
      'c:/repo/extension/src/panel.layout.cards.test.ts',
      'changed by Fold the Files rows behind a head line and prove the height guard goes red',
    ].join('\n'),
  );

  // The finished fixture has no live child evidence, so its agents heading reports no running count.

  const agents = listFor('agents');
  assert.deepEqual([agents?.layout, agents?.actions], ['agents', true]);
  // The turn has ended, so its open child recorded no ending and the heading counts nothing.
  assert.deepEqual(agents?.heading, { label: '3 subagents in this turn' });
  assert.deepEqual(
    card.agents.map((held) => [held.state, held.stateWord, held.sessionId]),
    [
      ['open', 'no ending recorded', null],
      ['done', '', 's2'],
      ['done', '', null],
    ],
  );

  const commits = listFor('commits');
  assert.deepEqual([commits?.layout, commits?.actions], ['commits', true]);
  assert.deepEqual(commits?.heading, { label: '3 commits', diff: { added: 271, removed: 59 } });
  // The turn itself records all three commits, including commits also reported by its child.

  assert.deepEqual(
    FIXTURE_TURNS[LONG_TURN_INDEX].commits.map((held) => held.sha),
    ['4f2a91c', '9d7be30', 'b83e0d1'],
    'a commit left the long turn and rode in on its child',
  );
  assert.deepEqual(commits?.entries, [
    { label: '4f2a91c', value: 'feat(card): fold the Files, Subagents and Commits sections' },
    { label: '9d7be30', value: 'test(card): measure the open card at the three panel widths' },
    { label: 'b83e0d1', value: 'fix(rail): keep the pinned row in view when the rail narrows' },
  ]);
  // Commit tooltip text matches the popover's heading and entries.
  const commitsChip = card.chips.find((chip) => chip.metric === 'commits');
  assert.deepEqual(
    commitsChip?.detail.split('\n'),
    [
      `${commits!.heading!.label}: +${commits!.heading!.diff!.added} −${commits!.heading!.diff!.removed}`,
      '',
      ...commits!.entries.map((entry) => `${entry.label}: ${entry.value as string}`),
    ],
    'the Commits chip hover and the list its popover draws say different things',
  );

  // File and commit detail layouts select the card's arrays without copying their rows into figure payloads.

  assert.deepEqual(
    card.chips.filter((chip) => chip.detailList && 'rows' in chip.detailList).map((chip) => chip.metric),
    [],
    'a record chip carries a second copy of the turn record',
  );
  const printedChips = (JSON.parse(cardPrint(card)) as unknown[])[CARD_CONTENT_FIELDS.indexOf('chips')] as unknown[];
  assert.equal(printedChips.length, card.chips.length, 'the repaint print dropped a chip');
  assert.deepEqual(
    card.commits.map((held) => [held.sha, held.branch, held.where, held.dir]),
    [
      ['4f2a91c', 'main', null, 'c:/repo'],
      // The worktree is named for the branch it holds, so the row says the branch and no place.
      ['9d7be30', 'turn-card-density', null, 'c:/repo-trees/turn-card-density'],
      ['b83e0d1', 'fix/rail-pin', 'in worktree rail-review', 'c:/repo-trees/rail-review'],
    ],
  );
  // Child-made commits retain maker attribution. Parent-only commits carry no maker line.

  const fold = 'Fold the Files rows behind a head line and prove the height guard goes red';
  assert.deepEqual(
    card.commits.map((held) => held.madeBy ?? null),
    [null, fold, fold],
  );
  // The maker's name opens the child's own session, so each row carries that session.
  assert.deepEqual(
    card.commits.map((held) => held.madeBySession),
    [null, 's2', 's2'],
  );
  assert.doesNotMatch(card.commits[1].detail, /made by/, 'the maker line leaves the hover to the name button');
  assert.equal(card.chips.find((chip) => chip.metric === 'commits')?.name, '3 commits, 2 made by a subagent');
});

test('a completed current Codex child spend appears once in the card and parent cost', () => {
  const t = turn({
    usage: { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    agents: [
      agent({
        id: 'child-thread',
        description: 'Laplace',
        model: 'gpt-5.6-sol',
        status: 'completed',
        spendFound: true,
        spend: [
          {
            model: 'claude-haiku-4-5',
            usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
          },
        ],
      }),
    ],
  });
  const card = toCard(t, false, NOW);
  assert.deepEqual(card.agents, [
    {
      description: 'Laplace',
      model: 'gpt-5.6-sol',
      effort: null,
      state: 'done',
      stateWord: '',
      since: null,
      figures: [
        {
          metric: 'cost',
          compactLabel: '$1.00',
          name: '$1.00 spent',
          record: {
            heading: { label: '$1.00 spent' },
            entries: [
              {
                label: 'Cost by usage · haiku-4-5',
                value: '$1.00',
                lines: [
                  { text: 'Cached input reads: $0', cost: true, cacheHit: { percent: 0, warning: false } },
                  { text: 'Uncached input: $1.00', cost: true },
                ],
              },
              { label: 'Input', separateBefore: true, value: '1M tokens' },
              { label: 'Input breakdown', separateBefore: true, lines: ['Uncached input: 1M tokens'] },
            ],
          },
          detail: [
            '$1.00 spent',
            '',
            'Cost by usage · haiku-4-5: $1.00',
            '  Cached input reads: $0 (0% cached)',
            '  Uncached input: $1.00',
            '',
            'Input: 1M tokens',
            '',
            'Input breakdown',
            '  Uncached input: 1M tokens',
          ].join('\n'),
        },
      ],
      hintDetail: '',
      sessionId: null,
    },
  ]);
  assert.equal(costChip(card), '$1.00');
  assert.deepEqual(turnCost(t), { dollars: 1, partial: false });
  assert.deepEqual(card.chips.find((chip) => chip.label === '1 subagent')?.detailList, {
    layout: 'agents',
    actions: true,
    heading: { label: '1 subagent in this turn' },
    entries: [{ label: 'Laplace', lines: ['gpt-5.6-sol \u00b7 1M in'] }],
  });
});

test('a Claude CLI child uses its recorded list cost without inventing a cache lifetime', () => {
  const t = turn({
    agents: [
      agent({
        description: 'Claude CLI',
        spendFound: true,
        spend: [
          {
            model: 'claude-opus-5',
            recordedCost: 3.24,
            costBasis: 'list',
            unclassifiedCacheWrite: 100,
            usage: { input: 20, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 300, output: 40, thinking: 12 },
          },
        ],
      }),
    ],
  });
  assert.equal(costChip(toCard(t, false, NOW)), '$3.24');
  assert.match(costDetail(t).join('\n'), /Claude CLI .* opus-5: \$3\.24/);
  assert.match(costDetail(t).join('\n'), /Cache writes without a recorded lifetime: 100 tokens/);
  assert.match(costDetail(t).join('\n'), /Total recorded by Claude CLI at list price/);
  assert.equal(agentTokensOf(t), 460);
});

test('a child mixed across direct OpenAI request bands keeps both prices', () => {
  const short = {
    requests: 2,
    input: 300_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
  };
  const long = {
    requests: 1,
    input: 300_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
  };
  const t = turn({
    agents: [
      agent({
        spendFound: true,
        spend: [
          {
            model: 'gpt-5.5',
            provider: 'openai',
            contextWindow: 1_050_000,
            usage: {
              requests: 3,
              input: 600_000,
              cacheWrite1h: 0,
              cacheWrite5m: 0,
              cacheWrite30m: 0,
              cacheRead: 0,
              output: 0,
              thinking: 0,
              byContextBand: { short, long },
            },
          },
        ],
      }),
    ],
  });
  assert.equal(costChip(toCard(t, false, NOW)), '$4.50');
  assert.match(costDetail(t).join('\n'), /Audit the parser .* gpt-5\.5: \$4\.50/);
});

test('a child that launched nested work leaves the cost total explicitly partial', () => {
  const t = turn({
    agents: [
      agent({
        spendFound: true,
        spend: [
          {
            model: 'claude-haiku-4-5',
            usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
          },
        ],
        spendPartial: true,
      }),
    ],
  });
  const card = toCard(t, false, NOW);
  assert.equal(costChip(card)?.endsWith('+'), true);
  assert.match(costDetail(t).join('\n'), /Some nested subagents are still running or left no record/);
});

test('a partial Claude CLI child says the run reported no full cost, not that nested work is missing', () => {
  const t = turn({
    agents: [
      agent({
        description: 'Claude CLI',
        agentType: 'claude-cli',
        spendFound: true,
        spendPartial: true,
        spend: [
          {
            model: 'claude-haiku-4-5',
            usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
          },
        ],
      }),
    ],
  });
  const detail = costDetail(t).join('\n');
  assert.match(detail, /Claude CLI did not report the full cost of this run/);
  assert.doesNotMatch(detail, /nested subagents/);
});

test('a partial Codex child says its own subagents are left out, on the row and in the turn cost', () => {
  const t = turn({
    agent: 'codex',
    provider: 'openai',
    agents: [
      agent({
        description: 'Audit the parser',
        agentType: '/root/audit',
        spendFound: true,
        spendPartial: true,
        spend: [
          {
            model: 'gpt-5.5',
            provider: 'openai',
            contextWindow: 1_050_000,
            usage: {
              requests: 1,
              input: 100_000,
              cacheWrite1h: 0,
              cacheWrite5m: 0,
              cacheRead: 0,
              output: 0,
              thinking: 0,
            },
          },
        ],
      }),
    ],
  });
  const detail = costDetail(t).join('\n');
  assert.match(detail, /This cost leaves out the subagents that this subagent started/);
  assert.doesNotMatch(detail, /still running or left no record/);
  const row = toCard(t, false, NOW).agents[0].figures.find((figure) => figure.metric === 'cost');
  const text = JSON.stringify(row?.record?.entries ?? []);
  assert.match(text, /This cost leaves out the subagents that this subagent started/);
  assert.doesNotMatch(text, /left no record/);
});

// The main transcript launches a flat-folder child chain through depth. Metadata identifies each child's launcher. Each transcript bills one million Haiku input tokens.

function nestedAgentTurn(depth: number, omit: { meta?: string; transcript?: string } = {}): Turn {
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const folder = tempDir('nested-agents-');
  const subagents = path.join(folder, 'sess', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const write = (file: string, records: object[]) =>
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const turnOf = (level: number): object[] => {
    const sidechain = level > 0;
    const next = level + 1;
    const say = (id: string, second: number, content: object[], input: number) => ({
      type: 'assistant',
      timestamp: at(second),
      isSidechain: sidechain,
      message: {
        role: 'assistant',
        id,
        model: 'claude-haiku-4-5',
        stop_reason: next <= depth && input ? 'tool_use' : 'end_turn',
        content,
        usage: { input_tokens: input, output_tokens: 0 },
      },
    });
    const prompt = {
      type: 'user',
      promptId: `p${level}`,
      timestamp: at(level),
      isSidechain: sidechain,
      message: { role: 'user', content: [{ type: 'text', text: `Work at level ${level}.` }] },
    };
    if (next > depth) {
      return [prompt, say(`m${level}`, level + 1, [{ type: 'text', text: 'Done.' }], 1_000_000)];
    }
    return [
      prompt,
      say(
        `m${level}`,
        level + 1,
        [{ type: 'tool_use', id: `launch-${next}`, name: 'Agent', input: { description: `Level ${next}` } }],
        1_000_000,
      ),
      {
        type: 'user',
        timestamp: at(level + 20),
        isSidechain: sidechain,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `launch-${next}`, content: 'done' }] },
        toolUseResult: { agentId: `a${next}`, status: 'completed', totalToolUseCount: 1 },
      },
      say(`m${level}-end`, level + 21, [{ type: 'text', text: 'Done.' }], 0),
    ];
  };
  write(path.join(folder, 'sess.jsonl'), turnOf(0));
  for (let level = 1; level <= depth; level++) {
    const id = `a${level}`;
    if (omit.transcript !== id) {
      write(path.join(subagents, `agent-${id}.jsonl`), turnOf(level));
    }
    if (omit.meta !== id) {
      fs.writeFileSync(
        path.join(subagents, `agent-${id}.meta.json`),
        JSON.stringify({
          agentType: 'general-purpose',
          description: `Level ${level}`,
          toolUseId: `launch-${level}`,
          ...(level > 1 ? { parentAgentId: `a${level - 1}` } : {}),
          spawnDepth: level,
        }),
      );
    }
  }
  const [read] = readSession(path.join(folder, 'sess.jsonl'), 'sess', {
    agentSpendOf: (launched) => readClaudeAgentSpend(path.join(subagents, `agent-${launched.id}.jsonl`)),
  }).turns;
  return read;
}

test('a subagent that launched its own subagent carries their spend in the turn cost', () => {
  const t = nestedAgentTurn(2);
  assert.equal(costChip(toCard(t, false, NOW)), '$3.00', 'the turn left out the nested agent the session total counts');
  assert.doesNotMatch(costDetail(t).join('\n'), /nested subagents/);
});

test('a three-level subagent chain folds every level into the first row', () => {
  const t = nestedAgentTurn(3);
  assert.equal(costChip(toCard(t, false, NOW)), '$4.00');
  assert.match(costDetail(t).join('\n'), /^agent · haiku-4-5: \$3\.00$/m, 'the first row carries both levels below it');
});

test('a nested launch with no meta file or no transcript keeps the turn cost a floor', () => {
  for (const omit of [{ meta: 'a2' }, { transcript: 'a2' }, { meta: 'a3' }]) {
    const t = nestedAgentTurn(omit.meta === 'a3' ? 3 : 2, omit);
    const priced = omit.meta === 'a3' ? '$3.00+' : '$2.00+';
    assert.equal(costChip(toCard(t, false, NOW)), priced, JSON.stringify(omit));
    assert.match(costDetail(t).join('\n'), /Some nested subagents are still running or left no record/);
  }
});

// Turn 1 launches a Haiku subagent, whose first request writes 1.6 million tokens to the
// five-minute cache. Turn 2 is a short main-agent turn. Turn 3 starts ten minutes after the launch
// and resumes the subagent. Its cache has expired, so its next request writes two million tokens
// to the cache. One more subagent request runs after turn 3 ends and before turn 4 starts. The
// main agent bills nothing.
function resumedAgentSession(
  resume: 'SendMessage' | 'Agent' = 'SendMessage',
  launchRequest = true,
  laterTurn = true,
  // A compaction at second `at` replaces the child's two requests in the resuming turn. The
  // first request bills `launchUsage`, so a zero request leaves the compaction estimate as the
  // child's only use of the model.
  compacted?: { launchUsage: 'billed' | 'zero'; at: number },
) {
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const folder = tempDir('resumed-agent-');
  const subagents = path.join(folder, 'sess', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const write = (file: string, records: object[]) =>
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const say = (id: string, second: number, stop: string, content: object[], usage: object, sidechain = false) => ({
    type: 'assistant',
    timestamp: at(second),
    isSidechain: sidechain,
    message: { role: 'assistant', id, model: 'claude-haiku-4-5', stop_reason: stop, content, usage },
  });
  const ask = (promptId: string, second: number, text: string, sidechain = false) => ({
    type: 'user',
    promptId,
    timestamp: at(second),
    isSidechain: sidechain,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const result = (id: string, second: number, extra: object = {}) => ({
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
    ...extra,
  });
  const reply = (id: string, second: number, text: string) =>
    say(id, second, 'end_turn', [{ type: 'text', text }], none);
  const none = { input_tokens: 0, output_tokens: 0 };
  const cacheWrite = (tokens: number) => ({
    input_tokens: 0,
    cache_creation_input_tokens: tokens,
    cache_creation: { ephemeral_5m_input_tokens: tokens, ephemeral_1h_input_tokens: 0 },
    output_tokens: 0,
  });
  const resumeCall =
    resume === 'SendMessage'
      ? { type: 'tool_use', id: 'resume-1', name: 'SendMessage', input: { to: 'a1', message: 'Apply the review.' } }
      : { type: 'tool_use', id: 'resume-1', name: 'Agent', input: { description: 'Planner' } };
  write(path.join(folder, 'sess.jsonl'), [
    ask('p1', 0, 'Draft the plan.'),
    say(
      'm1',
      1,
      'tool_use',
      [{ type: 'tool_use', id: 'launch-1', name: 'Agent', input: { description: 'Planner' } }],
      none,
    ),
    result('launch-1', 20, {
      toolUseResult: { agentId: 'a1', status: 'completed', totalToolUseCount: 1, totalTokens: 3_200_000 },
    }),
    reply('m1-end', 21, 'Drafted.'),
    ask('p2', 60, 'Name the file.'),
    reply('m2-end', 61, 'Named.'),
    ask('p3', 600, 'Apply the review.'),
    say('m3', 601, 'tool_use', [resumeCall], none),
    result('resume-1', 700, resume === 'Agent' ? { toolUseResult: { agentId: 'a1', status: 'completed' } } : {}),
    reply('m3-end', 701, 'Applied.'),
    ...(laterTurn ? [ask('p4', 900, 'Thanks.'), reply('m4-end', 901, 'Done.')] : []),
  ]);
  const child = path.join(subagents, 'agent-a1.jsonl');
  write(child, [
    ...(launchRequest
      ? [
          ask('c1', 2, 'Draft the plan.', true),
          say('c1-reply', 10, 'end_turn', [], compacted?.launchUsage === 'zero' ? none : cacheWrite(1_600_000), true),
        ]
      : []),
    ask('c2', 602, 'Apply the review.', true),
    ...(compacted
      ? [
          {
            type: 'system',
            subtype: 'compact_boundary',
            timestamp: at(compacted.at),
            isSidechain: true,
            compactMetadata: { trigger: 'auto', preTokens: 150_000, postTokens: 8_000, durationMs: 30_000 },
          },
          {
            type: 'user',
            timestamp: at(compacted.at + 1),
            isCompactSummary: true,
            isSidechain: true,
            message: {
              role: 'user',
              content: 'This session is being continued from a previous conversation.'.padEnd(2_000, '.'),
            },
          },
        ]
      : [
          say('c2-reply', 610, 'tool_use', [], cacheWrite(2_000_000), true),
          say('c3-reply', 750, 'end_turn', [], { input_tokens: 400_000, output_tokens: 0 }, true),
        ]),
  ]);
  fs.writeFileSync(
    path.join(subagents, 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Planner', toolUseId: 'launch-1' }),
  );
  const lookup = (launched: { id: string | null }) =>
    readClaudeAgentSpend(path.join(subagents, `agent-${launched.id}.jsonl`));
  const turns = readSession(path.join(folder, 'sess.jsonl'), 'sess', { agentSpendOf: lookup }).turns;
  // The cache-expiry facts come from the subagent's own requests, the way the spend ledger scans them.
  const scan = new CacheExpiryScan(undefined, () => true);
  for (const request of readClaudeAgentSpend(child).requests ?? []) scan.push(request);
  const childFacts = scan.ledger([]).facts;
  const facts = {
    sess: {
      ...emptyCacheExpiryFacts(),
      childSources: [
        {
          source: child,
          childId: 'a1',
          revision: {} as NativeChildCacheFacts['revision'],
          facts: childFacts,
          endedAt: null,
          outcome: null,
        },
      ],
    },
  };
  const warned = (all: Turn[]) => {
    const costs = new ChildCacheExpiryAttribution().read(all, facts, NOW);
    return all.map((turn) =>
      Boolean(
        toCard(
          turn,
          false,
          NOW,
          [],
          null,
          false,
          new Set(),
          [],
          turnCacheExpiryWarning(turn, facts.sess, costs.get(turnKey(turn))),
        )
          .chips.find((chip) => chip.metric === 'cost')
          ?.warnings?.some((item) => item.scope === 'cache-expiry'),
      ),
    );
  };
  return { turns, lookup, childFacts, warned };
}

const subagentLines = (turn: Turn) => costDetail(turn).filter((line) => line.startsWith('agent · '));

const heroOf = (turn: Turn, dispatched: DispatchedTurnCost[] = []) =>
  toCard(turn, false, NOW, [], null, false, new Set(), dispatched).chips.find((chip) => chip.metric === 'cost')!
    .detailList!.cost!;

test('the turn hero counts a child once when one turn holds its launch row and its resume row', () => {
  const spend = [
    {
      model: 'claude-haiku-4-5',
      usage: tokenUsage({ requests: 1, input: 100_000, output: 1000 }),
    },
  ];
  const main = { model: 'claude-sonnet-5', usage: tokenUsage({ requests: 2, input: 50_000, output: 2000 }) };
  // The reader gives a resume row in the launching turn an empty share, since the launch row holds the requests.
  const resumed = turn({
    ...main,
    agents: [
      agent({ id: 'a1', description: 'Planner', spendFound: true, spend }),
      agent({ id: 'a1', description: 'Planner', spendFound: true, spend: [] }),
    ],
  });
  assert.match(heroOf(resumed).delegated!.title, /, 1 child session$/);
  assert.equal(heroOf(resumed).delegated!.model, '1 × 5', 'the count agrees with the model counts');
  const two = turn({
    ...main,
    agents: [
      agent({ id: 'a1', description: 'Planner', spendFound: true, spend }),
      agent({ id: 'a2', description: 'Reviewer', spendFound: true, spend }),
    ],
  });
  assert.match(heroOf(two).delegated!.title, /, 2 child sessions$/);
});

test('the turn hero counts a dispatched session once when a row or another share names the same session', () => {
  const spend = [{ model: 'claude-haiku-4-5', usage: tokenUsage({ requests: 1, input: 100_000, output: 1000 }) }];
  const main = { model: 'claude-sonnet-5', usage: tokenUsage({ requests: 2, input: 50_000, output: 2000 }) };
  const named = turn({ ...main, agents: [agent({ id: 'child', description: 'Planner', spendFound: true, spend })] });
  const hero = heroOf(named, [dispatchedCost()]);
  assert.match(hero.delegated!.title, /, 1 child session$/, 'a row and a share of one session read as two');
  assert.equal(hero.delegated!.model, '1 × 5');
  assert.match(heroOf(turn(main), [dispatchedCost(), dispatchedCost()]).delegated!.title, /, 1 child session$/);
  assert.match(
    heroOf(named, [dispatchedCost({ sessionId: 'other' })]).delegated!.title,
    /, 2 child sessions$/,
    'a share of another session stays a second child',
  );
});

test('the session hero counts a child session once when two invocations resume it', () => {
  // A Codex turn that runs `claude -p` and then `claude -p --resume` gives each command its own scope.
  const bucket = (session: string, command: string) =>
    economicRequest({ linkedSessionId: session, linkedInvocationId: `${command}:${session}` });
  const part = (session: string, command: string) =>
    sessionCostUsageOf({
      bucket: bucket(session, command),
      role: 'delegated',
      scopeId: `invocation:${command}:${session}`,
    });
  const main = sessionCostUsageOf({ bucket: economicRequest(), role: 'main' });
  const delegated = (parts: ReturnType<typeof part>[]) =>
    sessionCostProjection([main, ...parts]).stats[0].detailList!.cost!.delegated!;
  const resumed = delegated([part('S', 'c1'), part('S', 'c2'), part('T', 'c3')]);
  assert.match(resumed.title, /, 2 child sessions, /);
  assert.equal(resumed.model, '2 × sol', 'the count agrees with the model counts');
  const distinct = delegated([part('S', 'c1'), part('U', 'c2'), part('T', 'c3')]);
  assert.match(distinct.title, /, 3 child sessions, /);
  assert.equal(resumed.value, distinct.value, 'merging scopes changes no dollars');
});

test('a subagent resumed in a later turn shows in both turn cards, each priced by its own requests', () => {
  const { turns, lookup, childFacts, warned } = resumedAgentSession();
  assert.equal(childFacts.counts['5m'], 1, 'the fixture records one expired five-minute cache');
  const check = () => {
    const [first, second, third, fourth] = turns;
    assert.deepEqual(warned(turns), [false, false, true, false], 'the warning sits on the turn that rebuilt the cache');
    assert.equal(costChip(toCard(first, false, NOW)), '$2.00', 'the launching turn kept the resumed requests');
    assert.deepEqual(subagentLines(first), ['agent · haiku-4-5: $2.00']);
    assert.deepEqual(
      [second.agents.length, fourth.agents.length],
      [0, 0],
      'a turn without subagent requests lists none',
    );
    assert.equal(third.agents.length, 1, 'the resuming turn lists the subagent once');
    assert.equal(costChip(toCard(third, false, NOW)), '$2.90', 'the resuming turn total left out the subagent');
    assert.deepEqual(
      subagentLines(third),
      ['agent · haiku-4-5: $2.90'],
      'the resuming turn cost list left out a request',
    );
  };
  check();
  refreshClaudeAgentFacts(turns, lookup, undefined);
  check();
});

test('a child that compacts on a model it billed nothing on still prices the estimate in its turn', () => {
  // The whole child stays in the launching turn, so no split prices it.
  const { turns } = resumedAgentSession('SendMessage', true, true, { launchUsage: 'zero', at: 15 });
  const [first, , third] = turns;
  assert.equal(costChip(toCard(first, false, NOW)), '$0.02', 'the estimate left the card total');
  assert.deepEqual(subagentLines(first).slice(0, 1), ['agent · haiku-4-5: $0.02']);
  assert.equal(third.agents.length, 0, 'the child made no request in the resuming turn');
});

test('a resuming turn whose only subagent request is a compaction estimate keeps its dollars', () => {
  // The first request billed the model in turn 1. Turn 3 holds only the estimated compaction.
  const { turns, lookup } = resumedAgentSession('SendMessage', true, true, { launchUsage: 'billed', at: 620 });
  const check = () => {
    const [first, , third] = turns;
    assert.equal(costChip(toCard(first, false, NOW)), '$2.00');
    assert.equal(third.agents.length, 1, 'the resuming turn lists the subagent once');
    assert.equal(costChip(toCard(third, false, NOW)), '$2.01', 'the share lost the estimate');
    assert.deepEqual(subagentLines(third).slice(0, 1), ['agent · haiku-4-5: $2.01']);
  };
  check();
  refreshClaudeAgentFacts(turns, lookup, undefined);
  check();
});

test('retained history pages refreshed apart never price a subagent onto a turn without its requests', () => {
  const { turns, lookup } = resumedAgentSession();
  const [first, second, third, fourth] = turns;
  refreshClaudeAgentFacts([first, second], lookup, undefined, false);
  refreshClaudeAgentFacts([third, fourth], lookup, undefined, false);
  assert.equal(second.agents.length, 0, 'the last turn of the older page took requests from a newer page');
  assert.equal(third.agents.length, 0);
  assert.deepEqual(
    subagentLines(first),
    ['agent · haiku-4-5: $4.90'],
    'requests outside the page stay on the launching row',
  );
  refreshClaudeAgentFacts(turns, lookup, undefined, false);
  assert.deepEqual(
    [first, second, third, fourth].map(subagentLines),
    [['agent · haiku-4-5: $2.00'], [], ['agent · haiku-4-5: $2.90'], []],
    'pages refreshed together place each request in its own turn',
  );
});

test('a child write refreshing the newest window keeps a request after the resuming turn ends on that turn', () => {
  // Turn 3 is the newest turn, and the last subagent request runs after it ends.
  const { turns: read, lookup, warned } = resumedAgentSession('SendMessage', true, false);
  const turns = retainedWorkerRead(read, lookup);
  const [first, second, third] = turns;
  assert.deepEqual(warned(turns), [false, false, true], 'the warning sits on the turn that rebuilt the cache');
  assert.deepEqual(subagentLines(second), []);
  assert.deepEqual(subagentLines(first), ['agent · haiku-4-5: $2.00'], 'the launching row took the later request');
  assert.deepEqual(subagentLines(third), ['agent · haiku-4-5: $2.90'], 'the resuming row lost the later request');
  assert.equal(costChip(toCard(third, false, NOW)), '$2.90', 'the resuming turn total left out the later request');
});

test('a subagent launched on a retained page and resumed in the newest window prices each turn by its requests', () => {
  const { turns, lookup, warned } = resumedAgentSession();
  const [first, second, third, fourth] = turns;
  // A history page and the newest window each read apart first.
  refreshClaudeAgentFacts([first, second], lookup, undefined, false);
  refreshClaudeAgentFacts([third, fourth], lookup, undefined);
  assert.equal(third.agents.length, 0, 'the window read alone has no row for a subagent an older page launched');
  // The page also holds a copy of the window's first turn. The cards show the window copy.
  const [page, window] = retainedWorkerPages(
    [
      [first, second, structuredClone(third)],
      [third, fourth],
    ],
    lookup,
  );
  const shown = [...page.slice(0, 2), ...window];
  assert.deepEqual(warned(shown), [false, false, true, false], 'the warning sits on the turn that rebuilt the cache');
  assert.deepEqual(
    shown.map(subagentLines),
    [['agent · haiku-4-5: $2.00'], [], ['agent · haiku-4-5: $2.90'], []],
    'the resuming card lost the requests the warning places on it',
  );
  assert.equal(costChip(toCard(window[0], false, NOW)), '$2.90', 'the resuming turn total left out the subagent');
  assert.equal(costChip(toCard(page[0], false, NOW)), '$2.00', 'the launching turn kept the resumed requests');
});

test('a subagent resumed by a second Agent call counts each of its requests once', () => {
  const [first, , third] = resumedAgentSession('Agent').turns;
  assert.equal(third.agents.length, 1);
  assert.deepEqual([first, third].map(agentTokensOf), [1_600_000, 2_400_000]);
});

test('a launching turn whose subagent made no request in it shows no billed usage for that row', () => {
  const [first, , third] = resumedAgentSession('SendMessage', false).turns;
  assert.equal(agentTokensOf(first), 0, 'the launching row fell back to the subagent result token count');
  assert.ok(costDetail(first).includes('agent: no billed usage'), 'the launching row lost its zero share');
  assert.deepEqual(subagentLines(third), ['agent · haiku-4-5: $2.90']);
});

// A timed response: a request record, then two content blocks of one response. The first block
// records the opening output count, and only the last records the stop reason and final count.
// The tag keeps the ids of a second timed response in the same transcript distinct.
function timedResponse(model: string, sidechain: boolean, at: (second: number) => string, tag = ''): object[] {
  const block = (second: number, output: number, stop: string | null) => ({
    type: 'assistant',
    requestRef: `req-1${tag}`,
    isSidechain: sidechain,
    timestamp: at(second),
    message: {
      role: 'assistant',
      id: `m-timed${tag}`,
      model,
      stop_reason: stop,
      content: [{ type: 'text', text: `Block ${second}.` }],
      usage: { input_tokens: 1000, output_tokens: output },
    },
  });
  return [
    {
      type: 'user',
      promptId: `p-timed${tag}`,
      timestamp: at(2),
      isSidechain: sidechain,
      message: { role: 'user', content: [{ type: 'text', text: 'Time this work.' }] },
    },
    {
      type: 'api-request',
      sessionId: 'sess',
      ...(sidechain ? { agentId: 'a1' } : {}),
      id: `req-1${tag}`,
      timestamp: at(10),
    },
    block(12, 5, null),
    block(14, 400, 'end_turn'),
  ];
}

// The main transcript launches one subagent whose own transcript holds a timed response.
function timedAgentTurn(model: string): { turn: Turn; child: string; at: (second: number) => string } {
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const folder = tempDir('timed-agent-');
  const subagents = path.join(folder, 'sess', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const write = (file: string, records: object[]) =>
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const say = (id: string, second: number, stop: string, content: object[]) => ({
    type: 'assistant',
    timestamp: at(second),
    message: {
      role: 'assistant',
      id,
      model: 'claude-haiku-4-5',
      stop_reason: stop,
      content,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  write(path.join(folder, 'sess.jsonl'), [
    {
      type: 'user',
      promptId: 'p0',
      timestamp: at(0),
      message: { role: 'user', content: [{ type: 'text', text: 'Launch a timed agent.' }] },
    },
    say('m0', 1, 'tool_use', [{ type: 'tool_use', id: 'launch-1', name: 'Agent', input: { description: 'Timed' } }]),
    {
      type: 'user',
      timestamp: at(20),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-1', content: 'done' }] },
      toolUseResult: { agentId: 'a1', status: 'completed', totalToolUseCount: 0 },
    },
    say('m0-end', 21, 'end_turn', [{ type: 'text', text: 'Done.' }]),
  ]);
  write(path.join(subagents, 'agent-a1.jsonl'), timedResponse(model, true, at));
  fs.writeFileSync(
    path.join(subagents, 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Timed', toolUseId: 'launch-1' }),
  );
  const [read] = readSession(path.join(folder, 'sess.jsonl'), 'sess', {
    agentSpendOf: (launched) => readClaudeAgentSpend(path.join(subagents, `agent-${launched.id}.jsonl`)),
  }).turns;
  return { turn: read, child: path.join(subagents, 'agent-a1.jsonl'), at };
}

// 400 tokens over the 4 seconds from the request send time to the last content block.
const childRequestTitle = (model: string) =>
  `100.0 tok/s. Output tokens per second. Actual output includes thinking. Request time includes the wait for the first response event. Untimed responses are excluded. Measured model: ${model}. Only this subagent is timed. Usage totals include any delegated work.`;

const outputSpeedLine = (row: ReturnType<typeof toCard>['agents'][number], metric: string) =>
  row.figures.find((figure) => figure.metric === metric)?.record?.entries.find((entry) => entry.label === 'Output')
    ?.lines?.[0];

test('a Claude subagent row shows the output speed its own request records measure', () => {
  const row = toCard(timedAgentTurn('claude-haiku-4-5').turn, false, NOW).agents[0];
  assert.deepEqual(outputSpeedLine(row, 'cost'), {
    text: '100.0 tok/s',
    title: childRequestTitle('claude-haiku-4-5'),
  });
});

test('a Claude subagent row drops its output speed once the subagent times a second model', () => {
  const { turn, child, at } = timedAgentTurn('claude-haiku-4-5');
  assert.deepEqual(outputSpeedLine(toCard(turn, false, NOW).agents[0], 'cost'), {
    text: '100.0 tok/s',
    title: childRequestTitle('claude-haiku-4-5'),
  });
  fs.appendFileSync(
    child,
    timedResponse('claude-sonnet-4-5', true, (second) => at(second + 30), '-second')
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  refreshClaudeAgentFacts([turn], () => readClaudeAgentSpend(child), undefined);
  const row = toCard(turn, false, NOW).agents[0];
  assert.ok(row.figures.some((figure) => figure.metric === 'cost'));
  assert.doesNotMatch(JSON.stringify(row), /tok\/s/);
});

test('an unpriced Claude subagent row names request time in its tokens figure', () => {
  const row = toCard(timedAgentTurn('claude-unpriced-9').turn, false, NOW).agents[0];
  assert.ok(!row.figures.some((figure) => figure.metric === 'cost'));
  assert.deepEqual(outputSpeedLine(row, 'tokens'), {
    text: '100.0 tok/s',
    title: childRequestTitle('claude-unpriced-9'),
  });
});

// The dispatched row's speed names the dispatched session, never a subagent.
const dispatchedRequestTitle = (model: string) =>
  childRequestTitle(model).replace('Only this subagent is timed.', 'Only this dispatched session is timed.');

test('a dispatched Claude session row shows the output speed its own request records measure', () => {
  for (const [model, metric] of [
    ['claude-haiku-4-5', 'cost'],
    ['claude-unpriced-9', 'tokens'],
  ]) {
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const file = path.join(tempDir('timed-dispatch-'), 'sess.jsonl');
    fs.writeFileSync(
      file,
      timedResponse(model, false, at)
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    assert.equal(readSession(file, 'sess').turns[0].outputRateBasis, 'request', 'the session turn itself is timed');
    const spend = readClaudeAgentSpend(file, [], false);
    const row = dispatchedAgentCard('sess', 'Review the card', spend, 'done', 1000, 65000, 2, [], NOW, 'claude');
    assert.equal(
      row.figures.some((figure) => figure.metric === 'cost'),
      metric === 'cost',
    );
    assert.deepEqual(outputSpeedLine(row, metric), { text: '100.0 tok/s', title: dispatchedRequestTitle(model) });
  }
});

test('a completed child with no billed response is an exact zero', () => {
  const t = turn({
    usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    agents: [agent({ spendFound: true })],
  });
  const card = toCard(t, false, NOW);
  assert.equal(costChip(card), '$5.00');
  assert.match(costDetail(t).join('\n'), /Audit the parser: no billed usage/);
  assert.deepEqual(card.chips.find((chip) => chip.label === '1 subagent')?.detailList, {
    layout: 'agents',
    actions: true,
    heading: { label: '1 subagent in this turn' },
    entries: [{ label: 'Audit the parser', lines: ['haiku-4-5'] }],
  });
  assert.doesNotMatch(
    card.chips.find((chip) => chip.label === '1 subagent')?.detail ?? '',
    /billed usage|cost unavailable/,
  );
});

test('a completed child with an incomplete billed response does not claim no billed usage', () => {
  const t = turn({
    usage: { requests: 1, input: 10_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    agents: [agent({ spendFound: true, spendIncomplete: true })],
  });
  assert.equal(costChip(toCard(t, false, NOW)), '$0.05+');
  assert.match(costDetail(t).join('\n'), /Audit the parser: cost unavailable/);
  assert.doesNotMatch(costDetail(t).join('\n'), /no billed usage/);
});

test('Auto Review child detail uses exact service and inference identities', () => {
  const standard = {
    requests: 1,
    input: 1_000_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 100_000,
    thinking: 0,
  };
  const priority = {
    requests: 1,
    input: 2_000_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 200_000,
    thinking: 0,
  };
  const aggregate = {
    requests: 2,
    input: 3_000_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 300_000,
    thinking: 0,
  };
  const card = toCard(
    turn({
      usage: {
        requests: 0,
        input: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead: 0,
        output: 0,
        thinking: 0,
      },
      agents: [
        agent({
          description: 'Codex Auto Review',
          spendFound: true,
          spend: [
            {
              model: 'codex-auto-review',
              provider: 'openai',
              usage: aggregate,
              usageParts: [
                {
                  model: 'codex-auto-review',
                  provider: 'openai',
                  contextWindow: null,
                  contextBand: null,
                  inferenceClass: 'global',
                  serviceTier: 'standard',
                  usage: standard,
                },
                {
                  model: 'codex-auto-review',
                  provider: 'openai',
                  contextWindow: null,
                  contextBand: null,
                  inferenceClass: 'in-region',
                  serviceTier: 'priority',
                  usage: priority,
                },
              ],
            },
          ],
        }),
      ],
    }),
    false,
    NOW,
  );
  const cost = card.chips.find((chip) => chip.metric === 'cost')!;
  const review = cost.detailList?.entries.find((entry) => entry.label === 'Codex Auto Review');
  assert.equal(review?.value, cost.label);
  assert.match(cost.detail, /Priority service-tier price unavailable\./);
});

test('a running child keeps a priced subtotal marked as incomplete', () => {
  // The turn is still running, so the child reads as running rather than as idle.
  const t = turn({
    finished: false,
    agents: [
      agent({
        status: 'running',
        spendFound: true,
        spend: [
          {
            model: 'claude-haiku-4-5',
            usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
          },
        ],
      }),
    ],
  });
  assert.equal(costChip(toCard(t, false, NOW))?.endsWith('+'), true);
  assert.match(
    costDetail(t).join('\n'),
    /Still running\. This is the cost so far\./,
    'the running line says the figure beside it is a subtotal',
  );
});

test('a running child draws its cost and tokens so far as a lower bound, and no commits or files', () => {
  const usage = {
    requests: 18,
    input: 6_000,
    cacheWrite1h: 0,
    cacheWrite5m: 42_000,
    cacheRead: 610_000,
    output: 9_400,
    thinking: 0,
  };
  const artifacts = {
    files: [{ path: 'extension/src/a.ts', added: 10, removed: 2, isNew: false }],
    commits: ['1234567'],
    complete: true,
    revision: 'child-r1',
  };
  const running = { status: 'running', spendFound: true, artifacts };
  // An unfinished child on a finished parent turn is open. Its detail describes recorded usage without claiming the child still runs.

  const cases = [
    ['running', false, 'running', 'Still running. This is the cost so far.'],
    ['async_launched', true, 'no ending recorded', 'This subagent recorded no ending. This is the cost Arc read.'],
  ] as const;
  for (const [status, finished, word, note] of cases) {
    const priced = toCard(
      turn({
        finished,
        endedAt: NOW,
        agents: [agent({ ...running, status, spend: [{ model: 'claude-sonnet-5', usage }] })],
      }),
      !finished,
      NOW,
    ).agents[0];
    assert.equal(priced.stateWord, word);
    assert.deepEqual(
      priced.figures.map((figure) => figure.metric),
      ['cost'],
      status,
    );
    const [cost] = priced.figures;
    assert.match(cost.compactLabel, /^\$[\d.]+\+$/);
    assert.equal(cost.name, `At least ${cost.compactLabel.slice(0, -1)} spent`);
    assert.ok(cost.detail?.includes(note), cost.detail);
    if (finished) {
      assert.equal(priced.state, 'open');
      assert.doesNotMatch(cost.detail ?? '', /Still running/, 'an idle subagent row claims the child still runs');
    }
  }
  // A spend Arc cannot price draws its tokens so far instead, with the same lower-bound mark.
  const unpriced = toCard(
    turn({
      finished: false,
      endedAt: NOW,
      agents: [agent({ ...running, spend: [{ model: 'unknown-model-x', usage }] })],
    }),
    true,
    NOW,
  ).agents[0];
  assert.deepEqual(
    unpriced.figures.map((figure) => [figure.metric, figure.compactLabel, figure.name]),
    [['tokens', '667k+ tokens', 'At least 667k tokens']],
  );
  assert.deepEqual(unpriced.figures[0].record?.footer, ['Still running. This is the usage so far.']);
  // The same unpriced child on a finished parent turn reports recorded usage without claiming continued activity.

  const idle = toCard(
    turn({
      finished: true,
      endedAt: NOW,
      agents: [agent({ ...running, status: 'async_launched', spend: [{ model: 'unknown-model-x', usage }] })],
    }),
    false,
    NOW,
  ).agents[0];
  assert.equal(idle.state, 'open');
  assert.deepEqual(idle.figures[0].record?.footer, ['This subagent recorded no ending. This is the usage Arc read.']);
});

test('an idle subagent with nothing priced says no ending was recorded', () => {
  // An unpriced open child reports its missing ending. costDetail and the card figure use the same turn-based wording.

  const idle = turn({
    finished: true,
    endedAt: NOW,
    usage: { requests: 2, input: 40_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 2_000, thinking: 0 },
    agents: [agent({ status: 'async_launched', tokens: 22_000 })],
  });
  const cost = toCard(idle, false, NOW).chips.find((chip) => chip.metric === 'cost');
  assert.match(cost?.detail ?? '', /This subagent recorded no ending\. No cost is recorded\./);
  assert.doesNotMatch(cost?.detail ?? '', /Still running/, 'the turn cost list claims an idle subagent still runs');
  assert.equal(costDetail(idle).join('\n'), cost?.detail);
});

test('a running child with nothing priced says no cost is recorded yet', () => {
  // An unpriced running child explains that no cost is recorded yet.

  const t = turn({ finished: false, agents: [agent({ status: 'running', tokens: 22_000 })] });
  const detail = costDetail(t).join('\n');
  assert.match(
    detail,
    /Audit the parser: cost unavailable\n {2}22k tokens recorded\n {2}Still running\. No cost is recorded yet\./,
  );
  assert.doesNotMatch(detail, /costs unavailable/, 'the running line repeats the figure it sits under');
});

test('a priced child still contributes when the main model is unknown', () => {
  const t = turn({
    model: 'unknown',
    usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    agents: [
      agent({
        spendFound: true,
        spend: [
          {
            model: 'claude-haiku-4-5',
            usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
          },
        ],
      }),
    ],
  });
  const card = toCard(t, false, NOW);
  assert.equal(costChip(card), '$1.00+');
  assert.match(costDetail(t).join('\n'), /Main agent · unknown: cost unavailable/);
});

test('the cost detail follows the shared usage category order', () => {
  const lines = costDetail(
    turn({
      usage: {
        input: 200,
        cacheWrite1h: 40_000,
        cacheWrite5m: 8000,
        cacheRead: 3_000_000,
        output: 206_000,
        thinking: 120_000,
      },
    }),
  );
  assert.deepEqual(lines, [
    'Estimated total: $7.10',
    '',
    'Cost by usage · opus-5',
    '  Output: $5.15',
    '  Cached input reads: $1.50 (98% cached)',
    '  Uncached input: <$0.01',
    '  1-hour cache writes: $0.40',
    '  5-minute cache writes: $0.05',
    CACHED_INPUT_READ_EXPLANATION,
    'Estimated from published model rates. Your actual charge may differ.',
  ]);
});

test('turn and session cost detail share the exact main-model label', () => {
  const usage = {
    requests: 1,
    input: 100_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 0,
    output: 10_000,
    thinking: 0,
  };
  const usagePart = {
    model: 'gpt-5.5',
    provider: 'openai',
    contextWindow: 1_050_000,
    contextBand: 'short' as const,
    inferenceClass: null,
    serviceTier: null,
    usage,
  };
  const turnChip = toCard(
    turn({
      agent: 'codex',
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      usage,
      usageParts: [usagePart],
    }),
    false,
    NOW,
  ).chips.find((chip) => chip.metric === 'cost')!;
  const sessionChip = sessionCostStats([{ agent: 'codex', role: 'main', ...usagePart }])[0];

  assert.equal(turnChip.detailList?.entries[0].label, sessionChip.detailList?.entries[0].label);
  assert.equal(turnChip.detailList?.entries[0].label, 'Cost by usage · gpt-5.5');

  const unknownUsage = {
    requests: 1,
    input: 1_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 0,
    output: 100,
    thinking: 0,
  };
  const unknownUsagePart = {
    model: null,
    provider: 'openai',
    contextWindow: null,
    contextBand: 'short' as const,
    inferenceClass: null,
    serviceTier: null,
    usage: unknownUsage,
  };
  const combinedUsage = {
    requests: usage.requests + unknownUsage.requests,
    input: usage.input + unknownUsage.input,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 0,
    output: usage.output + unknownUsage.output,
    thinking: 0,
  };
  const mixedTurnChip = toCard(
    turn({
      agent: 'codex',
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      usage: combinedUsage,
      usageParts: [usagePart, unknownUsagePart],
    }),
    false,
    NOW,
  ).chips.find((chip) => chip.metric === 'cost')!;
  const mixedSessionChip = sessionCostStats([
    { agent: 'codex', role: 'main', ...usagePart },
    { agent: 'codex', role: 'main', ...unknownUsagePart },
  ])[0];

  assert.equal(mixedTurnChip.detailList?.entries[0].label, mixedSessionChip.detailList?.entries[0].label);
  assert.equal(mixedTurnChip.detailList?.entries[0].label, 'Cost by usage · gpt-5.5, model not recorded');
});

test('failed calls stay in Activity and out of the header', () => {
  const failed = [1, 2, 3].map((ordinal) => step({ ordinal, status: 'failed' }));
  const failedTurn = turn({
    failures: failed.map((_, index) => ({ tool: 'Bash', message: `exit 1 (${index + 1})` })),
    steps: failed,
    stepCount: failed.length,
    stepKinds: Array(failed.length).fill('commands'),
  });
  const card = toCard(failedTurn, false, NOW);
  const activity = logOf(failedTurn).rows[0];
  assert.equal(
    card.chips.some((chip) => chip.label.includes('tool calls failed')),
    false,
  );
  assert.equal(
    card.marks.some((mark) => mark.id === 'failures'),
    false,
  );
  assert.equal(activity.failed, 3);
  assert.equal(activity.status, 'done', 'failed child calls make the settled group claim a failed outcome');
  assert.equal(activity.figure, '3 failed');
  assert.equal(activity.steps?.filter((row) => row.figure === 'failed').length, 3);
});

test('an interrupted child gives its group an interrupted status independently', () => {
  const activity = logOf(
    turn({
      steps: [step({ ordinal: 1, status: 'interrupted' }), step({ ordinal: 2 })],
      stepCount: 2,
      stepKinds: ['commands', 'commands'],
    }),
  ).rows[0];
  assert.equal(activity.status, 'interrupted');
  assert.equal(activity.failed, 0);
});

test('a card is marked by what its summary declared, from the list it opens with and no other', () => {
  const summary = [
    '**TLDR**',
    '',
    '- \u2705 The batch landed.',
    '- \u2753 One decision is still open.',
    '- \u2705 And a second thing is done.',
    '',
    'Prose, which ends the list above.',
    '',
    '- \u{1F64B} **Your actions** - reload the panel',
    '- \u2753 **Open questions** - none',
  ].join('\n');
  // Opening-list and closing-row marks appear once each in table order.

  assert.deepEqual(
    toCard(turn({ summary }), false, NOW).marks.map((m) => m.id),
    ['needsYou', 'question', 'done'],
  );

  // Settling both closing rows removes the action mark but retains the opening list's question mark.

  const settled = summary
    .replace('**Your actions** - reload the panel', '**Your actions** - none blocking')
    .replace('**Open questions** - none', '**Open questions** - none open');
  assert.deepEqual(
    toCard(turn({ summary: settled }), false, NOW).marks.map((m) => m.id),
    ['question', 'done'],
  );
});

test('a symbol the table does not hold marks nothing, and a variation selector changes nothing', () => {
  // The variation selector leaves the warning mark unchanged.

  assert.deepEqual(markIds({ summary: '- \u26A0\uFE0F This could bite later.' }), ['caveat']);
  assert.deepEqual(markIds({ summary: '- \u26A0 The same thing, written bare.' }), ['caveat']);
  // An unknown symbol creates no mark.

  assert.deepEqual(markIds({ summary: '- \u{1F984} An invented one.' }), []);
  assert.deepEqual(markIds({ summary: '- No symbol at all.' }), []);
  assert.deepEqual(markIds({ summary: '' }), []);
});

test("the rest of a card's marks are worked out from what the turn changed", () => {
  assert.deepEqual(markIds({ files: [changed('c:/repo/docs/architecture.md', 4, 1)] }), ['docs']);
  assert.deepEqual(markIds({ files: [changed('c:/repo/README.md', 4, 1)] }), ['docs']);
  assert.deepEqual(markIds({ files: [changed('c:/repo/extension/src/store.test.ts', 9, 0)] }), ['tests']);
  assert.deepEqual(markIds({ files: [changed('c:/repo/test/hooks-smoke.sh', 9, 0)] }), ['tests']);
  // A backslash separates a path the store wrote, and it names the same directory.
  assert.deepEqual(markIds({ files: [changed('c:\\repo\\docs\\spec.md', 4, 1)] }), ['docs']);
  assert.deepEqual(markIds({ agents: [agent()] }), ['agents']);
  assert.deepEqual(
    markIds({
      commits: [
        {
          sha: '00facf2a',
          subject: 'Add the timeline',
          files: 3,
          added: 12,
          removed: 0,
          at: NOW,
          place: null,
          dir: null,
        },
      ],
    }),
    ['commit'],
  );
  // The removal mark requires a positive removed count at least twice the added count.

  assert.deepEqual(markIds({ files: [changed('c:/repo/a.ts', 5, 40)] }), ['removal']);
  assert.deepEqual(markIds({ files: [changed('c:/repo/a.ts', 30, 40)] }), []);
  assert.deepEqual(markIds({ files: [changed('c:/repo/a.ts', 0, 0)] }), []);
  // The context mark begins at the first context band.

  const window = 1_000_000; // opus-5, which the fixture runs on
  const atShare = (share: number) => markIds({ contextTokens: Math.round(window * share) });
  assert.deepEqual(atShare(CONTEXT_BANDS[0].at), ['context']);
  assert.deepEqual(atShare(CONTEXT_BANDS[0].at - 0.01), []);
  // The context mark uses the printed percentage, matching the figure's band.

  assert.deepEqual(atShare(CONTEXT_BANDS[0].at - 0.0004), ['context']);
  // Shares between the first two thresholds still carry the context mark.

  assert.deepEqual(atShare(CONTEXT_BANDS[1].at - 0.01), ['context']);
  assert.deepEqual(markIds({ contextTokens: 160_000 }), []);
});

test('the spoken name of a card says its marks in words, and carries no pictograph', () => {
  const card = toCard(
    turn({
      summary: '- \u2705 The batch landed.',
      commits: [
        {
          sha: '00facf2a',
          subject: 'Add the timeline',
          files: 3,
          added: 12,
          removed: 0,
          at: NOW,
          place: null,
          dir: null,
        },
      ],
    }),
    false,
    NOW,
  );
  assert.equal(
    card.label,
    'Turn, finished, 5 hours ago, ran in 12m, started 2:32 PM, Claude opus-5, done, committed. The batch landed.',
  );
  // Accessible card names use mark words instead of pictographs.

  assert.ok(!/\p{Extended_Pictographic}/u.test(card.label), 'the spoken name still carries a pictograph');
  // Recognized symbols leave the headline and remain in card marks.

  assert.equal(card.headline, 'The batch landed.');
  assert.ok(
    card.marks.some((m) => m.character === '\u2705'),
    'the symbol left the headline with nothing carrying it',
  );
  // Unknown symbols remain in the headline because no mark represents them.

  const invented = toCard(turn({ summary: '- \u{1F984} An invented one.' }), false, NOW);
  assert.equal(invented.headline, '\u{1F984} An invented one.');
  assert.deepEqual(invented.marks, []);
});

test('a turn is marked read once it has finished, and a running one or a compaction never is', () => {
  assert.equal(canMarkRead(toCard(turn({ summary: 'Done.' }), false, NOW)), true);
  const running = toCard(turn({ finished: false, endedAt: NOW - 60_000 }), true, NOW);
  assert.equal(running.live, true);
  assert.equal(canMarkRead(running), false);
  assert.equal(canMarkRead(toCompactionCard(compaction(), NOW)), false);
});

test('a card names the section its own menu is matched on, from both of the two axes', () => {
  // Menu section identity combines read-state availability with summary-copy availability.

  const finished = toCard(turn({ summary: 'Done.' }), false, NOW);
  assert.equal(turnMenuSection(finished, false), 'arcTurnUnreadSummary');
  assert.equal(turnMenuSection(finished, true), 'arcTurnReadSummary');

  // Running turns and compactions with summaries use the summary-only menu section.

  const running = toCard(turn({ finished: false, endedAt: NOW - 60_000, summary: 'Halfway.' }), true, NOW);
  assert.equal(running.live, true, 'the fixture is not a running turn, so it cannot see the rule');
  assert.equal(turnMenuSection(running, false), 'arcTurnSummary');
  assert.equal(turnMenuSection(toCompactionCard(compaction(), NOW), false), 'arcTurnSummary');

  // A compaction with no summary supplies no turn-menu section.

  assert.equal(turnMenuSection(toCompactionCard(compaction({ summary: '' }), NOW), false), null);

  // A finished turn with a whitespace-only summary retains its read-state menu section.

  const blank = toCard(turn({ summary: '   \n  ' }), false, NOW);
  assert.equal(turnMenuSection(blank, false), 'arcTurnUnread');
  assert.equal(turnMenuSection(blank, true), 'arcTurnRead');

  // Every returned section name belongs to TURN_MENU_SECTIONS.

  const named = new Set(Object.values(TURN_MENU_SECTIONS));
  for (const section of [
    turnMenuSection(finished, false),
    turnMenuSection(finished, true),
    turnMenuSection(running, false),
    turnMenuSection(blank, false),
    turnMenuSection(blank, true),
  ]) {
    assert.ok(named.has(section as never), `${section} is not in TURN_MENU_SECTIONS`);
  }
  assert.equal(
    new Set(Object.values(TURN_MENU_SECTIONS)).size,
    5,
    'the table no longer holds five names, so one of the two axes lost a state',
  );
});

test('a card carries sessionLabeled only while its session has a label, on every kind of card', () => {
  // The label context is present or absent and never false.
  const finished = toCard(turn({ summary: 'Done.' }), false, NOW);
  assert.equal(turnMenuContext(finished, false, 'body', false, false, true)?.sessionLabeled, true);
  assert.equal('sessionLabeled' in (turnMenuContext(finished, false, 'body', false) ?? {}), false);
  // Selected text keeps both sessionLabeled and arcSelection. Clearing the selection removes arcSelection so the label action can appear.

  assert.equal(turnMenuContext(finished, false, 'body', false, true, true)?.sessionLabeled, true);
  assert.equal(turnMenuContext(finished, false, 'body', false, true, true)?.arcSelection, true);
  assert.equal('arcSelection' in (turnMenuContext(finished, false, 'body', false, false, true) ?? {}), false);
  // A compaction with nothing to copy, mark, or comment on still names its source session.
  const bare = toCompactionCard(compaction({ summary: '' }), NOW);
  assert.deepEqual(turnMenuContext(bare, false, 'body', false), { key: bare.key, session: bare.sessionId });
  assert.deepEqual(turnMenuContext(bare, false, 'body', false, false, true), {
    key: bare.key,
    session: bare.sessionId,
    sessionLabeled: true,
  });
});

test('a card carries its status as a word, for the head row hover', () => {
  // The card supplies a status word for its heading tooltip.

  assert.equal(toCard(turn(), false, NOW).statusWord, 'finished');
  assert.equal(toCard(turn({ finished: false, endedAt: NOW - 60_000 }), true, NOW).statusWord, 'running');
  assert.equal(toCard(turn({ interrupted: true, finished: false }), false, NOW).statusWord, 'stopped by you');
  assert.equal(toCompactionCard(compaction(), NOW).statusWord, 'compaction');
});

test('a compaction says why it ran, what it cost and how long it took', () => {
  const card = toCompactionCard(compaction(), NOW);
  assert.equal(card.kind, 'compaction');
  assert.equal(card.headline, 'Compacted by hand. 629k of session became a 14k summary.');
  assert.equal(card.key, 'sess:compact:' + compaction().at);
  assert.equal(card.duration, '2m');
  assert.equal(card.durationWord, CARD_ACTIONS.ranFor);
  assert.equal(card.durationDetail, 'Compacted 3:05 PM');
  // Without an earlier request, the estimate prices 629k cached-input tokens, a 2k uncached instruction, and a 14k output summary.

  assert.deepEqual(
    card.chips.map((c) => c.label),
    ['$0.68', '615k dropped'],
  );
  assert.equal(card.chips[0].detail.split('\n')[0], '631k of context sent, 14k summary written.');
  assert.match(card.chips[0].detail, /Claude Code records no usage for a compaction, so this cost is an estimate\./);
  assert.match(card.chips[0].detail, /Estimated from published model rates\. Your actual charge may differ/);
  // A compaction draws the same row whether it is open or shut.
  assert.deepEqual(
    foldedChips(card.chips).map((c) => c.label),
    ['$0.68', '615k dropped'],
  );
});

test('a compaction card names a refusal trigger and any other recorded trigger', () => {
  assert.equal(
    toCompactionCard(compaction({ trigger: 'refusal' }), NOW).headline,
    'Compacted after a refusal. 629k of session became a 14k summary.',
  );
  assert.equal(
    toCompactionCard(compaction({ trigger: 'scheduled' }), NOW).headline,
    'Compacted (Scheduled). 629k of session became a 14k summary.',
  );
  assert.equal(
    toCompactionCard(compaction({ trigger: '' }), NOW).headline,
    'Compacted. 629k of session became a 14k summary.',
  );
});

test('a compaction that ran because the context filled up says so', () => {
  const card = toCompactionCard(compaction({ trigger: 'auto' }), NOW);
  assert.equal(card.headline, 'Compacted automatically. 629k of session became a 14k summary.');
  assert.equal(
    card.label,
    'Compaction, 4 hours ago, ran in 2m. Compacted automatically. 629k of session became a 14k summary.',
  );
});

test('a compaction with no figures recorded still reads as a sentence', () => {
  const card = toCompactionCard(
    compaction({
      contextBefore: 0,
      contextAfter: 0,
      droppedTokens: 0,
      durationMs: 0,
      trigger: '',
      summary: '',
    }),
    NOW,
  );
  assert.equal(card.headline, 'Compacted.');
  assert.deepEqual(card.chips, []);
});

test('a compaction headline distinguishes which resulting context facts were recorded', () => {
  const sizeOnly = toCompactionCard(compaction({ contextBefore: 0, contextAfter: 14_172, summary: '' }), NOW);
  assert.equal(sizeOnly.headline, 'Compacted by hand. The resulting context was 14k.');
  assert.equal(sizeOnly.summary, '');

  const summaryOnly = toCompactionCard(compaction({ contextBefore: 0, contextAfter: 0 }), NOW);
  assert.equal(summaryOnly.headline, 'Compacted by hand. The session was replaced by a summary of itself.');
  assert.equal(summaryOnly.summary, '# What carried over');

  const neither = toCompactionCard(compaction({ contextAfter: 0, summary: '' }), NOW);
  assert.equal(neither.headline, 'Compacted by hand. 629k of session was compacted.');

  const complete = toCompactionCard(compaction(), NOW);
  assert.equal(complete.headline, 'Compacted by hand. 629k of session became a 14k summary.');
});

test('cost is omitted for a model the price table does not know', () => {
  const card = toCard(
    turn({
      model: 'some-other-model',
      usage: { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 1000, output: 500, thinking: 0 },
    }),
    false,
    NOW,
  );
  assert.equal(costChip(card), undefined, 'an unpriced model draws no cost chip');
  assert.deepEqual(
    tokenLines(turn({ usage: { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 } })),
    [],
  );
});

test('cardPrint holds still under the clock and moves with the content', () => {
  // The fixture end time is ahead of the first clock and within the second clock's quiet window.

  const running = turn({
    finished: false,
    endedAt: new Date(2026, 7, 23, 23, 40).getTime(),
    summary: 'Working on it.',
  });
  // Crossing midnight changes clock wording without changing card content.

  const NOON = new Date(2026, 7, 23, 12, 0).getTime();
  const PAST_MIDNIGHT = new Date(2026, 7, 24, 0, 5).getTime();
  const early = toCard(running, true, NOON);
  const late = toCard(running, true, PAST_MIDNIGHT);
  assert.notEqual(early.relative, late.relative, 'the fixture no longer moves the clock wording');
  assert.notEqual(early.absolute, late.absolute, 'the fixture no longer crosses midnight');
  assert.notEqual(early.label, late.label);
  assert.equal(
    cardPrint(early),
    cardPrint(late),
    'the clock alone changed the print, so every poll rebuilds every card',
  );
  // Content moves it: a new summary, a status change, and a chip change each rewrite.
  const spoke = toCard(
    turn({ finished: false, endedAt: new Date(2026, 7, 23, 23, 40).getTime(), summary: 'Done differently.' }),
    true,
    NOON,
  );
  assert.notEqual(cardPrint(early), cardPrint(spoke), 'a changed summary reads as unchanged');
  const finished = toCard(turn({ summary: 'Working on it.' }), true, NOON);
  assert.notEqual(cardPrint(early), cardPrint(finished), 'a finished turn reads as still running');
  // The payload fields the host adds on top of the card count as content too.
  const bare = { ...early, summaryHtml: '<p>a</p>' };
  const rendered = { ...early, summaryHtml: '<p>b</p>' };
  assert.notEqual(
    cardPrint(bare),
    cardPrint(rendered),
    'the rendered summary is not compared, so an icon or html change never redraws',
  );
  const dispatched = { ...early, dispatched: [{ description: 'Review the change', state: 'running' }] };
  const completedDispatch = { ...early, dispatched: [{ description: 'Review the change', state: 'done' }] };
  assert.notEqual(
    cardPrint(dispatched),
    cardPrint(completedDispatch),
    'a dispatched session changed without redrawing its parent card',
  );
  // A field the card lacks stringifies as null on both sides rather than throwing.
  assert.equal(cardPrint({}), cardPrint({}));
  // Clock wording inside answer and commit rows does not change the card print.

  const answeredAt = (absolute: string) => ({
    key: 'k',
    earlierAnswers: [{ summary: 'First answer.', at: 5, summaryHtml: '<p>First answer.</p>', absolute }],
  });
  assert.equal(
    cardPrint(answeredAt('2:32 PM')),
    cardPrint(answeredAt('Aug 27 2:32 PM')),
    'the hover clock alone changed the print, so midnight rebuilds every multi-answer card',
  );
  const reworded = {
    key: 'k',
    earlierAnswers: [{ summary: 'Another answer.', at: 5, summaryHtml: '<p>Another answer.</p>', absolute: '2:32 PM' }],
  };
  assert.notEqual(
    cardPrint(answeredAt('2:32 PM')),
    cardPrint(reworded),
    'a changed earlier answer reads as unchanged, so the card on screen goes stale',
  );
  const committedAt = (absolute: string) => ({
    key: 'k',
    commits: [{ sha: '00facf2a', subject: 'Add the timeline', detail: 'Add the timeline', at: 5, absolute }],
  });
  assert.equal(
    cardPrint(committedAt('2:32 PM')),
    cardPrint(committedAt('Aug 27 2:32 PM')),
    'the commit hover clock alone changed the print, so midnight rebuilds every card holding a commit',
  );
  // A branch landing adds a commit row whose absolute time gains a date across midnight.

  const branchMerged = turn({
    commits: [recordCommit('aaaa1111', 'Write it', 0, { head: { kind: 'branch', name: 'topic' } })],
    landings: [recordLanding('bbbb2222', 'Merge topic', 5, 'topic')],
  });
  const beforeMidnight = toCard(branchMerged, false, new Date(2026, 7, 23, 18, 0).getTime());
  const afterMidnight = toCard(branchMerged, false, new Date(2026, 7, 24, 0, 5).getTime());
  assert.notEqual(
    beforeMidnight.commits?.[1]?.absolute,
    afterMidnight.commits?.[1]?.absolute,
    'the fixture no longer crosses midnight',
  );
  assert.equal(beforeMidnight.chips.find((chip) => chip.metric === 'commits')?.detailList?.heading?.fact, '· on topic');
  assert.equal(
    cardPrint(beforeMidnight),
    cardPrint(afterMidnight),
    'the merge time alone changed the print, so midnight rebuilds every card whose branch merged',
  );
  const amended = {
    key: 'k',
    commits: [
      {
        sha: '00facf2a',
        subject: 'Add the timeline',
        detail: 'Add the timeline\n4 files changed',
        at: 5,
        absolute: '2:32 PM',
      },
    ],
  };
  assert.notEqual(
    cardPrint(committedAt('2:32 PM')),
    cardPrint(amended),
    'a changed commit row reads as unchanged, so the row on screen goes stale',
  );
});

test("every field a card carries is either compared or the clock's, and none is both", () => {
  // Turn and compaction payload fields belong to exactly one content or time list.

  const turnPayload = {
    ...toCard(turn({ summary: 'Ran `npm test` and it passed.' }), true, NOW),
    summaryHtml: '<p>s</p>',
    at: 1,
    dispatched: [],
  };
  const compaction = {
    sessionId: 'sess',
    at: NOW - 1000,
    trigger: 'auto' as const,
    summary: 'carried over',
    contextBefore: 100_000,
    contextAfter: 8_000,
    durationMs: 20_000,
    droppedTokens: 100_000,
    model: 'claude-opus-5',
  };
  const compactionPayload = { ...toCompactionCard(compaction, NOW), summaryHtml: '<p>s</p>' };
  for (const [name, payload] of [
    ['turn', turnPayload],
    ['compaction', compactionPayload],
  ] as const) {
    for (const field of Object.keys(payload)) {
      assert.ok(
        CARD_CONTENT_FIELDS.includes(field) || CARD_TIME_FIELDS.includes(field),
        `a ${name} card carries "${field}", which neither list places, so the in-place path ignores it`,
      );
    }
  }
  for (const field of CARD_CONTENT_FIELDS) {
    assert.ok(!CARD_TIME_FIELDS.includes(field), `"${field}" is in both lists`);
    assert.ok(
      field in turnPayload || field in compactionPayload,
      `the content list names "${field}", which no card carries`,
    );
  }
  for (const field of CARD_TIME_FIELDS) {
    assert.ok(
      field in turnPayload || field in compactionPayload,
      `the time list names "${field}", which no card carries`,
    );
  }
});

// Commentary and earlier answers reach the card in chronological order.

test('every message the agent sent while the turn ran reaches the card, oldest first', () => {
  const at = (minutes: number) => new Date(2026, 7, 23, 14, 32 + minutes).getTime();
  const working = turn({
    summary: 'The last word.',
    // Earlier-answer indexes differ from their positions in the chronological message list.

    answers: [
      { stepsBefore: 0, text: 'A first pass, closed.', at: at(2) },
      { stepsBefore: 0, text: 'A second pass, closed.', at: at(5) },
      { stepsBefore: 0, text: 'The last word.', at: at(6) },
    ],
    updates: [
      {
        stepsBefore: 0,
        sourceId: 'u1',
        kind: 'commentary',
        text: 'Reading the parser now.',
        at: at(1),
        status: 'done',
      },
      // Thinking, not a message. It has a row in the log and no place here.
      {
        stepsBefore: 0,
        sourceId: 'u2',
        kind: 'reasoning',
        text: 'The table may be the wrong shape.',
        at: at(3),
        status: 'done',
      },
      {
        stepsBefore: 0,
        sourceId: 'u3',
        kind: 'commentary',
        text: 'The table was wrong. Rewriting it.',
        at: at(4),
        status: 'done',
      },
    ],
  });
  const card = toCard(working, false, NOW);
  assert.deepEqual(
    card.saidMessages.map((m) => m.kind),
    ['commentary', 'answer', 'commentary', 'answer'],
    'the two records are not merged into one run in the order the transcript recorded them',
  );
  assert.deepEqual(
    card.saidMessages.map((m) => m.text),
    [
      'Reading the parser now.',
      'A first pass, closed.',
      'The table was wrong. Rewriting it.',
      'A second pass, closed.',
    ],
    'a message was dropped, reordered, or drawn as another kind of thing',
  );
  assert.deepEqual(
    card.saidMessages.map((m) => m.at),
    [at(1), at(2), at(4), at(5)],
  );
  // The response is the turn's last answer and it is drawn above this section, never in it.
  assert.equal(
    card.saidMessages.some((m) => m.text === 'The last word.'),
    false,
    'the response is repeated inside the section that sits under it',
  );

  // Each message carries clock and absolute timestamp wording.

  assert.deepEqual(
    card.saidMessages.map((m) => m.when),
    ['2:33 PM', '2:34 PM', '2:36 PM', '2:37 PM'],
  );
  assert.deepEqual(
    card.saidMessages.map((m) => m.absolute),
    ['2:33 PM', '2:34 PM', '2:36 PM', '2:37 PM'],
  );

  // Chronological message sorting preserves newest-first earlier-answer indexes used by comment anchors.

  const answers = card.saidMessages.filter((m) => m.kind === 'answer');
  assert.deepEqual(
    answers.map((m) => m.answerIndex),
    [1, 0],
  );
  for (const answer of answers) {
    assert.equal(
      commentAnchorText(card, answerPart(answer.answerIndex!)),
      answer.text,
      'a note written before this section existed now resolves to a different answer',
    );
  }

  // The section name and folded summary count messages and replies.

  assert.equal(card.saidName, 'Said while working, 4 messages, 2 replies');
  assert.equal(card.saidMix, '4 messages, 2 replies');
});

test('the messages are put in clock order, whatever order the two lists arrived in', () => {
  // Answer and update timestamps need not follow source-list order. The displayed message list sorts their combined timestamps.

  const out = toCard(
    turn({
      summary: 'The last word.',
      answers: [
        { stepsBefore: 0, text: 'A first pass, closed.', at: 15 },
        { stepsBefore: 0, text: 'The last word.', at: 30 },
      ],
      updates: [
        { stepsBefore: 0, sourceId: 'u1', kind: 'commentary', text: 'Second thought.', at: 20, status: 'done' },
        { stepsBefore: 0, sourceId: 'u2', kind: 'commentary', text: 'First thought.', at: 10, status: 'done' },
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    out.saidMessages.map((m) => m.text),
    ['First thought.', 'A first pass, closed.', 'Second thought.'],
    'the section is drawn in an order none of the messages were written in',
  );

  // Commentary precedes an answer with the same timestamp.

  const tied = toCard(
    turn({
      summary: 'The last word.',
      answers: [
        { stepsBefore: 0, text: 'A first pass, closed.', at: 15 },
        { stepsBefore: 0, text: 'The last word.', at: 30 },
      ],
      updates: [{ stepsBefore: 0, sourceId: 'u1', kind: 'commentary', text: 'Still reading.', at: 15, status: 'done' }],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    tied.saidMessages.map((m) => m.text),
    ['Still reading.', 'A first pass, closed.'],
    'an answer is drawn above the narration it closed',
  );
});

test('sorting the section renumbers nothing, and leaves the record it was built from alone', () => {
  // Answer timestamps can run backward relative to their source order.
  const backwards = toCard(
    turn({
      summary: 'The last word.',
      answers: [
        { stepsBefore: 0, text: 'Recorded first, stamped later.', at: 40 },
        { stepsBefore: 0, text: 'Recorded second, stamped earlier.', at: 20 },
        { stepsBefore: 0, text: 'The last word.', at: 50 },
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    backwards.saidMessages.map((m) => m.text),
    ['Recorded second, stamped earlier.', 'Recorded first, stamped later.'],
  );
  // Sorting messages preserves the answer indexes assigned by earlierAnswersOf.

  for (const said of backwards.saidMessages) {
    assert.equal(
      commentAnchorText(backwards, answerPart(said.answerIndex!)),
      said.text,
      'the sort renumbered the answers, so every note left on one now names another',
    );
  }

  // earlierAnswers retains newest-first source order independently of displayed message sorting.

  const recorded = toCard(
    turn({
      summary: 'The last word.',
      answers: [
        { stepsBefore: 0, text: 'A first pass, closed.', at: 20 },
        { stepsBefore: 0, text: 'A second pass, closed.', at: 40 },
        { stepsBefore: 0, text: 'The last word.', at: 50 },
      ],
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    recorded.earlierAnswers.map((a) => a.at),
    [40, 20],
    'the record was sorted along with the display list, so a search snippet is cut in a new order',
  );
});

test('the said section counts what it holds, and says nothing about replies it has none of', () => {
  const one = toCard(
    turn({
      updates: [
        {
          stepsBefore: 0,
          sourceId: 'u1',
          kind: 'commentary',
          text: 'Reading the parser now.',
          at: NOW - 1000,
          status: 'done',
        },
      ],
    }),
    false,
    NOW,
  );
  assert.equal(one.saidName, 'Said while working, 1 message');
  assert.equal(one.saidMix, '1 message');
  const answered = toCard(
    turn({
      summary: 'The last word.',
      answers: [
        { stepsBefore: 0, text: 'A first pass, closed.', at: NOW - 2000 },
        { stepsBefore: 0, text: 'The last word.', at: NOW - 1000 },
      ],
    }),
    false,
    NOW,
  );
  assert.equal(answered.saidName, 'Said while working, 1 message, 1 reply');
  // A turn that said nothing draws no section at all, so its head has no counts to carry.
  const quiet = toCard(turn(), false, NOW);
  assert.deepEqual(quiet.saidMessages, []);
  assert.equal(quiet.saidMix, '');
  assert.equal(quiet.saidName, 'Said while working');
});

test('the hover clock on a mid-turn message alone does not rebuild the card', () => {
  // Message tooltip wording changes across midnight without changing the card print.

  const saidAt = (absolute: string) => ({
    key: 'k',
    saidMessages: [
      {
        id: 'answer:5:0',
        kind: 'answer',
        at: 5,
        text: 'A first pass, closed.',
        summaryHtml: '<p>A first pass, closed.</p>',
        when: '2:32 PM',
        absolute,
        answerIndex: 0,
      },
    ],
  });
  assert.equal(
    cardPrint(saidAt('2:32 PM')),
    cardPrint(saidAt('Aug 27 2:32 PM')),
    'the hover clock alone changed the print, so midnight rebuilds every card that said anything',
  );
  const reworded = {
    key: 'k',
    saidMessages: [
      {
        id: 'answer:5:0',
        kind: 'answer',
        at: 5,
        text: 'A second pass, closed.',
        summaryHtml: '<p>A second pass, closed.</p>',
        when: '2:32 PM',
        absolute: '2:32 PM',
        answerIndex: 0,
      },
    ],
  };
  assert.notEqual(
    cardPrint(saidAt('2:32 PM')),
    cardPrint(reworded),
    'a changed mid-turn message reads as unchanged, so the section on screen goes stale',
  );
  // Rendered message HTML changes the card print even when source text stays identical.

  const rerendered = {
    key: 'k',
    saidMessages: [
      {
        ...saidAt('2:32 PM').saidMessages[0],
        summaryHtml: '<p>A first pass, <em>closed</em>.</p>',
      },
    ],
  };
  assert.notEqual(
    cardPrint(saidAt('2:32 PM')),
    cardPrint(rerendered),
    'a message rendered again reads as unchanged, so the section draws the markup it first had',
  );
  // The message clock field remains in the card print.

  const reclocked = {
    key: 'k',
    saidMessages: [{ ...saidAt('2:32 PM').saidMessages[0], when: '2:33 PM' }],
  };
  assert.notEqual(
    cardPrint(saidAt('2:32 PM')),
    cardPrint(reclocked),
    'the time drawn on a message is out of the print, so a card drawn again shows the old one',
  );
  // A narration arriving is content, and the card has to repaint for the reader to see it.
  const grown = {
    key: 'k',
    saidMessages: [
      ...saidAt('2:32 PM').saidMessages,
      {
        id: 'commentary:6:0',
        kind: 'commentary',
        at: 6,
        text: 'Rewriting it.',
        summaryHtml: '<p>Rewriting it.</p>',
        when: '2:33 PM',
        absolute: '2:33 PM',
      },
    ],
  };
  assert.notEqual(
    cardPrint(saidAt('2:32 PM')),
    cardPrint(grown),
    'a message arriving reads as no change, so the section freezes while the turn runs',
  );
});

// Stable message IDs preserve expansion and overflow state across card updates.

test('a mid-turn message keeps one identity, and a message arriving moves nobody else', () => {
  const at = (minutes: number) => new Date(2026, 7, 23, 14, 32 + minutes).getTime();
  const written = (updates: object[], answers: object[]) =>
    saidMessagesOf({ summary: 'The last word.', answers, updates } as Parameters<typeof saidMessagesOf>[0], NOW);
  const closed = [
    { text: 'A first pass, closed.', at: at(4) },
    { text: 'The last word.', at: at(9) },
  ];
  // Two commentary messages with the same timestamp retain distinct IDs.

  const tied = written(
    [
      { sourceId: 'u1', kind: 'commentary', text: 'Reading the parser.', at: at(2), status: 'done' },
      { sourceId: 'u2', kind: 'commentary', text: 'And the lexer beside it.', at: at(2), status: 'done' },
    ],
    [{ text: 'The last word.', at: at(9) }],
  );
  assert.equal(tied.length, 2, 'the fixture no longer draws two messages, so this measures nothing');
  assert.notEqual(tied[0].id, tied[1].id, 'two messages on one stamp share an id, so a press on one opens the other');

  // A newly arrived message with an earlier timestamp preserves existing message IDs.

  const reading = { sourceId: 'u1', kind: 'commentary', text: 'Reading the parser.', at: at(3), status: 'done' };
  const before = written([reading], closed);
  const after = written(
    [{ sourceId: 'u0', kind: 'commentary', text: 'Starting on it.', at: at(1), status: 'done' }, reading],
    closed,
  );
  assert.equal(after.length, before.length + 1, 'the message did not arrive, so this measures nothing');
  for (const was of before) {
    const now = after.find((m) => m.text === was.text);
    assert.equal(
      now?.id,
      was.id,
      `"${was.text}" was renumbered by a message arriving above it, so the reader's press moved to another`,
    );
  }
});

// Zero message timestamps represent unavailable time and produce no visible or tooltip clock.

test('a mid-turn message the record gave no time carries no clock at all', () => {
  const unstamped = saidMessagesOf(
    {
      summary: 'The last word.',
      answers: [
        { stepsBefore: 0, text: 'A first pass, closed.', at: 0 },
        { stepsBefore: 0, text: 'The last word.', at: NOW - 1000 },
      ],
      updates: [
        { stepsBefore: 0, sourceId: 'u1', kind: 'commentary', text: 'Reading the parser.', at: 0, status: 'done' },
      ],
    },
    NOW,
  );
  assert.equal(unstamped.length, 2, 'the fixture no longer carries two unstamped messages');
  assert.deepEqual(
    unstamped.map((m) => m.when),
    ['', ''],
    'a message with no time draws one off the epoch, so the card says the agent spoke in 1969',
  );
  assert.deepEqual(
    unstamped.map((m) => m.absolute),
    ['', ''],
    'the hover on a message with no time reveals a moment off the epoch',
  );
  // And a message the record did stamp keeps the clock it draws.
  const stamped = saidMessagesOf(
    {
      summary: 'The last word.',
      answers: [],
      updates: [
        {
          stepsBefore: 0,
          sourceId: 'u1',
          kind: 'commentary',
          text: 'Reading the parser.',
          at: NOW - 60_000,
          status: 'done',
        },
      ],
    },
    NOW,
  );
  assert.equal(stamped[0].when, '7:59 PM', 'a stamped message lost the clock the meta line draws');
  assert.equal(stamped[0].absolute, '7:59 PM', 'a stamped message lost the moment its hover reveals');
});

test('a card leads with latest activity and carries its start on the duration hover', () => {
  const card = toCard(turn({ startedAt: NOW - 5 * 60_000, endedAt: NOW - 60_000 }), false, NOW);
  assert.equal(card.relative, '5 mins ago');
  assert.equal(card.absolute, '7:55 PM');
  assert.equal(card.lastRelative, '1 min ago');
  assert.equal(card.lastAbsolute, '7:59 PM');
  assert.equal(card.duration, '4m');
  assert.equal(card.durationDetail, 'Started 7:55 PM');
  const cc = toCompactionCard(compaction(), NOW);
  assert.equal(cc.relative, '4 hours ago'); // 3:05 PM to the 8:00 PM "now"
  assert.equal(cc.absolute, '3:05 PM');
});

test('a turn that did work and changed no files says so, in every status but a running one', () => {
  const chipLabels = (card: TurnCard) => card.chips.map((c) => c.label);
  // Finished, failed, interrupted, and stopped turns all expose the no-file-change figure when their file list is empty.

  for (const [status, card] of [
    ['done', toCard(turn({ summary: 'Read the parser.', toolUses: 1 }), false, NOW)],
    ['failed', toCard(turn({ error: 'Overloaded.', toolUses: 1 }), false, NOW)],
    ['interrupted', toCard(turn({ finished: false, interrupted: true, toolUses: 1 }), false, NOW)],
    ['stopped', toCard(turn({ finished: false, toolUses: 1 }), false, NOW)],
  ] as [string, TurnCard][]) {
    assert.equal(card.status, status, `the ${status} fixture is not a ${status} turn`);
    assert.ok(chipLabels(card).includes('no file changes'), `a ${status} turn should say it changed nothing`);
  }
  // Running turns omit the no-file-change figure.

  const running = toCard(turn({ finished: false, endedAt: NOW - 60_000 }), true, NOW);
  assert.equal(running.status, 'running', 'the fixture must be a running turn');
  assert.ok(!chipLabels(running).includes('no file changes'));
  // And a turn that did change files says how many, not that there were none.
  const edited = toCard(
    turn({
      files: [{ path: 'c:/repo/a.ts', added: 3, removed: 1, isNew: false, edits: [] }],
    }),
    false,
    NOW,
  );
  assert.ok(!chipLabels(edited).includes('no file changes'));
  assert.ok(chipLabels(edited).includes('1 file'));
  // A turn where nothing happened has no files figure: no tool calls, subagents, commits, or output.
  const failedEarly = toCard(turn({ error: 'Credit balance is too low' }), false, NOW);
  assert.equal(failedEarly.status, 'failed', 'the fixture must be a failed turn');
  assert.ok(!failedEarly.chips.some((chip) => chip.metric === 'files'));
  // A turn whose only work is a subagent, or only a commit, keeps the figure.
  const agentOnly = toCard(turn({ summary: 'Delegated.', agents: [subagent()] }), false, NOW);
  assert.ok(
    chipLabels(agentOnly).includes('no file changes'),
    'a turn with only a subagent should say it changed nothing',
  );
  const commitOnly = toCard(
    turn({ summary: 'Committed.', commits: [recordCommit('abc1234', 'Record the change', 0)] }),
    false,
    NOW,
  );
  assert.ok(
    chipLabels(commitOnly).includes('no file changes'),
    'a turn with only a commit should say it changed nothing',
  );
  // A turn that recorded output tokens keeps the figure.
  const answered = toCard(turn({ summary: 'Answered.', usage: { ...turn().usage, output: 50 } }), false, NOW);
  assert.ok(chipLabels(answered).includes('no file changes'));
  const emptyDetail = toCard(turn({ summary: 'Read the parser.', toolUses: 1 }), false, NOW).chips.find(
    (chip) => chip.label === 'no file changes',
  )!.detail;
  assert.match(emptyDetail, /Changes outside edit tools/);
  assert.match(emptyDetail, /Delegated changes/);
  assert.match(emptyDetail, /Changes in scratch directories/);
});

test('a path is drawn and announced with forward slashes, and acted on as it was recorded', () => {
  // Visible and spoken paths use forward slashes independently of their recorded spelling.

  const inside = 'c:\\repo\\src\\store.ts';
  const outside = 'c:\\Users\\dev\\AppData\\Local\\Temp\\scratch\\notes.md';
  const card = toCard(
    turn({
      files: [
        { path: inside, added: 3, removed: 1, isNew: false, edits: [] },
        { path: outside, added: 1, removed: 0, isNew: true, edits: [] },
      ],
    }),
    false,
    NOW,
    ['c:/repo'],
  );

  // Workspace file rows use basename labels and a normalized full path for their tooltip.

  assert.deepEqual(
    [card.files[0].name, card.files[0].lead, card.files[0].label],
    ['store.ts', undefined, 'File store.ts'],
  );
  assert.equal(card.files[0].shownPath, 'c:/repo/src/store.ts');

  // A whole-path row: the directory, the filename, the spoken name and the hover.
  assert.equal(card.files[1].lead, 'c:/Users/dev/AppData/Local/Temp/scratch/');
  assert.equal(card.files[1].name, 'notes.md');
  assert.equal(card.files[1].label, 'File c:/Users/dev/AppData/Local/Temp/scratch/notes.md, new');
  assert.equal(card.files[1].shownPath, 'c:/Users/dev/AppData/Local/Temp/scratch/notes.md');

  // The card retains the recorded path separately for file actions.

  assert.deepEqual(
    card.files.map((f) => f.path),
    [inside, outside],
  );

  // Colliding basename labels use normalized directory suffixes.

  const collide = toCard(
    turn({
      files: [
        { path: 'c:\\repo\\a\\index.ts', added: 1, removed: 0, isNew: false, edits: [] },
        { path: 'c:/repo/b/index.ts', added: 1, removed: 0, isNew: false, edits: [] },
      ],
    }),
    false,
    NOW,
    ['c:/repo'],
  );
  assert.deepEqual(
    collide.files.map((f) => f.label),
    ['File a/index.ts', 'File b/index.ts'],
  );
  assert.deepEqual(
    collide.files.map((f) => f.path),
    ['c:\\repo\\a\\index.ts', 'c:/repo/b/index.ts'],
  );
});

test('a commit made in a worktree of this repository is not read as another repository', () => {
  const made = (over: Partial<TurnCommit> = {}): TurnCommit => ({
    sha: 'abc1234',
    subject: 'Note the run',
    files: 3,
    added: 12,
    removed: 1,
    at: NOW,
    place: null,
    dir: null,
    ...over,
  });

  // A linked worktree remains part of the same repository and receives a worktree location label.

  const card = commitCard(
    made({
      place: { kind: 'worktree', dir: 'C:/Users/dev/arc-worktrees/usage-model-bucket' },
      head: { kind: 'branch', name: 'feat/usage-model-bucket' },
    }),
    NOW,
  );
  assert.equal(card.where, 'in worktree usage-model-bucket');
  assert.equal(card.detail, 'Note the run\n3 files changed');
  // The branch and worktree directory remain separate fields.

  assert.equal(card.branch, 'feat/usage-model-bucket');
  if (card.where === null) {
    assert.fail('the worktree label is missing');
  }
  assert.doesNotMatch(card.where, /feat/);
  // A directory written with backslashes draws in the one spelling the panel uses.
  const backslashed = commitCard(
    made({ place: { kind: 'worktree', dir: 'C:\\Users\\dev\\arc-worktrees\\usage-model-bucket' } }),
    NOW,
  );
  assert.equal(backslashed.where, 'in worktree usage-model-bucket');
  assert.equal(backslashed.detail, 'Note the run\n3 files changed');
});

test('the tree the worktrees came from is not called a worktree', () => {
  const made = (over: Partial<TurnCommit> = {}): TurnCommit => ({
    sha: 'abc1234',
    subject: 'Note the run',
    files: 3,
    added: 12,
    removed: 1,
    at: NOW,
    place: null,
    dir: null,
    ...over,
  });

  // The main checkout of the same repository receives a main-tree label.

  const main = 'C:/Users/dev/Projects/work/arc';
  const card = commitCard(made({ place: { kind: 'maintree', dir: main } }), NOW);
  assert.equal(card.where, 'in the main tree');
  assert.equal(card.detail, 'Note the run\n3 files changed');
  if (card.where === null) {
    assert.fail('the main-tree label is missing');
  }
  assert.doesNotMatch(card.where, /worktree/);

  // An unknown location kind supplies no location wording.

  const unknown = commitCard(
    made({ place: { kind: 'somewhere-new', dir: main } as unknown as TurnCommit['place'] }),
    NOW,
  );
  assert.equal(unknown.where, null);
  assert.equal(unknown.detail, 'Note the run\n3 files changed');
});

test('a commit row says which repository it landed in, and only when that is not this one', () => {
  const made = (over: Partial<TurnCommit> = {}): TurnCommit => ({
    sha: 'abc1234',
    subject: 'Note the run',
    files: 3,
    added: 12,
    removed: 1,
    at: NOW,
    place: null,
    dir: null,
    ...over,
  });

  // A workspace commit without location evidence adds no location label.

  const here = commitCard(made(), NOW);
  assert.deepEqual([here.branch, here.headKind, here.repository], [null, null, null]);
  assert.equal(here.where, null);
  assert.equal(here.detail, 'Note the run\n3 files changed');
  // Another repository uses its directory basename as the location label and its full path in the tooltip.

  const away = commitCard(made({ place: { kind: 'named', dir: 'C:/Users/dev/Projects/side-repo' } }), NOW);
  assert.equal(away.where, 'in side-repo');
  assert.equal(away.detail, 'Note the run\n3 files changed\nin C:/Users/dev/Projects/side-repo');
  const branch = commitCard(made({ head: { kind: 'branch', name: 'main' } }), NOW);
  assert.deepEqual([branch.branch, branch.headKind], ['main', 'branch']);
  // The group heading owns the branch, so the hover does not repeat it.
  assert.doesNotMatch(branch.detail, /on main/);
  const detached = commitCard(made({ head: { kind: 'detached' } }), NOW);
  assert.deepEqual([detached.branch, detached.headKind], [null, 'detached']);
  // Nested repositories use workspace-relative names. Outside repositories use directory basenames. Repository identity distinguishes a nested repository without separate location evidence.

  const repository = (place: TurnCommit['place'], root: string, own: boolean) =>
    commitCard(
      made({
        place,
        repository: { key: `${root}/.git`, root, own },
      }),
      NOW,
      null,
      null,
      ['C:/Users/dev/Projects/arc'],
    ).repository;
  assert.deepEqual(repository(null, 'C:/Users/dev/Projects/arc/.claude/plans', false), {
    key: 'C:/Users/dev/Projects/arc/.claude/plans/.git',
    name: '.claude/plans',
    own: false,
  });
  assert.deepEqual(
    repository({ kind: 'named', dir: 'C:/Users/dev/Projects/side-repo' }, 'C:/Users/dev/Projects/side-repo', false),
    { key: 'C:/Users/dev/Projects/side-repo/.git', name: 'side-repo', own: false },
  );
  assert.equal(repository(null, 'C:/Users/dev/Projects/arc', true)?.own, true);
  assert.equal(repository({ kind: 'worktree', dir: 'C:/Users/dev/trees/x' }, 'C:/Users/dev/trees/x', true)?.own, true);
  // Repository location labels and tooltip paths accept backslash spelling.

  const backslashed = commitCard(made({ place: { kind: 'named', dir: 'C:\\Users\\dev\\Projects\\side-repo' } }), NOW);
  assert.equal(backslashed.where, 'in side-repo');
  assert.equal(backslashed.detail, 'Note the run\n3 files changed\nin C:/Users/dev/Projects/side-repo');
  // An ambiguous repository location keeps generic wording and explains the ambiguity in its tooltip.

  const elsewhere = commitCard(made({ place: { kind: 'unnamed' } }), NOW);
  assert.equal(elsewhere.where, 'in another repository');
  assert.equal(
    elsewhere.detail,
    'Note the run\n3 files changed\nIn another repository. The call committed to more than one, so which one cannot be said.',
  );
  // Ambiguous repository detail names no directory.
  if (elsewhere.where === null) {
    assert.fail('the other-repository label is missing');
  }
  assert.doesNotMatch(elsewhere.where, /[/\\]/);
  assert.doesNotMatch(elsewhere.detail, /[/\\]/);
  // Absent commit statistics add no file-count line.

  const quiet = commitCard(
    made({ files: null, added: null, removed: null, place: { kind: 'named', dir: 'C:/Users/dev/Projects/side-repo' } }),
    NOW,
  );
  assert.equal(quiet.detail, 'Note the run\nin C:/Users/dev/Projects/side-repo');
  assert.equal(commitCard(made({ files: null, added: null, removed: null }), NOW).detail, 'Note the run');
  assert.equal(
    commitCard(made({ files: null, added: null, removed: null, place: { kind: 'unnamed' } }), NOW).detail,
    'Note the run\nIn another repository. The call committed to more than one, so which one cannot be said.',
  );
  // One file changed is one file, not one files.
  assert.equal(commitCard(made({ files: 1 }), NOW).detail, 'Note the run\n1 file changed');
  // The figures and the commit time travel through unchanged.
  assert.deepEqual([away.sha, away.added, away.removed, away.at], ['abc1234', 12, 1, NOW]);
});

test('a worktree named for its branch draws the branch alone, and the hover keeps the time', () => {
  const made = (over: Partial<TurnCommit> = {}): TurnCommit => ({
    sha: 'abc1234',
    subject: 'Note the run',
    files: 3,
    added: 12,
    removed: 1,
    at: NOW,
    place: null,
    dir: null,
    ...over,
  });
  const dir = 'C:/Users/dev/arc-worktrees/turn-card-density';
  // The worktree repeats the branch name, so the row says the branch once.
  const same = commitCard(
    made({ place: { kind: 'worktree', dir }, head: { kind: 'branch', name: 'turn-card-density' } }),
    NOW,
  );
  assert.equal(same.branch, 'turn-card-density');
  assert.equal(same.where, null);
  // A name that differs, a detached head and a repository of the same name all keep the place.
  const differs = commitCard(
    made({ place: { kind: 'worktree', dir }, head: { kind: 'branch', name: 'feat/turn-card-density' } }),
    NOW,
  );
  assert.equal(differs.where, 'in worktree turn-card-density');
  assert.equal(
    commitCard(made({ place: { kind: 'worktree', dir }, head: { kind: 'detached' } }), NOW).where,
    'in worktree turn-card-density',
  );
  assert.equal(
    commitCard(made({ place: { kind: 'named', dir }, head: { kind: 'branch', name: 'turn-card-density' } }), NOW).where,
    'in turn-card-density',
  );
  // Commit absolute time stays separate from detail text so clock wording does not change the card print.

  const lastWeek = NOW - 7 * 86_400_000;
  const old = commitCard(made({ at: lastWeek }), NOW);
  assert.equal(old.absolute, formatWhen(lastWeek, NOW));
  assert.match(old.absolute, /^[A-Z][a-z]{2} \d+ /);
  assert.equal(old.detail, 'Note the run\n3 files changed');
});

test('a landing row carries the branch it merged and the branch it moved', () => {
  const landed = (over: Partial<TurnLanding> = {}): TurnLanding => ({
    id: 'merge-1:landing-1',
    sha: '1ede4cb1',
    subject: 'Bundle the panel script from a TypeScript entry',
    from: 'panel-ts/ui-1',
    head: { kind: 'branch', name: 'main' },
    mergedBranch: 'panel-ts/ui-1',
    at: NOW,
    place: null,
    dir: 'C:/Users/dev/Projects/arc',
    ...over,
  });
  const card = landingCard(landed());
  assert.equal(card.sha, '1ede4cb1');
  assert.equal(card.kind, 'landing');
  assert.equal(card.subject, 'Bundle the panel script from a TypeScript entry');
  assert.equal(card.mergedBranch, 'panel-ts/ui-1');
  assert.equal(card.landingTarget, 'main');
  // A landing row groups under the branch whose head moved.
  assert.deepEqual([card.branch, card.headKind], ['main', 'branch']);
  assert.equal(card.detail, 'Bundle the panel script from a TypeScript entry');
  assert.equal(commitRowSpoken(card), `, merged into main ${card.absolute}`);
  assert.equal(
    commitRowTitle(card),
    `Bundle the panel script from a TypeScript entry\nMerged into main at ${card.absolute}, as 1ede4cb1, from panel-ts/ui-1.`,
  );
  const unexplained = landingCard(landed({ mergedBranch: null }));
  assert.equal(unexplained.mergedBranch, null);
  assert.match(commitRowTitle(unexplained), /as 1ede4cb1\. The record does not say which branch it came from\.$/);
  assert.doesNotMatch(commitRowTitle(card), /Committed/);
  // A landing changes no files, so it carries no counts.
  assert.deepEqual([card.added, card.removed], [null, null]);
  assert.equal(card.at, NOW);
  assert.equal(card.dir, 'C:/Users/dev/Projects/arc');
});

test('a landing reaches the card beside the commits, in the order it happened', () => {
  const one = turn({
    commits: [
      {
        sha: 'aaaa1111',
        subject: 'Write it',
        head: null,
        files: 1,
        added: 1,
        removed: 0,
        at: NOW - 60_000,
        place: null,
        dir: 'c:/repo',
      },
    ],
    landings: [
      {
        id: 'merge-1:landing-1',
        sha: 'bbbb2222',
        subject: 'Write it',
        from: 'topic',
        head: { kind: 'branch', name: 'main' },
        at: NOW - 30_000,
        place: null,
        dir: 'c:/repo',
      },
    ],
  });
  const card = toCard(one, false, NOW, ['c:/repo']);
  assert.deepEqual(
    card.commits.map((c) => c.kind),
    ['commit', 'landing'],
  );
  const chip = card.chips.find((c) => c.metric === 'commits');
  assert.equal(chip?.label, '1 commit · 1 merged', 'the landing is named beside the commit figure');
  assert.equal(
    card.chips.some((c) => c.metric === 'landings'),
    false,
    'the landing rides the commits chip rather than a chip of its own',
  );
  assert.deepEqual(
    chip?.detailList?.entries?.map((entry) => entry.value),
    ['Write it', 'merged into main'],
    'the popover lists both rows in the order they happened',
  );
  assert.notEqual(card.commits[0].key, card.commits[1].key);
});

test('a landing-only turn says it landed and claims no commit', () => {
  const card = toCard(
    turn({
      landings: [
        {
          id: 'merge-1:landing-1',
          sha: 'bbbb2222',
          subject: 'Write it',
          from: 'topic',
          head: { kind: 'branch', name: 'main' },
          at: NOW,
          place: null,
          dir: 'c:/repo',
        },
      ],
    }),
    false,
    NOW,
  );
  const chip = card.chips.find((c) => c.metric === 'commits');
  assert.equal(chip?.label, '1 merged', 'a turn that wrote no commit never says it wrote one');
  // One group, the branch that moved, so the heading names it beside the figure.
  assert.equal(chip?.detailList?.heading?.fact, '· on main');
  assert.equal(chip?.focusable, true);
  assert.equal(card.commits.filter((row) => row.kind === 'commit').length, 0);
  assert.equal(card.commits.filter((row) => row.kind === 'landing').length, 1);
});

test('a card names its file rows from the folders it was handed', () => {
  const files = [
    { path: 'c:/repo/src/store.ts', added: 3, removed: 1, isNew: false, edits: [] },
    { path: 'c:/Users/dev/AppData/Local/Temp/scratch/notes.md', added: 1, removed: 0, isNew: true, edits: [] },
  ];
  const held = toCard(turn({ files }), false, NOW, ['c:/repo']);
  assert.deepEqual(
    held.files.map((f) => f.name),
    ['store.ts', 'notes.md'],
  );
  // Separate directory and filename fields let only the directory shrink.

  assert.deepEqual(
    held.files.map((f) => f.lead),
    [undefined, 'c:/Users/dev/AppData/Local/Temp/scratch/'],
  );
  assert.deepEqual(
    held.files.map((f) => f.label),
    ['File store.ts', 'File c:/Users/dev/AppData/Local/Temp/scratch/notes.md, new'],
  );
  // The path is still what the row opens and what its hover carries, whichever name it drew.
  assert.deepEqual(
    held.files.map((f) => f.path),
    files.map((f) => f.path),
  );
  // Without folder context, every file row uses its basename.
  const bare = toCard(turn({ files }), false, NOW);
  assert.deepEqual(
    bare.files.map((f) => f.name),
    ['store.ts', 'notes.md'],
  );
  assert.deepEqual(
    bare.files.map((f) => f.lead),
    [undefined, undefined],
  );
  assert.deepEqual(
    bare.files.map((f) => f.label),
    ['File store.ts', 'File notes.md, new'],
  );
});

test('every file row leaves here with an icon on it, whatever the file is', () => {
  // Every file row carries a fallback icon label when the editor supplies no themed icon.

  const card = toCard(
    turn({
      files: [
        { path: 'c:/repo/src/store.ts', added: 1, removed: 0, isNew: false, edits: [] },
        { path: 'c:/repo/package.json', added: 1, removed: 0, isNew: false, edits: [] },
        { path: 'c:/repo/odd.qqzz', added: 1, removed: 0, isNew: true, edits: [] },
        { path: 'c:/repo/Makefile', added: 1, removed: 0, isNew: false, edits: [] },
      ],
    }),
    false,
    NOW,
  );
  for (const file of card.files) {
    assert.ok(file.icon && file.icon.label, `${file.path} has nothing to draw in its icon column`);
  }
  // The card leaves themed glyph and image fields unset.
  assert.ok(
    card.files.every((f) => !f.icon.glyph && !f.icon.image),
    'a card is resolving the reader icon theme, which needs the editor and cannot be tested here',
  );
});

test('a head row is announced by everything it shows, since its glyph says nothing', () => {
  const card = toCard(
    turn({
      summary: 'Fixed the parser.',
      effort: 'xhigh',
      files: [{ path: 'c:/repo/a.ts', added: 1, removed: 0, isNew: false, edits: [] }],
    }),
    false,
    NOW,
  );
  // The latest activity and duration are visible. The start time follows them in the name
  // because the duration hover reveals it to a reader who can see.
  assert.equal(
    card.label,
    'Turn, finished, 5 hours ago, ran in 12m, started 2:32 PM, Claude opus-5 xhigh. Fixed the parser.',
  );
  // Accessible card names include status words independently of visible color.

  const failed = toCard(turn({ error: 'Overloaded.' }), false, NOW);
  assert.match(failed.label, /^Turn, failed, /);
  const running = toCard(turn({ finished: false, endedAt: NOW - 60_000 }), true, NOW);
  assert.match(running.label, /^Turn, running, /);
  // A model with nothing to say about it leaves no empty gap in the middle of the name.
  const bare = toCard(turn({ model: null, summary: 'Done.' }), false, NOW);
  // Every turn card name includes its agent even when the model is absent.
  assert.equal(bare.label, 'Turn, finished, 5 hours ago, ran in 12m, started 2:32 PM, Claude. Done.');
  assert.match(toCompactionCard(compaction(), NOW).label, /^Compaction, 4 hours ago, ran in 2m\. Compacted by hand\./);
});

test('the duration phrase matches the turn status', () => {
  // Running turns use present-tense duration wording.

  assert.equal(durationWord('running'), CARD_ACTIONS.runningFor);
  for (const status of ['done', 'failed', 'interrupted', 'stopped'] as const) {
    assert.equal(
      durationWord(status),
      CARD_ACTIONS.ranFor,
      `a ${status} turn has ended, so its duration takes the past tense`,
    );
  }
  // The card's accessible name uses its duration word.

  const running = toCard(turn({ finished: false, endedAt: NOW - 60_000 }), true, NOW);
  assert.equal(running.durationWord, CARD_ACTIONS.runningFor);
  assert.match(running.label, /running, 1 min ago, running for 5h 28m, started 2:32 PM,/);
  const done = toCard(turn({}), false, NOW);
  assert.equal(done.durationWord, CARD_ACTIONS.ranFor);
  assert.match(done.label, /finished, 5 hours ago, ran in 12m, started 2:32 PM,/);
  // Stopped unfinished turns use past-tense duration wording.

  const stopped = toCard(turn({ finished: false }), false, NOW);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.durationWord, CARD_ACTIONS.ranFor);
});

test('a file row says which file it opens, and whether the turn created it', () => {
  const card = toCard(
    turn({
      files: [
        { path: 'c:/repo/src/index.ts', added: 1, removed: 0, isNew: false, edits: [] },
        { path: 'c:/repo/docs/index.ts', added: 2, removed: 0, isNew: true, edits: [] },
      ],
    }),
    false,
    NOW,
  );
  // Visible rows retain basenames while accessible names distinguish their directories.
  assert.deepEqual(
    card.files.map((f) => f.name),
    ['index.ts', 'index.ts'],
  );
  assert.deepEqual(
    card.files.map((f) => f.label),
    ['File src/index.ts', 'File docs/index.ts, new'],
  );
});

test('a turn waiting on the reader draws no chip for it, and its marks still say so', () => {
  // Closing action and question rows add marks without adding figures.

  const both = closingCard([
    '- 🙋 **Your actions** — reload the window and confirm.',
    '- ❓ **Open questions / follow-ups** — (1) keep the store? (2) rename the view?',
  ]);
  assert.ok(
    !both.labels.some((l) => /needs you|waiting|question/i.test(l)),
    'a chip is worded as something the reader has to answer',
  );
  // Reader-action marks do not change figure kinds.

  assert.deepEqual(
    [...new Set(both.kinds)],
    ['plain'],
    'a chip on a turn that is waiting is drawn in a tone of its own again',
  );
  assert.deepEqual(both.marks, ['needsYou', 'question']);
  // Each nonempty closing row adds its own mark. Explicit negations add neither mark.

  assert.deepEqual(closingCard(['- 🙋 **Your actions** — reload the window.']).marks, ['needsYou']);
  assert.deepEqual(closingCard(['- ❓ **Open questions** — whether to keep the store.']).marks, ['question']);
  assert.deepEqual(closingCard(['- 🙋 **Your actions** — none.']).marks, []);
});

test('a session total is worked out over the turns read, and says so', () => {
  // Two turns each use 100k input at $5 per million and 20k output at $25 per million, totaling $2.00.

  const usage = { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 };
  const chips = sessionStats(
    [turn({ usage, startedAt: 1_000, endedAt: 2_000 }), turn({ usage, startedAt: 3_000, endedAt: 4_000 })],
    [],
  );
  const cost = statOf(chips, '$');
  assert.equal(cost?.label, '$2.00');
  // No trailing mark, because every turn was priced.
  assert.match(cost!.detail, /Over the 2 turns read, not the whole session\./);
});

test('session figures carry stable identities and compact rail faces', () => {
  const usage = { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 };
  const commit = { sha: 'abc1234', subject: 'x', files: 1, added: 1, removed: 0, at: 0, place: null, dir: null };
  const chips = sessionStats(
    [
      turn({
        usage,
        contextTokens: 620_000,
        contextWindow: 1_000_000,
        files: [{ path: '/w/a.ts', added: 4, removed: 1, isNew: false, edits: [] }],
        commits: [commit],
      }),
    ],
    [],
  );

  assert.deepEqual(
    chips.map((chip) => chip.metric),
    ['cost', 'context', 'files', 'commits'],
  );
  assert.equal(chips.find((chip) => chip.metric === 'cost')?.compactLabel, '$1.00');
  const context = chips.find((chip) => chip.metric === 'context');
  assert.equal(context?.compactLabel, '62% ctx');
  assert.equal(context?.label, '62% of 1M ctx (620k)', 'the session heading label changed with the rail face');

  const autoReview = sessionStats(
    [
      turn({
        model: 'codex-auto-review',
        usage,
        contextTokens: 140_000,
        contextWindow: 1_000_000,
      }),
    ],
    [],
  );
  assert.deepEqual(
    autoReview.map((chip) => chip.metric),
    ['cost', 'context'],
  );
  assert.equal(autoReview[0].compactLabel, '$0.55');
  assert.equal(autoReview[1].compactLabel, '14% ctx');
});

test('a fast Opus 5.5 session prices its card, its session figures and its cached reads at the fast rate', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const prompt = (id: string, second: number) => ({
    type: 'user',
    promptId: id,
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'text', text: 'Price this.' }] },
  });
  const reply = (id: string, second: number, usage: Record<string, number>) => ({
    type: 'assistant',
    timestamp: at(second),
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }],
      usage: { output_tokens: 0, ...usage, service_tier: 'standard', speed: 'fast' },
    },
  });
  const file = path.join(tempDir('fast-card-'), 'sess.jsonl');
  fs.writeFileSync(
    file,
    [
      prompt('p1', 0),
      reply('m1', 1, { input_tokens: 1_000_000 }),
      prompt('p2', 2),
      reply('m2', 3, { input_tokens: 0, cache_read_input_tokens: 1_000_000 }),
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  const read = readSession(file, 'sess');
  const card = toCard(read.turns[0], false, NOW);
  assert.equal(
    card.chips.find((chip) => chip.metric === 'cost')?.label,
    '$8.00',
    'the card priced a fast turn at the standard rate',
  );
  const figures = {
    parsed: sessionStats(read.turns, read.compactions),
    indexed: sessionStatsFromFacts(sessionStatFactsOf(read)),
  };
  for (const [scope, chips] of Object.entries(figures)) {
    assert.equal(chips.find((chip) => chip.metric === 'cost')?.compactLabel, '$8.40', `${scope} session cost`);
    assert.match(
      chips.find((chip) => chip.metric === 'context')?.detail ?? '',
      /Latest turn cached input reads: \$0\.40\n/,
      `${scope} cached reads`,
    );
  }
});

test('metadata facts produce only rail cost and context, with missing child spend marked', () => {
  const facts: SessionStatFacts = {
    turns: [
      {
        startedAt: 1_000,
        endedAt: 2_000,
        finished: true,
        error: false,
        model: 'claude-opus-5',
        provider: null,
        usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
        contextTokens: 620_000,
        contextWindow: 1_000_000,
        childSpendPartial: true,
      },
    ],
    compactions: [],
  };
  const chips = sessionStatsFromFacts(facts);
  assert.deepEqual(
    chips.map((chip) => chip.metric),
    ['cost', 'context'],
  );
  assert.equal(chips[0].compactLabel, '$1.00+', 'the metadata pass does not read child transcripts');
  assert.equal(chips[1].compactLabel, '62% ctx');
  assert.deepEqual(sessionStatsFromFacts(null), []);
});

test('indexed lifetime cost prices Auto Review and names every remaining unpriced identity', () => {
  const priced = {
    agent: 'claude',
    role: 'main' as const,
    model: 'claude-opus-5',
    provider: null,
    contextWindow: 1_000_000,
    usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
  };
  const autoReview = {
    agent: 'codex',
    role: 'delegated' as const,
    model: 'codex-auto-review',
    provider: 'openai',
    contextWindow: null,
    usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 },
  };
  const autoReviewWithoutProvider = { ...autoReview, provider: null };
  const unfamiliar = {
    agent: 'codex',
    role: 'delegated' as const,
    model: 'unlisted-model-v7',
    provider: 'private-gateway',
    contextWindow: null,
    usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 },
  };
  const chips = sessionCostStats([priced, autoReview, autoReviewWithoutProvider, autoReview, unfamiliar]);
  assert.equal(chips.length, 1);
  assert.equal(chips[0].metric, 'cost');
  assert.equal(chips[0].compactLabel, '$1.00+');
  assert.match(chips[0].detail, /Codex Auto Review: <\$0\.01/);
  assert.match(
    chips[0].detail,
    /Codex · unlisted-model-v7 · private-gateway: cost unavailable\n  Reliable list-price estimate unavailable\./,
  );
  assert.equal(
    chips[0].detailList?.entries.filter((entry) => entry.label === 'Codex Auto Review').length,
    1,
    'provider variants and repeated usage from Auto Review remain one detail entry',
  );
  assert.match(chips[0].detail, /Some usage could not be priced, so the estimated total may be low\./);
  assert.match(chips[0].detail, /Includes the main session and delegated work\./);
  assert.match(chips[0].detail, /Estimated from published model rates\. Your actual charge may differ\./);
  assert.equal(
    chips[0].partialDetail,
    'Cost unavailable for Codex · unlisted-model-v7 · private-gateway: reliable list-price estimate unavailable. Some usage could not be priced, so the estimated total may be low.',
  );
  assert.deepEqual(chips[0].detailList?.heading, { label: 'Estimated total', value: '$1.00+' });
  assert.deepEqual(
    chips[0].detailList?.entries[0].lines?.slice(0, 3),
    costLines('Output: $0.50', 'Cached input reads: $0 (0% cached)', 'Uncached input: $0.50'),
    'the partial detail omits the categories that make up its known amount',
  );
});

test('indexed lifetime cost names the main agent model in its detail', () => {
  const chip = sessionCostStats([
    {
      agent: 'codex',
      role: 'main',
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      usage: {
        requests: 1,
        input: 100_000,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheRead: 0,
        output: 10_000,
        thinking: 0,
      },
    },
  ])[0];

  assert.equal(chip.detailList?.entries[0].label, 'Cost by usage · gpt-5.5');
});

test('indexed lifetime cost rolls every priced bucket into one ordered usage breakdown', () => {
  const chip = sessionCostStats([
    {
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      contextBand: 'short',
      usage: {
        requests: 1,
        input: 100_000,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheRead: 1_000_000,
        output: 10_000,
        thinking: 0,
      },
    },
    {
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      contextBand: 'long',
      usage: {
        requests: 1,
        input: 100_000,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheRead: 1_000_000,
        output: 10_000,
        thinking: 0,
      },
    },
    {
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      usage: {
        requests: 1,
        input: 0,
        cacheWrite1h: 100_000,
        cacheWrite5m: 100_000,
        cacheRead: 0,
        output: 10_000,
        thinking: 0,
      },
    },
    {
      model: 'gpt-5.6',
      provider: 'openai',
      contextWindow: 272_000,
      contextBand: 'short',
      usage: {
        requests: 1,
        input: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 100_000,
        cacheRead: 0,
        output: 0,
        thinking: 0,
      },
    },
  ])[0];
  const lineTexts = [
    'Output: $1.00',
    'Cached input reads: $1.50 (80% cached · 4 requests · 625k avg input)',
    'Uncached input: $1.50',
    '1-hour cache writes: $1.00',
    '5-minute cache writes: $0.63',
    '30-minute cache writes: $0.50',
  ];
  assert.equal(chip.compactLabel, '$6.13');
  assert.deepEqual(flatForm(chip.detailList), {
    heading: { label: 'Estimated total', value: '$6.13' },
    entries: [{ label: 'Cost by usage · gpt-5.5, opus-5, gpt-5.6', lines: costLines(...lineTexts) }],
    footer: [],
    notes: [
      CACHED_INPUT_READ_EXPLANATION,
      'Includes the main session and delegated work.',
      'Estimated from published model rates. Your actual charge may differ.',
    ],
  });
  assert.equal(
    chip.detail,
    [
      'Estimated total: $6.13',
      '',
      'Cost by usage · gpt-5.5, opus-5, gpt-5.6',
      ...lineTexts.map((line) => `  ${line}`),
      CACHED_INPUT_READ_EXPLANATION,
      'Includes the main session and delegated work.',
      'Estimated from published model rates. Your actual charge may differ.',
    ].join('\n'),
    'the rail hover and selected-heading detail were built from different content',
  );
  assert.equal(
    chip.detail.split(CACHED_INPUT_READ_EXPLANATION).length - 1,
    1,
    'the flat rail hover includes the explanation once',
  );
  assert.equal(
    chip.detailList?.notes?.filter((line) => line === CACHED_INPUT_READ_EXPLANATION).length,
    1,
    'the structured selected-heading detail includes the explanation once',
  );
});

test('indexed lifetime cost separates the main agent from rolled-up delegated work', () => {
  const usage = { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 };
  const chip = sessionCostStats([
    {
      agent: 'claude',
      role: 'main',
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      usage: { ...usage, input: 100_000, output: 20_000 },
    },
    {
      agent: 'codex',
      role: 'main',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      contextWindow: 1_000_000,
      serviceTier: 'priority',
      usage,
    },
    {
      agent: 'claude',
      role: 'delegated',
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      recordedCost: 2.5,
      costBasis: 'list',
      usage,
    },
    {
      agent: 'codex',
      role: 'delegated',
      model: 'codex-auto-review',
      provider: 'openai',
      contextWindow: null,
      usage,
    },
  ])[0];

  assert.equal(chip.compactLabel, '$3.50+');
  assert.deepEqual(flatForm(chip.detailList), {
    heading: { label: 'Estimated total', value: '$3.50+' },
    entries: [
      {
        label: 'Main agent · opus-5',
        value: '$1.00',
        lines: costLines('Output: $0.50', 'Cached input reads: $0 (0% cached)', 'Uncached input: $0.50'),
      },
      {
        label: 'Main agent · gpt-5.6-sol',
        value: 'cost unavailable',
        lines: ['Priority service-tier price unavailable.'],
      },
      {
        label: 'Claude · opus-5',
        value: '$2.50',
        lines: ['Some recorded cost cannot be split by usage.'],
      },
      {
        label: 'Codex Auto Review',
        value: '<$0.01',
        lines: costLines('Output: <$0.01', 'Cached input reads: $0 (0% cached)', 'Uncached input: <$0.01'),
      },
    ],
    footer: ['Some usage could not be priced, so the estimated total may be low.'],
    notes: [
      'Codex Auto Review uses the OpenAI Codex rate card.',
      'Includes the main session and delegated work.',
      'Estimated from published model rates. Your actual charge may differ.',
    ],
  });
  assert.doesNotMatch(
    chip.detail,
    /provider "|model "/,
    'pricing identities returned to diagnostic grammar instead of readable names',
  );
});

test('indexed lifetime cost prices aggregated Auto Review volume without changing token scope', () => {
  const firstReview = {
    requests: 1,
    input: 1_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 300,
    cacheRead: 2_000,
    output: 400,
    thinking: 100,
  };
  const secondReview = {
    requests: 2,
    input: 4_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 700,
    cacheRead: 6_000,
    output: 1_600,
    thinking: 300,
  };
  const chip = sessionCostStats([
    {
      agent: 'claude',
      role: 'main',
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      usage: {
        requests: 1,
        input: 100_000,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheRead: 0,
        output: 20_000,
        thinking: 0,
      },
    },
    {
      agent: 'claude',
      role: 'delegated',
      model: 'claude-haiku-4-5',
      provider: null,
      contextWindow: 1_000_000,
      recordedCost: 2.5,
      costBasis: 'list',
      usage: { requests: 1, input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 },
    },
    {
      agent: 'codex',
      role: 'delegated',
      model: 'codex-auto-review',
      provider: 'openai',
      contextWindow: null,
      usage: firstReview,
    },
    {
      agent: 'codex',
      role: 'delegated',
      model: 'codex-auto-review',
      provider: null,
      contextWindow: null,
      usage: secondReview,
    },
  ])[0];

  assert.equal(chip.compactLabel, '$3.54');
  assert.deepEqual(chip.detailList?.entries, [
    {
      label: 'Main agent · opus-5',
      value: '$1.00',
      lines: costLines(
        'Output: $0.50',
        'Cached input reads: $0 (0% cached · 1 request · 100k avg input)',
        'Uncached input: $0.50',
      ),
    },
    {
      label: 'Claude · haiku-4-5',
      value: '$2.50',
      lines: ['Some recorded cost cannot be split by usage.'],
    },
    {
      label: 'Codex Auto Review',
      value: '$0.04',
      lines: costLines(
        'Output: $0.03',
        'Cached input reads: <$0.01 (57% cached · 3 requests · 4,667 avg input)',
        'Uncached input: $0.01',
      ),
    },
  ]);
  assert.equal(chip.detailList?.entries.filter((entry) => entry.label === 'Codex Auto Review').length, 1);
  assert.equal(chip.partialDetail, undefined);
  assert.match(chip.detail, /Codex Auto Review uses the OpenAI Codex rate card\./);
  assert.match(chip.detail, /Estimated from published model rates\. Your actual charge may differ\./);
  assert.doesNotMatch(chip.detail, /1-hour cache writes|5-minute cache writes|\b0 tokens\b/);

  const parent = turn({
    usage: {
      requests: 1,
      input: 1_000,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheRead: 1_000,
      output: 200,
      thinking: 50,
    },
    agents: [
      agent({
        description: 'Codex Auto Review',
        model: 'codex-auto-review',
        spendFound: true,
        spend: [
          { model: 'codex-auto-review', provider: 'openai', usage: firstReview },
          { model: 'codex-auto-review', provider: 'openai', usage: secondReview },
        ],
      }),
    ],
  });
  const card = toCard(parent, false, NOW);
  assert.equal(card.chips.find((held) => held.label.includes(' in'))?.label, '2k in · 200 out');
  const wholeReview = chip.detailList?.entries.find((entry) => entry.label === 'Codex Auto Review');
  const turnReview = card.chips
    .find((held) => held.label.startsWith('$'))
    ?.detailList?.entries.find((entry) => entry.label.includes('Auto Review'));
  assert.deepEqual(turnReview, wholeReview, 'turn and whole-session cost detail share the Auto Review entry formatter');
  assert.deepEqual(tokenLines(parent), [
    'Main agent only',
    'Input: 2,000 tokens',
    'Output: 200 tokens',
    '  Thinking: 50 tokens (25% of output), included in output',
    'Model requests: 1',
    '',
    'Input breakdown',
    '  Cached input reads: 1,000 tokens (50% of input)',
    '  Uncached input: 1,000 tokens',
  ]);
  assert.deepEqual(card.agents, [
    {
      description: 'Codex Auto Review',
      model: 'codex-auto-review',
      effort: null,
      state: 'done',
      stateWord: '',
      since: null,
      // Auto Review spend parts combine under one cost-by-usage heading.

      figures: [
        {
          metric: 'cost',
          compactLabel: '$0.04',
          name: '$0.04 spent',
          record: {
            heading: { label: '$0.04 spent' },
            entries: [
              {
                label: 'Cost by usage · Codex Auto Review',
                value: '$0.04',
                lines: costLines(
                  'Output: $0.03',
                  'Cached input reads: <$0.01 (57% cached · 3 requests · 4,667 avg input)',
                  'Uncached input: $0.01',
                ),
              },
              { label: 'Input', separateBefore: true, value: '14k tokens' },
              {
                label: 'Output',
                value: '2,000 tokens',
                lines: ['Thinking: 400 tokens (20% of output), included in output'],
              },
              { label: 'Model requests', value: '3', lines: ['Average input per request: 4,667 tokens'] },
              {
                label: 'Input breakdown',
                separateBefore: true,
                lines: [
                  'Cached input reads: 8,000 tokens (57% of input)',
                  'Uncached input: 5,000 tokens',
                  '30-minute cache writes: 1,000 tokens',
                ],
              },
            ],
          },
          detail: [
            '$0.04 spent',
            '',
            'Cost by usage · Codex Auto Review: $0.04',
            '  Output: $0.03',
            '  Cached input reads: <$0.01 (57% cached · 3 requests · 4,667 avg input)',
            '  Uncached input: $0.01',
            '',
            'Input: 14k tokens',
            'Output: 2,000 tokens',
            '  Thinking: 400 tokens (20% of output), included in output',
            'Model requests: 3',
            '  Average input per request: 4,667 tokens',
            '',
            'Input breakdown',
            '  Cached input reads: 8,000 tokens (57% of input)',
            '  Uncached input: 5,000 tokens',
            '  30-minute cache writes: 1,000 tokens',
          ].join('\n'),
        },
      ],
      hintDetail: '',
      sessionId: null,
    },
  ]);
  assert.deepEqual(card.chips.find((held) => held.label === '1 subagent')?.detailList, {
    layout: 'agents',
    actions: true,
    heading: { label: '1 subagent in this turn' },
    entries: [
      {
        label: 'Codex Auto Review',
        lines: ['codex-auto-review · 3 requests · 14k in · 2k out'],
      },
    ],
  });
  assert.doesNotMatch(
    card.chips.find((held) => held.label === '1 subagent')?.detail ?? '',
    /billed usage|cost unavailable/,
  );
  assert.match(
    card.chips.find((held) => held.metric === 'cost')?.detail ?? '',
    /Codex Auto Review uses the OpenAI Codex rate card\./,
  );
});

test('lifetime cost rolls dated and undated model ids into their shared displayed identity', () => {
  const usage = { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 };
  const chip = sessionCostStats([
    {
      agent: 'claude',
      role: 'main',
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      recordedCost: 1,
      costBasis: 'list',
      usage,
    },
    {
      agent: 'claude',
      role: 'delegated',
      model: 'claude-haiku-4-5',
      provider: null,
      contextWindow: 1_000_000,
      recordedCost: 2,
      costBasis: 'list',
      usage,
    },
    {
      agent: 'claude',
      role: 'delegated',
      model: 'claude-haiku-4-5-20251001',
      provider: null,
      contextWindow: 1_000_000,
      recordedCost: 3,
      costBasis: 'list',
      usage,
    },
  ])[0];

  assert.equal(chip.detailList?.entries[0].label, 'Main agent · opus-5');
  assert.deepEqual(chip.detailList?.entries[1].lines, [
    {
      text: 'Claude · haiku-4-5: $5.00',
      cacheHit: { percent: 0, warning: false },
    },
  ]);

  const unpriced = sessionCostStats([
    {
      agent: 'claude',
      role: 'main',
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      recordedCost: 1,
      costBasis: 'list',
      usage,
    },
    { agent: 'claude', model: 'unlisted-model', provider: null, contextWindow: null, usage },
    { agent: 'claude', model: 'unlisted-model-20251001', provider: null, contextWindow: null, usage },
  ])[0];
  assert.equal(
    unpriced.partialDetail,
    'Cost unavailable for Claude · unlisted-model: reliable list-price estimate unavailable. Some usage could not be priced, so the estimated total may be low.',
  );
});

test('indexed lifetime cost includes Auto Review in the exact rail total', () => {
  const usage = { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 };
  const chip = sessionCostStats([
    {
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      usage: { ...usage, input: 100_000, output: 20_000 },
    },
    { model: 'codex-auto-review', provider: null, contextWindow: null, usage },
  ])[0];
  assert.equal(chip.compactLabel, '$1.00');
  assert.equal(chip.partialDetail, undefined);
});

test('Codex Auto Review keeps a recorded third-party provider visible', () => {
  const usage = { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 };
  const detail = sessionCostStats([
    {
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      usage: { ...usage, input: 100_000, output: 20_000 },
    },
    { model: 'codex-auto-review', provider: 'private-gateway', contextWindow: null, usage },
  ])[0].detail;
  assert.match(
    detail,
    /Cost unavailable for Codex Auto Review · private-gateway: reliable list-price estimate unavailable\./,
  );
  assert.doesNotMatch(detail, /OpenAI Codex rate card/);
});

test('Auto Review rate detail excludes third-party and recorded amounts', () => {
  const usage = {
    requests: 1,
    input: 1_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 0,
    output: 100,
    thinking: 20,
  };
  const publicSpend = { model: 'codex-auto-review', provider: 'openai', usage };
  const privateSpend = { model: 'codex-auto-review', provider: 'private-gateway', usage };
  const recordedSpend = { ...publicSpend, recordedCost: 0.25, costBasis: 'list' };
  const detailFor = (spend: TurnAgent['spend'][number]) =>
    costDetail(
      turn({
        agents: [agent({ description: 'Codex Auto Review', spendFound: true, spend: [spend] })],
      }),
    ).join('\n');

  assert.match(detailFor(publicSpend), /Codex Auto Review uses the OpenAI Codex rate card\./);
  assert.doesNotMatch(detailFor(privateSpend), /OpenAI Codex rate card/);
  const recordedTurn = detailFor(recordedSpend);
  assert.match(recordedTurn, /^  Total recorded by Claude CLI at list price$/m);
  assert.doesNotMatch(recordedTurn, /OpenAI Codex rate card/);

  const recordedLifetime = sessionCostStats([
    {
      agent: 'codex',
      role: 'delegated',
      model: 'codex-auto-review',
      provider: 'openai',
      contextWindow: null,
      usage,
      recordedCost: 0.25,
      costBasis: 'list',
    },
  ])[0];
  assert.equal(recordedLifetime.compactLabel, '$0.25');
  assert.match(recordedLifetime.detail, /^  Total recorded by Claude CLI at list price$/m);
  assert.doesNotMatch(recordedLifetime.detail, /OpenAI Codex rate card/);
});

test('a child whose whole spend is the Auto Review heads its block with the review once', () => {
  const usage = {
    requests: 1,
    input: 1_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 0,
    output: 100,
    thinking: 20,
  };
  // `Background review` is the description a Codex background review child carries into a card.
  const review = { model: 'codex-auto-review', provider: 'private-gateway', usage };
  const reviewOnly = costDetail(
    turn({
      agents: [agent({ description: 'Background review', spendFound: true, spend: [review] })],
    }),
  ).join('\n');
  assert.match(
    reviewOnly,
    /^Codex Auto Review · private-gateway: /m,
    'a child that billed only the review names the review once',
  );
  assert.doesNotMatch(reviewOnly, /Background review · Codex Auto Review/);

  const alsoBilledModelWork = costDetail(
    turn({
      agents: [
        agent({
          description: 'Background review',
          spendFound: true,
          spend: [{ model: 'gpt-5.4-codex', provider: 'openai', usage }, review],
        }),
      ],
    }),
  ).join('\n');
  assert.match(
    alsoBilledModelWork,
    /^Background review · Codex Auto Review · private-gateway: /m,
    'a child that billed work beyond the review keeps its description over the review block',
  );
});

test('indexed lifetime cost leaves an unfamiliar single identity exact and omits all-unpriced totals', () => {
  const priced = {
    model: 'claude-opus-5',
    provider: null,
    contextWindow: 1_000_000,
    usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
  };
  const unknown = {
    model: 'unlisted-model-v7',
    provider: 'private-gateway',
    contextWindow: null,
    usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 },
  };
  const mixed = sessionCostStats([priced, unknown]);
  assert.match(
    mixed[0].detail,
    /Cost unavailable for unlisted-model-v7 · private-gateway: reliable list-price estimate unavailable\./,
  );
  assert.match(mixed[0].detail, /Some usage could not be priced, so the estimated total may be low\./);
  assert.deepEqual(sessionCostStats([unknown]), []);
  assert.deepEqual(sessionCostStats([]), []);
});

test('indexed lifetime usage prices each retained request band', () => {
  const chips = sessionCostStats([
    {
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      contextBand: 'short',
      usage: { requests: 2, input: 300_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    },
    {
      model: 'gpt-5.5',
      provider: 'openai',
      contextWindow: 1_050_000,
      contextBand: 'long',
      usage: { requests: 1, input: 300_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    },
  ]);
  assert.equal(chips[0].compactLabel, '$4.50');
  assert.doesNotMatch(chips[0].detail, /estimated total may be low/);
});

test('indexed lifetime cost prices OpenAI default-tier usage at the standard public rate', () => {
  const chip = sessionCostStats([
    {
      agent: 'codex',
      role: 'main',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      contextWindow: 272_000,
      contextBand: 'short',
      serviceTier: 'default',
      usage: { requests: 1, input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    },
  ])[0];
  assert.equal(chip.compactLabel, '$4.00');
  assert.deepEqual(
    chip.detailList?.entries[0].lines,
    costLines('Cached input reads: $0 (0% cached · 1 request · 1M avg input)', 'Uncached input: $4.00'),
  );
  assert.doesNotMatch(chip.detail, /cost unavailable|estimated total may be low/i);
});

test('indexed lifetime cost prices Bedrock default-tier usage at its standard rate', () => {
  const chip = sessionCostStats([
    {
      agent: 'codex',
      role: 'main',
      model: 'openai.gpt-5.6-sol',
      provider: 'amazon-bedrock',
      contextWindow: 258_400,
      contextBand: 'short',
      serviceTier: 'default',
      usage: { requests: 1, input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    },
  ])[0];
  assert.equal(chip.compactLabel, '$4.40');
  assert.deepEqual(
    chip.detailList?.entries[0].lines,
    costLines('Cached input reads: $0 (0% cached · 1 request · 1M avg input)', 'Uncached input: $4.40'),
  );
  assert.doesNotMatch(chip.detail, /default service-tier price unavailable|estimated total may be low/i);
});

test('indexed lifetime cost explains an unavailable tier beside priced usage from the same model', () => {
  const part = {
    agent: 'codex',
    role: 'main' as const,
    model: 'gpt-5.6-sol',
    provider: 'openai',
    contextWindow: 272_000,
    contextBand: 'short' as const,
    usage: { requests: 1, input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
  };
  const chip = sessionCostStats([
    { ...part, serviceTier: 'default' },
    { ...part, serviceTier: 'priority' },
  ])[0];
  assert.equal(chip.compactLabel, '$4.00+');
  assert.deepEqual(chip.detailList?.entries[0].lines, [
    ...costLines('Uncached input: $4.00'),
    'Cost unavailable for Codex · gpt-5.6-sol · OpenAI: priority service-tier price unavailable.',
  ]);
});

test('indexed lifetime cost prices a fast-mode turn at the fast rate where the model publishes one', () => {
  const part = {
    agent: 'claude',
    role: 'main' as const,
    model: 'claude-opus-5-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    usage: { requests: 1, input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
  };
  const chip = sessionCostStats([
    { ...part, serviceTier: 'standard' },
    { ...part, serviceTier: 'fast' },
  ])[0];
  assert.match(chip.detail, /^Estimated total: \$12\n/);
  assert.doesNotMatch(chip.detail, /Cost unavailable/);
});

test('indexed lifetime cost words a fast-mode turn for the speed the reader chose, not a service tier', () => {
  const part = {
    agent: 'claude',
    role: 'main' as const,
    model: 'claude-opus-4-7',
    provider: null,
    contextWindow: null,
    contextBand: null,
    usage: { requests: 1, input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
  };
  const chip = sessionCostStats([
    { ...part, serviceTier: 'standard' },
    { ...part, serviceTier: 'fast' },
  ])[0];
  assert.match(chip.detail, /Cost unavailable for [^:]+: fast-mode price unavailable\./);
  assert.doesNotMatch(chip.detail, /fast service-tier price unavailable/);
});

test('indexed lifetime cost prices inference classes and rejects unsupported service tiers', () => {
  const chip = sessionCostStats([
    {
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      inferenceClass: null,
      serviceTier: null,
      usage: { requests: 1, input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    },
    {
      model: 'claude-sonnet-4-6',
      provider: null,
      contextWindow: 1_000_000,
      inferenceClass: 'in-region',
      serviceTier: 'standard',
      usage: { requests: 1, input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    },
    {
      model: 'claude-sonnet-4-6',
      provider: null,
      contextWindow: 1_000_000,
      inferenceClass: 'in-region',
      serviceTier: 'priority',
      usage: { requests: 1, input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    },
  ])[0];
  assert.equal(chip.compactLabel, '$3.80+');
  assert.deepEqual(chip.detailList?.entries[0].lines?.[0], costLines('Uncached input: $3.80')[0]);
  assert.match(
    chip.detail,
    /Cost unavailable for sonnet-4-6 · provider not recorded: priority service-tier price unavailable\./,
  );
});

test('indexed lifetime cost does not call an indeterminate published tier an absent rate', () => {
  const priced = {
    model: 'claude-opus-5',
    provider: null,
    contextWindow: 1_000_000,
    usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
  };
  const indeterminateTier = {
    model: 'openai.gpt-5.6-sol',
    provider: 'amazon-bedrock',
    contextWindow: 1_000_000,
    usage: { requests: 2, input: 300_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 },
  };
  const detail = sessionCostStats([priced, indeterminateTier])[0].detail;
  assert.match(
    detail,
    /Cost unavailable for openai\.gpt-5\.6-sol · Amazon Bedrock: reliable list-price estimate unavailable\./,
  );
  assert.match(detail, /Some usage could not be priced, so the estimated total may be low/);
});

test('indexed lifetime cost keeps structured identities distinct before display', () => {
  const priced = {
    model: 'claude-opus-5',
    provider: null,
    contextWindow: 1_000_000,
    usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
  };
  const usage = { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 };
  const detail = sessionCostStats([
    priced,
    { model: 'west / model', provider: 'acme', contextWindow: null, usage },
    { model: 'model', provider: 'acme / west', contextWindow: null, usage },
  ])[0].detail;
  assert.match(detail, /Cost unavailable for west \/ model · acme: reliable list-price estimate unavailable\./);
  assert.match(detail, /Cost unavailable for model · acme \/ west: reliable list-price estimate unavailable\./);
});

test('indexed lifetime cost distinguishes a missing model from a recorded unknown model', () => {
  const priced = {
    model: 'claude-opus-5',
    provider: null,
    contextWindow: 1_000_000,
    usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
  };
  const usage = { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 };
  const detail = sessionCostStats([
    priced,
    { model: null, provider: null, contextWindow: null, usage },
    { model: 'unlisted-without-provider', provider: null, contextWindow: null, usage },
    { model: null, provider: 'x', contextWindow: null, usage },
    { model: 'unknown', provider: 'x', contextWindow: null, usage },
  ])[0].detail;
  assert.match(
    detail,
    /Cost unavailable for Model and provider not recorded: reliable list-price estimate unavailable\./,
  );
  assert.match(
    detail,
    /Cost unavailable for unlisted-without-provider · provider not recorded: reliable list-price estimate unavailable\./,
  );
  assert.match(detail, /Cost unavailable for model not recorded · x: reliable list-price estimate unavailable\./);
  assert.match(detail, /Cost unavailable for unknown · x: reliable list-price estimate unavailable\./);
});

test('indexed lifetime cost keeps an exact fully-priced total unchanged', () => {
  const chips = sessionCostStats([
    {
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
    },
  ]);
  assert.equal(chips[0].compactLabel, '$1.00');
  assert.equal(chips[0].detailList?.heading?.label, 'Estimated total');
  assert.deepEqual(
    chips[0].detailList?.entries[0].lines,
    costLines('Output: $0.50', 'Cached input reads: $0 (0% cached)', 'Uncached input: $0.50'),
    'zero lifetime categories were not omitted',
  );
  assert.doesNotMatch(
    chips[0].detail,
    new RegExp(CACHED_INPUT_READ_EXPLANATION),
    'a lifetime detail with no priced cached input category gets no cache explanation',
  );
});

const turnStats = (turnCount: number, extra: Partial<SessionTurnStats> = {}): SessionTurnStats => ({
  turnCount,
  compactionCount: null,
  firstTurnAt: null,
  lastTurnAt: null,
  ...extra,
});

test('an indexed primary transcript produces a whole-session turn chip', () => {
  assert.deepEqual(
    sessionTurnStats(turnStats(1)).map((chip) => [chip.metric, chip.compactLabel]),
    [['turns', '1 turn']],
  );
  assert.deepEqual(
    sessionTurnStats(turnStats(12)).map((chip) => [chip.metric, chip.compactLabel]),
    [['turns', '12 turns']],
  );
  assert.deepEqual(sessionTurnStats(turnStats(0)), []);
  assert.deepEqual(sessionTurnStats(null), []);
  assert.deepEqual(sessionTurnStats(undefined), []);
});

test('a ledger with no span and no compaction count leaves both lines out of the turn chip hover', () => {
  // Missing ledger span and compaction count remain null and add no detail lines.

  assert.equal(
    sessionTurnStats(turnStats(12))[0].detail,
    'Turns in the main session: 12\nThe turn count excludes delegated work.',
  );
});

test('the turn figure lists its counts as label and value rows and folds its notes', () => {
  const first = Date.UTC(2026, 0, 1, 9, 0, 0);
  const last = first + (9 * 24 + 3) * 60 * 60_000; // 9d 3h later
  const [chip] = sessionTurnStats(turnStats(22, { compactionCount: 3, firstTurnAt: first, lastTurnAt: last }));
  assert.deepEqual(flatForm(chip.detailList), {
    layout: 'economics',
    entries: [
      { label: 'Turns in the main session', value: '22' },
      { label: 'First to last turn', value: '9d 3h' },
      { label: 'Compactions', value: '3' },
    ],
    notes: ['The turn count excludes delegated work.', 'Elapsed time includes gaps between turns.'],
  });
  assert.equal(
    chip.detail,
    'Turns in the main session: 22\nFirst to last turn: 9d 3h\nCompactions: 3\n' +
      'The turn count excludes delegated work.\nElapsed time includes gaps between turns.',
  );
});

test('a session with no compactions omits the compaction row', () => {
  const chip = sessionTurnStats(turnStats(12, { compactionCount: 0 }))[0];
  assert.equal(
    chip.detailList?.entries.some((entry) => entry.label === 'Compactions'),
    false,
  );
});

test('a first running turn and unavailable clocks omit elapsed detail', () => {
  const first = Date.UTC(2026, 0, 1);
  for (const [firstTurnAt, lastTurnAt] of [
    [first, first],
    [first, first + 499],
    [0, first],
    [first, 0],
    [0, 0],
    [first, first - 1000],
    [NaN, first],
    [first, Infinity],
    [-1000, first],
    [null, first],
    [first, null],
  ]) {
    const chip = sessionTurnStats(turnStats(1, { firstTurnAt, lastTurnAt, compactionCount: 0 }))[0];
    assert.equal(chip.detail, 'Turns in the main session: 1\nThe turn count excludes delegated work.');
  }
  const chip = sessionTurnStats(turnStats(1, { firstTurnAt: first, lastTurnAt: first + 500, compactionCount: 1 }))[0];
  assert.deepEqual(chip.detailList?.entries.slice(1), [
    { label: 'First to last turn', value: '1s' },
    { label: 'Compactions', value: '1' },
  ]);
  assert.ok(chip.detailList?.notes?.includes('Elapsed time includes gaps between turns.'));
});

test('a total that could not price every turn is marked as a floor and says how many', () => {
  const usage = { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 };
  const chips = sessionStats(
    [
      turn({ usage, startedAt: 1_000, endedAt: 2_000 }),
      // A model with no row in the price table, and tokens that were really spent on it.
      turn({ usage, model: 'unlisted-model', startedAt: 3_000, endedAt: 4_000 }),
    ],
    [],
  );
  const cost = statOf(chips, '$');
  assert.equal(cost?.label, '$1.00+');
  assert.match(cost!.detail, /Some usage could not be priced in 1 of 2 turns, so the estimated total may be low\./);
});

test('a session cost includes priced child transcripts', () => {
  const child = agent({
    spendFound: true,
    spend: [
      {
        model: 'claude-haiku-4-5',
        usage: { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
      },
    ],
  });
  const parent = { input: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 };
  const cost = statOf(sessionStats([turn({ usage: parent, agents: [child] })], []), '$');
  assert.equal(cost?.label, '$6.00');
});

test('an indexed session keeps a recorded Claude list cost', () => {
  const cost = sessionCostStats([
    {
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      recordedCost: 3.24,
      costBasis: 'list',
      unclassifiedCacheWrite: 100,
      usage: { input: 20, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 300, output: 40, thinking: 12 },
    },
  ])[0];
  assert.equal(cost?.label, '$3.24');
  assert.deepEqual(cost?.detailList?.entries[0].lines, ['Some recorded cost cannot be split by usage.']);
  assert.doesNotMatch(
    cost.detail,
    /Cached input reads|Uncached input|Output:/,
    'a provider-recorded total was presented as if public category rates explained it',
  );
});

test('unclassified cache writes keep a lifetime category total partial without inventing a tier', () => {
  const chip = sessionCostStats([
    {
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
    },
    {
      model: 'claude-opus-5',
      provider: null,
      contextWindow: 1_000_000,
      unclassifiedCacheWrite: 100,
      usage: { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    },
  ])[0];
  assert.equal(chip.compactLabel, '$1.00+');
  assert.deepEqual(chip.detailList?.heading, { label: 'Estimated total', value: '$1.00+' });
  assert.match(chip.detail, /Output: \$0\.50\n  Uncached input: \$0\.50/);
  assert.match(chip.detail, /Cost unavailable for opus-5 · provider not recorded: cache-write duration not recorded\./);
  assert.doesNotMatch(chip.detail, /cache writes: \$/i);
});

test('an indexed session does not replace list price with a provider amount of unknown basis', () => {
  const cost = statOf(
    sessionCostStats([
      {
        model: 'claude-opus-5',
        provider: null,
        contextWindow: 1_000_000,
        recordedCost: 0.01,
        usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
      },
    ]),
    '$',
  );
  assert.equal(cost?.label, '$1.00');
});

test('an incomplete indexed child keeps a known lifetime cost marked as a floor', () => {
  const cost = statOf(
    sessionCostStats([
      {
        model: 'claude-opus-5',
        provider: null,
        contextWindow: 1_000_000,
        usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
      },
      {
        model: null,
        provider: null,
        contextWindow: null,
        incomplete: true,
        usage: { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
      },
    ]),
    '$',
  );
  assert.equal(cost?.label, '$1.00+');
  assert.match(cost!.detail, /Model and provider not recorded/);
});

test('a session whose every turn is unpriced carries no cost at all, rather than a zero', () => {
  const chips = sessionStats(
    [
      turn({
        model: 'unlisted-model',
        usage: { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 },
      }),
    ],
    [],
  );
  assert.equal(statOf(chips, '$'), undefined);
});

test('a file several turns touched is one file in the total, not several', () => {
  const chips = sessionStats(
    [
      turn({
        files: [
          { path: '/w/a.ts', added: 10, removed: 2, isNew: false, edits: [] },
          { path: '/w/b.ts', added: 5, removed: 0, isNew: true, edits: [] },
        ],
      }),
      turn({
        files: [
          // A repeated path contributes lines without increasing the distinct file count.
          { path: '/w/a.ts', added: 3, removed: 1, isNew: false, edits: [] },
        ],
      }),
    ],
    [],
  );
  assert.equal(statOf(chips, '2 file')?.label, '2 files');
  // Line totals sum each edit's counts. File totals count distinct paths.
  const lines = chips.find((c) => c.added !== undefined);
  assert.equal(lines?.added, 18);
  assert.equal(lines?.removed, 3);
});

test('context is the newest turn level, never a sum of the turns', () => {
  const chips = sessionStats(
    [
      turn({ contextTokens: 500_000, startedAt: 1_000, endedAt: 2_000 }),
      // The newest turn supplies 200k tokens in a 1M window, or 20%.
      turn({ contextTokens: 200_000, startedAt: 9_000, endedAt: 9_500 }),
    ],
    [],
  );
  const ctx = chips.find((c) => c.label.includes('ctx'));
  assert.equal(ctx?.label, '20% of 1M ctx (200k)');
  assert.match(ctx!.detail, /Context measures the current level, not cumulative token usage\./);
  // The standing explanation sits under the notes disclosure, not in the visible breakdown.
  assert.ok(ctx!.detailList?.notes?.includes('Context measures the current level, not cumulative token usage.'));
  assert.ok(
    !ctx!.detailList?.entries.some((entry) =>
      (entry.lines ?? []).some((line) => typeof line === 'string' && line.startsWith('Context measures')),
    ),
    'the context explanation is still a visible line',
  );
  // Session context must not sum the turns' token levels.
  assert.ok(!chips.some((c) => c.label.includes('700k')));
});

test('a newer compaction supplies the session context level', () => {
  const held = turn({ contextTokens: 760_000, startedAt: 1_000, endedAt: 2_000 });
  const chips = sessionStats(
    [held],
    [
      compaction({
        at: 3_000,
        contextAfter: 14_172,
        model: 'claude-opus-5',
      }),
    ],
  );
  const ctx = chips.find((chip) => chip.label.includes('ctx'));
  assert.equal(ctx?.label, '1% of 1M ctx (14k)');
  assert.match(ctx!.detail, /after the latest compaction/);
  assert.doesNotMatch(ctx!.detail, /newest turn's context/);
});

test('an unknown post-compaction level does not leave the earlier turn on screen', () => {
  const held = turn({ contextTokens: 760_000, startedAt: 1_000, endedAt: 2_000 });
  const chips = sessionStats([held], [compaction({ at: 3_000, contextAfter: 0 })]);
  assert.equal(
    chips.some((chip) => chip.label.includes('ctx')),
    false,
  );
});

test('current context selects the newest recorded boundary', () => {
  const held = turn({
    contextTokens: 760_000,
    contextWindow: 1_000_000,
    startedAt: 1_000,
    endedAt: 2_000,
  });
  assert.deepEqual(currentContextOf(held, null), {
    tokens: 760_000,
    window: 1_000_000,
    afterCompaction: false,
  });
  assert.equal(currentContextOf(held, compaction({ at: 3_000, contextAfter: 0 })), null);
  assert.deepEqual(
    currentContextOf(
      held,
      compaction({
        at: 3_000,
        contextAfter: 14_172,
        model: 'claude-opus-5',
      }),
    ),
    { tokens: 14_172, window: 1_000_000, afterCompaction: true },
  );
  assert.deepEqual(
    currentContextOf(
      turn({ ...held, contextTokens: 200_000, startedAt: 4_000, endedAt: 5_000 }),
      compaction({ at: 3_000, contextAfter: 14_172 }),
    ),
    { tokens: 200_000, window: 1_000_000, afterCompaction: false },
  );
});

test('a turn after compaction supplies the current session context', () => {
  const chips = sessionStats(
    [
      turn({ contextTokens: 760_000, startedAt: 1_000, endedAt: 2_000 }),
      turn({ contextTokens: 200_000, startedAt: 4_000, endedAt: 5_000 }),
    ],
    [compaction({ at: 3_000, contextAfter: 14_172 })],
  );
  assert.equal(chips.find((chip) => chip.label.includes('ctx'))?.label, '20% of 1M ctx (200k)');
});

test('commits are counted across the turns read', () => {
  const commit = { sha: 'abc1234', subject: 'x', files: 1, added: 1, removed: 0, at: 0, place: null, dir: null };
  const chips = sessionStats([turn({ commits: [commit, commit] }), turn({ commits: [commit] })], []);
  assert.equal(statOf(chips, '3 commit')?.label, '3 commits');
});

test('a turn that spent nothing is not a hole in the total, so the figure keeps no floor mark', () => {
  // A model-less turn with no usage leaves a fully priced total complete.

  const usage = { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 };
  const chips = sessionStats(
    [turn({ usage, startedAt: 1_000, endedAt: 2_000 }), turn({ model: null, startedAt: 3_000, endedAt: 4_000 })],
    [],
  );
  const cost = statOf(chips, '$');
  assert.equal(cost?.label, '$1.00');
  assert.doesNotMatch(cost!.detail, /floor/);
});

test('the session context detail includes no forecast of remaining turns', () => {
  assert.doesNotMatch(ctxDetail([turn({ contextTokens: 950_000 })]), /turns? (left|remaining)|per turn|room for/);
});

test('the context hover says what the newest turn paid for cached input reads', () => {
  // 1M cache-read tokens on opus-5: $5 per MTok at a tenth is $0.50.
  const reread = { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 1_000_000, output: 0, thinking: 0 };
  // The cached-input figure needs its list-price caveat beside the context facts.
  const said = 'Latest turn cached input reads: $0.50';
  assert.ok(
    hoverLines([turn({ contextTokens: 200_000, usage: reread })]).includes(said),
    `the hover does not say: ${said}`,
  );
  assert.match(ctxDetail([turn({ contextTokens: 200_000, usage: reread })]), /Estimated from published model rates\./);
  // A fact about the turn that ran, never a rate for the ones to come.
  assert.doesNotMatch(ctxDetail([turn({ contextTokens: 200_000, usage: reread })]), /per turn|turns? (left|remaining)/);
  // No cached input reads produce no cached-read cost line.

  assert.doesNotMatch(ctxDetail([turn({ contextTokens: 200_000 })]), /cached input reads/);
  // Nor for a model the price table cannot price at all.
  assert.doesNotMatch(
    ctxDetail([turn({ contextTokens: 200_000, usage: reread, model: 'unlisted-model' })]),
    /cached input reads/,
  );
});

test('the context hover does not substitute loaded compactions for indexed evidence', () => {
  const held = [turn({ contextTokens: 200_000, startedAt: 9_000, endedAt: 9_500 })];
  const detail = ctxDetail(held, [
    compaction({ at: 9_100, trigger: 'manual' }),
    compaction({ at: 9_200, trigger: 'auto' }),
  ]);
  assert.doesNotMatch(detail, /Compactions:|Latest compaction: automatic|reason not recorded/);
});

test('one file reached through both path shapes is one file, not two', () => {
  // Slash and drive-letter normalization count the two Windows path spellings as one file.

  const chips = sessionStats(
    [
      turn({ files: [{ path: 'C:\\Users\\dev\\work\\a.ts', added: 3, removed: 0, isNew: false, edits: [] }] }),
      turn({ files: [{ path: 'c:/Users/dev/work/a.ts', added: 2, removed: 1, isNew: false, edits: [] }] }),
    ],
    [],
  );
  assert.equal(chips.find((c) => c.label.endsWith('file'))?.label, '1 file');
});

test('a path the shell names without hunks in one turn and a later turn edits keeps a partial count', () => {
  // An uncounted shell mention and a later counted edit contribute one file with partial line coverage.

  const chips = sessionStats(
    [
      turn({
        files: [
          {
            path: 'c:/repo/src/shared.ts',
            added: 0,
            removed: 0,
            isNew: false,
            edits: [],
            countsUnknown: true,
            unknownReason: 'shell',
          },
        ],
      }),
      turn({ files: [{ path: 'c:/repo/src/shared.ts', added: 5, removed: 0, isNew: false, edits: [] }] }),
    ],
    [],
  );
  const files = chips.find((c) => c.metric === 'files')!;
  assert.equal(files.name, '1 file, 5 lines added');
  assert.deepEqual(files.detail.split('\n'), [
    'Distinct files changed: 1',
    'Lines changed: +5',
    '  Across the 2 loaded turns',
    // The sentence names its file, so it never reads as a sentence about the turns above it.
    '1 file was named by the shell without its lines, so its line counts are partial.',
    'Each file counts once, even when several turns change it.',
    'Line totals add recorded edits across those turns, rather than a final net diff.',
  ]);
});

test('the cost hover explains missing pricing and still limits the total to the turns read', () => {
  const usage = { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 };
  const floor = sessionStats([turn({ usage }), turn({ usage, model: 'unlisted-model' })], []).find((c) =>
    c.label.startsWith('$'),
  );
  assert.match(floor!.detail, /Some usage could not be priced in 1 of 2 turns, so the estimated total may be low\./);
  assert.match(floor!.detail, /Over the 2 turns read, not the whole session\./);
});

test('a session cost chip carries the number its label was worded from', () => {
  // The cost figure retains its numeric estimate alongside formatted wording for aggregation.

  const usage = { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 };
  const whole = sessionStats(
    [turn({ usage, startedAt: 1_000, endedAt: 2_000 }), turn({ usage, startedAt: 3_000, endedAt: 4_000 })],
    [],
  ).find((chip) => chip.metric === 'cost');
  assert.equal(whole?.compactLabel, '$2.00');
  assert.equal(whole?.dollars, 2);
  // Every turn was priced, so the figure is the total and the label wears no mark.
  assert.equal(whole?.partial, false);

  // Auto Review's published rate prices its recorded usage without making the total partial.
  const withAutoReview = sessionStats(
    [
      turn({ usage, startedAt: 1_000, endedAt: 2_000 }),
      turn({ usage, model: 'codex-auto-review', startedAt: 3_000, endedAt: 4_000 }),
    ],
    [],
  ).find((chip) => chip.metric === 'cost');
  assert.equal(withAutoReview?.compactLabel, '$1.55');
  assert.equal(withAutoReview?.dollars, 1.55);
  assert.equal(withAutoReview?.partial, false);

  // Only cost figures carry dollars and partial fields.

  const others = sessionStats(
    [
      turn({
        usage,
        contextTokens: 620_000,
        contextWindow: 1_000_000,
        files: [{ path: '/w/a.ts', added: 4, removed: 1, isNew: false, edits: [] }],
      }),
    ],
    [],
  ).filter((chip) => chip.metric !== 'cost');
  assert.ok(others.length > 0, 'the case needs a chip that is not the cost chip');
  assert.deepEqual(
    others.map((chip) => [chip.dollars, chip.partial]),
    others.map(() => [undefined, undefined]),
  );
});

test('a step is said in the panel own words, and in the tense the call is in', () => {
  // Known tools use shared panel verbs and present tense while their calls run.

  assert.equal(said(step()), 'Read extension/src/store.ts');
  assert.equal(said(step({ status: 'running' })), 'Reading extension/src/store.ts');
  assert.equal(said(step({ name: 'Bash', detail: 'npm test' })), 'Ran npm test');
  assert.equal(said(step({ name: 'Bash', detail: 'npm test', status: 'running' })), 'Running npm test');
  assert.equal(said(step({ name: 'Grep', detail: 'livePressOver' })), 'Searched for livePressOver');
  assert.equal(said(step({ name: 'Edit', detail: 'a.ts' })), 'Edited a.ts');

  // A skill is the one row whose noun needs saying: "Loaded polish" reads as a file.
  assert.equal(said(step({ name: 'Skill', detail: 'polish' })), 'Loaded the polish skill');
  assert.equal(said(step({ name: 'Skill', detail: '' })), 'Loaded a skill');

  // An exec step with no recorded detail carries its verb alone.

  assert.equal(said(step({ name: 'exec', detail: '' })), 'Ran');
  assert.equal(said(step({ name: 'apply_patch', detail: 'src/a.ts' })), 'Edited src/a.ts');
  // A step with no detail omits the trailing colon.

  assert.equal(
    said(step({ name: 'spawn_agent', detail: '' })),
    'Started a subagent',
    'a row ends on a colon with nothing behind it, which reads as a fault',
  );
  assert.equal(said(step({ name: 'spawn_agent', detail: 'head_review' })), 'Started a subagent: head_review');
  assert.equal(said(step({ name: 'wait', detail: '' })), 'Waited for subagents');
  assert.equal(said(step({ name: 'ToolSearch', detail: 'calendar tools' })), 'Searched tools for calendar tools');
  assert.equal(said(step({ name: 'followup_task', detail: 'reviewer' })), 'Followed up with a subagent: reviewer');
  assert.equal(said(step({ name: 'view_image', detail: 'shots/panel.png' })), 'Viewed shots/panel.png');
  assert.equal(said(step({ name: 'write_stdin', detail: '' })), 'Continued command');
  assert.equal(said(step({ name: 'SubagentHandback', detail: '' })), 'Handed back the report');
  assert.equal(said(step({ name: 'SubagentHandback', detail: '', status: 'running' })), 'Handing back the report');

  // Unknown tools retain their recorded names.

  assert.equal(said(step({ name: 'DesignSync', detail: 'the canvas' })), 'DesignSync: the canvas');
  assert.equal(said(step({ name: 'DesignSync', detail: '' })), 'DesignSync');
});

test('what the agent handed the tool is kept apart from the words about it', () => {
  // Commands, paths, patterns, and URLs remain separate from their step verbs.

  assert.deepEqual(
    [stepLine(step({ name: 'Bash', detail: 'npm test' })), stepCode(step({ name: 'Bash', detail: 'npm test' }))],
    ['Ran', 'npm test'],
  );
  assert.equal(stepCode(step()), 'extension/src/store.ts');
  assert.equal(stepCode(step({ name: 'Grep', detail: 'livePressOver' })), 'livePressOver');
  // Unknown tools also retain a separate literal argument.

  assert.deepEqual(
    [
      stepLine(step({ name: 'DesignSync', detail: 'the canvas' })),
      stepCode(step({ name: 'DesignSync', detail: 'the canvas' })),
    ],
    ['DesignSync:', 'the canvas'],
  );

  // Skill names, child descriptions, and search queries stay in prose instead of the literal-code field.

  assert.equal(stepCode(step({ name: 'Skill', detail: 'polish' })), '');
  assert.equal(stepCode(step({ name: 'Task', detail: 'find the config loader' })), '');
  assert.equal(stepCode(step({ name: 'spawn_agent', detail: 'head_review' })), '');
  assert.equal(stepCode(step({ name: 'WebSearch', detail: 'how to pin a chip' })), '');
  // And a row with no detail at all has no literal half to draw.
  assert.equal(stepCode(step({ name: 'exec', detail: '' })), '');
  // A Codex exec whose rollout named the command it ran is read the same way a Bash row is.
  assert.deepEqual(
    [
      stepLine(step({ name: 'exec', detail: 'git status --short' })),
      stepCode(step({ name: 'exec', detail: 'git status --short' })),
    ],
    ['Ran', 'git status --short'],
  );
  assert.deepEqual(
    [
      stepLine(step({ name: 'exec_command', detail: 'git status --short', status: 'running' })),
      stepCode(step({ name: 'exec_command', detail: 'git status --short' })),
    ],
    ['Running', 'git status --short'],
  );
});

test('a human tool headline leads its bounded command preview and hovers the exact command', () => {
  const exact = ['npm test', '-- --runInBand', 'x'.repeat(STEP_DETAIL_LIMIT)].join('\n');
  const command = step({
    name: 'Bash',
    sourceId: 'bash-one',
    headline: 'Run the focused checks',
    detail: stepDetail({ command: exact }),
  });
  Object.defineProperty(command, 'fullDetail', { value: exact });
  const card = toCard(turn({ steps: [command], stepCount: 1 }), false, NOW);
  const [row] = card.activity;
  assert.equal(row.sourceId, 'bash-one');
  assert.equal(row.line, 'Run the focused checks (done):');
  assert.equal(row.code.length, STEP_DETAIL_LIMIT);
  assert.equal(row.title, exact);
  assert.equal(row.name, `Run the focused checks (done): ${exact}`);
  assert.equal('fullDetail' in row, false);
});

test('an exact headline activity name includes each status once', () => {
  const cases: Array<[TurnStep['status'], string]> = [
    ['running', 'running'],
    ['done', 'done'],
    ['failed', 'failed'],
    ['interrupted', 'stopped'],
  ];
  for (const [status, word] of cases) {
    const command = step({ name: 'Bash', headline: 'Run focused checks', detail: 'npm test', status });
    Object.defineProperty(command, 'fullDetail', { value: 'npm test' });
    const [row] = logOf(turn({ steps: [command], stepCount: 1 })).rows;
    assert.equal(row.name, `Run focused checks (${word}): npm test`, status);
  }
});

test('a failed step says so in words, and nothing else carries a word at all', () => {
  // Failed steps carry an explicit failure word.

  assert.equal(stepFigure(step({ status: 'failed' })), 'failed');
  assert.equal(stepFigure(step()), '');
  assert.equal(
    stepFigure(step({ status: 'running' })),
    '',
    'a running step carries a word as well as a clock, so the row says two things at once',
  );
});

test('the rows of the log carry the clock on the one call still in flight', () => {
  const rows = logOf(
    turn({
      steps: [
        step(),
        step({ ordinal: 2, name: 'Bash', detail: 'npm test', status: 'failed', at: 2 }),
        step({ ordinal: 3, name: 'Grep', detail: 'live', status: 'running', at: 3 }),
      ],
      stepCount: 3,
    }),
  ).rows[0].steps!;
  assert.deepEqual(
    rows.map((r) => [r.kind, r.line, r.code, r.figure, r.since]),
    [
      ['step', 'Read', 'extension/src/store.ts', '', null],
      ['step', 'Ran', 'npm test', 'failed', null],
      // A figure growing beside a call that came back would read as work still being done.
      ['step', 'Searching for', 'live', '', 3],
    ],
  );
});

test('what the reader typed mid-turn is drawn among the calls, where it happened', () => {
  // The Activity log places a mid-turn prompt between the calls surrounding its submission.

  const rows = logOf(
    turn({
      steps: [step({ at: 10 }), step({ ordinal: 2, name: 'Bash', detail: 'npm test', at: 30 })],
      stepCount: 2,
      laterPrompts: [{ stepsBefore: 1, text: 'and keep the tests green', at: 20 }],
    }),
  ).rows;
  assert.deepEqual(
    rows.map((r) => [r.kind, r.line]),
    [
      ['step', 'Read'],
      ['ask', 'You asked: and keep the tests green'],
      ['step', 'Ran'],
    ],
  );
  // Prompt rows carry no literal-code field, status figure, or running clock.

  assert.deepEqual([rows[1].code, rows[1].figure, rows[1].since], ['', '', null]);

  // A prompt sent after the last call still lands, at the end.
  const after = logOf(
    turn({
      steps: [step({ at: 10 })],
      stepCount: 1,
      laterPrompts: [{ stepsBefore: 1, text: 'one more thing', at: 99 }],
    }),
  ).rows;
  assert.deepEqual(
    after.map((r) => r.kind),
    ['step', 'ask'],
  );

  // Tool calls retain transcript order independently of their timestamps.

  const unsorted = logOf(
    turn({
      steps: [step({ at: 90 }), step({ ordinal: 2, name: 'Bash', detail: 'npm test', at: 10 })],
      stepCount: 2,
      laterPrompts: [],
    }),
  ).rows[0].steps!;
  assert.deepEqual(
    unsorted.map((r) => r.line),
    ['Read', 'Ran'],
  );
});

test('Activity partitions complete interleaved commands with bounded ordinal reads', () => {
  const count = 2000;
  let ordinalReads = 0;
  const steps = Array.from({ length: count }, (_, index) => ({
    ...step({ name: 'Bash', detail: `command ${index + 1}`, at: 0, status: index % 2 ? 'failed' : 'done' }),
    get ordinal() {
      ordinalReads++;
      return index + 1;
    },
  }));
  const rows = logOf(
    turn({
      startedAt: 0,
      steps,
      stepCount: count,
      stepKinds: Array(count).fill('commands'),
      failedOrdinals: Array.from({ length: count / 2 }, (_, index) => index * 2 + 2),
      updates: Array.from({ length: count }, (_, index) => ({
        sourceId: `message-${index}`,
        kind: 'commentary',
        text: `After command ${index + 1}`,
        at: 0,
        stepsBefore: index + 1,
        status: 'done',
      })),
    }),
    null,
    false,
    10000,
  ).rows;
  assert.equal(rows.length, count * 2);
  for (let index = 0; index < count; index++) {
    assert.equal(rows[index * 2].code, `command ${index + 1}`);
    assert.equal(rows[index * 2].status, index % 2 ? 'failed' : 'done');
    assert.equal(rows[index * 2 + 1].text, `After command ${index + 1}`);
  }
  assert.ok(ordinalReads < count * 20, `${ordinalReads} ordinal reads exceed the complete Activity traversal bound`);
});

test('activity merges narration, reasoning, prompts and tools while tool totals stay tool-only', () => {
  const card = toCard(
    turn({
      steps: [
        step({ sourceId: 'read-one', at: 10 }),
        step({ ordinal: 2, sourceId: 'bash-one', name: 'Bash', detail: 'npm test', at: 30 }),
      ],
      updates: [
        {
          stepsBefore: 1,
          sourceId: 'comment-one',
          kind: 'commentary',
          text: 'I am checking the current files.',
          at: 20,
          status: 'done',
        },
        {
          stepsBefore: 1,
          sourceId: 'reason-one',
          kind: 'reasoning',
          text: 'The parser and card need one shared model.',
          at: 30,
          status: 'done',
        },
      ],
      laterPrompts: [{ stepsBefore: 1, text: 'also check the tests', at: 25 }],
      stepCount: 2,
      toolCounts: counts({ reads: 1, commands: 1 }),
      toolTally: { Read: 1, Bash: 1 },
    }),
    false,
    NOW,
  );
  assert.deepEqual(
    card.activity.map((row) => [row.kind, row.sourceId, row.text ?? row.line, row.code]),
    [
      ['step', 'read-one', 'Read', 'extension/src/store.ts'],
      ['message', undefined, 'I am checking the current files.', ''],
      ['ask', undefined, 'You asked: also check the tests', ''],
      ['reasoning', 'reason-one', 'The parser and card need one shared model.', ''],
      ['step', 'bash-one', 'Ran', 'npm test'],
    ],
  );
  assert.equal(card.activityCount, 2);
  assert.equal(card.activityName, 'Activity, 1 message, 2 steps, 1 run · 1 read, 1 prompt');
  assert.deepEqual(card.toolTally, [
    { name: 'Bash', count: 1, category: 'commands' },
    { name: 'Read', count: 1, category: 'reads' },
  ]);
});

test('a narration reaches the log whole so its rendered block owns the bound', () => {
  // Activity messages retain complete text so their rendered blocks own truncation.

  const ordinary = `Checking the parser. ${'x'.repeat(400)}`;
  const past = `Checking the parser\n${'x'.repeat(NARRATION_DETAIL_LIMIT * 2)}`;
  const [whole, cut] = logOf(
    turn({
      updates: [
        { stepsBefore: 0, sourceId: 'comment-ordinary', kind: 'commentary', text: ordinary, at: 1, status: 'done' },
        { stepsBefore: 0, sourceId: 'comment-long', kind: 'commentary', text: past, at: 2, status: 'done' },
      ],
    }),
  ).rows;
  assert.equal(whole.kind, 'message');
  assert.equal(whole.text, ordinary, 'an ordinary narration block was cut');
  assert.equal(whole.code, '');
  assert.equal(cut.text, past);
  assert.ok(NARRATION_DETAIL_LIMIT > STEP_DETAIL_LIMIT, 'prose is bounded wider than a tool argument');
});

test('live protocol activity joins the card without changing recorded tool totals', () => {
  const base = turn({
    startedAt: 1_000,
    finished: false,
    steps: [{ ordinal: 1, name: 'Read', sourceId: 'recorded', detail: 'one.ts', at: 1_100, status: 'done' }],
    updates: [
      {
        stepsBefore: 0,
        sourceId: 'same-comment',
        kind: 'commentary',
        text: 'Already recorded.',
        at: 1_150,
        status: 'done',
      },
    ],
    stepCount: 1,
    toolUses: 1,
    stepKinds: ['reads'],
  });
  const exact = `npm test\n${'x'.repeat(STEP_DETAIL_LIMIT * 2)}`;
  const merged = withLiveActivity(base, [
    { sourceId: 'recorded', kind: 'tool', name: 'Read', headline: 'Read', detail: 'one.ts', status: 'done', at: 1_100 },
    {
      sourceId: 'same-comment',
      kind: 'commentary',
      name: 'Update',
      headline: 'Worked',
      detail: 'Already recorded.',
      status: 'done',
      at: 1_150,
    },
    {
      sourceId: 'live-comment',
      kind: 'commentary',
      name: 'Update',
      headline: 'Working',
      detail: 'Checking the renderer.',
      status: 'running',
      at: 1_200,
    },
    {
      sourceId: 'live-command',
      kind: 'tool',
      name: 'Bash',
      headline: 'Run focused checks',
      detail: exact,
      status: 'running',
      at: 1_300,
    },
  ]);
  assert.notEqual(merged, base);
  assert.equal(merged.stepCount, 1);
  assert.equal(merged.toolUses, 1);
  assert.deepEqual(merged.stepKinds, ['reads', 'commands']);
  assert.deepEqual(base.stepKinds, ['reads']);
  assert.deepEqual(
    merged.updates.map((update) => update.sourceId),
    ['same-comment', 'live-comment'],
  );
  assert.deepEqual(
    merged.steps.map((item) => item.sourceId),
    ['recorded', 'live-command'],
  );
  assert.equal(merged.steps[1].headline, 'Run focused checks');
  assert.equal(merged.steps[1].detail.length, STEP_DETAIL_LIMIT);
  assert.equal(merged.steps[1].fullDetail, exact);
  assert.equal(Object.keys(merged.steps[1]).includes('fullDetail'), false);
});

test('live activity retains any exact detail changed by its preview', () => {
  const path = `C:\\workspace\\${'deep-folder\\'.repeat(20)}file.ts`;
  const merged = withLiveActivity(turn({ startedAt: 1_000, finished: false }), [
    { sourceId: 'read-one', kind: 'tool', name: 'Read', headline: 'Read', detail: path, status: 'running', at: 1_100 },
    {
      sourceId: 'plan-one',
      kind: 'plan',
      name: 'update_plan',
      headline: 'Updated the plan',
      detail: 'Implement parser',
      status: 'done',
      at: 1_200,
    },
  ]);
  assert.deepEqual(
    merged.steps.map((step) => step.fullDetail),
    [path, undefined],
  );
  assert.deepEqual(
    logOf(merged).rows[0].steps!.map((row) => row.title),
    [path, 'Implement parser'],
  );
  assert.equal(logOf(merged).rows[0].steps![0].name, `Reading ${path} running`);
});

for (const recordedCount of [0, 1]) {
  test(`Activity heading and run agree with ${recordedCount ? 'recorded plus live' : 'live-only'} calls`, () => {
    const base = turn({
      startedAt: 1_000,
      endedAt: 1_100,
      finished: false,
      stepCount: recordedCount,
      stepKinds: recordedCount ? ['reads'] : [],
      steps: recordedCount ? [step({ sourceId: 'read', at: 1_100 })] : [],
    });
    const read = {
      sourceId: 'read',
      kind: 'tool' as const,
      name: 'Read',
      headline: '',
      detail: 'one.ts',
      status: 'done' as const,
      at: 1_100,
    };
    const command = { ...read, sourceId: 'command', name: 'Bash', detail: 'npm test', at: 1_200 };
    const shown = withLiveActivity(base, recordedCount ? [command] : [read, command]);
    const card = toCard(shown, true, 1_300);
    const [run] = card.activity;
    assert.deepEqual(
      [card.activityCount, card.activityName, card.activityTools, run.count, run.mix],
      [2, 'Activity, 2 steps, 1 run · 1 read', '1 run · 1 read', 2, '1 run · 1 read'],
    );
    assert.equal(shown.stepCount, recordedCount);
    assert.equal(base.stepCount, recordedCount);
    if (!recordedCount) {
      const single = toCard(withLiveActivity(base, [command]), true, 1_300);
      assert.deepEqual(
        [single.activityCount, single.activityName, single.activityTools, single.activity[0].kind],
        [1, 'Activity, 1 step, 1 run', '1 run', 'step'],
      );
    }
  });
}

test('an interrupted live command remains interrupted on its activity row', () => {
  const merged = withLiveActivity(turn({ startedAt: 1_000, finished: false }), [
    {
      sourceId: 'stopped-command',
      kind: 'tool',
      name: 'Shell',
      headline: 'Run focused checks',
      detail: 'npm test',
      status: 'interrupted',
      at: 1_100,
    },
  ]);
  assert.equal(merged.steps[0].status, 'interrupted');
  const [row] = logOf(merged).rows;
  assert.equal(row.status, 'interrupted');
  assert.equal(row.line, 'Run focused checks (stopped):');
});

test('live activity before the turn is not attached to it', () => {
  const base = turn({ startedAt: 2_000, finished: false });
  assert.equal(
    withLiveActivity(base, [
      {
        sourceId: 'older',
        kind: 'commentary',
        name: 'Update',
        headline: 'Worked',
        detail: 'This belonged to an earlier turn.',
        status: 'done',
        at: 1_999,
      },
    ]),
    base,
  );
});

test('a prompt the panel has sent and the transcript has not caught up with is on the card', () => {
  // A submitted mid-turn prompt appears before the transcript records its matching text.

  const running = turn({ startedAt: 1_000, endedAt: 9_000, finished: false });
  const sent = { text: 'follow up msg test', at: 5_000, midTurn: true };
  const ask = pendingAskOf(running, sent, true);
  assert.deepEqual(ask, { text: 'follow up msg test', at: 5_000, stepsBefore: 0 });

  // A matching recorded prompt removes its pending copy.

  assert.equal(
    pendingAskOf({ ...running, laterPrompts: [{ stepsBefore: 0, text: 'follow up msg test', at: 5_100 }] }, sent, true),
    null,
  );

  // A press that started its own turn is not one of these, whatever else is true.
  assert.equal(pendingAskOf(running, { ...sent, midTurn: false }, true), null);
  // Nor is one made before this turn began: it belongs to whatever turn was running then.
  assert.equal(pendingAskOf(running, { ...sent, at: 500 }, true), null);
  // And a turn that has stopped answers nothing more, so nothing is pending on it.
  assert.equal(pendingAskOf(running, sent, false), null);
  // A compaction press carries none of the reader's words and leaves no line on the card.
  assert.equal(pendingAskOf(running, { ...sent, text: '' }, true), null);
  assert.equal(pendingAskOf(running, null, true), null);
});

test('a pending prompt keeps its submitted position after later recorded and live calls', () => {
  const base = turn({
    startedAt: 1_000,
    endedAt: 9_000,
    finished: false,
    stepCount: 1,
    stepKinds: ['commands'],
    steps: [step({ ordinal: 1, sourceId: 'first', at: 2_000 })],
  });
  const live = [
    {
      sourceId: 'live-first',
      kind: 'tool' as const,
      name: 'Bash',
      headline: '',
      detail: 'first live call',
      status: 'done' as const,
      at: 3_000,
    },
  ];
  const shown = withLiveActivity(base, live);
  const sent = {
    text: 'Keep this between calls',
    at: 4_000,
    midTurn: true,
    stepsBefore: Math.max(shown.stepCount, ...shown.steps.map((step) => step.ordinal)),
  };
  const later = withLiveActivity(
    {
      ...base,
      stepCount: 2,
      stepKinds: ['commands', 'commands'],
      steps: [...base.steps, step({ ordinal: 2, sourceId: 'live-first', at: 3_000 })],
    },
    [...live, { ...live[0], sourceId: 'live-later', at: 5_000 }],
  );
  const card = toCard(later, true, 9_000, [], sent);
  assert.deepEqual(
    card.activity.map((row) => [row.kind, row.id]),
    [
      ['run', 'run:1'],
      ['ask', undefined],
      ['step', 'step:3'],
    ],
  );
  const recordedLater = { ...later, stepCount: 3 };
  assert.deepEqual(toCard(recordedLater, true, 9_000, [], sent).activity, card.activity);
});

test('a slash command sent mid-turn stops being pending once the transcript carries it', () => {
  // Slash-command tags normalize to the submitted line so the card removes its pending copy.

  const running = turn({ startedAt: 1_000, endedAt: 9_000, finished: false });
  const sent = { text: '/write-ppm-docs review the plugin pages', at: 5_000, midTurn: true };
  const recorded = cleanPrompt(
    '<command-message>write-ppm-docs</command-message>\n<command-name>/write-ppm-docs</command-name>\n<command-args>review the plugin pages</command-args>',
  );
  assert.equal(recorded, sent.text, 'the recorded prompt reads as a different prompt from the one the composer holds');
  assert.equal(
    pendingAskOf({ ...running, laterPrompts: [{ stepsBefore: 0, text: recorded, at: 5_100 }] }, sent, true),
    null,
    'the card draws the pending copy beside the recorded one',
  );
});

test('the card says which of the prompts on it the transcript has and which it has just sent', () => {
  const card = toCard(
    turn({
      startedAt: NOW - 60_000,
      endedAt: NOW,
      finished: false,
      laterPrompts: [{ stepsBefore: 1, text: 'the recorded one', at: NOW - 40_000 }],
      steps: [step({ at: NOW - 50_000 })],
      stepCount: 1,
    }),
    true,
    NOW,
    [],
    { text: 'the one just sent', at: NOW - 10_000, midTurn: true },
  );
  assert.deepEqual(
    card.laterPrompts.map((a) => [a.text, a.label]),
    [
      ['the recorded one', CARD_ACTIONS.askedMidTurn],
      ['the one just sent', CARD_ACTIONS.askedJustSent],
    ],
  );
  // This pending prompt follows all recorded calls in the Activity log.

  assert.deepEqual(
    card.activity.map((r) => [r.kind, r.line]),
    [
      ['step', 'Read'],
      ['ask', 'You asked: the recorded one'],
      ['ask', 'You asked: the one just sent'],
    ],
  );
  // A finished turn takes none of it: nothing more is coming back on that card.
  const done = toCard(turn({ startedAt: NOW - 60_000, endedAt: NOW - 1_000 }), false, NOW, [], {
    text: 'the one just sent',
    at: NOW - 10_000,
    midTurn: true,
  });
  assert.deepEqual(done.laterPrompts, []);
});

test('the log control counts what is under it, which is not only the calls', () => {
  // Activity counts include prompts even when the turn made no tool calls.

  const asked = toCard(
    turn({
      steps: [],
      stepCount: 0,
      toolCounts: counts(),
      laterPrompts: [{ stepsBefore: 0, text: 'and keep the tests green', at: 2 }],
    }),
    false,
    NOW,
  );
  assert.equal(asked.activityName, 'Activity, 1 prompt');
  assert.ok(!asked.activityName.includes('0 steps'), 'the control counts calls that were never made');

  // Activity names list tool counts before prompt counts.

  const both = toCard(
    turn({
      steps: [step()],
      stepCount: 3,
      toolCounts: counts({ reads: 3 }),
      laterPrompts: [
        { stepsBefore: 0, text: 'one', at: 2 },
        { stepsBefore: 0, text: 'two', at: 3 },
      ],
    }),
    false,
    NOW,
  );
  assert.equal(both.activityName, 'Activity, 3 steps, 3 read, 2 prompts');

  // Without later prompts, Activity names contain tool counts alone.

  assert.equal(
    toCard(turn({ steps: [step()], stepCount: 1, toolCounts: counts({ reads: 1 }) }), false, NOW).activityName,
    'Activity, 1 step, 1 read',
  );
});

test('a card says how many steps it is not showing', () => {
  // Activity rows report earlier omitted steps separately from visible steps.

  assert.equal(logOf(turn({ steps: [step()], stepCount: 1 })).rows[0].earlierLine, undefined);
  assert.equal(logOf(turn({ steps: [step({ ordinal: 2 })], stepCount: 2 })).rows[0].earlierLine, 'and 1 earlier step');
  assert.equal(
    logOf(turn({ steps: [step({ ordinal: 92 })], stepCount: 92 })).rows[0].earlierLine,
    'and 91 earlier steps',
  );
});

test('the capped log retains messages, original run counts, failures and tool mixes', () => {
  const fixture = turn({
    stepCount: 65,
    stepKinds: Array(65).fill('reads'),
    failedOrdinals: [1],
    toolCounts: counts({ reads: 65 }),
    steps: Array.from({ length: 60 }, (_, n) => step({ ordinal: n + 6, at: 100 + n })),
    updates: Array.from({ length: 6 }, (_, n) => ({
      kind: 'commentary',
      sourceId: `message-${n}`,
      text: `Message ${n + 1}`,
      at: 99 - n,
      status: 'done',
      stepsBefore: (n + 1) * 10,
    })),
    answers: [{ text: 'An earlier reply', at: 95, stepsBefore: 20 }],
    summary: 'Closing response',
    laterPrompts: [{ text: 'Also check the tests', at: 94, stepsBefore: 30 }],
  });
  const log = logOf(fixture);
  assert.equal(log.rows.filter((row) => row.kind === 'message').length, 7);
  assert.equal(log.rows.filter((row) => row.messageKind === 'answer').length, 1);
  assert.equal(log.rows.filter((row) => row.kind === 'ask').length, 1);
  const runs = log.rows.filter((row) => row.kind === 'run');
  assert.deepEqual(
    runs.map((row) => row.count),
    [10, 10, 10, 10, 10, 10, 5],
  );
  assert.equal(runs[0].earlier, 5);
  assert.equal(runs[0].failed, 1);
  assert.equal(runs[0].mix, '10 read');
  assert.match(runs[0].label!, /10 tool calls, 1 failed, 5 earlier, 10 read/);
  assert.deepEqual(log.counts, ['7 messages', '1 reply']);
  const card = toCard(fixture, false, NOW);
  assert.deepEqual(card.activityCounts, log.counts);
  assert.equal(card.activityTools, '65 read');
  assert.match(card.activityName, /^Activity, 7 messages, 1 reply,/);
  assert.match(card.toolMix, /^7 messages, 1 reply/);
  assert.equal(
    CARD_CONTENT_FIELDS.some((field: string) => ['activityOpen', 'activityMore'].includes(field)),
    false,
  );

  const empty = logOf({ ...fixture, steps: fixture.steps.filter((step) => step.ordinal > 10) }).rows[0];
  assert.equal(empty.kind, 'run');
  assert.equal(empty.earlier, empty.count);
  assert.equal(empty.count, 10);
  assert.equal(empty.mix, '10 read');
  assert.equal(empty.failed, 1);
  assert.equal(empty.steps!.length, 0);
  assert.equal(logOf(turn({ stepCount: 1, steps: [step()] })).rows[0].kind, 'step');
  const active = turn({ stepCount: 2, steps: [step(), step({ ordinal: 2, status: 'running' })] });
  assert.equal(logOf(active, null, true).rows[0].inFlight, true);
  assert.equal(logOf(active, null, false).rows[0].inFlight, false);
  assert.equal(
    logOf({ ...active, steps: active.steps.map((step) => ({ ...step, status: 'done' })) }).rows[0].inFlight,
    false,
  );
});

test('the folded card names what the agent is on, and only while it is on something', () => {
  // The folded doing line names only a newest step that is still running.

  assert.equal(doingOf(turn({ steps: [step({ status: 'running' })], stepCount: 1 }))?.name, 'Read');
  assert.equal(doingOf(turn({ steps: [step()], stepCount: 1 })), null);
  assert.equal(doingOf(turn({ steps: [], stepCount: 0 })), null);
  // When two steps run together, the doing line names the newest one.

  const both = turn({
    steps: [step({ status: 'running' }), step({ name: 'Bash', detail: 'npm test', status: 'running' })],
    stepCount: 2,
  });
  assert.equal(doingOf(both)?.name, 'Bash');
});

test('the card carries the log, its heading and what the agent is doing', () => {
  const running = toCard(
    turn({
      steps: [step({ ordinal: 4, name: 'Bash', detail: 'npm test', status: 'running' })],
      stepCount: 4,
      toolCounts: counts({ reads: 2, commands: 2 }),
      endedAt: Date.now(),
      finished: false,
    }),
    true,
    Date.now(),
  );
  assert.equal(running.activityCount, 4);
  assert.equal(running.activityWord, 'Activity');
  assert.ok(running.activityName.includes('4 steps'), 'the control never says how much it opens');
  assert.ok(running.activityName.includes('Activity'));
  assert.equal('activityOpen' in running, false);
  assert.equal('activityMore' in running, false);
  assert.equal(running.doing, 'Running');
  assert.equal(running.doingCode, 'npm test', 'the folded line drew the command as prose');
  assert.equal(running.doingSince, running.activity[0].steps![0].since);

  // Finished turns carry no current doing line or running clock.
  const done = toCard(turn({ steps: [step()], stepCount: 1 }), false);
  assert.equal('activityOpen' in done, false);
  assert.equal(done.doing, '', 'a finished card still says the agent is doing something');
  assert.equal(done.doingCode, '');
  assert.equal(done.doingSince, null);
});

test('a folded running card uses the latest commentary when no tool is running', () => {
  const running = toCard(
    turn({
      steps: [step({ status: 'done', at: NOW - 20_000 })],
      updates: [
        {
          stepsBefore: 0,
          sourceId: 'older',
          kind: 'commentary',
          text: 'I am reading the plan.',
          at: NOW - 10_000,
          status: 'done',
        },
        {
          stepsBefore: 0,
          sourceId: 'reasoning',
          kind: 'reasoning',
          text: 'Internal clear summary.',
          at: NOW - 5_000,
          status: 'done',
        },
        {
          stepsBefore: 0,
          sourceId: 'newer',
          kind: 'commentary',
          text: 'I am preparing the result.',
          at: NOW - 1_000,
          status: 'done',
        },
      ],
      stepCount: 1,
      startedAt: NOW - 60_000,
      endedAt: NOW,
      finished: false,
    }),
    true,
    NOW,
  );
  assert.equal(running.doing, 'I am preparing the result.');
  assert.equal(running.doingCode, '');
  assert.equal(running.doingSince, null);

  const withTool = toCard(
    turn({
      steps: [step({ name: 'Bash', detail: 'npm test', status: 'running', at: NOW - 500 })],
      updates: [
        {
          stepsBefore: 0,
          sourceId: 'newer',
          kind: 'commentary',
          text: 'I am preparing the result.',
          at: NOW - 100,
          status: 'done',
        },
      ],
      stepCount: 1,
      startedAt: NOW - 60_000,
      endedAt: NOW,
      finished: false,
    }),
    true,
    NOW,
  );
  assert.equal(withTool.doing, 'Running');
  assert.equal(withTool.doingCode, 'npm test');
});

// Next-turn cost basis uses the context-setting request's timestamp and cache lifetime, independently of aggregate turn usage and later activity.

const CONTEXT_REQUEST = {
  at: 9_000,
  lifetime: '1h' as const,
  inferenceClass: null,
  serviceTier: null,
  readBack: true,
  outputTokens: 100,
};

test('the floor is dated by the request that set the level, not by the end of the turn', () => {
  // Tool results, interruptions, and notifications do not refresh the model request's cache timestamp.

  const held = turn({
    contextTokens: 620_000,
    contextWindow: 1_000_000,
    startedAt: 1_000,
    endedAt: 7_200_000,
    contextRequest: CONTEXT_REQUEST,
  });
  assert.equal(
    nextTurnBasisOf(held, null)?.lastRequestAt,
    9_000,
    'the turn own clock dates the cache, so a long tool run reads as a fresh request',
  );
});

test('the lifetime comes from that request, not from what the whole turn wrote', () => {
  // The latest request's five-minute lifetime outranks earlier one-hour writes in aggregate usage.

  const held = turn({
    contextTokens: 620_000,
    contextWindow: 1_000_000,
    usage: {
      requests: 4,
      input: 0,
      cacheWrite1h: 620_000,
      cacheWrite5m: 6_000,
      cacheRead: 500_000,
      output: 100,
      thinking: 0,
    },
    contextRequest: { ...CONTEXT_REQUEST, lifetime: '5m' as const },
  });
  assert.equal(nextTurnBasisOf(held, null)?.tier, '5m');
});

test('the next request adds only the latest answer to its recorded input', () => {
  const held = turn({
    contextTokens: 271_999,
    usage: {
      requests: 4,
      input: 271_999,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheRead: 0,
      output: 80_000,
      thinking: 0,
    },
    contextRequest: { ...CONTEXT_REQUEST, outputTokens: 2 },
  });
  const basis = nextTurnBasisOf(held, null);
  assert.equal(basis?.tokens, 271_999);
  assert.equal(
    basis?.outputTokens,
    2,
    'the turn output total includes older answers that its last request input already contains',
  );
});

test('a request naming no lifetime leaves the panel with none to report', () => {
  const held = turn({
    contextTokens: 620_000,
    contextWindow: 1_000_000,
    usage: {
      requests: 1,
      input: 0,
      cacheWrite1h: 620_000,
      cacheWrite5m: 0,
      cacheRead: 0,
      output: 100,
      thinking: 0,
    },
    contextRequest: { ...CONTEXT_REQUEST, lifetime: null },
  });
  // The write above is charged at the hour because that is the price fallback. It is not
  // evidence that an hour was bought, and the basis must not report it as one.
  assert.equal(nextTurnBasisOf(held, null)?.tier, null);
});

test('the floor carries what the request was billed under', () => {
  const held = turn({
    contextTokens: 620_000,
    contextWindow: 1_000_000,
    contextRequest: { ...CONTEXT_REQUEST, inferenceClass: 'in-region' as const, serviceTier: 'priority' },
  });
  const basis = nextTurnBasisOf(held, null);
  assert.equal(basis?.inferenceClass, 'in-region');
  assert.equal(basis?.serviceTier, 'priority');
});

test('a turn with no recorded request has no forward price', () => {
  const held = turn({ contextTokens: 620_000, contextWindow: 1_000_000, startedAt: 1_000, endedAt: 2_000 });
  assert.equal(nextTurnBasisOf(held, null), null, 'a price without the last answer would understate the next request');
});

test('an unfinished turn has no forward price until a request measures its later tool results', () => {
  const held = turn({
    contextTokens: 620_000,
    contextWindow: 1_000_000,
    startedAt: 1_000,
    endedAt: 90_000,
    finished: false,
    interrupted: true,
    contextRequest: CONTEXT_REQUEST,
    steps: [{ ordinal: 1, name: 'Read', detail: 'a large result', at: 80_000, status: 'done' }],
  });
  assert.equal(
    nextTurnBasisOf(held, null),
    null,
    'the last request cannot measure a tool result that arrived after it',
  );
});

test('a newer compaction claims no cache for the history it just wrote', () => {
  const held = turn({
    contextTokens: 760_000,
    contextWindow: 1_000_000,
    startedAt: 1_000,
    endedAt: 2_000,
    contextRequest: CONTEXT_REQUEST,
  });
  const basis = nextTurnBasisOf(
    held,
    compaction({
      at: 30_000,
      contextAfter: 14_172,
      model: 'claude-sonnet-5',
    }),
  );
  assert.equal(basis?.tokens, 14_172);
  assert.equal(basis?.outputTokens, 0);
  assert.equal(basis?.model, 'claude-sonnet-5');
  // The compaction timestamp becomes the latest request time.
  assert.equal(basis?.lastRequestAt, 30_000);
  // Compacted context carries neither the preceding request's cache lifetime nor its cache-read evidence.

  assert.equal(basis?.tier, null);
  assert.equal(basis?.readBack, false);
  // afterCompaction distinguishes replacement context from missing cache evidence.

  assert.equal(basis?.afterCompaction, true);
});

// A compaction can follow the last model request while preceding later turn activity.

test('a compaction newer than the last request drops the cache, whenever the turn ended', () => {
  const held = turn({
    contextTokens: 620_000,
    contextWindow: 1_000_000,
    startedAt: 1_000,
    endedAt: 90_000,
    contextRequest: CONTEXT_REQUEST,
  });
  const basis = nextTurnBasisOf(held, compaction({ at: 30_000, contextAfter: 14_172, model: 'claude-sonnet-5' }));
  assert.equal(basis?.afterCompaction, true, 'the cache state is dated from the end of the turn');
  assert.equal(basis?.tier, null, 'the lifetime the request before the compaction bought is carried over');
  assert.equal(basis?.readBack, false);
  assert.equal(basis?.lastRequestAt, 30_000, 'the compaction is the newest request and is not the clock');
  assert.equal(basis?.tokens, 14_172);
  assert.equal(basis?.outputTokens, 0);
  assert.equal(basis?.model, 'claude-sonnet-5');
});

test('no floor at all where there is no current context to price', () => {
  assert.equal(nextTurnBasisOf(null, null), null);
  assert.equal(
    nextTurnBasisOf(
      turn({ contextTokens: 760_000, startedAt: 1_000, endedAt: 2_000 }),
      compaction({ at: 3_000, contextAfter: 0 }),
    ),
    null,
    'a compaction with no recorded result leaves the earlier level in place',
  );
});

test('the card draws one row for each skill, in the order the turn first loaded it', () => {
  const card = toCard(
    turn({
      skillUses: [
        skillUse({ sourceId: 'a1', name: 'polish', at: 1_000 }),
        skillUse({
          sourceId: 'b1',
          name: 'panel-mockup',
          at: 2_000,
          evidence: 'best-effort',
          description: 'Review the panel and draw a mockup of it.',
          fullDescription: 'Review the panel and draw a mockup of it, then compare candidates.',
          path: 'C:\\repo\\.claude\\skills\\panel-mockup\\SKILL.md',
        }),
        skillUse({ sourceId: 'a2', name: 'polish', at: 3_000 }),
      ],
      skillUseCount: 3,
    }),
    false,
    NOW,
  );
  assert.deepEqual(card.activitySkills, [
    {
      name: 'polish',
      count: 2,
      path: 'C:/Users/dev/.claude/skills/polish/SKILL.md',
      shownPath: 'C:/Users/dev/.claude/skills/polish/SKILL.md',
      evidence: 'recorded',
    },
    {
      name: 'panel-mockup',
      count: 1,
      description: 'Review the panel and draw a mockup of it.',
      fullDescription: 'Review the panel and draw a mockup of it, then compare candidates.',
      path: 'C:\\repo\\.claude\\skills\\panel-mockup\\SKILL.md',
      shownPath: 'C:/repo/.claude/skills/panel-mockup/SKILL.md',
      evidence: 'best-effort',
    },
  ]);
  assert.equal(card.activitySkillCount, 3);
  assert.equal(card.activitySkillLabel, '3 skills');
  assert.equal(toCard(turn({ skillUses: [skillUse()], skillUseCount: 1 }), false, NOW).activitySkillLabel, '1 skill');
  assert.deepEqual(toCard(turn(), false, NOW).activitySkills, []);
});

test('the strongest evidence and the first recorded file win for one skill', () => {
  // Recorded skill loads outrank inferred file reads for the same skill.

  const card = toCard(
    turn({
      skillUses: [
        skillUse({
          sourceId: 'c1',
          name: 'polish',
          evidence: 'best-effort',
          at: 1_000,
          description: 'Tidy the wording.',
          path: undefined,
        }),
        skillUse({ sourceId: 'c2', name: 'polish', at: 2_000, path: 'C:/repo/skills/polish/SKILL.md' }),
        skillUse({ sourceId: 'c3', name: 'polish', at: 3_000, path: 'C:/elsewhere/polish/SKILL.md' }),
      ],
      skillUseCount: 3,
    }),
    false,
    NOW,
  );
  assert.deepEqual(card.activitySkills, [
    {
      name: 'polish',
      count: 3,
      description: 'Tidy the wording.',
      path: 'C:/repo/skills/polish/SKILL.md',
      shownPath: 'C:/repo/skills/polish/SKILL.md',
      evidence: 'recorded',
    },
  ]);
});

test('the card counts every load the turn recorded, not the rows it drew', () => {
  // A turn past the bound on the list, and a skill loaded twice, both make the two differ.
  const card = toCard(turn({ skillUses: [skillUse()], skillUseCount: 9 }), false, NOW);
  assert.equal(card.activitySkills.length, 1);
  assert.equal(card.activitySkillCount, 9);
  assert.equal(card.activitySkillLabel, '9 skills');
});

test('a skill load is counted in no tool category, and listed under its own', () => {
  const card = toCard(
    turn({
      stepCount: 2,
      stepKinds: ['reads', 'skill'],
      toolUses: 2,
      toolTally: { Read: 1, Skill: 1 },
      steps: [step(), step({ ordinal: 2, name: 'Skill', detail: 'polish' })],
    }),
    false,
    NOW,
  );
  assert.deepEqual(card.activityToolCategories, [{ key: 'reads', label: 'read', count: 1 }]);
  assert.equal(card.activityTools, '1 read');
  assert.deepEqual(card.toolTally, [
    { name: 'Read', count: 1, category: 'reads' },
    { name: 'Skill', count: 1, category: 'skill' },
  ]);
  assert.equal(card.activityCount, 2, "the call is still one of the turn's calls");
});

test('a live skill load is counted the way a recorded one is', () => {
  const merged = withLiveActivity(turn({ stepCount: 0, stepKinds: [], steps: [] }), [
    {
      sourceId: 'live-skill',
      kind: 'tool',
      name: 'Skill',
      headline: 'Loading',
      detail: 'polish',
      status: 'running',
      at: NOW - 1_000,
    },
  ]);
  assert.deepEqual(merged.stepKinds, ['skill']);
  assert.deepEqual(toCard(merged, false, NOW).activityToolCategories, []);
});

test('turn cache-rate color excludes output spend and respects the input-cost minimum', () => {
  for (const [input, output, warning] of [
    [100, 1000000, false],
    [100000, 0, true],
  ] as const) {
    const card = toCard(
      turn({
        model: 'claude-opus-5',
        usage: { requests: 5, input, output, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, thinking: 0 },
      }),
      false,
      NOW,
    );
    const descendants = (lines: readonly StatDetailLine[]): StatDetailLine[] =>
      lines.flatMap((line) => [
        line,
        ...(typeof line === 'object' && 'text' in line ? descendants(line.lines ?? []) : []),
      ]);
    const lines = card.chips[0].detailList!.entries.flatMap((entry) => descendants(entry.lines ?? []));
    const rate = lines.find((line) => typeof line === 'object' && 'cacheHit' in line);
    assert.equal((rate as { cacheHit: { warning: boolean } }).cacheHit.warning, warning);
  }
});

test('a compaction card estimates each measured warm Claude compaction within 20% of its real cost', () => {
  const folder = tempDir('compaction-card-');
  for (const row of COMPACTION_SAMPLES.filter((sample) => sample.firstRead === null)) {
    const file = path.join(folder, `${row.name.replace(/\W+/g, '-')}.jsonl`);
    fs.writeFileSync(
      file,
      claudeCompactionTranscript(row)
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
    const [compacted] = readSession(file, 'sess').compactions;
    const cost = toCompactionCard(compacted, NOW).chips.find((chip) => chip.metric === 'cost');
    const dollars = Number(cost?.label.replace('$', ''));
    assert.ok(Math.abs(dollars / row.realCost - 1) <= 0.2, `${row.name}: ${cost?.label} against $${row.realCost}`);
    assert.match(cost?.detail ?? '', /estimate/i);
  }
});

test('a compaction estimate raises no cache-write warning and leaves the cached share alone', () => {
  const recorded = {
    model: 'claude-opus-5',
    provider: null,
    contextWindow: null,
    role: 'main' as const,
    usage: {
      requests: 5,
      input: 1_000,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheRead: 200_000,
      output: 1_000,
      thinking: 0,
    },
  };
  // An estimate with $5.63 of writes, most of the scope's input.
  const estimate = {
    ...recorded,
    compactionEstimate: true as const,
    usage: { requests: 1, input: 0, cacheWrite1h: 0, cacheWrite5m: 900_000, cacheRead: 0, output: 3_000, thinking: 0 },
  };
  const cacheHit = (parts: Parameters<typeof sessionCostProjection>[0]) => {
    const chip = sessionCostProjection(parts).stats[0];
    const lines = chip.detailList?.entries.flatMap((entry) => entry.lines ?? []) ?? [];
    return {
      warnings: chip.warnings,
      cacheHit: lines.find(
        (line): line is StatDetailLine & { cacheHit: unknown } => typeof line === 'object' && 'cacheHit' in line,
      )?.cacheHit,
    };
  };
  const alone = cacheHit([recorded]);
  const both = cacheHit([recorded, estimate]);
  assert.equal(both.warnings, undefined);
  assert.deepEqual(both.cacheHit, alone.cacheHit);
  assert.ok(alone.cacheHit, 'the recorded usage carries a cached share');
});

test('delegated advisor usage cannot dilute executor cache detail or create advisor-only cache detail', () => {
  const executor: SessionCostUsage = {
    role: 'delegated',
    scopeId: 'child',
    model: 'claude-sonnet-5-5',
    provider: null,
    contextWindow: null,
    usage: { requests: 2, input: 2_000, cacheRead: 18_000, cacheWrite1h: 0, cacheWrite5m: 0, output: 20, thinking: 0 },
  };
  const advisor: SessionCostUsage = {
    ...executor,
    usageOrigin: 'claude-advisor',
    usage: { ...executor.usage, requests: 1, input: 95_000, cacheRead: 0, output: 300 },
  };
  const detail = (parts: SessionCostUsage[]) => {
    const projection = sessionCostProjection(parts);
    const lines = projection.stats[0].detailList!.entries.flatMap((entry) => entry.lines ?? []);
    return {
      dollars: projection.total.dollars!,
      hits: lines.flatMap((line) => (typeof line === 'object' && 'cacheHit' in line ? [line.cacheHit] : [])),
    };
  };
  const plain = detail([executor]);
  const advised = detail([executor, advisor]);
  assert.ok(advised.dollars > plain.dollars);
  assert.deepEqual(advised.hits, [{ percent: 90, warning: false, requestScale: [2, 10_000] }]);
  assert.deepEqual(advised.hits, plain.hits);
  assert.deepEqual(detail([advisor]).hits, []);
});

// Unjoined dispatched cost marks the delegated remainder across detail layouts. Independently priced scopes and model entries keep their own totals.

test('each cost popover layout marks the delegated line that holds work not joined yet', () => {
  const usage = {
    requests: 5,
    input: 1_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 0,
    output: 1_000,
    thinking: 0,
  };
  const main = { model: 'claude-opus-5', provider: null, contextWindow: null, role: 'main' as const, usage };
  const warm = { ...main, usage: { ...usage, cacheWrite5m: 900_000 } };
  const scoped = { ...main, role: 'delegated' as const, scopeId: 'invocation:a' };
  const other = { ...main, role: 'delegated' as const };
  const review = { ...other, agent: 'codex' as const, model: 'codex-auto-review', provider: 'openai' };
  const drawn = (parts: Parameters<typeof sessionCostProjection>[0]) => {
    const chip = sessionCostProjection(parts, true).stats[0];
    const heading = chip.detailList?.heading?.value;
    assert.match(typeof heading === 'string' ? heading : '', /[+]$/, 'the heading lost its lower-bound mark');
    return {
      warned: !!chip.warnings?.length,
      lines: Object.fromEntries((chip.detailList?.entries ?? []).map((entry) => [entry.label, entry.value])),
    };
  };
  const alone = drawn([main]);
  assert.equal(alone.lines['Delegated work'], 'cost unavailable');

  const warned = drawn([warm, scoped]);
  assert.ok(warned.warned, 'the fixture raised no cache-write warning');
  assert.equal(warned.lines['Other delegated work'], 'cost unavailable');
  const subagent = Object.entries(warned.lines).find(([label]) => label.startsWith('Subagent 1'));
  assert.ok(subagent, 'the fixture drew no subagent line');
  assert.doesNotMatch(String(subagent[1]), /[+]$/, 'a subagent line that does not hold the pending work drew its mark');
  const unscoped = drawn([warm, scoped, other]).lines['Other delegated work'];
  assert.match(String(unscoped), /^[$][0-9.]+[+]$/, 'the warning layout left the Other delegated work line unmarked');

  // An unpriced delegated remainder reports cost unavailable.
  const unpriced = { ...other, model: 'unknown' };
  assert.equal(
    drawn([main, unpriced]).lines['Delegated work'],
    'cost unavailable',
    'an unpriced Delegated work line lost its mark',
  );
  assert.equal(
    drawn([warm, scoped, unpriced]).lines['Other delegated work'],
    'cost unavailable',
    'an unpriced Other delegated work line lost its mark',
  );

  const reviewed = drawn([main, review]);
  assert.equal(reviewed.lines['Other delegated work'], 'cost unavailable');
  assert.doesNotMatch(String(reviewed.lines['Codex Auto Review']), /[+]$/);
});

test('missing-only usage is unavailable and scope coverage suppresses incomplete cache-write warnings', () => {
  const known = {
    model: 'claude-opus-5',
    provider: null,
    contextWindow: null,
    role: 'main' as const,
    usage: {
      requests: 5,
      input: 1_000,
      cacheWrite1h: 0,
      cacheWrite5m: 900_000,
      cacheRead: 0,
      output: 1_000,
      thinking: 0,
    },
  };
  const missing = {
    ...known,
    incomplete: true,
    usage: { ...known.usage, requests: 1, input: 0, output: 0, cacheWrite5m: 0 },
  };
  assert.deepEqual(sessionCostProjection([missing]), { stats: [], total: { dollars: null, partial: true } });
  assert.deepEqual(sessionCostProjection([{ ...missing, incomplete: false }]).total, { dollars: 0, partial: false });
  const knownTotal = sessionCostProjection([known]).total.dollars;
  assert.equal(sessionCostProjection([known, missing]).total.dollars, knownTotal);
  const delegated = { ...known, role: 'delegated' as const, scopeId: 'source:child' };
  for (const [main, child] of [
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const projection = sessionCostProjection([known, delegated], {
      main,
      delegated: child,
      delegatedScopeIds: new Set(child ? ['source:child'] : []),
    });
    assert.equal(projection.total.partial, true);
    assert.deepEqual(
      (projection.stats[0].warnings ?? []).map((warning) => warning.scope),
      [...(!main ? ['main'] : []), ...(!child ? ['delegated'] : [])],
    );
    const entries = projection.stats[0].detailList!.entries;
    assert.equal(String(entries[0].value).endsWith('+'), main);
    assert.equal(String(entries[1].value).endsWith('+'), child);
  }
});

test('a compaction card words the estimate it priced', () => {
  const at = compaction().at;
  const detail = (over: Partial<Compaction>) =>
    toCompactionCard(compaction({ durationMs: 0, ...over }), NOW).chips.find((chip) => chip.metric === 'cost')
      ?.detail ?? '';
  // A warm estimate reads back what the request before it read and writes what it wrote.
  const warm = detail({
    previousRequest: { tokens: 170_000, cacheRead: 163_000, cacheWrite: 6_998, at: at - 20_000, lifetime: '5m' },
  });
  assert.match(
    warm,
    /Estimated as 163k of cached input reads, 7k of 5-minute cache writes, and 2k of uncached input, because the session was still cached\./,
  );
  assert.match(warm, /Claude Code records no usage for a compaction/);
  // A request before it that missed the cache leaves the warm estimate nothing to read.
  const missed = detail({
    previousRequest: { tokens: 137_049, cacheRead: 0, cacheWrite: 137_047, at: at - 20_000, lifetime: '5m' },
  });
  assert.match(
    missed,
    /Estimated as 137k of 5-minute cache writes and 2k of uncached input, because the request before it read no cached input\./,
  );
  assert.doesNotMatch(missed, /context this small/);
  // A cold estimate reads back the first request's prefix and sends the rest again uncached.
  const lapsed = {
    tokens: 230_090,
    cacheRead: 228_615,
    cacheWrite: 1_473,
    at: at - 10 * 60_000,
    lifetime: '5m' as const,
  };
  const cold = detail({ previousRequest: lapsed, firstRequestCachedTokens: 10_086 });
  assert.match(
    cold,
    /Estimated as 10k of 5-minute cache writes and 222k of uncached input, because the cache had expired and the context was sent again without it\./,
  );
  assert.doesNotMatch(cold, /cached input reads/);
  const coldUnknown = detail({ previousRequest: lapsed });
  assert.match(
    coldUnknown,
    /Estimated as 232k of uncached input, because the cache had expired and the context was sent again without it\./,
  );
  // The summary written is the output the estimate priced, the stored summary text where one is paired.
  assert.match(detail({ previousRequest: lapsed, summaryChars: 22_000 }), /of context sent, 10k summary written\./);
  assert.match(coldUnknown, /of context sent, 14k summary written\./);
  // Another model is priced as one cache read of the recorded context.
  const other = detail({ model: 'gpt-5.5', contextBefore: 400_000, contextAfter: 10_000 });
  assert.match(other, /Estimated as a cache read of the whole context/);
  assert.doesNotMatch(other, /mostly|Claude Code/);
});

test('parent and subagent commits keep distinct complete identities behind a shared visible prefix', () => {
  const parent = subagentCommitTurn();
  parent.agents[0].commits = [parent.agents[0].commits![0]];
  parent.commits = [
    { ...parent.agents[0].commits[0], printedSha: 'abc1234a' + '1'.repeat(32), subject: 'Parent work' },
  ];
  parent.agents[0].commits[0] = {
    ...parent.agents[0].commits[0],
    printedSha: 'abc1234a' + '2'.repeat(32),
    subject: 'Child work',
  };
  const original = structuredClone(parent);
  const card = toCard(parent, false, NOW);
  assert.deepEqual(
    card.commits.map((commit) => [commit.sha, commit.subject, commit.madeBy ?? null]),
    [
      ['abc1234a', 'Parent work', null],
      ['abc1234a', 'Child work', 'Parser reviewer'],
    ],
  );
  assert.deepEqual(parent, original);
  parent.commits[0].printedSha = parent.agents[0].commits[0].printedSha;
  const sameObject = toCard(parent, false, NOW);
  assert.equal(sameObject.commits.length, 1);
  assert.equal(sameObject.commits[0].madeBy, 'Parser reviewer');
  delete parent.commits[0].printedSha;
  assert.equal(toCard(parent, false, NOW).commits.length, 1);
});

// A dispatched session's lifetime usage, priced at one dollar a million input tokens.
const dispatchedPart = (input: number, over: Partial<DispatchedCostUsage> = {}): DispatchedCostUsage => ({
  model: 'claude-haiku-4-5',
  provider: null,
  contextWindow: null,
  usage: {
    requests: 1,
    input,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
  },
  ...over,
});
const dispatchedCost = ({
  parts = [dispatchedPart(2_000_000, { own: true })],
  ...over
}: Partial<DispatchedTurnCost> & { parts?: DispatchedCostUsage[] } = {}): DispatchedTurnCost => ({
  sessionId: 'child',
  name: 'Fix the parser',
  costs: priceDispatchedParts(parts),
  short: false,
  ownSettledAt: null,
  ...over,
});
const costFigure = (card: TurnCard) => card.chips.find((chip) => chip.metric === 'cost')!;

test('dispatched cost movement identifies only drawn cards whose contribution or discovery answer changed', () => {
  const original = dispatchedCost();
  const print = (costs = [original], hydrated = true, pending = false) => dispatchedCostPrint(costs, hydrated, pending);
  const drawn = new Map([
    ['parent:1', print()],
    ['other:1', print()],
  ]);
  for (const changed of [
    print([dispatchedCost({ parts: [dispatchedPart(3_000_000)] })]),
    print([{ ...original, short: true }]),
    print([{ ...original, ownSettledAt: NOW }]),
    print([original], false),
    print([original], true, true),
  ]) {
    assert.deepEqual(
      movedDispatchedCards(
        drawn,
        new Map([
          ['parent:1', changed],
          ['other:1', print()],
          ['new:1', changed],
        ]),
      ),
      ['parent:1'],
    );
  }
  assert.deepEqual(movedDispatchedCards(drawn, drawn), []);
});

test('a dispatched session waiting for input remains running on its row', () => {
  assert.equal(dispatchedState('waiting'), 'running');
  assert.equal(dispatchedState('done'), 'done');
});

test('the turn cost adds each dispatched session the card counts, and the session heading does not', () => {
  const t = turn();
  const own = turnCost(t).dollars!;
  const card = toCard(t, false, NOW, [], null, false, new Set(), [dispatchedCost()]);
  const figure = costFigure(card);
  const sum = `$${(own + 2).toFixed(2)}`;
  assert.equal(figure.label, sum);
  assert.equal(figure.detailList?.heading?.value, sum);
  assert.deepEqual(figure.detailList?.entries.at(-1)?.label, 'Fix the parser');
  assert.equal(figure.detailList?.entries.at(-1)?.value, '$2.00');
  assert.ok(figure.name?.includes('Fix the parser: $2.00'), 'the spoken name left out the dispatched session');
  assert.ok(card.label.includes('Fix the parser: $2.00'), 'the card label left out the dispatched session');
  assert.deepEqual(sessionStats([t], []), sessionStats([turn()], []), 'the turns-read total took the dispatched cost');
  assert.equal(turnCost(t).dollars, own, 'turnCost took the dispatched cost');
});

test('a dispatched share marks the turn cost as a lower bound when it is short or partial', () => {
  const short = toCard(turn(), false, NOW, [], null, false, new Set(), [dispatchedCost({ short: true })]);
  assert.match(costFigure(short).label, /[+]$/);
  assert.match(String(costFigure(short).detailList!.heading!.value), /[+]$/);
  assert.equal(costFigure(short).detailList?.entries.at(-1)?.value, '$2.00+');
  for (const part of [
    dispatchedPart(1_000_000, { incomplete: true }),
    dispatchedPart(1_000_000, { unclassifiedCacheWrite: 5 }),
  ]) {
    assert.equal(turnCardCost(turn(), [dispatchedCost({ parts: [part] })]).partial, true);
  }
  assert.equal(turnCardCost(turn(), [dispatchedCost()]).partial, false);
});

test('a dispatched share adds the session total notes for its compactions and auto reviews', () => {
  const list = (part: DispatchedCostUsage) =>
    costFigure(toCard(turn(), false, NOW, [], null, false, new Set(), [dispatchedCost({ parts: [part] })])).detailList!;
  const notes = (part: DispatchedCostUsage) => list(part).notes!.join(' ');
  // The compaction estimate stays in the visible footer.
  assert.match(
    (list(dispatchedPart(1_000_000, { compactionEstimate: true })).footer ?? []).join(' '),
    /estimated \$1\.00 for /,
  );
  assert.match(
    notes({ ...dispatchedPart(1_000_000), model: 'codex-auto-review', provider: 'openai', inferenceClass: 'global' }),
    /Codex Auto Review uses the OpenAI Codex rate card/,
  );
});

// A Codex turn that ran `claude -p --resume child` holds a print row with the child's id, which
// the child's lifetime usage also holds.
test('a print row of a dispatched session keeps its amount and is not counted twice', () => {
  const print = (invocationId: string) =>
    agent({
      id: 'child',
      description: 'Claude CLI',
      agentType: 'claude-cli',
      spendFound: true,
      invocationId,
      spend: [{ model: 'claude-haiku-4-5', usage: dispatchedPart(500_000).usage }],
    });
  for (const rows of [[print('a')], [print('a'), print('b')]]) {
    const t = turn({ agent: 'codex', provider: 'openai', agents: rows });
    const own = turnCost(t).dollars!;
    const printed = rows.length * 0.5;
    const settled = dispatchedCost({ ownSettledAt: t.startedAt });
    const figure = costFigure(toCard(t, false, NOW, [], null, false, new Set(), [settled]));
    assert.equal(figure.label, `$${(own + 2 - printed).toFixed(2)}`, `${rows.length} print rows counted again`);
    const entries = figure.detailList!.entries;
    assert.equal(entries.filter((entry) => entry.value === '$0.50').length, rows.length, 'a print row lost its amount');
    assert.equal(entries.at(-1)?.value, `$${(2 - printed).toFixed(2)}`);
    assert.equal(entries.at(-1)?.lines, undefined, 'a reduced share drew the whole session lines');
    // Without settled own usage, printed child requests remain counted separately. Other dispatched contributions remain included.

    for (const [unsettled, rest] of [
      [dispatchedCost({ short: true, parts: [] }), 0],
      [dispatchedCost({ parts: [dispatchedPart(2_000_000)], ownSettledAt: t.startedAt }), 2],
      [dispatchedCost({ ownSettledAt: null }), 0],
      [dispatchedCost({ ownSettledAt: t.startedAt - 1 }), 0],
      // Priced descendants cannot stand in for own requests that have no price.
      [
        dispatchedCost({
          parts: [dispatchedPart(1_000_000, { own: true, model: 'unpriced-model' }), dispatchedPart(2_000_000)],
          ownSettledAt: t.startedAt,
        }),
        2,
      ],
    ] as const) {
      const label = costFigure(toCard(t, false, NOW, [], null, false, new Set(), [unsettled])).label;
      assert.equal(label, `$${(own + rest).toFixed(2)}+`);
    }
  }
});

test('a card that counts a dispatched session shows its cost when the turn prices nothing of its own', () => {
  const base = turn();
  const zero = Object.fromEntries(Object.keys(base.usage).map((key) => [key, 0])) as unknown as Turn['usage'];
  for (const [t, why] of [
    [turn({ usage: zero, agents: [] }), 'a turn with no usage'],
    [turn({ model: 'unpriced-model', agents: [] }), 'a turn with no price'],
  ] as const) {
    assert.equal(costFigure(toCard(t, false, NOW)), undefined, `${why} drew a cost on its own`);
    for (const [cost, label] of [
      [dispatchedCost({ short: true, parts: [] }), '$0.00+'],
      [dispatchedCost({ parts: [dispatchedPart(1_000_000, { model: 'unpriced-model' })] }), '$0.00+'],
    ] as const) {
      const figure = costFigure(toCard(t, false, NOW, [], null, false, new Set(), [cost]));
      assert.equal(figure?.label, label, `${why}: the figure hid the dispatched session`);
      assert.equal(figure?.detailList?.heading?.value, label, why);
      assert.deepEqual(
        [figure?.detailList?.entries.at(-1)?.label, figure?.detailList?.entries.at(-1)?.value],
        ['Fix the parser', '$0.00+'],
        why,
      );
    }
  }
});

test('the cost entry of a dispatched session takes the name its Dispatched row shows', () => {
  const t = turn({ sessionId: 'parent', agents: [] });
  const receipt = (toolUseId: string, name: string) => ({
    kind: 'dispatch',
    parentSessionId: 'parent',
    sessionId: 'child',
    toolUseIds: [toolUseId],
    name,
  });
  const references = [receipt('a', 'First name'), receipt('b', 'Second name')];
  // The Dispatched row keeps the last reference on the card for each session.
  const row = [...new Map(references.map((reference) => [reference.sessionId, reference])).values()][0];
  const counted = countedDispatchReferences(references, t, new Set(['a', 'b']));
  assert.deepEqual(
    counted.map(({ reference }) => reference.name),
    [row.name],
  );
  // A later card that holds the second receipt alone counts nothing.
  assert.deepEqual(countedDispatchReferences(references, t, new Set(['b'])), []);
});

test('background usage preserves recorded cache-write warnings in main and delegated scopes', () => {
  const recorded = {
    agent: 'claude',
    role: 'main' as const,
    model: 'claude-haiku-4-5',
    provider: null,
    contextWindow: null,
    usage: {
      requests: 5,
      input: 100,
      output: 10,
      thinking: 0,
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 10_000_000,
    },
  };
  for (const role of ['main', 'delegated'] as const) {
    const part = { ...recorded, role, ...(role === 'delegated' ? { scopeId: 'source:child' } : {}) };
    const baseline = sessionCostProjection([part], true).stats[0].warnings;
    assert.equal(baseline?.length, 1);
    for (const model of ['claude-haiku-4-5', 'unknown']) {
      const background = {
        ...part,
        model,
        usageOrigin: 'claude-cost-state' as const,
        requestCountExact: false as const,
        usage: { ...part.usage, requests: 0, cacheWrite5m: 0, input: 100 },
      };
      assert.deepEqual(sessionCostProjection([part, background], true).stats[0].warnings, baseline);
    }
  }
});

test('the next-turn basis reads request effort independently of later turn effort', () => {
  const held = turn({
    contextTokens: 620000,
    effort: 'low',
    contextRequest: { ...CONTEXT_REQUEST, effort: 'high', bedrock: true },
  });
  assert.equal(nextTurnBasisOf(held, null)?.effort, 'high');
  assert.equal(nextTurnBasisOf(held, null)?.bedrock, true);
  assert.equal(nextTurnBasisOf({ ...held, contextRequest: CONTEXT_REQUEST }, null)?.effort, null);
});

function subagentResultsEntry(chips: readonly { metric?: string; detailList?: StatDetailList }[]) {
  const entries = chips.find((chip) => chip.metric === 'context')?.detailList?.entries ?? [];
  return { entries, entry: entries.find((entry) => entry.label === 'Subagent results') };
}

test('the context chip shows the subagent results in context at the end of each turn', () => {
  const lines = [
    { name: 'Fix the stale cache key in the usage reducer', tokens: 3800 },
    { name: 'Review the parser', tokens: 1000 },
    { name: 'Find the fixtures', tokens: 800 },
  ];
  const card = toCard(
    turn({
      contextTokens: 120_000,
      contextWindow: 200_000,
      subagentContext: { tokens: 12_400, partial: false, removed: false, agents: lines },
    }),
    false,
    Date.now(),
  );
  const { entries, entry } = subagentResultsEntry(card.chips);
  assert.equal(entries.at(-1), entry, 'the entry is last');
  assert.deepEqual(entry, {
    label: 'Subagent results',
    value: '10% (12k)',
    valueTitle: '12,400 tokens, estimate',
    lines: [
      'Fix the stale cache key in the usage reducer: 4k tokens (3.2%)',
      'Review the parser: 1k tokens (0.8%)',
      'Find the fixtures: 800 tokens (0.7%)',
    ],
  });

  const none = toCard(turn({ contextTokens: 120_000, contextWindow: 200_000 }), false, Date.now());
  assert.equal(subagentResultsEntry(none.chips).entry, undefined, 'a session without subagents shows no entry');
  for (const context of [
    { contextWindow: 200_000 },
    { contextWindow: null, model: 'claude-sonnet-5' },
    { contextWindow: null, model: 'unknown' },
    { contextWindow: 100_000 },
    { contextWindow: 200_000, contextTokens: 0 },
  ]) {
    for (const subagentContext of [undefined, { tokens: 12_400, partial: false, removed: false, agents: lines }]) {
      const chips = toCard(turn({ contextTokens: 120_000, ...context, subagentContext }), false, Date.now()).chips;
      const list = chips.find((chip) => chip.metric === 'context')?.detailList;
      const { entry } = subagentResultsEntry(chips);
      assert.equal(!!list?.notes?.includes('Estimated from text size.'), !!entry);
      if (list) {
        const recorded = context.contextWindow === 200_000;
        const notes = [
          ...(recorded ? ['Recorded context window size.'] : []),
          ...(entry ? ['Estimated from text size.'] : []),
        ];
        assert.deepEqual(list.notes, notes.length ? notes : undefined);
        assert.deepEqual(
          list.footer,
          context.model === 'claude-sonnet-5' ? ['Window size from the model fallback for sonnet-5.'] : undefined,
        );
      }
    }
  }
});

test('the subagent results entry caps its lines, marks a partial figure and reports a compaction', () => {
  const agents = Array.from({ length: 12 }, (_, index) => ({
    name: `Subagent ${index + 1}`,
    tokens: 2000 - index * 100,
  }));
  const many = toCard(
    turn({
      contextTokens: 120_000,
      contextWindow: 200_000,
      subagentContext: { tokens: 18_600, partial: true, removed: false, agents },
    }),
    false,
    Date.now(),
  );
  const { entry } = subagentResultsEntry(many.chips);
  assert.equal(entry?.value, '16% (19k)');
  assert.equal(entry?.valueTitle, '18,600 tokens, estimate');
  assert.deepEqual(entry?.lines, [
    'Subagent 1: 2k tokens (1.7%)',
    'Subagent 2: 2k tokens (1.6%)',
    'Subagent 3: 2k tokens (1.5%)',
    'Subagent 4: 2k tokens (1.4%)',
    'Subagent 5: 2k tokens (1.3%)',
    '7 more: 8k tokens (7%)',
    'Part of the session record was not read.',
  ]);

  const compacted = toCard(
    turn({
      contextTokens: 30_000,
      contextWindow: 200_000,
      subagentContext: { tokens: 0, partial: false, removed: true, agents: [] },
    }),
    false,
    Date.now(),
  );
  assert.deepEqual(subagentResultsEntry(compacted.chips).entry?.value, '0% (0)');
  assert.equal(subagentResultsEntry(compacted.chips).entry?.valueTitle, 'No subagent results in context');
  assert.deepEqual(subagentResultsEntry(compacted.chips).entry?.lines, [
    'The latest compaction removed earlier results.',
  ]);
});

test('the session heading context chip shows the current subagent results last', () => {
  const figure = { tokens: 4000, partial: false, removed: false, agents: [{ name: 'Reviewer', tokens: 4000 }] };
  const older = turn({ startedAt: 1000, endedAt: 2000, contextTokens: 50_000, contextWindow: 200_000 });
  const newest = turn({
    startedAt: 3000,
    endedAt: 4000,
    contextTokens: 80_000,
    contextWindow: 200_000,
    subagentContext: figure,
  });
  const chips = withSessionContextDetail(sessionStats([older, newest], []), {
    entries: [{ label: 'Latest compaction', value: 'Automatic' }],
  });
  const { entries, entry } = subagentResultsEntry(chips);
  assert.equal(entries.at(-1), entry, 'the entry stays after the latest compaction');
  assert.equal(entry?.value, '5% (4k)', 'the share is of the current context');
  assert.deepEqual(entry?.lines, ['Reviewer: 4k tokens (5%)']);
  assert.equal(chips.find((chip) => chip.metric === 'context')?.detailList?.notes?.at(-1), 'Estimated from text size.');

  const after = sessionStats([newest], [compaction({ at: 5000, contextAfter: 20_000 })]);
  assert.equal(subagentResultsEntry(after).entry?.value, '0% (0)', 'a later compaction removed the results');
});

test('the session heading keeps the subagent results a later compaction retained', () => {
  const newest = turn({
    startedAt: 3000,
    endedAt: 4000,
    contextTokens: 80_000,
    contextWindow: 200_000,
    subagentContext: { tokens: 4000, partial: false, removed: false, agents: [{ name: 'Reviewer', tokens: 4000 }] },
  });
  const kept = { tokens: 27, partial: false, removed: false, agents: [{ name: 'Reviewer', tokens: 27 }] };
  const chips = sessionStats([newest], [compaction({ at: 5000, contextAfter: 20_000, subagentContext: kept })]);
  const { entry } = subagentResultsEntry(chips);
  assert.equal(entry?.value, '0.1% (27)');
  assert.deepEqual(entry?.lines, ['Reviewer: 27 tokens (0.1%)']);
});

test('the session list hover text leaves out the subagent results', () => {
  const figure = { tokens: 4000, partial: false, removed: false, agents: [{ name: 'Reviewer', tokens: 4000 }] };
  const chips = sessionStats([turn({ contextTokens: 80_000, contextWindow: 200_000, subagentContext: figure })], []);
  const context = chips.find((chip) => chip.metric === 'context');
  assert.ok(subagentResultsEntry(chips).entry, 'the context chip popover keeps the entry');
  assert.ok(context?.detail?.includes('Latest recorded context'));
  assert.ok(!context?.detail?.includes('Subagent results'), context?.detail);
  assert.ok(!context?.detail?.includes('Reviewer'), context?.detail);
  assert.ok(!context?.detail?.includes('Estimated from text size.'), context?.detail);
});

test('the file actions select the same rows the card displays, and the card carries no edit text', () => {
  const childFile = (path: string) => ({ path, added: 1, removed: 0, isNew: false });
  const artifacts = (paths: string[], revision: string) => ({
    files: paths.map(childFile),
    commits: [],
    complete: true,
    revision,
  });
  const creator = agent({
    description: 'Create the notes',
    artifacts: artifacts(['c:/repo/shared.ts', 'C:/Repo/Child.md', '/repo/posix.md'], 'a'),
  });
  const editor = agent({ description: 'Edit the notes', artifacts: artifacts(['C:/Repo/Child.md'], 'b') });
  const subject = turn({
    files: [
      {
        path: 'C:/Repo/Shared.ts',
        added: 1,
        removed: 0,
        isNew: false,
        edits: [{ hunks: [], originalFile: 'parent text before', content: 'parent text after', isCreate: false }],
      },
      { path: '/Repo/Posix.md', added: 1, removed: 0, isNew: false, edits: [] },
    ],
    agents: [creator, editor],
  });
  const card = toCard(subject, false, NOW);
  const rows = turnFileContributors(subject);
  assert.deepEqual(
    rows.map((row) => row.path),
    card.files.map((file) => file.path),
  );
  // A drive path compares without case on every platform. A rooted POSIX path compares without case only on Windows.
  const posixRows = { win32: 1, darwin: 2, linux: 2 }[process.platform as 'win32' | 'darwin' | 'linux'];
  assert.equal(rows.filter((row) => row.path.toLowerCase() === '/repo/posix.md').length, posixRows);
  assert.deepEqual(
    rows.map((row) => [row.parent !== null, row.agents.map((one) => one.description)]),
    [
      [true, ['Create the notes']],
      [true, posixRows === 1 ? ['Create the notes'] : []],
      [false, ['Create the notes', 'Edit the notes']],
      ...(posixRows === 1 ? [] : [[false, ['Create the notes']]]),
    ],
  );
  assert.ok(!JSON.stringify(card).includes('parent text'), 'the card payload carries recorded edit text');
});
