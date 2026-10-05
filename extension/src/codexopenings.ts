import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { writeFileAtomically } from './atomicfile';
import type { CodexSessionMeta } from './codex';

// CODEX_META_VERSION identifies stored opening fields and their derivation rules.
// Loading drops rows with another version and rereads their rollout openings.
//
// Bump this version when CodexSessionMeta fields or their derivation rules change.
// readCodexOpeningRecord in codex.ts owns those rules and calls codexStartedAt,
// codexReplayBoundaryAt, guardianPayloadAt, stamp, codexAgentPath, and their helpers.
// Changed rules can leave the stored shape valid, so shape validation cannot detect them.
//
// This version is independent of VERSION in derivedcache.ts.
// A bump rereads every stored rollout opening on the machine.
export const CODEX_META_VERSION = 3;

// Unversioned opening rows use the derived session cache version below.
// Versions before 27 lack startedAt and have no supported opening metadata version.
const LEGACY_CODEX_META_VERSIONS: ReadonlyMap<number, number> = new Map([
  [27, 1],
  [28, 1],
  [29, 1],
]);

// Saves attempt takeover when a lock reaches this age.
// A dead holder or a paused live holder can leave a lock past the threshold.
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

// Validates required stored fields and the optional nativeSpawnedAt field.
// Invalid rows are dropped individually.
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

// Reads valid Codex opening rows from shared or workspace cache data.
// Rows with another CODEX_META_VERSION are dropped.
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

// Reads the shared opening rows, or null for a missing, unreadable, or malformed file.
// A null result lets startup use workspace rows.
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

// Starts with shared opening rows when the file loads, including an empty map.
// Otherwise, workspace rows seed the first save into the shared file.
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

// Creates file containing token, or returns false if creation or writing fails.
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

// Takes over a stale lock under a guard named for its contents and modification time.
// Only the window that creates the guard removes the lock after rechecking its identity.
// Contending windows return false.
// judged runs after the initial stale-lock read.
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
    // The lock failed inspection or reading.
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

// A takeover interrupted after lock removal can leave a guard that later takeovers will not encounter.
// The lock holder removes guards past CODEX_OPENINGS_LOCK_STALE_MS.
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

// Returns the acquired lock token, or null when acquisition fails.
// Before replacing the shared file or releasing the lock, the holder checks its token.
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

// Saves opening rows into the shared file while holding its adjacent lock.
// A failed lock acquisition returns false without waiting.
//
// For walked rollouts, rows takes precedence over the shared file.
// A walked row absent from the shared file stays only if its rollout exists.
// Shared rows outside the walk also stay only if their rollouts exist.
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

// Delay before retrying a save that failed to acquire the lock.
export const CODEX_OPENINGS_RETRY_MS = 2_000;

// The window's opening records, whose revision moves whenever a row is added or removed.
interface OpeningRows {
  readonly revision: number;
  snapshot(): Iterable<[string, CodexSessionMeta]>;
}

// Saves opening records after the first walk when their revision differs from the last saved revision.
// Failed lock acquisition retries after CODEX_OPENINGS_RETRY_MS, even when no checkpoint follows.
// Node type stripping rejects constructor parameter properties, so fields are declared separately.
export class CodexOpeningsWriter {
  private readonly file: string;
  private readonly rows: OpeningRows;
  private savedRevision: number;
  private walk: readonly string[] | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  // Seeded workspace rows require a first shared save even if the walk adds nothing.
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
