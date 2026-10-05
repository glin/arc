// Commits and landings read back from the repository, for the calls whose git output printed
// neither.
//
// `git commit -q` prints nothing at all, and a quiet flag is the common reason a commit
// never reaches a card. The transcript still says that a turn ran `git commit` and which
// directory it ran in, so the command stays the attribution and the repository supplies the
// identity: the sha, the subject, the branch and the counts.
//
// A fast-forward merge writes no commit and prints no full identity. The head log's
// `merge <name>: Fast-forward` entry carries the full sha and the name the command named.
//
// Every read is bounded. One `git log` per call that committed is limited to the window
// between the call and its result. A known sha can use an exact, non-walking log when its
// directory stops answering. One `git rev-parse` runs per directory. Which repository a
// directory belongs to cannot change, so that answer is kept for good. Which branch it is on
// can change, so that one is read again with each batch of work.
//
// The reads are asynchronous and nothing waits for them. A render draws what is already
// known and asks for the rest. The answers arrive on a later render, because a filled turn
// asks the panel to draw itself again.
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
  isInside,
  normalizeFsPath,
  parseStatLine,
  sameCommitSha,
} from './transcript';

// One git read. `dir` is where git runs. The answer is stdout, or null when git failed,
// which covers a directory that no longer exists, a directory that is not a repository, and
// a read that ran out of time.
export interface GitRunner {
  run(dir: string, args: string[]): Promise<string | null>;
  identity?(dir: string): Promise<{ stdout: string | null; outsideGit: boolean }>;
}

// Long enough for a cold repository on a slow disk, short enough that a hung read gives up
// while the reader is still looking at the same session.
const GIT_TIMEOUT_MS = 5000;

// A single call cannot have made more commits than this, and a window that returns more is
// answering about something other than the call. The read asks for one more than the limit,
// so a window holding too many is refused rather than trimmed: a trimmed answer drops the
// call's own oldest commit and can leave a stranger behind in its place.
const LOG_LIMIT = 20;

// How often one question is put to git before the reader stops asking. A repository that is
// briefly unreachable answers on a later try. One that is gone never answers, and a panel
// that refreshes every few seconds would spawn a process every few seconds for the life of
// the window.
const READ_ATTEMPTS = 3;

// `git log` takes a date and compares it against whole seconds. The query asks for a wider
// span than the window so that rounding at either edge cannot drop the commit, and the
// window itself is applied by `chooseCommits`.
const WINDOW_SLACK_MS = 2000;

const RECORD = '\x1e';
const FIELD = '\x00';

// A commit message can hold any byte except NUL, so the fields inside a record are separated
// by one and cannot be split by their own contents.
//
// A record separator has no such byte to use, because NUL is spent, so the subject is written
// last. A subject holding the record separator then cuts its own record short instead of
// taking the next commit's fields with it: the sha and the time are already read, and the
// fragment left behind fails the sha test rather than becoming a commit of its own.
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

// How many head movements to read for one commit window. A directory that moved more than
// this in a few seconds is not answering about the call.
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

// One commit as the repository reports it. `at` is git's own committer time, which is what
// places the commit inside a call's window.
export interface RepositoryCommit {
  sha: string;
  subject: string;
  at: number;
  files: number | null;
  added: number | null;
  removed: number | null;
}

// What this directory's own head did inside the window.
//
// Every worktree keeps its own head log, and only the directory that made a commit records
// it. A commit another worktree made in the same window is reachable from a branch this one
// later checks out, and would otherwise stand in for the commit this call really made. The
// head log cannot be borrowed that way.
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

// A landing also needs every later checkout fact that connects its head movement to the
// branch that moved. The time-bounded tail starts at the call and reaches the current head.
// A count limit would drop an old landing after enough later head movements.
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

// The commits the head log says this directory made. Git writes `commit:` for an ordinary
// commit, and `commit (amend):` and `commit (initial):` for the other two. Every other entry
// is a head that moved to a commit somebody else made, which is what a fast-forward landing
// and a checkout are. `landingsInHeadLog` reads the landings out of the same answer.
//
// A directory whose head log has been turned off or has expired names none, so nothing is
// drawn. That loses a commit and never claims one.
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

// What git writes when a merge moved the head without making a commit. The name after the
// word is what the merge command named, which is the only place that name survives: git's own
// output says `Updating a..b` and `Fast-forward`, and neither carries it.
//
// A merge that made a merge commit writes `Merge made by the 'ort' strategy` instead, and is
// no landing. It is left out here, so a call that made one names nothing at all rather than
// naming the wrong thing.
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

// The trees this directory fast-forwarded, oldest first. Walking the log backwards also
// walks checkout entries backwards, so each landing keeps the branch that moved then.
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

// The branch a landing brought in. A ref name the merge command named is that branch. A hash
// is answered by the branches pointing at the commit, taking the first that is not the branch
// the merge moved, because that branch points at the commit too once it has moved. None is null.
//
// The answer is read when the landing is recorded and kept. Asked later it answers wrong,
// because branches move on and are deleted, and a later branch can come to point at the commit.
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

// The subject of one commit, for a landing. A landing knows its sha from the head log and
// nothing else, and a row carrying a sha alone says nothing a reader can use.
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

// One commit whose identity the transcript already supplied. The exact revision keeps this
// fallback from searching an open folder for a commit that the command directory did not prove.
export function exactCommitArgs(sha: string): string[] {
  return ['log', '--no-walk', `--format=${LOG_FORMAT}`, '--shortstat', sha, '--'];
}

// git writes the commits newest first. They are turned around here because a turn that made
// several made them in the other order, and the card lists them the way they happened.
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
    // A commit that changed nothing prints no stat block, and git writes a blank line before
    // the one it does print, so the search runs over the whole record.
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

// What one `git rev-parse` says about a directory.
//
// `commonDir` identifies the repository. A linked worktree and the tree it came from report
// the same one, whatever their paths look like.
//
// `linked` tells the two apart. Git gives the main tree the same directory for its own state
// as for the state it shares, and gives a linked worktree one of its own underneath it.
//
// `root` is the top of the tree the directory sits in, so a commit made in a subdirectory is
// still drawn against the tree that holds it rather than against the subdirectory's name.
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

// The repository a commit is in, by the directory git answered for. A directory git could not
// name has none. The repository is the open folder's own when its key is an open folder's key,
// so a repository nested inside an open folder is not, while a linked worktree of it is.
export function repositoryOf(dir: string, place: RepositoryPlace, folderIdentities: string[]): CommitRepository | null {
  return place.commonDir === null
    ? null
    : { key: place.commonDir, root: place.root ?? dir, own: folderIdentities.includes(place.commonDir) };
}

// The branch a directory is on, for a commit read back from it.
//
// Every commit this reader returns was found by walking that directory's own `HEAD`, so it
// is on that branch. A detached head names no branch, and saying so would claim the commit
// was made outside one, which is a claim about how it was made rather than where it sits.
export function parseBranch(stdout: string | null): CommitHead {
  const line = (stdout ?? '').split('\n')[0]?.trim();
  return !line || line === 'HEAD' ? null : { kind: 'branch', name: line };
}

// Which commits in the window belong to the call, or none.
//
// `made` is what the directory's own head log recorded. A commit outside it belongs to
// another tree, however reachable it is from the branch this one is on now.
//
// Git stores a commit time as whole seconds, and a window's bounds carry milliseconds, so
// the window is widened to the second before it is applied. A commit the call made always
// survives that widening, because its own second cannot fall outside the seconds its window
// began and ended in. A commit somebody else made in the same second survives it too.
//
// `expected` is what separates the two. It is how many times the command said `git commit`,
// so a window holding exactly that many is the call's own work. Any other count means the
// window is answering about something else, and nothing is named. Naming another session's
// commit as this turn's work is the failure this exists to prevent, and missing a commit
// only leaves the card as it was.
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

// Where a commit made in `dir` landed, once the repository has been asked.
//
// A directory inside an open folder says nothing extra, the way it always has: the card it
// is on already says where it is. A directory outside every open folder is decided by the
// repository rather than by the path. A linked worktree shares the object store and the
// branch refs of the folder it came from, so a commit made there is this project's work on a
// branch the reader will merge. Only a different repository is somebody else's.
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
  // Both trees report the same common directory, so the test is symmetric and the reader can
  // be standing in either one. The row names the tree the commit was made in rather than the
  // directory the command ran in, which is often a subdirectory of it.
  const named = place.root ?? dir;
  return place.linked ? { kind: 'worktree', dir: named } : { kind: 'maintree', dir: named };
}

export function intentKey(intent: CommitIntent): string {
  return `${normalizeFsPath(intent.dir)}|${intent.from}|${intent.to}|${intent.expected}|${intent.witnessedSha ?? ''}`;
}

// One call can commit and merge in the same window, in the same directory, the same number of
// times. The two questions are told apart by what they ask for rather than by their window.
export function landingKey(intent: LandingIntent): string {
  return `landing|${intent.id ?? ''}|${intentKey(intent)}`;
}

// What one call's window answered: the commits, and the branch the directory was on when the
// answer was read.
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

// The same for a call that merged: what the tree landed on, and the branch that moved.
interface LandingAnswer {
  found: Array<RepositoryLanding & { subject: string; mergedBranch: string | null }>;
}

// Which landings in the window belong to the call, or none.
//
// The head log is already this directory's own, so nothing another tree did can appear in it.
// What can appear is a second session merging in the same tree, and `expected` is what refuses
// that: it is how many times the command said `git merge`, so a window holding any other
// number is answering about something else.
//
// A merge that made a merge commit is no landing and writes no entry this reads, so a command
// that made one holds fewer landings than it expected and names nothing.
export function chooseLandings<T extends { at: number }>(found: T[], from: number, to: number, expected: number): T[] {
  if (expected <= 0) {
    return [];
  }
  const first = Math.floor(from / 1000) * 1000;
  const last = Math.floor(to / 1000) * 1000;
  const inWindow = found.filter((landing) => landing.at >= first && landing.at <= last);
  return inWindow.length === expected ? inWindow : [];
}

// Fills in what the printed output did not carry, and corrects what a path test alone got
// wrong.
//
// `apply` is synchronous and draws only from answers already held. Work it has no answer for
// is asked for in the background, and `onFilled` says that a later render has more to draw.
export class RepositoryCommits {
  private readonly answers = new Map<string, Answer>();
  private readonly exactAnswers = new Map<string, ExactAnswer>();
  private readonly landed = new Map<string, LandingAnswer>();
  private readonly identities = new Map<string, RepositoryPlace>();
  private readonly attempts = new Map<string, number>();
  private readonly asking = new Set<string>();
  private work: Promise<void> = Promise.resolve();

  constructor(
    private readonly runner: GitRunner,
    private readonly onFilled: () => void,
  ) {}

  apply(turns: Turn[], folders: string[]): void {
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
          commits: (agent.commits ??= []),
          commitIntents: agent.commitIntents,
        })),
      ];
      for (const owner of owners) {
        for (const intent of owner.commitIntents ?? []) {
          const exact =
            intent.witnessedSha === undefined || !this.unknownIdentity(intent.dir)
              ? undefined
              : this.exactAnswers.get(exactKey(intent.witnessedSha, folders));
          if (exact !== undefined) {
            this.adopt(owner, { found: [exact.commit], head: null }, exact.dir, folderIdentities, folders);
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
          this.adopt(owner, answer, intent.dir, folderIdentities, folders);
        }
        // A printed commit says where it landed from its path alone, which reads a linked
        // worktree of this repository as somebody else's. Correcting it here keeps one answer
        // for a place, whether the commit was printed or read back.
        for (const commit of owner.commits) {
          if (commit.candidates) {
            const evidence = commit.candidates;
            if (!evidence.complete) {
              cleared ||= commit.dir !== null || commit.place != null || commit.repository != null;
              commit.dir = null;
              commit.place = null;
              commit.repository = null;
              continue;
            }
            const query = { sha: commit.printedSha ?? commit.sha, folders: [...evidence.dirs, ...folders] };
            const key = candidateKey(query);
            const exact = this.exactAnswers.get(key);
            if (exact) {
              commit.dir = exact.dir;
              const found = this.identities.get(normalizeFsPath(exact.dir)) ?? UNKNOWN_PLACE;
              commit.place = placeOf(exact.dir, found, folderIdentities, folders);
              commit.repository = repositoryOf(exact.dir, found, folderIdentities);
            } else {
              cleared ||= commit.dir !== null || commit.place != null || commit.repository != null;
              commit.dir = null;
              commit.place = null;
              commit.repository = null;
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
      // A commit read back for a child joins the child's figures, which its own record left
      // without it.
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
    // A question is marked as asked here rather than where it is put, because a batch waits
    // for the batch before it. A listing calls `apply` for each session it draws, and every
    // one of those would queue the same question again while the first was still waiting.
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
    // One batch at a time. Unqueued batches would start a process apiece.
    //
    // The chain swallows what a batch throws. A rejected chain answers every later batch
    // without running it, and the questions those batches marked as asked would stay marked,
    // so one failed repaint would stop the reader from ever asking anything again.
    this.work = this.work.then(() => this.ask(wanted, merged, dirs, shas, folders, keys, candidates)).catch(() => {});
    if (cleared) this.onFilled();
  }

  // Whether a question is worth putting to git: not already in flight, and not one that has
  // failed as often as this reader is willing to ask.
  private wants(key: string): boolean {
    return !this.asking.has(key) && (this.attempts.get(key) ?? 0) < READ_ATTEMPTS;
  }

  // One directory, however it is spelled. The two spellings of one folder are one question,
  // and raw string equality would put it twice.
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
    // A printed commit carries the time its output was read and a read-back one carries
    // git's own, so a card holding both would list them out of order without this.
    if (added) {
      turn.commits.sort((a, b) => a.at - b.at);
    }
  }

  // The landings one call made, once the head log has answered.
  //
  // A landing is stamped with the end of the call's own window rather than with the commit's
  // time. The commit was written earlier, often in another tree and on another day, and what
  // this row reports is when the turn moved the tree onto it.
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

  // Every read goes through this, so a runner that rejects counts as a read that failed. A
  // rejection reaching the loop instead would leave the attempt uncounted, and the ceiling on
  // asking would not hold for it.
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
      // The branch is read beside the commits rather than kept, because a directory changes
      // branch and a card must not name the one it was on last time. Several calls in one
      // directory share the one read, because they are answered in the same pass.
      //
      // It is read first. A branch read that fails answers the same as a detached head, so
      // recording the commits without it would keep a wrong silence for good. A failed read
      // is no answer at all, and the whole call is asked about again.
      const branches = new Map<string, string | null>();
      for (const intent of intents) {
        const key = intentKey(intent);
        // The head log is read first, because a window this directory made no commit in needs
        // no other read at all.
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
        // The head log carries the sha and the name the command named, and no subject. A row
        // holding a sha and nothing else says nothing a reader can use, so the subject is read
        // before anything is drawn.
        //
        // The branch the merge brought in is read here too, once, while the branches still say it.
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
    // A batch runs only where there was a question, and every answer changes what a render
    // can draw: what the reader learned, or what it has settled for after asking too often.
    // An idle panel repaints on a change alone, so the batch has to ask for one.
    this.onFilled();
  }

  // A read that failed is not an answer, so the next render asks again. A directory that is
  // gone never answers, so the asking stops after a few tries. A failed window settles as
  // empty, a directory settles as unknown, and an exact sha remains unavailable.
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
