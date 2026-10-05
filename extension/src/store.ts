import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ARC_IDENTITY } from './identity';

export interface ManifestEntry {
  path: string;
  snapshot: string;
  isNew: boolean;
}
export interface Manifest {
  sessionId: string;
  cwd: string | null;
  title?: string | null;
  files: ManifestEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    typeof value.snapshot === 'string' &&
    value.snapshot.length > 0 &&
    typeof value.isNew === 'boolean'
  );
}

function isManifest(value: unknown): value is Manifest {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    (value.cwd === null || typeof value.cwd === 'string') &&
    (value.title === undefined || value.title === null || typeof value.title === 'string') &&
    Array.isArray(value.files) &&
    value.files.every(isManifestEntry)
  );
}

export function arcHome(): string {
  return process.env[`${ARC_IDENTITY.environmentPrefix}HOME`] || path.join(os.homedir(), ARC_IDENTITY.homeDirectory);
}

export function storeRoot(): string {
  return path.join(arcHome(), ARC_IDENTITY.snapshotsDirectory);
}

export function cacheRoot(): string {
  return path.join(arcHome(), 'cache');
}

export function projectSpendDirectory(workspaceCacheRoot: string): string {
  return path.join(workspaceCacheRoot, 'project-spend');
}

// One cache partition for one workspace. Its directory name is a digest of the normalized
// workspace identity, and the directory holds the project spend index and the derived session
// cache. A change to the normalization or to the digest leaves every saved partition behind.
export interface WorkspaceIdentity {
  workspaceFile: string | null;
  folders: string[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('A workspace identity holds a value that cannot be written to JSON.');
  }
  return encoded;
}

function normalizedWorkspaceFolder(folder: string): string {
  const unified = path.resolve(folder).replace(/\\/g, '/').replace(/\/$/, '');
  return /^[A-Za-z]:\//.test(unified) || process.platform === 'win32' ? unified.toLowerCase() : unified;
}

export function normalizedWorkspaceIdentity(
  folders: readonly string[],
  workspaceFile: string | null = null,
): WorkspaceIdentity {
  return {
    workspaceFile: workspaceFile ? normalizedWorkspaceFolder(workspaceFile) : null,
    folders: [...new Set(folders.map(normalizedWorkspaceFolder))].sort(),
  };
}

// A window with no folder has no identity to reuse, so it returns null.
export function workspaceCacheKey(identity: WorkspaceIdentity): string | null {
  if (identity.workspaceFile === null && identity.folders.length === 0) {
    return null;
  }
  return crypto.createHash('sha256').update(stableJson(identity)).digest('hex');
}

function rejectLinkedDestination(target: string): void {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Saved data cannot be written through a linked folder or file: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

// A workspace reuses its own partition. A window with no folder gets a fresh partition that no
// later window reuses. Allocation creates no directory.
export function createWorkspaceCacheRoot(cacheDirectory: string, identity: WorkspaceIdentity): string {
  const resolvedCacheDirectory = path.resolve(cacheDirectory);
  rejectLinkedDestination(resolvedCacheDirectory);
  const reusableKey = workspaceCacheKey(identity);
  if (reusableKey) {
    const partition = path.join(resolvedCacheDirectory, reusableKey);
    rejectLinkedDestination(partition);
    return partition;
  }
  return path.join(resolvedCacheDirectory, `folderless-${crypto.randomUUID()}`);
}

export const FOLDERLESS_OWNER_FILE = 'owner.json';
export const FOLDERLESS_CLEANUP_LIMITS = { operations: 0, ownerBytes: 4096 } as const;
const FOLDERLESS_NAME = /^folderless-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface CacheOwner {
  version: 1;
  generation: string;
  pid: number;
  platform: NodeJS.Platform;
  lifetime: { boot: string; namespace: string; start: string } | null;
}

function boundedTextSync(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(FOLDERLESS_CLEANUP_LIMITS.ownerBytes + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length === bytes.length) throw new Error('Cache ownership exceeds its size limit.');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function linuxProcessStart(stat: string): { state: string; start: string } | null {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  return /^[0-9]+$/.test(fields[19] ?? '') && /^[A-Z]$/.test(fields[0] ?? '')
    ? { state: fields[0], start: fields[19] }
    : null;
}

function cacheOwner(generation: string): CacheOwner {
  let lifetime: CacheOwner['lifetime'] = null;
  if (process.platform === 'linux') {
    try {
      const stat = linuxProcessStart(boundedTextSync(`/proc/${process.pid}/stat`));
      if (stat)
        lifetime = {
          boot: boundedTextSync('/proc/sys/kernel/random/boot_id').trim(),
          namespace: fs.readlinkSync('/proc/self/ns/pid'),
          start: stat.start,
        };
    } catch {
      /* An unavailable lifetime keeps the partition uncertain. */
    }
  }
  return { version: 1, generation, pid: process.pid, platform: process.platform, lifetime };
}

export function linuxCacheOwnerStatus(
  owner: CacheOwner,
  observed: { boot: string; namespace: string; stat: string },
): 'live' | 'abandoned' | 'uncertain' {
  if (owner.platform !== 'linux' || !owner.lifetime || observed.namespace !== owner.lifetime.namespace)
    return 'uncertain';
  if (observed.boot !== owner.lifetime.boot) return 'uncertain';
  const stat = linuxProcessStart(observed.stat);
  if (!stat) return 'uncertain';
  return stat.start !== owner.lifetime.start || stat.state === 'Z' || stat.state === 'X' ? 'abandoned' : 'live';
}

// Released generations keep their own paths. Resumed writes allocate a fresh path.
export class WorkspaceCachePartition {
  private materialized = false;
  private closed = false;
  private flushing = false;
  private owner: CacheOwner | null = null;
  root: string;
  constructor(
    private readonly cacheDirectory: string,
    private readonly identity: WorkspaceIdentity,
  ) {
    this.root = createWorkspaceCacheRoot(cacheDirectory, identity);
  }

  write(write: () => void, flush = false, destination = this.root): boolean {
    if (this.closed && !(flush && this.flushing)) return false;
    rejectLinkedDestination(this.root);
    rejectLinkedDestination(destination);
    rejectLinkedDestination(path.join(this.root, FOLDERLESS_OWNER_FILE));
    if (!workspaceCacheKey(this.identity) && !this.materialized) {
      const generation = FOLDERLESS_NAME.exec(path.basename(this.root))![1];
      const owner = cacheOwner(generation);
      fs.mkdirSync(path.dirname(this.root), { recursive: true });
      fs.mkdirSync(this.root);
      fs.writeFileSync(path.join(this.root, FOLDERLESS_OWNER_FILE), JSON.stringify(owner), { flag: 'wx' });
      this.owner = owner;
      this.materialized = true;
    }
    if (this.owner && !this.ownsCurrentGeneration()) return false;
    write();
    return true;
  }

  private ownsCurrentGeneration(): boolean {
    if (!this.owner) return false;
    try {
      rejectLinkedDestination(this.root);
      const file = path.join(this.root, FOLDERLESS_OWNER_FILE);
      rejectLinkedDestination(file);
      if (!fs.lstatSync(file).isFile()) return false;
      return boundedTextSync(file) === JSON.stringify(this.owner);
    } catch {
      return false;
    }
  }

  close(flush: () => void = () => {}): void {
    if (this.closed) return;
    this.closed = true;
    this.flushing = true;
    try {
      flush();
    } finally {
      this.flushing = false;
    }
    if (this.owner && this.ownsCurrentGeneration()) {
      try {
        rejectLinkedDestination(this.root);
        fs.writeFileSync(path.join(this.root, 'released.json'), JSON.stringify({ generation: this.owner.generation }), {
          flag: 'wx',
        });
      } catch {
        /* Failed release retains uncertain ownership. */
      }
    }
  }

  resume(): void {
    if (!this.closed) return;
    this.root = createWorkspaceCacheRoot(this.cacheDirectory, this.identity);
    this.owner = null;
    this.materialized = false;
    this.closed = false;
  }
}

export interface FolderlessCleanupOptions {
  signal: AbortSignal;
  platform?: NodeJS.Platform;
  inspect?: (owner: CacheOwner) => Promise<'live' | 'abandoned' | 'uncertain'>;
  onBatch?: (operations: number) => void;
}

// Node's pathname deletion cannot bind removal to every validated directory identity.
// Retain written partitions on every platform until that boundary can be established.
export function reclaimFolderlessCaches(_cacheDirectory: string, options: FolderlessCleanupOptions): Promise<void> {
  options.onBatch?.(0);
  return Promise.resolve();
}

export function readManifest(file: string): Manifest | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isManifest(value) ? value : null;
  } catch {
    return null;
  }
}

// Whether a multi-diff editor's tab label belongs to the given title. VS Code appends a
// dynamic " (N file[s])" count to the title set via `vscode.changes`, so match on the title
// prefix rather than equality. The trailing " (" guard prevents matching a different session
// whose label merely starts with this one (e.g. "repo" vs "repo-2").
export function tabLabelMatchesTitle(tabLabel: string, title: string): boolean {
  return tabLabel === title || tabLabel.startsWith(`${title} (`);
}

// True if `target` equals, or is nested under, any of `folders`. Used to decide
// whether a session's cwd belongs to the current VS Code window's workspace.
export function isPathWithin(target: string, folders: string[]): boolean {
  if (!target) {
    return false;
  }
  return folders.some((f) => {
    if (!f) {
      return false;
    }
    const base = f.endsWith(path.sep) ? f.slice(0, -1) : f;
    return target === base || target.startsWith(base + path.sep);
  });
}

// Compare two files chunk by chunk with early exit. This runs on the shared extension-host
// event loop, where reading whole files into memory would stall every extension in the
// host once a manifest references enough large files, so memory stays bounded regardless
// of file size and runtime stops at the first differing chunk.
const COMPARE_CHUNK = 1 << 20;
function filesEqual(a: string, b: string, size: number): boolean {
  let fa = -1,
    fb = -1;
  try {
    fa = fs.openSync(a, 'r');
    fb = fs.openSync(b, 'r');
    const bufA = Buffer.allocUnsafe(Math.min(COMPARE_CHUNK, size));
    const bufB = Buffer.allocUnsafe(Math.min(COMPARE_CHUNK, size));
    let pos = 0;
    while (pos < size) {
      const n = fs.readSync(fa, bufA, 0, bufA.length, pos);
      const m = fs.readSync(fb, bufB, 0, bufB.length, pos);
      if (n !== m) {
        return false;
      }
      if (n <= 0) {
        return true;
      } // both hit EOF early (file changed mid-scan); next refresh recheck
      if (!bufA.subarray(0, n).equals(bufB.subarray(0, m))) {
        return false;
      }
      pos += n;
    }
    return true;
  } catch {
    return false;
  } // unreadable mid-compare -> treat as differing; next refresh recheck
  finally {
    if (fa >= 0) {
      try {
        fs.closeSync(fa);
      } catch {
        /* ignore */
      }
    }
    if (fb >= 0) {
      try {
        fs.closeSync(fb);
      } catch {
        /* ignore */
      }
    }
  }
}

// Whether the live file still differs from its baseline on disk. A file reverted by the
// native revert arrow or a manual edit stops differing. Sizes are compared
// first so most differing files resolve on two stats without any content read.
export function fileDiffersOnDisk(entry: ManifestEntry): boolean {
  let liveStat: fs.Stats;
  try {
    liveStat = fs.statSync(entry.path);
  } catch {
    return false;
  } // deleted -> resolved
  if (!liveStat.isFile()) {
    return false;
  } // replaced by a directory etc. -> nothing left to diff
  const liveSize = liveStat.size;
  let baseSize = 0;
  try {
    baseSize = fs.statSync(entry.snapshot).size;
  } catch {
    /* missing snapshot -> empty baseline */
  }
  if (liveSize !== baseSize) {
    return true;
  }
  if (liveSize === 0) {
    return false;
  }
  return !filesEqual(entry.path, entry.snapshot, liveSize);
}

// Sessions under `root` whose cwd is inside one of `workspaceFolders` and that still have
// files differing from their snapshots, each narrowed to those files. Taking the folders as
// an argument, rather than reading the VS Code API, keeps it unit-testable.
export function pendingSessions(
  root: string,
  workspaceFolders: string[],
): { manifestFile: string; manifest: Manifest }[] {
  const out: { manifestFile: string; manifest: Manifest }[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const manifestFile = path.join(root, d, 'manifest.json');
    const manifest = readManifest(manifestFile);
    if (!manifest || !manifest.cwd || !isPathWithin(manifest.cwd, workspaceFolders)) {
      continue;
    }
    const pending = manifest.files.filter(fileDiffersOnDisk);
    if (pending.length > 0) {
      out.push({ manifestFile, manifest: { ...manifest, files: pending } });
    }
  }
  return out;
}

// How long a session's snapshots are kept, in days. Age is the only thing that ends a
// session, because nothing ever marks a file as dealt with: a rule waiting for that would
// hold every session until its transcript expired, and the store would only grow. A month is
// longer than any turn a reader comes back to, and the snapshots are the exact pre-edit
// files, which is what makes a diff of a recent turn exact rather than a guess.
export const SNAPSHOT_KEEP_DAYS = 30;

// Delete session folders whose last turn is older than maxAgeDays, by the trigger file's
// mtime, falling back to the folder's own. Returns the names of the folders removed.
// maxAgeDays <= 0 disables the sweep.
export function sweepOldSessions(
  root: string,
  maxAgeDays: number = SNAPSHOT_KEEP_DAYS,
  now: number = Date.now(),
): string[] {
  if (!(maxAgeDays > 0)) {
    return [];
  }
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    let mtime = stat.mtimeMs;
    try {
      mtime = fs.statSync(path.join(dir, 'trigger')).mtimeMs;
    } catch {
      /* fall back to dir mtime */
    }
    if ((now - mtime) / 86400000 <= maxAgeDays) {
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(d);
    } catch {
      /* ignore */
    }
  }
  return removed;
}
