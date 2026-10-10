import { composerView, pickMenu, sessionLauncherView } from '../src/composerview.ts';
import { labelCounts } from '../src/turnlabels.ts';
import { formatRelative, railSessions, toCard } from '../src/turnview.ts';
import {
  dispatchedAgentCard,
  dispatchedChip,
  nextTurnBasisOf,
  priceDispatchedParts,
  sessionCacheExpiryStats,
  sessionCostStats,
  sessionCostProjection,
  turnCacheExpiryWarning,
  sessionStats,
} from '../src/turncard.ts';
import {
  classifyCacheExpiry,
  emptyCacheExpiryFacts,
  emptyUsage,
  prepareProjectSpendView,
  publicProjectSpendPrice,
} from '../src/projectspend.ts';
import { cacheLifetimeFor, contextBandForRequest } from '../src/pricing.ts';
import type { CacheExpiryCarry, ProjectUsageBucket, SpendFileIndex } from '../src/projectspend.ts';
import { usageBar } from '../src/usageview.ts';
import type { AgentUsage } from '../src/usageview.ts';
import { renderRichMarkdown } from '../src/richtext.ts';
import { skillUse, subagent, turn } from '../src/turnfixtures.ts';
import { SKILL_STEP_KIND, type Turn } from '../src/transcript.ts';
import type { TurnComment } from '../src/turncomments.ts';
import { railCacheMarkOf, sessionParentOf } from '../src/turnrail.ts';
import { DEMO_DEFAULTS, DEMO_MODELS } from './demo-catalog.ts';
import type { PinnedSetup } from '../src/domain/session-setups.ts';
import type { RailCard, RailStatus, SessionParentEdge } from '../src/turnrail.ts';
import { RAIL_FOLDS } from '../src/view/rail.ts';
import type { Ask } from '../src/agentwire.ts';
import { addUsage } from '../src/agentspend.ts';

export const CAPTURE_TIME = Date.parse('2026-09-15T14:42:00-05:00');
// Browser timezone for captures.
export const CAPTURE_ZONE = 'America/Chicago';
// Session list width for README captures and the web demo.
export { STATIC_PAGE_RAIL_WIDTH as CAPTURE_RAIL_WIDTH } from '../src/view/static-page.ts';
export const DEMO_RAIL_FOLDS = { [RAIL_FOLDS.agent]: false, [RAIL_FOLDS.archived]: false };
export const ROOT = 'C:/sample/arc';
const TEST_WORKTREE = `${ROOT}/.claude/worktrees/read-state-tests`;
const start = CAPTURE_TIME - 22 * 60_000;
const demoSolStartedAt = start + 6 * 60_000;
const file = (name: string, added: number, removed: number, isNew = false) => ({
  path: `${ROOT}/${name}`,
  added,
  removed,
  isNew,
  edits: [],
});

const readStateTurn: Turn = turn({
  agent: 'codex',
  sessionId: 'arc-read-state',
  sessionTitle: 'Keep unread results visible',
  promptId: 'unread-results',
  startedAt: start,
  endedAt: start + 14 * 60_000,
  prompt:
    'Keep finished sessions unread until I open them. Check switching views, and show the files and commits for this turn.',
  summary:
    'Finished sessions stay unread until you open their results. Switching views keeps that mark in place.\n\nOpening one result clears only its own mark. The regression test checks both paths.',
  model: 'gpt-6-astra',
  effort: 'high',
  files: [],
  commits: [
    {
      sha: 'b4e7c21',
      subject: 'fix(rail): keep unread results visible across views',
      head: { kind: 'branch', name: 'unread-results' },
      files: 2,
      added: 59,
      removed: 19,
      at: start + 10 * 60_000,
      place: null,
      dir: ROOT,
    },
    {
      sha: 'd29a6f4',
      subject: 'test(rail): cover read state after switching views',
      head: { kind: 'branch', name: 'test/read-state' },
      files: 1,
      added: 44,
      removed: 6,
      at: start + 13 * 60_000,
      place: { kind: 'worktree', dir: TEST_WORKTREE },
      dir: TEST_WORKTREE,
    },
  ],
  agents: [
    subagent({
      id: 'sol-implementation',
      childSessionId: 'arc-sol-read-state',
      description: 'Preserve unread state across views',
      model: 'gpt-6-sol',
      effort: 'medium',
      spend: [
        {
          model: 'gpt-6-sol',
          usage: {
            requests: 18,
            input: 128_000,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheRead: 2_320_000,
            output: 136_000,
            thinking: 0,
          },
        },
      ],
      durationMs: 192_000,
      tokens: 2_584_000,
      toolUses: 18,
      commits: [
        {
          sha: 'b4e7c21',
          subject: 'fix(rail): keep unread results visible across views',
          head: { kind: 'branch', name: 'unread-results' },
          files: 2,
          added: 59,
          removed: 19,
          at: start + 10 * 60_000,
          place: null,
          dir: ROOT,
        },
      ],
      artifacts: {
        files: [
          file('extension/src/webview/read-state.ts', 38, 12),
          file('extension/src/webview/session-state.ts', 21, 7),
        ],
        commits: ['b4e7c21'],
        complete: true,
        revision: 'sol-implementation',
      },
    }),
    subagent({
      id: 'luna-tests',
      description: 'Check the view-switching test',
      model: 'gpt-6-luna',
      effort: 'medium',
      spend: [
        {
          model: 'gpt-6-luna',
          usage: {
            requests: 12,
            input: 72_000,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheRead: 1_380_000,
            output: 84_000,
            thinking: 0,
          },
        },
      ],
      durationMs: 68_000,
      tokens: 1_536_000,
      toolUses: 7,
      commits: [
        {
          sha: 'd29a6f4',
          subject: 'test(rail): cover read state after switching views',
          head: { kind: 'branch', name: 'test/read-state' },
          files: 1,
          added: 44,
          removed: 6,
          at: start + 13 * 60_000,
          place: { kind: 'worktree', dir: TEST_WORKTREE },
          dir: TEST_WORKTREE,
        },
      ],
      artifacts: {
        files: [file('extension/src/webview/read-state.test.ts', 44, 6)],
        commits: ['d29a6f4'],
        complete: true,
        revision: 'luna-tests',
      },
    }),
    subagent({
      id: 'background-review',
      description: 'Background review',
      model: 'codex-auto-review',
      effort: 'low',
      spend: [
        {
          model: 'codex-auto-review',
          usage: {
            requests: 2,
            input: 900,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheRead: 15_000,
            output: 1_000,
            thinking: 0,
          },
        },
      ],
      durationMs: 42_000,
      tokens: 16_900,
      toolUses: 5,
      artifacts: { files: [], commits: [], complete: true, revision: 'background-review' },
    }),
  ],
  usage: {
    requests: 12,
    input: 54_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheRead: 1_720_000,
    output: 62_000,
    thinking: 0,
  },
  contextTokens: 52_000,
  contextWindow: 258_400,
  toolUses: 22,
  toolCounts: { edits: 3, reads: 8, searches: 3, commands: 4, agents: 3, coordination: 1, web: 0, other: 0 },
});

// Each synthetic request stays within the short-context pricing band.
readStateTurn.usage.byContextBand = { short: { ...readStateTurn.usage } };
for (const agent of readStateTurn.agents) {
  for (const part of agent.spend) part.usage.byContextBand = { short: { ...part.usage } };
}

const README_REPOSITORY = { key: `${ROOT}/.git`, root: ROOT, own: true };
const readmeFilesTurn: Turn = {
  ...readStateTurn,
  files: [file('extension/src/webview/navigation.ts', 12, 4)],
  commits: readStateTurn.commits.map((commit) => ({ ...commit, repository: README_REPOSITORY })),
  agents: readStateTurn.agents.map((agent) => ({
    ...agent,
    commits: agent.commits?.map((commit) => ({ ...commit, repository: README_REPOSITORY })),
  })),
  landings: [
    {
      id: 'readme-merge-read-state-tests',
      sha: 'd29a6f4',
      subject: 'test(rail): cover read state after switching views',
      from: 'test/read-state',
      mergedBranch: 'test/read-state',
      head: { kind: 'branch', name: 'main' },
      at: start + 13.5 * 60_000,
      place: null,
      dir: ROOT,
      repository: README_REPOSITORY,
    },
    {
      id: 'readme-merge-keyboard-focus',
      sha: 'a87f3d2',
      subject: 'fix(navigation): preserve focus after restoring tabs',
      from: 'keyboard-focus',
      mergedBranch: 'keyboard-focus',
      head: { kind: 'branch', name: 'main' },
      at: start + 14 * 60_000,
      place: null,
      dir: ROOT,
      repository: README_REPOSITORY,
    },
  ],
};

const changesTurn: Turn = turn({
  sessionId: 'arc-open-changes',
  sessionTitle: 'Open changed files',
  promptId: 'open-changed-files',
  startedAt: start - 31 * 60_000,
  endedAt: start - 19 * 60_000,
  prompt: 'Let me open a changed file or the full turn diff from the review card. Cover restored session tabs.',
  summary: 'File names and Open the changes remain available after restoring a session tab.',
  model: 'claude-opus-5-5',
  files: [
    file('extension/src/webview/card-rows.ts', 27, 8),
    file('extension/src/webview/card.ts', 14, 5),
    file('extension/src/panel.webview.test.ts', 35, 0),
  ],
  commits: [
    {
      sha: 'a61d9e3',
      subject: 'fix(review): open changed files from restored tabs',
      head: { kind: 'branch', name: 'open-changes' },
      files: 3,
      added: 76,
      removed: 13,
      at: start - 20 * 60_000,
      place: null,
      dir: ROOT,
    },
  ],
  agents: [
    subagent({
      id: 'changes-check',
      description: 'Check file and diff navigation',
      model: 'claude-sonnet-5-5',
      spend: [
        {
          model: 'claude-sonnet-5-5',
          usage: {
            requests: 8,
            input: 42_000,
            cacheWrite1h: 0,
            cacheWrite5m: 160_000,
            cacheRead: 1_280_000,
            output: 46_000,
            thinking: 0,
          },
        },
      ],
      durationMs: 94_000,
      tokens: 1_528_000,
      toolUses: 9,
      artifacts: { files: [], commits: [], complete: true, revision: 'changes-check' },
    }),
  ],
  usage: {
    requests: 12,
    input: 54_000,
    cacheWrite1h: 0,
    cacheWrite5m: 240_000,
    cacheRead: 1_720_000,
    output: 62_000,
    thinking: 0,
  },
  contextTokens: 52_000,
  contextWindow: 200_000,
  toolUses: 22,
  toolCounts: { edits: 3, reads: 8, searches: 3, commands: 6, agents: 1, coordination: 1, web: 0, other: 0 },
});

const nextTurn: Turn = {
  ...changesTurn,
  model: 'claude-fable-5-1',
  contextTokens: 198_000,
  contextWindow: 1_000_000,
  usage: { ...emptyUsage(), requests: 1, cacheWrite1h: 198_000, output: 50 },
  contextRequest: {
    at: changesTurn.endedAt,
    lifetime: '1h',
    inferenceClass: null,
    serviceTier: null,
    readBack: true,
    outputTokens: 50,
  },
};

const beforeExpiry: Turn = turn({
  agent: 'claude',
  sessionId: changesTurn.sessionId,
  sessionTitle: changesTurn.sessionTitle,
  promptId: 'inspect-file-navigation',
  startedAt: changesTurn.startedAt - 83 * 60_000,
  endedAt: changesTurn.startedAt - 72 * 60_000,
  prompt: 'Inspect file and diff navigation in the review card before changing restored tabs.',
  summary: 'The file and full diff actions open the editor from an active session tab.',
  model: changesTurn.model,
  usage: {
    requests: 1,
    input: 2_000,
    cacheWrite1h: 126_000,
    cacheWrite5m: 0,
    cacheRead: 0,
    output: 1_000,
    thinking: 0,
  },
  contextTokens: 128_000,
  contextWindow: 200_000,
});

const expiryUsage = {
  requests: 1,
  input: 2_000,
  cacheWrite1h: 160_000,
  cacheWrite5m: 0,
  cacheRead: 0,
  output: 2_300,
  thinking: 0,
};
const expiryTurn: Turn = { ...changesTurn, usage: expiryUsage, contextTokens: 162_000 };
const expiryHistory: Turn[] = [
  expiryTurn,
  { ...beforeExpiry, usage: expiryUsage, contextTokens: 162_000 },
  {
    ...beforeExpiry,
    promptId: 'trace-restored-file-actions',
    startedAt: beforeExpiry.startedAt - 83 * 60_000,
    endedAt: beforeExpiry.endedAt - 83 * 60_000,
    prompt: 'Trace file actions after restoring a session tab.',
    usage: expiryUsage,
    contextTokens: 162_000,
  },
  {
    ...beforeExpiry,
    promptId: 'inspect-restored-session',
    startedAt: beforeExpiry.startedAt - 166 * 60_000,
    endedAt: beforeExpiry.endedAt - 166 * 60_000,
    prompt: 'Inspect the restored session and its changed files.',
  },
].map((item) => ({
  ...item,
  openingResponseId: `demo-${item.promptId}`,
  contextRequest: {
    at: item.startedAt,
    lifetime: '1h' as const,
    inferenceClass: null,
    serviceTier: null,
    readBack: false,
    outputTokens: item.usage.output,
  },
}));
const expiryRequest: ProjectUsageBucket = {
  localDate: '2026-09-15',
  agent: 'claude',
  provider: null,
  model: changesTurn.model,
  contextWindow: 200_000,
  contextBand: 'short',
  billingClass: 'metered',
  inferenceClass: null,
  serviceTier: null,
  reportedCost: null,
  usage: expiryUsage,
  requests: 1,
};
const previousRequest: CacheExpiryCarry = {
  requestKey: 'inspect-file-navigation',
  timestamp: beforeExpiry.startedAt,
  visibleTurnId: beforeExpiry.promptId,
  lifetime: '1h',
  model: changesTurn.model,
  provider: null,
  serviceTier: null,
  inferenceClass: null,
  compactionsBefore: 0,
  inputTokens: beforeExpiry.usage.input + beforeExpiry.usage.cacheWrite1h,
  incomplete: false,
};
const expiryFacts = emptyCacheExpiryFacts();
for (let index = expiryHistory.length - 2; index >= 0; index--) {
  const current = expiryHistory[index];
  const previous = expiryHistory[index + 1];
  const carry = (item: Turn): CacheExpiryCarry => ({
    ...previousRequest,
    requestKey: `claude:${item.openingResponseId}`,
    visibleTurnId: item.promptId,
    timestamp: item.startedAt,
    inputTokens: item.usage.input + item.usage.cacheWrite1h,
  });
  const verdict = classifyCacheExpiry(carry(previous), carry(current), current.usage);
  if (verdict.kind !== 'return') throw new Error('The README return request did not cross its cache lifetime.');
  expiryFacts.counts[verdict.lifetime]++;
  expiryFacts.longestGapMs = Math.max(expiryFacts.longestGapMs ?? 0, verdict.gapMs);
  expiryFacts.returns.push({
    lifetime: verdict.lifetime,
    gapMs: verdict.gapMs,
    request: { ...expiryRequest, usage: current.usage },
    visibleTurnId: current.promptId,
    requestKey: carry(current).requestKey,
    previousInputSide: carry(previous).inputTokens,
  });
}

const cacheUsage: Turn['usage'] = {
  requests: 48,
  input: 50_000,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWrite30m: 6_000_000,
  cacheRead: 20_000,
  output: 12_000,
  thinking: 0,
};
const cacheTurn: Turn = turn({
  agent: 'codex',
  sessionId: 'arc-cache-run',
  sessionTitle: 'Inspect low cache reuse',
  promptId: 'cache-run',
  startedAt: start - 2 * 60 * 60_000,
  endedAt: start - 60 * 60_000,
  prompt: 'Find why this long Arc test run spent so much on input. Show cache writes and reads.',
  summary:
    'This run recorded repeated cache writes with little reuse. The cost detail shows how much went to cache writes.',
  model: 'openai.gpt-6-sol',
  provider: 'amazon-bedrock',
  effort: 'medium',
  usage: { ...cacheUsage, byContextBand: { short: { ...cacheUsage } } },
  usageParts: [
    {
      model: 'openai.gpt-6-sol',
      provider: 'amazon-bedrock',
      contextWindow: 258_400,
      contextBand: 'short',
      inferenceClass: null,
      serviceTier: null,
      usage: cacheUsage,
    },
  ],
  contextTokens: 130_000,
  contextWindow: 258_400,
  toolUses: 7,
  toolCounts: { edits: 0, reads: 3, searches: 1, commands: 3, agents: 0, coordination: 0, web: 0, other: 0 },
});

export const README_SCENES = [
  'main',
  'review',
  'files',
  'comment',
  'comment-editor',
  'session-menu',
  'response-menu',
  'cost',
  'next-turn',
  'cache-expiry',
  'cache',
  'project-cost',
  'usage',
] as const;

// Derive the capture day in the capture timezone so host timezone changes leave it unchanged.
const CAPTURE_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: CAPTURE_ZONE }).format(CAPTURE_TIME);

function spendDate(daysBack: number): string {
  const date = new Date(`${CAPTURE_DAY}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysBack);
  return date.toISOString().slice(0, 10);
}

// Use noon of the capture day on the host calendar for Project cost windows.
const [captureYear, captureMonth, captureDate] = CAPTURE_DAY.split('-').map(Number);
const SPEND_NOW = new Date(captureYear, captureMonth - 1, captureDate, 12).getTime();

// Estimate the context band from average request input. Production indexing bands individual requests.
function spendBucket(
  agent: 'claude' | 'codex',
  daysBack: number,
  tokens: { input: number; cacheRead: number; output: number },
  requests: number,
): ProjectUsageBucket {
  const provider = agent === 'codex' ? 'openai' : null;
  const model = agent === 'codex' ? 'gpt-6-astra' : 'claude-opus-5-5';
  return {
    localDate: spendDate(daysBack),
    agent,
    provider,
    model,
    contextWindow: null,
    contextBand: contextBandForRequest(model, provider, Math.ceil((tokens.input + tokens.cacheRead) / requests)),
    billingClass: 'metered',
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    usage: { ...emptyUsage(), ...tokens, requests },
    requests,
  };
}

function spendFile(agent: 'claude' | 'codex', buckets: ProjectUsageBucket[]): SpendFileIndex {
  return {
    file: `C:/sample/${agent}/${agent}-sessions.jsonl`,
    workspace: ROOT,
    size: 1,
    mtimeMs: CAPTURE_TIME - 60_000,
    offset: 0,
    trailing: '',
    buckets,
    parserKind: agent,
    indexedAt: CAPTURE_TIME - 60_000,
  };
}

const README_PROJECT_SPEND = {
  ...prepareProjectSpendView(
    [
      spendFile('claude', [
        spendBucket('claude', 0, { input: 210_000, cacheRead: 18_000_000, output: 52_000 }, 40),
        spendBucket('claude', 3, { input: 900_000, cacheRead: 90_000_000, output: 260_000 }, 210),
        spendBucket('claude', 17, { input: 2_400_000, cacheRead: 240_000_000, output: 700_000 }, 600),
      ]),
      spendFile('codex', [
        spendBucket('codex', 0, { input: 90_000, cacheRead: 2_600_000, output: 12_000 }, 18),
        spendBucket('codex', 2, { input: 400_000, cacheRead: 13_000_000, output: 50_000 }, 90),
        spendBucket('codex', 12, { input: 1_000_000, cacheRead: 33_000_000, output: 130_000 }, 230),
      ]),
    ],
    publicProjectSpendPrice,
    { now: SPEND_NOW, name: 'Project cost' },
  ),
  calculating: false,
  indexingStatus: null,
};

// Each agent has a usage reading from one minute before capture.
const README_USAGE: AgentUsage[] = [
  {
    agent: 'claude',
    plan: 'max',
    spend: null,
    checkedAt: CAPTURE_TIME - 60_000,
    windows: [
      {
        window: 'session',
        group: 'session',
        scope: '',
        utilization: 0.34,
        resetsAtSeconds: CAPTURE_TIME / 1000 + 9_600,
        status: '',
        readAt: CAPTURE_TIME - 60_000,
      },
      {
        window: 'weekly_all',
        group: 'weekly',
        scope: '',
        utilization: 0.21,
        resetsAtSeconds: CAPTURE_TIME / 1000 + 280_000,
        status: '',
        readAt: CAPTURE_TIME - 60_000,
      },
    ],
  },
  {
    agent: 'codex',
    plan: 'pro',
    spend: null,
    checkedAt: CAPTURE_TIME - 60_000,
    windows: [
      {
        window: 'five_hour',
        group: 'session',
        scope: '',
        utilization: 0.52,
        resetsAtSeconds: CAPTURE_TIME / 1000 + 6_300,
        status: '',
        readAt: CAPTURE_TIME - 60_000,
      },
      {
        window: 'seven_day',
        group: 'weekly',
        scope: '',
        utilization: 0.18,
        resetsAtSeconds: CAPTURE_TIME / 1000 + 350_000,
        status: '',
        readAt: CAPTURE_TIME - 60_000,
      },
    ],
  },
];

const DEMO_SKILL_PATH = `${ROOT}/.claude/skills/review-changes/SKILL.md`;

const demoCodexReadStateTurn: Turn = {
  ...readStateTurn,
  agents: readStateTurn.agents.map((agent) =>
    agent.id === 'luna-tests'
      ? { ...agent, childSessionId: 'arc-luna-read-state-tests' }
      : agent.id === 'sol-implementation'
        ? { ...agent, status: 'running', startedAt: demoSolStartedAt, spendPartial: true, durationMs: null }
        : agent,
  ),
  summary: `${readStateTurn.summary}\n\n| Check | Result |\n| --- | --- |\n| Switch views | Unread mark stays visible |\n| Open a result | Only that result becomes read |`,
  steps: [
    { ordinal: 16, name: 'rg', detail: 'read-state view-switching test', at: start + 3 * 60_000, status: 'done' },
    {
      ordinal: 17,
      name: 'npm test',
      detail: 'read-state test failed after switching views',
      at: start + 4 * 60_000,
      status: 'failed',
    },
    {
      ordinal: 18,
      name: 'Edit',
      detail: 'extension/src/webview/read-state.ts',
      at: start + 6 * 60_000,
      status: 'done',
    },
    { ordinal: 19, name: 'npm test', detail: 'read-state test passed', at: start + 8 * 60_000, status: 'done' },
    { ordinal: 20, name: 'Agent', detail: 'Check view-switching behavior', at: start + 9 * 60_000, status: 'done' },
    {
      ordinal: 21,
      name: 'Send message',
      detail: 'Review the read-state result',
      at: start + 11 * 60_000,
      status: 'done',
    },
    {
      ordinal: 22,
      name: 'Read',
      detail: 'extension/src/webview/read-state.test.ts',
      at: start + 12 * 60_000,
      status: 'done',
    },
    // Codex reads SKILL.md through a command. The fixture includes that command and its best-effort skill use.
    {
      ordinal: 23,
      name: 'exec_command',
      detail: `Get-Content ${DEMO_SKILL_PATH}`,
      at: start + 12.5 * 60_000,
      status: 'done',
    },
  ],
  skillUses: [
    skillUse({
      sourceId: 'demo-read-state-skill',
      name: 'review-changes',
      description: 'Review a change before it lands',
      path: DEMO_SKILL_PATH,
      at: start + 12.5 * 60_000,
      evidence: 'best-effort',
    }),
  ],
  skillUseCount: 1,
  toolUses: 23,
  toolCounts: { ...readStateTurn.toolCounts, commands: readStateTurn.toolCounts.commands + 1 },
  updates: [
    {
      sourceId: 'demo-read-state-start',
      stepsBefore: 16,
      kind: 'commentary',
      text: 'The view-switching test shows an unread result losing its mark. I will keep that mark with its session.',
      at: start + 3 * 60_000,
      status: 'done',
    },
    {
      sourceId: 'demo-read-state-recovery',
      stepsBefore: 19,
      kind: 'commentary',
      text: 'The test passes after the read-state change. I will check the result after switching views again.',
      at: start + 8 * 60_000,
      status: 'done',
    },
  ],
  stepCount: 23,
  stepKinds: [
    'edits',
    'edits',
    'reads',
    'reads',
    'reads',
    'reads',
    'reads',
    'reads',
    'reads',
    'searches',
    'searches',
    'commands',
    'commands',
    'agents',
    'agents',
    'searches',
    'commands',
    'edits',
    'commands',
    'agents',
    'coordination',
    'reads',
    'commands',
  ],
  failedOrdinals: [17],
  failures: [{ tool: 'npm test', message: 'The read-state test failed after switching views.' }],
};

const demoReadStateTurn: Turn = {
  ...demoCodexReadStateTurn,
  agent: 'claude',
  model: 'claude-opus-5-5',
  contextWindow: 200_000,
  agents: demoCodexReadStateTurn.agents.map((agent) => {
    const model = agent.id === 'background-review' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5-5';
    return {
      ...agent,
      model,
      effort: agent.id === 'background-review' ? null : 'high',
      spend: agent.spend.map((part) => ({ ...part, model })),
    };
  }),
  steps: [
    ...demoCodexReadStateTurn.steps.map((step) =>
      step.ordinal === 23
        ? { ...step, name: 'Skill', detail: 'review-changes' }
        : step.ordinal === 16
          ? { ...step, name: 'Read', detail: 'extension/src/webview/read-state.test.ts' }
          : step,
    ),
    {
      ordinal: 24,
      name: 'Bash',
      detail: 'codex exec --json --model gpt-6.1-sol -c model_reasoning_effort=high "Review the read-state change"',
      at: start + 12.6 * 60_000,
      status: 'done',
    },
  ],
  skillUses: demoCodexReadStateTurn.skillUses.map((use) =>
    skillUse({ sourceId: use.sourceId, name: use.name, description: use.description, path: use.path, at: use.at }),
  ),
  stepCount: 24,
  stepKinds: [
    ...demoCodexReadStateTurn.stepKinds.map((kind, index) =>
      index === 22 ? SKILL_STEP_KIND : kind === 'searches' ? 'reads' : kind,
    ),
    'commands',
  ],
  toolUses: 24,
  toolCounts: {
    ...demoCodexReadStateTurn.toolCounts,
    reads: demoCodexReadStateTurn.toolCounts.reads + demoCodexReadStateTurn.toolCounts.searches,
    searches: 0,
    other: 0,
  },
};

const demoTestAgent = demoReadStateTurn.agents.find((agent) => agent.id === 'luna-tests')!;
const demoTestEndedAt = demoTestAgent.commits![0].at;

export const DEMO_TURNS: Record<string, Turn[]> = {
  'arc-read-state': [
    demoReadStateTurn,
    turn({
      agent: 'codex',
      sessionId: 'arc-read-state',
      sessionTitle: readStateTurn.sessionTitle,
      promptId: 'inspect-unread-reproduction',
      startedAt: start - 35 * 60_000,
      endedAt: start - 28 * 60_000,
      prompt: 'Reproduce the unread mark disappearing after switching views.',
      summary: 'Switching views removes the unread mark before the result opens. The reproduction uses two sessions.',
      model: 'gpt-6-astra',
      effort: 'high',
      contextTokens: 30_000,
      contextWindow: 258_400,
      contextRequest: {
        at: start - 28 * 60_000,
        lifetime: cacheLifetimeFor('gpt-6-astra', null),
        inferenceClass: null,
        serviceTier: null,
        readBack: false,
        outputTokens: 900,
      },
      usage: { ...emptyUsage(), requests: 1, input: 30_000, output: 900 },
    }),
    turn({
      agent: 'codex',
      sessionId: 'arc-read-state',
      sessionTitle: readStateTurn.sessionTitle,
      promptId: 'map-unread-behavior',
      startedAt: start - 65 * 60_000,
      endedAt: start - 58 * 60_000,
      prompt: 'Map how opening a result changes its session unread state.',
      summary: 'Read marks belong to each response. The session stays unread while another response remains unread.',
      model: 'gpt-6-astra',
      effort: 'high',
      contextTokens: 18_000,
      contextWindow: 258_400,
      contextRequest: {
        at: start - 58 * 60_000,
        lifetime: cacheLifetimeFor('gpt-6-astra', null),
        inferenceClass: null,
        serviceTier: null,
        readBack: false,
        outputTokens: 700,
      },
      usage: { ...emptyUsage(), requests: 1, input: 18_000, output: 700 },
    }),
  ],
  'arc-cache-run': [
    turn({
      agent: 'codex',
      sessionId: 'arc-cache-run',
      sessionTitle: cacheTurn.sessionTitle,
      promptId: 'cache-follow-up',
      startedAt: CAPTURE_TIME - 3 * 60_000,
      endedAt: CAPTURE_TIME,
      finished: false,
      model: 'gpt-6.1-sol',
      effort: 'high',
      prompt: 'Check the repeated cache writes against the current model.',
      summary: 'The recorded run has repeated cache writes with little reuse. Checking the current request settings.',
      contextTokens: 130_000,
      contextWindow: 258_400,
      toolUses: 1,
      toolCounts: { ...turn().toolCounts, commands: 1 },
      steps: [
        {
          ordinal: 1,
          name: 'npm test',
          detail: 'Checking cache accounting',
          at: CAPTURE_TIME - 60_000,
          status: 'running',
        },
      ],
      stepCount: 1,
      stepKinds: ['commands'],
    }),
    cacheTurn,
  ],
  'arc-luna-read-state-tests': [
    turn({
      agent: 'claude',
      sessionId: 'arc-luna-read-state-tests',
      sessionTitle: 'Check the view-switching test',
      promptId: 'subagent-read-state-test-turn',
      startedAt: demoTestEndedAt - demoTestAgent.durationMs!,
      endedAt: demoTestEndedAt,
      prompt: 'Check the view-switching regression test in the read-state worktree.',
      summary:
        'The test checks that switching views preserves unread results. Opening a result clears only its own mark.',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      contextTokens: 18_000,
      contextWindow: 200_000,
      usage: demoTestAgent.spend[0].usage,
      files: [file('extension/src/webview/read-state.test.ts', 44, 6)],
      commits: demoTestAgent.commits,
    }),
  ],
  'arc-sol-read-state': [
    turn({
      agent: 'claude',
      sessionId: 'arc-sol-read-state',
      sessionTitle: 'Preserve unread state',
      promptId: 'subagent-read-state-turn',
      startedAt: demoSolStartedAt,
      endedAt: CAPTURE_TIME,
      finished: false,
      prompt: 'Preserve the unread mark when the reader changes views.',
      summary: 'The unread mark stays with the session until the reader opens its result.',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      contextTokens: 22_000,
      contextWindow: 200_000,
      usage: demoReadStateTurn.agents[0].spend[0].usage,
      files: readStateTurn.agents[0].artifacts!.files.map((item) => ({ ...item, edits: [] })),
      commits: readStateTurn.agents[0].commits,
    }),
  ],
  'delegated-cost': [
    turn({
      agent: 'claude',
      sessionId: 'delegated-cost',
      sessionTitle: 'Count delegated work once',
      promptId: 'delegated-cost-turn',
      startedAt: expiryTurn.startedAt,
      endedAt: CAPTURE_TIME - 4 * 60_000,
      prompt: 'Show main-agent and subagent costs separately. Check file navigation after restoring a session tab.',
      summary: `The session cost separates main-agent usage from delegated usage.\n\n${changesTurn.summary}`,
      model: 'claude-opus-5-5',
      effort: 'high',
      contextTokens: expiryTurn.contextTokens,
      contextWindow: 200_000,
      contextRequest: {
        at: CAPTURE_TIME - 4 * 60_000,
        lifetime: '1h',
        inferenceClass: null,
        serviceTier: null,
        readBack: true,
        outputTokens: 2_300,
      },
      usage: expiryUsage,
      finished: true,
      // Remove these subagent links so only the unread-results session opens Preserve unread state.
      agents: readStateTurn.agents.map((agent) => {
        const unlinked = { ...agent };
        delete unlinked.childSessionId;
        return unlinked;
      }),
      files: [file('extension/src/turncard.ts', 28, 6)],
    }),
    ...expiryHistory.slice(1).map((item) => ({
      ...item,
      sessionId: 'delegated-cost',
      sessionTitle: 'Count delegated work once',
    })),
  ],
  'arc-demo-sketch': [
    turn({
      agent: 'codex',
      sessionId: 'arc-demo-sketch',
      sessionTitle: 'Review unread result changes',
      promptId: 'unread-code-review',
      startedAt: start + 12.6 * 60_000,
      endedAt: start + 13.5 * 60_000,
      prompt:
        'Review the read-state changes and regression tests. Report any correctness issue without changing files.',
      summary:
        'The changes preserve unread marks across view switches. The regression tests cover both sessions and keep opening one result separate from the other.\n\nNo correctness issue found.',
      model: 'gpt-6.1-sol',
      effort: 'high',
      contextTokens: 16_000,
      contextWindow: 258_400,
      usage: { ...emptyUsage(), requests: 8, input: 120_000, cacheRead: 400_000, output: 120_000 },
    }),
  ],
  'arc-demo-dispatch': [
    turn({
      agent: 'claude',
      sessionId: 'arc-demo-dispatch',
      sessionTitle: 'Review the web demo',
      promptId: 'demo-dispatch-prompt',
      startedAt: start - 18 * 60_000,
      endedAt: start - 4 * 60_000,
      prompt: 'Ask Codex to review the web demo. Report any behavior that needs a follow-up.',
      summary:
        'Codex found one read-state issue. Marking a response unread leaves its session outside the Unread filter.\n\nA fresh session can check that small follow-up.',
      model: 'claude-opus-5-5',
      effort: 'high',
      usage: { ...emptyUsage(), requests: 4, input: 8_000, cacheWrite5m: 20_000, cacheRead: 64_000, output: 2_500 },
      contextTokens: 36_000,
      contextWindow: 200_000,
      toolUses: 3,
      toolCounts: { ...turn().toolCounts, reads: 2, commands: 1 },
      steps: [
        { ordinal: 1, name: 'Read', detail: 'extension/scripts/web-demo.ts', at: start - 17 * 60_000, status: 'done' },
        {
          ordinal: 2,
          name: 'Bash',
          detail: 'codex exec --model gpt-6-sol -c model_reasoning_effort=xhigh "Review the web demo"',
          at: start - 16 * 60_000,
          status: 'done',
        },
        { ordinal: 3, name: 'Read', detail: `${ROOT}/demo-review.txt`, at: start - 5 * 60_000, status: 'done' },
      ],
      stepCount: 3,
      stepKinds: ['reads', 'commands', 'reads'],
    }),
  ],
  'arc-demo-review': [
    turn({
      agent: 'codex',
      sessionId: 'arc-demo-review',
      sessionTitle: 'Check the demo read state',
      promptId: 'demo-review-prompt',
      startedAt: start - 16 * 60_000,
      endedAt: start - 5 * 60_000,
      prompt: 'Review the web demo without changing files. Check response read marks and the Unread filter.',
      summary:
        'Marking a response unread does not return its session to the Unread filter.\n\nOpen a response, mark it unread, then select Unread. Its session stays outside the filtered list. Check that both read states change together.',
      model: 'gpt-6-sol',
      effort: 'xhigh',
      usage: { ...emptyUsage(), requests: 7, input: 6_000, cacheRead: 90_000, output: 4_000 },
      contextTokens: 28_000,
      contextWindow: 258_400,
      toolUses: 3,
      toolCounts: { ...turn().toolCounts, reads: 2, commands: 1 },
      steps: [
        {
          ordinal: 1,
          name: 'Read',
          detail: 'extension/scripts/web-demo-adapter.js',
          at: start - 15 * 60_000,
          status: 'done',
        },
        {
          ordinal: 2,
          name: 'Read',
          detail: 'extension/src/web-demo.browser.test.ts',
          at: start - 13 * 60_000,
          status: 'done',
        },
        {
          ordinal: 3,
          name: 'exec_command',
          detail: 'node extension/test.mjs browser src/web-demo.browser.test.ts',
          at: start - 10 * 60_000,
          status: 'done',
        },
      ],
      stepCount: 3,
      stepKinds: ['reads', 'reads', 'commands'],
    }),
  ],
  'arc-demo-continuation': [
    turn({
      agent: 'claude',
      sessionId: 'arc-demo-continuation',
      sessionTitle: 'Check unread marks in fresh context',
      promptId: 'demo-continuation-prompt',
      startedAt: start + 2 * 60_000,
      endedAt: start + 10 * 60_000,
      prompt:
        'Check the demo review finding in fresh context. Focus on marking a response unread and the Unread filter.',
      summary:
        'The follow-up needs the response read marks and session unread state to change together.\n\nCheck opening a response, marking it unread, and switching sessions before selecting Unread.',
      model: 'claude-opus-5-5',
      effort: 'high',
      usage: { ...emptyUsage(), requests: 2, input: 4_000, cacheWrite1h: 9_000, cacheRead: 9_000, output: 1_500 },
      contextTokens: 15_000,
      contextWindow: 200_000,
      toolUses: 1,
      toolCounts: { ...turn().toolCounts, reads: 1 },
      steps: [
        {
          ordinal: 1,
          name: 'Read',
          detail: 'extension/scripts/web-demo-adapter.js',
          at: start + 3 * 60_000,
          status: 'done',
        },
      ],
      stepCount: 1,
      stepKinds: ['reads'],
    }),
  ],
};

DEMO_TURNS['arc-codex-read-state'] = DEMO_TURNS['arc-read-state'].map((item, index) => {
  const source = index === 0 ? demoCodexReadStateTurn : item;
  return {
    ...source,
    sessionId: 'arc-codex-read-state',
    sessionTitle: 'Review unread results with Codex',
    promptId: `codex-${source.promptId}`,
    agents: source.agents.map((agent) => {
      const unlinked = { ...agent };
      delete unlinked.childSessionId;
      return {
        ...unlinked,
        status: 'done' as const,
        spendPartial: false,
        durationMs: agent.id === 'sol-implementation' ? 192_000 : agent.durationMs,
      };
    }),
  };
});
DEMO_TURNS['arc-read-state'] = DEMO_TURNS['arc-read-state'].map((item, index) =>
  index === 0
    ? item
    : {
        ...item,
        agent: 'claude',
        model: 'claude-opus-5-5',
        contextWindow: 200_000,
        startedAt: item.startedAt - (index === 2 ? 60 * 60_000 : 0),
        endedAt: item.endedAt - (index === 2 ? 60 * 60_000 : 0),
        contextRequest: {
          ...item.contextRequest!,
          at: item.contextRequest!.at - (index === 2 ? 60 * 60_000 : 0),
          lifetime: '1h' as const,
        },
        usage: { ...item.usage, input: 0, cacheWrite1h: item.usage.input },
      },
);

for (const [id, turns] of Object.entries(DEMO_TURNS)) {
  for (const item of turns) {
    if (item.agent === 'codex' && !item.usage.byContextBand) {
      const banded = emptyUsage();
      addUsage(banded, item.usage, 'short');
      item.usage = banded;
    }
    item.contextRequest ??= {
      at: item.endedAt,
      lifetime: null,
      inferenceClass: null,
      serviceTier: null,
      readBack: item.usage.cacheRead > 0,
      outputTokens: item.usage.output,
    };
  }
  if (
    id === 'arc-demo-sketch' ||
    id === 'arc-cache-run' ||
    id === 'delegated-cost' ||
    id === 'arc-read-state' ||
    id === 'arc-codex-read-state' ||
    id === 'arc-sol-read-state' ||
    id === 'arc-luna-read-state-tests'
  )
    continue;
  const age =
    id === 'arc-demo-continuation'
      ? 46 * 60_000
      : id === 'arc-demo-dispatch' || id === 'arc-demo-review'
        ? 120 * 60_000
        : 2 * 24 * 60 * 60_000;
  DEMO_TURNS[id] = turns.map((item) => ({
    ...item,
    startedAt: item.startedAt - age,
    endedAt: item.endedAt - age,
    contextRequest: item.contextRequest ? { ...item.contextRequest, at: item.contextRequest.at - age } : undefined,
    ...(id === 'arc-demo-continuation'
      ? {
          contextRequest: {
            at: item.endedAt - age,
            lifetime: '1h' as const,
            inferenceClass: null,
            serviceTier: null,
            readBack: true,
            outputTokens: 1_500,
          },
        }
      : {}),
    steps: item.steps.map((step) => ({ ...step, at: step.at - age })),
    updates: item.updates.map((update) => ({ ...update, at: update.at - age })),
    commits: item.commits.map((commit) => ({ ...commit, at: commit.at - age })),
    agents: item.agents.map((agent) => ({
      ...agent,
      commits: agent.commits?.map((commit) => ({ ...commit, at: commit.at - age })),
    })),
  }));
}

export const DEMO_DEFAULT_EXPIRY = emptyCacheExpiryFacts();
const demoCodexExpiry = emptyCacheExpiryFacts();
const demoDelegatedExpiry = emptyCacheExpiryFacts();
// Request identities let the production warning match the opening response.
for (const turns of Object.values(DEMO_TURNS)) {
  for (const item of turns) {
    if (item.agent === 'claude') item.openingResponseId = `demo-${item.promptId}`;
  }
}
// Single-request turns supply complete adjacent request evidence.
for (const [sessionId, facts] of [
  ['arc-read-state', DEMO_DEFAULT_EXPIRY],
  ['arc-codex-read-state', demoCodexExpiry],
  ['delegated-cost', demoDelegatedExpiry],
] as const) {
  const defaultHistory = DEMO_TURNS[sessionId].filter((item) => item.usage.requests === 1).reverse();
  for (let index = 1; index < defaultHistory.length; index++) {
    const carry = (item: Turn): CacheExpiryCarry => ({
      requestKey: item.agent === 'claude' ? `claude:${item.openingResponseId}` : item.promptId,
      visibleTurnId: item.agent === 'codex' ? `codex-turn:${item.promptId}` : item.promptId,
      timestamp: item.contextRequest!.at,
      lifetime: item.contextRequest!.lifetime,
      model: item.model,
      provider: item.provider ?? null,
      serviceTier: item.contextRequest!.serviceTier,
      inferenceClass: item.contextRequest!.inferenceClass,
      compactionsBefore: 0,
      inputTokens: item.contextTokens,
      incomplete: false,
      effort: item.effort,
    });
    const previous = defaultHistory[index - 1];
    const current = defaultHistory[index];
    const verdict = classifyCacheExpiry(carry(previous), carry(current), current.usage);
    if (verdict.kind !== 'return') continue;
    facts.counts[verdict.lifetime]++;
    facts.longestGapMs = Math.max(facts.longestGapMs ?? 0, verdict.gapMs);
    facts.returns.push({
      lifetime: verdict.lifetime,
      gapMs: verdict.gapMs,
      visibleTurnId: carry(current).visibleTurnId!,
      requestKey: carry(current).requestKey,
      previousInputSide: carry(previous).inputTokens,
      request: {
        localDate: '2026-09-15',
        agent: current.agent,
        provider: current.provider ?? null,
        model: current.model,
        contextWindow: current.contextWindow,
        contextBand: contextBandForRequest(current.model, current.provider ?? null, current.contextTokens),
        billingClass: 'metered',
        inferenceClass: null,
        serviceTier: null,
        reportedCost: null,
        usage: current.usage,
        requests: 1,
      },
    });
  }
}

const DEMO_PINNED_SETUPS: PinnedSetup[] = [
  { id: 'claude-opus-high', agent: 'claude', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'auto' },
  { id: 'codex-sol-high', agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'never' },
];

export function demoContextSample(sessionId: string) {
  const item = DEMO_TURNS[sessionId][0];
  return { agent: item.agent, model: item.model, contextTokens: item.contextTokens, contextWindow: item.contextWindow };
}

export const DEMO_SESSION_IDS = Object.keys(DEMO_TURNS).filter((id) => id !== 'arc-codex-read-state');
DEMO_SESSION_IDS.splice(1, 0, 'arc-codex-read-state');

// Map linked unread-results subagent session IDs to their parent edges.
export const demoParentEdges = new Map<string, SessionParentEdge>(
  demoReadStateTurn.agents.flatMap((agent) =>
    agent.childSessionId
      ? [[agent.childSessionId, { parent: readStateTurn.sessionId, relation: 'subagent' } as const]]
      : [],
  ),
);
demoParentEdges.set('arc-demo-sketch', { parent: 'arc-read-state', relation: 'dispatched' });
demoParentEdges.set('arc-demo-review', { parent: 'arc-demo-dispatch', relation: 'dispatched' });

export const demoReaderParents: Readonly<Record<string, string>> = { 'arc-demo-continuation': 'arc-demo-dispatch' };

// Initial demo session labels. The adapter edits a page-local copy and rebuilds session list label fields from it.
export const DEMO_LABELS: Readonly<Record<string, readonly string[]>> = {
  'arc-read-state': ['review', 'navigation'],
  'arc-codex-read-state': ['navigation'],
  'arc-cache-run': ['cost'],
  'arc-luna-read-state-tests': [],
  'arc-sol-read-state': [],
  'delegated-cost': ['cost'],
  'arc-demo-sketch': [],
  'arc-demo-dispatch': ['demo'],
  'arc-demo-review': ['review'],
  'arc-demo-continuation': ['demo'],
};

const DEMO_NAVIGATION_QUESTION: Ask = {
  kind: 'question',
  id: 'restored-tab-navigation',
  toolUseId: 'restored-tab-navigation',
  input: {},
  questions: [
    {
      id: 'navigation-case',
      question: 'Which file navigation case do you want checked next?',
      header: 'File navigation',
      options: [
        { label: 'Restored session tab', description: 'Check file navigation after reopening the session tab.' },
        { label: 'Active session tab', description: 'Check file navigation in the open session tab.' },
      ],
      multiSelect: false,
      secret: false,
    },
  ],
};

export function demoPayload(sessionId: string): Record<string, unknown> {
  const selected = DEMO_TURNS[sessionId] ? sessionId : 'arc-read-state';
  const base = readmePayload('main');
  const rows = Object.entries(DEMO_TURNS).map(([id, turns]) => {
    const item = turns[0];
    const at = item.endedAt;
    return {
      id,
      label: item.sessionTitle!,
      agent: item.agent === 'codex' ? 'Codex' : 'Claude',
      agentKey: item.agent,
      agentRun: demoParentEdges.has(id),
      at,
      relative: formatRelative(at, CAPTURE_TIME),
      when: new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CAPTURE_ZONE }),
      persisted: true,
    };
  });
  const stats = Object.fromEntries(rows.map((row) => [row.id, sessionStats(DEMO_TURNS[row.id], [])]));
  const costParts = ['arc-demo-dispatch', 'arc-demo-review'].map((id) => {
    const item = DEMO_TURNS[id][0];
    return {
      agent: item.agent,
      role: id === 'arc-demo-review' ? ('delegated' as const) : ('main' as const),
      scopeId: id,
      model: item.model,
      provider: null,
      contextWindow: item.contextWindow,
      usage: item.usage,
    };
  });
  stats['arc-demo-dispatch'] = [
    ...stats['arc-demo-dispatch'].filter((chip) => chip.metric !== 'cost'),
    ...sessionCostStats(costParts),
  ];
  const readerParentId = demoReaderParents[selected];
  const readerParent = readerParentId ? rows.find((row) => row.id === readerParentId) : undefined;
  const parent = readerParentId
    ? readerParent
      ? { id: readerParent.id, label: readerParent.label, relation: 'reader' as const }
      : undefined
    : sessionParentOf(rows, demoParentEdges, selected);
  const mainTurns = DEMO_TURNS['arc-read-state'];
  const sketch = DEMO_TURNS['arc-demo-sketch'][0];
  const mainCost = sessionCostProjection(
    [
      ...mainTurns.flatMap((item) => [
        {
          agent: item.agent,
          role: 'main' as const,
          scopeId: item.sessionId ?? undefined,
          model: item.model,
          provider: item.provider ?? null,
          contextWindow: item.contextWindow,
          usage: item.usage,
        },
        ...item.agents.flatMap((agent) =>
          agent.spend.map((part) => ({
            ...part,
            agent: item.agent,
            role: 'delegated' as const,
            scopeId: agent.id ?? undefined,
            provider: null,
            contextWindow: item.contextWindow,
            incomplete: agent.spendPartial || !agent.spendFound,
          })),
        ),
      ]),
      {
        agent: sketch.agent,
        role: 'delegated',
        scopeId: sketch.sessionId ?? undefined,
        model: sketch.model,
        provider: null,
        contextWindow: sketch.contextWindow,
        usage: sketch.usage,
      },
    ],
    false,
    { expiry: DEMO_DEFAULT_EXPIRY },
  ).stats;
  stats['arc-read-state'] = [
    ...stats['arc-read-state'].filter((chip) => chip.metric !== 'cost'),
    ...mainCost,
    ...sessionCacheExpiryStats(DEMO_DEFAULT_EXPIRY),
  ];
  stats['delegated-cost'] = [
    ...stats['delegated-cost'].filter((chip) => chip.metric !== 'cost'),
    ...sessionCostProjection(
      DEMO_TURNS['delegated-cost'].flatMap((item) => [
        {
          agent: item.agent,
          model: item.model,
          provider: item.provider ?? null,
          contextWindow: item.contextWindow,
          usage: item.usage,
          role: 'main' as const,
        },
        ...item.agents.flatMap((agent) =>
          agent.spend.map((part) => ({
            ...part,
            agent: item.agent,
            provider: part.provider ?? null,
            contextWindow: part.contextWindow ?? item.contextWindow,
            role: 'delegated' as const,
            scopeId: agent.id ?? undefined,
            incomplete: agent.spendPartial || !agent.spendFound,
          })),
        ),
      ]),
      false,
      { expiry: demoDelegatedExpiry },
    ).stats,
    ...sessionCacheExpiryStats(demoDelegatedExpiry),
  ];
  stats['arc-codex-read-state'].push(...sessionCacheExpiryStats(demoCodexExpiry));
  const statuses = new Map<string, RailStatus>([
    ['delegated-cost', 'waiting'],
    ['arc-read-state', 'subagents'],
    ['arc-sol-read-state', 'running'],
    ['arc-cache-run', 'running'],
  ]);
  const newest = new Map(rows.map((row) => [row.id, DEMO_TURNS[row.id][0].startedAt]));
  const cacheById = Object.fromEntries(
    Object.entries(DEMO_TURNS).map(([id, turns]) => [id, railCacheMarkOf({ turns, compactions: [] }, CAPTURE_TIME)]),
  );
  const runningSince = new Map([
    ['arc-cache-run', DEMO_TURNS['arc-cache-run'][0].startedAt],
    ['arc-sol-read-state', DEMO_TURNS['arc-sol-read-state'][0].startedAt],
  ]);
  const railFor = (
    archived: ReadonlySet<string>,
    pinned: ReadonlySet<string>,
    unread: ReadonlyMap<string, { count: number; atLeast: boolean }>,
    labels: Readonly<Record<string, readonly string[]>> = DEMO_LABELS,
  ) =>
    railSessions(
      rows,
      unread,
      newest,
      statuses,
      archived,
      selected,
      pinned,
      new Map(),
      stats,
      labels,
      cacheById,
      {},
      runningSince,
      CAPTURE_TIME,
      new Map([['arc-read-state', 1]]),
    );
  const rail = railFor(
    new Set(['arc-demo-dispatch']),
    new Set(['delegated-cost']),
    new Map([['arc-demo-continuation', { count: 1, atLeast: false }]]),
  );
  type RailVariant = Pick<
    RailCard,
    'agentRun' | 'agentWord' | 'nameBeforeAge' | 'nameAfterAge' | 'indicator' | 'newCount' | 'unread' | 'menuSection'
  >;
  const railVariants: Record<string, Record<string, RailVariant>> = {};
  const everyId = new Set(rows.map((row) => row.id));
  for (const membership of ['normal', 'pinned', 'archived'] as const) {
    for (const reading of ['read', 'unread'] as const) {
      const cards = railFor(
        membership === 'archived' ? everyId : new Set(),
        membership === 'pinned' ? everyId : new Set(),
        reading === 'unread' ? new Map(rows.map((row) => [row.id, { count: 1, atLeast: false }])) : new Map(),
        // Omit labels because the page appends their accessible-name clause.
        {},
      );
      railVariants[`${membership}:${reading}`] = Object.fromEntries(
        cards.map((card) => [
          card.id,
          {
            agentRun: card.agentRun,
            agentWord: card.agentWord,
            nameBeforeAge: card.nameBeforeAge,
            nameAfterAge: card.nameAfterAge,
            indicator: card.indicator,
            newCount: card.newCount,
            unread: card.unread,
            menuSection: card.menuSection,
          },
        ]),
      );
    }
  }
  const item = DEMO_TURNS[selected][0];
  const commentScene = readmePayload('comment') as { comments: TurnComment[]; usage: { composer: { draft: string } } };
  const commentCard = toCard(item, true, CAPTURE_TIME);
  const comments =
    selected === 'delegated-cost'
      ? commentScene.comments.map((comment) => ({
          ...comment,
          sessionId: selected,
          turnKey: commentCard.key,
          headline: item.sessionTitle!,
          sessionTitle: item.sessionTitle!,
          turnAt: item.startedAt,
        }))
      : [];
  const draft = selected === 'delegated-cost' ? commentScene.usage.composer.draft : '';
  const recordedModel = item.model ?? '';
  const defaults = DEMO_DEFAULTS[item.agent];
  const composer = {
    agent: item.agent,
    session: item.sessionTitle ?? '',
    draft,
    onScreen: draft,
    queued: [],
    history: [],
    running: !item.finished || selected === 'delegated-cost',
    asks: selected === 'delegated-cost' ? [DEMO_NAVIGATION_QUESTION] : [],
    comments,
    sessionId: selected,
    models: DEMO_MODELS[item.agent],
    defaults,
    commands: [],
    settings: {
      selectedModel: recordedModel,
      selectedEffort: item.effort ?? '',
      effortModel: recordedModel,
      pendingModel: null,
      pendingEffort: null,
      confirmedModel: recordedModel,
      confirmedEffort: item.effort,
    },
    askMode: item.agent === 'codex' ? 'never' : 'auto',
    effectiveMode:
      item.agent === 'codex'
        ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
        : null,
    effectivePermissionMode: item.agent === 'claude' ? 'auto' : null,
    context: { used: item.contextTokens, max: item.contextWindow ?? 200_000 },
    nextTurn: nextTurnBasisOf(item, null),
    mcpServers: [],
    live: [],
    claudeSkills: null,
  };
  return {
    ...base,
    cards: DEMO_TURNS[selected].map((item) => {
      const card = toCard(
        item,
        item === DEMO_TURNS[selected][0],
        CAPTURE_TIME,
        [],
        null,
        !item.finished,
        selected === 'arc-read-state' ? new Set(['sol-implementation']) : new Set(),
        selected === 'arc-read-state' && item === demoReadStateTurn
          ? [
              {
                sessionId: sketch.sessionId,
                name: sketch.sessionTitle!,
                costs: priceDispatchedParts([
                  {
                    agent: sketch.agent,
                    role: 'delegated',
                    scopeId: sketch.sessionId,
                    model: sketch.model,
                    provider: sketch.provider ?? null,
                    contextWindow: sketch.contextWindow,
                    usage: sketch.usage,
                    own: true,
                  },
                ]),
                short: false,
                ownSettledAt: sketch.startedAt,
              },
            ]
          : [],
        turnCacheExpiryWarning(
          item,
          selected === 'arc-read-state'
            ? DEMO_DEFAULT_EXPIRY
            : selected === 'delegated-cost'
              ? demoDelegatedExpiry
              : selected === 'arc-codex-read-state'
                ? demoCodexExpiry
                : null,
        ),
      );
      if (selected === 'arc-demo-dispatch' || (selected === 'arc-read-state' && item === demoReadStateTurn)) {
        const review = DEMO_TURNS[selected === 'arc-read-state' ? 'arc-demo-sketch' : 'arc-demo-review'][0];
        card.dispatched = [
          dispatchedAgentCard(
            review.sessionId,
            review.sessionTitle!,
            {
              models: [{ model: review.model!, usage: review.usage }],
              effort: review.effort,
              found: true,
              partial: false,
              commits: [],
              artifacts: { files: [], commits: [], complete: true, revision: review.promptId },
            },
            'done',
            review.startedAt,
            review.endedAt,
            review.toolUses,
            [],
            CAPTURE_TIME,
          ),
        ];
        card.chips.push(dispatchedChip(card.dispatched));
      }
      return {
        ...card,
        summaryHtml: renderRichMarkdown(item.summary),
        saidMessages: card.saidMessages.map((message) => ({
          ...message,
          summaryHtml: renderRichMarkdown(message.text),
        })),
        activity: card.activity.map((row) =>
          row.kind === 'message' ? { ...row, summaryHtml: renderRichMarkdown(row.text!) } : row,
        ),
      };
    }),
    sessions: rows.map((row) => ({
      ...row,
      ...(row.id === selected && parent ? { parent } : {}),
      shown: row.id === selected,
    })),
    rail,
    railVariants,
    labels: labelCounts(DEMO_LABELS),
    views: [{ id: 'review', name: 'Review', query: 'label:review', archived: false }],
    railFilters: [],
    stats,
    hidden: ['arc-demo-dispatch'],
    pinnedTop: ['delegated-cost'],
    comments,
    projectSpend: README_PROJECT_SPEND,
    showing: selected,
    timelineLayout: { cardLayout: 'two-columns', promptPosition: 'above' },
    usage: {
      composer: composerView(composer, CAPTURE_TIME),
      menus: Object.fromEntries(
        ['model', 'effort', 'askmode'].map((kind) => [kind, pickMenu(kind, composer)]).filter(([, menu]) => menu),
      ),
      launcher: sessionLauncherView(composer, [], DEMO_MODELS, DEMO_PINNED_SETUPS, DEMO_DEFAULTS),
      bar: usageBar(README_USAGE, CAPTURE_TIME),
    },
  };
}

export function readmePayload(scene: (typeof README_SCENES)[number] = 'main'): Record<string, unknown> {
  const selected =
    scene === 'next-turn'
      ? nextTurn
      : scene === 'cache-expiry' || scene === 'cost'
        ? expiryHistory[0]
        : scene === 'comment' || scene === 'comment-editor'
          ? changesTurn
          : scene === 'cache'
            ? cacheTurn
            : scene === 'review'
              ? { ...readStateTurn, agents: demoCodexReadStateTurn.agents }
              : scene === 'files'
                ? readmeFilesTurn
                : readStateTurn;
  const rows = [
    ['arc-read-state', 'Keep unread results visible', 'Codex', CAPTURE_TIME - 8 * 60_000],
    ['session-search', 'Search across sessions', 'Codex', CAPTURE_TIME - 2 * 60_000],
    ['arc-open-changes', 'Open changed files', 'Claude', CAPTURE_TIME - 5 * 60_000],
    ['archive', 'Keep the list responsive', 'Codex', CAPTURE_TIME - 47 * 60_000],
    ['delegated-cost', 'Count delegated work once', 'Claude', CAPTURE_TIME - 74 * 60_000],
    ['arc-sol-read-state', 'Preserve unread state', 'Codex', CAPTURE_TIME - 4 * 60 * 60_000],
  ]
    .map((row) =>
      scene === 'cache' && row[0] === 'session-search'
        ? ['arc-cache-run', 'Inspect low cache reuse', 'Codex', CAPTURE_TIME - 60 * 60_000]
        : row,
    )
    .map((row) =>
      scene === 'review' && row[0] === 'arc-sol-read-state' ? [row[0], row[1], row[2], CAPTURE_TIME] : row,
    )
    .map(([id, label, agent, at]) => ({
      id: String(id),
      label: String(label),
      agent: String(agent),
      at: Number(at),
      when: new Date(Number(at)).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: CAPTURE_ZONE,
      }),
      relative: formatRelative(Number(at), CAPTURE_TIME),
      persisted: true,
      agentKey: String(agent).toLowerCase(),
    }));
  const labels = {
    'arc-read-state': ['review', 'navigation'],
    'session-search': ['review'],
    'arc-open-changes': ['review'],
    archive: ['navigation'],
    'delegated-cost': ['cost'],
    'arc-sol-read-state': ['review'],
    'arc-cache-run': ['cost'],
  };
  const stats = {
    'arc-read-state': sessionStats(scene === 'review' || scene === 'files' ? [selected] : [readStateTurn], []),
    'arc-open-changes': [
      ...sessionStats(
        scene === 'cache-expiry' ? expiryHistory : scene === 'next-turn' ? [nextTurn] : [changesTurn],
        [],
      ),
      ...(scene === 'cache-expiry' ? sessionCacheExpiryStats(expiryFacts) : []),
    ],
    'arc-cache-run': sessionStats([cacheTurn], []),
  };
  const statuses = new Map<string, RailStatus>([
    ['session-search', 'running'],
    ['delegated-cost', 'waiting'],
    ...(scene === 'review'
      ? ([
          ['arc-read-state', 'subagents'],
          ['arc-sol-read-state', 'running'],
        ] as [string, RailStatus][])
      : []),
  ]);
  const unread = new Map([['archive', { count: 1, atLeast: false }]]);
  const rail = railSessions(
    rows,
    unread,
    new Map(),
    statuses,
    new Set(),
    selected.sessionId,
    new Set(['delegated-cost']),
    new Map(),
    stats,
    labels,
    {},
    {},
    new Map<string, number>([
      ['session-search', CAPTURE_TIME - 7 * 60_000],
      ...(scene === 'review' ? [['arc-sol-read-state', DEMO_TURNS['arc-sol-read-state'][0].startedAt] as const] : []),
    ]),
    CAPTURE_TIME,
    scene === 'review' ? new Map([['arc-read-state', 1]]) : new Map(),
  );
  const claudeModel = {
    value: 'opus',
    resolvedModel: selected.model ?? undefined,
    label: selected === nextTurn ? 'Fable 5.1' : 'Opus 5.5',
    description: '',
    efforts: [{ value: 'high', label: 'High', description: '' }],
  };
  const codexModel = {
    value: selected === cacheTurn ? 'openai.gpt-6-sol' : 'gpt-6-astra',
    label: selected === cacheTurn ? 'GPT-6 Sol' : 'GPT-6 Astra',
    description: '',
    efforts: [{ value: 'high', label: 'High', description: '' }],
  };
  const model = selected.agent === 'codex' ? codexModel : claudeModel;
  const card = toCard(
    selected,
    true,
    CAPTURE_TIME,
    [],
    null,
    false,
    scene === 'review' ? new Set(['sol-implementation']) : new Set(),
    [],
    turnCacheExpiryWarning(selected, scene === 'cache-expiry' || scene === 'cost' ? expiryFacts : null),
  );
  const comments: TurnComment[] =
    scene === 'comment' || scene === 'comment-editor'
      ? [
          {
            id: 'comment-open-changes',
            sessionId: selected.sessionId,
            turnKey: card.key,
            part: 'summary',
            quote: 'after restoring a session tab.',
            note: 'Please check this after reopening a session tab.',
            headline: 'Open changed files',
            sessionTitle: selected.sessionTitle ?? '',
            turnAt: selected.startedAt,
            at: CAPTURE_TIME - 60_000,
          },
        ]
      : [];
  const composer = {
    agent: selected.agent,
    session: selected.sessionTitle ?? '',
    draft:
      scene === 'comment' || scene === 'comment-editor' ? 'Please check the restored-tab case before merging.' : '',
    onScreen:
      scene === 'comment' || scene === 'comment-editor' ? 'Please check the restored-tab case before merging.' : '',
    queued: [],
    history: [],
    running: false,
    comments,
    sessionId: selected.sessionId,
    models: [model],
    commands: [],
    settings: {
      selectedModel: model.value,
      selectedEffort: 'high',
      effortModel: model.value,
      pendingModel: null,
      pendingEffort: null,
      confirmedModel: null,
      confirmedEffort: null,
    },
    askMode: selected.agent === 'codex' ? 'on-request' : 'auto',
    context: { used: selected.contextTokens, max: selected.contextWindow ?? 200_000 },
    nextTurn: nextTurnBasisOf(selected, null),
    mcpServers: [],
    live: [],
    claudeSkills: null,
  };
  return {
    type: 'render',
    cards: [
      { ...card, summaryHtml: renderRichMarkdown(selected.summary) },
      ...(scene === 'cache-expiry'
        ? expiryHistory
            .slice(1)
            .map((item) => ({ ...toCard(item, true, CAPTURE_TIME), summaryHtml: renderRichMarkdown(item.summary) }))
        : []),
    ],
    sessions: rows.map((row) => ({ ...row, shown: row.id === selected.sessionId })),
    rail,
    labels: labelCounts(labels),
    views: [{ id: 'review', name: 'Review', query: 'label:review', archived: false }],
    railFilters: [],
    stats,
    hidden: [],
    pinnedTop: ['delegated-cost'],
    comments,
    showing: selected.sessionId,
    sessionAdoptions: [],
    maxSessions: 10,
    timelineLayout: {
      cardLayout: scene === 'review' || scene === 'files' ? 'one-column' : 'two-columns',
      promptPosition: 'above',
    },
    olderHistory: null,
    diagnosis: null,
    iconFonts: [],
    projectSpend: scene === 'project-cost' ? README_PROJECT_SPEND : null,
    usage: {
      bar: scene === 'usage' || scene === 'next-turn' ? usageBar(README_USAGE, CAPTURE_TIME) : null,
      menus: Object.fromEntries(
        ['model', 'effort', 'askmode'].map((kind) => [kind, pickMenu(kind, composer)]).filter(([, menu]) => menu),
      ),
      composer: composerView(composer, CAPTURE_TIME),
      launcher: sessionLauncherView(composer, [], { claude: [claudeModel], codex: [codexModel] }),
    },
  };
}
