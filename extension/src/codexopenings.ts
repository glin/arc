import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { writeFileAtomically } from './atomicfile';
import type { CodexSessionMeta } from './codex';

// The shape and the meaning of a stored Codex opening record. A stored row at another version
// is dropped at load, and the rollout's head is read again.
//
// Bump it when `CodexSessionMeta` gains or loses a field, and when the rule behind a stored
// field changes. The rules live in `readCodexOpeningRecord` in `codex.ts` and the helpers it
// derives a stored field with: `codexStartedAt`, `codexReplayBoundaryAt`, `guardianPayloadAt`,
// `stamp`, `codexAgentPath`, and what they call. A changed rule keeps a valid shape, so nothing
// else rejects the old row, and a rollout's opening record is read only once.
//
// It is apart from `VERSION` in `derivedcache.ts`, because every rollout on the machine has a
// row here. A bump costs one read of every rollout's head, which is seconds at startup.
export const CODEX_META_VERSION = 3;

// A file written before rows carried their own version names none. Versions 27 through 29 of
// the derived session cache hold rows with the version 1 shape and meaning. Version 27 is the
// first with `startedAt`, so an older file keeps no rows.
const LEGACY_CODEX_META_VERSIONS: ReadonlyMap<number, number> = new Map([
  [27, 1],
  [28, 1],
  [29, 1],
]);

// A save takes over a lock older than this. Its holder is a window that died holding it, or a
// live window that paused past this age. A save holds the lock for one read and one write of
// the file, which takes well under a second.
export const CODEX_OPENINGS_LOCK_STALE_MS = 30_000;

interface StoredOpenings {
  codexMetaVersion: number;
  codexMetas: { file: string; meta: CodexSessionMeta }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function nullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

// Whether a stored value has every field `CodexSessionMeta` holds, so a row that lacks one
// drops alone.
export function isStoredCodexMeta(value: unknown): value is CodexSessionMeta {
  return (
    record(value) &&
    (value.sessionId === null || nonEmptyText(value.sessionId)) &&
    (value.cwd === null || nonEmptyText(value.cwd)) &&
    (value.modelProvider === null || nonEmptyText(value.modelProvider)) &&
    nullableFinite(value.openedAt) &&
    nullableFinite(value.startedAt) &&
    nullableFinite(value.replayBoundaryAt) &&
    (value.nativeSpawnedAt === undefined || nullableFinite(value.nativeSpawnedAt)) &&
    (value.launchSource === null || nonEmptyText(value.launchSource)) &&
    (value.threadSource === null || nonEmptyText(value.threadSource)) &&
    (value.parentThreadId === null || nonEmptyText(value.parentThreadId)) &&
    (value.agentPath === null || nonEmptyText(value.agentPath)) &&
    (value.subagentKind === null || nonEmptyText(value.subagentKind)) &&
    typeof value.hasSubagentSource === 'boolean'
  );
}

// The Codex opening rows a parsed cache file holds, or none when they were derived under
// another `CODEX_META_VERSION`. Both the shared file and the older workspace file go through
// here.
export function storedCodexMetas(parsed: unknown): Map<string, CodexSessionMeta> {
  const rows = new Map<string, CodexSessionMeta>();
  if (!record(parsed) || !Array.isArray(parsed.codexMetas)) {
    return rows;
  }
  const version =
    parsed.codexMetaVersion === undefined
      ? typeof parsed.version === 'number'
        ? LEGACY_CODEX_META_VERSIONS.get(parsed.version)
        : undefined
      : parsed.codexMetaVersion;
  if (version !== CODEX_META_VERSION) {
    return rows;
  }
  for (const row of parsed.codexMetas) {
    if (record(row) && nonEmptyText(row.file) && isStoredCodexMeta(row.meta)) {
      rows.set(row.file, row.meta);
    }
  }
  return rows;
}

// The rows of the machine's shared file, or null when the file is missing or unreadable. Null
// is what lets the caller seed from an older workspace file.
export function loadCodexOpenings(file: string): Map<string, CodexSessionMeta> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return storedCodexMetas(JSON.parse(text));
  } catch {
    return null;
  }
}

// The Codex opening rows a window starts with. The machine's shared file answers when it
// exists. A missing one takes the rows an older workspace file holds, read under the same
// version rule, and `seeded` says the first save must write them into the shared file.
export function codexOpeningsAtStartup(
  sharedFile: string,
  workspaceRows: ReadonlyMap<string, CodexSessionMeta> | undefined,
): { rows: ReadonlyMap<string, CodexSessionMeta>; seeded: boolean } {
  const shared = loadCodexOpenings(sharedFile);
  return shared ? { rows: shared, seeded: false } : { rows: workspaceRows ?? new Map(), seeded: true };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Creates `file` holding `token`, or answers false when it exists.
function createExclusive(file: string, token: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch {
    return false;
  }
  let written = false;
  try {
    fs.writeSync(fd, token);
    written = true;
  } catch {
    /* removed below */
  } finally {
    fs.closeSync(fd);
  }
  if (!written) {
    fs.rmSync(file, { force: true });
  }
  return written;
}

// Removes a lock past `CODEX_OPENINGS_LOCK_STALE_MS` and takes it. Two windows can judge the
// same lock stale, so the removal runs under a guard file named for that lock's text and time.
// Only the window that creates the guard removes the lock, and it reads the lock again first.
// A window that finds the guard taken, or a lock other than the one it judged stale, backs off.
// `judged` runs once this window has judged the lock stale.
function takeStaleLock(lock: string, token: string, now: number, judged?: () => void): boolean {
  let mtimeMs: number;
  let text: string;
  try {
    mtimeMs = fs.statSync(lock).mtimeMs;
    if (now - mtimeMs < CODEX_OPENINGS_LOCK_STALE_MS) {
      return false;
    }
    text = fs.readFileSync(lock, 'utf8');
  } catch {
    // The holder released the lock between the tries.
    return false;
  }
  judged?.();
  const identity = createHash('sha1').update(`${mtimeMs}\n${text}`).digest('hex').slice(0, 16);
  const guard = `${lock}.${identity}.takeover`;
  if (!createExclusive(guard, token)) {
    // A window that died between taking the guard and removing it leaves the guard behind.
    try {
      if (now - fs.statSync(guard).mtimeMs >= CODEX_OPENINGS_LOCK_STALE_MS) {
        fs.rmSync(guard, { force: true });
      }
    } catch {
      /* already removed */
    }
    return false;
  }
  try {
    if (fs.statSync(lock).mtimeMs !== mtimeMs || fs.readFileSync(lock, 'utf8') !== text) {
      return false;
    }
    fs.unlinkSync(lock);
  } catch {
    return false;
  } finally {
    fs.rmSync(guard, { force: true });
  }
  return createExclusive(lock, token);
}

// A window that dies after it removed a stale lock and before it removed its guard leaves that
// guard behind. The guard names a lock that no longer exists, so no takeover meets it again.
// The holder of the lock removes every guard past `CODEX_OPENINGS_LOCK_STALE_MS`, the same age
// at which a takeover removes the guard it meets.
function removeAbandonedGuards(lock: string, now: number): void {
  const directory = path.dirname(lock);
  const prefix = `${path.basename(lock)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.takeover')) {
      continue;
    }
    const guard = path.join(directory, name);
    try {
      if (now - fs.statSync(guard).mtimeMs >= CODEX_OPENINGS_LOCK_STALE_MS) {
        fs.rmSync(guard, { force: true });
      }
    } catch {
      /* already removed */
    }
  }
}

// Takes the lock beside the shared file and answers the token it holds, or null when another
// writer holds it. The holder reads the token back before it replaces the file and before it
// removes the lock, so a holder whose lock was taken from it writes and removes nothing.
export function takeCodexOpeningsLock(lock: string, now = Date.now(), judged?: () => void): string | null {
  const token = `${process.pid}.${randomUUID()}`;
  if (!createExclusive(lock, token) && !takeStaleLock(lock, token, now, judged)) {
    return null;
  }
  removeAbandonedGuards(lock, now);
  return token;
}

export function releaseCodexOpeningsLock(lock: string, token: string): void {
  if (readText(lock) === token) {
    fs.rmSync(lock, { force: true });
  }
}

// Saves this window's Codex opening rows into the machine's shared file, merged with what the
// file holds. Every window writes this file, so the read, the merge and the write run under a
// lock file beside it. A busy lock skips the save and answers false, so a save never waits.
//
// The merge takes rows for the rollouts in `walked`, this window's latest complete walk, from
// `rows` first and the file second. A walked rollout that the file lacks keeps its row only
// while the rollout exists, because another window can have removed its row after this walk.
// A row of the file outside the walk stays only while its rollout exists, which covers a
// rollout another window saw first. Every other row is dropped, so a deleted rollout never
// comes back and the file stays bounded by the rollouts on disk.
export function saveCodexOpenings(
  file: string,
  rows: ReadonlyMap<string, CodexSessionMeta>,
  walked: Iterable<string>,
  replace: (temporary: string, target: string) => void = fs.renameSync,
  exists: (rollout: string) => boolean = fs.existsSync,
): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const token = takeCodexOpeningsLock(lock);
  if (token === null) {
    return false;
  }
  try {
    const disk = loadCodexOpenings(file) ?? new Map<string, CodexSessionMeta>();
    const seen = new Set(walked);
    const merged = new Map<string, CodexSessionMeta>();
    for (const rollout of seen) {
      const stored = disk.get(rollout);
      const meta = rows.get(rollout) ?? stored;
      if (meta && (stored || exists(rollout))) {
        merged.set(rollout, meta);
      }
    }
    for (const [rollout, meta] of disk) {
      if (!seen.has(rollout) && exists(rollout)) {
        merged.set(rollout, meta);
      }
    }
    const data: StoredOpenings = {
      codexMetaVersion: CODEX_META_VERSION,
      codexMetas: [...merged]
        .map(([rollout, meta]) => ({ file: rollout, meta }))
        .sort((a, b) => a.file.localeCompare(b.file)),
    };
    let held = true;
    writeFileAtomically(file, JSON.stringify(data), (temporary, target) => {
      held = readText(lock) === token;
      if (held) {
        replace(temporary, target);
      }
    });
    return held;
  } finally {
    releaseCodexOpeningsLock(lock, token);
  }
}

// How long a save that found the lock busy waits before it tries again. A holder keeps the lock
// for one read and one write of the file.
export const CODEX_OPENINGS_RETRY_MS = 2_000;

// The window's opening records, whose revision moves whenever a row is added or removed.
interface OpeningRows {
  readonly revision: number;
  snapshot(): Iterable<[string, CodexSessionMeta]>;
}

// One window's saves of the shared file. A save writes only when the window's opening records
// moved since its last save, and none runs before the first walk. A save that finds the lock
// busy tries again after `CODEX_OPENINGS_RETRY_MS`, because a quiet window can go without
// another checkpoint for as long as it stays open.
// It declares its fields apart from the constructor, because the child processes of the
// concurrency test load this module with type stripping, which rejects parameter properties.
export class CodexOpeningsWriter {
  private readonly file: string;
  private readonly rows: OpeningRows;
  private savedRevision: number;
  private walk: readonly string[] | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  // `seeded` says the rows came from an older workspace file rather than the shared file. The
  // first save then owes the shared file those rows even when the walk reads nothing new.
  constructor(file: string, rows: OpeningRows, seeded: boolean) {
    this.file = file;
    this.rows = rows;
    this.savedRevision = seeded ? -1 : rows.revision;
  }

  setWalk(walked: readonly string[]): void {
    this.walk = walked;
  }

  // False when the shared file still needs this save.
  write(): boolean {
    const revision = this.rows.revision;
    if (!this.walk || revision === this.savedRevision) {
      return true;
    }
    let saved: boolean;
    try {
      saved = saveCodexOpenings(this.file, new Map(this.rows.snapshot()), this.walk);
    } catch {
      // An optional cache must not affect the panel. A failed write waits for the next checkpoint.
      return false;
    }
    if (saved) {
      this.savedRevision = revision;
    } else {
      this.retry ??= setTimeout(() => {
        this.retry = null;
        this.write();
      }, CODEX_OPENINGS_RETRY_MS);
    }
    return saved;
  }

  dispose(): void {
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
  }
}
