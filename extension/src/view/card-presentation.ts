import { sameCommitSha } from '../domain/commit-sha.ts';

export const CARD_GLYPHS = {
  done: '\u2713',
  failed: '\u2715',
  interrupted: '\u25A0',
  running: '\u25CF',
  stopped: '\u2298',
  compaction: '\u25CC',
  disclosureClosed: '\u25B8',
  disclosureOpen: '\u25BE',
} as const;

export const CONTEXT_CLASSES: Readonly<Record<string, string>> = {
  filling: 'ctx-filling',
  gettingFull: 'ctx-getting-full',
  nearlyFull: 'ctx-nearly-full',
};

export function contextClass(level: string | undefined): string {
  return level ? CONTEXT_CLASSES[level] || '' : '';
}

export const CARD_CONTENT_FIELDS: readonly string[] = [
  'kind',
  'key',
  'sessionId',
  'status',
  'statusWord',
  'agent',
  'model',
  'effort',
  'headline',
  'headlineHtml',
  'prompt',
  'delegation',
  'promptHeading',
  'promptNotice',
  'summary',
  'summaryHtml',
  'earlierAnswers',
  'laterPrompts',
  'sessionTitle',
  'saidMessages',
  'saidName',
  'saidMix',
  'files',
  'fileCount',
  'added',
  'removed',
  'chips',
  'marks',
  'live',
  'startedAt',
  'endedAt',
  'at',
  'toolMix',
  'agents',
  'dispatched',
  'commits',
  'errorText',
  'toolTally',
  'activityToolCategories',
  'activitySkills',
  'activitySkillCount',
  'activitySkillLabel',
  'activity',
  'activityCount',
  'activityWord',
  'activityName',
  'activityCounts',
  'activityTools',
  'doing',
  'doingCode',
  'doingSince',
  'durationWord',
];

type ContentRow = Record<string, unknown> & { steps?: ContentRow[] };

export function cardPrint(card: object): string {
  const logContent = ({
    absolute: _absolute,
    spoken: _spoken,
    hintDetail: _hintDetail,
    steps,
    ...row
  }: ContentRow): object => ({
    ...row,
    ...(steps ? { steps: steps.map(logContent) } : {}),
  });
  const record = card as Record<string, unknown>;
  return JSON.stringify(
    CARD_CONTENT_FIELDS.map((field) => {
      const value = record[field];
      if (field === 'activity' && Array.isArray(value)) {
        return (value as ContentRow[]).map(logContent);
      }
      if (field === 'earlierAnswers' && Array.isArray(value)) {
        return (value as Record<string, unknown>[]).map((answer) => ({
          summary: answer.summary,
          at: answer.at,
          summaryHtml: answer.summaryHtml,
        }));
      }
      if (field === 'saidMessages' && Array.isArray(value)) {
        return (value as Record<string, unknown>[]).map((message) => ({
          id: message.id,
          kind: message.kind,
          at: message.at,
          text: message.text,
          summaryHtml: message.summaryHtml,
          when: message.when,
          answerIndex: message.answerIndex,
        }));
      }
      if (field === 'commits' && Array.isArray(value)) {
        return (value as Record<string, unknown>[]).map(({ absolute: _absolute, ...commit }) => commit);
      }
      if (field === 'laterPrompts' && Array.isArray(value)) {
        return (value as Record<string, unknown>[]).map((prompt) => ({
          text: prompt.text,
          when: prompt.when,
          label: prompt.label,
        }));
      }
      return value;
    }),
  );
}

// Count written commits and landings separately. A landing carries work the turn did not write.
// The commits chip and its popover use this label. The Commits heading uses repositoryWorkFigures for the same counts.
export function repositoryWorkLabel(commits: number, landings: number): string {
  return [commits ? `${commits} commit${commits === 1 ? '' : 's'}` : null, landingFigure(landings)]
    .filter(Boolean)
    .join(' · ');
}

// The Commits heading supplies the commit label, so its count needs only a number. Landings retain their own label.
export function repositoryWorkFigures(commits: number, landings: number): string {
  return [commits ? String(commits) : null, landingFigure(landings)].filter(Boolean).join(' · ');
}

function landingFigure(landings: number): string | null {
  return landings ? `${landings} merged` : null;
}

// The hint on a commit row's maker name, which opens the subagent's session.
export function openMakerSession(name: string): string {
  return `Open ${name} session`;
}

// Shared grouping fields for card commit rows and message-boundary commit rows.
export interface GroupableCommitRow {
  kind: 'commit' | 'landing';
  sha: string;
  subject: string;
  at: number;
  absolute: string;
  where: string | null;
  repository: { key: string; name: string; own: boolean } | null;
  branch: string | null;
  headKind: 'branch' | 'detached' | null;
  mergedBranch?: string | null;
  landingTarget?: string;
}

export interface CommitArrival {
  at: number;
  absolute: string;
  sha: string;
  subject: string;
  target: string;
  // The merge moved the target onto the branch's own last commit, rather than onto a commit
  // holding the same work under a new hash.
  sameAsLast: boolean;
}

export interface CommitGroupView<Row extends GroupableCommitRow = GroupableCommitRow> {
  key: string;
  repository: { name: string; own: boolean };
  branch: string | null; // Null for detached commits and commits with unknown branch state.
  detached: boolean; // True only when Git identifies a detached head.
  where: string | null; // The worktree label, when different from the branch name.
  rows: Row[]; // Commits and landings not stored as arrivals, in time order.
  arrival: CommitArrival | null;
}

export interface CommitGrouping<Row extends GroupableCommitRow = GroupableCommitRow> {
  single: boolean;
  groups: CommitGroupView<Row>[];
}

// Group commit rows by repository and branch. Detached commits and commits with unknown branch state form separate groups.
// The first matching landing becomes a group's arrival when its merged branch holds a commit from this turn. Other landings remain rows.
// The card's repository sorts first. Other repositories sort by their earliest row, with each repository's groups kept together.
// Groups and their rows sort by time.
// Rows without a repository use the card's repository key, including its branch groups.
export function groupCommitRows<Row extends GroupableCommitRow>(rows: readonly Row[]): CommitGrouping<Row> {
  const ownKey = rows.find((row) => row.repository?.own)?.repository?.key ?? '';
  const repositoryKey = (row: Row) => row.repository?.key ?? ownKey;
  const groups = new Map<string, CommitGroupView<Row>>();
  const groupFor = (row: Row, head: 'branch' | 'detached' | null, branch: string | null): CommitGroupView<Row> => {
    const key = `${repositoryKey(row)}|${head === 'branch' ? branch : head === 'detached' ? 'detached' : 'unknown'}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        repository: { name: row.repository?.name ?? '', own: row.repository?.own ?? true },
        branch: head === 'branch' ? branch : null,
        detached: head === 'detached',
        where: row.repository && !row.repository.own ? null : row.where,
        rows: [],
        arrival: null,
      };
      groups.set(key, group);
    }
    return group;
  };
  const byTime = [...rows].sort((a, b) => a.at - b.at);
  for (const row of byTime) {
    if (row.kind !== 'commit') {
      continue;
    }
    groupFor(row, row.headKind, row.branch).rows.push(row);
  }
  for (const row of byTime) {
    if (row.kind !== 'landing') {
      continue;
    }
    const target = row.landingTarget ?? 'detached HEAD';
    const merged = row.mergedBranch ? groups.get(`${repositoryKey(row)}|${row.mergedBranch}`) : undefined;
    if (merged && !merged.arrival && merged.rows.some((one) => one.kind === 'commit')) {
      const last = merged.rows[merged.rows.length - 1];
      merged.arrival = {
        at: row.at,
        absolute: row.absolute,
        sha: row.sha,
        subject: row.subject,
        target,
        sameAsLast: sameCommitSha(last.sha, row.sha),
      };
      continue;
    }
    const group = groupFor(row, row.headKind, target);
    group.rows.push(row);
    group.rows.sort((a, b) => a.at - b.at);
  }
  const first = (group: CommitGroupView<Row>) => group.rows[0]?.at ?? group.arrival?.at ?? 0;
  // Sort repositories by key rather than display name, because different repositories can share a name.
  const repoKeyOf = (group: CommitGroupView<Row>) => group.key.slice(0, group.key.indexOf('|'));
  const repoFirst = new Map<string, number>();
  for (const group of groups.values()) {
    const key = repoKeyOf(group);
    const at = first(group);
    const known = repoFirst.get(key);
    if (known === undefined || at < known) {
      repoFirst.set(key, at);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => {
    const repoA = repoKeyOf(a);
    const repoB = repoKeyOf(b);
    if (repoA !== repoB) {
      const ownA = repoA === ownKey;
      const ownB = repoB === ownKey;
      if (ownA !== ownB) {
        return ownA ? -1 : 1;
      }
      return (repoFirst.get(repoA) ?? 0) - (repoFirst.get(repoB) ?? 0);
    }
    return first(a) - first(b);
  });
  return { single: sorted.length === 1, groups: sorted };
}

// What a group heading calls its branch. A head git never named has no branch to call.
export function commitGroupName(group: CommitGroupView): string {
  return group.branch ?? (group.detached ? 'detached commit' : 'unknown branch');
}

// Build the element id for a card part. Encode the card key and keep differently named parts distinct.
export function cardPartId(key: string, part: string): string {
  return `card-${encodeURIComponent(key)}-${part}`;
}

// The branch a one-group record names beside its count, muted, since no group heading draws it.
// The merged word follows it apart, as `ARRIVAL_WORD`, because it carries a hover of its own.
export function commitHeadFact(group: CommitGroupView): string {
  return [
    group.branch === null
      ? commitGroupName(group)
      : `on ${group.repository.own ? '' : `${group.repository.name} · `}${group.branch}`,
    group.where,
  ]
    .filter(Boolean)
    .map((part) => `· ${part}`)
    .join(' ');
}

// The word a merged branch's heading ends on.
export const ARRIVAL_WORD = '· merged';

// The arrival tooltip names the target, time and hash. Include the subject when the arrival hash differs from the group's last commit.
export function arrivalTitle(arrival: CommitArrival): string {
  const lead = `Merged into ${arrival.target} at ${arrival.absolute}, as ${arrival.sha}`;
  return arrival.sameAsLast
    ? `${lead}, the last commit of this branch`
    : `${lead}, which holds this branch's work under a new hash: ${arrival.subject}`;
}

// The hidden words after the merged word, so the hover is never the only home of the hash.
export function arrivalSpoken(arrival: CommitArrival): string {
  return ` into ${arrival.target} at ${arrival.absolute}, as ${arrival.sha}`;
}

// A group's accessible name: the repository when it is not the open folder's, the branch, and
// the arrival.
export function commitGroupLabel(group: CommitGroupView): string {
  return [
    group.repository.own ? null : group.repository.name,
    commitGroupName(group),
    group.arrival ? `merged into ${group.arrival.target} at ${group.arrival.absolute}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}
