import assert from 'node:assert';
import { test } from 'vitest';
import {
  commitGroupName,
  commitHeadFact,
  groupCommitRows,
  repositoryWorkFigures,
  repositoryWorkLabel,
  type GroupableCommitRow,
} from './card-presentation.ts';

const OWN = { key: 'c:/repo/.git', name: 'repo', own: true };
const PLANS = { key: 'c:/repo/.claude/plans/.git', name: '.claude/plans', own: false };

const commit = (sha: string, at: number, over: Partial<GroupableCommitRow> = {}): GroupableCommitRow => ({
  kind: 'commit',
  sha,
  subject: `Write ${sha}`,
  at,
  absolute: `${at}`,
  where: null,
  repository: OWN,
  branch: 'main',
  headKind: 'branch',
  ...over,
});

const landing = (
  sha: string,
  at: number,
  mergedBranch: string | null,
  over: Partial<GroupableCommitRow> = {},
): GroupableCommitRow => ({
  ...commit(sha, at),
  kind: 'landing',
  mergedBranch,
  landingTarget: 'main',
  ...over,
});

// The owner's turn: one commit on a topic branch that then merged into main, and one commit on
// main in a nested repository.
const OWNER_TURN = [
  commit('184751b0', 1, { branch: 'ship/commit-record-repairs' }),
  commit('5e0c1d2a', 2, { repository: PLANS }),
  landing('c36e7b5b', 3, 'ship/commit-record-repairs'),
];

test("a landing whose branch holds a commit of the turn is that group's arrival, not a row", () => {
  const grouping = groupCommitRows(OWNER_TURN);
  assert.equal(grouping.single, false);
  assert.deepEqual(
    grouping.groups.map((group) => [group.branch, group.repository.name, group.rows.map((row) => row.sha)]),
    [
      ['ship/commit-record-repairs', 'repo', ['184751b0']],
      ['main', '.claude/plans', ['5e0c1d2a']],
    ],
  );
  assert.deepEqual(grouping.groups[0].arrival, {
    at: 3,
    absolute: '3',
    sha: 'c36e7b5b',
    subject: 'Write c36e7b5b',
    target: 'main',
    sameAsLast: false,
  });
  assert.equal(grouping.groups[1].arrival, null);
});

test("groups of the card's own repository lead, whichever repository committed first", () => {
  const OTHER = { key: 'c:/repo/other/.git', name: 'other', own: false };
  const grouping = groupCommitRows([
    commit('1111aaa', 1, { repository: PLANS, branch: 'main' }),
    commit('2222bbb', 2, { repository: OTHER, branch: 'main' }),
    commit('3333ccc', 5, { branch: 'topic' }),
    commit('4444ddd', 4, { branch: 'main' }),
  ]);
  assert.deepEqual(
    grouping.groups.map((group) => [group.repository.name, group.rows.map((row) => row.sha)]),
    [
      // The card's repository sorts first, even when its commits follow the other repositories' commits.
      ['repo', ['4444ddd']],
      ['repo', ['3333ccc']],
      // Other repositories follow by earliest commit. Each repository keeps its groups together.
      ['.claude/plans', ['1111aaa']],
      ['other', ['2222bbb']],
    ],
  );
});

test('a landing no branch explains is a row under the branch that moved', () => {
  const grouping = groupCommitRows([OWNER_TURN[0], OWNER_TURN[1], landing('c36e7b5b', 3, null)]);
  assert.deepEqual(
    grouping.groups.map((group) => [group.repository.own, group.branch, group.rows.map((row) => row.sha)]),
    [
      // The card's repository keeps both groups first, despite the nested repository's intervening commit.
      [true, 'ship/commit-record-repairs', ['184751b0']],
      [true, 'main', ['c36e7b5b']],
      [false, 'main', ['5e0c1d2a']],
    ],
  );
  assert.ok(grouping.groups.every((group) => group.arrival === null));
  // A landing without a matching commit group remains a row.
  const stranger = groupCommitRows([landing('c36e7b5b', 3, 'topic')]);
  assert.equal(stranger.single, true);
  assert.deepEqual(
    stranger.groups[0].rows.map((row) => row.sha),
    ['c36e7b5b'],
  );
  assert.equal(commitHeadFact(stranger.groups[0]), '· on main');
});

test('detached commits group apart, groups follow their first row, and one group is single', () => {
  const grouping = groupCommitRows([
    commit('bbbb222', 5, { branch: 'topic' }),
    commit('aaaa111', 2, { branch: null, headKind: 'detached' }),
    commit('cccc333', 4, { branch: 'topic' }),
  ]);
  assert.deepEqual(
    grouping.groups.map((group) => [group.branch, group.rows.map((row) => row.sha)]),
    [
      [null, ['aaaa111']],
      ['topic', ['cccc333', 'bbbb222']],
    ],
  );
  assert.equal(grouping.single, false);
  const one = groupCommitRows([commit('cccc333', 4, { branch: 'fix/rail-pin', where: 'in worktree rail-review' })]);
  assert.equal(one.single, true);
  assert.equal(commitHeadFact(one.groups[0]), '· on fix/rail-pin\u00a0· in worktree rail-review');
  const merged = groupCommitRows([commit('cccc333', 4, { branch: 'topic' }), landing('cccc333', 5, 'topic')]);
  assert.equal(merged.single, true);
  assert.equal(merged.groups[0].arrival?.sameAsLast, true);
  assert.equal(commitHeadFact(merged.groups[0]), '· on topic');
  const foreign = groupCommitRows([commit('dddd444', 1, { repository: PLANS })]);
  assert.equal(commitHeadFact(foreign.groups[0]), '· on .claude/plans\u00a0· main');
});

test('a commit whose head git never named files apart from the detached commits', () => {
  const unknown = commit('eeee555', 1, { branch: null, headKind: null });
  const detached = commit('ffff666', 2, { branch: null, headKind: 'detached' });
  const grouping = groupCommitRows([unknown, detached]);
  assert.deepEqual(
    grouping.groups.map((group) => [commitGroupName(group), group.rows.map((row) => row.sha)]),
    [
      ['unknown branch', ['eeee555']],
      ['detached commit', ['ffff666']],
    ],
  );
  assert.equal(commitHeadFact(groupCommitRows([unknown]).groups[0]), '· unknown branch');
});

test('a row git has not placed joins its branch in the open folder repository', () => {
  const unplaced = commit('abab777', 2, { repository: null });
  const grouping = groupCommitRows([commit('cdcd888', 1), unplaced]);
  assert.equal(grouping.single, true, 'an unplaced row drew a second main heading beside the real one');
  assert.deepEqual(
    grouping.groups[0].rows.map((row) => row.sha),
    ['cdcd888', 'abab777'],
  );
  // A landing git has not placed arrives on its branch the same way.
  const arrived = groupCommitRows([
    commit('1111aaa', 1, { branch: 'topic' }),
    landing('2222bbb', 2, 'topic', { repository: null }),
  ]);
  assert.equal(arrived.groups[0].arrival?.sha, '2222bbb');
  // Alone, it still files under the open folder's repository.
  assert.deepEqual(groupCommitRows([unplaced]).groups[0].repository, { name: '', own: true });
});

test('the Commits heading counts keep every "·" on the line of the word before it', () => {
  assert.equal(repositoryWorkLabel(1, 1), '1 commit\u00a0· 1 merged');
  assert.equal(repositoryWorkLabel(3, 0), '3 commits');
  assert.equal(repositoryWorkFigures(12, 3), '12\u00a0· 3 merged');
  assert.equal(repositoryWorkFigures(0, 2), '2 merged');
});
