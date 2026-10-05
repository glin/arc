import type { GitRunner } from './gitcommits';
import { normalizeFsPath } from './transcript';

const WORKTREE_LIST_ARGS = ['worktree', 'list', '--porcelain', '-z'];

export const REPOSITORY_SCOPE_REFRESH_MS = 15 * 1000;

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

function rootsEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((root, index) => normalizeFsPath(root) === normalizeFsPath(right[index]))
  );
}

// Resolves the registered worktrees of the repositories containing the open folders.
// Listing stays synchronous: it uses the last successful answer for each folder while Git
// refreshes in the background. A failed read retains that folder's prior roots, because a
// temporary Git failure must not remove sessions or reader state from the panel.
export class RepositoryScope {
  private folderKey: string | null = null;
  private folders: string[] = [];
  private roots: string[] = [];
  private rootsByFolder = new Map<string, string[]>();
  private ready = false;
  private revision = 0;
  private generation = 0;
  private checking = false;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    private readonly runner: GitRunner,
    private readonly onChanged: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(folders: string[]): RepositoryScopeSnapshot {
    const nextFolders = uniqueRoots(folders);
    const nextFolderKeys = new Set(nextFolders.map(rootKey));
    const nextKey = [...nextFolderKeys].join('\0');
    if (nextKey !== this.folderKey) {
      this.folderKey = nextKey;
      this.folders = nextFolders;
      this.roots = nextFolders;
      for (const key of this.rootsByFolder.keys()) {
        if (!nextFolderKeys.has(key)) {
          this.rootsByFolder.delete(key);
        }
      }
      this.ready = nextFolders.length === 0;
      this.checking = false;
      this.checkedAt = Number.NEGATIVE_INFINITY;
      this.generation++;
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
        for (const answer of answers) {
          if (answer.stdout === null) {
            continue;
          }
          this.rootsByFolder.set(
            rootKey(answer.folder),
            uniqueRoots([answer.folder, ...parseWorktreeRoots(answer.stdout)]),
          );
        }
        const next = uniqueRoots([...folders, ...this.rootsByFolder.values()].flat());
        const moved = !rootsEqual(next, this.roots);
        this.ready = true;
        this.checking = false;
        if (moved) {
          this.roots = next;
          this.revision++;
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
