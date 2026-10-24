import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { IDENTITY_ARGS, exactCommitArgs, intentKey, parseCommitLog, parseIdentity, type GitRunner } from './gitcommits';
import { parseWorktreeRoots } from './repositoryscope';
import {
  commitSourceStamp,
  fileIdentityValue,
  normalizeFsPath,
  revisionOf,
  sameRelationshipStamp,
  supportedFileIdentity,
  type RelationshipStamp,
  type TurnCommit,
  type CommitIntent,
} from './transcript';

export const COMMIT_REPOSITORY_CHECK_MS = 30_000;

export const MAX_COMMIT_REPOSITORIES = 4096;
export const MAX_SOURCE_COMMIT_REPOSITORIES = 64;
export const MAX_COMMIT_REPOSITORY_BYTES = 4 * 1024 * 1024;

interface DirectoryIdentity {
  path: string;
  dev: string;
  ino: string;
}

export interface VerifiedCommitRepository {
  version: 2;
  file: string;
  stamp: RelationshipStamp;
  occurrence: string;
  dir: string;
  sha: string;
  root: DirectoryIdentity;
  common: DirectoryIdentity;
  command: DirectoryIdentity;
  recovered?: {
    intent: string;
    commit: Pick<TurnCommit, 'sha' | 'subject' | 'head' | 'files' | 'added' | 'removed' | 'at'>;
  };
}

function directoryIdentity(path: string): DirectoryIdentity | null {
  try {
    const physical = realpathSync(path);
    const stat = statSync(physical, { bigint: true });
    const revision = revisionOf(stat);
    return stat.isDirectory() && supportedFileIdentity(revision)
      ? { path: normalizeFsPath(physical), dev: String(revision.dev), ino: String(revision.ino) }
      : null;
  } catch {
    return null;
  }
}

function sameDirectory(held: DirectoryIdentity): boolean {
  const now = directoryIdentity(held.path);
  return now !== null && now.path === held.path && now.dev === held.dev && now.ino === held.ino;
}

export function validCommitRepository(value: unknown): value is VerifiedCommitRepository {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as VerifiedCommitRepository;
  const path = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 4096;
  const identity = (item: DirectoryIdentity | undefined): boolean =>
    !!item && path(item.path) && fileIdentityValue(item.dev) && fileIdentityValue(item.ino, true);
  const stamp = row.stamp;
  return (
    row.version === 2 &&
    path(row.file) &&
    path(row.dir) &&
    typeof row.occurrence === 'string' &&
    /^[a-f0-9]{64}$/.test(row.occurrence) &&
    typeof row.sha === 'string' &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.sha) &&
    identity(row.root) &&
    identity(row.common) &&
    identity(row.command) &&
    validRecovered(row.recovered) &&
    (!row.recovered || row.sha.startsWith(row.recovered.commit.sha.toLowerCase())) &&
    !!stamp &&
    fileIdentityValue(stamp.dev) &&
    fileIdentityValue(stamp.ino, true) &&
    Number.isSafeInteger(stamp.size) &&
    stamp.size >= 0 &&
    Number.isFinite(stamp.mtimeMs) &&
    stamp.mtimeMs >= 0 &&
    typeof stamp.mtimeNs === 'string' &&
    /^\d+$/.test(stamp.mtimeNs) &&
    typeof stamp.ctimeNs === 'string' &&
    /^\d+$/.test(stamp.ctimeNs) &&
    Number(BigInt(stamp.mtimeNs) / 1_000_000n) + Number(BigInt(stamp.mtimeNs) % 1_000_000n) / 1_000_000 ===
      stamp.mtimeMs
  );
}

function validRecovered(value: VerifiedCommitRepository['recovered']): boolean {
  if (value === undefined) return true;
  if (!value || typeof value.intent !== 'string' || value.intent.length > 8192 || !value.commit) return false;
  const row = value.commit;
  return (
    typeof row.sha === 'string' &&
    /^[a-f0-9]{7,64}$/i.test(row.sha) &&
    typeof row.subject === 'string' &&
    row.subject.length <= 65536 &&
    Number.isFinite(row.at) &&
    row.at >= 0 &&
    [row.files, row.added, row.removed].every((n) => n === null || (Number.isSafeInteger(n) && n >= 0)) &&
    (row.head == null ||
      row.head.kind === 'detached' ||
      (row.head.kind === 'branch' && typeof row.head.name === 'string' && row.head.name.length <= 4096))
  );
}

export function boundedCommitRepositories(rows: Iterable<VerifiedCommitRepository>): VerifiedCommitRepository[] {
  const result: VerifiedCommitRepository[] = [];
  const counts = new Map<string, number>();
  const keys = new Set<string>();
  let bytes = 0;
  for (const row of rows) {
    if (!validCommitRepository(row)) continue;
    const file = normalizeFsPath(row.file);
    const key = `${file}|${row.occurrence}`;
    if (keys.has(key) || (counts.get(file) ?? 0) >= MAX_SOURCE_COMMIT_REPOSITORIES) continue;
    const size = Buffer.byteLength(JSON.stringify(row));
    if (result.length >= MAX_COMMIT_REPOSITORIES || bytes + size > MAX_COMMIT_REPOSITORY_BYTES) break;
    result.push(row);
    keys.add(key);
    counts.set(file, (counts.get(file) ?? 0) + 1);
    bytes += size;
  }
  return result;
}

// A source that only grew keeps its device and inode and gains bytes.
function grewFrom(before: RelationshipStamp, now: RelationshipStamp): boolean {
  return before.dev === now.dev && before.ino === now.ino && now.size > before.size;
}

// Retain direct observations only. A saved occurrence never rebinds to a replacement command directory or matching clone.
export class CommitRepositories {
  private rows = new Map<string, VerifiedCommitRepository>();
  private readonly occurrences = new WeakMap<TurnCommit, string>();
  private readonly checked = new Map<string, { stamp: RelationshipStamp; valid: boolean; until: number }>();
  // Occurrences whose latest check failed. A later passing check clears them, and a new source revision does not.
  private readonly failed = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly sourceRevisions = new Map<string, { stamp: RelationshipStamp }>();
  private work: Promise<void> = Promise.resolve();
  private readonly reads = new Map<string, { until: number; answer: Promise<string | null> }>();

  constructor(
    private readonly runner: GitRunner,
    private readonly changed: () => void,
  ) {}

  load(rows: Iterable<VerifiedCommitRepository>): void {
    for (const row of boundedCommitRepositories(rows)) this.rows.set(this.key(row.file, row.occurrence), row);
  }

  snapshot(): VerifiedCommitRepository[] {
    return [...this.rows.values()];
  }

  prune(absent: (file: string) => boolean): boolean {
    let changed = false;
    for (const [key, row] of this.rows) {
      if (absent(row.file)) {
        this.rows.delete(key);
        changed = true;
      }
    }
    for (const file of this.sourceRevisions.keys()) {
      if (absent(file)) this.sourceRevisions.delete(file);
    }
    for (const key of [...this.checked.keys(), ...this.failed]) {
      if (absent(key.slice(0, key.lastIndexOf('|')))) {
        this.checked.delete(key);
        this.failed.delete(key);
      }
    }
    return changed;
  }

  restore(intent: CommitIntent, file: string | null, identities: string[]): TurnCommit[] | null {
    if (!file || !intent.source) return null;
    const rows = [...this.rows.values()].filter(
      (row) =>
        normalizeFsPath(row.file) === normalizeFsPath(file) &&
        row.recovered?.intent === intentKey(intent) &&
        sameRelationshipStamp(row.stamp, intent.source!.stamp),
    );
    if (rows.length !== intent.expected) return null;
    const commits: TurnCommit[] = [];
    for (const row of rows) {
      const commit: TurnCommit = {
        ...row.recovered!.commit,
        intent: row.recovered!.intent,
        dir: row.dir,
        place: null,
        source: intent.source,
      };
      this.occurrences.set(commit, row.occurrence);
      this.apply(commit, file, identities);
      if (commit.dir) commits.push(commit);
    }
    return commits.length === intent.expected ? commits : [];
  }

  apply(commit: TurnCommit, file: string | null, identities: string[]): boolean {
    if (!file) return false;
    let occurrence = this.occurrences.get(commit);
    if (!occurrence) {
      occurrence = createHash('sha256')
        .update(
          JSON.stringify([
            commit.sha,
            commit.intent,
            commit.printedSha,
            commit.at,
            commit.subject,
            commit.head,
            commit.files,
            commit.added,
            commit.removed,
            commit.dir && normalizeFsPath(commit.dir),
          ]),
        )
        .digest('hex');
      this.occurrences.set(commit, occurrence);
    }
    const key = this.key(file, occurrence);
    const row = this.rows.get(key);
    const source = commit.source;
    const now = commitSourceStamp(file);
    const accepted =
      source &&
      normalizeFsPath(source.file) === normalizeFsPath(file) &&
      now &&
      sameRelationshipStamp(source.stamp, now);
    const sourceFile = normalizeFsPath(file);
    const revision = this.sourceRevisions.get(sourceFile);
    if (accepted && revision && !sameRelationshipStamp(revision.stamp, source.stamp)) {
      this.sourceRevisions.delete(sourceFile);
      for (const held of this.checked.keys()) {
        if (held.slice(0, held.lastIndexOf('|')) === sourceFile) this.checked.delete(held);
      }
    }
    const checked = this.checked.get(key);
    const sameCheckRevision = checked && accepted && sameRelationshipStamp(checked.stamp, source.stamp);
    const currentCheck = sameCheckRevision && Date.now() < checked.until;
    if (row) {
      const sameDirs = sameDirectory(row.root) && sameDirectory(row.common);
      const valid = accepted && sameRelationshipStamp(row.stamp, now) && sameDirs;
      const rebind =
        accepted &&
        !sameRelationshipStamp(row.stamp, now) &&
        !sameCheckRevision &&
        sameDirectory(row.command) &&
        sameDirs;
      // A commit parsed from an earlier revision of a source that only grew still names its proof. The rebuilt commit follows.
      const grew =
        !accepted &&
        !!source &&
        !!now &&
        normalizeFsPath(source.file) === normalizeFsPath(file) &&
        grewFrom(source.stamp, now) &&
        sameRelationshipStamp(row.stamp, source.stamp) &&
        sameDirs;
      // The row keeps its group while the repository is checked again. A failed check removes the group until a later check passes.
      const proven = valid && currentCheck && checked.valid;
      const held = ((valid && !currentCheck) || rebind || grew) && !this.failed.has(key);
      commit.repository =
        proven || held
          ? { key: row.common.path, root: row.root.path, own: identities.includes(row.common.path) }
          : null;
      commit.place = commit.repository && !commit.repository.own ? { kind: 'named', dir: row.root.path } : null;
      commit.dir = proven ? row.root.path : null;
      if (valid && !currentCheck)
        void this.queue(key, file, source.stamp, async (current) => {
          const valid = await this.validate(row);
          if (current()) this.mark(key, source.stamp, valid);
        });
      else if (rebind) this.captureRow(key, file, source.stamp, occurrence, row.dir, row.sha, commit, row);
      return true;
    }
    if (!accepted || !commit.dir || commit.candidates || sameCheckRevision || !this.canCapture(file)) return false;
    const dir = commit.dir;
    const sha = commit.printedSha ?? commit.sha;
    this.captureRow(key, file, source.stamp, occurrence, dir, sha, commit);
    return false;
  }

  // The directory a proven commit opens in right now. Null when its proof is pending, failed, or no longer matches its source or directories.
  // Undefined when the commit holds no proof, so the caller keeps the directory it resolved from Git.
  openableDir(commit: TurnCommit): string | null | undefined {
    const occurrence = this.occurrences.get(commit);
    const file = commit.source?.file;
    const row = occurrence && file ? this.rows.get(this.key(file, occurrence)) : undefined;
    if (!row || !file || !commit.source) return undefined;
    const now = commitSourceStamp(file);
    const checked = this.checked.get(this.key(file, occurrence!));
    return now &&
      sameRelationshipStamp(commit.source.stamp, now) &&
      sameRelationshipStamp(row.stamp, now) &&
      checked?.valid &&
      sameRelationshipStamp(checked.stamp, now) &&
      Date.now() < checked.until &&
      sameDirectory(row.root) &&
      sameDirectory(row.common)
      ? row.root.path
      : null;
  }

  // The directory a proven commit opens in once its repository check has passed. An expired check, or a source that only grew, is checked first.
  // Null when the check fails. Undefined when the commit holds no proof.
  async openable(commit: TurnCommit): Promise<string | null | undefined> {
    const current = this.openableDir(commit);
    if (current !== null) return current;
    const occurrence = this.occurrences.get(commit);
    const source = commit.source;
    const row = occurrence && source ? this.rows.get(this.key(source.file, occurrence)) : undefined;
    const now = source && commitSourceStamp(source.file);
    if (!occurrence || !source || !row || !now) return null;
    const key = this.key(source.file, occurrence);
    const grown = grewFrom(source.stamp, now);
    const intact =
      !this.failed.has(key) &&
      sameRelationshipStamp(row.stamp, source.stamp) &&
      (grown || sameRelationshipStamp(source.stamp, now)) &&
      sameDirectory(row.root) &&
      sameDirectory(row.common);
    if (!intact) return null;
    await this.queue(key, source.file, source.stamp, async (live) => {
      const valid = await this.validate(row, grown);
      if (live()) this.mark(key, source.stamp, valid);
    });
    const checked = this.checked.get(key);
    return checked?.valid && sameRelationshipStamp(checked.stamp, source.stamp) && Date.now() < checked.until
      ? row.root.path
      : null;
  }

  private canCapture(file: string): boolean {
    const keys = new Set([...this.rows.keys(), ...this.checked.keys(), ...this.pending]);
    const source = normalizeFsPath(file);
    return (
      keys.size < MAX_COMMIT_REPOSITORIES &&
      [...keys].filter((key) => key.slice(0, key.lastIndexOf('|')) === source).length < MAX_SOURCE_COMMIT_REPOSITORIES
    );
  }

  private mark(key: string, stamp: RelationshipStamp, valid: boolean): void {
    this.checked.set(key, { stamp, valid, until: Date.now() + COMMIT_REPOSITORY_CHECK_MS });
    this.failed.delete(key);
    if (valid) return;
    this.failed.add(key);
    if (this.failed.size > MAX_COMMIT_REPOSITORIES) this.failed.delete(this.failed.values().next().value!);
  }

  private captureRow(
    key: string,
    file: string,
    stamp: RelationshipStamp,
    occurrence: string,
    dir: string,
    sha: string,
    commit: TurnCommit,
    previous?: VerifiedCommitRepository,
  ): void {
    if (this.pending.has(key)) return;
    // Saved occurrences refresh once per accepted revision, independently of admission for additional observations.
    void this.queue(key, file, stamp, async (current) => {
      const found = await this.capture(file, stamp, occurrence, dir, sha);
      if (!current()) return;
      const valid =
        found !== null &&
        (!previous ||
          (found.sha === previous.sha &&
            JSON.stringify(found.command) === JSON.stringify(previous.command) &&
            JSON.stringify(found.root) === JSON.stringify(previous.root) &&
            JSON.stringify(found.common) === JSON.stringify(previous.common)));
      this.mark(key, stamp, valid);
      if (valid) {
        if (commit.intent) {
          const { sha, subject, head, files, added, removed, at } = commit;
          found.recovered = { intent: commit.intent, commit: { sha, subject, head, files, added, removed, at } };
        } else if (previous?.recovered) found.recovered = previous.recovered;
        this.rows.set(key, found);
        this.rows = new Map(
          boundedCommitRepositories(this.rows.values()).map((one) => [this.key(one.file, one.occurrence), one]),
        );
      }
    });
  }

  private key(file: string, occurrence: string): string {
    return `${normalizeFsPath(file)}|${occurrence}`;
  }

  private queue(
    key: string,
    file: string,
    stamp: RelationshipStamp,
    read: (current: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (this.pending.has(key)) return this.work;
    const source = normalizeFsPath(file);
    let revision = this.sourceRevisions.get(source);
    if (!revision) {
      revision = { stamp };
      this.sourceRevisions.set(source, revision);
    }
    const current = () => this.sourceRevisions.get(source) === revision;
    this.pending.add(key);
    this.work = this.work
      .then(async () => {
        if (current()) await read(current);
      })
      .catch(() => {
        if (current()) this.mark(key, stamp, false);
      })
      .finally(() => {
        this.pending.delete(key);
        if (!this.pending.size) this.reads.clear();
        this.changed();
      });
    return this.work;
  }

  private read(dir: string, args: readonly string[]): Promise<string | null> {
    const key = JSON.stringify([normalizeFsPath(dir), args]);
    const held = this.reads.get(key);
    if (held && Date.now() < held.until) return held.answer;
    const answer = this.runner
      .run(dir, [...args])
      .catch(() => null)
      .then((value) => {
        if (value && Buffer.byteLength(value) > 256 * 1024 && this.reads.get(key)?.answer === answer)
          this.reads.delete(key);
        return value;
      });
    this.reads.set(key, { until: Date.now() + COMMIT_REPOSITORY_CHECK_MS, answer });
    if (this.reads.size > 16) this.reads.delete(this.reads.keys().next().value!);
    return answer;
  }

  // A grown source keeps the commit it printed, so its saved stamp is compared with the stamp the commit was parsed from by the caller.
  private async validate(row: VerifiedCommitRepository, grown = false): Promise<boolean> {
    if (!sameDirectory(row.root) || !sameDirectory(row.common)) return false;
    const place = parseIdentity(await this.read(row.root.path, IDENTITY_ARGS));
    const found = parseCommitLog((await this.read(row.root.path, exactCommitArgs(row.sha))) ?? '');
    const stamp = commitSourceStamp(row.file);
    return (
      place.commonDir === row.common.path &&
      normalizeFsPath(place.root ?? '') === row.root.path &&
      found.length === 1 &&
      found[0].sha.toLowerCase() === row.sha &&
      sameDirectory(row.root) &&
      sameDirectory(row.common) &&
      (grown || (!!stamp && sameRelationshipStamp(row.stamp, stamp)))
    );
  }

  private async capture(
    file: string,
    stamp: RelationshipStamp,
    occurrence: string,
    dir: string,
    sha: string,
  ): Promise<VerifiedCommitRepository | null> {
    const command = directoryIdentity(dir);
    if (!command) return null;
    const before = parseIdentity(await this.read(dir, IDENTITY_ARGS));
    if (!before.commonDir) return null;
    const common = directoryIdentity(before.commonDir);
    const found = parseCommitLog((await this.read(dir, exactCommitArgs(sha))) ?? '');
    if (
      !common ||
      !command ||
      found.length !== 1 ||
      !found[0].sha.toLowerCase().startsWith(sha.toLowerCase()) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(found[0].sha)
    )
      return null;
    const roots = parseWorktreeRoots(await this.read(dir, ['worktree', 'list', '--porcelain', '-z']));
    if (!roots.length || roots.length > 64) return null;
    // Git lists its main checkout first. Never derive it from a worktree pathname.
    const root = directoryIdentity(roots[0]);
    if (!root) return null;
    const row: VerifiedCommitRepository = {
      version: 2,
      file,
      stamp,
      occurrence,
      dir,
      sha: found[0].sha.toLowerCase(),
      root,
      common,
      command,
    };
    const after = parseIdentity(await this.runner.run(dir, [...IDENTITY_ARGS]).catch(() => null));
    return before.commonDir === common.path &&
      after.commonDir === common.path &&
      before.root === after.root &&
      sameDirectory(command) &&
      (await this.validate(row))
      ? row
      : null;
  }
}
