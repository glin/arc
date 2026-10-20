// extension/src/gitcommits.test.ts
//
// Parser fixtures cover Git log, repository identity, and HEAD reflog output.

import { test } from 'vitest';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
} from './gitcommits.ts';
import { candidateGitRunner as candidateRunner, turn } from './turnfixtures.ts';
import { commitCard } from './turncard.ts';
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
  assert.deepEqual(spend.commitIntents, [quiet]);
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
