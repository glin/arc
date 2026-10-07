import type { GitRunner } from './gitcommits';
import { isInside, normalizeFsPath } from './transcript';

const WORKTREE_LIST_ARGS = ['worktree', 'list', '--porcelain', '-z'];

export const REPOSITORY_SCOPE_REFRESH_MS = 15 * 1000;

// How long a Git answer that removes roots waits for a second answer to confirm the removal.
export const REPOSITORY_SCOPE_CONFIRM_MS = 5 * 1000;

// How many times in a row a held removal asks Git again soon after a failed read. After that it waits for the regular interval.
export const REPOSITORY_SCOPE_FAILED_RECHECKS = 3;

// What the scope did with one Git answer. An answer that removes roots is held for confirmation. A later answer confirms the held
// roots that it also removes, and holds the roots that it newly removes. A later answer that lists held roots again discards their
// removal. The answer that ends the quick rechecks after failed reads records that the removal stays held.
export type RepositoryScopeDecisionKind =
  | 'accepted'
  | 'held for confirmation'
  | 'confirmed'
  | 'discarded'
  | 'held after failed reads';

export interface RepositoryScopeDecision {
  decision: RepositoryScopeDecisionKind;
  // The roots the scope published before the answer.
  previous: string[];
  // The roots the answer lists, including the open folders, without the registered roots nested inside another of them.
  answered: string[];
  // The roots the scope publishes after the answer.
  applied: string[];
  // The roots of a held removal that a folder whose Git read succeeded lists again, including those of an answer that confirms only
  // part of it.
  restored: string[];
  // The combined length of the Git output for every open folder, and the number of folders whose Git read failed.
  stdoutLength: number;
  failed: number;
}

export interface RepositoryScopeSnapshot {
  ready: boolean;
  revision: number;
  roots: string[];
}

export function parseWorktreeRoots(stdout: string | null): string[] {
  if (stdout === null) {
    return [];
  }
  return stdout
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length))
    .filter(Boolean);
}

function uniqueRoots(roots: Iterable<string>): string[] {
  const found = new Map<string, string>();
  for (const root of roots) {
    const key = rootKey(root);
    if (key && !found.has(key)) {
      found.set(key, root);
    }
  }
  return [...found.values()].sort((a, b) => normalizeFsPath(a).localeCompare(normalizeFsPath(b)));
}

function rootKey(root: string): string {
  const normalized = normalizeFsPath(root);
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

// Drops each registered root that lies strictly inside another root of the list. Membership already admits a session under an
// enclosing root, so a nested worktree adds no session and must not move the scope. Open folders always stay. Containment runs only
// from a root toward its ancestors, so an open subfolder keeps its enclosing repository root.
function withoutNestedRoots(roots: string[], folders: string[]): string[] {
  const open = new Set(folders.map(rootKey));
  return roots.filter(
    (root) =>
      open.has(rootKey(root)) || !roots.some((other) => rootKey(other) !== rootKey(root) && isInside(root, [other])),
  );
}

function rootsEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((root, index) => normalizeFsPath(root) === normalizeFsPath(right[index]))
  );
}

// Resolves the registered worktrees of the repositories containing the open folders.
// Listing stays synchronous: it uses the last successful answer for each folder while Git
// refreshes in the background. Each folder keeps its raw Git answer, and the published roots leave out a registered worktree nested
// inside another root. A failed read retains that folder's prior roots, because a
// temporary Git failure must not remove sessions or reader state from the panel. After the first
// answer, an answer that removes a root keeps it until a second answer also removes it, because Git
// can briefly list fewer worktrees than the repository has. An answer that adds roots applies at once.
export class RepositoryScope {
  private folderKey: string | null = null;
  private folders: string[] = [];
  private roots: string[] = [];
  // The roots before nested ones are left out. Removal confirmation compares each answer with these, so a nested root that a removed
  // ancestor hid still needs two answers that omit it.
  private retained: string[] = [];
  private rootsByFolder = new Map<string, string[]>();
  private ready = false;
  private revision = 0;
  private generation = 0;
  private checking = false;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private disposed = false;
  // The root keys of a removal that waits for a second answer, and the timer that asks for it.
  private pendingRemoval: Set<string> | null = null;
  private recheck: ReturnType<typeof setTimeout> | null = null;
  // The rechecks in a row that followed a failed read while a removal was held.
  private failedRechecks = 0;

  constructor(
    private readonly runner: GitRunner,
    private readonly onChanged: () => void,
    private readonly now: () => number = Date.now,
    private readonly report: (decision: RepositoryScopeDecision) => void = () => {},
  ) {}

  snapshot(folders: string[]): RepositoryScopeSnapshot {
    const nextFolders = uniqueRoots(folders);
    const nextFolderKeys = new Set(nextFolders.map(rootKey));
    const nextKey = [...nextFolderKeys].join('\0');
    if (nextKey !== this.folderKey) {
      this.folderKey = nextKey;
      this.folders = nextFolders;
      this.roots = nextFolders;
      this.retained = nextFolders;
      for (const key of this.rootsByFolder.keys()) {
        if (!nextFolderKeys.has(key)) {
          this.rootsByFolder.delete(key);
        }
      }
      this.ready = nextFolders.length === 0;
      this.checking = false;
      this.checkedAt = Number.NEGATIVE_INFINITY;
      this.generation++;
      this.clearPendingRemoval();
    }
    if (
      !this.disposed &&
      !this.checking &&
      (!this.ready || this.now() - this.checkedAt >= REPOSITORY_SCOPE_REFRESH_MS)
    ) {
      this.startRefresh();
    }
    return { ready: this.ready, revision: this.revision, roots: [...this.roots] };
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.clearPendingRemoval();
  }

  private clearPendingRemoval(): void {
    this.pendingRemoval = null;
    this.failedRechecks = 0;
    if (this.recheck !== null) clearTimeout(this.recheck);
    this.recheck = null;
  }

  // Asks Git again soon, so a held removal waits seconds rather than the full refresh interval.
  private scheduleRecheck(): void {
    if (this.recheck !== null) clearTimeout(this.recheck);
    const generation = this.generation;
    this.recheck = setTimeout(() => {
      this.recheck = null;
      if (!this.disposed && generation === this.generation && !this.checking) this.startRefresh();
    }, REPOSITORY_SCOPE_CONFIRM_MS);
  }

  private startRefresh(): void {
    const generation = this.generation;
    const folders = [...this.folders];
    if (folders.length === 0) {
      return;
    }
    this.checking = true;
    this.checkedAt = this.now();
    void Promise.all(
      folders.map(async (folder) => ({
        folder,
        stdout: await this.runner.run(folder, [...WORKTREE_LIST_ARGS]).catch(() => null),
      })),
    ).then(
      (answers) => {
        if (this.disposed || generation !== this.generation) {
          return;
        }
        const priorReady = this.ready;
        const candidate = new Map(this.rootsByFolder);
        for (const answer of answers) {
          if (answer.stdout === null) {
            continue;
          }
          candidate.set(rootKey(answer.folder), uniqueRoots([answer.folder, ...parseWorktreeRoots(answer.stdout)]));
        }
        const failedKeys = new Set(
          answers.filter((answer) => answer.stdout === null).map((answer) => rootKey(answer.folder)),
        );
        const failed = failedKeys.size;
        const previous = this.retained;
        const previousPublished = this.roots;
        const answered = uniqueRoots([...folders, ...candidate.values()].flat());
        const published = withoutNestedRoots(answered, folders);
        const answeredKeys = new Set(answered.map(rootKey));
        // The roots that a folder whose Git read succeeded lists in this answer. A failed folder contributes only its stored roots.
        const listedKeys = new Set(
          [...folders, ...[...candidate].flatMap(([key, roots]) => (failedKeys.has(key) ? [] : roots))].map(rootKey),
        );
        const removed = previous.filter((root) => !answeredKeys.has(rootKey(root)));
        const pending = this.pendingRemoval;
        const isHeld = (root: string) => pending?.has(rootKey(root)) ?? false;
        let decision: RepositoryScopeDecisionKind | null = null;
        // The held roots that an answering folder lists again, and the held roots that only a failed folder still stores. A failed
        // read can neither confirm nor discard the held roots of its own folder, so those stay held.
        const restored = priorReady ? previous.filter((root) => isHeld(root) && listedKeys.has(rootKey(root))) : [];
        const unverified = priorReady
          ? previous.filter((root) => isHeld(root) && !listedKeys.has(rootKey(root)) && answeredKeys.has(rootKey(root)))
          : [];
        let next = answered;
        if (!priorReady) {
          decision = 'accepted';
        } else {
          // Two answers must agree on each removed root. The answer confirms the held roots it also removes, and holds the roots it
          // newly removes until the next answer.
          const fresh = removed.filter((root) => !isHeld(root));
          if (removed.length > 0) {
            decision = fresh.length < removed.length ? 'confirmed' : 'held for confirmation';
          } else if (restored.length > 0) {
            decision = 'discarded';
          } else if (!rootsEqual(published, previousPublished)) {
            decision = 'accepted';
          }
          if (fresh.length > 0 || unverified.length === 0) {
            this.clearPendingRemoval();
          }
          if (fresh.length > 0 || unverified.length > 0) {
            this.pendingRemoval = new Set([...fresh, ...unverified].map(rootKey));
            next = uniqueRoots([...answered, ...fresh]);
            if (fresh.length > 0) {
              this.scheduleRecheck();
            } else if (this.failedRechecks < REPOSITORY_SCOPE_FAILED_RECHECKS) {
              // A failed read keeps part of the removal held. The scope asks again soon a few times, then waits for the regular
              // interval.
              this.failedRechecks++;
              this.scheduleRecheck();
            } else {
              if (this.recheck !== null) clearTimeout(this.recheck);
              this.recheck = null;
              if (this.failedRechecks === REPOSITORY_SCOPE_FAILED_RECHECKS) {
                this.failedRechecks++;
                decision ??= 'held after failed reads';
              }
            }
          }
        }
        // A held removal keeps each folder's prior held roots beside its new answer, so a later failed read cannot confirm it.
        const held = this.pendingRemoval;
        for (const [key, roots] of candidate) {
          const prior = this.rootsByFolder.get(key) ?? [];
          this.rootsByFolder.set(
            key,
            held ? uniqueRoots([...roots, ...prior.filter((root) => held.has(rootKey(root)))]) : roots,
          );
        }
        // Removal confirmation and failed-read retention above read the raw answers and the retained roots. Only the published roots
        // leave out nested ones.
        this.retained = next;
        const publishedNext = withoutNestedRoots(next, folders);
        const moved = !rootsEqual(publishedNext, previousPublished);
        this.ready = true;
        this.checking = false;
        if (moved) {
          this.roots = publishedNext;
          this.revision++;
        }
        // A removal that names only nested roots keeps its hold and recheck, but it records no decision unless the published roots move.
        const publishedKeys = new Set(previousPublished.map(rootKey));
        const nestedRemovalOnly =
          (decision === 'held for confirmation' || decision === 'confirmed') &&
          !moved &&
          !removed.some((root) => publishedKeys.has(rootKey(root)));
        if (decision && !nestedRemovalOnly) {
          this.report({
            decision,
            previous: [...previousPublished],
            answered: published,
            applied: [...this.roots],
            restored,
            stdoutLength: answers.reduce((length, answer) => length + (answer.stdout?.length ?? 0), 0),
            failed,
          });
        }
        if (!priorReady || moved) {
          this.onChanged();
        }
      },
      () => {
        if (this.disposed || generation !== this.generation) {
          return;
        }
        this.ready = true;
        this.checking = false;
        this.onChanged();
      },
    );
  }
}
