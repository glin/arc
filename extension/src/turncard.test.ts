// extension/src/turncard.test.ts
//
// The tests for turncard.ts. One that reads a second seam's names lives in turnview.test.ts
// instead, because neither file owns it. The builders a test is written against are here
// while only this file needs them, and in turnfixtures.ts once a second file does.
import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { readCodexAgentSpend, refreshCodexStructuralAgents } from './codex.ts';
import { AgentSpendCache, readChildSpend, spendFileVersion } from './agentspend.ts';
import { tempDir } from './temproot.ts';
import * as pricing from './pricing.ts';
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
  sessionCompactionContextDetail,
  sessionCostProjection,
  sessionCostStats,
  sessionStats,
  sessionStatsFromFacts,
  saidMessagesOf,
  sessionTurnStats,
  statusOf,
  stepCode,
  stepFigure,
  stepLine,
  toCard,
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
import type { StatDetailLine, TurnCard } from './turncard.ts';
import type { TurnStep } from './transcript.ts';
import { answerPart, commentAnchorText } from './turncomments.ts';
import { formatWhen } from './turnformat.ts';
import {
  COMPACTION_SAMPLES,
  NOW,
  claudeCompactionTranscript,
  compaction,
  counts,
  recordCommit,
  recordLanding,
  skillUse,
  subagentCommitTurn,
  turn,
} from './turnfixtures.ts';
import { commitRowSpoken, commitRowTitle } from './webview/card-rows.ts';
import { reduceChildArtifacts } from './childartifacts.ts';
import { exposeClaudeAgentRelationshipIds } from './progressiveworker-entry.ts';
import type { ChildArtifacts } from './childartifacts.ts';
import { normalizeFsPath, sameCommitSha } from './transcript.ts';
// The page fixture the panel's own pictures and measurements are drawn from.
import { FIXTURE_CLOCK, FIXTURE_TURNS, LONG_TURN_INDEX } from './panelfixture.ts';
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
    returns: [{ lifetime: '30m', gapMs: 31 * 60 * 1000, request: economicRequest() }],
    excluded: 2,
    unavailable: 0,
    truncated: false,
  };
  const chip = sessionCacheExpiryStats(exact)[0];
  assert.equal(chip.label, '3 cache expiries');
  assert.equal(chip.focusable, true);
  assert.deepEqual(
    chip.detailList?.entries.map((entry) => entry.label),
    ['Cache lifetimes', 'Input cost on affected requests', 'Longest qualifying gap', 'Excluded ambiguous events'],
  );
  assert.match(chip.detail, /Longest qualifying gap: 1d 2h/);
  assert.ok(chip.detail.includes('The record does not identify every cache-key change.'));
  const lower = sessionCacheExpiryStats({
    ...exact,
    returns: [
      ...exact.returns,
      { lifetime: '1h', gapMs: 61 * 60 * 1000, request: economicRequest({ reportedCost: 4.1 }) },
    ],
  })[0];
  assert.match(lower.detail, /Input cost on affected requests: At least \$/);
  assert.ok(!lower.detail.includes('recommend'));
});

// The Rail's `cache-expiry:` filter reads this count as exact whenever the classifier judged
// every adjacent pair. An unjudged pair may itself have been a qualifying return the count has
// not added in, so a fact carrying any `unavailable` pairs must mark its count as a floor the
// same way `SessionCostTotal.partial` marks an unpriced cost total.
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

test('latest compaction maps supported triggers and collapses every other value to unknown', () => {
  const value = (trigger: string | null) =>
    sessionCompactionContextDetail([compactionFact({ trigger })])?.entries[0].value;
  assert.equal(value('manual'), 'Manual');
  assert.equal(value('auto'), 'Automatic');
  assert.equal(value('scheduled'), 'Unknown');
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
    [
      '22 turns in the main session',
      '1m between the first and last turns',
      'Context compacted 3 times',
      'Latest compaction',
      'About these figures',
    ],
  );
  assert.equal(merged.detailList?.entries.at(-2)?.value, 'Automatic');
  assert.equal(
    merged.detail,
    [
      '22 turns in the main session',
      '1m between the first and last turns',
      'Context compacted 3 times',
      'Latest compaction: Automatic',
      '',
      'About these figures',
      '  The turn count excludes delegated work.',
      '  Elapsed time includes gaps between turns.',
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

// The whole row as a reader hears it. The words and the literal are drawn as two elements
// side by side, and they read out in that order, so a wording guard reads them joined.
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

// The cost reaches the panel as a chip, so that is where a test reads it from.
const costChip = (card: TurnCard): string | undefined => card.chips.find((c) => c.label.startsWith('$'))?.label;

// The context chip reaches the panel as a chip too, so a test reads it the same way.
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
    card.chips.find((chip) => chip.metric === 'cost')?.warnings?.map((warning) => warning.id),
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

// The four bands, three of them toned. A colour reads out as nothing, so each band is read
// through its word and its hover sentence as well as through the level the panel tones by.
const bandAt = (share: number) => {
  const window = 1_000_000; // opus-5
  const chip = ctxChip(toCard(turn({ contextTokens: Math.round(window * share) }), false, NOW))!;
  return { level: chip.level, word: chip.word, kind: chip.kind, detail: chip.detail };
};

// The marks a card ends up with, by id. What is drawn is the character beside each id, and
// the order is the table's, so reading ids back tests both.
const markIds = (over: Partial<Turn>) => toCard(turn(over), false, NOW).marks.map((m) => m.id);

const changed = (path: string, added: number, removed: number) => ({ path, added, removed, isNew: false, edits: [] });

// The chips and the marks a card carries, read off one built from a summary with the two
// reader-facing rows written out.
const closingCard = (rows: string[]) => {
  const card = toCard(turn({ summary: ['- The work landed.', '', ...rows].join('\n') }), false, NOW);
  return {
    labels: card.chips.map((c) => c.label),
    kinds: card.chips.map((c) => c.kind),
    marks: card.marks.map((m) => m.id),
  };
};

// The figures a session heading carries. Each expected number below is worked out by hand
// beside the input rather than by calling the code under test a second time: two sums built
// from one mistake agree with each other and the check passes.
const statOf = (chips: { label: string; detail: string; added?: number; removed?: number }[], starts: string) =>
  chips.find((c) => c.label.startsWith(starts));

// The sentence that says what to do about a crowded session. It rides the session
// heading's context chip alone, from the second band up.
const COMPACT_HERE = 'This is a place to compact, or to hand the work to a fresh session.';

const sessionCtxDetail = (share: number) => {
  const window = 1_000_000; // opus-5
  const held = turn({
    contextTokens: Math.round(window * share),
    startedAt: 9_000,
    endedAt: 9_500,
    summary: '- The work landed.',
  });
  return sessionStats([held], [])
    .find((c) => c.label.includes('ctx'))!
    .detail.split('\n')
    .map((line) => line.trim());
};

// The two facts the session heading's context chip carries on its hover, beside the level it
// already reported. Both are drawn wherever the figures exist, not only on a crowded session.
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
  // The rule the CLI's own context report follows. A figure a point under the CLI's reads
  // as a second measurement of the same window rather than as a second rounding of it.
  assert.equal(wholePercent(0.4989), 50);
  assert.equal(wholePercent(0.735), 74);
  assert.equal(wholePercent(0.104), 10);
  // The two ends are absolutes and are held back from rounding. A window with a few
  // thousand tokens left in it is not full, and one with a few thousand in it is not empty.
  assert.equal(wholePercent(0.999), 99);
  assert.equal(wholePercent(1), 100);
  assert.equal(wholePercent(0.0004), 1);
  assert.equal(wholePercent(0), 0);
  // A share past the window passes through: an overrun says so rather than reading as full.
  assert.equal(wholePercent(1.5), 150);
  // And nothing under zero is a figure at all.
  assert.equal(wholePercent(-0.2), 0);
});

test('every mark is one character and one id, and no two share either', () => {
  // Two marks on one character draw the same thing for different reasons, and two on one id
  // means one of them can never be earned. Neither shows up as a failure anywhere else.
  assert.equal(new Set(MARKS.map((m) => m.id)).size, MARKS.length);
  assert.equal(new Set(MARKS.map((m) => m.character)).size, MARKS.length);
  assert.ok(
    MARKS.every((m) => m.word.trim().length),
    'a mark with no word is silent to a screen reader',
  );
});

test('a symbol is read as one character, joined sequence and all, and taken off whole', () => {
  // Read as characters, not as the pairs a string is stored in: a raised hand is two of
  // those pairs, and reading the first alone finds half a character and no symbol.
  assert.equal(leadingSymbol('\u{1F64B} Your turn.'), '\u{1F64B}');
  assert.equal(withoutLeadingSymbol('\u{1F64B} Your turn.'), 'Your turn.');
  // The selector after a symbol belongs to it and goes with it.
  assert.equal(leadingSymbol('⚠️ Careful.'), '⚠');
  assert.equal(withoutLeadingSymbol('⚠️ Careful.'), 'Careful.');
  // A joined sequence marks as the symbol it is built on, and none of what it is joined to
  // is left behind: a stray gender sign at the head of the name is read out as "male sign".
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
  // Reachable without doing anything unusual: a headline opens with an emoji whenever the
  // summary's first line does, and every line of the summary format does.
  // A high surrogate with no low surrogate after it is half a character, and a tab draws it
  // as an empty box.
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
  // The store writes backslashes and the transcript writes forward slashes, so a row can
  // arrive in either shape and both have to split.
  assert.deepEqual(distinctNames(['c:\\repo\\a\\index.ts', 'c:/repo/b/index.ts']), ['a/index.ts', 'b/index.ts']);
  // Two rows for one path cannot be told apart by their path, so this settles rather than
  // growing for ever.
  assert.deepEqual(distinctNames(['c:/repo/a.ts', 'c:/repo/a.ts']), ['c:/repo/a.ts', 'c:/repo/a.ts']);
  assert.deepEqual(distinctNames([]), []);
});

test('a file no open folder holds is drawn by its whole path, and said as one too', () => {
  const inside = 'c:/repo/src/store.ts';
  const outside = 'c:/Users/dev/AppData/Local/Temp/scratch/notes.md';
  // One folder open: the file under it keeps its basename, and the one outside it cannot,
  // because a scratch `notes.md` and a repository `notes.md` read the same.
  assert.deepEqual(fileRowNames([inside, outside], ['c:/repo']), [
    { name: 'store.ts', spoken: 'store.ts' },
    { lead: 'c:/Users/dev/AppData/Local/Temp/scratch/', name: 'notes.md', spoken: outside },
  ]);
  // Two folders open: a file under either is inside, and two basenames that collide still
  // grow leftwards until they are distinct.
  assert.deepEqual(fileRowNames(['c:/repo/src/index.ts', 'c:/other/src/index.ts', outside], ['c:/repo', 'c:/other']), [
    { name: 'index.ts', spoken: 'repo/src/index.ts' },
    { name: 'index.ts', spoken: 'other/src/index.ts' },
    { lead: 'c:/Users/dev/AppData/Local/Temp/scratch/', name: 'notes.md', spoken: outside },
  ]);
  // The folder itself is inside it, which is the case `isInside` names and the one a rule
  // written as a prefix test alone would answer wrongly.
  assert.deepEqual(fileRowNames(['c:/repo'], ['c:/repo']), [{ name: 'repo', spoken: 'repo' }]);
  // A sibling folder whose name starts with the open one's is not inside it.
  assert.deepEqual(fileRowNames(['c:/repo-two/a.ts'], ['c:/repo']), [
    { lead: 'c:/repo-two/', name: 'a.ts', spoken: 'c:/repo-two/a.ts' },
  ]);
  // With nothing open there is nothing to be outside of, so every row says the smaller
  // thing rather than guessing that every file is foreign.
  assert.deepEqual(fileRowNames([inside, outside], []), [
    { name: 'store.ts', spoken: 'store.ts' },
    { name: 'notes.md', spoken: 'notes.md' },
  ]);
});

test('the inside test reads a path in either spelling, and the drive letter in either case', () => {
  // The store writes backslashes and the transcript writes forward slashes, and the folder
  // arrives from the editor in a third shape again, so every pairing has to answer the same.
  assert.deepEqual(fileRowNames(['c:\\repo\\src\\store.ts'], ['c:/repo']), [{ name: 'store.ts', spoken: 'store.ts' }]);
  assert.deepEqual(fileRowNames(['c:/repo/src/store.ts'], ['c:\\repo']), [{ name: 'store.ts', spoken: 'store.ts' }]);
  assert.deepEqual(fileRowNames(['C:/repo/src/store.ts'], ['c:/repo']), [{ name: 'store.ts', spoken: 'store.ts' }]);
  // And a file genuinely outside stays outside in both spellings. What is drawn and what is
  // announced come back in the one spelling the panel uses, whichever it arrived in.
  const outside = 'c:\\Users\\dev\\AppData\\Local\\Temp\\notes.md';
  assert.deepEqual(fileRowNames([outside], ['c:/repo']), [
    { lead: 'c:/Users/dev/AppData/Local/Temp/', name: 'notes.md', spoken: 'c:/Users/dev/AppData/Local/Temp/notes.md' },
  ]);
});

test('only the rows that will draw a basename are told apart from one another', () => {
  // The second row is outside the open folder, so it is drawn and announced by its whole
  // path and never by a basename. Growing the first one to be distinct from it hangs a
  // directory on a row the reader can neither see nor hear that directory on.
  assert.deepEqual(fileRowNames(['c:/repo/notes.md', 'c:/temp/notes.md'], ['c:/repo']), [
    { name: 'notes.md', spoken: 'notes.md' },
    { lead: 'c:/temp/', name: 'notes.md', spoken: 'c:/temp/notes.md' },
  ]);
  // Two rows that do draw a basename still grow, and a path row sitting between them does
  // not shift the grown names onto the wrong rows.
  assert.deepEqual(fileRowNames(['c:/repo/a/index.ts', 'c:/temp/index.ts', 'c:/repo/b/index.ts'], ['c:/repo']), [
    { name: 'index.ts', spoken: 'a/index.ts' },
    { lead: 'c:/temp/', name: 'index.ts', spoken: 'c:/temp/index.ts' },
    { name: 'index.ts', spoken: 'b/index.ts' },
  ]);
});

test('a row drawn by its whole path hands over the directory and the filename separately', () => {
  const outside = 'c:/Users/dev/AppData/Local/Temp/scratch/notes.md';
  // The row truncates on the right. Handed one string it cuts the filename off first, and
  // the filename is the part that says which file the row is, so the two pieces are split
  // here and the row draws the directory as the piece that gives way.
  assert.deepEqual(fileRowNames([outside], ['c:/repo']), [
    { lead: 'c:/Users/dev/AppData/Local/Temp/scratch/', name: 'notes.md', spoken: outside },
  ]);
  // A path recorded with backslashes is cut into the same two pieces, in the spelling the
  // panel draws: the row's hover carries that same spelling, and the two have to read alike.
  const back = 'c:\\Users\\dev\\AppData\\Local\\Temp\\notes.md';
  assert.deepEqual(fileRowNames([back], ['c:/repo']), [
    { lead: 'c:/Users/dev/AppData/Local/Temp/', name: 'notes.md', spoken: 'c:/Users/dev/AppData/Local/Temp/notes.md' },
  ]);
  // A row drawn by its basename is one piece, exactly as it always was.
  assert.deepEqual(fileRowNames(['c:/repo/src/store.ts'], ['c:/repo']), [{ name: 'store.ts', spoken: 'store.ts' }]);
  // And so is a path with no directory in front of the filename.
  assert.deepEqual(fileRowNames(['notes.md'], ['c:/repo']), [{ name: 'notes.md', spoken: 'notes.md' }]);
});

test('every control the panel can be operated with has something to be called', () => {
  // Some entries are a table of their own, one word per scope or state. The leaves are the
  // labels, so the walk goes through a table rather than stopping at it and calling the
  // object a string that reads out as nothing.
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
  assert.equal(CARD_ACTIONS.expandAllTurns, 'Expand every shown turn');
  assert.equal(CARD_ACTIONS.collapseAllTurns, 'Collapse every shown turn');
});

// What the turn is waiting on the reader for. Every answer below is hand-written from the
// row as a reader would read it, never from what the parser returned, so a reader that
// starts missing a row fails here rather than agreeing with itself.
test('a row that says it holds nothing is not something waiting on the reader', () => {
  // All four are copied from summaries in the store. Before the format left an empty row
  // out, this was how every turn with nothing outstanding wrote one.
  const nothing = [
    'none blocking. Items 1 and 2 can start whenever the other session frees turnview.ts.',
    'None for me. Both decisions are settled and recorded.',
    'nothing right now; I will report when the icons land.',
    'none open.',
  ];
  for (const text of nothing) {
    assert.equal(waitingOn(`- 🙋 **Your actions** — ${text}`).needsYou, false, text);
  }
  // And the other way: a row with something in it is waiting, including one that says what
  // is not blocked as well as what is.
  const waiting = [
    'reload the window, then open a turn and confirm the badge.',
    'decide the icon question above; nothing else is blocked on you.',
    'answer the two open questions below so phase 1 can start',
  ];
  for (const text of waiting) {
    assert.equal(waitingOn(`- 🙋 **Your actions** — ${text}`).needsYou, true, text);
  }
  // A word that begins with one of the negations is not one of them. Without the boundary
  // this row reads as holding nothing and the turn drops out of the filter.
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
  // No numbering, so no number: the row is badged without one rather than with a guess.
  assert.equal(enumeratedCount('whether to keep the store, and what to call it.'), null);
  assert.equal(enumeratedCount('the three above.'), null);
  // A lone marker is prose far more often than it is a list of one.
  assert.equal(enumeratedCount('only one thing: (1) the store.'), null);
  // A run that does not start at one, or skips, is not a count of anything.
  assert.equal(enumeratedCount('as in (2) and (3) above'), null);
  assert.equal(enumeratedCount('(1) first (3) third'), null);
});

test('a session with no turns read has nothing to say about itself', () => {
  assert.deepEqual(sessionStats([], []), []);
});

test('the log names a mid-turn prompt without printing the whole of it twice', () => {
  // The text itself is drawn under "You asked". A log row is a pointer to it, one line, cut
  // the way a long command is, so a paragraph typed mid-turn cannot turn the log into prose.
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
  // A glyph and a badge say nothing to a reader who cannot see them, so the head row's own
  // name carries the agent as a word beside the model.
  assert.match(codex.label, /Codex gpt-5\.6-sol high/);
  assert.match(claude.label, /Claude opus-5/);
});

test('a Codex turn that ran commands and recorded no files is marked as a gap, and a Claude one is not', () => {
  const ran = { toolCounts: counts({ commands: 6 }), files: [] };
  const gap = (t: Turn) => toCard(t, false, NOW).marks.some((m) => m.id === 'gap');
  assert.equal(gap(turn({ agent: 'codex', ...ran })), true);
  // Claude Code records every edit, so the same turn there changed nothing and the card can
  // say so without a caveat.
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
  // A Codex turn that ran no command wrote no file by any route the panel cannot see.
  assert.equal(gap(turn({ agent: 'codex', toolCounts: counts({ edits: 2 }), files: [] })), false);
  // The word, not only the mark: it is what a reader who cannot see the symbol is told.
  const mark = MARKS.find((m) => m.id === 'gap');
  assert.equal(mark?.word, 'a gap in what it recorded');
});

test('the window a turn recorded beats the one the price table would have guessed', () => {
  // gpt-5.6-sol is advertised at 272,000 and this session was given 258,400. 200,000 of the
  // smaller window is 77%; of the larger it is 73%, which is the wrong side of the line the
  // chip changes colour on.
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
  // The hover says where the figure came from. A recorded window is what that session was
  // given, so calling it the window for the model would put a wrong number beside a real
  // name: gpt-5.6 is advertised with the larger one.
  assert.match(chip?.detail ?? '', /77% of 258k[\s\S]*Recorded context window size/);
  // With nothing recorded the table answers, which is what a Claude turn always relies on,
  // and there the model's name is the right thing to say.
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

// When the fixture turn last recorded anything, read off the fixture rather than written out
// again. The quiet window is measured from it, and a second copy of the time would move the
// window without moving the turn.
const TURN_END = turn().endedAt;

test('status separates a finished turn from a failed, stopped, running or cut-short one', () => {
  assert.equal(statusOf(turn({ summary: 'Done.' }), false), 'done');
  assert.equal(statusOf(turn({ error: 'Overloaded.' }), false), 'failed');
  assert.equal(statusOf(turn({ finished: false, interrupted: true }), false), 'interrupted');
  // a turn the user stopped that still closed properly afterwards counts as answered
  assert.equal(statusOf(turn({ interrupted: true }), false), 'done');
  // mid-turn text does not mean the turn is over: the newest one is still running
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
  // The reported session: the CLI was closed part-way through a tool call, so no record
  // ever closed the turn and nothing else in the file is newer. Every reading below is the
  // one the reader was given for the three hours after it died.
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
  // What the reader could not do. A running card takes no read state, so the session
  // wore its unread dot with no press that would clear it.
  const dead = toCard(abandoned, true, TURN_END + TURN_QUIET_MS + 1);
  assert.equal(dead.live, false, 'the card still counts its duration up from a dead agent');
  assert.equal(canMarkRead(dead), true, 'the reader still has no way to mark the session read');
  assert.equal(
    turnMenuSection(dead, false),
    TURN_MENU_SECTIONS.unread,
    'the card still offers no entry for marking it read',
  );
  // A turn the agent is working in keeps the word, which is what the window is for.
  const busy = toCard(abandoned, true, TURN_END + 60_000);
  assert.equal(busy.live, true);
  assert.equal(canMarkRead(busy), false);
});

test('a turn cut off in the middle of a call stops saying it is on that call', () => {
  // The call the agent was killed during is left recorded as running, because the record that
  // would close it was never written. Both clocks on the card read off that record.
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
  // The panel skips the parse when nothing about the listing moved. A turn whose agent died is
  // never written to again, so this is the only thing that can wake it, and a card the poll
  // never rebuilds keeps the word running for as long as the panel stays open.
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

  // Nothing drawn yet is nothing to have moved, which is the first refresh of all.
  assert.equal(statusMoved(dying, 0, deadline + 1), false, 'the first refresh compares against a clock nobody set');

  // A clock that goes backwards, which a machine waking from sleep can do. One repaint the
  // other way and then quiet, rather than a poll that never settles.
  assert.equal(statusMoved(dying, deadline + 1, deadline), true);

  // A session whose turn already ended is not woken by the clock at all.
  assert.equal(statusMoved([turn({ summary: 'Done.' })], deadline, deadline + 60_000), false);
  assert.equal(statusMoved([], 0, deadline + 1), false, 'a panel with nothing parsed still asks for a repaint');
});

test('a turn whose end time could not be read keeps the word it had', () => {
  // `stamp` answers zero for a timestamp it cannot parse, and a turn carries that zero. Aged
  // against the clock a zero is older than everything, so the window would call the one turn
  // nobody can time dead on the first repaint.
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
  // A turn with nothing said yet leads with what it was asked, which is what the card was
  // already showing while the press was in flight. A stock line here put three different
  // sentences in the same slot in the first seconds of every prompt.
  assert.equal(headlineFor(turn({ prompt: 'take the sandbox off' }), 'running'), 'take the sandbox off');
  assert.equal(headlineFor(turn({ prompt: 'first line\nand a second' }), 'running'), 'first line');
  assert.equal(headlineFor(turn({ prompt: '' }), 'running'), 'Still working.');
  assert.equal(headlineFor(turn(), 'interrupted'), 'Stopped by you before it answered.');
  assert.equal(headlineFor(turn(), 'stopped'), 'Ended without a closing message.');
});

test('the collapsed headline keeps an inline-code identifier intact', () => {
  // headlineFor leaves a leading mark such as the checkmark below where it was written;
  // withoutLeadingSymbol takes it off separately, once the headline reaches the card. This
  // test is only about what stripMarkdown does to the bold text and the code span after it.
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

  // A symbol sitting inside the emphasis marker survives in the Markdown line but is gone
  // from the plain one, so the two would disagree: no headlineHtml is drawn rather than
  // putting the symbol back on the folded card.
  const markedSymbol = toCard(turn({ summary: '**✅ Done**' }), false, NOW);
  assert.equal(markedSymbol.headlineHtml, undefined);

  // A backtick with no closing mate, common while a turn is still streaming, stays literal
  // once rendered but is deleted by the plain headline's strip. The two disagree, so no
  // headlineHtml is drawn: a raw backtick on the folded card would be worse than none.
  const unclosedBacktick = toCard(turn({ summary: 'Ran `npm test' }), false, NOW);
  assert.equal(unclosedBacktick.headlineHtml, undefined);

  // An underscore inside a word is left alone by the renderer, since GFM does not read it as
  // emphasis there, and the plain headline's strip now agrees rather than deleting it. The
  // line carries no other Markdown, so it equals the plain headline and draws no
  // headlineHtml regardless, the same as any other plain line.
  const strayUnderscore = toCard(turn({ summary: 'calc_total is a function' }), false, NOW);
  assert.equal(strayUnderscore.headline, 'calc_total is a function');
  assert.equal(strayUnderscore.headlineHtml, undefined);

  // GFM draws `~~old~~` as a struck span with the tildes gone, while the plain headline's
  // strip does not touch a tilde and keeps them. The two disagree, so no headlineHtml is
  // drawn: a strikethrough span whose accessible name still reads the tildes would say two
  // different things about the same line.
  const strikethrough = toCard(turn({ summary: '~~old~~ `new`' }), false, NOW);
  assert.equal(strikethrough.headlineHtml, undefined);

  // An emphasis run nested inside another one of the same marker character, and a tripled
  // marker, both lose every marker on the plain headline the same way the renderer's own
  // nested tags read, so the two agree and headlineHtml is drawn.
  const nested = toCard(turn({ summary: 'nested **bold *em* inside** text' }), false, NOW);
  assert.equal(nested.headline, 'nested bold em inside text');
  assert.equal(nested.headlineHtml, 'nested <strong>bold <em>em</em> inside</strong> text');

  const tripled = toCard(turn({ summary: 'a ***bold em*** line' }), false, NOW);
  assert.equal(tripled.headline, 'a bold em line');
  assert.equal(tripled.headlineHtml, 'a <em><strong>bold em</strong></em> line');
});

test("a folded headline keeps a file name's underscore and gets headlineHtml", () => {
  // The reported bug: a card built from a summary naming `my_file.py` showed "myfile.py"
  // in the folded headline, its accessible name and the tab title, because the plain strip
  // deleted every underscore in the line rather than only the ones marking emphasis.
  // Reproduced with `npx vitest run turncard.test.ts -t "keeps a file name's underscore"`.
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
  // The panel draws these off the card, from inside a template literal the compiler never
  // reads, so a card that quietly stopped carrying them would break nothing until it shipped.
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
    // A child Arc read no spend for draws the token count it recorded, with nothing behind it.
    // How long it ran leads the row when the child has no cost.
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
  // 200 @ $5 + 40k @ $10 + 3M @ $0.50 + 206k @ $25 per MTok = $0.40 + $1.50 + $5.15
  // two failures is ordinary work the agent handled, so no chip and no mark.
  assert.deepEqual(
    card.chips.map((c) => c.label),
    ['$7.05+', '16% of 1M ctx (160k)', '2 files', '3M in · 206k out', '1 commit', '1 subagent'],
  );
  assert.deepEqual(
    foldedChips(card.chips).map((c) => c.label),
    ['$7.05+', '16% of 1M ctx (160k)', '2 files', '3M in · 206k out', '1 commit', '1 subagent'],
  );
  // every chip spells out what it is made of, for the hover, and the files and the lines
  // are one chip whose hover carries both
  assert.deepEqual(card.chips[2].detail.split('\n'), [
    // A half that moved no line is left out, the way the drawn pair leaves it out.
    '2 files: +85 −12',
    '',
    'a.ts: +80 −12',
    'new.md: +5 new',
  ]);
  // The tool calls have no chip of their own. It only ever showed on an opened card, and an
  // opened card draws the Activity heading, which says the same number broken down by kind
  // and lists the calls under it.
  assert.equal(
    card.chips.some((c) => c.label.endsWith(' tools')),
    false,
    'the tool count is drawn twice on one open card, once as a chip and once as a heading',
  );
  assert.equal(card.toolMix, '40 run · 20 edit · 8 read', 'the heading has no mix left to draw');
  assert.deepEqual(card.chips[5].detail.split('\n'), ['Audit the parser', '  haiku-4-5 · 2m · 20 tools · 70k']);
  // The Commits chip reads its own list out, so its hover cannot drift from what the popover
  // draws. See the record-chip test below for the rule.
  assert.equal(card.chips[4].detail, ['1 commit: +12', '', '00facf2a: Add the timeline'].join('\n'));

  // a turn that changed nothing carries no row of zeros, only the one chip saying so, and
  // nothing at all waiting inside the card
  const empty = toCard(turn({ summary: 'Answered your question.' }), false, NOW);
  assert.deepEqual(
    empty.chips.map((c) => c.label),
    ['no file changes'],
  );
  assert.deepEqual(
    foldedChips(empty.chips).map((c) => c.label),
    ['no file changes'],
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
  // The figure's face and its spoken name say nothing about the row that carries no count. The
  // record it opens still says why, in the footer sentence below, which does not also ride the
  // flat run.
  assert.equal(files.name, '2 files, 2 lines added, 1 removed');
  assert.deepEqual(files.detail.split('\n'), ['2 files: +2 −1', '', 'a.ts: +2 −1', 'unlisted.ts']);
  assert.deepEqual(files.detailList?.footer, ['1 file carries no line counts.']);
});

test('an Edit and then a whole-file Write keeps the lines and says the file was written whole', () => {
  // The turn's own reader keeps an Edit's counted lines on the row a later Write of the same
  // path left uncounted. The row settles to partial, keeps the Write as its cause, and the
  // session heading names the file the way the turn's figure does.
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
  assert.equal(heading.detail.split('\n').at(-1), '  1 file was written whole, so its line counts are partial.');
});

test('the files figure names a Write and a shell edit apart, and folds a subagent write in too', () => {
  // Two causes on one turn: the turn's own shell command named a path without hunks, and a
  // subagent wrote a second path whole. The figure's own face and name say nothing about either
  // cause. Its record names each in its own sentence, in the order write, then shell.
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
  // The subagent's own file still rides the Files section with its maker named, unaffected by
  // the figure's own mark: the plan puts the mark on the figure alone, not on this row.
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
  // Both the whole row and the folded view are written out in sequence rather than
  // derived, so a chip that moves position goes red here and not only a chip that
  // disappears. A rule read off the code would pass whatever the code did with it.
  //
  // The order: cost, context, files and lines lead, because they are what a reader steers
  // by and what the session heading draws; the tool count, the token totals, the subagents
  // and the commits follow. Closing the response does not hide any of them.
  //
  // The summary this is built from closes with both reader-facing rows, and the row ends
  // without a word about either: every chip reports a figure the turn produced.
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
  // The file count carries the two line figures, rather than a second chip beside it: one
  // pill, one hover, and one thing to announce.
  assert.deepEqual([loaded.chips[2].kind, loaded.chips[2].added, loaded.chips[2].removed], ['diff', 80, 12]);
  // The tones travel with the chips, so each remaining figure keeps its role in the row.
  assert.deepEqual(
    loaded.chips.map((c) => c.kind),
    ['plain', 'plain', 'diff', 'plain', 'plain', 'plain'],
  );

  // A turn that was never priced and recorded no context still leads with what it has,
  // rather than leaving a hole where the first two chips would be.
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
  // Two pills for one fact is what this replaced: they were never drawn apart, and each
  // hover said most of what the other's said. What a screen reader is handed matters more
  // on this chip than on any other, because the figures are drawn as `+85 -12` and that is
  // two numbers and a run of punctuation when it is read out in order.
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

  // The session heading builds from the same function, so the two cannot come to say one
  // pair of figures in two sets of words.
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
  // The caveat is said once. Two chips carried one each, and the reader was told twice.
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
  // A window with nothing left in it is the one share the scale has no word for. The band
  // does not move, so the colour does not either; only the word and the sentence do.
  assert.equal(full.level, 'nearlyFull', 'the full window changed band as well as wording');
  assert.equal(full.word, 'context full');
  assert.match(full.detail, /^\s*The window is full\.$/m);
  assert.equal(nearly.word, 'context nearly full', '99% is not full, and must not be worded as it');
  assert.match(nearly.detail, /^\s*The window is nearly full\.$/m);
});

test('the context chip stays a bare count when the model has no known window', () => {
  const card = toCard(turn({ contextTokens: 160_000, model: 'some-other-model' }), false, NOW);
  const chip = ctxChip(card)!;
  assert.equal(chip.label, '160k ctx');
  assert.equal(chip.kind, 'plain');
  assert.equal(chip.detail, 'Context at the end of the turn: 160,000 tokens');
});

test('the context chip takes its band at each threshold, and stays plain under the first', () => {
  // The table is the vocabulary, so the guard reads it rather than spelling three numbers
  // out again. Its order is what a share is matched against, and a reordered table would
  // hand the wrong word to a share.
  assert.deepEqual(
    CONTEXT_BANDS.map((b) => [b.at, b.level, b.word]),
    [
      [0.5, 'filling', 'context filling up'],
      [0.75, 'gettingFull', 'context getting full'],
      [0.9, 'nearlyFull', 'context nearly full'],
    ],
  );

  // Under the first band: no level, no word, and no sentence on the hover. A ramp that
  // started at zero would colour every card and drown the chips beside it.
  for (const share of [0.1, 0.49]) {
    const quiet = bandAt(share);
    assert.equal(quiet.level, undefined, `${share} of the window is toned`);
    assert.equal(quiet.word, undefined, `${share} of the window is worded as a band`);
    assert.doesNotMatch(quiet.detail, /The window is/, `${share} of the window says how full it is`);
  }

  // A share that rounds up to a threshold is toned at that threshold. The band is read off
  // the figure the chip prints, so one number cannot be drawn in two colours.
  const carried = bandAt(CONTEXT_BANDS[0].at - 0.0004);
  assert.equal(carried.level, CONTEXT_BANDS[0].level, 'a figure printed at the threshold was left untoned');
  assert.equal(carried.word, CONTEXT_BANDS[0].word);

  // On each threshold, and one point under it. The kind stays plain throughout: the band
  // travels beside it and never inside it.
  const edges: [number, string, string, string][] = [
    [0.5, 'filling', 'context filling up', 'The window is filling up.'],
    [0.75, 'gettingFull', 'context getting full', 'The window is getting full.'],
    [0.9, 'nearlyFull', 'context nearly full', 'The window is nearly full.'],
  ];
  const below = ['filling', 'gettingFull'];
  for (let i = 0; i < edges.length; i += 1) {
    const [at, level, word, sentence] = edges[i];
    const on = bandAt(at);
    assert.equal(on.level, level, `${at} of the window is not in the ${level} band`);
    assert.equal(on.word, word, `${at} of the window is worded wrong`);
    assert.match(
      on.detail,
      new RegExp('^\\s*' + sentence.replace(/\./g, '\\.') + '$', 'm'),
      `${at} of the window does not say so on its hover`,
    );
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
  // The table saying opus-5 has a 1M window does not stop a turn from recording more,
  // whether the table is stale or the session switched models mid-way.
  const card = toCard(turn({ contextTokens: 1_200_000, model: 'claude-opus-5' }), false, NOW);
  const chip = ctxChip(card)!;
  assert.equal(chip.label, '1.2M ctx');
  assert.equal(chip.kind, 'plain');
  assert.equal(chip.detail, 'Context at the end of the turn: 1,200,000 tokens');
});

test('a chip with no share behind it wears no band, whichever way the share went unknown', () => {
  // A band is set only after a real share, so a turn the panel cannot measure cannot print
  // a band for a share nobody knows. Both ways in: a model with no window in the table, and
  // a turn holding more context than the window it was measured against.
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
  // The row's own hint is the tool uses, which word its state. The cost sits on a figure the
  // reader can press and question, and how long the child ran sits on one of its own.
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

// A record line as its words alone. A cost line carries its cache reading and any line
// under it beside the text, so a reading of the words asks for the text.
const lineText = (line: StatDetailLine): string =>
  typeof line === 'string' ? line : 'text' in line ? line.text : `${line.lead}${line.trail}`;

// The row draws a total and the reader asks what it bought. Each figure answers for its own
// total: the cost by usage under the cost, the commits under their count, the paths under
// theirs. The row's own hover keeps the run line none of them owns.
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
  // Every figure the row draws answers for itself, and each record is headed by the figure's
  // own words, so the popover never opens on the words under the pointer.
  assert.deepEqual(
    drawn.map((figure) => [figure.metric, figure.record?.heading?.label]),
    [
      ['cost', '$0.33 spent'],
      ['duration', undefined],
      ['commits', '2 commits'],
      ['files', '3 files, 18 lines added, 4 removed'],
    ],
  );
  // The cost record wears the shape the card's own Cost popover wears: a heading, the value in
  // a second column, and the lines indented under it. The total is left out, because the figure
  // the record hangs under already carries it. The child's own usage closes the record.
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
  // The cache reading rides the line it belongs to, the way the card's own Cost popover draws
  // it. A record flattened into text loses it.
  assert.equal(
    (drawn[0].record?.entries[0].lines ?? []).filter((line) => typeof line === 'object' && 'cacheHit' in line).length,
    1,
  );
  // The commits and the files records draw the card's own rows rather than lines of text, so
  // each carries the shas or the paths the panel filters those arrays down to.
  assert.deepEqual(
    [drawn[2].record?.layout, drawn[2].record?.entries, drawn[2].shas],
    ['commits', [], ['9d7be30', 'b83e0d1']],
  );
  assert.deepEqual(
    [drawn[3].record?.layout, drawn[3].record?.entries, drawn[3].paths],
    ['files', [], ['extension/src/a.ts', 'extension/src/b.ts', 'extension/src/c.ts']],
  );
  // One fact has one home. The row's hover keeps the tool uses, which word its own state, and
  // repeats no block a figure beside it already answers for.
  assert.equal(card.agents[0].hintDetail, '23 tools');
  // A child that spent nothing Arc can price and committed nothing keeps the tool line alone,
  // and how long it ran stands as a figure beside it.
  const bare = toCard(turn({ agents: [agent({ durationMs: 60_000, toolUses: 4 })] }), false, NOW);
  assert.equal(bare.agents[0].hintDetail, '4 tools');
  assert.deepEqual(
    bare.agents[0].figures.map((figure) => [figure.metric, figure.compactLabel]),
    [['duration', '1m']],
  );
  // A recorded zero is absent from every figure. A finished child's hover keeps only its tool
  // uses, so a zero count leaves it with nothing to say rather than a line that reads "0 tools".
  const noToolsYet = toCard(turn({ agents: [agent({ durationMs: 60_000, toolUses: 0 })] }), false, NOW);
  assert.equal(noToolsYet.agents[0].hintDetail, '');

  // A spend Arc cannot price leaves its cost block with a heading and no lines under it. The
  // hover keeps the run line alone rather than opening a section a reader finds empty.
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
  // The money is unknown, so the usage keeps a figure of its own. A row with no cost figure has
  // nowhere else to carry it, and a reader would lose the run's volume along with its price.
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

  // A part Arc could not price says so under the block that did price. A heading over that
  // note alone reads as a section whose figures went missing.
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
  // The totals close the record, and they cover the unpriced part as well as the priced one.
  // Read without the lead they are the volume the money beside them bought, which is half true.
  assert.deepEqual(
    partialCost?.record?.entries.map((entry) => [entry.label, entry.value]),
    [
      ['Cost by usage · sonnet-5', '<$0.01'],
      ['Some nested subagents are still running or left no record. This is the cost so far.', undefined],
      ['Every part above, priced or not', undefined],
      ['Input', '2,000 tokens'],
      ['Output', '1,000 tokens'],
      ['Model requests', '4'],
      ['Input breakdown', undefined],
    ],
    'a block with nothing priced under it heads a lone note',
  );

  // The record is a popover that takes the pointer and scrolls, so it names every commit the
  // child made. The count that stood in for the rest was a bound the hint box needed.
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

  // A running child draws its cost so far and nothing else, so its hover names none of the
  // commits the row itself withholds.
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
  // A recorded zero is absent from every figure. A child that has not yet run a tool keeps its
  // running time alone, rather than a hover that reads "1m · 0 tools".
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

// The host holds a session's retained turns and hands them to the progressive worker for each
// refresh. Structured clone copies them both ways, and the worker copies each agent row by
// spread on its way out, so a figure a later read may replace has to survive both copies.
function retainedWorkerRead(held: Turn[], spend: Parameters<typeof refreshClaudeAgentFacts>[1]): Turn[] {
  const page = structuredClone(held);
  refreshClaudeAgentFacts(page, spend, undefined);
  exposeClaudeAgentRelationshipIds(page);
  return structuredClone(page);
}

// A retained history page re-reads a finished background child as its own transcript grows,
// running refreshClaudeAgentFacts again on the turn the first read already filled. The row's
// drawn count has to follow that second read, not freeze at the first one.
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

// A background child can finish having run no tool at all, which the row draws the same as no
// count. A later read that finds calls the first read missed still has to replace that zero.
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

// A genuine count from the Agent result or the task notification wins even where it happens
// to equal the count the artifacts fallback already wrote, and a later, bigger artifacts read
// never replaces it.
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

  // The fallback fills the row from the child's own calls, the same as any other finished
  // child with no result or notification count.
  refreshClaudeAgentFacts(turns, lookupOf(artifactsOf({ Bash: 5 }, 'child-r1')), undefined);
  assert.equal(turns[0].agents[0].toolUses, 5);

  // A notification then arrives with its own count, which by chance equals the fallback's
  // figure. It must read as the genuine source from here on.
  turns[0].agents[0].toolUses = 5;
  delete turns[0].agents[0].toolUsesFromArtifacts;

  // A later read's artifacts total a different figure. The naive comparison this fix replaced
  // would have refilled from it because the prior figure equalled the old artifacts total; the
  // genuine count must stay instead.
  refreshClaudeAgentFacts(turns, lookupOf(artifactsOf({ Bash: 5, Edit: 4 }, 'child-r2')), undefined);
  assert.equal(turns[0].agents[0].toolUses, 5);
});

// The requests and the token totals rode the row's own hover, where a reader could read them
// and not question them. A priced child carries them inside its cost record now, under the
// money they came to, and its own face carries how long the child ran instead.
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
  // A child Arc read no spend for keeps the token count it recorded as a figure's face, and
  // that count answers for itself with nothing behind it.
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
      // The mix leads, largest first, and a tie reads in name order. It carries no total, because
      // the row's hint counts the child's tool uses.
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
  // A child a later prompt sent back for a second turn draws the count with Started and Ended,
  // ahead of both since it says how often the child ran rather than when.
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
  // The parent prompts the child a second time, after its first task completed, so its rollout
  // holds a second `task_started`/`task_complete` cycle under a second turn id.
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

// A dispatched Claude session is a real session file someone can resume and prompt again, read
// through readClaudeAgentSpend with childTranscript false, the same path dispatchedAgentCard
// draws its row from.
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
      // A recorded list-price total leaves no usage to break down, so the block names its
      // basis and stops there. The requests behind it follow, parted from the money by a rule.
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
      // This child's commits reached Arc as shas with no subjects behind them. The record draws
      // the card's own commit rows for those shas, and the run of text behind the figure names
      // the shas alone, because a figure carries whatever the record holds. A record of rows
      // declares its presses, or the popover drawing it stays a tooltip: it would take no name
      // from its heading, and the figure would describe it rather than say it opens it.
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
      // A list-price total records no token at all, and a recorded zero is absent. This child's
      // record carries no run time either, so the row draws no figure for one.
    ],
    hintDetail: '',
    sessionId: null,
  });
  assert.deepEqual(
    card.agents[1].figures.map((figure) => [figure.metric, figure.compactLabel, figure.name]),
    [['cost', '$1.23+', 'At least $1.23 spent']],
  );

  // A recorded zero is absent. A child that spent money and committed nothing draws its cost
  // and nothing else, and one that recorded neither draws an empty line rather than two zeros.
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
  // Partial evidence marks what it found. A partial zero is still absent, because `0+ commits`
  // claims a count the record does not hold.
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
  // The turn holds one file of its own, and the child holds one more of its own beside the same
  // file under the spelling its own transcript recorded. That is what a delegated turn delivers:
  // the parent transcript records no edit a child made, so a fixture that hands the card the
  // child's paths in front of the test proves nothing about production.
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
  // A file the turn and a child both changed is one row holding both edits. A file only the
  // child changed is a row of its own, and its hover and its spoken name say who changed it.
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
  // Every path the figure filters the card's rows by is a row the card holds, so the record the
  // figure opens draws rows rather than nothing at all.
  assert.deepEqual(figure?.paths, ['c:/repo/src/parent.ts', 'c:/repo/src/child.ts']);
  assert.deepEqual(card.files.filter((file) => figure?.paths?.includes(file.path)).length, 2);
  // The turn's own figure counts the delegated work beside its own and says how much of it a
  // child did, the way the commits figure does.
  const chip = card.chips.find((held) => held.metric === 'files');
  assert.deepEqual(
    [chip?.label, chip?.name],
    ['2 files', '2 files, 14 lines added, 3 removed, 1 changed by a subagent'],
  );
  assert.equal(card.fileCount, 2);

  // Two children that changed one file come to one row, which holds both their edits and names
  // neither of them, because the row cannot say one child changed what two did.
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
  // The turn counted its own edit of a path, and a child's record names that same file without
  // the hunks behind it. A record that counted nothing says nothing about what another record
  // measured, so the row and the turn's totals keep every line the turn really counted. The row
  // keeps those lines as a floor rather than dropping them, which is what under-reporting a
  // measured count would be.
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

  // A path only an uncounted mention names carries no count to keep, so it stays a row with no
  // counts and the turn's totals stay out of it.
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
  // One child, one path, two records of it: an edit that carried its hunks and a Write that says
  // nothing about the lines the file held before. A child transcript normally holds one turn, so
  // the reader hands the reducer one entry carrying the counted lines and the mark together. A
  // child that ran more than one turn hands it the same two records as separate entries.
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
    // The row in the child's record keeps the lines the child measured. A blank row under a figure
    // that already added those lines up says two things about one file.
    assert.deepEqual(
      card.files.map((file) => [file.added, file.removed, file.countsUnknown ?? null]),
      [[5, 1, null]],
    );
    // The turn total holds the same lines, because a row whose count is a floor stays in it.
    assert.deepEqual([card.added, card.removed], [5, 1]);
    const figure = card.agents[0].figures.find((entry) => entry.metric === 'files');
    assert.deepEqual([figure?.compactLabel, figure?.added, figure?.removed], ['1 file', 5, 1]);
    // The spoken name says nothing about the counts being partial, whatever the row settled to.
    assert.equal(figure?.name, '1 file, 5 lines added, 1 removed');
    // The flat run names the file once and does not repeat the record's own footer sentence.
    assert.deepEqual((figure?.detail ?? '').split('\n'), ['1 file, 5 lines added, 1 removed', 'c:/repo/src/both.ts']);
    // The record still says the Write is why, even though the figure's face does not, and it is
    // the only place that sentence rides.
    assert.deepEqual(figure?.record?.footer, ['1 file was written whole, so its line counts are partial.']);
  }
});

test("a child's written-whole row keeps its cause where the turn already holds the path", () => {
  // The turn Edits a path, and a subagent Edits the same path and then Writes it whole. The
  // child's reducer settles its row to partial with the Write as its cause. The turn's row for
  // that path takes the child's lines and its cause, so the turn's record names the file the way
  // the subagent's record does.
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
  // The turn's file list holds the spelling the edit recorded, and the child's own record holds
  // the spelling its transcript recorded. Both name one file. The figure carries the card's
  // spelling, because the record filters the card's rows by it and an exact match on the other
  // spelling would draw no row for a file the child did change.
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

// The line a partial record ends on, written out rather than imported, so a reworded note
// goes red here and the reader of this test sees what a partial record says.
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
  // A partial record keeps the `At least` wording its figure carries, and says on its own last
  // line how far the child's own record reached.
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
  // The popover reads the sentence from the record's footer alone. No reader draws `detail`
  // while a record exists, so a figure whose flat reading repeated it there would double the
  // payload rather than what the reader hears.
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
  // Matches the files-figure guard above: the sentence rides the footer alone, and never a
  // second time inside the flat reading `detail` carries.
  const count = (text: string) => text.split(CUT_SHORT).length - 1;
  assert.equal(count(figure?.detail ?? '') + count((figure?.record?.footer ?? []).join('\n')), 1);
});

test('every status a reader records draws its own state, and only a real failure draws failed', () => {
  // `running` from both readers, `async_launched` from Claude and `launched` from Codex are open.
  // `interrupted` comes from Codex, and Claude passes a task word such as `killed` through raw.
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

// The newest card counts its carried subagents on its agents figure, so the popover heading
// counts them beside its own rows. A heading that counted the rows alone read below the
// running figure standing next to it. The line naming the carried subagents counts subagents
// and never turns, because the card knows how many children the rail counts and not which
// turn launched each one.
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
  // A card that launched nothing names the carried subagents in the heading itself, and two
  // of them can come from one earlier turn or from two.
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
  // Arc cannot tell whether a background child outlived its session. Outside a running turn the
  // child says that no ending was recorded, drops the time it has run for three days after
  // launch, and takes the idle tone. The heading counts no such child, so it holds no count.
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

// What a child's own transcript billed, reduced to the field these cases read. The price is
// not under test here, so every other count is zero.
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

test('a model named on the call outranks what the child billed', () => {
  const card = toCard(
    turn({
      agents: [
        agent({
          model: 'claude-opus-5',
          spend: [ran('claude-haiku-4-5', 90_000)],
        }),
      ],
    }),
    true,
    NOW,
  );
  assert.equal(card.agents[0].model, 'opus-5');
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
  // The payload carries the price as a number, and a raw quotient carries every digit a float
  // has. Four significant digits survive the two-decimal display and keep the rail row small.
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

// A large cached-read figure is hundreds of small charges rather than one. The dollar list
// carried neither the count nor the average, so the figure read as a single charge the reader
// could not place against anything.
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
  // Only the line the count explains. An output or an uncached-input figure does not read as
  // one charge that needs breaking up.
  assert.doesNotMatch(many, /Uncached input: [^\n]*requests/);
  // One request bought the whole figure, so there is nothing to explain.
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

// The reader asks what one more request on this session costs. A share cannot answer it. The
// worst turn measured in this project ran at a 99% cached share and still cost $96.59, so a
// share-based signal stays silent on exactly the session that needs an answer.
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
  // The price is a fact, not a defect. Repeated context is the normal shape of a long session.
  assert.equal(priced.warnings, undefined);

  // An inexact request count cannot divide a cost, so no price is honest.
  const counted = sessionCostStats([{ ...part, requestCountExact: false }])[0];
  assert.doesNotMatch(
    counted.detail,
    /avg input/,
    `an estimated request count still reports an exact scale: ${counted.detail}`,
  );

  // An incomplete scope has a lower bound, not a total.
  const open = sessionCostStats([{ ...part, incomplete: true }])[0];
  assert.doesNotMatch(open.detail, /avg input/);

  // One unpriced part also leaves a lower bound, while the priced part still draws the line.
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

// A running scope grows. Its cost is a lower bound, and dividing a lower bound is not a price.
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

  // The child's own run state counts too, beside the text that already says so.
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

// One cost record prices the same usage twice today: the heading's total prices it, and the
// entry that shows it prices it again. The record inside that entry reads the entry's answer
// rather than pricing a third time for the cache-rate warning's input cost, and a card with
// no subagent builds a Main-agent entry only when a cache-write warning changes the wording.
// These are upper bounds, so a later change that prices fewer times passes and one that prices
// more goes red. The spy counts only calls carrying a usage object by reference, so the
// categorized per-key repricing inside each breakdown, which builds its own partial usage
// objects, is never mistaken for a repeat of this price. Each count also carries a floor of
// one, because that same reference equality reads a change that copies a usage object as no
// pricing at all, and a bound from above alone stays green when a count falls to zero.
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

// The turn card and the rail read the same record, so they must agree about what it says.
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
  // The result gives one total, with no split between what it read and what it wrote and
  // no model of its own, so there is nothing to price it with.
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
  assert.deepEqual(cost?.detailList, {
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
    footer: ['Estimated from published model rates. Your actual charge may differ.'],
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
  assert.deepEqual(agents?.detailList, {
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

// The turn's record reaches the reader through the three chip popovers, so each chip names
// the record its popover draws. The fixture's long turn is the one turn that has a record of
// every kind: seven files, three delegated runs one of which is still going, and two commits.
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

  // The heading counts what is still going, which is the one fact about the list that changes
  // while the reader looks at it.
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
  // The turn holds all three itself. A commit the fold child also reports reaches the card
  // twice over, so the entries below would stand even after one left the turn's own record.
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
  // The chip's plain hover is the list read out, so the two cannot say different things.
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

  // The record reaches the panel on the card's own arrays and on nothing else. A chip holding
  // a copy of the rows as well put every row of a long turn on the wire twice, once under the
  // card and once under the chip, on every post the poll makes.
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
  // The two worktree commits are the fold child's own, so each row names its maker and the
  // chip counts them. The row a child did not make carries no maker line at all.
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

// A main transcript launches agent a1, and each agent launches the next one down to `depth`.
// Claude Code writes every subagent transcript flat into the session's subagents folder, and
// only a nested agent's meta file names its launcher. Each transcript bills one Haiku request
// of 1M input tokens, which costs $1.00, so a whole chain of depth 2 costs $3.00.
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
  // The second row is the `open` state: the parent turn ended and nothing says the child is
  // alive, so the row draws the idle mark, and its face and its note say what Arc read rather
  // than that work goes on.
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
  // The same child on a turn that ended, with nothing saying it is alive. Its row is idle, so
  // its usage footer says what Arc read instead of that the child still runs.
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
  // The row draws the idle mark, so the line under `cost unavailable` cannot call the child
  // still running. It says what the record is missing instead. `costDetail` reads no session
  // liveness, so it answers from the turn alone and has to reach the same words as the chip.
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
  // The figure reads "cost unavailable", so a line repeating that says nothing. What the
  // reader needs is why: the subagent has not finished, and no priced usage exists yet.
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
  // Each mark once, in the table's order. The opening list gives the question and the done;
  // the closing rows give the raised hand, because the actions row here has something in it
  // and the questions row says "none". A card whose summary declares a question in its
  // opening list and closes with a row of them is marked once, not twice.
  assert.deepEqual(
    toCard(turn({ summary }), false, NOW).marks.map((m) => m.id),
    ['needsYou', 'question', 'done'],
  );

  // The same summary with nothing waiting in either row. The raised hand goes; the question
  // stays, because the opening list declared one.
  const settled = summary
    .replace('**Your actions** - reload the panel', '**Your actions** - none blocking')
    .replace('**Open questions** - none', '**Open questions** - none open');
  assert.deepEqual(
    toCard(turn({ summary: settled }), false, NOW).marks.map((m) => m.id),
    ['question', 'done'],
  );
});

test('a symbol the table does not hold marks nothing, and a variation selector changes nothing', () => {
  // The warning sign is nearly always typed as U+26A0 followed by U+FE0F; the table holds
  // the bare form, because that one keeps its width steady wherever it is drawn.
  assert.deepEqual(markIds({ summary: '- \u26A0\uFE0F This could bite later.' }), ['caveat']);
  assert.deepEqual(markIds({ summary: '- \u26A0 The same thing, written bare.' }), ['caveat']);
  // An invented symbol is drawn in the headline where it was written and marks nothing, so
  // it is something the reader can see rather than something the panel swallowed.
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
  // A turn that took out twice what it put in reads as a removal; one that swapped a
  // similar amount either way does not.
  assert.deepEqual(markIds({ files: [changed('c:/repo/a.ts', 5, 40)] }), ['removal']);
  assert.deepEqual(markIds({ files: [changed('c:/repo/a.ts', 30, 40)] }), []);
  assert.deepEqual(markIds({ files: [changed('c:/repo/a.ts', 0, 0)] }), []);
  // The first toned band, and not a threshold of its own, so the words on the head row and
  // the tone on the chip beside them cannot disagree about how full the window is.
  const window = 1_000_000; // opus-5, which the fixture runs on
  const atShare = (share: number) => markIds({ contextTokens: Math.round(window * share) });
  assert.deepEqual(atShare(CONTEXT_BANDS[0].at), ['context']);
  assert.deepEqual(atShare(CONTEXT_BANDS[0].at - 0.01), []);
  // And the mark is keyed off the printed figure, the way the chip's tone is, so the words
  // on the head row and the tone beside them still arrive together.
  assert.deepEqual(atShare(CONTEXT_BANDS[0].at - 0.0004), ['context']);
  // Between the first band and the second, where a mark keyed on the wrong row of the table
  // would still be silent.
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
  // A pictograph is announced by its Unicode name, so a tick left in here would be read out
  // as "white heavy check mark" straight after the word it already stands for.
  assert.ok(!/\p{Extended_Pictographic}/u.test(card.label), 'the spoken name still carries a pictograph');
  // Nor is it left in the headline, where it would be read out on top of the word this name
  // already says it with. The card keeps it as a mark, which is what carries it.
  assert.equal(card.headline, 'The batch landed.');
  assert.ok(
    card.marks.some((m) => m.character === '\u2705'),
    'the symbol left the headline with nothing carrying it',
  );
  // A symbol the table does not hold has no mark to stand in for it, so it stays where it
  // was written rather than going missing from the card altogether.
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
  // Which entries a right-click offers is the whole of what this decides, and the section
  // name is the only piece of a card's context a when clause can read. Two things go into
  // it and they move independently: whether the read state can be set, and whether the card
  // holds a summary to copy. Every answer is written out, so a name changed on one side of
  // the pair fails here rather than quietly matching no menu at all.
  const finished = toCard(turn({ summary: 'Done.' }), false, NOW);
  assert.equal(turnMenuSection(finished, false), 'arcTurnUnreadSummary');
  assert.equal(turnMenuSection(finished, true), 'arcTurnReadSummary');

  // A running turn cannot take a read state, and its summary is still worth copying, so it
  // reaches the summary-only name. A compaction that carried one over reaches it by the
  // same rule: the kind of card is nowhere in the question.
  const running = toCard(turn({ finished: false, endedAt: NOW - 60_000, summary: 'Halfway.' }), true, NOW);
  assert.equal(running.live, true, 'the fixture is not a running turn, so it cannot see the rule');
  assert.equal(turnMenuSection(running, false), 'arcTurnSummary');
  assert.equal(turnMenuSection(toCompactionCard(compaction(), NOW), false), 'arcTurnSummary');

  // A compaction with nothing carried over can take neither, so it names nothing at all and
  // the editor draws its own menu instead of one whose entries would do nothing.
  assert.equal(turnMenuSection(toCompactionCard(compaction({ summary: '' }), NOW), false), null);

  // A finished turn whose summary is whitespace can still take a read state, so it names one
  // of the two plain names: there is nothing to put on the clipboard.
  const blank = toCard(turn({ summary: '   \n  ' }), false, NOW);
  assert.equal(turnMenuSection(blank, false), 'arcTurnUnread');
  assert.equal(turnMenuSection(blank, true), 'arcTurnRead');

  // And every name the rule can return is one the table holds, or a card names a section no
  // menu is looking for.
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
  // package.json hides this entry over a selection with !arcSelection, so a labeled card
  // must carry both flags together while text is selected, and drop arcSelection once it is not.
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
  // The glyph is a pictograph and the unread dot is drawn by the stylesheet, so the word is
  // the only thing a hover can say. It rides the card rather than being worked out in the
  // panel, which is the file nothing tests.
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
  // With no earlier request the recorded 629k sizes the input: all of it read back at a tenth
  // of $5, a 2k instruction, and 14k written at $25 per MTok.
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
  // Still running at both clocks below: ahead of the first and half an hour behind the second.
  // Left at zero the two cards compared here would both be turns left unfinished, and the
  // running card this test is about would go uncovered.
  const running = turn({
    finished: false,
    endedAt: new Date(2026, 7, 23, 23, 40).getTime(),
    summary: 'Working on it.',
  });
  // The same running turn worded at two different clocks, the second past midnight so
  // the absolute wording gains its day: relative, duration, absolute and the label all
  // move, and none of them is a reason to rebuild the card.
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
  // Clock-worded values nested inside a content field: an earlier answer's hover clock and a
  // commit row's, both of which gain a day name at midnight. Neither alone must read as the
  // card's content moving, or every card rebuilds at once and drops its selection.
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
  // A branch that merged names the merge on the Commits popover heading. The heading comes from
  // the host, and the merge time on it would gain a day name at midnight like any other.
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
  // Real cards, with the two fields the host adds before posting, so a field added to
  // either card shape fails here until it is placed in exactly one of the two lists.
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

// The symptom this section exists for: a message the agent wrote while it worked was
// readable only as a truncated activity row with a hover on it. So the guard is written
// against what reaches the card, in the order the reader will read it.
test('every message the agent sent while the turn ran reaches the card, oldest first', () => {
  const at = (minutes: number) => new Date(2026, 7, 23, 14, 32 + minutes).getTime();
  const working = turn({
    summary: 'The last word.',
    // Three answers, two of them closed before the last, so the index a note anchors by is
    // not the same number as the entry's place in the section. An implementation that
    // numbered by that place would pass a single-answer fixture and strand every note.
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

  // Every message carries a clock now, because every one of them draws one: the meta line
  // shows the time and the hover shows the same moment in full.
  assert.deepEqual(
    card.saidMessages.map((m) => m.when),
    ['2:33 PM', '2:34 PM', '2:36 PM', '2:37 PM'],
  );
  assert.deepEqual(
    card.saidMessages.map((m) => m.absolute),
    ['2:33 PM', '2:34 PM', '2:36 PM', '2:37 PM'],
  );

  // The anchor a note already carries still names the answer it was left on. `earlierAnswers`
  // is newest first and the section is oldest first, so this is the one number that has to
  // survive the change.
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

  // What the shut head says, and what a reader who cannot see it hears. It counts replies,
  // which is the word the message itself wears.
  assert.equal(card.saidName, 'Said while working, 4 messages, 2 replies');
  assert.equal(card.saidMix, '4 messages, 2 replies');
});

test('the messages are put in clock order, whatever order the two lists arrived in', () => {
  // Neither source list promises the clock. `turnview.test.ts` holds that an answer stamp may
  // go backwards, and an update stamp promises nothing either. Merged as though both were
  // already sorted, one narration recorded late drags the answer beside it out of order too
  // and the reader is shown the messages in an order nobody wrote them in.
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

  // A narration and an answer on one stamp: the narration first, because an answer closes the
  // stretch of narration that led to it.
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
  // Two answers whose stamps go backwards, which is the case turnview.test.ts permits.
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
  // The anchor is the number earlierAnswersOf gave, and where the section draws an entry never
  // touches it.
  for (const said of backwards.saidMessages) {
    assert.equal(
      commentAnchorText(backwards, answerPart(said.answerIndex!)),
      said.text,
      'the sort renumbered the answers, so every note left on one now names another',
    );
  }

  // And the record itself keeps the transcript's order, because searchableSummary reads it.
  // Recorded oldest first, the card carries them newest first, which no sort would produce.
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
  // The same projection the earlier answers get, for the same reason: the wording gains a day
  // name at midnight, and a day boundary must not read as the card's content moving. Every
  // message carries the hover now, so every message is projected.
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
  // The rendered markdown is what the section draws, and it moves without the markdown behind
  // it moving: a picture resolves to a host address the first render had no answer for.
  // Dropped from the print, the card keeps drawing the markup it was first given.
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
  // The clock the meta line draws is fixed, carries no day, and stays in the print the way a
  // mid-turn prompt's does.
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

// The section keys the reader's own presses by message id: which messages they opened whole,
// and which of them overflow their bound. An id that moves under them is a message they
// opened snapping shut. The card repaints every few seconds while the turn runs.
test('a mid-turn message keeps one identity, and a message arriving moves nobody else', () => {
  const at = (minutes: number) => new Date(2026, 7, 23, 14, 32 + minutes).getTime();
  const written = (updates: object[], answers: object[]) =>
    saidMessagesOf({ summary: 'The last word.', answers, updates } as Parameters<typeof saidMessagesOf>[0], NOW);
  const closed = [
    { text: 'A first pass, closed.', at: at(4) },
    { text: 'The last word.', at: at(9) },
  ];
  // Two narrations on one stamp, which the record allows and which a stamp alone cannot tell
  // apart. Both are drawn, so both need an identity of their own.
  const tied = written(
    [
      { sourceId: 'u1', kind: 'commentary', text: 'Reading the parser.', at: at(2), status: 'done' },
      { sourceId: 'u2', kind: 'commentary', text: 'And the lexer beside it.', at: at(2), status: 'done' },
    ],
    [{ text: 'The last word.', at: at(9) }],
  );
  assert.equal(tied.length, 2, 'the fixture no longer draws two messages, so this measures nothing');
  assert.notEqual(tied[0].id, tied[1].id, 'two messages on one stamp share an id, so a press on one opens the other');

  // Numbered after the sort. A narration recorded late but stamped early is drawn at the top.
  // Numbering by arrival would hand it the id the message below it already holds.
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

// A transcript record whose timestamp will not parse is stamped zero by the reader, and zero is
// a real moment both formatters draw. The section says a message with no time shows none, and a
// reply then carries its word alone.
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

test('a turn with no file changes says so, in every status but a running one', () => {
  const chipLabels = (card: TurnCard) => card.chips.map((c) => c.label);
  // Every status a finished turn can carry, so the rule stays "all but one" rather than
  // quietly narrowing to the one status the first test happened to use. Each fixture
  // asserts the status it is filed under, on the card being read.
  for (const [status, card] of [
    ['done', toCard(turn({ summary: 'Read the parser.' }), false, NOW)],
    ['failed', toCard(turn({ error: 'Overloaded.' }), false, NOW)],
    ['interrupted', toCard(turn({ finished: false, interrupted: true }), false, NOW)],
    ['stopped', toCard(turn({ finished: false }), false, NOW)],
  ] as [string, TurnCard][]) {
    assert.equal(card.status, status, `the ${status} fixture is not a ${status} turn`);
    assert.ok(chipLabels(card).includes('no file changes'), `a ${status} turn should say it changed nothing`);
  }
  // The one exception: a running turn has not finished, so this would guess at what it is
  // still going to do.
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
  const emptyDetail = toCard(turn({ summary: 'Read the parser.' }), false, NOW).chips.find(
    (chip) => chip.label === 'no file changes',
  )!.detail;
  assert.match(emptyDetail, /Changes outside edit tools/);
  assert.match(emptyDetail, /Delegated changes/);
  assert.match(emptyDetail, /Changes in scratch directories/);
});

test('a path is drawn and announced with forward slashes, and acted on as it was recorded', () => {
  // One card showed both spellings: a commit's hover said `in C:/Users/dev/...`, because
  // that directory is read out of a command and comes back unified, while the file rows
  // above it said `C:\Users\dev\...`. Everything the reader reads is now the first shape.
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

  // A basename row. Nothing drawn on it holds a separator at all, and the path it hovers
  // with is the whole path in the drawn spelling.
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

  // The recorded path is still on the card beside them, exactly as the transcript wrote it.
  // It is what the row opens, what Copy Path writes into a terminal, and what the snapshot
  // store is looked up by, and none of those can take a spelling made for reading.
  assert.deepEqual(
    card.files.map((f) => f.path),
    [inside, outside],
  );

  // Two basename rows that collide grow leftwards, and that growth is spelled the same way
  // whichever separator the path arrived with.
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

  // A linked worktree shares the object store and the branch refs of the folder it came
  // from, so the work is this project's own. The word `worktree` is what keeps the row from
  // reading like `in side-repo`, which is the shape that means somebody else's repository,
  // and the hover says "of this repository" rather than leaving one word to carry it.
  const card = commitCard(
    made({
      place: { kind: 'worktree', dir: 'C:/Users/dev/arc-worktrees/usage-model-bucket' },
      head: { kind: 'branch', name: 'feat/usage-model-bucket' },
    }),
    NOW,
  );
  assert.equal(card.where, 'in worktree usage-model-bucket');
  assert.equal(card.detail, 'Note the run\n3 files changed');
  // The group heading draws the branch and the place beside it. The two are different facts:
  // where to look on disk, and what the reader will merge.
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

  // The reader's open folder is a worktree and the commit was made in the tree that worktree
  // came from. Both are the same repository, and only one of them is a worktree.
  const main = 'C:/Users/dev/Projects/work/arc';
  const card = commitCard(made({ place: { kind: 'maintree', dir: main } }), NOW);
  assert.equal(card.where, 'in the main tree');
  assert.equal(card.detail, 'Note the run\n3 files changed');
  if (card.where === null) {
    assert.fail('the main-tree label is missing');
  }
  assert.doesNotMatch(card.where, /worktree/);

  // A kind none of the arms name says nothing. Falling through to the wording for another
  // repository is the worst thing a kind added later could be told to say.
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

  // A commit in this workspace says nothing extra: the card it is drawn on already says
  // where it is, and a row repeating that on every commit would say nothing at all.
  const here = commitCard(made(), NOW);
  assert.deepEqual([here.branch, here.headKind, here.repository], [null, null, null]);
  assert.equal(here.where, null);
  assert.equal(here.detail, 'Note the run\n3 files changed');
  // One made elsewhere says so by that directory's own name, which is the part that tells
  // the reader which tree to go and look in, and the hover carries the whole path.
  const away = commitCard(made({ place: { kind: 'named', dir: 'C:/Users/dev/Projects/side-repo' } }), NOW);
  assert.equal(away.where, 'in side-repo');
  assert.equal(away.detail, 'Note the run\n3 files changed\nin C:/Users/dev/Projects/side-repo');
  const branch = commitCard(made({ head: { kind: 'branch', name: 'main' } }), NOW);
  assert.deepEqual([branch.branch, branch.headKind], ['main', 'branch']);
  // The group heading owns the branch, so the hover does not repeat it.
  assert.doesNotMatch(branch.detail, /on main/);
  const detached = commitCard(made({ head: { kind: 'detached' } }), NOW);
  assert.deepEqual([detached.branch, detached.headKind], [null, 'detached']);
  // The repository a row files under. A nested repository inside the open folder is named by
  // its path under that folder, one outside every folder by its own folder name, and the open
  // folder's own repository and its worktrees are the card's own.
  // A nested repository's tree sits inside the open folder, so git gives it no place, and its
  // key alone says it is not the folder's own.
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
  // A directory written with backslashes names itself the same way, and its hover draws the
  // path in the one spelling everything else on the panel is drawn in.
  const backslashed = commitCard(made({ place: { kind: 'named', dir: 'C:\\Users\\dev\\Projects\\side-repo' } }), NOW);
  assert.equal(backslashed.where, 'in side-repo');
  assert.equal(backslashed.detail, 'Note the run\n3 files changed\nin C:/Users/dev/Projects/side-repo');
  // A call that committed to more than one repository, none of them here, can say that much
  // and no more. The row keeps the shape a named one has, since it is already carrying a
  // sha, a subject and two counts; the reason goes on the hover, where there is room.
  const elsewhere = commitCard(made({ place: { kind: 'unnamed' } }), NOW);
  assert.equal(elsewhere.where, 'in another repository');
  assert.equal(
    elsewhere.detail,
    'Note the run\n3 files changed\nIn another repository. The call committed to more than one, so which one cannot be said.',
  );
  // No directory is named anywhere on it, which is the whole of what makes it safe.
  if (elsewhere.where === null) {
    assert.fail('the other-repository label is missing');
  }
  assert.doesNotMatch(elsewhere.where, /[/\\]/);
  assert.doesNotMatch(elsewhere.detail, /[/\\]/);
  // A commit that changed nothing prints no stat line, so the hover keeps the two parts it
  // does have rather than writing a file count it never read.
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
  // The row draws no age. The full local time rides beside the hover and names a day that is
  // not today. It stays out of `detail`, which the panel compares to decide on a redraw.
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
  // The branch that moved files the row when no branch of the record explains it.
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
  // The directory travels beside the filename rather than glued in front of it, so the row
  // can shrink the one and not the other.
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
  // Handed no folders, the card draws what it drew before there was anything to be outside of.
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
  // The reader's icon theme is drawn in front of this, and the panel is where that happens,
  // so this is the floor. A card that arrives with nothing in the icon column leaves the
  // panel nothing to fall back to when the theme has no answer, which is the common case for
  // a reader who has turned file icons off.
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
  // The theme's own icon is the panel's to add, so a card carries neither half of it.
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
  // A failed turn and a finished one look different only by colour, which is read out as
  // nothing at all, so the word has to be in the name.
  const failed = toCard(turn({ error: 'Overloaded.' }), false, NOW);
  assert.match(failed.label, /^Turn, failed, /);
  const running = toCard(turn({ finished: false, endedAt: NOW - 60_000 }), true, NOW);
  assert.match(running.label, /^Turn, running, /);
  // A model with nothing to say about it leaves no empty gap in the middle of the name.
  const bare = toCard(turn({ model: null, summary: 'Done.' }), false, NOW);
  // Never bare: the agent is on every card, so this is the shortest a name gets.
  assert.equal(bare.label, 'Turn, finished, 5 hours ago, ran in 12m, started 2:32 PM, Claude. Done.');
  assert.match(toCompactionCard(compaction(), NOW).label, /^Compaction, 4 hours ago, ran in 2m\. Compacted by hand\./);
});

test('the duration phrase matches the turn status', () => {
  // The figure beside the word is still growing: the panel counts it up once a second for
  // exactly this status. Past-tense wording over a turn nothing has finished is a claim the
  // ticker contradicts a second later.
  assert.equal(durationWord('running'), CARD_ACTIONS.runningFor);
  for (const status of ['done', 'failed', 'interrupted', 'stopped'] as const) {
    assert.equal(
      durationWord(status),
      CARD_ACTIONS.ranFor,
      `a ${status} turn has ended, so its duration takes the past tense`,
    );
  }
  // The card carries the word, and its spoken name reads the same one, so the row and the
  // screen reader cannot say different things about whether the turn is over.
  const running = toCard(turn({ finished: false, endedAt: NOW - 60_000 }), true, NOW);
  assert.equal(running.durationWord, CARD_ACTIONS.runningFor);
  assert.match(running.label, /running, 1 min ago, running for 5h 28m, started 2:32 PM,/);
  const done = toCard(turn({}), false, NOW);
  assert.equal(done.durationWord, CARD_ACTIONS.ranFor);
  assert.match(done.label, /finished, 5 hours ago, ran in 12m, started 2:32 PM,/);
  // A turn left unfinished is not running: nothing is going to move its figure again, so
  // the past tense is the honest one there and the two must not be one branch.
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
  // The row still draws the basename; only what it is announced by grows.
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
  // The row used to end with a `needs you` chip, on the folded card as well as the open one,
  // read out of the two rows a summary can close with. It was never acted on, and it put a
  // claim taken from the agent's own prose at the end of a row of figures the panel counted
  // itself. What the summary said it is waiting for is still carried, in the marks the head
  // row is announced and hovered by.
  const both = closingCard([
    '- 🙋 **Your actions** — reload the window and confirm.',
    '- ❓ **Open questions / follow-ups** — (1) keep the store? (2) rename the view?',
  ]);
  assert.ok(
    !both.labels.some((l) => /needs you|waiting|question/i.test(l)),
    'a chip is worded as something the reader has to answer',
  );
  // The tone that chip was drawn in went with it, so nothing on the row is called out in a
  // colour that means "act on this".
  assert.deepEqual(
    [...new Set(both.kinds)],
    ['plain'],
    'a chip on a turn that is waiting is drawn in a tone of its own again',
  );
  assert.deepEqual(both.marks, ['needsYou', 'question']);
  // Each row on its own earns its own mark, and a row written to say it holds nothing earns
  // neither, which is what keeps every turn recorded before the format dropped such a row
  // from reading as one that is waiting on the reader.
  assert.deepEqual(closingCard(['- 🙋 **Your actions** — reload the window.']).marks, ['needsYou']);
  assert.deepEqual(closingCard(['- ❓ **Open questions** — whether to keep the store.']).marks, ['question']);
  assert.deepEqual(closingCard(['- 🙋 **Your actions** — none.']).marks, []);
});

test('a session total is worked out over the turns read, and says so', () => {
  // 1M input tokens on opus-5 at $5/Mtok is exactly $5.00; 1M output at $25/Mtok is $25.00.
  // Two turns of 100k input and 20k output each: 2 * (0.1 * 5 + 0.02 * 25) = $2.00.
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
  assert.deepEqual(chip.detailList, {
    heading: { label: 'Estimated total', value: '$6.13' },
    entries: [{ label: 'Cost by usage · gpt-5.5, opus-5, gpt-5.6', lines: costLines(...lineTexts) }],
    footer: [
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
    chip.detailList?.footer?.filter((line) => line === CACHED_INPUT_READ_EXPLANATION).length,
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
  assert.deepEqual(chip.detailList, {
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
    footer: [
      'Some usage could not be priced, so the estimated total may be low.',
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
      // Two Auto Review spend parts are one block under one heading, as the cost popover
      // draws them. Two blocks headed by the same words left the reader two Output lines and
      // no way to tell which review each belonged to. The heading names the block the way
      // every other cost block is named, with the review as the work the money bought.
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
  // A ledger written before unit 3 recorded neither figure, which is exactly this shape:
  // both null rather than a real number.
  assert.equal(
    sessionTurnStats(turnStats(12))[0].detail,
    '12 turns in the main session\n\nAbout these figures\n  The turn count excludes delegated work.',
  );
});

test('the turn chip hover carries the elapsed span and compaction count', () => {
  const first = Date.UTC(2026, 0, 1, 9, 0, 0);
  const last = first + (2 * 60 + 8) * 60_000; // 2h 8m later
  const detail = sessionTurnStats(
    turnStats(12, {
      compactionCount: 3,
      firstTurnAt: first,
      lastTurnAt: last,
    }),
  )[0].detail;
  assert.equal(
    detail,
    '12 turns in the main session\n' +
      '2h 8m between the first and last turns\nContext compacted 3 times\n\nAbout these figures\n' +
      '  The turn count excludes delegated work.\n  Elapsed time includes gaps between turns.',
  );
});

test('a session with no compactions says so in words rather than a bare zero', () => {
  const detail = sessionTurnStats(turnStats(12, { compactionCount: 0 }))[0].detail;
  assert.match(detail, /\nNo compactions recorded\n/);
  assert.doesNotMatch(detail, /\bIt held 0\b/);
});

test('a single compaction is worded in the singular', () => {
  const detail = sessionTurnStats(turnStats(12, { compactionCount: 1 }))[0].detail;
  assert.match(detail, /\nContext compacted once\n/);
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
          // a.ts again: three distinct paths would be wrong, two is the answer.
          { path: '/w/a.ts', added: 3, removed: 1, isNew: false, edits: [] },
        ],
      }),
    ],
    [],
  );
  assert.equal(statOf(chips, '2 file')?.label, '2 files');
  // 10 + 5 + 3 added, 2 + 0 + 1 removed. Lines are summed across every touch; files are not.
  const lines = chips.find((c) => c.added !== undefined);
  assert.equal(lines?.added, 18);
  assert.equal(lines?.removed, 3);
});

test('context is the newest turn level, never a sum of the turns', () => {
  const chips = sessionStats(
    [
      turn({ contextTokens: 500_000, startedAt: 1_000, endedAt: 2_000 }),
      // The newest, and the only one that counts. 200k of a 1M window is 20%.
      turn({ contextTokens: 200_000, startedAt: 9_000, endedAt: 9_500 }),
    ],
    [],
  );
  const ctx = chips.find((c) => c.label.includes('ctx'));
  assert.equal(ctx?.label, '20% of 1M ctx (200k)');
  assert.match(ctx!.detail, /Context measures the current level, not cumulative token usage\./);
  // 700k, the sum, must appear nowhere: it is the wrong answer and it is the easy mistake.
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
  // Every unpriced turn in the local store is exactly this: model null and no tokens at all,
  // which is a prompt that never reached a model. Counting one as a gap put a "+" on totals
  // that were complete, and the store is the only place that showed it.
  const usage = { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 };
  const chips = sessionStats(
    [turn({ usage, startedAt: 1_000, endedAt: 2_000 }), turn({ model: null, startedAt: 3_000, endedAt: 4_000 })],
    [],
  );
  const cost = statOf(chips, '$');
  assert.equal(cost?.label, '$1.00');
  assert.doesNotMatch(cost!.detail, /floor/);
});

test('a crowded session heading says where a boundary could go, from the second band up', () => {
  // Verbatim, and on a line of its own, on the top two bands.
  for (const share of [CONTEXT_BANDS[1].at, CONTEXT_BANDS[2].at, 0.99]) {
    assert.ok(
      sessionCtxDetail(share).includes(COMPACT_HERE),
      `a window ${share} full does not say where a boundary could go`,
    );
  }
  // Not on the first band, where half a window remains and there is nothing to decide, and
  // not on a quiet session, which is the ordinary answer: three quarters of the
  // sessions measured end under the first band.
  for (const share of [0.1, CONTEXT_BANDS[0].at, CONTEXT_BANDS[1].at - 0.01]) {
    assert.ok(
      !sessionCtxDetail(share).includes(COMPACT_HERE),
      `a window ${share} full is told to compact while most of it is still free`,
    );
  }
  // And it says nothing about how many turns are left. A forecast is an estimated figure,
  // and the panel draws none.
  assert.doesNotMatch(sessionCtxDetail(0.95).join('\n'), /turns? (left|remaining)|per turn|room for/);
});

test('the compaction sentence stays off a turn card, where the moment is already behind the reader', () => {
  const card = toCard(
    turn({
      contextTokens: 800_000,
      model: 'claude-opus-5',
      summary: '- The work landed.',
    }),
    false,
    NOW,
  );
  assert.equal(
    ctxChip(card)!.level,
    'gettingFull',
    'the fixture is not crowded, so nothing below can see the sentence withheld',
  );
  for (const chip of card.chips) {
    assert.ok(!chip.detail.includes(COMPACT_HERE), 'a turn card names a boundary the reader has already gone past');
  }
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
  // Nothing read back from the cache, and nothing to say about it. A line reading $0.00 is a
  // different answer from no line.
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
  // The two readers record a path in different shapes: transcripts write forward slashes and
  // a lower-case drive letter, the store writes backslashes and the cwd's case. Counted with
  // a bare lower-casing these are two files on every platform, and on the filesystems where
  // case really does distinguish two files, a bare lower-casing folds those into one.
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
  // Turn 1's shell names the path with no hunks. Turn 2 edits the same path with real hunks.
  // The heading folds both records of the one path the way `attributedFiles` settles a
  // child's merged row: a path with a count anywhere is a floor, not a blank mention.
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
    '',
    'About these figures',
    '  Each file counts once, even when several turns change it.',
    '  Line totals add recorded edits across those turns, rather than a final net diff.',
    // The sentence names its file, so it never reads as a sentence about the turns above it.
    '  1 file was named by the shell without its lines, so its line counts are partial.',
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
  // A heading over a run of rail cards adds several sessions together, and it cannot add
  // `$1.87`. So the chip keeps the estimate beside the wording rather than throwing it away.
  const usage = { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 };
  const whole = sessionStats(
    [turn({ usage, startedAt: 1_000, endedAt: 2_000 }), turn({ usage, startedAt: 3_000, endedAt: 4_000 })],
    [],
  ).find((chip) => chip.metric === 'cost');
  assert.equal(whole?.compactLabel, '$2.00');
  assert.equal(whole?.dollars, 2);
  // Every turn was priced, so the figure is the total and the label wears no mark.
  assert.equal(whole?.partial, false);

  // Auto Review has a published rate, so its recorded usage makes the total exact.
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

  // Only the cost chip carries either. A context or a file count is not money and adds to
  // nothing, so a caller reading `dollars` off one would be summing the wrong thing.
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
  // The reader is not reading an API. A tool the table knows is said the same way whichever
  // agent ran it, and a call still in flight is said in the present tense, because it is.
  assert.equal(said(step()), 'Read extension/src/store.ts');
  assert.equal(said(step({ status: 'running' })), 'Reading extension/src/store.ts');
  assert.equal(said(step({ name: 'Bash', detail: 'npm test' })), 'Ran npm test');
  assert.equal(said(step({ name: 'Bash', detail: 'npm test', status: 'running' })), 'Running npm test');
  assert.equal(said(step({ name: 'Grep', detail: 'livePressOver' })), 'Searched for livePressOver');
  assert.equal(said(step({ name: 'Edit', detail: 'a.ts' })), 'Edited a.ts');

  // A skill is the one row whose noun needs saying: "Loaded polish" reads as a file.
  assert.equal(said(step({ name: 'Skill', detail: 'polish' })), 'Loaded the polish skill');
  assert.equal(said(step({ name: 'Skill', detail: '' })), 'Loaded a skill');

  // Codex names its own tools, and a rollout writes no arguments for the exec sandbox, so
  // that row carries the verb and nothing else. That is what the record holds.
  assert.equal(said(step({ name: 'exec', detail: '' })), 'Ran');
  assert.equal(said(step({ name: 'apply_patch', detail: 'src/a.ts' })), 'Edited src/a.ts');
  // A verb with nothing after it loses its colon. Measured over this workspace's own
  // rollouts: a Codex turn is mostly exec and spawn_agent, and neither records an argument
  // this reads, so the row that says only what was done is the common one there.
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

  // A tool the table has never heard of is drawn as the agent named it. A verb invented for
  // it would be the panel saying something nobody recorded.
  assert.equal(said(step({ name: 'DesignSync', detail: 'the canvas' })), 'DesignSync: the canvas');
  assert.equal(said(step({ name: 'DesignSync', detail: '' })), 'DesignSync');
});

test('what the agent handed the tool is kept apart from the words about it', () => {
  // The command, the path, the pattern and the URL are read character by character, so they
  // are drawn in the editor's face and the words in front of them are not.
  assert.deepEqual(
    [stepLine(step({ name: 'Bash', detail: 'npm test' })), stepCode(step({ name: 'Bash', detail: 'npm test' }))],
    ['Ran', 'npm test'],
  );
  assert.equal(stepCode(step()), 'extension/src/store.ts');
  assert.equal(stepCode(step({ name: 'Grep', detail: 'livePressOver' })), 'livePressOver');
  // A tool the table has never heard of still handed its argument to something, so the
  // argument is a literal and the name in front of it is the words.
  assert.deepEqual(
    [
      stepLine(step({ name: 'DesignSync', detail: 'the canvas' })),
      stepCode(step({ name: 'DesignSync', detail: 'the canvas' })),
    ],
    ['DesignSync:', 'the canvas'],
  );

  // What a person wrote stays in the prose face. A brief for a subagent and a web query are
  // sentences, and a skill is named inside one, so none of the three is a literal to run.
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
  // The glyph in front of a failed row is the only thing on it the line does not already
  // say, so the words say it too: colour and shape are never the only place a fact is.
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
  // The agent answers a mid-turn prompt inside the turn, so the log that shows the answer
  // has to show the question. It sits where it was sent, between the calls that came before
  // it and the ones that came after.
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
  // The reader's row is not a call: it carries no literal, no clock and nothing that says
  // an answer came back.
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

  // And the calls keep the order the transcript wrote them in. Their times place a prompt;
  // they are not what the calls themselves are sorted by.
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
  // The symptom: an ordinary narration block was cut on the card. The median recorded Codex
  // block is 284 characters and its 90th percentile is 417, so a bound of 120 cut nearly
  // every one of them, and a quarter of Claude's.
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
  // Claude Code writes a queued prompt when the agent picks it up, not when the reader
  // presses. Measured on a real transcript: the record carried the press time and was
  // appended 76 seconds later, and for that whole minute the card showed the answer to a
  // question it did not show. The panel knows it sent the prompt, so the card says so.
  const running = turn({ startedAt: 1_000, endedAt: 9_000, finished: false });
  const sent = { text: 'follow up msg test', at: 5_000, midTurn: true };
  const ask = pendingAskOf(running, sent, true);
  assert.deepEqual(ask, { text: 'follow up msg test', at: 5_000, stepsBefore: 0 });

  // Gone the moment the transcript carries the same words. The two are one prompt, and the
  // copy that goes is the panel's own memory of it.
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
  // The composer holds the line the reader typed. The transcript records the same prompt as
  // two tags on separate lines, and the panel drops its own copy only when the two clean to
  // one string. Joined by a newline instead of a space they compare unequal, and the card
  // draws the reader's prompt twice until the turn stops.
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
  // And the log carries it too, after every call the turn has recorded, which is when it
  // happened.
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
  // A turn asked something while it was writing prose has run no tool, and a control saying
  // "0 steps" over a row that is plainly there contradicts its own contents.
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

  // Both, when the turn did both. The calls lead, because they are what the section is
  // mostly made of.
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

  // And a turn nobody typed into says exactly what it said before there was anything else
  // to count.
  assert.equal(
    toCard(turn({ steps: [step()], stepCount: 1, toolCounts: counts({ reads: 1 }) }), false, NOW).activityName,
    'Activity, 1 step, 1 read',
  );
});

test('a card says how many steps it is not showing', () => {
  // A count on the heading that does not match the rows under it is the panel quietly
  // under-reporting, which is the one thing a record of what happened may not do.
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
  // The newest step, and only while it is still running. A finished step drawn on a card
  // that is still running says the agent is on something the panel cannot see, which is the
  // silence the line is there to fill.
  assert.equal(doingOf(turn({ steps: [step({ status: 'running' })], stepCount: 1 }))?.name, 'Read');
  assert.equal(doingOf(turn({ steps: [step()], stepCount: 1 })), null);
  assert.equal(doingOf(turn({ steps: [], stepCount: 0 })), null);
  // The newest, never an older one that is still open. Two calls sent together both run, and
  // the last is the one the line names.
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

  // A finished turn shuts it, because the answer is what the reader came for by then.
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

// The floor price of the next turn rests on two facts about one request: when it happened and
// which cache lifetime it bought. A turn is not that request. It sums every request it made and
// it ends on whichever record came last, so both of those answers are wider than the question.
const CONTEXT_REQUEST = {
  at: 9_000,
  lifetime: '1h' as const,
  inferenceClass: null,
  serviceTier: null,
  readBack: true,
  outputTokens: 100,
};

test('the floor is dated by the request that set the level, not by the end of the turn', () => {
  // A tool result, an interruption and a background notification all move a turn's end. None
  // of them is a model request, and none of them refreshes a cache.
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
  // The turn wrote far more at one hour early on and finished on a five-minute write. The sum
  // says one hour, the request says five minutes, and only the request is about this cache.
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
  // The compaction is itself a request, so it is what any lifetime would be measured against.
  assert.equal(basis?.lastRequestAt, 30_000);
  // It records no cache write and no cache read for the history it wrote, so the lifetime the
  // turn before it bought says nothing about the context that is there now. Carrying that
  // lifetime over would call a replacement nobody has cached warm.
  assert.equal(basis?.tier, null);
  assert.equal(basis?.readBack, false);
  // Nothing has cached the replacement, which is a fact about the record rather than a gap in
  // it. The composer needs to tell the two apart, so the basis says which one this is.
  assert.equal(basis?.afterCompaction, true);
});

// The same request-versus-turn scope error the lifetime and the clock already answer. A turn
// ends on whichever record came last, and a tool result or a synthetic response is one, so a
// compaction can be newer than every request the turn made and older than the turn itself.
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
  // A skill read from a Codex command and also loaded by a native call is one row, and the
  // recorded load is what the row says: a file read is an inference and a named load is proof.
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

test('a compaction card estimates each measured Claude compaction within 20% of its real cost', () => {
  const folder = tempDir('compaction-card-');
  for (const row of COMPACTION_SAMPLES) {
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

// A dispatched session whose cost has not joined has no usage in the parts yet. Every popover
// layout draws the delegated line that holds that work with the lower-bound mark, even with no
// delegated usage at all, and the lines drawn per scope or per model carry none.
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

  // Delegated usage with no price still leaves the line a lower bound of what is priced.
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
    /Estimated as 163k of cached input reads, 7k of new cache writes, and 2k of uncached input, because the session was still cached\./,
  );
  assert.match(warm, /Claude Code records no usage for a compaction/);
  // A request before it that missed the cache leaves the warm estimate nothing to read.
  const missed = detail({
    previousRequest: { tokens: 137_049, cacheRead: 0, cacheWrite: 137_047, at: at - 20_000, lifetime: '5m' },
  });
  assert.match(
    missed,
    /Estimated as 137k of new cache writes and 2k of uncached input, because the request before it read no cached input\./,
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
  const cold = detail({ previousRequest: lapsed, firstRequestCacheRead: 10_086 });
  assert.match(
    cold,
    /Estimated as 10k of cached input reads and 222k of uncached input, because the cache had expired and the context was sent again without it\./,
  );
  assert.doesNotMatch(cold, /cache write/);
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

test('a dispatched share adds the session total footer notes for its compactions and auto reviews', () => {
  const notes = (part: DispatchedCostUsage) =>
    costFigure(
      toCard(turn(), false, NOW, [], null, false, new Set(), [dispatchedCost({ parts: [part] })]),
    ).detailList!.footer!.join(' ');
  assert.match(notes(dispatchedPart(1_000_000, { compactionEstimate: true })), /estimated \$1\.00 for /);
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
    // A contribution that cannot be shown to hold the printed requests drops its own transcript,
    // keeps every other group, and counts the rows.
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
