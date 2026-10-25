// extension/src/gitcommits.test.ts
//
// Parser fixtures cover Git log, repository identity, and HEAD reflog output.

import { test, vi } from 'vitest';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, renameSync, rmdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CommitIntent,
  LandingIntent,
  Turn,
  TurnCommit,
  TurnLanding,
  normalizeFsPath,
  recordCommits,
  inspectCommitCommand,
  commitSourceStamp,
} from './transcript.ts';
import {
  GitRunner,
  IDENTITY_ARGS,
  RepositoryCommits,
  chooseCommits,
  chooseLandings,
  exactCommitArgs,
  intentKey,
  landingKey,
  landingReflogArgs,
  landingsInHeadLog,
  logArgs,
  commitsInHeadLog,
  nodeGitRunner,
  parseBranch,
  parseCommitLog,
  parseIdentity,
  placeOf,
  reflogArgs,
  subjectArgs,
  mergedBranchOf,
  pointsAtArgs,
  sameRepositoryRoot,
} from './gitcommits.ts';
import { candidateGitRunner as candidateRunner, turn } from './turnfixtures.ts';
import { commitCard, commitRowsOf, landingCard } from './turncard.ts';
import { groupCommitRows } from './view/card-presentation.ts';
import {
  COMMIT_REPOSITORY_CHECK_MS,
  MAX_COMMIT_REPOSITORIES,
  MAX_SOURCE_COMMIT_REPOSITORIES,
  MAX_COMMIT_REPOSITORY_BYTES,
  CommitRepositories,
} from './commitrepositories.ts';
import { loadDerivedCache, saveDerivedCache } from './derivedcache.ts';
import { tempDir } from './temproot.ts';
import { readCodexAgentSpend, refreshCodexStructuralAgents } from './codex.ts';

const REPO = 'C:/Users/dev/Projects/work/arc';
const TREE = 'C:/Users/dev/arc-worktrees/usage-model-bucket';
const NOTES = 'C:/Users/dev/Projects/side-repo';
const COMMON = `${REPO}/.git`;
const COMMON_WINDOWS = `${REPO.replace(/\//g, '\\')}\\.git`;
const OTHER_COMMON = `${NOTES}/.git`;

const RECORD = '\x1e';
const FIELD = '\x00';

// One `git log --format=... --shortstat` record, spelled the way git spells it: the fields on
// the first line with the subject last, a blank line, then the stat block. Git prints a commit
// time to the second, which is the fact the window rules are built on.
function record(
  sha: string,
  subject: string,
  when: string,
  stat = ' 1 file changed, 1 insertion(+), 1 deletion(-)',
): string {
  return `${RECORD}${sha}${FIELD}${when}${FIELD}${subject}\n${stat ? `\n${stat}\n` : '\n'}`;
}

const AT = (when: string): number => Date.parse(when);

// Every commit in the fixture, as a head log that recorded each of them. A test about the head
// log itself passes its own set.
const allOf = (...found: { sha: string }[]): Set<string> => new Set(found.map((c) => c.sha));

test('a recorded git log reads back as commits, oldest first', () => {
  const stdout =
    record(
      '98394c09040ae303d564a7619ced107cd4d6621f',
      'Make the Codex skill link relative',
      '2026-09-01T20:52:45-05:00',
    ) +
    record(
      'cacbfb309aaadb0c677b25716c016e084b9b56c3',
      'Link the Codex skill directory to the skill',
      '2026-09-01T20:52:19-05:00',
      ' 4 files changed, 12 insertions(+), 19 deletions(-)',
    );

  const found = parseCommitLog(stdout);
  // git writes the newest first and a turn made them in the other order.
  assert.deepEqual(
    found.map((c) => c.subject),
    ['Link the Codex skill directory to the skill', 'Make the Codex skill link relative'],
  );
  assert.deepEqual(found[0], {
    sha: 'cacbfb309aaadb0c677b25716c016e084b9b56c3',
    subject: 'Link the Codex skill directory to the skill',
    at: AT('2026-09-01T20:52:19-05:00'),
    files: 4,
    added: 12,
    removed: 19,
  });
});

test('a commit that changed nothing keeps its identity and reports no figures', () => {
  const [only] = parseCommitLog(
    record('04d3fed1111111111111111111111111111111ab', 'loud one', '2026-09-01T16:20:46-05:00', ''),
  );
  assert.equal(only.sha, '04d3fed1111111111111111111111111111111ab');
  assert.deepEqual([only.files, only.added, only.removed], [null, null, null]);
});

test('a subject holding the words of a stat line is still the subject', () => {
  // The stat search runs over the record's later lines only, so a subject cannot be read as
  // its own figures.
  const [only] = parseCommitLog(
    record(
      'abc1234abc1234abc1234abc1234abc1234abc12',
      '3 files changed, 1 insertion(+)',
      '2026-09-01T16:20:46-05:00',
      ' 2 files changed, 7 insertions(+)',
    ),
  );
  assert.equal(only.subject, '3 files changed, 1 insertion(+)');
  assert.deepEqual([only.files, only.added, only.removed], [2, 7, 0]);
});

test('output that is not a git log yields no commits', () => {
  assert.deepEqual(parseCommitLog(''), []);
  assert.deepEqual(parseCommitLog('fatal: not a git repository'), []);
  assert.deepEqual(parseCommitLog(record('nothex', 'x', '2026-09-01T16:20:46-05:00')), []);
  assert.deepEqual(parseCommitLog(record('abc1234abc1234abc1234abc1234abc1234abc12', 'x', 'not a date')), []);
});

test('a subject cannot break the record that carries it', () => {
  // A commit message holds any byte except NUL, so the fields are separated by one and the
  // subject is written last. A subject holding the record separator cuts its own record short
  // rather than taking the next commit's fields with it.
  const [only] = parseCommitLog(
    record('abc1234abc1234abc1234abc1234abc1234abc12', 'a subject with a control byte', '2026-09-01T16:20:46-05:00'),
  );
  assert.equal(only.subject, 'a subject with a control byte');

  const split = parseCommitLog(
    record('abc1234abc1234abc1234abc1234abc1234abc12', `cut${RECORD}here`, '2026-09-01T16:20:46-05:00') +
      record('def5678def5678def5678def5678def5678def56', 'the next one', '2026-09-01T16:20:47-05:00'),
  );
  // Both commits survive, and neither takes the other's identity.
  assert.deepEqual(
    split.map((c) => c.sha.slice(0, 6)),
    ['def567', 'abc123'],
  );
  assert.equal(split[1].subject, 'cut');
});

test('one read says which repository a directory belongs to and which tree it is', () => {
  // The identity fixture supplies the absolute common directory, Git directory, and root for a linked worktree and its main checkout.

  assert.deepEqual(parseIdentity(`${COMMON}\n${COMMON}/worktrees/usage-model-bucket\n${TREE}\n`), {
    commonDir: normalizeFsPath(COMMON),
    linked: true,
    root: TREE,
  });
  assert.deepEqual(parseIdentity(`${COMMON}\n${COMMON}\n${REPO}\n`), {
    commonDir: normalizeFsPath(COMMON),
    linked: false,
    root: REPO,
  });
  assert.equal(
    parseIdentity(`${COMMON_WINDOWS}\n${COMMON_WINDOWS}\n${REPO}\n`).commonDir,
    parseIdentity(`${COMMON}\n${COMMON}\n${REPO}\n`).commonDir,
  );
  // A directory that is gone, or that is no repository, answers nothing at all.
  assert.deepEqual(parseIdentity(null), { commonDir: null, linked: false, root: null });
  assert.deepEqual(parseIdentity(''), { commonDir: null, linked: false, root: null });
});

test('a detached head names no branch rather than naming a detached commit', () => {
  assert.deepEqual(parseBranch('feat/commits-from-the-repository\n'), {
    kind: 'branch',
    name: 'feat/commits-from-the-repository',
  });
  // HEAD denotes a detached checkout and supplies no branch name.

  assert.equal(parseBranch('HEAD\n'), null);
  assert.equal(parseBranch(null), null);
});

test('a window names its commits only when it holds as many as the command asked for', () => {
  const from = AT('2026-09-02T04:08:18.531Z');
  const to = AT('2026-09-02T04:08:20.139Z');
  const mine = parseCommitLog(
    record('f245c68f245c68f245c68f245c68f245c68f2456', 'Read commits from the repository', '2026-09-02T04:08:19Z'),
  );

  assert.deepEqual(
    chooseCommits(mine, from, to, 1, allOf(...mine)).map((c) => c.subject),
    ['Read commits from the repository'],
  );

  // Two commits within a one-commit window are ambiguous, so neither is attributed to the call.

  const theirs = parseCommitLog(
    record('5c8e9415c8e9415c8e9415c8e9415c8e9415c8e9', 'Send item four', '2026-09-02T04:08:19Z') +
      record('f245c68f245c68f245c68f245c68f245c68f2456', 'Read commits from the repository', '2026-09-02T04:08:19Z'),
  );
  assert.deepEqual(chooseCommits(theirs, from, to, 1, allOf(...theirs)), []);

  // A matching expected count admits both candidates within the window.
  assert.equal(chooseCommits(theirs, from, to, 2, allOf(...theirs)).length, 2);

  // The commit failed, so the window holds none and the row stays as it was.
  assert.deepEqual(chooseCommits([], from, to, 1, new Set()), []);
  assert.deepEqual(chooseCommits(mine, from, to, 0, allOf(...mine)), []);
});

test('a commit the call made survives git rounding its time down to the second', () => {
  // Git commit timestamps use whole seconds. A 19.000 timestamp must remain eligible for a call starting at 19.400.

  const from = AT('2026-09-02T04:08:19.400Z');
  const to = AT('2026-09-02T04:08:20.139Z');
  const mine = parseCommitLog(
    record('f245c68f245c68f245c68f245c68f245c68f2456', 'Read commits', '2026-09-02T04:08:19Z'),
  );
  assert.deepEqual(
    chooseCommits(mine, from, to, 1, allOf(...mine)).map((c) => c.sha),
    ['f245c68f245c68f245c68f245c68f245c68f2456'],
  );

  // Widening to the second lets in a commit another session made just after the call ended,
  // in the same second the call ended in. The count is what refuses it: the call's own commit
  // is in the window too, so the window holds two where one was asked for.
  const both = parseCommitLog(
    record('5c8e9415c8e9415c8e9415c8e9415c8e9415c8e9', 'Send item four', '2026-09-02T04:08:20Z') +
      record('f245c68f245c68f245c68f245c68f245c68f2456', 'Read commits', '2026-09-02T04:08:19Z'),
  );
  assert.deepEqual(chooseCommits(both, from, to, 1, allOf(...both)), []);
});

test('a commit outside the window is not the call that ran inside it', () => {
  // A commit inside the turn but outside the call window must not be attributed to that call.

  const from = AT('2026-09-02T04:08:18.531Z');
  const to = AT('2026-09-02T04:08:20.139Z');
  const earlier = parseCommitLog(
    record('5c8e9415c8e9415c8e9415c8e9415c8e9415c8e9', 'Send item four', '2026-09-02T04:08:14Z'),
  );
  assert.deepEqual(chooseCommits(earlier, from, to, 1, allOf(...earlier)), []);
  const later = parseCommitLog(
    record('5c8e9415c8e9415c8e9415c8e9415c8e9415c8e9', 'Send item four', '2026-09-02T04:08:22Z'),
  );
  assert.deepEqual(chooseCommits(later, from, to, 1, allOf(...later)), []);
});

test('the log read is bounded by the window and by a count', () => {
  const args = logArgs(AT('2026-09-02T04:08:18.531Z'), AT('2026-09-02T04:08:20.139Z'));
  assert.ok(args.includes('-n'), 'the read must be capped');
  // Two seconds of slack either way, because git compares the date against whole seconds.
  assert.ok(args.includes('--since=2026-09-02T04:08:16.531Z'), args.join(' '));
  assert.ok(args.includes('--until=2026-09-02T04:08:22.139Z'), args.join(' '));
});

test('a linked worktree is this repository and another repository is not', () => {
  const here = normalizeFsPath(COMMON);
  const there = normalizeFsPath(OTHER_COMMON);
  const linked = { commonDir: here, linked: true, root: TREE };
  const main = { commonDir: here, linked: false, root: REPO };
  const foreign = { commonDir: there, linked: false, root: NOTES };

  // Inside the open folder the card already says where it is.
  assert.equal(placeOf(`${REPO}/extension`, main, [here], [REPO]), null);
  // Outside it, and the same object store: this project's own work in another tree.
  assert.deepEqual(placeOf(TREE, linked, [here], [REPO]), { kind: 'worktree', dir: TREE });
  // A commit made in a subdirectory is drawn against the tree that holds it, so the row never
  // reads a subdirectory's name as a worktree's.
  assert.deepEqual(placeOf(`${TREE}/extension`, linked, [here], [REPO]), { kind: 'worktree', dir: TREE });
  // The same relation from the other side. The panel is open on a worktree and the commit was
  // made in the tree the worktrees came from, which is not a worktree of anything.
  assert.deepEqual(placeOf(REPO, main, [here], [TREE]), { kind: 'maintree', dir: REPO });
  assert.deepEqual(placeOf(`${REPO}/extension`, main, [here], [TREE]), { kind: 'maintree', dir: REPO });
  // Outside it, and a different object store: somebody else's.
  assert.deepEqual(placeOf(NOTES, foreign, [here], [REPO]), { kind: 'named', dir: NOTES });
  // A directory that answered nothing cannot be claimed, so it keeps the safe wording.
  assert.deepEqual(placeOf(TREE, { commonDir: null, linked: false, root: null }, [here], [REPO]), {
    kind: 'named',
    dir: TREE,
  });
});

// Records each request and returns its table entry. With hold enabled, answers remain pending until release() runs.

function fakeRunner(
  answers: Record<string, string | null>,
  hold = false,
): GitRunner & { asked: string[]; release: () => void } {
  const asked: string[] = [];
  const waiting: (() => void)[] = [];
  return {
    asked,
    release(): void {
      for (const go of waiting.splice(0)) {
        go();
      }
    },
    run(dir: string, args: string[]): Promise<string | null> {
      const key = `${dir} ${args.join(' ')}`;
      asked.push(key);
      // Unless supplied explicitly, the fake HEAD reflog includes every commit from the directory's log answer.

      const answer = key in answers ? answers[key] : args[1] === '-g' ? headLogFor(dir, answers) : null;
      if (!hold) {
        return Promise.resolve(answer);
      }
      return new Promise((resolve) => waiting.push(() => resolve(answer)));
    },
  };
}

// The head log a directory would write for the commits its own log answer holds.
function headLogFor(dir: string, answers: Record<string, string | null>): string {
  const log = Object.entries(answers).find(([k]) => k.startsWith(`${dir} log `) && !k.startsWith(`${dir} log -g `));
  const shas = (log?.[1] ?? '')
    .split(RECORD)
    .map((chunk) => chunk.split(FIELD)[0]?.trim())
    .filter(Boolean);
  return shas.map((sha) => `commit: made it${FIELD}${sha}`).join('\n');
}

const IDENTITY = 'rev-parse --path-format=absolute --git-common-dir --git-dir --show-toplevel';
const reflogs = (runner: { asked: string[] }, dir: string): number =>
  runner.asked.filter((k) => k.startsWith(`${dir} log -g `)).length;
const BRANCH = 'rev-parse --abbrev-ref HEAD';
const asks = (runner: { asked: string[] }, dir: string, args: string): number =>
  runner.asked.filter((k) => k === `${dir} ${args}`).length;
const logs = (runner: { asked: string[] }, dir: string): number =>
  runner.asked.filter((k) => k.startsWith(`${dir} log `) && !k.startsWith(`${dir} log -g `)).length;

const intent = (over: Partial<CommitIntent> = {}): CommitIntent => ({
  dir: TREE,
  from: AT('2026-09-02T04:08:18.531Z'),
  to: AT('2026-09-02T04:08:20.139Z'),
  expected: 1,
  ...over,
});

const reader = (runner: GitRunner, onFilled: () => void): RepositoryCommits => new RepositoryCommits(runner, onFilled);

// `apply` starts its reads and returns. Nothing waits for them, so a test has to let the
// queued promises run before it reads the answer.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

const treeAnswers = (): Record<string, string | null> => ({
  [`${TREE} ${IDENTITY}`]: `${COMMON}\n${COMMON}/worktrees/usage-model-bucket\n${TREE}\n`,
  [`${TREE} ${BRANCH}`]: 'feat/usage-model-bucket\n',
  [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
});

test('a quiet commit made in a worktree reaches the card as this project own work', async () => {
  const one = turn({ commits: [], commitIntents: [intent()] });
  const runner = fakeRunner({
    ...treeAnswers(),
    [`${TREE} ${logArgs(intent().from, intent().to).join(' ')}`]: record(
      '302bd76302bd76302bd76302bd76302bd76302bd',
      'Bucket usage by model',
      '2026-09-02T04:08:19Z',
      ' 3 files changed, 40 insertions(+), 2 deletions(-)',
    ),
  });
  let filled = 0;
  const commits = reader(runner, () => {
    filled++;
  });

  // The first apply starts reads without adding commits.
  commits.apply([one], [REPO]);
  assert.deepEqual(one.commits, []);
  await settle();
  assert.equal(filled, 1, 'a filled turn has to say that a later render has more to draw');

  // The next render draws it.
  commits.apply([one], [REPO]);
  assert.deepEqual(one.commits, [
    {
      sha: '302bd763',
      subject: 'Bucket usage by model',
      head: { kind: 'branch', name: 'feat/usage-model-bucket' },
      files: 3,
      added: 40,
      removed: 2,
      at: AT('2026-09-02T04:08:19Z'),
      place: { kind: 'worktree', dir: TREE },
      dir: TREE,
      // The worktree shares the repository of the tree it came from, so it files under that key.
      repository: { key: normalizeFsPath(COMMON), root: TREE, own: true },
    },
  ] as TurnCommit[]);
});

test('a witnessed quiet commit adopts only the repository candidate whose sha it printed', async () => {
  const sha = '302bd76302bd76302bd76302bd76302bd76302bd';
  const matching = intent({ witnessedSha: '302bd763' });
  const different = intent({ witnessedSha: '5c8e9415' });
  const runner = fakeRunner({
    ...treeAnswers(),
    [`${TREE} ${logArgs(matching.from, matching.to).join(' ')}`]: record(
      sha,
      'Bucket usage by model',
      '2026-09-02T04:08:19Z',
    ),
  });
  const accepted = turn({ commits: [], commitIntents: [matching] });
  const refused = turn({ commits: [], commitIntents: [different] });
  const commits = new RepositoryCommits(runner, () => {});

  commits.apply([accepted, refused], [REPO]);
  await settle();
  commits.apply([accepted, refused], [REPO]);
  assert.deepEqual(
    accepted.commits.map((commit) => commit.sha),
    ['302bd763'],
  );
  assert.deepEqual(refused.commits, []);
});

test('a witnessed commit keeps its identity after its worktree stops answering', async () => {
  const sha = '302bd76302bd76302bd76302bd76302bd76302bd';
  const quiet = intent({ witnessedSha: '302bd763' });
  const unknown = intent({ from: quiet.from + 10, to: quiet.to + 10 });
  const exact = ['log', '--no-walk', '--format=%x1e%H%x00%cI%x00%s', '--shortstat', '302bd763', '--'];
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${exact.join(' ')}`]: record(sha, 'Bucket usage by model', '2026-09-02T04:08:19Z'),
  });
  const knownTurn = turn({ commits: [], commitIntents: [quiet] });
  const unknownTurn = turn({ commits: [], commitIntents: [unknown] });
  const commits = new RepositoryCommits(runner, () => {});

  for (let i = 0; i < 6; i++) {
    commits.apply([knownTurn, unknownTurn], [REPO]);
    await settle();
  }

  assert.deepEqual(knownTurn.commits, [
    {
      sha: '302bd763',
      subject: 'Bucket usage by model',
      head: null,
      files: 1,
      added: 1,
      removed: 1,
      at: AT('2026-09-02T04:08:19Z'),
      place: null,
      dir: REPO,
      repository: { key: normalizeFsPath(COMMON), root: REPO, own: true },
    },
  ] as TurnCommit[]);
  assert.deepEqual(unknownTurn.commits, []);
  assert.equal(asks(runner, REPO, exact.join(' ')), 1);
  assert.equal(asks(runner, REPO, logArgs(quiet.from, quiet.to).join(' ')), 0);
  assert.equal(asks(runner, REPO, logArgs(unknown.from, unknown.to).join(' ')), 0);
});

test('the central quiet-commit reader adopts a child commit onto its launch row', async () => {
  const quiet = intent({ witnessedSha: '302bd763' });
  const one = turn({
    agents: [
      {
        id: 'child',
        description: 'Review child',
        agentType: 'general-purpose',
        model: null,
        effort: null,
        spend: [],
        spendFound: true,
        spendPartial: false,
        durationMs: 1,
        tokens: null,
        toolUses: 1,
        status: 'completed',
        commits: [],
        commitIntents: [quiet],
      },
    ],
  });
  const runner = fakeRunner({
    ...treeAnswers(),
    [`${TREE} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(
      '302bd76302bd76302bd76302bd76302bd76302bd',
      'Child fix',
      '2026-09-02T04:08:19Z',
    ),
  });
  const commits = new RepositoryCommits(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(one.commits, []);
  assert.deepEqual(
    one.agents[0].commits?.map((commit) => [commit.sha, commit.subject]),
    [['302bd763', 'Child fix']],
  );
});

test('a printed commit keeps its subject and opens from the parent checkout after its worktree stops answering', async () => {
  const sha = '7574445a7574445a7574445a7574445a7574445a';
  const exact = ['log', '--no-walk', '--format=%x1e%H%x00%cI%x00%s', '--shortstat', '7574445a', '--'];
  const printed: TurnCommit = {
    sha: '7574445a',
    subject: 'Subject recorded by the transcript',
    head: null,
    files: 3,
    added: 40,
    removed: 2,
    at: 1,
    place: { kind: 'named', dir: TREE },
    dir: TREE,
  };
  const one = turn({ commits: [printed] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${exact.join(' ')}`]: record(sha, 'Subject read from Git', '2026-09-02T04:08:19Z'),
  });
  const commits = new RepositoryCommits(runner, () => {});

  for (let i = 0; i < 5; i++) {
    commits.apply([one], [REPO]);
    await settle();
  }

  assert.equal(one.commits[0].subject, 'Subject recorded by the transcript');
  assert.equal(one.commits[0].dir, REPO);
  assert.equal(one.commits[0].place, null);
  assert.equal(asks(runner, REPO, exact.join(' ')), 1);
});

test('a printed commit inside an open folder survives its nested worktree disappearing', async () => {
  const nested = `${REPO}/.claude/worktrees/finished`;
  const sha = '7574445a7574445a7574445a7574445a7574445a';
  const exact = ['log', '--no-walk', '--format=%x1e%H%x00%cI%x00%s', '--shortstat', '7574445a', '--'];
  const printed: TurnCommit = {
    sha: '7574445a',
    subject: 'Subject recorded by the transcript',
    head: null,
    files: 3,
    added: 40,
    removed: 2,
    at: 1,
    place: null,
    dir: nested,
  };
  const one = turn({ commits: [printed] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${exact.join(' ')}`]: record(sha, 'Subject read from Git', '2026-09-02T04:08:19Z'),
  });
  const commits = new RepositoryCommits(runner, () => {});

  for (let i = 0; i < 5; i++) {
    commits.apply([one], [REPO]);
    await settle();
  }

  assert.equal(one.commits[0].dir, REPO);
  assert.equal(one.commits[0].place, null);
  assert.equal(asks(runner, nested, IDENTITY), 3);
  assert.equal(asks(runner, REPO, exact.join(' ')), 1);
});

test('an abbreviated sha shared by different open repositories names no commit', async () => {
  const exact = ['log', '--no-walk', '--format=%x1e%H%x00%cI%x00%s', '--shortstat', '7574445a', '--'];
  const printed: TurnCommit = {
    sha: '7574445a',
    subject: 'Subject recorded by the transcript',
    head: null,
    files: 3,
    added: 40,
    removed: 2,
    at: 1,
    place: { kind: 'named', dir: TREE },
    dir: TREE,
  };
  const one = turn({ commits: [printed] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${NOTES} ${IDENTITY}`]: `${OTHER_COMMON}\n${OTHER_COMMON}\n${NOTES}\n`,
    [`${REPO} ${exact.join(' ')}`]: record(
      '7574445aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'Arc commit',
      '2026-09-02T04:08:19Z',
    ),
    [`${NOTES} ${exact.join(' ')}`]: record(
      '7574445abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'Notes commit',
      '2026-09-02T04:08:19Z',
    ),
  });
  const commits = new RepositoryCommits(runner, () => {});

  for (let i = 0; i < 6; i++) {
    commits.apply([one], [REPO, NOTES]);
    await settle();
  }

  assert.equal(one.commits[0].dir, TREE, runner.asked.join('\n'));
  assert.deepEqual(one.commits[0].place, { kind: 'named', dir: TREE });
  assert.equal(asks(runner, REPO, exact.join(' ')), 3, runner.asked.join('\n'));
  assert.equal(asks(runner, NOTES, exact.join(' ')), 3);
});

test('exact lookup misses and hits stay with their open-folder set', async () => {
  const sha = '7574445a7574445a7574445a7574445a7574445a';
  const exact = ['log', '--no-walk', '--format=%x1e%H%x00%cI%x00%s', '--shortstat', '7574445a', '--'];
  const printed: TurnCommit = {
    sha: '7574445a',
    subject: 'Subject recorded by the transcript',
    head: null,
    files: 3,
    added: 40,
    removed: 2,
    at: 1,
    place: { kind: 'named', dir: TREE },
    dir: TREE,
  };
  const one = turn({ commits: [printed] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${NOTES} ${IDENTITY}`]: `${OTHER_COMMON}\n${OTHER_COMMON}\n${NOTES}\n`,
    [`${NOTES} ${exact.join(' ')}`]: record(sha, 'Recovered commit', '2026-09-02T04:08:19Z'),
  });
  const commits = new RepositoryCommits(runner, () => {});

  for (let i = 0; i < 6; i++) {
    commits.apply([one], [REPO]);
    await settle();
  }
  assert.equal(one.commits[0].dir, TREE);
  for (let i = 0; i < 3; i++) {
    commits.apply([one], [NOTES]);
    await settle();
  }

  assert.equal(one.commits[0].dir, NOTES);
  assert.equal(one.commits[0].place, null);
  assert.equal(asks(runner, REPO, exact.join(' ')), 3, runner.asked.join('\n'));
  assert.equal(asks(runner, NOTES, exact.join(' ')), 1);

  const otherGone = `${TREE}/other-gone-worktree`;
  const another = turn({
    commits: [
      {
        sha: '7574445a',
        subject: 'Another transcript subject',
        head: null,
        files: 1,
        added: 1,
        removed: 0,
        at: 2,
        place: { kind: 'named', dir: otherGone },
        dir: otherGone,
      },
    ],
  });
  for (let i = 0; i < 5; i++) {
    commits.apply([another], [REPO]);
    await settle();
  }

  assert.equal(another.commits[0].dir, otherGone);
  assert.deepEqual(another.commits[0].place, { kind: 'named', dir: otherGone });
});

test('a printed commit made in a worktree stops reading as another repository', async () => {
  // The path test cannot tell the two apart, so the printed row arrives marked `named`.
  const printed: TurnCommit = {
    sha: '7574445a',
    subject: 'Bucket usage by model',
    head: { kind: 'branch', name: 'feat/usage-model-bucket' },
    files: 3,
    added: 40,
    removed: 2,
    at: 1,
    place: { kind: 'named', dir: TREE },
    dir: TREE,
  };
  const one = turn({ commits: [printed] });
  const runner = fakeRunner(treeAnswers());
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(one.commits[0].place, { kind: 'worktree', dir: TREE });
  // Reading a place asks nothing about a branch. That question belongs to a commit read back.
  assert.equal(asks(runner, TREE, BRANCH), 0);
});

test('a commit in another repository keeps saying so', async () => {
  const foreign: TurnCommit = {
    sha: 'abc1234a',
    subject: 'notes',
    head: null,
    files: 1,
    added: 1,
    removed: 0,
    at: 1,
    place: { kind: 'named', dir: NOTES },
    dir: NOTES,
  };
  const one = turn({ commits: [foreign] });
  const runner = fakeRunner({
    [`${NOTES} ${IDENTITY}`]: `${OTHER_COMMON}\n${OTHER_COMMON}\n${NOTES}\n`,
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
  });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(one.commits[0].place, { kind: 'named', dir: NOTES });
});

test('a window that cannot be told apart from a parallel session names nothing', async () => {
  const quiet = intent({ dir: REPO });
  const one = turn({ commits: [], commitIntents: [quiet] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${logArgs(quiet.from, quiet.to).join(' ')}`]:
      record('5c8e9415c8e9415c8e9415c8e9415c8e9415c8e9', 'Send item four', '2026-09-02T04:08:19Z') +
      record('f245c68f245c68f245c68f245c68f245c68f2456', 'Read commits', '2026-09-02T04:08:19Z'),
  });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(one.commits, []);
});

test('a cold render asks about one directory once, however many sessions it draws', async () => {
  // Every session in a listing calls `apply` before the first read returns. Without a guard
  // on what is already in flight, each one starts its own process for the same directory.
  const runner = fakeRunner(treeAnswers(), true);
  const commits = reader(runner, () => {});
  const sessions = [
    turn({ commits: [], commitIntents: [intent()] }),
    turn({ commits: [], commitIntents: [intent()] }),
    turn({ commits: [], commitIntents: [intent()] }),
  ];

  for (const one of sessions) {
    commits.apply([one], [REPO]);
  }
  // The batches run one after another, so each held read is let go in turn.
  for (let i = 0; i < 24; i++) {
    runner.release();
    await settle();
  }

  assert.equal(asks(runner, REPO, IDENTITY), 1);
  assert.equal(asks(runner, TREE, IDENTITY), 1);
  assert.equal(reflogs(runner, TREE), 1, 'one window is one question, whoever asks it');
});

test('a read that failed is asked again, and the asking stops', async () => {
  const quiet = intent({ dir: REPO });
  const one = turn({ commits: [], commitIntents: [quiet] });
  const answers: Record<string, string | null> = {
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${reflogArgs(quiet.from, quiet.to).join(' ')}`]: null,
  };
  const runner = fakeRunner(answers);
  const commits = reader(runner, () => {});

  // The repository was briefly unreachable, so the head log is asked for again while the
  // directory it already answered for is not.
  for (let i = 0; i < 6; i++) {
    commits.apply([one], [REPO]);
    await settle();
  }
  assert.equal(asks(runner, REPO, IDENTITY), 1);
  // A worktree that was removed never answers. A panel that refreshes every few seconds must
  // not spawn a process every few seconds for the life of the window.
  assert.equal(reflogs(runner, REPO), 3, 'the reader must stop asking a question nothing answers');
  assert.deepEqual(one.commits, []);
});

test('a read that rejects is a read that failed, so the asking still stops', async () => {
  // The ceiling on asking is counted where a read returns nothing. A runner that rejects would
  // leave the attempt uncounted, and the reader would ask again on every render for the life
  // of the window.
  let asked = 0;
  const runner: GitRunner = {
    run(): Promise<string | null> {
      asked++;
      return Promise.reject(new Error('git is not there'));
    },
  };
  const one = turn({ commits: [], commitIntents: [intent({ dir: REPO })] });
  const commits = reader(runner, () => {});

  for (let i = 0; i < 8; i++) {
    commits.apply([one], [REPO]);
    await settle();
  }
  // Three tries for the directory and three for the window, and then nothing.
  assert.equal(asked, 6);
  assert.deepEqual(one.commits, []);
});

test('a directory that never answers stops being asked about', async () => {
  const gone = 'C:/Users/dev/AppData/Local/Temp/tmp-quiet-test';
  const printed: TurnCommit = {
    sha: 'abc1234a',
    subject: 'measure the quiet flag',
    head: null,
    files: 1,
    added: 1,
    removed: 0,
    at: 1,
    place: { kind: 'named', dir: gone },
    dir: gone,
  };
  const one = turn({ commits: [printed] });
  const runner = fakeRunner({ [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n` });
  const commits = reader(runner, () => {});

  for (let i = 0; i < 6; i++) {
    commits.apply([one], [REPO]);
    await settle();
  }
  assert.equal(asks(runner, gone, IDENTITY), 3);
  // It keeps the safe wording, which never offers to open a folder that is not there.
  assert.deepEqual(one.commits[0].place, { kind: 'named', dir: gone });
});

test('a turn already holding a commit does not gain it twice, and the rows stay in order', async () => {
  const sha = 'f245c68f245c68f245c68f245c68f245c68f2456';
  const later: TurnCommit = {
    sha: '9b7394dd',
    subject: 'Leave an in-tree worktree out',
    head: null,
    files: 1,
    added: 21,
    removed: 2,
    at: AT('2026-09-02T04:09:00Z'),
    place: null,
    dir: REPO,
  };
  const already: TurnCommit = {
    sha: 'f245c68f',
    subject: 'Read commits',
    head: null,
    files: null,
    added: null,
    removed: null,
    at: AT('2026-09-02T04:08:19Z'),
    place: null,
    dir: REPO,
  };
  const quiet = intent({ dir: REPO });
  const one: Turn = turn({ commits: [later, already], commitIntents: [quiet] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(sha, 'Read commits', '2026-09-02T04:08:19Z'),
  });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  commits.apply([one], [REPO]);
  assert.equal(one.commits.length, 2);
});

test('a card mixing printed and read-back commits lists them the way they happened', async () => {
  const printed: TurnCommit = {
    sha: '9b7394dd',
    subject: 'Leave an in-tree worktree out',
    head: null,
    files: 1,
    added: 21,
    removed: 2,
    at: AT('2026-09-02T04:09:00Z'),
    place: null,
    dir: REPO,
  };
  const quiet = intent({ dir: REPO });
  const one = turn({ commits: [printed], commitIntents: [quiet] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(
      'f245c68f245c68f245c68f245c68f245c68f2456',
      'Read commits',
      '2026-09-02T04:08:19Z',
    ),
  });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(
    one.commits.map((c) => c.sha),
    ['f245c68f', '9b7394dd'],
  );
});

test('a worktree in the middle of a rebase names no branch', async () => {
  const quiet = intent();
  const one = turn({ commits: [], commitIntents: [quiet] });
  const runner = fakeRunner({
    ...treeAnswers(),
    [`${TREE} ${BRANCH}`]: 'HEAD\n',
    [`${TREE} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(
      '302bd76302bd76302bd76302bd76302bd76302bd',
      'Bucket usage by model',
      '2026-09-02T04:08:19Z',
    ),
  });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.equal(one.commits[0].head, null);
});

test('a window holding more commits than one read allows names nothing', async () => {
  // An answer at the read limit cannot establish complete coverage. The fixture includes twenty slack-only commits and one in-window candidate.

  const quiet = intent({ dir: REPO });
  let stdout = record('5c8e9415c8e9415c8e9415c8e9415c8e9415c8e9', 'Send item four', '2026-09-02T04:08:19Z');
  for (let i = 0; i < 20; i++) {
    stdout += record(
      `${String(i).padStart(2, '0')}c1234abc1234abc1234abc1234abc1234abc12`,
      `commit ${i}`,
      '2026-09-02T04:08:17Z',
    );
  }
  const one = turn({ commits: [], commitIntents: [quiet] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${logArgs(quiet.from, quiet.to).join(' ')}`]: stdout,
  });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(one.commits, []);
  assert.ok(logArgs(1, 2).includes('21'), `the read must ask for one more than it allows: ${logArgs(1, 2).join(' ')}`);
});

test('a branch read that failed is asked again rather than remembered as no branch', async () => {
  // A failed branch read answers the same as a detached head. Keeping that answer would hold
  // a wrong silence for good, so the whole call is asked about again instead.
  const quiet = intent({ dir: REPO });
  const one = turn({ commits: [], commitIntents: [quiet] });
  const answers: Record<string, string | null> = {
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: null,
    [`${REPO} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(
      'f245c68f245c68f245c68f245c68f245c68f2456',
      'Read commits',
      '2026-09-02T04:08:19Z',
    ),
  };
  const runner = fakeRunner(answers);
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  assert.deepEqual(one.commits, []);
  // A branch read that failed spends no log read either, because the answer would be partial.
  assert.equal(logs(runner, REPO), 0);

  answers[`${REPO} ${BRANCH}`] = 'main\n';
  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(
    one.commits.map((c) => c.head),
    [{ kind: 'branch', name: 'main' }],
  );
});

test('a repaint that throws does not stop the reader from ever asking again', async () => {
  // The batches run one after another through one chain. A batch that let its own failure
  // reach that chain would answer every later batch without running it, and every question
  // those batches marked as asked would stay marked for the life of the window.
  const first = turn({ commits: [], commitIntents: [intent({ dir: REPO })] });
  const second = turn({ commits: [], commitIntents: [intent({ dir: TREE })] });
  const quiet = intent();
  const runner = fakeRunner({
    ...treeAnswers(),
    [`${REPO} ${BRANCH}`]: 'main',
    [`${REPO} ${logArgs(quiet.from, quiet.to).join(' ')}`]: '',
    [`${TREE} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(
      '302bd76302bd76302bd76302bd76302bd76302bd',
      'Bucket usage by model',
      '2026-09-02T04:08:19Z',
    ),
  });
  const commits = reader(runner, () => {
    throw new Error('a repaint failed');
  });

  commits.apply([first], [REPO]);
  await settle();
  commits.apply([second], [REPO]);
  await settle();
  commits.apply([second], [REPO]);
  assert.deepEqual(
    second.commits.map((c) => c.sha),
    ['302bd763'],
  );
});

test('a head log names the commits a directory made and nothing else', () => {
  // HEAD reflog entries use the subject and hash format from git log -g --format=%gs%x00%H.
  const log = [
    'commit: Record that a cold derived cache rebuild blocks the first render' +
      FIELD +
      '8734e7c4b773c3926ec84a467c1385b1fefcc75e',
    'commit (amend): Reword it' + FIELD + 'aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1',
    'commit (initial): First' + FIELD + 'bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2',
    // Fast-forward and checkout entries move HEAD without creating commits.

    'merge 302bd76: Fast-forward' + FIELD + 'ccccccc3ccccccc3ccccccc3ccccccc3ccccccc3',
    'checkout: moving from feat/x to main' + FIELD + 'ddddddd4ddddddd4ddddddd4ddddddd4ddddddd4',
  ].join('\n');
  assert.deepEqual(
    [...commitsInHeadLog(log)],
    [
      '8734e7c4b773c3926ec84a467c1385b1fefcc75e',
      'aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1',
      'bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2',
    ],
  );
  // A head log that was turned off or has expired names none, so nothing is drawn.
  assert.equal(commitsInHeadLog('').size, 0);
  assert.ok(reflogArgs(1, 2).includes('-g'));
  assert.ok(reflogArgs(1, 2).includes('HEAD'));
});

test('a commit this directory did not make is not taken from the branch it is on now', async () => {
  // The turn committed quietly on one branch. Another worktree committed once on another
  // branch inside the same window, and this directory was later checked out to it. Walking
  // the current head finds exactly one commit, which the count rule alone would accept.
  // Only this directory's own head log can say that the commit is not its work.
  const quiet = intent({ dir: REPO });
  const runner = fakeRunner({
    ...treeAnswers(),
    [`${REPO} ${reflogArgs(quiet.from, quiet.to).join(' ')}`]: 'checkout: moving from feat/x to main\n',
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(
      '5c8e9415c8e9415c8e9415c8e9415c8e9415c8e9',
      'Send item four',
      '2026-09-02T04:08:19Z',
    ),
  });
  const one = turn({ commits: [], commitIntents: [quiet] });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(one.commits, []);
  // A window with no commit of its own costs one read and no more.
  assert.equal(reflogs(runner, REPO), 1);
  assert.equal(logs(runner, REPO), 0);
  assert.equal(asks(runner, REPO, BRANCH), 0);
});

test('a commit the head log did not record is not adopted from the current branch', async () => {
  // The directory did commit in this window, so the head log says yes. What it committed was
  // on a branch the directory has since left, and walking the current head reaches somebody
  // else's commit instead. The count alone accepts that one. Only the shas the head log
  // recorded can refuse it.
  const quiet = intent({ dir: REPO });
  const mine = 'f245c68f245c68f245c68f245c68f245c68f2456';
  const theirs = '5c8e9415c8e9415c8e9415c8e9415c8e9415c8e9';
  const runner = fakeRunner({
    ...treeAnswers(),
    [`${REPO} ${reflogArgs(quiet.from, quiet.to).join(' ')}`]: `commit: my own quiet commit${FIELD}${mine}`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(theirs, 'Send item four', '2026-09-02T04:08:19Z'),
  });
  const one = turn({ commits: [], commitIntents: [quiet] });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(one.commits, []);
});

test('two calls in one directory are told apart by their windows', () => {
  const first = intent({ from: 1000, to: 2000 });
  const second = intent({ from: 2000, to: 3000 });
  assert.notEqual(intentKey(first), intentKey(second));
  // The same call read twice is one question.
  assert.equal(intentKey(first), intentKey(intent({ from: 1000, to: 2000 })));
  // Path spelling is not a second question either.
  assert.equal(intentKey(intent({ dir: TREE.replace(/\//g, '\\') })), intentKey(intent()));
  assert.notEqual(intentKey(intent({ witnessedSha: '302bd763' })), intentKey(intent({ witnessedSha: '5c8e9415' })));
});

test('a commit read back for a child joins the child figures its own record left without it', async () => {
  const quiet = intent({ witnessedSha: '302bd763' });
  const file = join(tempDir('codex-child-recovery-'), 'child.jsonl');
  const records = [
    {
      timestamp: new Date(quiet.from - 1000).toISOString(),
      type: 'session_meta',
      payload: { id: 'child', cwd: TREE, source: 'vscode' },
    },
    {
      timestamp: new Date(quiet.from).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'child-turn' },
    },
    {
      timestamp: new Date(quiet.to).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'quiet',
          command: [
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            '-Command',
            'git commit -q -m fix && git log --oneline -1 || echo aborted',
          ],
          parsed_cmd: [{ type: 'unknown', cmd: 'git commit -q -m fix && git log --oneline -1 || echo aborted' }],
          cwd: TREE,
          status: 'completed',
          exit_code: 0,
          stdout: '302bd763 Child fix\n',
          started_at_ms: quiet.from,
          completed_at_ms: quiet.to,
        },
      },
    },
    {
      timestamp: new Date(quiet.to + 1000).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'child-turn', last_agent_message: 'Finished.' },
    },
  ];
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const spend = readCodexAgentSpend(file);
  assert.deepEqual(
    spend.commitIntents?.map(({ source: _source, ...intent }) => intent),
    [quiet],
  );
  const read = {
    files: [{ path: 'c:/repo/a.ts', added: 1, removed: 0, isNew: false }],
    commits: [] as string[],
    complete: true,
    revision: 'r1',
  };
  const one = turn({
    agents: [
      {
        id: 'child',
        description: 'Review child',
        agentType: 'general-purpose',
        model: null,
        effort: null,
        spend: [],
        spendFound: true,
        spendPartial: false,
        durationMs: 1,
        tokens: null,
        toolUses: 1,
        status: 'completed',
        commits: [],
        artifacts: { ...read },
      },
    ],
  });
  refreshCodexStructuralAgents([one], 'parent', [], () => ({ ...spend, artifacts: read }));
  const runner = fakeRunner({
    ...treeAnswers(),
    [`${TREE} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(
      '302bd76302bd76302bd76302bd76302bd76302bd',
      'Child fix',
      '2026-09-02T04:08:19Z',
    ),
  });
  const commits = new RepositoryCommits(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(one.agents[0].artifacts?.commits, ['302bd763']);
  assert.equal(one.agents[0].commits?.[0].subject, 'Child fix');
  assert.equal(one.agents[0].commits?.[0].dir, TREE);
  assert.equal(one.agents[0].commits?.[0].place?.kind, 'worktree');
  // The figures a child read returns are shared with the cache that holds them.
  assert.deepEqual(read.commits, []);
});

const LANDED = 'f338b37f338b37f338b37f338b37f338b37f3383';

test.each(['printed', 'quiet'] as const)(
  'verified foreign child commits survive cache reload and worktree removal (%s)',
  { tags: ['subprocess'], timeout: 120000 },
  async (mode) => {
    const directory = tempDir('verified-child-repository-');
    const arc = join(directory, 'arc');
    const foreign = join(directory, 'skills');
    const tree = join(directory, 'worker');
    const file = join(directory, 'child.jsonl');
    const cache = join(directory, 'derived-session-cache.json');
    const clone = join(directory, 'clone');
    let commitAt = '2026-09-02T04:08:17Z';
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, GIT_COMMITTER_DATE: commitAt, GIT_AUTHOR_DATE: commitAt },
      }).trim();
    for (const root of [arc, foreign]) {
      mkdirSync(root);
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test');
    }
    git(foreign, 'commit', '--allow-empty', '-q', '-m', 'First');
    git(foreign, 'worktree', 'add', '-q', '-b', 'topic', tree);
    writeFileSync(join(tree, 'a.txt'), 'child\n');
    git(tree, 'add', 'a.txt');
    commitAt = '2026-09-02T04:08:18Z';
    git(tree, 'commit', '-q', '-m', 'Child fix');
    const sha = git(tree, 'rev-parse', 'HEAD');
    const records = [
      { type: 'session_meta', payload: { id: 'child', cwd: tree, source: 'vscode' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Commit the child fix.' } },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'commit',
            command: ['bash', '-c', `git commit ${mode === 'quiet' ? '-q ' : ''}-m "Child fix"`],
            parsed_cmd: [{ type: 'unknown', cmd: `git commit ${mode === 'quiet' ? '-q ' : ''}-m "Child fix"` }],
            cwd: tree,
            status: 'completed',
            exit_code: 0,
            stdout:
              mode === 'quiet'
                ? ''
                : `[topic ${sha.slice(0, 8)}] Printed child subject\n 1 file changed, 1 insertion(+)\n`,
            started_at_ms: AT('2026-09-02T04:08:18Z'),
            completed_at_ms: AT('2026-09-02T04:08:19Z'),
          },
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn' } },
    ].map((record, index) => ({
      ...record,
      timestamp: new Date(AT('2026-09-02T04:08:17Z') + index * 1000).toISOString(),
    }));
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const parent = (): Turn => {
      const one = turn({
        agents: [
          {
            id: 'child',
            description: 'Worker',
            agentType: 'general-purpose',
            model: null,
            effort: null,
            spend: [],
            spendFound: true,
            spendPartial: false,
            durationMs: 1,
            tokens: null,
            toolUses: 1,
            status: 'completed',
          },
        ],
      });
      const spend = readCodexAgentSpend(file);
      refreshCodexStructuralAgents(
        [one],
        'parent',
        [
          {
            file,
            threadId: 'child',
            parentThreadId: 'parent',
            agentPath: 'general-purpose',
            openedAt: null,
            startedAt: null,
            threadSource: 'subagent',
            backgroundReview: false,
          },
        ],
        () => spend,
      );
      assert.ok((one.agents[0].commits?.[0] ?? one.agents[0].commitIntents?.[0])?.source, JSON.stringify(spend));
      return one;
    };
    const runner = nodeGitRunner();
    let captured!: () => void;
    const capture = new Promise<void>((resolve) => {
      captured = resolve;
    });
    let recovered!: () => void;
    const recovery = new Promise<void>((resolve) => {
      recovered = resolve;
    });
    const retained = new CommitRepositories(runner, captured);
    const resolver = new RepositoryCommits(runner, recovered);
    const apply = (reader: RepositoryCommits, proofs: CommitRepositories, one: Turn, folders = [arc]) =>
      reader.apply(
        [one],
        folders,
        (commit, identities, _turn, agent) => proofs.apply(commit, agent?.id === 'child' ? file : null, identities),
        (intent, identities, _turn, agent) => proofs.restore(intent, agent?.id === 'child' ? file : null, identities),
      );
    const first = parent();
    apply(resolver, retained, first);
    await recovery;
    apply(resolver, retained, first);
    await capture;
    assert.equal(retained.snapshot().length, 1);
    saveDerivedCache(cache, [], [], [], undefined, undefined, retained.snapshot());
    const stored = JSON.parse(readFileSync(cache, 'utf8'));
    delete stored.formatVersion;
    delete stored.metadataVersion;
    stored.version = 64;
    writeFileSync(cache, JSON.stringify(stored));
    const migrated = loadDerivedCache(cache);
    assert.equal(migrated.migrationPending, true);
    const current = cache + '-v1';
    saveDerivedCache(current, [], [], [], undefined, undefined, migrated.commitRepositories);
    const saved = loadDerivedCache(current).commitRepositories!;
    assert.equal(saved[0].sha, sha);
    git(foreign, 'worktree', 'remove', tree);
    git(directory, 'clone', '-q', foreign, clone);

    const fresh = async (gitRunner = runner, folders = [arc]) => {
      let answered = false;
      const proofs = new CommitRepositories(gitRunner, () => {
        answered = true;
      });
      proofs.load(saved);
      const reader = new RepositoryCommits(gitRunner, () => {});
      const one = parent();
      apply(reader, proofs, one, folders);
      await vi.waitFor(() => assert.equal(answered, true), { timeout: 10000 });
      apply(reader, proofs, one, folders);
      return { one, reader, proofs };
    };
    const restored = await fresh();
    const card = commitRowsOf(restored.one, 1, [arc]).commits[0];
    assert.deepEqual(card.repository, { key: normalizeFsPath(join(foreign, '.git')), name: 'skills', own: false });
    assert.equal(card.madeBySession, 'child');
    assert.equal(card.madeBy, 'Worker');
    assert.equal(restored.one.agents[0].commits![0].dir, normalizeFsPath(foreign));
    assert.deepEqual(
      ['subject', 'head', 'files', 'added', 'removed', 'at'].map(
        (key) => restored.one.agents[0].commits![0][key as keyof TurnCommit],
      ),
      ['subject', 'head', 'files', 'added', 'removed', 'at'].map(
        (key) => first.agents[0].commits![0][key as keyof TurnCommit],
      ),
    );
    // Child spend recreates its rows. The same saved occurrence must still enrich the parent.
    const rebuilt = parent();
    apply(restored.reader, restored.proofs, rebuilt);
    assert.equal(commitRowsOf(rebuilt, 1, [arc]).commits[0].repository?.name, 'skills');
    await vi.waitFor(
      () => {
        apply(restored.reader, restored.proofs, rebuilt, [arc, foreign]);
        assert.equal(rebuilt.agents[0].commits![0].repository?.own, true);
      },
      { timeout: 10000 },
    );
    apply(restored.reader, restored.proofs, rebuilt, [arc]);
    assert.equal(rebuilt.agents[0].commits![0].repository?.own, false);

    // A clone with the same object cannot replace the saved checkout's missing object.
    const missing: GitRunner = {
      run: (dir, args) =>
        normalizeFsPath(dir) === normalizeFsPath(foreign) && args.includes('--no-walk')
          ? Promise.resolve(null)
          : runner.run(dir, args),
    };
    assert.ok(!(await fresh(missing, [arc, clone])).one.agents[0].commits?.some((commit) => commit.repository));
    const common = join(foreign, '.git');
    const movedCommon = join(foreign, '.git-saved');
    renameSync(common, movedCommon);
    mkdirSync(common);
    const replacedCommon = new CommitRepositories(runner, () => {});
    replacedCommon.load(saved);
    const commonRow = parent();
    await new Promise<void>((resolve) => {
      apply(new RepositoryCommits(runner, resolve), replacedCommon, commonRow);
      assert.ok(!commonRow.agents[0].commits?.some((commit) => commit.repository));
    });
    rmdirSync(common);
    renameSync(movedCommon, common);
    const movedRoot = join(directory, 'skills-saved');
    renameSync(foreign, movedRoot);
    git(directory, 'clone', '-q', clone, foreign);
    const replacedRoot = new CommitRepositories(runner, () => {});
    replacedRoot.load(saved);
    const rootRow = parent();
    await new Promise<void>((resolve) => {
      apply(new RepositoryCommits(runner, resolve), replacedRoot, rootRow);
      assert.ok(!rootRow.agents[0].commits?.some((commit) => commit.repository));
    });
    renameSync(foreign, join(directory, 'replacement'));
    renameSync(movedRoot, foreign);
    appendFileSync(file, '{}\n');
    const changedSource = new CommitRepositories(runner, () => {});
    changedSource.load(saved);
    const changedRow = parent();
    await new Promise<void>((resolve) => {
      apply(new RepositoryCommits(runner, resolve), changedSource, changedRow);
      assert.ok(!changedRow.agents[0].commits?.some((commit) => commit.repository));
    });
  },
);
// File identities remain real while Git responses and the validation clock stay controlled.
function observedRepository() {
  const directory = tempDir('observed-repository-');
  const root = join(directory, 'skills');
  const command = join(directory, 'worker');
  const common = join(root, '.git');
  mkdirSync(root);
  mkdirSync(command);
  mkdirSync(common);
  const file = join(directory, 'source.jsonl');
  writeFileSync(file, '{}\n');
  const sha = 'a'.repeat(40);
  let unavailable = false;
  let association = common;
  let race = false;
  let calls = 0;
  const runner: GitRunner = {
    run: async (dir, args) => {
      calls++;
      if (args[0] === 'rev-parse')
        return `${normalizeFsPath(association)}\n${normalizeFsPath(association)}\n${normalizeFsPath(dir)}\n`;
      if (args[0] === 'worktree') return `worktree ${root}\0HEAD ${sha}\0branch refs/heads/main\0\0`;
      if (race && normalizeFsPath(dir) === normalizeFsPath(root)) {
        race = false;
        appendFileSync(file, '{}\n');
      }
      return unavailable ? null : record(sha, 'Child fix', '2026-09-02T04:08:18Z');
    },
  };
  const fresh = (): TurnCommit => ({
    sha: sha.slice(0, 8),
    subject: 'Child fix',
    head: { kind: 'branch', name: 'topic' },
    files: 1,
    added: 1,
    removed: 0,
    at: AT('2026-09-02T04:08:19Z'),
    dir: command,
    place: null,
    source: { file, stamp: commitSourceStamp(file)! },
  });
  return {
    file,
    root,
    command,
    common,
    runner,
    fresh,
    calls: () => calls,
    race: () => {
      race = true;
    },
    remove: () => {
      unavailable = true;
    },
    recover: () => {
      unavailable = false;
    },
    retarget: () => {
      association = join(directory, 'another.git');
    },
  };
}

test('an accepted source append refreshes proof and preserves a live foreign commit', async () => {
  const f = observedRepository();
  const proofs = new CommitRepositories(f.runner, () => {});
  const reader = new RepositoryCommits(f.runner, () => {});
  const apply = (commit: TurnCommit) =>
    reader.apply([turn({ commits: [commit] })], [], (one, ids) => proofs.apply(one, f.file, ids));
  const first = f.fresh();
  apply(first);
  await vi.waitFor(() => assert.equal(proofs.snapshot().length, 1));
  appendFileSync(f.file, '{}\n');
  const fresh = f.fresh();
  await vi.waitFor(() => {
    apply(fresh);
    assert.equal(fresh.dir, normalizeFsPath(f.root));
  });
  assert.equal(fresh.repository?.root, normalizeFsPath(f.root));
  assert.deepEqual(proofs.snapshot()[0].stamp, fresh.source!.stamp);
  // A recreated command path cannot supply fresh evidence for the saved occurrence.
  renameSync(f.command, f.command + '-old');
  mkdirSync(f.command);
  appendFileSync(f.file, '{}\n');
  const replacement = f.fresh();
  apply(replacement);
  await settle();
  apply(replacement);
  assert.equal(replacement.repository, null);
});

test('a source race retries once at a newly accepted revision', async () => {
  const f = observedRepository();
  f.race();
  let completed = 0;
  const proofs = new CommitRepositories(f.runner, () => {
    completed++;
  });
  const first = f.fresh();
  proofs.apply(first, f.file, []);
  await vi.waitFor(() => assert.equal(completed, 1));
  assert.equal(proofs.snapshot().length, 0);
  const before = f.calls();
  proofs.apply(first, f.file, []);
  await settle();
  assert.equal(f.calls(), before);
  const next = f.fresh();
  proofs.apply(next, f.file, []);
  await vi.waitFor(() => assert.equal(proofs.snapshot().length, 1));
  proofs.apply(next, f.file, []);
  assert.equal(next.repository?.root, normalizeFsPath(f.root));
});

// Mocked Git keeps collection limits independent of repository creation and subprocess cost.
test.each(['source', 'global'] as const)('a full %s collection refreshes a live commit after append', async (limit) => {
  const f = observedRepository();
  const initial = new CommitRepositories(f.runner, () => {});
  initial.apply(f.fresh(), f.file, []);
  await vi.waitFor(() => assert.equal(initial.snapshot().length, 1));
  const saved = initial.snapshot()[0];
  const count = limit === 'source' ? MAX_SOURCE_COMMIT_REPOSITORIES : MAX_COMMIT_REPOSITORIES;
  const rows = Array.from({ length: count }, (_, i) => ({
    ...(i === 0
      ? saved
      : {
          ...saved,
          dir: '/repo',
          root: { path: '/repo', dev: '1', ino: '2' },
          command: { path: '/command', dev: '1', ino: '3' },
          common: { path: '/repo/.git', dev: '1', ino: '4' },
        }),
    file: i < MAX_SOURCE_COMMIT_REPOSITORIES ? f.file : `/source/${Math.floor(i / MAX_SOURCE_COMMIT_REPOSITORIES)}`,
    occurrence: i === 0 ? saved.occurrence : i.toString(16).padStart(64, '0'),
  }));
  let completed = 0;
  const proofs = new CommitRepositories(f.runner, () => {
    completed++;
  });
  proofs.load(rows);
  assert.equal(proofs.snapshot().length, count);
  appendFileSync(f.file, '{}\n');
  const fresh = f.fresh();
  const one = turn({ commits: [fresh] });
  const reader = new RepositoryCommits(f.runner, () => {});
  await vi.waitFor(() => {
    reader.apply([one], [], (commit, ids) => proofs.apply(commit, f.file, ids));
    assert.equal(commitRowsOf(one, 1, []).commits[0].dir, normalizeFsPath(f.root));
  });
  assert.equal(commitRowsOf(one, 1, []).commits[0].repository?.name, 'skills');
  assert.equal(fresh.repository?.root, normalizeFsPath(f.root));
  assert.deepEqual(proofs.snapshot()[0].stamp, fresh.source!.stamp);
  assert.equal(proofs.snapshot().length, count);
  assert.ok(Buffer.byteLength(JSON.stringify(proofs.snapshot())) <= MAX_COMMIT_REPOSITORY_BYTES);
  const additional = { ...f.fresh(), at: fresh.at + 1 };
  const additionalTurn = turn({ commits: [additional] });
  await vi.waitFor(() => {
    reader.apply([additionalTurn], [], (commit, ids) => proofs.apply(commit, f.file, ids));
    assert.equal(additional.repository?.key, normalizeFsPath(f.common));
  });
  assert.equal(proofs.snapshot().length, count);
  f.remove();
  appendFileSync(f.file, '{}\n');
  const missing = f.fresh();
  proofs.apply(missing, f.file, []);
  await vi.waitFor(() => assert.equal(completed, 2));
  const before = f.calls();
  for (let i = 0; i < 20; i++) proofs.apply(missing, f.file, []);
  await settle();
  assert.equal(f.calls(), before);
  assert.equal(missing.repository, null);
});

test('capture exhaustion refuses repeated work until a newly accepted source revision', async () => {
  const f = observedRepository();
  f.remove();
  let completed = 0;
  const proofs = new CommitRepositories(f.runner, () => {
    completed++;
  });
  const refused = Array.from({ length: MAX_SOURCE_COMMIT_REPOSITORIES + 1 }, (_, i) => ({
    ...f.fresh(),
    at: f.fresh().at + i,
  }));
  for (const commit of refused) proofs.apply(commit, f.file, []);
  await vi.waitFor(() => assert.equal(completed, MAX_SOURCE_COMMIT_REPOSITORIES));
  assert.equal(proofs.snapshot().length, 0);
  const before = f.calls();
  for (let i = 0; i < 20; i++) {
    for (const commit of refused) proofs.apply(commit, f.file, []);
  }
  await settle();
  assert.equal(f.calls(), before);
  assert.equal(completed, MAX_SOURCE_COMMIT_REPOSITORIES);
  // New revisions replace the allowance instead of accumulating a lifetime query count.
  for (let i = 0; i < MAX_SOURCE_COMMIT_REPOSITORIES; i++) {
    appendFileSync(f.file, '{}\n');
    proofs.apply(f.fresh(), f.file, []);
    await vi.waitFor(() => assert.equal(completed, MAX_SOURCE_COMMIT_REPOSITORIES + i + 1));
  }
  f.recover();
  appendFileSync(f.file, '{}\n');
  const fresh = f.fresh();
  const one = turn({ commits: [fresh] });
  const reader = new RepositoryCommits(f.runner, () => {});
  await vi.waitFor(() => {
    reader.apply([one], [], (commit, ids) => proofs.apply(commit, f.file, ids));
    assert.equal(commitRowsOf(one, 1, []).commits[0].repository?.name, 'skills');
  });
});

test('global failed checks release admission after source revision and removal', async () => {
  const f = observedRepository();
  f.remove();
  let completed = 0;
  const proofs = new CommitRepositories(f.runner, () => {
    completed++;
  });
  const files = Array.from({ length: MAX_COMMIT_REPOSITORIES / MAX_SOURCE_COMMIT_REPOSITORIES }, (_, i) => {
    const file = i === 0 ? f.file : f.file + i;
    writeFileSync(file, '{}\n');
    return file;
  });
  const failed = files.flatMap((file) => {
    const source = { file, stamp: commitSourceStamp(file)! };
    return Array.from({ length: MAX_SOURCE_COMMIT_REPOSITORIES }, (_, i) => ({
      ...f.fresh(),
      source,
      at: f.fresh().at + i,
    }));
  });
  for (const commit of failed) proofs.apply(commit, commit.source.file, []);
  await vi.waitFor(() => assert.equal(completed, MAX_COMMIT_REPOSITORIES));
  assert.equal(proofs.snapshot().length, 0);
  const before = f.calls();
  for (const commit of failed) proofs.apply(commit, commit.source.file, []);
  await settle();
  assert.equal(f.calls(), before);

  f.recover();
  appendFileSync(f.file, '{}\n');
  proofs.apply(f.fresh(), f.file, []);
  await vi.waitFor(() => assert.equal(proofs.snapshot().length, 1));
  const cache = f.file + '-cache';
  saveDerivedCache(cache, [], [], [], undefined, undefined, proofs.snapshot());
  rmdirSync(f.command);
  const restored = new CommitRepositories(f.runner, () => {});
  restored.load(loadDerivedCache(cache).commitRepositories!);
  const one = turn({ commits: [f.fresh()] });
  const reader = new RepositoryCommits(f.runner, () => {});
  await vi.waitFor(() => {
    reader.apply([one], [], (commit, ids) => restored.apply(commit, f.file, ids));
    assert.equal(commitRowsOf(one, 1, []).commits[0].repository?.name, 'skills');
  });

  mkdirSync(f.command);
  f.remove();
  for (let i = 1; i < MAX_SOURCE_COMMIT_REPOSITORIES; i++)
    proofs.apply({ ...f.fresh(), at: f.fresh().at + i }, f.file, []);
  await vi.waitFor(() => assert.equal(completed, MAX_COMMIT_REPOSITORIES + MAX_SOURCE_COMMIT_REPOSITORIES));
  const newFile = f.file + '-new';
  writeFileSync(newFile, '{}\n');
  const next = { ...f.fresh(), source: { file: newFile, stamp: commitSourceStamp(newFile)! } };
  const saturated = f.calls();
  proofs.apply(next, newFile, []);
  await settle();
  assert.equal(f.calls(), saturated);
  // Failed-only sources release their admission metadata when coverage proves them absent.
  proofs.prune((file) => normalizeFsPath(file) !== normalizeFsPath(f.file));
  f.recover();
  proofs.apply(next, newFile, []);
  await vi.waitFor(() => assert.equal(proofs.snapshot().length, 2));
});

test('byte-evicted validation checks share admission with saved and pending occurrences', async () => {
  const f = observedRepository();
  const initial = new CommitRepositories(f.runner, () => {});
  initial.apply(f.fresh(), f.file, []);
  await vi.waitFor(() => assert.equal(initial.snapshot().length, 1));
  const saved = initial.snapshot()[0];
  const lastFile = f.file + '-last';
  writeFileSync(lastFile, '{}\n');
  const rows = Array.from({ length: MAX_SOURCE_COMMIT_REPOSITORIES }, (_, i) => ({
    ...saved,
    file: i === 0 ? f.file : `/source/${Math.floor(i / MAX_SOURCE_COMMIT_REPOSITORIES)}`,
    occurrence: i === 0 ? saved.occurrence : i.toString(16).padStart(64, '0'),
    recovered: {
      intent: '',
      commit: { sha: saved.sha, subject: '', head: null, files: 1, added: 1, removed: 0, at: 0 },
    },
  }));
  Object.assign(rows.at(-1)!, { file: lastFile, occurrence: saved.occurrence, stamp: commitSourceStamp(lastFile)! });
  let remaining =
    MAX_COMMIT_REPOSITORY_BYTES - rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  assert.ok(remaining > 0);
  for (const row of rows) {
    const size = Math.min(remaining, 65536);
    row.recovered.commit.subject = 'x'.repeat(size);
    remaining -= size;
  }
  assert.equal(remaining, 0);
  let completed = 0;
  let release!: () => void;
  let hold = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const proofs = new CommitRepositories(
    {
      run: async (dir, args) => {
        if (hold) await held;
        return f.runner.run(dir, args);
      },
    },
    () => {
      completed++;
    },
  );
  proofs.load(rows);
  const last = { ...f.fresh(), source: { file: lastFile, stamp: commitSourceStamp(lastFile)! } };
  proofs.apply(last, lastFile, []);
  await vi.waitFor(() => assert.equal(completed, 1));
  appendFileSync(f.file, ' '.repeat(1000));
  proofs.apply(f.fresh(), f.file, []);
  await vi.waitFor(() => assert.equal(completed, 2));
  assert.equal(proofs.snapshot().length, rows.length - 1);
  assert.ok(!proofs.snapshot().some((row) => row.file === lastFile));
  const before = f.calls();
  proofs.apply(last, lastFile, []);
  await settle();
  assert.equal(f.calls(), before);
  f.remove();
  const count = MAX_COMMIT_REPOSITORIES - rows.length;
  const files = Array.from({ length: count / MAX_SOURCE_COMMIT_REPOSITORIES }, (_, i) => {
    const file = f.file + '-failed-' + i;
    writeFileSync(file, '{}\n');
    return file;
  });
  const failed = files.flatMap((file) =>
    Array.from({ length: MAX_SOURCE_COMMIT_REPOSITORIES }, (_, i) => ({
      ...f.fresh(),
      at: f.fresh().at + i,
      source: { file, stamp: commitSourceStamp(file)! },
    })),
  );
  for (const commit of failed.slice(0, -1)) proofs.apply(commit, commit.source.file, []);
  await vi.waitFor(() => assert.equal(completed, count + 1));
  hold = true;
  const pending = failed.at(-1)!;
  proofs.apply(pending, pending.source.file, []);
  const refusedFile = f.file + '-refused';
  writeFileSync(refusedFile, '{}\n');
  const refused = { ...f.fresh(), source: { file: refusedFile, stamp: commitSourceStamp(refusedFile)! } };
  proofs.apply(refused, refusedFile, []);
  release();
  await vi.waitFor(() => assert.equal(completed, count + 2));
  await settle();
  assert.equal(completed, count + 2);
  proofs.prune((file) => file === rows[1].file);
  f.recover();
  appendFileSync(files[0], '{}\n');
  const revised = { ...f.fresh(), source: { file: files[0], stamp: commitSourceStamp(files[0])! } };
  proofs.apply(revised, files[0], []);
  await vi.waitFor(() => assert.equal(completed, count + 3));
  proofs.apply(refused, refusedFile, []);
  await vi.waitFor(() => assert.equal(completed, count + 4));
  assert.ok(proofs.snapshot().some((row) => row.file === refusedFile));
});

test('pruning an in-flight capture prevents the absent source from returning', async () => {
  const f = observedRepository();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  let completed = 0;
  const proofs = new CommitRepositories(
    {
      run: async (dir, args) => {
        started = true;
        await held;
        return f.runner.run(dir, args);
      },
    },
    () => {
      completed++;
    },
  );
  proofs.apply(f.fresh(), f.file, []);
  await vi.waitFor(() => assert.ok(started));
  proofs.prune(() => true);
  release();
  await vi.waitFor(() => assert.equal(completed, 1));
  assert.equal(proofs.snapshot().length, 0);
});

test.each(['object', 'association'] as const)(
  'successful proof expires after a changed repository %s',
  async (change) => {
    const f = observedRepository();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let completed = 0;
    const proofs = new CommitRepositories(f.runner, () => {
      completed++;
    });
    const first = f.fresh();
    proofs.apply(first, f.file, []);
    await vi.waitFor(() => assert.equal(completed, 1));
    proofs.apply(first, f.file, []);
    assert.ok(first.repository);
    const before = f.calls();
    if (change === 'object') f.remove();
    else f.retarget();
    for (let i = 0; i < 20; i++) proofs.apply(first, f.file, []);
    assert.equal(f.calls(), before);
    now += COMMIT_REPOSITORY_CHECK_MS;
    proofs.apply(first, f.file, []);
    proofs.apply(first, f.file, []);
    // The row keeps its group while the check runs, and navigation waits for it.
    assert.ok(first.repository);
    assert.equal(first.dir, null);
    await vi.waitFor(() => assert.equal(completed, 2));
    proofs.apply(first, f.file, []);
    assert.equal(first.repository, null);
    assert.equal(first.dir, null);
    assert.equal(f.calls() - before, 2);
  },
);

// The pane shape a reader sees: each group's repository name, branch and row order, or one headerless list.
function paneShape(commits: TurnCommit[], owned: TurnLanding) {
  const cards = [landingCard(owned, [], 1), ...commits.map((commit) => commitCard(commit, 1, null, null, []))];
  const grouping = groupCommitRows(cards);
  return {
    cards: cards.slice(1),
    shape: {
      single: grouping.single,
      groups: grouping.groups.map((group) => ({
        repository: group.repository.name,
        own: group.repository.own,
        rows: group.rows.map((row) => row.at),
      })),
    },
  };
}

const foreignGroup = (commits: TurnCommit[], owned: TurnLanding) =>
  paneShape(commits, owned).shape.groups.some((group) => !group.own);

// A held Git check keeps the pending state open. The injected clock and the real source stamp decide when a check is due.
function heldRepository() {
  const f = observedRepository();
  let gate: Promise<void> | null = null;
  let release = () => {};
  let completed = 0;
  const proofs = new CommitRepositories(
    {
      run: async (dir, args) => {
        if (gate) await gate;
        return f.runner.run(dir, args);
      },
    },
    () => {
      completed++;
    },
  );
  const reader = new RepositoryCommits(f.runner, () => {});
  const owned: TurnLanding = {
    id: 'owned',
    sha: 'bbbbbbbb',
    subject: 'Owned landing',
    from: 'topic',
    head: { kind: 'branch', name: 'main' },
    at: AT('2026-09-02T04:08:10Z'),
    dir: '/owned',
    place: null,
    repository: { key: '/owned/.git', root: '/owned', own: true },
  };
  const make = () => [f.fresh(), { ...f.fresh(), at: AT('2026-09-02T04:08:30Z') }];
  const apply = (commits: TurnCommit[]) =>
    reader.apply([turn({ commits })], [], (one, ids) => proofs.apply(one, f.file, ids));
  return {
    f,
    owned,
    make,
    apply,
    proofs,
    completed: () => completed,
    hold: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release();
      gate = null;
    },
  };
}

test.each(['expiry', 'append'] as const)('a commit group survives a repository check after %s', async (change) => {
  const h = heldRepository();
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    let commits = h.make();
    h.apply(commits);
    await vi.waitFor(() => assert.equal(h.completed(), 2));
    h.apply(commits);
    const before = paneShape(commits, h.owned);
    assert.equal(before.shape.single, false);
    assert.deepEqual(
      before.shape.groups.map((group) => group.rows.length),
      [1, 2],
    );
    assert.ok(before.cards.every((card) => card.dir !== null));
    h.hold();
    if (change === 'expiry') now += COMMIT_REPOSITORY_CHECK_MS;
    else {
      appendFileSync(h.f.file, '{}\n');
      // The commits parsed before the append still render while the grown source is read again.
      h.apply(commits);
      const grown = paneShape(commits, h.owned);
      assert.deepEqual(grown.shape, before.shape);
      assert.ok(grown.cards.every((card) => card.dir === null));
      commits = h.make();
    }
    h.apply(commits);
    h.apply(commits);
    const pending = paneShape(commits, h.owned);
    assert.deepEqual(pending.shape, before.shape);
    // Navigation waits for the check.
    assert.ok(pending.cards.every((card) => card.dir === null));
    h.release();
    await vi.waitFor(() => assert.equal(h.completed(), 4));
    h.apply(commits);
    const after = paneShape(commits, h.owned);
    assert.deepEqual(after.shape, before.shape);
    assert.ok(after.cards.every((card) => card.dir !== null));
  } finally {
    vi.restoreAllMocks();
  }
});

test('a commit group is lost once its repository check fails and stays lost while the next check runs', async () => {
  const h = heldRepository();
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const commits = h.make();
    h.apply(commits);
    await vi.waitFor(() => assert.equal(h.completed(), 2));
    h.apply(commits);
    assert.equal(foreignGroup(commits, h.owned), true);
    h.f.remove();
    now += COMMIT_REPOSITORY_CHECK_MS;
    h.hold();
    h.apply(commits);
    assert.equal(foreignGroup(commits, h.owned), true);
    h.release();
    await vi.waitFor(() => assert.equal(h.completed(), 4));
    h.apply(commits);
    const failed = paneShape(commits, h.owned);
    assert.equal(
      failed.shape.groups.some((group) => !group.own),
      false,
    );
    assert.ok(failed.cards.every((card) => card.dir === null || card.repository?.own));
    // The next check also runs without the group, so a failing row never regroups for it.
    now += COMMIT_REPOSITORY_CHECK_MS;
    h.hold();
    h.apply(commits);
    h.apply(commits);
    assert.equal(foreignGroup(commits, h.owned), false);
    h.release();
    await vi.waitFor(() => assert.equal(h.completed(), 6));
    // A source append rebinds the row, and the earlier failure keeps its group away until a check passes.
    appendFileSync(h.f.file, '{}\n');
    const rebuilt = h.make();
    h.hold();
    h.apply(rebuilt);
    h.apply(rebuilt);
    assert.equal(foreignGroup(rebuilt, h.owned), false);
    h.release();
    await vi.waitFor(() => assert.equal(h.completed(), 8));
    h.apply(rebuilt);
    assert.equal(foreignGroup(rebuilt, h.owned), false);
  } finally {
    vi.restoreAllMocks();
  }
});

test.each(['pending', 'expired', 'pruned', 'retargeted', 'replaced'] as const)(
  'a delayed open of a proven commit is refused while its proof is %s',
  async (state) => {
    const f = observedRepository();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let completed = 0;
    const proofs = new CommitRepositories(f.runner, () => {
      completed++;
    });
    const commit = f.fresh();
    proofs.apply(commit, f.file, []);
    assert.equal(proofs.openableDir(commit), undefined);
    await vi.waitFor(() => assert.equal(completed, 1));
    if (state === 'pending') {
      // A saved proof holds no passing check until the host checks it again.
      const loaded = new CommitRepositories(f.runner, () => {});
      loaded.load(proofs.snapshot());
      const again = f.fresh();
      loaded.apply(again, f.file, []);
      assert.equal(loaded.openableDir(again), null);
      // A commit without a recorded proof keeps the directory Git resolved.
      assert.equal(proofs.openableDir(f.fresh()), undefined);
      return;
    }
    proofs.apply(commit, f.file, []);
    assert.equal(proofs.openableDir(commit), normalizeFsPath(f.root));
    if (state === 'pruned') f.remove();
    else if (state === 'retargeted') f.retarget();
    else if (state === 'replaced') {
      renameSync(f.root, f.root + '-old');
      mkdirSync(f.root);
    }
    if (state === 'expired' || state === 'pruned' || state === 'retargeted') now += COMMIT_REPOSITORY_CHECK_MS;
    // The proof gives no directory until a check passes.
    assert.equal(proofs.openableDir(commit), null);
    if (state === 'pruned' || state === 'retargeted') {
      proofs.apply(commit, f.file, []);
      await vi.waitFor(() => assert.equal(completed, 2));
      assert.equal(proofs.openableDir(commit), null);
    }
  },
);

test.each(['pending', 'failed'] as const)(
  'a recovered commit waits for its repository check after a restart and never appears when the check is %s',
  async (state) => {
    const f = observedRepository();
    const recovering: CommitIntent = {
      dir: f.command,
      from: 1,
      to: 2,
      expected: 1,
      source: { file: f.file, stamp: commitSourceStamp(f.file)! },
    };
    let completed = 0;
    const proofs = new CommitRepositories(f.runner, () => {
      completed++;
    });
    proofs.apply({ ...f.fresh(), intent: intentKey(recovering) }, f.file, []);
    await vi.waitFor(() => assert.equal(completed, 1));
    const restarted = new CommitRepositories(f.runner, () => {
      completed++;
    });
    restarted.load(proofs.snapshot());
    if (state === 'failed') f.remove();
    const ask = () => restarted.restore(recovering, f.file, []);
    // Nothing is returned before the check, and a repeated read starts no second check.
    assert.deepEqual(ask(), []);
    assert.deepEqual(ask(), []);
    await vi.waitFor(() => assert.equal(completed, 2));
    if (state === 'failed') assert.deepEqual(ask(), []);
    else assert.equal(ask()?.[0].dir, normalizeFsPath(f.root));
  },
);

test.each(['expired', 'grown'] as const)(
  'opening a proven commit waits for the repository check after its proof is %s',
  async (state) => {
    const f = observedRepository();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let completed = 0;
      const proofs = new CommitRepositories(f.runner, () => {
        completed++;
      });
      const commit = f.fresh();
      proofs.apply(commit, f.file, []);
      await vi.waitFor(() => assert.equal(completed, 1));
      proofs.apply(commit, f.file, []);
      assert.equal(await proofs.openable(commit), normalizeFsPath(f.root));
      const lapse = () => {
        if (state === 'expired') now += COMMIT_REPOSITORY_CHECK_MS;
        else appendFileSync(f.file, '{}\n');
      };
      lapse();
      assert.equal(proofs.openableDir(commit), null);
      const before = f.calls();
      // The click starts the check and opens once it passes.
      assert.equal(await proofs.openable(commit), normalizeFsPath(f.root));
      assert.ok(f.calls() > before);
      // A check that fails refuses the open, and the failure keeps later opens refused.
      f.remove();
      if (state === 'expired') now += COMMIT_REPOSITORY_CHECK_MS;
      assert.equal(await proofs.openable(commit), null);
      f.recover();
      now += COMMIT_REPOSITORY_CHECK_MS;
      assert.equal(await proofs.openable(commit), null);
    } finally {
      vi.restoreAllMocks();
    }
  },
);

const LANDED_SUBJECT = 'Bundle the panel script from a TypeScript entry';

const merge = (over: Partial<LandingIntent> = {}): LandingIntent => ({
  dir: REPO,
  from: AT('2026-09-03T21:15:37.497Z'),
  to: AT('2026-09-03T21:16:10.139Z'),
  expected: 1,
  ...over,
});

const LANDED_AT = '2026-09-03T21:16:00+00:00';
const entry = (name: string, sha: string, at: string = LANDED_AT): string =>
  `merge ${name}: Fast-forward${FIELD}${sha}${FIELD}${at}`;

test('a head log names the trees this directory fast-forwarded', () => {
  // A fast-forward reflog entry retains the source named by the merge command.

  const log = [
    entry('panel-ts/ui-1', LANDED),
    `commit: Read commits from the repository${FIELD}f245c68f245c68f245c68f245c68f245c68f2456${FIELD}${LANDED_AT}`,
    // A merge that made a merge commit is no landing, and neither is a checkout.
    `merge topic: Merge made by the 'ort' strategy${FIELD}ccccccc3ccccccc3ccccccc3ccccccc3ccccccc3${FIELD}${LANDED_AT}`,
    `checkout: moving from feat/x to main${FIELD}ddddddd4ddddddd4ddddddd4ddddddd4ddddddd4${FIELD}${LANDED_AT}`,
  ].join('\n');
  assert.deepEqual(landingsInHeadLog(log, { kind: 'branch', name: 'main' }), [
    {
      from: 'panel-ts/ui-1',
      sha: LANDED,
      at: Date.parse(LANDED_AT),
      head: { kind: 'branch', name: 'main' },
    },
  ]);
  assert.deepEqual(landingsInHeadLog('', { kind: 'branch', name: 'main' }), []);
  // Git writes the newest first and a call that landed two landed them in the other order.
  const two = [entry('second', 'bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2'), entry('first', LANDED)];
  assert.deepEqual(
    landingsInHeadLog(two.join('\n'), { kind: 'branch', name: 'main' }).map((l) => l.from),
    ['first', 'second'],
  );
});

test('a checkout to an upper-case all-hex branch name names that branch, not a detached head', () => {
  // Git only ever prints a sha in lower case, so an upper-case hex word is a branch name, spelled
  // that way by whoever created it, and never git's own abbreviation of a commit.
  const log = [
    entry('feature', LANDED),
    `checkout: moving from ABCDEF1 to feature${FIELD}eeeeeee5eeeeeee5eeeeeee5eeeeeee5eeeeeee5${FIELD}${LANDED_AT}`,
    entry('older', 'bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2'),
  ].join('\n');
  const [older] = landingsInHeadLog(log, { kind: 'branch', name: 'feature' });
  assert.deepEqual(older.head, { kind: 'branch', name: 'ABCDEF1' });
});

test('a window names its landings only when it holds as many as the command asked for', () => {
  const from = AT('2026-09-03T21:15:37.497Z');
  const to = AT('2026-09-03T21:16:10.139Z');
  const one = [{ from: 'topic', sha: LANDED, at: AT(LANDED_AT), head: { kind: 'branch', name: 'main' } as const }];
  assert.deepEqual(chooseLandings(one, from, to, 1), one);
  assert.deepEqual(chooseLandings(one, from, to, 0), []);
  assert.deepEqual(chooseLandings(one, from, to, 2), []);
  // A second session landed in the same tree inside the window. Naming either one would be a
  // guess, so neither is named.
  assert.deepEqual(chooseLandings([...one, { ...one[0], from: 'other', sha: 'bbb' }], from, to, 1), []);
  const slackOnly = { ...one[0], at: AT('2026-09-03T21:16:12Z') };
  assert.deepEqual(
    chooseLandings([one[0], slackOnly], from, to, 1),
    one,
    'a no-op merge beside the call borrowed a landing from the query slack',
  );
});

test('a fast-forward in the window reaches the card as a landing', async () => {
  const ff = merge();
  const one = turn({ commits: [], landingIntents: [ff] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${landingReflogArgs(ff.from).join(' ')}`]: entry('panel-ts/ui-1', LANDED),
    [`${REPO} ${subjectArgs(LANDED).join(' ')}`]: `${LANDED_SUBJECT}\n`,
  });
  let filled = 0;
  const commits = reader(runner, () => {
    filled++;
  });

  commits.apply([one], [REPO]);
  assert.equal(one.landings, undefined);
  await settle();
  assert.equal(filled, 1);

  commits.apply([one], [REPO]);
  assert.deepEqual(one.landings, [
    {
      id: `${landingKey(ff)}|${Date.parse(LANDED_AT)}|0`,
      sha: 'f338b37f',
      subject: LANDED_SUBJECT,
      from: 'panel-ts/ui-1',
      head: { kind: 'branch', name: 'main' },
      at: ff.to,
      place: null,
      dir: REPO,
      repository: { key: normalizeFsPath(COMMON), root: REPO, own: true },
      mergedBranch: 'panel-ts/ui-1',
    },
  ] as TurnLanding[]);
  // A landing is not a commit. The turn made none, so the commit row stays empty.
  assert.deepEqual(one.commits, []);
});

test('a commit in the window is a commit and not a landing', async () => {
  const sha = 'f245c68f245c68f245c68f245c68f245c68f2456';
  const quiet = intent({ dir: REPO });
  const ff = merge({ from: quiet.from, to: quiet.to });
  const one = turn({ commits: [], commitIntents: [quiet], landingIntents: [ff] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${reflogArgs(quiet.from, quiet.to).join(' ')}`]: `commit: Read commits${FIELD}${sha}`,
    [`${REPO} ${landingReflogArgs(ff.from).join(' ')}`]: `commit: Read commits${FIELD}${sha}${FIELD}${LANDED_AT}`,
    [`${REPO} ${logArgs(quiet.from, quiet.to).join(' ')}`]: record(sha, 'Read commits', '2026-09-02T04:08:19Z'),
    // The subject is there for the asking, so what keeps the commit out of the landing rows is
    // the head log's own word for it and nothing else.
    [`${REPO} ${subjectArgs(sha).join(' ')}`]: 'Read commits\n',
  });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(
    one.commits.map((c) => c.sha),
    ['f245c68f'],
  );
  assert.equal(one.landings, undefined);
});

test('two fast-forwards where the command merged once name neither', async () => {
  const ff = merge();
  const one = turn({ commits: [], landingIntents: [ff] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${landingReflogArgs(ff.from).join(' ')}`]: [
      entry('theirs', 'bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2'),
      entry('mine', LANDED),
    ].join('\n'),
    // Both subjects answer, so the count is the only thing refusing them.
    [`${REPO} ${subjectArgs(LANDED).join(' ')}`]: `${LANDED_SUBJECT}\n`,
    [`${REPO} ${subjectArgs('bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2bbbbbbb2').join(' ')}`]: 'Send item four\n',
  });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.equal(one.landings, undefined);
});

test('two questions about one window are told apart by what they ask for', () => {
  // A call can commit and merge in the same window, in the same directory, the same number of
  // times. One key for both would answer the second question with the first one's answer.
  assert.notEqual(landingKey(merge()), intentKey(merge()));
});

test('each landing keeps the branch that moved before a later checkout', async () => {
  const ff = merge();
  const one = turn({ commits: [], landingIntents: [ff] });
  const later = '2026-09-03T21:16:30+00:00';
  const moves = [
    `checkout: moving from main to release${FIELD}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${FIELD}${later}`,
    entry('topic', LANDED),
  ].join('\n');
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'release\n',
    [`${REPO} ${landingReflogArgs(ff.from).join(' ')}`]: moves,
    [`${REPO} ${subjectArgs(LANDED).join(' ')}`]: `${LANDED_SUBJECT}\n`,
  });
  const commits = reader(runner, () => {});
  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.deepEqual(
    one.landings?.[0].head,
    { kind: 'branch', name: 'main' },
    'a later checkout renamed the destination branch',
  );
});

test('separate merge invocations that reach one sha remain separate landings', async () => {
  const first = merge({ id: 'merge-1' });
  const second = merge({ id: 'merge-2' });
  const one = turn({ commits: [], landingIntents: [first, second] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${landingReflogArgs(first.from).join(' ')}`]: entry('topic', LANDED),
    [`${REPO} ${subjectArgs(LANDED).join(' ')}`]: `${LANDED_SUBJECT}\n`,
  });
  const commits = reader(runner, () => {});
  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  assert.equal(one.landings?.length, 2, 'the second merge invocation disappeared because its sha matched the first');
  assert.notEqual(one.landings?.[0].id, one.landings?.[1].id);
});

test('a historical landing survives more than 40 later head movements', async () => {
  const ff = merge();
  const one = turn({ commits: [], landingIntents: [ff] });
  const laterMoves = [
    `checkout: moving from main to release${FIELD}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${FIELD}HEAD@{2026-09-03T21:17:00+00:00}`,
    ...Array.from(
      { length: 39 },
      (_, index) =>
        `reset: moving to HEAD${FIELD}${String(index).padStart(40, '0')}${FIELD}HEAD@{2026-09-03T21:16:30+00:00}`,
    ),
  ];
  const moves = [...laterMoves, entry('topic', LANDED)].join('\n');
  const base = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'release\n',
    [`${REPO} ${subjectArgs(LANDED).join(' ')}`]: `${LANDED_SUBJECT}\n`,
  });
  const runner: GitRunner = {
    run(dir, args) {
      if (args[0] !== 'log' || args[1] !== '-g') {
        return base.run(dir, args);
      }
      const limitAt = args.indexOf('-n');
      const limit = limitAt < 0 ? laterMoves.length + 1 : Number(args[limitAt + 1]);
      return Promise.resolve(moves.split('\n').slice(0, limit).join('\n'));
    },
  };
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);

  assert.equal(one.landings?.length, 1, 'a historical fast-forward has to reach the card');
  assert.deepEqual(one.landings?.[0].head, { kind: 'branch', name: 'main' });
});

test(
  'a real fast-forward is read back with its subject and the name the command named',
  { tags: ['subprocess'] },
  async () => {
    // Run Git to check that a fast-forward writes its source name into the HEAD reflog.

    const root = tempDir('landing-');
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'First');
    git('checkout', '-q', '-b', 'topic');
    writeFileSync(join(root, 'a.txt'), 'two\n');
    git('commit', '-q', '-a', '-m', 'Bundle the panel script');
    git('checkout', '-q', 'main');

    const from = Date.now();
    git('merge', '--ff-only', 'topic');
    const to = Date.now();

    const one = turn({ commits: [], landingIntents: [{ dir: root, from, to, expected: 1 }] });
    let fill!: () => void;
    const filled = new Promise<void>((resolve) => {
      fill = resolve;
    });
    const commits = new RepositoryCommits(nodeGitRunner(), fill);
    commits.apply([one], [root]);
    await filled;
    commits.apply([one], [root]);

    assert.equal(one.landings?.length, 1, 'a real fast-forward has to reach the card');
    assert.equal(one.landings?.[0].subject, 'Bundle the panel script');
    assert.equal(one.landings?.[0].from, 'topic');
    assert.deepEqual(one.landings?.[0].head, { kind: 'branch', name: 'main' });
    const landed = one.landings![0];
    const exact = await nodeGitRunner(0).run(root, exactCommitArgs(landed.sha));
    assert.ok(exact);
    assert.deepEqual(
      parseCommitLog(exact).map(({ sha, subject, files, added, removed }) => ({
        sha: sha.slice(0, landed.sha.length),
        subject,
        files,
        added,
        removed,
      })),
      [{ sha: landed.sha, subject: landed.subject, files: 1, added: 1, removed: 1 }],
    );
    assert.match(parseCommitLog(exact)[0].sha, /^[0-9a-f]{40}$/);
  },
);

test('a landing keeps the branch its merge named, and a hash is answered by the branches at the commit', () => {
  assert.deepEqual(pointsAtArgs('c36e7b5b'), [
    'for-each-ref',
    '--points-at',
    'c36e7b5b',
    '--format=%(refname:short)',
    'refs/heads',
  ]);
  const main = { kind: 'branch', name: 'main' } as const;
  // A ref name is the branch, whatever the branches say, and git is asked nothing.
  assert.equal(mergedBranchOf('topic', null, main), 'topic');
  // Git prints a sha in lower case, so an upper-case all-hex word is a branch name.
  assert.equal(mergedBranchOf('DEADBEEFCAFE', null, main), 'DEADBEEFCAFE');
  // A hash takes the first branch at the commit that is not the branch the merge moved, which
  // points at the commit too once it has moved.
  assert.equal(
    mergedBranchOf('c36e7b5b', 'main\nship/commit-record-repairs\nlater\n', main),
    'ship/commit-record-repairs',
  );
  assert.equal(mergedBranchOf('c36e7b5b', 'main\n', main), null);
  assert.equal(mergedBranchOf('c36e7b5b', null, main), null);
});

test('a repository nested inside the open folder heads its commits by its own name', async () => {
  const nested = `${REPO}/.claude/plans`;
  const made = (sha: string, dir: string): TurnCommit => ({
    sha,
    subject: 'Record the plan',
    head: { kind: 'branch', name: 'main' },
    files: 1,
    added: 3,
    removed: 0,
    at: AT('2026-09-02T04:08:19Z'),
    place: null,
    dir,
  });
  const one = turn({ commits: [made('5c8e9415', nested), made('302bd763', REPO)] });
  const runner = fakeRunner({
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${nested} ${IDENTITY}`]: `${nested}/.git\n${nested}/.git\n${nested}\n`,
  });
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  // Both trees sit inside the open folder, so neither names a place of its own. Only the
  // repository key tells the nested one apart.
  assert.deepEqual(
    one.commits.map((commit) => commit.place),
    [null, null],
  );
  const repositories = one.commits.map((commit) => commitCard(commit, Date.now(), null, null, [REPO]).repository);
  assert.deepEqual(
    repositories.map((repository) => [repository?.name, repository?.own]),
    [
      ['.claude/plans', false],
      ['arc', true],
    ],
  );
});

test('a failed read of the branches at a merged hash is asked again', async () => {
  const ff = merge();
  const one = turn({ commits: [], landingIntents: [ff] });
  const pointsAt = `${REPO} ${pointsAtArgs(LANDED).join(' ')}`;
  const answers: Record<string, string | null> = {
    [`${REPO} ${IDENTITY}`]: `${COMMON}\n${COMMON}\n${REPO}\n`,
    [`${REPO} ${BRANCH}`]: 'main\n',
    [`${REPO} ${landingReflogArgs(ff.from).join(' ')}`]: entry('c36e7b5b', LANDED),
    [`${REPO} ${subjectArgs(LANDED).join(' ')}`]: `${LANDED_SUBJECT}\n`,
    [pointsAt]: null,
  };
  const runner = fakeRunner(answers);
  const commits = reader(runner, () => {});

  commits.apply([one], [REPO]);
  await settle();
  commits.apply([one], [REPO]);
  // A read that failed says nothing about the branch, so the landing waits for the next one.
  assert.equal(one.landings, undefined);
  answers[pointsAt] = 'panel-ts/ui-1\nmain\n';
  await settle();
  commits.apply([one], [REPO]);
  assert.equal(asks(runner, REPO, pointsAtArgs(LANDED).join(' ')), 2);
  assert.deepEqual(
    one.landings?.map((landing) => landing.mergedBranch),
    ['panel-ts/ui-1'],
  );
});

const candidateSha = 'abc1234a' + '1'.repeat(32);

test('candidate Git fixture rejects malformed requests and objects absent from the repository', async () => {
  const otherSha = 'def4567b' + '2'.repeat(32);
  const runner = candidateRunner({
    'c:/notes': { sha: candidateSha },
    'c:/plans': { sha: otherSha },
    'c:/empty': null,
  });
  assert.equal(await runner.run('C:/notes', [...IDENTITY_ARGS]), 'c:/notes/.git\nc:/notes/.git\nC:/notes\n');
  assert.equal(await runner.run('C:/notes', ['rev-parse', '--disambiguate=abc1234a']), candidateSha);
  const object = await runner.run('C:/notes', exactCommitArgs(candidateSha));
  assert.equal(parseCommitLog(object!)[0].sha, candidateSha);
  for (const args of [
    ['rev-parse', '--disambiguate=abc1234a', '--verify'],
    ['rev-parse', '--verify'],
    ['rev-parse', 'HEAD'],
    ['rev-parse', '--git-common-dir'],
    [...IDENTITY_ARGS, '--verify'],
    ['rev-parse', '--disambiguate=not-a-hash'],
    ['rev-parse', '--disambiguate=abc'],
    ['show', candidateSha],
    [...exactCommitArgs(candidateSha), '--verify'],
    exactCommitArgs(otherSha),
  ])
    assert.equal(await runner.run('C:/notes', args), null, args.join(' '));
  assert.equal(await runner.run('C:/plans', ['rev-parse', '--disambiguate=abc1234a']), '');
  assert.equal(await runner.run('C:/empty', ['rev-parse', '--disambiguate=abc1234a']), '');
  assert.equal(await runner.run('C:/plans', exactCommitArgs(candidateSha)), null);
  assert.equal(await runner.run('C:/missing', [...IDENTITY_ARGS]), null);
});

function candidateTurn(command = 'git -C C:/notes commit -m first; git -C C:/plans commit -m second') {
  const one = turn({ commits: [] });
  recordCommits(one, '[main abc1234a] Printed subject\n 1 file changed, 2 insertions(+)', 1, {
    command,
    cwd: 'C:/repo',
    shell: 'bash',
    at: 0,
  });
  return one;
}

test('candidate exact lookup resolves each printed hash without changing recorded metadata', async () => {
  const one = candidateTurn();
  const original = { ...one.commits[0] };
  const reads: string[] = [];
  const commits = reader(
    candidateRunner({ 'c:/repo': null, 'c:/plans': null, 'c:/notes': { sha: candidateSha } }, reads),
    () => {},
  );
  commits.apply([one], ['C:/repo']);
  commits.apply([one], ['C:/repo']);
  await settle();
  commits.apply([one], ['C:/repo']);
  assert.equal(one.commits[0].dir, 'c:/notes');
  assert.deepEqual(
    [one.commits[0].subject, one.commits[0].at, one.commits[0].added],
    [original.subject, original.at, original.added],
  );
  assert.equal(reads.filter((s) => s.includes('--disambiguate=')).length, 3);
});

test('full identities from native child JSON resolve separate roots and preserve recorded child details', async () => {
  const hashes = [candidateSha, 'def4567' + '2'.repeat(33)];
  const directory = tempDir('native-commit-candidates-');
  const file = join(directory, 'child.jsonl');
  const records: object[] = [
    {
      type: 'session_meta',
      timestamp: '2026-09-02T04:00:00Z',
      payload: { id: 'child', session_id: 'child', thread_source: 'subagent', parent_thread_id: 'parent', cwd: REPO },
    },
    { type: 'event_msg', timestamp: '2026-09-02T04:00:01Z', payload: { type: 'task_started', turn_id: 'child-turn' } },
    {
      type: 'turn_context',
      timestamp: '2026-09-02T04:00:01Z',
      payload: { turn_id: 'child-turn', current_date: '2026-09-02' },
    },
    {
      type: 'event_msg',
      timestamp: '2026-09-02T04:00:02Z',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          command: 'python loop.py',
          status: 'completed',
          exit_code: 0,
          stdout: hashes
            .map((sha, index) => `[topic ${sha.slice(0, 7)}] Recorded ${index}\n 1 file changed, 2 insertions(+)`)
            .join('\n'),
        },
      },
    },
    {
      type: 'event_msg',
      timestamp: '2026-09-02T04:00:03Z',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          command: 'python report.py',
          status: 'completed',
          exit_code: 0,
          stdout: JSON.stringify({
            candidates: {
              first: { sha: hashes[0], repository: 'C:/notes' },
              second: { sha: hashes[1], repository: 'C:/plans' },
            },
          }),
        },
      },
    },
  ];
  records.splice(2, 0, {
    type: 'event_msg',
    timestamp: '2026-09-02T04:00:01Z',
    payload: { type: 'user_message', message: 'Commit both roots' },
  });
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  writeFileSync(
    file,
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-09-02T04:00:04Z',
      payload: { type: 'task_complete', turn_id: 'child-turn' },
    }) + '\n',
    { flag: 'a' },
  );
  const spend = readCodexAgentSpend(file);
  assert.equal(spend.commits?.length, 2);
  const one = turn({ commits: spend.commits! });
  assert.deepEqual(
    one.commits.map((commit) => commit.dir),
    [null, null],
  );
  const original = one.commits.map(({ subject, at, files, added }) => ({ subject, at, files, added }));
  for (const commit of one.commits) commit.candidates!.complete = true;
  const resolver = reader(
    candidateRunner({ 'c:/notes': { sha: hashes[0] }, 'c:/plans': { sha: hashes[1] }, [normalizeFsPath(REPO)]: null }),
    () => {},
  );
  resolver.apply([one], [REPO]);
  await settle();
  resolver.apply([one], [REPO]);
  assert.deepEqual(
    one.commits.map((commit) => commit.dir),
    ['c:/notes', 'c:/plans'],
  );
  const cards = one.commits.map((commit) => commitCard(commit, 1, 'Worker', 'child', [REPO]));
  assert.deepEqual(
    cards.map((card) => card.objectSha),
    hashes,
  );
  assert.deepEqual(
    cards.map((card) => card.madeBySession),
    ['child', 'child'],
  );
  assert.deepEqual(
    one.commits.map(({ subject, at, files, added }) => ({ subject, at, files, added })),
    original,
  );
});

test('candidate exact lookup refuses collisions, clones and inconclusive reads', async () => {
  for (const matches of [
    {
      'c:/repo': null,
      'c:/plans': { sha: candidateSha.slice(0, 8) + '2'.repeat(32) },
      'c:/notes': { sha: candidateSha },
    },
    { 'c:/repo': null, 'c:/plans': { sha: candidateSha }, 'c:/notes': { sha: candidateSha } },
    { 'c:/repo': null, 'c:/notes': { sha: candidateSha } },
  ]) {
    const one = candidateTurn();
    const reads: string[] = [];
    const commits = reader(candidateRunner(matches, reads), () => {});
    for (let i = 0; i < 8; i++) {
      commits.apply([one], ['C:/repo']);
      await settle();
    }
    assert.equal(one.commits[0].dir, null);
    assert.ok(reads.filter((s) => s.endsWith('--disambiguate=abc1234a')).length <= 9);
  }
  const shared = candidateTurn();
  const commits = reader(
    candidateRunner({
      'c:/repo': null,
      'c:/notes': { sha: candidateSha, common: 'c:/common/.git' },
      'c:/plans': { sha: candidateSha, common: 'c:/common/.git' },
    }),
    () => {},
  );
  commits.apply([shared], ['C:/repo']);
  await settle();
  commits.apply([shared], ['C:/repo']);
  assert.ok(shared.commits[0].dir);
});

test('candidate exact answers and exhausted retries follow new candidate evidence', async () => {
  const first = candidateTurn();
  const second = candidateTurn('git -C C:/other commit -m second; git -C C:/plans commit -m third');
  const reads: string[] = [];
  const commits = reader(
    candidateRunner({ 'c:/repo': null, 'c:/plans': null, 'c:/notes': { sha: candidateSha }, 'c:/other': null }, reads),
    () => {},
  );
  commits.apply([first, second], ['C:/repo']);
  await settle();
  commits.apply([first, second], ['C:/repo']);
  await settle();
  assert.ok(first.commits[0].dir);
  assert.equal(second.commits[0].dir, null);
  second.commits[0].candidates!.dirs.push('C:/notes');
  commits.apply([second], ['C:/repo']);
  await settle();
  commits.apply([second], ['C:/repo']);
  assert.ok(second.commits[0].dir);
});

test('incomplete nested evidence refuses hidden competing matches and unrelated workspace objects', async () => {
  let deep = 'git -C C:/hidden commit -m hidden';
  for (let i = 0; i < 6; i++) deep = `bash -c ${JSON.stringify(deep)}`;
  const commands = [
    `git -C C:/notes commit -m shown; ${deep}`,
    Array.from({ length: 33 }, (_, i) => `git -C C:/r${i} commit -m x`).join('; '),
    'cd $unknown; git commit -m x',
  ];
  for (const command of commands) {
    assert.equal(inspectCommitCommand(command, 'C:/repo', 'bash').complete, false);
    const one = candidateTurn(command);
    const reads: string[] = [];
    const commits = reader(
      candidateRunner(
        {
          'c:/repo': { sha: candidateSha },
          'c:/notes': { sha: candidateSha },
          'c:/hidden': { sha: candidateSha },
          'c:/r32': { sha: candidateSha },
        },
        reads,
      ),
      () => {},
    );
    commits.apply([one], ['C:/repo']);
    await settle();
    commits.apply([one], ['C:/repo']);
    assert.equal(one.commits[0].dir, null);
    assert.equal(reads.filter((s) => s.includes('--disambiguate')).length, 0);
  }
});

test('a resolved candidate row keeps its group while its answer is asked again, and loses it once the answer fails', async () => {
  const one = candidateTurn();
  const matches: Record<string, { sha: string } | null | undefined> = {
    'c:/repo': null,
    'c:/notes': { sha: candidateSha },
    'c:/plans': null,
  };
  const commits = reader(candidateRunner(matches), () => {});
  commits.apply([one], ['C:/repo']);
  await settle();
  commits.apply([one], ['C:/repo']);
  const grouped = one.commits[0].repository;
  assert.equal(one.commits[0].dir, 'c:/notes');
  assert.ok(grouped);
  // The held answer goes away and the repository no longer names the commit.
  commits['exactAnswers'].clear();
  matches['c:/notes'] = null;
  commits.apply([one], ['C:/repo']);
  assert.equal(one.commits[0].dir, null);
  assert.deepEqual(one.commits[0].repository, grouped);
  for (let i = 0; i < 8 && one.commits[0].repository; i++) {
    await settle();
    commits.apply([one], ['C:/repo']);
    assert.equal(one.commits[0].dir, null);
  }
  assert.equal(one.commits[0].repository, null);
  assert.equal(one.commits[0].place, null);
});

test('retained candidate rows clear navigation when current evidence has no exact answer', async () => {
  for (const state of ['clone', 'incomplete', 'failed']) {
    const one = candidateTurn();
    const matches: Record<string, { sha: string } | null | undefined> = {
      'c:/repo': null,
      'c:/notes': { sha: candidateSha },
      'c:/plans': null,
    };
    let updates = 0;
    const commits = reader(candidateRunner(matches), () => {
      updates++;
    });
    commits.apply([one], ['C:/repo']);
    await settle();
    commits.apply([one], ['C:/repo']);
    assert.equal(one.commits[0].dir, 'c:/notes', state);
    assert.ok(one.commits[0].place, state);
    assert.ok(one.commits[0].repository, state);
    if (state === 'incomplete') one.commits[0].candidates!.complete = false;
    else {
      one.commits[0].candidates!.dirs.push('C:/clone');
      if (state === 'clone') matches['c:/clone'] = { sha: candidateSha };
    }
    const fresh = candidateTurn();
    fresh.commits[0].candidates = structuredClone(one.commits[0].candidates);
    const before = updates;
    const navigation = (row: typeof one) => [
      row.commits[0].dir,
      row.commits[0].place ?? null,
      row.commits[0].repository ?? null,
    ];
    commits.apply([one, fresh], ['C:/repo']);
    assert.deepEqual(navigation(one), [null, null, null], `${state} pending`);
    assert.equal(updates, before + 1, `${state} clearing must request an update`);
    commits.apply([one, fresh], ['C:/repo']);
    assert.equal(updates, before + 1, `${state} repeated clearing must remain idle`);
    for (let i = 0; i < 8; i++) {
      await settle();
      commits.apply([one, fresh], ['C:/repo']);
      assert.deepEqual(navigation(one), [null, null, null], `${state} settled or exhausted`);
      assert.deepEqual(navigation(one), navigation(fresh), `${state} retained and fresh`);
    }
  }
});

test('a removed commit directory opens in its containing repository only when that repository holds exactly one commit for the hash', async () => {
  const full = 'bc0f4d30127f4f5f5b04db0a128bc1d5654fbb8c';
  const root = tempDir('arc-navigable-');
  const notes = join(root, 'notes');
  const clone = join(root, 'clone');
  const live = join(root, 'live');
  for (const dir of [notes, clone, live]) mkdirSync(dir);
  const removed = join(notes, 'worktrees', 'finished');
  const plain = join(root, 'plain', 'gone');
  mkdirSync(join(root, 'plain'));
  const reads: string[] = [];
  let matches: Record<string, { sha: string } | null> = {
    [normalizeFsPath(notes)]: { sha: full },
    [normalizeFsPath(clone)]: { sha: full },
  };
  let collision = false;
  const base = (): GitRunner => candidateRunner(matches, reads);
  const commits = reader(
    {
      run: (dir, args) =>
        collision && args[1]?.startsWith('--disambiguate=')
          ? Promise.resolve(`${full}\n${full.slice(0, 8)}${'0'.repeat(32)}\n`)
          : base().run(dir, args),
    },
    () => {},
  );
  // The nearest existing ancestor resolves to the containing repository, and a short hash returns its full identity.
  assert.deepEqual(await commits.navigable(removed, full.slice(0, 8)), { dir: notes, sha: full });
  assert.deepEqual(await commits.navigable(removed, full), { dir: notes, sha: full });
  // A short hash that names more than one object opens nothing.
  collision = true;
  assert.equal(await commits.navigable(removed, full.slice(0, 8)), null);
  collision = false;
  // A containing repository without the commit opens nothing.
  matches = { [normalizeFsPath(notes)]: { sha: 'e'.repeat(40) }, [normalizeFsPath(clone)]: { sha: full } };
  assert.equal(await commits.navigable(removed, full.slice(0, 8)), null);
  // An ancestor outside any repository opens nothing, and the clone that holds the commit is never asked.
  reads.length = 0;
  assert.equal(await commits.navigable(plain, full.slice(0, 8)), null);
  assert.ok(
    reads.every((read) => !read.startsWith(normalizeFsPath(clone))),
    reads.join('\n'),
  );
  // An existing directory waits for this reader's identity read, and an exhausted read opens nothing.
  matches = { [normalizeFsPath(live)]: { sha: full } };
  const printed: TurnCommit = {
    sha: full.slice(0, 8),
    subject: 's',
    head: null,
    files: null,
    added: null,
    removed: null,
    at: 1,
    place: null,
    dir: live,
  };
  const one = turn({ commits: [printed] });
  assert.equal(await commits.navigable(live, full.slice(0, 8)), null);
  commits.apply([one], []);
  await settle();
  assert.deepEqual(await commits.navigable(live, full.slice(0, 8)), { dir: live, sha: full.slice(0, 8) });
  const silent = reader(candidateRunner({}), () => {});
  for (let i = 0; i < 4; i++) {
    silent.apply([one], []);
    await settle();
  }
  assert.equal(await silent.navigable(live, full.slice(0, 8)), null);
  assert.equal(printed.dir, live);
});

test('a registered repository root matches the verified folder exactly, with each platform case rule', () => {
  const unread = (): string => {
    throw new Error('ENOENT');
  };
  for (const [platform, registered, verified, same] of [
    ['win32', 'C:\\Users\\Dev\\Repo', 'c:/users/dev/repo', true],
    ['darwin', 'C:\\Users\\Dev\\Repo', 'c:/users/dev/repo', true],
    ['linux', 'C:\\Users\\Dev\\Repo', 'c:/users/dev/repo', true],
    ['win32', '/Users/Dev/Repo', '/users/dev/repo', true],
    ['darwin', '/Users/Dev/Repo', '/users/dev/repo', false],
    ['linux', '/Users/Dev/Repo', '/users/dev/repo', false],
    ['linux', '/Users/Dev/Repo/', '/Users/Dev/Repo', true],
    ['linux', '/', '/', true],
    ['win32', 'C:\\Users\\Dev', 'C:/Users/Dev/Repo', false],
    ['darwin', '/Users/Dev', '/Users/Dev/Repo', false],
    ['linux', '/Users/Dev', '/Users/Dev/Repo', false],
  ] as const)
    assert.equal(
      sameRepositoryRoot(registered, verified, platform, unread),
      same,
      `${platform} ${registered} ${verified}`,
    );
});

test('a registered repository root matches by physical directory, and distinct directories that differ only in case refuse', () => {
  const physical: Record<string, string> = {
    '/Repos/Notes': '/Repos/Notes',
    '/Repos/notes': '/Repos/notes',
    '/Links/Notes': '/Repos/Notes',
    '/Links/Repos': '/Repos',
    'C:/Links/Notes': 'C:/Repos/Notes',
    'C:/Repos/Notes': 'C:/Repos/Notes',
    'c:/repos/notes': 'c:/repos/notes',
  };
  const realpath = (target: string): string => {
    if (!(target in physical)) throw new Error('ENOENT');
    return physical[target];
  };
  for (const [platform, registered, verified, same] of [
    ['darwin', '/Repos/Notes', '/Repos/notes', false],
    ['linux', '/Repos/Notes', '/Repos/notes', false],
    ['darwin', '/Links/Notes', '/Repos/Notes', true],
    ['linux', '/Links/Notes', '/Repos/Notes', true],
    ['darwin', '/Links/Repos', '/Repos/Notes', false],
    ['win32', 'C:/Links/Notes', 'c:/repos/notes', true],
    ['win32', 'C:/Links/Notes', 'C:/Repos/Notes', true],
    ['win32', 'c:/links/notes', 'C:/Repos/Notes', false],
  ] as const)
    assert.equal(
      sameRepositoryRoot(registered, verified, platform, realpath),
      same,
      `${platform} ${registered} ${verified}`,
    );
});

test('a short commit header takes the one full hash a commit line in the same output prints for it', () => {
  const full = 'bc0f4d30127f4f5f5b04db0a128bc1d5654fbb8c';
  const header = `[review/x ${full.slice(0, 8)}] subject\n 1 file changed, 1 insertion(+)\n`;
  const recorded = (stdout: string) => {
    const one = turn({ commits: [] });
    recordCommits(one, stdout, 1, 'unreadable', [], 'C:/repo');
    return one.commits;
  };
  assert.equal(recorded(`${header}commit ${full} (HEAD -> review/x)\nAuthor: Dev\n`)[0].fullSha, full);
  assert.equal(recorded(`${header}commit ${'c'.repeat(40)}\n`)[0].fullSha, undefined);
  assert.equal(
    recorded(`${header}commit ${full}\ncommit ${full.slice(0, 8)}${'0'.repeat(32)}\n`)[0].fullSha,
    undefined,
  );
  assert.equal(recorded(header)[0].fullSha, undefined);
});
