// Recover commit identities and fast-forward landings from Git when printed output omits them. The recorded command supplies attribution.
// Commit windows use bounded logs, exact hashes use non-walking logs, and landings use the worktree's HEAD reflog.
// Cache repository identities by directory. Read branch names again for each batch.
// Apply retained answers synchronously. Fetch missing answers in the background and request a render when the batch finishes.
import { execFile } from 'node:child_process';
import { withRecoveredCommits } from './childartifacts';
import {
  CommitHead,
  CommitIntent,
  CommitPlace,
  CommitRepository,
  HEX_SHA,
  LandingIntent,
  Turn,
  TurnCommit,
  TurnAgent,
  isInside,
  normalizeFsPath,
  parseStatLine,
  sameCommitSha,
} from './transcript';

// Run Git in `dir` and return stdout. Failed or timed-out reads return null.
export interface GitRunner {
  run(dir: string, args: string[]): Promise<string | null>;
  identity?(dir: string): Promise<{ stdout: string | null; outsideGit: boolean }>;
}

// Bound each Git process, including cold-disk reads and hung commands.
const GIT_TIMEOUT_MS = 5000;

// Accept at most twenty commits per call. Request one extra so an oversized window is rejected instead of losing its oldest commit.
const LOG_LIMIT = 20;

// Allow three total read attempts per query. Stop automatic retries after the limit.
const READ_ATTEMPTS = 3;

// Widen Git's whole-second date query around the call window. `chooseCommits` applies the window after parsing.
const WINDOW_SLACK_MS = 2000;

const RECORD = '\x1e';
const FIELD = '\x00';

// Separate fields with NUL, which commit messages cannot contain. Write the subject last.
// A subject containing the record separator truncates its own record without consuming the next commit's identity fields.
const LOG_FORMAT = '%x1e%H%x00%cI%x00%s';

export const IDENTITY_ARGS: readonly string[] = [
  'rev-parse',
  '--path-format=absolute',
  '--git-common-dir',
  '--git-dir',
  '--show-toplevel',
];
const BRANCH_ARGS: readonly string[] = ['rev-parse', '--abbrev-ref', 'HEAD'];
const HEAD_LOG_FORMAT = '%gs%x00%H%x00%gD';

// Limit the HEAD reflog entries inspected for a commit window.
const REFLOG_LIMIT = 40;

export function nodeGitRunner(timeoutMs: number = GIT_TIMEOUT_MS): GitRunner {
  return {
    identity(dir) {
      return new Promise((resolve) => {
        execFile(
          'git',
          ['-C', dir, ...IDENTITY_ARGS],
          { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } },
          (error, stdout, stderr) => {
            resolve({
              stdout: error ? null : stdout,
              outsideGit:
                !!error &&
                /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point )/.test(
                  stderr,
                ),
            });
          },
        );
      });
    },
    run(dir: string, args: string[]): Promise<string | null> {
      return new Promise((resolve) => {
        execFile(
          'git',
          ['-C', dir, ...args],
          { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (err, stdout) => resolve(err ? null : stdout),
        );
      });
    },
  };
}

// Use Git's committer time to place each reported commit inside the call window.
export interface RepositoryCommit {
  sha: string;
  subject: string;
  at: number;
  files: number | null;
  added: number | null;
  removed: number | null;
}

// Read the worktree's own HEAD reflog. A commit reachable from another worktree's branch does not establish that this call created it.
export function reflogArgs(from: number, to: number): string[] {
  return [
    'log',
    '-g',
    '-n',
    String(REFLOG_LIMIT),
    '--date=iso-strict',
    `--since=${new Date(from - WINDOW_SLACK_MS).toISOString()}`,
    `--until=${new Date(to + WINDOW_SLACK_MS).toISOString()}`,
    `--format=${HEAD_LOG_FORMAT}`,
    'HEAD',
  ];
}

// Read later checkout entries alongside a landing to identify the branch that moved. Omit a count limit that discards those connecting entries.
export function landingReflogArgs(from: number): string[] {
  return [
    'log',
    '-g',
    '--date=iso-strict',
    `--since=${new Date(from - WINDOW_SLACK_MS).toISOString()}`,
    `--format=${HEAD_LOG_FORMAT}`,
    'HEAD',
  ];
}

// Accept reflog entries whose subject starts with `commit`. Other head movements establish no commit creation here.
// An absent or expired HEAD reflog supplies no attributable commits.
export function commitsInHeadLog(stdout: string): Set<string> {
  const made = new Set<string>();
  for (const line of stdout.split('\n')) {
    const [subject, sha] = line.split('\x00');
    if (!subject?.trim().startsWith('commit') || !sha?.trim()) {
      continue;
    }
    made.add(sha.trim());
  }
  return made;
}

// Match fast-forward merge entries and retain the merge command's source name. Merge-commit entries do not count as landings.
const LANDING_ENTRY = /^merge (.+): Fast-forward$/;

export interface RepositoryLanding {
  from: string;
  sha: string;
  at: number;
  head: CommitHead;
}

const CHECKOUT_ENTRY = /^checkout: moving from (.+) to (.+)$/;

function namedHead(name: string): CommitHead {
  return HEX_SHA.test(name) ? { kind: 'detached' } : { kind: 'branch', name };
}

// Read checkout entries backward to recover each landing's destination branch. Return landings oldest first.
export function landingsInHeadLog(stdout: string, currentHead: CommitHead): RepositoryLanding[] {
  const found: RepositoryLanding[] = [];
  let head = currentHead;
  for (const line of stdout.split('\n')) {
    const [subject, sha, when] = line.split('\x00');
    const checkout = CHECKOUT_ENTRY.exec((subject ?? '').trim());
    if (checkout) {
      head = namedHead(checkout[1]);
      continue;
    }
    const m = LANDING_ENTRY.exec((subject ?? '').trim());
    const selectorDate = /@\{(.+)\}$/.exec(when ?? '')?.[1] ?? when ?? '';
    const at = Date.parse(selectorDate);
    if (!m || !sha?.trim() || !Number.isFinite(at)) {
      continue;
    }
    found.push({ from: m[1], sha: sha.trim(), at, head });
  }
  return found.reverse();
}

// The branches pointing at a commit, asked when a merge that named a hash is recorded.
export function pointsAtArgs(sha: string): string[] {
  return ['for-each-ref', '--points-at', sha, '--format=%(refname:short)', 'refs/heads'];
}

// Use the merge command's ref name directly. For a hash, select the first pointing branch other than the destination branch.
// Capture that branch when recording the landing because refs move or disappear later.
export function mergedBranchOf(from: string, pointsAt: string | null, head: CommitHead): string | null {
  if (!HEX_SHA.test(from)) {
    return from;
  }
  const moved = head?.kind === 'branch' ? head.name : null;
  return (
    (pointsAt ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((name) => name && name !== moved) ?? null
  );
}

// Read the subject of the landed commit for its display row.
export function subjectArgs(sha: string): string[] {
  return ['log', '-n', '1', '--format=%s', sha, '--'];
}

export function logArgs(from: number, to: number): string[] {
  return [
    'log',
    '-n',
    String(LOG_LIMIT + 1),
    `--since=${new Date(from - WINDOW_SLACK_MS).toISOString()}`,
    `--until=${new Date(to + WINDOW_SLACK_MS).toISOString()}`,
    `--format=${LOG_FORMAT}`,
    '--shortstat',
  ];
}

// Read the exact printed commit identity without walking a folder's history.
export function exactCommitArgs(sha: string): string[] {
  return ['log', '--no-walk', `--format=${LOG_FORMAT}`, '--shortstat', sha, '--'];
}

// Reverse Git's newest-first output so turn commits appear in creation order.
export function parseCommitLog(stdout: string): RepositoryCommit[] {
  const found: RepositoryCommit[] = [];
  for (const chunk of stdout.split(RECORD)) {
    if (!chunk.trim()) {
      continue;
    }
    const lines = chunk.split('\n');
    const [sha, when, ...rest] = lines[0].split(FIELD);
    if (!sha || !HEX_SHA.test(sha.trim())) {
      continue;
    }
    const subject = rest.join(FIELD);
    const at = Date.parse(when ?? '');
    if (!Number.isFinite(at)) {
      continue;
    }
    // Search all remaining record lines for shortstat. Empty commits have no shortstat block.
    let stat: { files: number; added: number; removed: number } | null = null;
    for (let i = 1; i < lines.length; i++) {
      stat = parseStatLine(lines[i].trim());
      if (stat) {
        break;
      }
    }
    found.push({
      sha: sha.trim(),
      subject: subject.trim(),
      at,
      files: stat ? stat.files : null,
      added: stat ? stat.added : null,
      removed: stat ? stat.removed : null,
    });
  }
  return found.reverse();
}

// Describe repository identity from `rev-parse`. Linked worktrees share `commonDir` and have a distinct Git directory.
// `root` names the worktree root even when the command runs in a subdirectory.
export interface RepositoryPlace {
  commonDir: string | null;
  linked: boolean;
  root: string | null;
}

export function parseIdentity(stdout: string | null): RepositoryPlace {
  const lines = (stdout ?? '').split('\n').map((l) => l.trim());
  const commonDir = lines[0] ? normalizeFsPath(lines[0]) : null;
  const gitDir = lines[1] ? normalizeFsPath(lines[1]) : null;
  return {
    commonDir,
    linked: commonDir !== null && gitDir !== null && gitDir !== commonDir,
    root: lines[2] ? lines[2] : null,
  };
}

const UNKNOWN_PLACE: RepositoryPlace = { commonDir: null, linked: false, root: null };

// Match repository ownership by common Git directory. Linked worktrees share ownership with open folders. Nested independent repositories do not.
export function repositoryOf(dir: string, place: RepositoryPlace, folderIdentities: string[]): CommitRepository | null {
  return place.commonDir === null
    ? null
    : { key: place.commonDir, root: place.root ?? dir, own: folderIdentities.includes(place.commonDir) };
}

// Read the current branch name. A detached HEAD or missing answer supplies no branch name.
export function parseBranch(stdout: string | null): CommitHead {
  const line = (stdout ?? '').split('\n')[0]?.trim();
  return !line || line === 'HEAD' ? null : { kind: 'branch', name: line };
}

// Select commits inside the whole-second call window and the worktree's commit reflog. Reject windows over the log limit.
// Require the selected count to match the command's expected commit count. A witnessed hash must identify the sole selected commit.
export function chooseCommits(
  found: RepositoryCommit[],
  from: number,
  to: number,
  expected: number,
  made: ReadonlySet<string>,
  witnessedSha?: string,
): RepositoryCommit[] {
  if (expected <= 0 || found.length > LOG_LIMIT) {
    return [];
  }
  const first = Math.floor(from / 1000) * 1000;
  const last = Math.floor(to / 1000) * 1000;
  const inWindow = found.filter((c) => c.at >= first && c.at <= last && made.has(c.sha));
  if (witnessedSha !== undefined && (inWindow.length !== 1 || !inWindow[0].sha.startsWith(witnessedSha))) {
    return [];
  }
  return inWindow.length === expected ? inWindow : [];
}

// Omit a place label inside an open folder. Otherwise classify a shared repository as a worktree or main tree.
// An independent or unknown repository uses the command directory as its named place.
export function placeOf(
  dir: string,
  place: RepositoryPlace,
  folderIdentities: string[],
  folders: string[],
): CommitPlace {
  if (isInside(dir, folders)) {
    return null;
  }
  if (place.commonDir === null || !folderIdentities.includes(place.commonDir)) {
    return { kind: 'named', dir };
  }
  // Name the worktree root when available, even if the command ran in a subdirectory.
  const named = place.root ?? dir;
  return place.linked ? { kind: 'worktree', dir: named } : { kind: 'maintree', dir: named };
}

export function intentKey(intent: CommitIntent): string {
  return `${normalizeFsPath(intent.dir)}|${intent.from}|${intent.to}|${intent.expected}|${intent.witnessedSha ?? ''}`;
}

// Distinguish commit and landing queries even when their directory, time window, and expected count match.
export function landingKey(intent: LandingIntent): string {
  return `landing|${intent.id ?? ''}|${intentKey(intent)}`;
}

// Retain selected commits and the branch reported when reading the window.
interface Answer {
  found: RepositoryCommit[];
  head: CommitHead;
}

interface ExactAnswer {
  commit: RepositoryCommit;
  dir: string;
}

interface CandidateQuery {
  sha: string;
  folders: string[];
}

// Retain selected landings with their subjects and merged branch names.
interface LandingAnswer {
  found: Array<RepositoryLanding & { subject: string; mergedBranch: string | null }>;
}

// Select landings inside the whole-second call window. Require their count to match the expected merges.
// Merge commits produce no matching landing entry, so a mixed or incomplete count is rejected.
export function chooseLandings<T extends { at: number }>(found: T[], from: number, to: number, expected: number): T[] {
  if (expected <= 0) {
    return [];
  }
  const first = Math.floor(from / 1000) * 1000;
  const last = Math.floor(to / 1000) * 1000;
  const inWindow = found.filter((landing) => landing.at >= first && landing.at <= last);
  return inWindow.length === expected ? inWindow : [];
}

// Fill missing commit identities and classify their repositories. Apply held answers immediately and fetch missing answers asynchronously.
export class RepositoryCommits {
  private readonly answers = new Map<string, Answer>();
  private readonly exactAnswers = new Map<string, ExactAnswer>();
  private readonly landed = new Map<string, LandingAnswer>();
  private readonly identities = new Map<string, RepositoryPlace>();
  private readonly attempts = new Map<string, number>();
  private readonly asking = new Set<string>();
  private readonly resolvedBy = new WeakMap<TurnCommit, string>();
  private work: Promise<void> = Promise.resolve();
  private openFolders: string[] = [];

  constructor(
    private readonly runner: GitRunner,
    private readonly onFilled: () => void,
  ) {}

  // True once candidate resolution has placed the commit, so a group it holds came from a repository answer.
  resolved(commit: TurnCommit): boolean {
    return this.resolvedBy.has(commit);
  }

  // Gives a commit read again the placement of the commit it replaces, so its group holds until the answer returns. False when the earlier commit was never placed.
  inherit(from: TurnCommit, to: TurnCommit): boolean {
    const key = this.resolvedBy.get(from);
    if (key === undefined) return false;
    this.resolvedBy.set(to, key);
    return true;
  }

  apply(
    turns: Turn[],
    folders: string[],
    retained?: (commit: TurnCommit, identities: string[], turn: Turn, agent?: TurnAgent) => boolean,
    restore?: (intent: CommitIntent, identities: string[], turn: Turn, agent?: TurnAgent) => TurnCommit[] | null,
  ): void {
    const nextFolders = folders.map(normalizeFsPath).sort();
    if (JSON.stringify(nextFolders) !== JSON.stringify(this.openFolders)) {
      for (const folder of [...this.openFolders, ...nextFolders]) {
        this.identities.delete(folder);
        this.attempts.delete(folder);
      }
      this.exactAnswers.clear();
      this.openFolders = nextFolders;
    }
    let cleared = false;
    const wanted: CommitIntent[] = [];
    const merged: LandingIntent[] = [];
    const dirs: string[] = [];
    const shas: string[] = [];
    const candidates: CandidateQuery[] = [];
    const folderIdentities = this.knownIdentities(folders, dirs);
    for (const turn of turns) {
      const owners = [
        turn,
        ...turn.agents.map((agent) => ({
          childAgent: agent,
          commits: (agent.commits ??= []),
          commitIntents: agent.commitIntents,
        })),
      ];
      for (const owner of owners) {
        const restoredCommits = new Set<TurnCommit>();
        for (const intent of owner.commitIntents ?? []) {
          const restored = restore?.(
            intent,
            folderIdentities,
            turn,
            'childAgent' in owner ? owner.childAgent : undefined,
          );
          if (restored != null) {
            for (const commit of restored) {
              if (!owner.commits.some((one) => sameCommitSha(one.sha, commit.sha))) {
                owner.commits.push(commit);
                restoredCommits.add(commit);
              }
            }
            owner.commits.sort((a, b) => a.at - b.at);
            continue;
          }
          const exact =
            intent.witnessedSha === undefined || !this.unknownIdentity(intent.dir)
              ? undefined
              : this.exactAnswers.get(exactKey(intent.witnessedSha, folders));
          if (exact !== undefined) {
            this.adopt(owner, { found: [exact.commit], head: null }, exact.dir, folderIdentities, folders, intent);
            continue;
          }
          const key = intentKey(intent);
          const answer = this.answers.get(key);
          if (answer === undefined) {
            if (this.wants(key)) {
              wanted.push(intent);
            }
            this.want(intent.dir, dirs);
            if (intent.witnessedSha !== undefined && this.unknownIdentity(intent.dir)) {
              this.wantExact(intent.witnessedSha, folders, shas);
            }
            continue;
          }
          if (intent.witnessedSha !== undefined && this.unknownIdentity(intent.dir)) {
            this.wantExact(intent.witnessedSha, folders, shas);
            continue;
          }
          if (!this.identities.has(normalizeFsPath(intent.dir))) {
            this.want(intent.dir, dirs);
            continue;
          }
          this.adopt(owner, answer, intent.dir, folderIdentities, folders, intent);
          for (const commit of owner.commits) {
            if (intent.source && answer.found.some((one) => sameCommitSha(one.sha, commit.sha)))
              commit.source = intent.source;
          }
        }
        // Classify printed commits by repository identity as well as path, so linked worktrees retain their project's ownership.
        for (const commit of owner.commits) {
          if (restoredCommits.has(commit)) continue;
          if (retained?.(commit, folderIdentities, turn, 'childAgent' in owner ? owner.childAgent : undefined))
            continue;
          if (commit.candidates) {
            const evidence = commit.candidates;
            if (!evidence.complete) {
              // A commit whose reply is still awaited keeps its group. Navigation waits for the reply.
              const awaiting = evidence.awaiting === true;
              cleared ||= commit.dir !== null || (!awaiting && (commit.place != null || commit.repository != null));
              commit.dir = null;
              if (!awaiting) {
                commit.place = null;
                commit.repository = null;
              }
              continue;
            }
            const query = { sha: commit.printedSha ?? commit.sha, folders: [...evidence.dirs, ...folders] };
            const key = candidateKey(query);
            const exact = this.exactAnswers.get(key);
            if (exact) {
              this.resolvedBy.set(commit, key);
              commit.dir = exact.dir;
              const found = this.identities.get(normalizeFsPath(exact.dir)) ?? UNKNOWN_PLACE;
              commit.place = placeOf(exact.dir, found, folderIdentities, folders);
              commit.repository = repositoryOf(exact.dir, found, folderIdentities);
            } else {
              // A commit resolved from this same query keeps its group while the answer is awaited again. Navigation waits for it.
              const awaiting = this.resolvedBy.get(commit) === key && (this.asking.has(key) || this.wants(key));
              cleared ||= commit.dir !== null || (!awaiting && (commit.place != null || commit.repository != null));
              commit.dir = null;
              if (!awaiting) {
                commit.place = null;
                commit.repository = null;
              }
              if (this.wants(key) && !candidates.some((one) => candidateKey(one) === key)) {
                candidates.push(query);
                for (const dir of query.folders) this.want(dir, dirs);
              }
            }
            continue;
          }
          const dir = commit.dir;
          if (dir === null) {
            continue;
          }
          const place = this.identities.get(normalizeFsPath(dir));
          if (place === undefined) {
            this.want(dir, dirs);
            continue;
          }
          if (place.commonDir === null) {
            const exact = this.exactAnswers.get(exactKey(commit.sha, folders));
            if (exact === undefined) {
              this.wantExact(commit.sha, folders, shas);
              continue;
            }
            commit.dir = exact.dir;
            const found = this.identities.get(normalizeFsPath(exact.dir)) ?? UNKNOWN_PLACE;
            commit.place = placeOf(exact.dir, found, folderIdentities, folders);
            commit.repository = repositoryOf(exact.dir, found, folderIdentities);
            continue;
          }
          commit.place = placeOf(dir, place, folderIdentities, folders);
          commit.repository = repositoryOf(dir, place, folderIdentities);
        }
      }
      // Add recovered commits to the subagent's artifact figures.
      for (const agent of turn.agents) {
        if (agent.artifacts && agent.commits?.length) {
          agent.artifacts = withRecoveredCommits(agent.artifacts, agent.commits, sameCommitSha);
        }
      }
      for (const intent of turn.landingIntents ?? []) {
        const key = landingKey(intent);
        const answer = this.landed.get(key);
        if (answer === undefined) {
          if (this.wants(key)) {
            merged.push(intent);
          }
          this.want(intent.dir, dirs);
          continue;
        }
        if (!this.identities.has(normalizeFsPath(intent.dir))) {
          this.want(intent.dir, dirs);
          continue;
        }
        this.adoptLandings(turn, answer, intent, folderIdentities, folders);
      }
    }
    if (
      wanted.length === 0 &&
      merged.length === 0 &&
      dirs.length === 0 &&
      shas.length === 0 &&
      candidates.length === 0
    ) {
      if (cleared) this.onFilled();
      return;
    }
    // Mark queries in flight before queuing the batch. Repeated session renders then cannot queue the same unanswered query.
    const keys = [
      ...dirs.map(normalizeFsPath),
      ...wanted.map(intentKey),
      ...merged.map(landingKey),
      ...shas.map((sha) => exactKey(sha, folders)),
      ...candidates.map(candidateKey),
    ];
    for (const key of keys) {
      this.asking.add(key);
    }
    // Serialize batches. Catch batch failures so one rejected batch cannot block subsequent reads.
    this.work = this.work.then(() => this.ask(wanted, merged, dirs, shas, folders, keys, candidates)).catch(() => {});
    if (cleared) this.onFilled();
  }

  // Accept queries that are not in flight and have not reached the retry limit.
  private wants(key: string): boolean {
    return !this.asking.has(key) && (this.attempts.get(key) ?? 0) < READ_ATTEMPTS;
  }

  // Deduplicate directory queries by normalized filesystem path.
  private want(dir: string, dirs: string[]): void {
    const key = normalizeFsPath(dir);
    if (this.identities.has(key) || !this.wants(key) || dirs.some((d) => normalizeFsPath(d) === key)) {
      return;
    }
    dirs.push(dir);
  }

  private unknownIdentity(dir: string): boolean {
    return this.identities.get(normalizeFsPath(dir))?.commonDir === null;
  }

  private wantExact(sha: string, folders: string[], shas: string[]): void {
    const key = exactKey(sha, folders);
    if (this.exactAnswers.has(key) || !this.wants(key) || shas.some((one) => sameCommitSha(one, sha))) {
      return;
    }
    shas.push(sha);
  }

  private knownIdentities(folders: string[], dirs: string[]): string[] {
    const known: string[] = [];
    for (const folder of folders) {
      const place = this.identities.get(normalizeFsPath(folder));
      if (place === undefined) {
        this.want(folder, dirs);
      } else if (place.commonDir !== null) {
        known.push(place.commonDir);
      }
    }
    return known;
  }

  private adopt(
    turn: Pick<Turn, 'commits'>,
    answer: Answer,
    dir: string,
    folderIdentities: string[],
    folders: string[],
    intent?: CommitIntent,
  ): void {
    const identity = this.identities.get(normalizeFsPath(dir)) ?? UNKNOWN_PLACE;
    const place = placeOf(dir, identity, folderIdentities, folders);
    const repository = repositoryOf(dir, identity, folderIdentities);
    let added = false;
    for (const one of answer.found) {
      const sha = one.sha.slice(0, 8);
      if (turn.commits.some((c) => sameCommitSha(c.sha, sha))) {
        continue;
      }
      turn.commits.push({
        ...(intent?.source ? { intent: intentKey(intent), source: intent.source } : {}),
        sha,
        subject: one.subject,
        head: answer.head,
        files: one.files,
        added: one.added,
        removed: one.removed,
        at: one.at,
        place,
        dir,
        repository,
      });
      added = true;
    }
    // Sort printed and recovered commits together because their timestamps come from different sources.
    if (added) {
      turn.commits.sort((a, b) => a.at - b.at);
    }
  }

  // Record landing time as the call's end time. The landed commit's creation time does not describe when this turn moved the branch.
  private adoptLandings(
    turn: Turn,
    answer: LandingAnswer,
    intent: LandingIntent,
    folderIdentities: string[],
    folders: string[],
  ): void {
    const identity = this.identities.get(normalizeFsPath(intent.dir)) ?? UNKNOWN_PLACE;
    const place = placeOf(intent.dir, identity, folderIdentities, folders);
    const repository = repositoryOf(intent.dir, identity, folderIdentities);
    for (let index = 0; index < answer.found.length; index += 1) {
      const one = answer.found[index];
      const sha = one.sha.slice(0, 8);
      const id = `${landingKey(intent)}|${one.at}|${index}`;
      if ((turn.landings ?? []).some((landing) => landing.id === id)) {
        continue;
      }
      (turn.landings ??= []).push({
        id,
        sha,
        subject: one.subject,
        from: one.from,
        head: one.head,
        at: intent.to,
        place,
        dir: intent.dir,
        repository,
        mergedBranch: one.mergedBranch,
      });
    }
  }

  // Treat runner rejections as failed reads so they count toward the retry limit.
  private read(dir: string, args: readonly string[]): Promise<string | null> {
    return this.runner.run(dir, [...args]).catch(() => null);
  }

  private async ask(
    intents: CommitIntent[],
    merges: LandingIntent[],
    dirs: string[],
    shas: string[],
    folders: string[],
    keys: string[],
    candidates: CandidateQuery[],
  ): Promise<void> {
    try {
      for (const dir of dirs) {
        const key = normalizeFsPath(dir);
        const out = await this.read(dir, IDENTITY_ARGS);
        if (out === null) {
          this.giveUp(key, 'directory');
          continue;
        }
        this.identities.set(key, parseIdentity(out));
      }
      for (const sha of shas) {
        const key = exactKey(sha, folders);
        let answer: ExactAnswer | undefined;
        let collision = false;
        const uniqueFolders = folders
          .filter(
            (folder, index) => folders.findIndex((one) => normalizeFsPath(one) === normalizeFsPath(folder)) === index,
          )
          .sort((a, b) => normalizeFsPath(a).localeCompare(normalizeFsPath(b)));
        for (const folder of uniqueFolders) {
          const out = await this.read(folder, exactCommitArgs(sha));
          if (out === null) {
            continue;
          }
          const found = parseCommitLog(out);
          if (found.length === 1 && sameCommitSha(found[0].sha, sha)) {
            if (answer !== undefined && answer.commit.sha.toLowerCase() !== found[0].sha.toLowerCase()) {
              collision = true;
            } else {
              answer ??= { commit: found[0], dir: folder };
            }
          }
        }
        if (answer !== undefined && !collision) {
          this.exactAnswers.set(key, answer);
        } else {
          this.giveUp(key, 'exact');
        }
      }
      for (const query of candidates) {
        const key = candidateKey(query);
        let answer: ExactAnswer | undefined;
        let identity: string | null = null;
        let inconclusive = false;
        for (const folder of [...new Set(query.folders.map(normalizeFsPath))].sort()) {
          const place = this.identities.get(folder);
          if (!place?.commonDir) {
            inconclusive = true;
            continue;
          }
          // Empty output proves absence. A failed read proves nothing about another candidate.
          const objects = await this.read(folder, ['rev-parse', `--disambiguate=${query.sha}`]);
          if (objects === null) {
            inconclusive = true;
            continue;
          }
          const hashes = objects.split(/\s+/).filter(Boolean);
          if (hashes.length === 0) continue;
          if (hashes.length !== 1 || !sameCommitSha(hashes[0], query.sha)) {
            inconclusive = true;
            continue;
          }
          const out = await this.read(folder, exactCommitArgs(hashes[0]));
          const found = out === null ? [] : parseCommitLog(out);
          if (found.length !== 1 || found[0].sha.toLowerCase() !== hashes[0].toLowerCase()) {
            inconclusive = true;
            continue;
          }
          if (answer && (answer.commit.sha !== found[0].sha || identity !== place.commonDir)) {
            inconclusive = true;
          } else {
            answer ??= { commit: found[0], dir: folder };
            identity ??= place.commonDir;
          }
        }
        if (answer && !inconclusive) this.exactAnswers.set(key, answer);
        else this.giveUp(key, 'exact');
      }
      // Read the branch before each directory's commit log and reuse it within the batch. Retry the window if the branch read fails.
      const branches = new Map<string, string | null>();
      for (const intent of intents) {
        const key = intentKey(intent);
        // Read the HEAD reflog before the branch and commit log. An empty commit set needs neither additional read.
        const moves = await this.read(intent.dir, reflogArgs(intent.from, intent.to));
        if (moves === null) {
          this.giveUp(key, 'window');
          continue;
        }
        const made = commitsInHeadLog(moves);
        if (made.size === 0) {
          this.answers.set(key, { found: [], head: null });
          continue;
        }
        const dir = normalizeFsPath(intent.dir);
        if (!branches.has(dir)) {
          branches.set(dir, await this.read(intent.dir, BRANCH_ARGS));
        }
        const branch = branches.get(dir) ?? null;
        const out = branch === null ? null : await this.read(intent.dir, logArgs(intent.from, intent.to));
        if (out === null) {
          this.giveUp(key, 'window');
          continue;
        }
        this.answers.set(key, {
          found: chooseCommits(parseCommitLog(out), intent.from, intent.to, intent.expected, made, intent.witnessedSha),
          head: parseBranch(branch),
        });
      }
      for (const intent of merges) {
        const key = landingKey(intent);
        const dir = normalizeFsPath(intent.dir);
        if (!branches.has(dir)) {
          branches.set(dir, await this.read(intent.dir, BRANCH_ARGS));
        }
        const branch = branches.get(dir) ?? null;
        if (branch === null) {
          this.giveUp(key, 'landing');
          continue;
        }
        const currentHead = parseBranch(branch);
        const moves = await this.read(intent.dir, landingReflogArgs(intent.from));
        if (moves === null) {
          this.giveUp(key, 'landing');
          continue;
        }
        const found = chooseLandings(landingsInHeadLog(moves, currentHead), intent.from, intent.to, intent.expected);
        if (found.length === 0) {
          this.landed.set(key, { found: [] });
          continue;
        }
        // Read landing subjects and merged branch names before publishing the rows. Capture current pointing branches for hash-based merge sources.
        const named: LandingAnswer['found'] = [];
        for (const one of found) {
          const subject = await this.read(intent.dir, subjectArgs(one.sha));
          if (subject === null) {
            break;
          }
          const pointsAt = HEX_SHA.test(one.from) ? await this.read(intent.dir, pointsAtArgs(one.sha)) : '';
          if (pointsAt === null) {
            break;
          }
          named.push({
            ...one,
            subject: subject.split('\n')[0].trim(),
            mergedBranch: mergedBranchOf(one.from, pointsAt, one.head),
          });
        }
        if (named.length !== found.length) {
          this.giveUp(key, 'landing');
          continue;
        }
        this.landed.set(key, { found: named });
      }
    } finally {
      for (const key of keys) {
        this.asking.delete(key);
      }
    }
    // Request a render after the batch settles so the panel displays new answers or exhausted retries.
    this.onFilled();
  }

  // Retry failed reads up to the limit. Then commit and landing windows settle empty, directories settle unknown, and exact identities remain unavailable.
  private giveUp(key: string, asked: 'window' | 'directory' | 'exact' | 'landing'): void {
    const tried = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, tried);
    if (tried < READ_ATTEMPTS) {
      return;
    }
    if (asked === 'directory') {
      this.identities.set(key, UNKNOWN_PLACE);
    } else if (asked === 'landing') {
      this.landed.set(key, { found: [] });
    } else if (asked === 'window') {
      this.answers.set(key, { found: [], head: null });
    }
  }
}

const exactKey = (sha: string, folders: string[]): string =>
  `exact|${sha.toLowerCase()}|${[...new Set(folders.map(normalizeFsPath))].sort().join('|')}`;

const candidateKey = (query: CandidateQuery): string => `candidates|${exactKey(query.sha, query.folders)}`;
