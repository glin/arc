// extension/src/turnfixtures.ts
//
// The turns, notes and sessions the panel's tests are written against.
//
// Test support only. Nothing the extension ships imports this, and imports.test.ts holds it
// that way: a value written here would settle how the panel behaves somewhere no test looks.
//
// A builder belongs here once a second test file needs it, or once one that is already here
// is built out of it. One that a single test file reads and nothing here needs stays in that
// file, so a fixture is read beside the tests that use it wherever it can be.
import { Compaction, ToolCounts, Turn, TurnAgent, TurnCommit, TurnLanding, TurnSkillUse } from './transcript.ts';

export function claudeCostState(modelUsage: Record<string, Record<string, number>>, startTime = 1, sessionId = 's') {
  return { type: 'cost-state', sessionId, startTime, totalDuration: 1, modelUsage };
}

export function worktreeCreationCommand(repositories: readonly string[], suffix = '/.claude/worktrees/worker'): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  return (
    "$ErrorActionPreference='Stop'\n$specs=@(" +
    repositories
      .map((repository) => '@{repository=' + quote(repository) + ";base='" + '1'.repeat(40) + "'}")
      .join(',') +
    ')\nforeach($spec in $specs) {\n$spec.worktree=$spec.repository+' +
    quote(suffix) +
    "\n$spec.branch='ship/worker'\nif((git -C $spec.repository rev-parse HEAD).Trim() -ne $spec.base) { throw 'HEAD changed' }\ngit -C $spec.repository worktree add -b $spec.branch $spec.worktree $spec.base\nif($LASTEXITCODE -ne 0){throw 'Worktree creation failed'}\n}"
  );
}
import type { ChildFileChange } from './childartifacts.ts';
import type { TurnComment } from './turncomments.ts';
import type { searchTurns } from './turnsearch.ts';
import type { LivePress } from './composerview.ts';
import { toCard, type TurnCard } from './turncard.ts';
import { ARC_IDENTITY } from './identity.ts';

export const counts = (over: Partial<ToolCounts> = {}): ToolCounts => ({
  edits: 0,
  reads: 0,
  searches: 0,
  commands: 0,
  agents: 0,
  coordination: 0,
  web: 0,
  other: 0,
  ...over,
});

export const turn = (over: Partial<Turn> = {}): Turn => ({
  agent: 'claude',
  sessionId: 'sess',
  sessionTitle: null,
  promptId: 'p',
  startedAt: new Date(2026, 7, 23, 14, 32).getTime(),
  endedAt: new Date(2026, 7, 23, 14, 44).getTime(),
  prompt: 'address the review findings',
  summary: '',
  answers: [],
  model: 'claude-opus-5',
  effort: null,
  files: [],
  agents: [],
  commits: [],
  usage: { requests: 0, input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
  contextTokens: 0,
  contextWindow: null,
  toolUses: 0,
  toolCounts: counts(),
  toolTally: {},
  laterPrompts: [],
  steps: [],
  updates: [],
  stepCount: 0,
  stepKinds: [],
  failedOrdinals: [],
  failures: [],
  skillUses: [],
  skillUseCount: 0,
  interrupted: false,
  finished: true,
  error: null,
  ...over,
});

// One finished subagent with the spend its transcript read gave.
export const subagent = (over: Partial<TurnAgent> = {}): TurnAgent => ({
  id: 'child-1',
  description: 'Parser reviewer',
  agentType: 'general-purpose',
  model: 'claude-opus-5',
  effort: null,
  spend: [],
  spendFound: true,
  spendPartial: false,
  durationMs: 1_000,
  tokens: null,
  toolUses: 1,
  status: 'completed',
  ...over,
});

export const subagentCommitTurn = (): Turn => {
  const shared: TurnCommit = {
    sha: 'abc1234',
    subject: 'Share the parser fix',
    files: 1,
    added: 4,
    removed: 1,
    at: NOW,
    place: null,
    dir: 'c:/repo',
  };
  const childOnly: TurnCommit = {
    sha: 'def5678',
    subject: 'Cover the parser fix',
    files: 1,
    added: 7,
    removed: 0,
    at: NOW + 1,
    place: null,
    dir: 'c:/repo',
  };
  const child: TurnAgent = {
    id: 'child-1',
    description: 'Parser reviewer',
    agentType: 'general-purpose',
    model: 'claude-opus-5',
    effort: null,
    spend: [],
    spendFound: true,
    spendPartial: false,
    durationMs: 1_000,
    tokens: null,
    toolUses: 1,
    status: 'completed',
    commits: [{ ...shared, sha: 'abc1234a' }, childOnly],
    artifacts: {
      files: [],
      commits: ['abc1234a', 'def5678'],
      complete: true,
      revision: 'child-1',
    },
  };
  return turn({ agents: [child], commits: [shared] });
};

// The repository the commit fixtures below stand in, and the open folder that holds it. Every
// commit a real turn records carries its repository, so a fixture that leaves it out weighs and
// groups a row no real card sends.
export const COMMIT_FOLDERS = ['c:/repo'];
const OWN_REPOSITORY = { key: 'c:/repo/.git', root: 'c:/repo', own: true };

// The heavy fixture's repository, at the depth a real checkout sits. The key rides on every
// commit row, so a short one would weigh a row lighter than a real card sends it.
const HEAVY_ROOT = 'c:/users/developer/source/repos/agent-diff-review';
const HEAVY_REPOSITORY = { key: `${HEAVY_ROOT}/.git`, root: HEAVY_ROOT, own: true };

// A turn carrying several subagents, each with enough commits and files behind it to weigh
// what one subagent row's own figures cost: the per-figure record, its paths and its shas.
// `commitsPerAgent` defaults to 13, which is what one real implementer left behind on this
// project. `subagentCount` and `filesPerAgent` are chosen to make a heavy turn, because this
// fixture exists to weigh a row rather than to describe an average one. Every sha is the full
// 40 characters git prints, which is what a row and a commits record both carry. Each subagent
// commits on a branch of its own and has a session to open, the way a real implementer does.
export const heavySubagentTurn = (subagentCount = 4, commitsPerAgent = 13, filesPerAgent = 5): Turn => {
  const agents: TurnAgent[] = [];
  for (let a = 0; a < subagentCount; a++) {
    const commits: TurnCommit[] = [];
    const commitIds: string[] = [];
    for (let c = 0; c < commitsPerAgent; c++) {
      const body = 'a1b2c3d4e5f6a7b8c9d0'.repeat(2);
      const sha = `${a.toString(16).padStart(2, '0')}${c.toString(16).padStart(2, '0')}${body}`.slice(0, 40);
      commits.push({
        sha,
        subject: `Fix the edge case subagent ${a} found while auditing the parser, part ${c}`,
        files: 1,
        added: 12,
        removed: 3,
        at: NOW + a * 10_000 + c,
        place: null,
        dir: HEAVY_ROOT,
        head: { kind: 'branch', name: `ship/audit-parser-${a}` },
        repository: HEAVY_REPOSITORY,
      });
      commitIds.push(sha);
    }
    const files: ChildFileChange[] = [];
    for (let f = 0; f < filesPerAgent; f++) {
      files.push({
        path: `extension/src/deeply/nested/module-${a}-${f}/component-implementation.ts`,
        added: 18,
        removed: 4,
        isNew: false,
      });
    }
    agents.push({
      id: `child-${a}`,
      childSessionId: `5d0c2e7a-91b4-4c3f-8e6d-0a1b2c3d4e${a.toString(16).padStart(2, '0')}`,
      description: `Audit subagent ${a} for the parser regression`,
      agentType: 'general-purpose',
      model: 'claude-opus-5',
      effort: 'high',
      spend: [
        {
          model: 'claude-opus-5',
          usage: {
            requests: 12,
            input: 40_000,
            cacheWrite1h: 0,
            cacheWrite5m: 9_000,
            cacheRead: 300_000,
            output: 8_000,
            thinking: 2_000,
          },
        },
      ],
      spendFound: true,
      spendPartial: false,
      durationMs: 240_000,
      tokens: null,
      toolUses: 71,
      status: 'completed',
      commits,
      artifacts: { files, commits: commitIds, complete: true, revision: `child-${a}` },
    });
  }
  return turn({ agents, commits: [] });
};

// The commits record's fixture matrix: one turn for each case the record draws differently.
// The subjects, the branches and the maker names are real ones where a case turns on a length.
// A repository nested inside the open folder. Its tree is inside the folder, so git gives it no
// place of its own, and only its key tells it apart from the folder's repository.
const PLANS_REPOSITORY = { key: 'c:/repo/.claude/plans/.git', root: 'c:/repo/.claude/plans', own: false };
const RECORD_AT = new Date(2026, 7, 23, 16, 0).getTime();

// A commit on main in the open folder's repository, written by the turn itself.
export const recordCommit = (
  sha: string,
  subject: string,
  minute: number,
  over: Partial<TurnCommit> = {},
): TurnCommit => ({
  sha,
  subject,
  head: { kind: 'branch', name: 'main' },
  files: 3,
  added: 24,
  removed: 6,
  at: RECORD_AT + minute * 60_000,
  place: null,
  dir: 'c:/repo',
  repository: OWN_REPOSITORY,
  ...over,
});

// A merge that moved main in the open folder's repository. `mergedBranch` is the branch the
// merge brought in, or null where nothing named one.
export const recordLanding = (
  sha: string,
  subject: string,
  minute: number,
  mergedBranch: string | null,
  over: Partial<TurnLanding> = {},
): TurnLanding => ({
  id: `merge-${sha}`,
  sha,
  subject,
  from: mergedBranch ?? sha,
  head: { kind: 'branch', name: 'main' },
  at: RECORD_AT + minute * 60_000,
  place: null,
  dir: 'c:/repo',
  repository: OWN_REPOSITORY,
  mergedBranch,
  ...over,
});

// A commit on main in the repository nested under the open folder.
const planCommit = (sha: string, subject: string, minute: number): TurnCommit =>
  recordCommit(sha, subject, minute, {
    place: null,
    dir: PLANS_REPOSITORY.root,
    repository: PLANS_REPOSITORY,
    files: 1,
    added: 12,
    removed: 2,
  });

// A subagent that made these commits. A null session is a child whose transcript the turn never
// linked, so its name has nothing to open.
export const recordMaker = (
  description: string,
  commits: TurnCommit[],
  session: string | null = `s-${commits[0]?.sha ?? 'none'}`,
): TurnAgent => ({
  id: `agent-${commits[0]?.sha ?? 'none'}`,
  ...(session ? { childSessionId: session } : {}),
  description,
  agentType: 'general-purpose',
  model: 'claude-opus-5',
  effort: 'high',
  spend: [],
  spendFound: true,
  spendPartial: false,
  durationMs: 60_000,
  tokens: null,
  toolUses: 12,
  status: 'completed',
  commits,
  artifacts: {
    files: [],
    commits: commits.map((one) => one.sha),
    complete: true,
    revision: `agent-${commits[0]?.sha ?? 'none'}`,
  },
});

export const LONGEST_COMMIT_SUBJECT =
  "test(payload): weigh a subagent row's own figures and bound a card's repeat pricing";
export const LONGEST_MAKER = 'Fold the Files rows behind a head line and prove the height guard goes red';

export type CommitRecordCase =
  | 'missing'
  | 'recordedZero'
  | 'positive'
  | 'partial'
  | 'longest'
  | 'common'
  | 'grouped'
  | 'fallback'
  | 'detached'
  | 'worktree'
  | 'makerWithoutSession'
  | 'subagentRecord'
  | 'landingOnly'
  | 'manyGroups';

export function commitRecordMatrix(): Record<CommitRecordCase, Turn> {
  const onRepairs = { head: { kind: 'branch', name: 'ship/commit-record-repairs' } } as const;
  const repair = recordCommit('184751b0', 'fix(timeline): repair four defects in the commits record', 6, {
    ...onRepairs,
    files: 9,
    added: 201,
    removed: 29,
  });
  const plan = planCommit('5e0c1d2a', 'plan(commit-record-repairs): record the repair and its follow-up work', 50);
  const repairLanding = (mergedBranch: string | null) =>
    recordLanding(
      'c36e7b5b',
      'fix(timeline): repair the landing row, the Commits heading and the maker clause',
      49,
      mergedBranch,
    );
  // The owner's turn: a topic branch that merged into main, and a commit in the nested repository.
  const owner = (mergedBranch: string | null): Turn =>
    turn({
      commits: [repair, plan],
      landings: [repairLanding(mergedBranch)],
      agents: [recordMaker('Fix the commit record rows', [repair])],
    });
  const longest = recordCommit('a3f9c21e', LONGEST_COMMIT_SUBJECT, 8, { ...onRepairs, added: 1284, removed: 1076 });
  const longestMade = recordCommit('7c41d0e2', LONGEST_COMMIT_SUBJECT, 9, { ...onRepairs, added: 96, removed: 4 });
  // The run: six topic branches that each merged into main, two of them with a second commit, and
  // one plans commit after each merge. Twenty facts in all.
  const phases = ['a', 'b', 'c', 'd', 'e', 'f'];
  const phaseCommits = (phase: string, index: number): TurnCommit[] => {
    const head = { kind: 'branch' as const, name: `ship/subagent-evidence-${phase}` };
    const name = phase.toUpperCase();
    return [
      recordCommit(`${index + 1}0e1d2c3`, `feat(subagents): build phase ${name} of the subagent evidence`, index * 20, {
        head,
      }),
      ...(index === 1 || index === 2
        ? [
            recordCommit(`${index + 1}1f2e3d4`, `fix(subagents): answer the review of phase ${name}`, index * 20 + 8, {
              head,
            }),
          ]
        : []),
    ];
  };
  const onEvidence = { head: { kind: 'branch', name: 'ship/subagent-evidence-b' } } as const;
  const childOwn = [
    recordCommit('9d7be30', 'test(card): measure the open card at the three panel widths', 4, onEvidence),
    recordCommit('b83e0d1', 'fix(rail): keep the pinned row in view when the rail narrows', 5, onEvidence),
  ];
  return {
    missing: turn(),
    recordedZero: turn({
      commits: [recordCommit('0d5b7a2', 'chore(release): retag the release', 1, { files: 0, added: 0, removed: 0 })],
    }),
    positive: turn({
      commits: [
        recordCommit('184751b0', 'fix(timeline): repair four defects in the commits record', 1, {
          added: 201,
          removed: 29,
        }),
      ],
    }),
    partial: turn({
      commits: [recordCommit('6816be3', 'feat(card): draw the added figure alone', 1, { added: 42, removed: 0 })],
    }),
    longest: turn({
      commits: [longest, longestMade, plan],
      landings: [repairLanding('ship/commit-record-repairs')],
      agents: [recordMaker(LONGEST_MAKER, [longestMade])],
    }),
    common: turn({
      agents: [
        recordMaker('Implement Phase B', [
          recordCommit('4f2a91c', 'feat(card): fold the Files, Subagents and Commits sections', 1),
        ]),
      ],
    }),
    grouped: owner('ship/commit-record-repairs'),
    fallback: owner(null),
    detached: turn({
      commits: [
        recordCommit('aa11bb2', 'fix(git): read a detached head', 1, { head: { kind: 'detached' } }),
        recordCommit('cc33dd4', 'test(git): cover the detached head', 2),
      ],
    }),
    worktree: turn({
      commits: [
        recordCommit('b83e0d1', 'fix(rail): keep the pinned row in view when the rail narrows', 1, {
          head: { kind: 'branch', name: 'fix/rail-pin' },
          place: { kind: 'worktree', dir: 'c:/repo-trees/rail-review' },
          dir: 'c:/repo-trees/rail-review',
        }),
      ],
    }),
    makerWithoutSession: turn({
      agents: [recordMaker('Read the reflog', [recordCommit('e5f6a7b', 'docs(git): name the reflog fields', 1)], null)],
    }),
    subagentRecord: turn({
      commits: [recordCommit('4f2a91c', 'feat(card): fold the Files, Subagents and Commits sections', 1)],
      agents: [recordMaker(LONGEST_MAKER, childOwn)],
    }),
    landingOnly: turn({ landings: [repairLanding(null)] }),
    manyGroups: turn({
      commits: phases.map((phase, index) =>
        planCommit(
          `${index + 1}a0b1c2d`,
          `plan(subagent-evidence): record phase ${phase.toUpperCase()}`,
          index * 20 + 15,
        ),
      ),
      landings: phases.map((phase, index) =>
        recordLanding(
          `${index + 1}c0d1e2f`,
          `Merge ship/subagent-evidence-${phase}`,
          index * 20 + 12,
          `ship/subagent-evidence-${phase}`,
        ),
      ),
      agents: phases.map((phase, index) =>
        recordMaker(`Implement Phase ${phase.toUpperCase()}`, phaseCommits(phase, index)),
      ),
    }),
  };
}

// The matrix as the host sends it, one card for each case. A browser test swaps a case's rows
// into the card it measures.
export function commitRecordCards(): Record<CommitRecordCase, TurnCard> {
  const turns = commitRecordMatrix();
  return Object.fromEntries(
    (Object.keys(turns) as CommitRecordCase[]).map((name) => [name, toCard(turns[name], false, NOW, COMMIT_FOLDERS)]),
  ) as Record<CommitRecordCase, TurnCard>;
}

export const livePress = (over: Partial<LivePress> = {}): LivePress => ({
  sessionId: 'sess',
  agent: 'claude',
  kind: 'prompt',
  text: 'Keep the live prompt visible.',
  reply: '',
  at: 2_000,
  midTurn: false,
  ran: true,
  started: true,
  failed: false,
  reason: '',
  ...over,
});

// One skill load, as a reader of either agent's records produces it. Defaults to the shape
// with the most in it, a recorded Claude load with a path, so a test names only the field it
// is about.
export const skillUse = (over: Partial<TurnSkillUse> = {}): TurnSkillUse => ({
  sourceId: 'call-skill',
  name: 'polish',
  path: 'C:/Users/dev/.claude/skills/polish/SKILL.md',
  at: new Date(2026, 7, 23, 14, 33).getTime(),
  evidence: 'recorded',
  ...over,
});

export const NOW = new Date(2026, 7, 23, 20, 0).getTime();

export const compaction = (over: Partial<Compaction> = {}): Compaction => ({
  sessionId: 'sess',
  at: new Date(2026, 7, 23, 15, 5).getTime(),
  contextBefore: 629_292,
  contextAfter: 14_172,
  droppedTokens: 615_120,
  durationMs: 147_691,
  trigger: 'manual',
  model: 'claude-opus-5',
  summary: '# What carried over',
  ...over,
});

export const MB = 1024 * 1024;

export const entry = (over: Partial<Parameters<typeof searchTurns>[0][0]> = {}) => ({
  key: 'k',
  sessionId: 's',
  sessionTitle: 'A session',
  agent: 'Claude',
  startedAt: 1000,
  prompt: '',
  summary: '',
  ...over,
});

// A note the reader left, with everything a stored one carries. The turn it hangs on is the
// one the fixture turn above uses, so a card built from that turn and a note about it line up.
export const TURN_AT = new Date(2026, 7, 23, 14, 32).getTime();

export const comment = (over: Partial<TurnComment> = {}): TurnComment => ({
  id: 'n1',
  sessionId: 'sess',
  turnKey: 'sess:' + TURN_AT,
  part: 'summary',
  quote: 'the tokenizer now walks a table',
  note: 'Measure this on the hot path first.',
  headline: 'Rewrote the tokenizer to be table driven.',
  sessionTitle: 'Fix the parser',
  turnAt: TURN_AT,
  at: TURN_AT + 60_000,
  ...over,
});

// A forward checkpoint as the progressive worker receives it. That boundary copies a
// checkpoint with structured clone, which keeps only enumerable string-keyed properties, and
// the worker entry rewraps the two buffers on arrival and restores nothing else.
export function throughStructuredClone<
  Checkpoint extends {
    lineFragment: Buffer;
    contentAnchor: { bytes: Buffer };
  },
>(checkpoint: Checkpoint): Checkpoint {
  const copy = structuredClone(checkpoint);
  copy.lineFragment = Buffer.from(copy.lineFragment);
  copy.contentAnchor.bytes = Buffer.from(copy.contentAnchor.bytes);
  return copy;
}

// A finished single-prompt sdk-cli transcript that wrote one file: an entrypoint the SDK
// file-change exception excuses, and the shape a read-only dispatch run leaves behind when
// it writes a plan or a report. `padding` pushes the transcript past a 256 KB read window,
// to exercise the whole-file scan reader alongside the tail reader.
export function sdkFileChangeTranscript(padding = 'ok'): object[] {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'text', text: 'write the plan file' }] },
    },
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '.claude/plans/plan.md' } }],
      },
    },
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: padding }] },
    },
    {
      type: 'assistant',
      timestamp: at(3),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Wrote the plan.' }],
      },
    },
  ];
}

// A finished sdk-cli transcript whose one prompt is a slash command with no origin, the shape
// `claude -p "/hello"` leaves behind: a command record, the `isMeta` record Claude Code
// expands it into, an unattended `stop_hook_summary`, and a tool call padded past a 256 KB
// read window to exercise the whole-file scan reader alongside the tail reader.
export function sdkSlashCommandTranscript(padding = 'ok'): object[] {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'sdk-cli',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<command-message>hello</command-message>\n<command-name>/hello</command-name>' },
        ],
      },
    },
    {
      type: 'user',
      timestamp: at(1),
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Say hello back' }] },
    },
    {
      type: 'assistant',
      timestamp: at(2),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo hi' } }],
      },
    },
    {
      type: 'user',
      timestamp: at(3),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: padding }] },
    },
    {
      type: 'assistant',
      timestamp: at(4),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hello!' }],
      },
    },
    { type: 'system', timestamp: at(5), subtype: 'stop_hook_summary' },
  ];
}

// A finished background-session transcript, the shape `claude --bg` leaves behind: a first
// prompt carrying `sessionKind: 'bg'` beside a human origin, Claude Code's own remote-control
// `bridge-session` record, an unattended `turn_duration`, and a changed file, padded past a
// 256 KB read window to exercise the whole-file scan reader alongside the tail reader.
export function bgSessionTranscript(padding = 'ok'): object[] {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'cli',
      origin: { kind: 'human' },
      promptSource: 'typed',
      turnOrigin: 'human',
      sessionKind: 'bg',
      message: { role: 'user', content: [{ type: 'text', text: 'fix the failing lint rule' }] },
    },
    {
      type: 'bridge-session',
      timestamp: at(1),
      sessionId: 'sess',
      bridgeSessionId: 'bridge-1',
      lastSequenceNum: 1,
      ownerAccountUuid: 'acct-1',
      ownerOrganizationUuid: 'org-1',
    },
    { type: 'system', timestamp: at(2), subtype: 'stop_hook_summary' },
    {
      type: 'assistant',
      timestamp: at(3),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'lint.config.ts' } }],
      },
    },
    {
      type: 'user',
      timestamp: at(4),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: padding }] },
    },
    { type: 'system', timestamp: at(5), subtype: 'turn_duration' },
    {
      type: 'assistant',
      timestamp: at(6),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Fixed the rule.' }],
      },
    },
  ];
}

// A finished background-session transcript with a second prompt the dispatching agent sent to
// the worker, the shape a `claude --bg` session dispatched from another agent leaves behind: a
// human-origin first prompt, a `bridge-session` record, an `automode-blocked` tool denial, and
// a follow-up carrying `entrypoint: 'sdk-cli'` and `promptSource: 'sdk'` with no origin at all.
// `padding` pushes the transcript past a 256 KB read window, to exercise the whole-file scan
// reader alongside the tail reader.
export function bgWorkerFollowUpTranscript(padding = 'ok'): object[] {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'cli',
      origin: { kind: 'human' },
      promptSource: 'typed',
      sessionKind: 'bg',
      message: { role: 'user', content: [{ type: 'text', text: 'review the saved-views prototype' }] },
    },
    {
      type: 'bridge-session',
      timestamp: at(1),
      sessionId: 'sess',
      bridgeSessionId: 'bridge-1',
      lastSequenceNum: 1,
      ownerAccountUuid: 'acct-1',
      ownerOrganizationUuid: 'org-1',
    },
    { type: 'system', timestamp: at(2), subtype: 'stop_hook_summary' },
    {
      type: 'user',
      timestamp: at(3),
      toolDenialKind: 'automode-blocked',
      message: { role: 'user', content: [] },
    },
    {
      type: 'user',
      promptId: 'p2',
      timestamp: at(4),
      entrypoint: 'sdk-cli',
      promptSource: 'sdk',
      message: { role: 'user', content: [{ type: 'text', text: 'continue the review and report back' }] },
    },
    { type: 'system', timestamp: at(5), subtype: 'turn_duration' },
    {
      type: 'assistant',
      timestamp: at(6),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'e1', name: 'Read', input: { file_path: 'saved-views.ts' } }],
      },
    },
    {
      type: 'user',
      timestamp: at(7),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: padding }] },
    },
    {
      type: 'assistant',
      timestamp: at(8),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Reviewed the prototype.' }],
      },
    },
  ];
}

// A finished background-session transcript that ends with Claude Code's own `away_summary`
// recap instead of a plain answer, the shape a session left unattended past the stop hook
// leaves behind. `padding` pushes the transcript past a 256 KB read window, to exercise the
// whole-file scan reader alongside the tail reader.
export function bgAwaySummaryTranscript(padding = 'ok'): object[] {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'cli',
      origin: { kind: 'human' },
      promptSource: 'typed',
      sessionKind: 'bg',
      message: { role: 'user', content: [{ type: 'text', text: 'review the saved-views prototype' }] },
    },
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'e1', name: 'Read', input: { file_path: 'saved-views.ts' } }],
      },
    },
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: padding }] },
    },
    {
      type: 'assistant',
      timestamp: at(3),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Reviewed the prototype.' }],
      },
    },
    {
      type: 'system',
      timestamp: at(4),
      subtype: 'away_summary',
      content: 'Goal was to review the saved-views prototype and report back. (disable recaps in /config)',
    },
  ];
}

// A finished sdk-cli transcript with two typed prompts and no human origin on either, the
// shape a resumed `claude -p --resume` review leaves behind, with a tool call padded past a
// 256 KB read window to exercise the whole-file scan reader alongside the tail reader.
export function resumedSdkTranscript(padding = 'ok'): object[] {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'text', text: 'review the diff' }] },
    },
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Looks fine.' }],
      },
    },
    {
      type: 'user',
      timestamp: at(2),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'text', text: 'now check the tests' }] },
    },
    {
      type: 'assistant',
      timestamp: at(3),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }],
      },
    },
    {
      type: 'user',
      timestamp: at(4),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: padding }] },
    },
    {
      type: 'assistant',
      timestamp: at(5),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Tests pass.' }],
      },
    },
  ];
}

// An sdk-cli transcript still inside its first turn, the shape `claude -p` leaves while it
// works: one typed prompt with `promptSource: 'sdk'` and no origin, a tool call, its result,
// and no finished turn. `entrypoint` names the entrypoint every record carries. The prompt
// carries `promptSource: 'sdk'` only under an SDK entrypoint, because that is the only place
// Claude Code writes it. `origin` puts an origin on the prompt. `padding` pushes the
// transcript past a 256 KB read window, to exercise the whole-file scan reader alongside the
// tail reader.
export function runningSdkTranscript(
  options: { padding?: string; entrypoint?: string; origin?: { kind: string } } = {},
): object[] {
  const { padding = 'ok', entrypoint = 'sdk-cli', origin } = options;
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint,
      ...(entrypoint.startsWith('sdk-') ? { promptSource: 'sdk' } : {}),
      ...(origin ? { origin } : {}),
      message: { role: 'user', content: [{ type: 'text', text: 'review the candidate commit' }] },
    },
    {
      type: 'assistant',
      timestamp: at(1),
      entrypoint,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git show HEAD' } }],
      },
    },
    {
      type: 'user',
      timestamp: at(2),
      entrypoint,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: padding }] },
    },
  ];
}

export const powershellDispatchCommand =
  "$runPath='C:/fixtures/arc/.claude/ship-logs/2026-09-30-rail-head-phase3-132913-758280594ce0090c'\n" +
  "python C:/tools/dispatch.py --runner claude --model claude-opus-5-5 --effort high --cwd 'C:/fixtures/arc/.claude/worktrees/2026-09-30-rail-head-phase3-132913-758280594ce0090c' --prompt (Join-Path $runPath 'implementation-prompt.md') --log (Join-Path $runPath 'implementation.log') --name rail-head-phase3-implement --add-dir C:/fixtures/arc --notify-thread 01a0eea1-3eec-7832-affb-83676f62b6a0 --arc-dispatch | Tee-Object -FilePath (Join-Path $runPath 'implementation-launch.txt')";

export const powershellDispatchExecution = {
  type: 'CommandExecution',
  id: 'exec-3b1ba415-d922-4de5-8953-f32c4e7d1dd3',
  command: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', powershellDispatchCommand],
  cwd: 'file:///C:/fixtures/arc',
  parsed_cmd: [{ type: 'unknown', cmd: powershellDispatchCommand }],
  source: 'unified_exec_startup',
  status: 'completed',
  stdout: `${ARC_IDENTITY.environmentPrefix}DISPATCH_SESSION={"agent":"claude","session_id":"3f99580e","name":"rail-head-phase3-implement"}\r\n`,
  stderr: '',
  exit_code: 0,
};

export function claudeDispatchTranscript(command: string, output: string, toolUseId = 'dispatch-1'): object[] {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      type: 'user',
      promptId: 'dispatch-prompt',
      timestamp: at(0),
      message: { role: 'user', content: [{ type: 'text', text: 'start another session' }] },
    },
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }],
      },
    },
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output }] },
      toolUseResult: { stdout: output, stderr: '' },
    },
  ];
}

// Claude compaction requests with a measured cost, each beside the last main request before it.
// That request sent 2 uncached tokens, read `previousRead` from the cache, wrote `previousWrite`
// to it at the `lifetime` it bought, and ran `idleMinutes` before the compaction. `firstRead` is
// the cache read of the transcript's first request, where the row is cold. `summaryChars` is the
// length of the stored summary text, and `postTokens` the summary size its boundary recorded
// where one was matched. `realCost` prices the measured request at the published rates.
export interface CompactionCalibrationRow {
  name: string;
  model: string;
  trigger: 'auto' | 'manual';
  previousRead: number;
  previousWrite: number;
  firstRead: number | null;
  idleMinutes: number;
  lifetime: '5m' | '1h';
  summaryChars: number;
  postTokens: number | null;
  realCost: number;
}

// The input side of the request before a row's compaction.
export function previousContextOf(row: CompactionCalibrationRow): number {
  return 2 + row.previousRead + row.previousWrite;
}

export const COMPACTION_SAMPLES: readonly CompactionCalibrationRow[] = [
  {
    name: 'C3',
    model: 'claude-opus-5',
    trigger: 'auto',
    previousRead: 166_768,
    previousWrite: 113,
    firstRead: null,
    idleMinutes: 1 / 3,
    lifetime: '5m',
    summaryChars: 6_266,
    postTokens: 3_047,
    realCost: 0.1815,
  },
  {
    name: 'C10 a',
    model: 'claude-sonnet-5',
    trigger: 'auto',
    previousRead: 156_913,
    previousWrite: 21_907,
    firstRead: null,
    idleMinutes: 1 / 3,
    lifetime: '5m',
    summaryChars: 6_034,
    postTokens: 3_090,
    realCost: 0.1022,
  },
  {
    name: 'C10o a',
    model: 'claude-sonnet-5',
    trigger: 'auto',
    previousRead: 156_913,
    previousWrite: 21_702,
    firstRead: null,
    idleMinutes: 1 / 3,
    lifetime: '5m',
    summaryChars: 4_566,
    postTokens: 2_678,
    realCost: 0.0926,
  },
  {
    name: '630c5f4e cold on claude-opus-5',
    model: 'claude-opus-5',
    trigger: 'manual',
    previousRead: 259_151,
    previousWrite: 601,
    firstRead: 12_582,
    idleMinutes: 72,
    lifetime: '1h',
    summaryChars: 17_192,
    postTokens: null,
    realCost: 1.5671,
  },
  {
    name: '630c5f4e warm',
    model: 'claude-opus-5-5',
    trigger: 'manual',
    previousRead: 213_428,
    previousWrite: 1_072,
    firstRead: null,
    idleMinutes: 29,
    lifetime: '1h',
    summaryChars: 19_326,
    postTokens: null,
    realCost: 0.2078,
  },
  {
    name: '386c0253 cold',
    model: 'claude-opus-5-5',
    trigger: 'manual',
    previousRead: 228_615,
    previousWrite: 1_473,
    firstRead: 10_086,
    idleMinutes: 818,
    lifetime: '1h',
    summaryChars: 18_532,
    postTokens: null,
    realCost: 1.0501,
  },
  {
    name: '630c5f4e cold on claude-opus-5-5',
    model: 'claude-opus-5-5',
    trigger: 'manual',
    previousRead: 152_863,
    previousWrite: 898,
    firstRead: 12_582,
    idleMinutes: 996,
    lifetime: '1h',
    summaryChars: 18_003,
    postTokens: null,
    realCost: 0.737,
  },
  {
    name: '0d62124b warm',
    model: 'claude-opus-5-5',
    trigger: 'manual',
    previousRead: 84_939,
    previousWrite: 2_877,
    firstRead: null,
    idleMinutes: 2,
    lifetime: '5m',
    summaryChars: 6_380,
    postTokens: null,
    realCost: 0.0868,
  },
  {
    name: 'b8bab4d2 cold',
    model: 'claude-opus-5-5',
    trigger: 'manual',
    previousRead: 102_348,
    previousWrite: 419,
    firstRead: 10_086,
    idleMinutes: 1_309,
    lifetime: '1h',
    summaryChars: 5_177,
    postTokens: null,
    realCost: 0.413,
  },
  {
    name: 'fb1756cf warm after a cache miss',
    model: 'claude-opus-5-5',
    trigger: 'manual',
    previousRead: 10_086,
    previousWrite: 126_961,
    firstRead: null,
    idleMinutes: 1.5,
    lifetime: '5m',
    summaryChars: 10_634,
    postTokens: null,
    realCost: 0.714,
  },
];

export interface ClaudeCompactionTranscriptOptions {
  // How long after each answer its compaction record is written.
  gapMs?: number;
  answerOutput?: number;
  // How long the compaction request ran, as its boundary records it.
  durationMs?: number;
  // Write each summary before its boundary. Claude Code writes them in either order.
  summaryFirst?: boolean;
  // Leave every answer without a clock.
  untimedAnswers?: boolean;
  // How many prompt, answer and compaction rounds the session runs, each a minute after the last.
  rounds?: number;
  // Mark every line as a child agent's, as a child transcript records it.
  sidechain?: boolean;
}

// One Claude session that answers a prompt, compacts `gapMs` after that answer, and repeats that
// for each round. Each answer reads and writes what the row's previous request did. A row with a
// first read opens the session with a request that reads that prefix back.
export function claudeCompactionTranscript(
  row: CompactionCalibrationRow,
  {
    gapMs = row.idleMinutes * 60_000,
    answerOutput = 500,
    durationMs,
    summaryFirst = false,
    untimedAnswers = false,
    rounds = 1,
    sidechain = false,
  }: ClaudeCompactionTranscriptOptions = {},
): object[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  const side = sidechain ? { isSidechain: true } : {};
  const base = Date.UTC(2026, 8, 20, 10, 0, 0);
  const summaryText = 'This session is being continued from a previous conversation.'.padEnd(row.summaryChars, '.');
  const answer = (id: string, at: number, usage: object) => ({
    type: 'assistant',
    uuid: id,
    ...(untimedAnswers ? {} : { timestamp: iso(at) }),
    ...side,
    message: { id, model: row.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage },
  });
  const opening =
    row.firstRead === null
      ? []
      : [
          {
            type: 'user',
            uuid: 'prompt-0',
            timestamp: iso(base - 120_000),
            ...side,
            message: { role: 'user', content: 'start' },
          },
          answer('answer-0', base - 119_000, {
            input_tokens: 2,
            cache_read_input_tokens: row.firstRead,
            output_tokens: 100,
          }),
        ];
  const compacted = Array.from({ length: rounds }, (_, index) => {
    const n = index + 1;
    const start = base + index * (gapMs + 60_000);
    const answerAt = start + 1_000;
    const compactedAt = answerAt + gapMs;
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: `boundary-${n}`,
      timestamp: iso(compactedAt),
      ...side,
      compactMetadata: {
        trigger: row.trigger,
        preTokens: previousContextOf(row),
        // A row with no matched size records one unlike the summary text's estimate, so a test can
        // tell which of the two priced the output.
        postTokens: row.postTokens ?? Math.round(row.summaryChars / 4),
        ...(durationMs === undefined ? {} : { durationMs }),
      },
    };
    const summary = {
      type: 'user',
      uuid: `summary-${n}`,
      timestamp: iso(compactedAt + 1),
      isCompactSummary: true,
      ...side,
      message: { role: 'user', content: summaryText },
    };
    return [
      {
        type: 'user',
        uuid: `prompt-${n}`,
        timestamp: iso(start),
        ...side,
        message: { role: 'user', content: 'keep going' },
      },
      answer(`answer-${n}`, answerAt, {
        input_tokens: 2,
        cache_read_input_tokens: row.previousRead,
        cache_creation_input_tokens: row.previousWrite,
        cache_creation:
          row.lifetime === '1h'
            ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: row.previousWrite }
            : { ephemeral_5m_input_tokens: row.previousWrite, ephemeral_1h_input_tokens: 0 },
        output_tokens: answerOutput,
      }),
      ...(summaryFirst ? [summary, boundary] : [boundary, summary]),
    ];
  }).flat();
  return [...opening, ...compacted];
}
export function codexContextRecords(session = 's1', compacted = false): Array<Record<string, any>> {
  const message = (role: string, text: string) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
  const history = [
    message('developer', 'Use the project instructions. '.repeat(40)),
    message('user', 'Explain the parser. '.repeat(200)),
    { type: 'function_call', call_id: 'read', name: 'exec_command', arguments: '{"cmd":"rg parser"}' },
    { type: 'function_call_output', call_id: 'read', output: 'Untruncated original output. '.repeat(400) },
    message('assistant', 'The parser reads the latest session. '.repeat(50)),
  ];
  const records = [
    {
      type: 'session_meta',
      payload: { id: session, cli_version: '0.160.0', base_instructions: { text: 'You are a coding assistant.' } },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'context-turn', model_context_window: 20_000 } },
    { type: 'turn_context', payload: { turn_id: 'context-turn', model: 'gpt-6.1-sol' } },
    ...(compacted
      ? [
          { type: 'response_item', payload: message('user', 'Discarded input. '.repeat(10_000)) },
          {
            type: 'compacted',
            payload: {
              window_number: 2,
              replacement_history: [...history, { type: 'compaction', encrypted_content: 'opaque' }],
            },
          },
        ]
      : history.map((payload) => ({ type: 'response_item', payload }))),
    { type: 'turn_context', payload: { turn_id: 'context-turn', model: 'gpt-6.1-sol' } },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 20_000,
          last_token_usage: { input_tokens: 10_000, cached_input_tokens: 9_000, output_tokens: 100 },
          total_token_usage: { input_tokens: 9_000_000 },
        },
      },
    },
  ];
  return records.map((record, index) => ({
    ...record,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
}
