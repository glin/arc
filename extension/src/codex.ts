import type { SourceEnumeration } from './sessioncoverage';
import * as fs from 'node:fs';
import { ExportLimitError, type ExportRelationshipLimits } from './exportlimits';
import {
  emptyCodexResponseClock,
  summedTurnRate,
  reduceCodexResponseClock,
  type CodexResponseClock,
} from './outputrate';
import { meterRead, meterReadWork } from './readmeter';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  BackwardLineCursor,
  type RelationshipReadMeter,
  captureTurnTextOrder,
  BoundaryDiscovery,
  BoundaryDiscoveryOptions,
  CacheLifetime,
  Compaction,
  CompactionSignal,
  PatchHunk,
  ReadOptions,
  ReducerCompaction,
  SessionFile,
  SessionRead,
  ToolCounts,
  retainNewestCompaction,
  Turn,
  TurnAgent,
  TurnAnswer,
  TurnDelegation,
  TurnFileChange,
  TurnStarts,
  TurnStep,
  TurnUpdate,
  TurnUsage,
  UsageEvent,
  STEP_CUT,
  STEP_DETAIL_LIMIT,
  TURN_ASK_LIMIT,
  TURN_START_BYTES,
  TURN_STEP_LIMIT,
  stepDetail,
  presentedStepDetail,
  addTurnSkillUse,
  cleanPrompt,
  countLines,
  firstLine,
  isEphemeralPath,
  folderMatcher,
  normalizeFsPath,
  commitSourceStamp,
  bindCommitSources,
  sameCommitSha,
  revisionOf,
  readQualifiedOpening,
  type FileRevision,
  RelationshipReader,
  RELATIONSHIP_QUANTUM_BYTES,
  relationshipEvidence,
  extendRelationshipEvidence,
  validRelationshipEvidence,
  type RelationshipEvidence,
  normalizeSessionTitle,
  normalizeFullSessionTitle,
  readTurnStartsFromTail,
  recordCommits,
  shortenTo,
  tailOf,
  tallyToolName,
  activityIn,
  TurnOutcome,
  discoverBackwardBoundary,
  readPreviousLines,
  SessionStatFacts,
  addTurnUsagePart,
  sessionStatFactsOf,
  setTurnStepStatus,
  headLines,
  claudeLaunchKind,
  shellDispatchFromOutput,
  type ClaudeDispatchSessionReference,
} from './transcript';
import {
  AgentSpend,
  openSpendBand,
  AgentSpendLookup,
  AgentSpendRef,
  ModelSpend,
  addUsage,
  emptyUsage,
  spendFileVersion,
  scanLinesIncremental,
} from './agentspend';
import {
  childToolCalls,
  cloneChildArtifacts,
  lastLineWhole,
  reduceChildArtifacts,
  UNNAMED_TOOL,
} from './childartifacts';
import {
  BEDROCK_LIST_COST_BASIS,
  bedrockClaudeListMultiplier,
  cacheLifetimeFor,
  contextBandForRequest,
  resolveModelPricing,
} from './pricing';
import {
  applyHiddenParserState,
  cloneParserState,
  retainedParserPayload,
  retainedParserPayloadScan,
  hiddenParserState,
  ParserLine,
  RETAINED_COMPACTIONS,
  type HiddenParserState,
  type HiddenStatePolicy,
} from './parserstate';
import { ARC_IDENTITY } from './identity';
import { codexHome } from './agentpaths';
import { parseQuestionReply, type QuestionReply } from './codexreply';

// Reads Codex rollouts into the shared `Turn` shape without writing to the source files.
// `task_started` and `task_complete` supply explicit turn boundaries through `turn_id`.
// Date-sharded directories supply no project identity. Each rollout's opening record supplies its cwd.
// OpenAI's `input_tokens` includes cached input. Subtract cached input before using the shared usage fields.

// The configured rollout root, or the sessions directory under the Codex home.
export function codexSessionsRoot(): string {
  return process.env[`${ARC_IDENTITY.environmentPrefix}CODEX_ROOT`] || path.join(codexHome(), 'sessions');
}

// Opening metadata identifies the session, workspace, launch source, and child relationships.
// Read it from the first record without loading the full rollout.
// Changes to persisted fields require a `CODEX_META_VERSION` change in `codexopenings.ts`.
export interface CodexSessionMeta {
  sessionId: string | null;
  cwd: string | null;
  modelProvider: string | null;
  // Envelope time on the first record. A replayed turn keeps its original started_at,
  // which lets readers distinguish inherited history from work done by this rollout.
  openedAt: number | null;
  // The creation clock for a direct session, guardian, or verified native spawn.
  // Every other rollout uses its opening envelope.
  startedAt: number | null;
  // The clock the usage reducer measures a turn's recorded start against to tell inherited
  // history from work done by this rollout. See `codexReplayBoundaryAt`.
  replayBoundaryAt: number | null;
  // A verified native spawn's creation clock. Rounded starts still require its own bill.
  nativeSpawnedAt?: number | null;
  // The public entrypoint. `exec` starts headless work. `vscode` and `cli` identify interactive entrypoints.
  launchSource: string | null;
  // The recorded thread source, such as `subagent` or `user`. Null when the opening omits it.
  threadSource: string | null;
  // The non-empty parent thread id, from the opening payload or its native spawn metadata.
  parentThreadId: string | null;
  // The stable path Codex assigned this child, such as `/root/review_sol`. Null for a user
  // session and for internal services such as the background guardian.
  agentPath: string | null;
  // The structured subtype inside `source.subagent.other`, when Codex wrote one.
  subagentKind: string | null;
  // True when `source.subagent` is an object. String sources never establish this structural child relationship.
  hasSubagentSource: boolean;
}

// Default concurrency limit for opening reads in `CodexMetaCache.prime`.
export const COLD_OPENING_READS = 8;

// Retry interval after repeated refused opening reads.
export const REFUSED_OPENING_RETRY_MS = 30_000;

// Short retry interval after the first refused opening read.
export const REFUSED_OPENING_FIRST_RETRY_MS = 1_000;

// Readable openings stay cached until invalidation. An unreadable head gets one retry, then waits for file growth.
// Refused reads retain no size marker. They use the first retry interval, then the repeated-refusal interval.
// The default clock is monotonic.
export class CodexMetaCache {
  private entries = new Map<
    string,
    | { meta: CodexSessionMeta }
    | { meta: null; size: number | null }
    | { meta: undefined; triedAt: number; wait: number }
  >();
  private changed = 0;

  constructor(
    private readMeta: (file: string) => CodexSessionMeta | null | undefined = readCodexOpening,
    private sizeOf: (file: string) => number | null = fileSize,
    private now: () => number = () => performance.now(),
  ) {}

  get(file: string): CodexSessionMeta | null {
    const hit = this.entries.get(file);
    if (hit?.meta) {
      return hit.meta;
    }
    let size: number | null = null;
    if (hit && hit.meta === undefined) {
      // A clock value before the last attempt makes the retry due immediately.
      const elapsed = this.now() - hit.triedAt;
      if (elapsed >= 0 && elapsed < hit.wait) {
        return null;
      }
    } else if (hit) {
      size = this.sizeOf(file);
      if (size === null || (hit.size !== null && hit.size === size)) {
        return null;
      }
    }
    const meta = this.readMeta(file);
    // Refused reads keep an attempt time and retry interval instead of a file-size marker.
    if (meta === undefined) {
      const wait = hit && hit.meta === undefined ? REFUSED_OPENING_RETRY_MS : REFUSED_OPENING_FIRST_RETRY_MS;
      this.entries.set(file, { meta: undefined, triedAt: this.now(), wait });
      return null;
    }
    this.entries.set(file, meta ? { meta } : { meta: null, size });
    if (meta) {
      this.changed += 1;
    }
    return meta;
  }

  // Read missing and refused openings asynchronously, with at most `limit` concurrent reads.
  // Preserve any non-refusal entry `get` supplies during the read.
  // A missing record keeps its measured size. Later `get` calls retry after growth.
  // Rejected reads leave existing entries unchanged. Return true when a readable opening was added.
  // An aborted `signal` stops each lane before its next read.
  async prime(
    files: readonly string[],
    readAsync: (file: string, buf: Buffer) => Promise<CodexSessionMeta | null> = readCodexSessionMetaAsync,
    limit = COLD_OPENING_READS,
    sizeAsync: (file: string) => Promise<number | null> = fileSizeAsync,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const missing = files.filter((file) => this.entries.get(file)?.meta === undefined);
    const before = this.changed;
    let next = 0;
    const lane = async (): Promise<void> => {
      const buf = Buffer.allocUnsafe(META_BYTES);
      while (next < missing.length) {
        if (signal?.aborted) return;
        const file = missing[next++];
        let meta: CodexSessionMeta | null;
        try {
          meta = await readAsync(file, buf);
        } catch {
          continue;
        }
        const size = meta ? null : await sizeAsync(file).catch(() => null);
        if (this.entries.get(file)?.meta !== undefined) {
          continue;
        }
        this.entries.set(file, meta ? { meta } : { meta: null, size });
        if (meta) {
          this.changed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, missing.length) }, lane));
    return this.changed !== before;
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }
  get revision(): number {
    return this.changed;
  }
  // Install an already qualified opening and notify the existing snapshot owner.
  install(file: string, meta: CodexSessionMeta): void {
    const previous = this.entries.get(file)?.meta;
    this.entries.set(file, { meta });
    if (!isDeepStrictEqual(previous, meta)) {
      this.changed += 1;
    }
  }
  delete(file: string): boolean {
    const hit = this.entries.get(file);
    const deleted = this.entries.delete(file);
    if (deleted && hit?.meta) {
      this.changed += 1;
    }
    return deleted;
  }

  // Persist only readable opening records. A failed opening read is a retry marker whose
  // answer can change without the file growing, so it must not survive a window restart.
  snapshot(): [string, CodexSessionMeta][] {
    return [...this.entries].flatMap(([file, entry]) => (entry.meta ? [[file, entry.meta]] : []));
  }

  // Restore positive entries from the machine's stored opening records. Validation belongs to
  // the cache reader, while this method keeps the retry-marker representation private to this
  // class.
  load(entries: Iterable<[string, CodexSessionMeta]>): void {
    for (const [file, meta] of entries) {
      this.entries.set(file, { meta });
    }
  }
}

function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

async function fileSizeAsync(file: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    return null;
  }
}

// Guardian review is background automation. Its explicit source keeps it out of the session list.
export function isHiddenThread(meta: CodexSessionMeta): boolean {
  return isGuardianSource(meta.threadSource, meta.subagentKind);
}

// Current guardian rollouts name `guardian_review` as their thread source. Older ones use the
// ordinary `subagent` source and name the guardian in `source.subagent.other`.
function isGuardianSource(threadSource: string | null, subagentKind: string | null): boolean {
  return threadSource === 'guardian_review' || (threadSource === 'subagent' && subagentKind === 'guardian');
}

// Headless entrypoints and structural child metadata identify agent runs independently.
// Unknown values without either sign remain in the reader's day buckets.
export function isAgentRun(meta: CodexSessionMeta): boolean {
  return (
    meta.launchSource === 'exec' ||
    meta.threadSource === 'subagent' ||
    meta.parentThreadId !== null ||
    meta.hasSubagentSource
  );
}

// Maximum opening-record size. The opening includes the model's base instructions.
export const CODEX_OPENING_BYTES = 128 * 1024;
const META_BYTES = CODEX_OPENING_BYTES;

// How far into a rollout the first prompt can sit. Everything the model was told opens the
// file ahead of it: the instructions, the sandbox rules and a snapshot of the workspace.
export const CODEX_TITLE_BYTES = 1024 * 1024;
export const CODEX_COMMIT_REPOSITORY_PARSER_VERSION = 4;

// Maximum directory depth below the rollout root. Four levels include YYYY/MM/DD and one additional shard.
// The limit bounds directory traversal.
const WALK_DEPTH = 4;

// The first read of a rollout's head. Most opening records end inside it.
const FIRST_LINE_WINDOW = 16 * 1024;

// One buffer for every synchronous head read. A read runs to its end without yielding, so no
// two reads share it at once. Asynchronous reads each carry their own.
let headBuffer: Buffer | null = null;

// Returns the first line, null when no complete line is available, or undefined when another window is needed.
function firstLineStep(buf: Buffer, have: number, read: number, want: number): string | null | undefined {
  // Bounded to this file's bytes, because the buffer past them holds an earlier file.
  const newline = buf.subarray(0, have + read).indexOf(0x0a, have);
  if (newline >= 0) {
    return buf.toString('utf8', 0, newline);
  }
  if (read < want) {
    return buf.toString('utf8', 0, have + read);
  }
  return have + read >= META_BYTES ? null : undefined;
}

// Read the first line in growing windows up to `META_BYTES`. Decode only through its newline.
// Accept an unterminated line when the file ends below the bound. Failed opens and reads throw.
function firstLineOf(file: string): string | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    return firstLineFromDescriptor(file, fd);
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function firstLineFromDescriptor(file: string, fd: number): string | null {
  const buf = (headBuffer ??= Buffer.allocUnsafe(META_BYTES));
  let have = 0;
  let window = FIRST_LINE_WINDOW;
  for (;;) {
    const want = window - have;
    const read = meterRead(file, fs.readSync(fd, buf, have, want, have), have);
    const line = firstLineStep(buf, have, read, want);
    if (line !== undefined) return line;
    have += read;
    window = Math.min(window * 2, META_BYTES);
  }
}

export function readQualifiedCodexOpening(file: string): { value: CodexSessionMeta; revision: FileRevision } | null {
  return readQualifiedOpening(file, (fd) => {
    const meta = openingRecordOf(firstLineFromDescriptor(file, fd));
    return meta?.sessionId && meta.cwd ? meta : null;
  });
}

// Read the first line asynchronously. This read owns its `META_BYTES` buffer until settlement.
// Failed opens and reads reject, distinguishing refusal from a head with no opening record.
async function firstLineOfAsync(file: string, buf: Buffer): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, 'r');
    let have = 0;
    let window = FIRST_LINE_WINDOW;
    for (;;) {
      const want = window - have;
      const { bytesRead: read } = await handle.read(buf, have, want, have);
      const line = firstLineStep(buf, have, read, want);
      if (line !== undefined) {
        return line;
      }
      have += read;
      window = Math.min(window * 2, META_BYTES);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Returns opening metadata, null for a head without it, or undefined for a refused read.
// Changes to persisted fields or their deriving helpers require a `CODEX_META_VERSION` change in `codexopenings.ts`.
function readCodexOpeningRecord(file: string): CodexSessionMeta | null | undefined {
  let line: string | null;
  try {
    line = firstLineOf(file);
  } catch {
    return undefined;
  }
  return openingRecordOf(line);
}

export function openingRecordOf(line: string | null): CodexSessionMeta | null {
  if (!line || line.indexOf('session_meta') < 0) {
    return null;
  }
  let o: { type?: string; timestamp?: unknown; payload?: Record<string, unknown> };
  try {
    o = JSON.parse(line) as { type?: string; timestamp?: unknown; payload?: Record<string, unknown> };
  } catch {
    return null;
  }
  if (o.type !== 'session_meta' || !o.payload) {
    return null;
  }
  const p = o.payload;
  // Prefer the rollout's `id`. `session_id` is a fallback and can be shared across rollouts.
  // Context-window sizes come from turn and token-count records, not the opening's `context_window` object.
  const source = p.source;
  const subagent = isRecord(source) && isRecord(source.subagent) ? source.subagent : null;
  const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  const openedAt = stamp(o.timestamp) || null;
  const threadSource = str(p.thread_source);
  const subagentKind = str(subagent?.other);
  return {
    sessionId: str(p.id) ?? str(p.session_id),
    cwd: str(p.cwd),
    modelProvider: str(p.model_provider),
    openedAt,
    startedAt: codexStartedAt(openedAt, p, threadSource, subagentKind),
    replayBoundaryAt: codexReplayBoundaryAt(openedAt, p, threadSource, subagentKind),
    ...(nativeSpawnPayloadAt(openedAt, p) === null ? {} : { nativeSpawnedAt: nativeSpawnPayloadAt(openedAt, p) }),
    launchSource: str(source),
    threadSource,
    parentThreadId: str(p.parent_thread_id) ?? str(spawn?.parent_thread_id),
    agentPath: codexAgentPath(p),
    subagentKind,
    hasSubagentSource: subagent !== null,
  };
}

function codexAgentPath(payload: Record<string, unknown>): string | null {
  const source = payload.source;
  const subagent = isRecord(source) && isRecord(source.subagent) ? source.subagent : null;
  const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  return str(payload.agent_path) ?? str(spawn?.agent_path);
}

export function readCodexSessionMeta(file: string): CodexSessionMeta | null {
  return readCodexOpeningRecord(file) ?? null;
}

// `readCodexSessionMeta` that answers undefined when the file system refuses the read, so
// `CodexMetaCache` keeps a refused read apart from a head with no record.
export function readCodexOpening(file: string): CodexSessionMeta | null | undefined {
  return readCodexOpeningRecord(file);
}

// `readCodexSessionMeta` off the extension host's main thread. `buf` holds `META_BYTES` and
// belongs to this read until it settles. It rejects when the file system refuses the read.
export async function readCodexSessionMetaAsync(file: string, buf: Buffer): Promise<CodexSessionMeta | null> {
  return openingRecordOf(await firstLineOfAsync(file, buf));
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function guardianPayloadAt(
  payload: Record<string, unknown>,
  threadSource = str(payload.thread_source),
  subagentKind = str(
    isRecord(payload.source) && isRecord(payload.source.subagent) ? payload.source.subagent.other : null,
  ),
): number | null {
  return isGuardianSource(threadSource, subagentKind) ? stamp(payload.timestamp) || null : null;
}

function codexStartedAt(
  openedAt: number | null,
  payload: Record<string, unknown>,
  threadSource?: string | null,
  subagentKind?: string | null,
): number | null {
  return (
    guardianPayloadAt(payload, threadSource, subagentKind) ??
    directPayloadAt(payload) ??
    nativeSpawnPayloadAt(openedAt, payload) ??
    openedAt
  );
}

function directPayloadAt(payload: Record<string, unknown>): number | null {
  if (
    (payload.source !== 'vscode' && payload.source !== 'cli' && payload.source !== 'exec') ||
    (payload.thread_source !== undefined && payload.thread_source !== 'user') ||
    str(payload.parent_thread_id) !== null ||
    str(payload.forked_from_id) !== null
  ) {
    return null;
  }
  return stamp(payload.timestamp) || null;
}

function nativeSpawnPayloadAt(openedAt: number | null, payload: Record<string, unknown>): number | null {
  const source = payload.source;
  const subagent = isRecord(source) && isRecord(source.subagent) ? source.subagent : null;
  const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  const child = str(payload.id);
  const parent = str(spawn?.parent_thread_id);
  const created = stamp(payload.timestamp);
  return payload.thread_source === 'subagent' &&
    child &&
    parent &&
    child !== parent &&
    !str(payload.forked_from_id) &&
    str(payload.parent_thread_id) === parent &&
    openedAt !== null &&
    created > 0 &&
    created <= openedAt
    ? created
    : null;
}

// The usage reducer counts a turn as inherited history when its recorded start falls more than
// this slack before the replay boundary. Direct sessions use their creation clock.
// Verified native spawns use their creation clock without the direct-session allowance.
// Unsupported child sources keep the envelope allowance.
const CODEX_REPLAY_CLOCK_SLACK_MS = 5_000;
// Turn starts round down to whole seconds. A guardian's first turn can precede its payload clock by under one second.
const CODEX_TURN_START_ROUNDING_MS = 1_000;

// A guardian's payload clock is its exact opening time, and its envelope can follow its own
// first turn. Its boundary therefore sits where the reducer's slack ends one rounding step
// before the payload clock. A copied parent turn that started earlier stays inherited history,
// however late the envelope is.
function codexReplayBoundaryAt(
  openedAt: number | null,
  payload: Record<string, unknown>,
  threadSource?: string | null,
  subagentKind?: string | null,
): number | null {
  const payloadAt = guardianPayloadAt(payload, threadSource, subagentKind);
  const spawnedAt = nativeSpawnPayloadAt(openedAt, payload);
  if (spawnedAt !== null) return spawnedAt + CODEX_REPLAY_CLOCK_SLACK_MS;
  return payloadAt === null
    ? (directPayloadAt(payload) ?? openedAt)
    : payloadAt + CODEX_REPLAY_CLOCK_SLACK_MS - CODEX_TURN_START_ROUNDING_MS;
}

// The thread id at the end of `rollout-<ISO8601>-<uuid>.jsonl`, for a file whose opening
// record did not name one.
const ROLLOUT_NAME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// List every rollout under `root` within `WALK_DEPTH`.
// Directory dates describe session starts, not their latest activity. Do not prune resumed sessions by those dates.
export function rolloutFiles(root: string): string[] {
  return enumerateRolloutFiles(root).files as string[];
}

// The traversal policy that both drivers follow: depth-first order, `WALK_DEPTH`, the rollout
// filter, directory evidence and uncertainty. A driver calls `collect`, reads the directory in
// `dir` when one waits there, hands the answer to `read` or `failed`, and repeats until `complete`.
// The walk keeps its position in an explicit stack, so a driver can await between directory reads
// and between the entries of one directory.
class RolloutWalk {
  // The directory the driver reads next. It is null while entries wait for `collect`, and once the walk is complete.
  dir: string | null;
  // `depth` counts the levels already descended, so the root itself is zero and a directory
  // is entered while that count is still under the limit.
  private depth = 0;
  private status: SourceEnumeration['status'] = 'complete';
  private missingRoot = false;
  private readonly directories: string[] = [];
  private readonly files: string[] = [];
  private readonly uncertain: string[] = [];
  // Directories whose entries the walk has not finished, innermost last.
  private readonly open: { dir: string; depth: number; entries: fs.Dirent[]; next: number }[] = [];

  constructor(private readonly root: string) {
    this.dir = root;
  }

  get complete(): boolean {
    return this.dir === null && this.open.length === 0;
  }

  read(entries: fs.Dirent[]): void {
    this.directories.push(this.dir!);
    this.open.push({ dir: this.dir!, depth: this.depth, entries, next: 0 });
    this.dir = null;
  }

  failed(error: unknown): void {
    if (this.depth === 0 && (error as NodeJS.ErrnoException)?.code === 'ENOENT') this.missingRoot = true;
    else {
      this.status = this.depth === 0 ? 'unavailable' : 'incomplete';
      this.uncertain.push(this.dir!);
    }
    this.dir = null;
  }

  result(): SourceEnumeration {
    const { status, root, directories, files, uncertain } = this;
    return this.missingRoot
      ? { status, root, directories, files, uncertain, missingRoot: true }
      : { status, root, directories, files, uncertain };
  }

  // Collects rollouts in entry order until the next directory to descend into, which then waits
  // in `dir`. Rollouts listed after that directory are collected once its subtree is done.
  // Collection also stops before an entry once `pause` answers true, and the next call resumes there.
  collect(pause?: () => boolean): void {
    if (this.dir !== null) return;
    const open = this.open;
    while (open.length > 0) {
      const top = open[open.length - 1];
      const { dir, depth, entries } = top;
      while (top.next < entries.length) {
        if (pause?.()) return;
        const entry = entries[top.next++];
        if (entry.isDirectory()) {
          if (depth < WALK_DEPTH) {
            this.dir = path.join(dir, entry.name);
            this.depth = depth + 1;
            return;
          }
        } else if (entry.name.endsWith('.jsonl')) {
          this.files.push(path.join(dir, entry.name));
        }
      }
      open.pop();
    }
  }
}

export function enumerateRolloutFiles(root: string): SourceEnumeration {
  const walk = new RolloutWalk(root);
  for (walk.collect(); !walk.complete; walk.collect()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(walk.dir!, { withFileTypes: true });
    } catch (error) {
      walk.failed(error);
      continue;
    }
    walk.read(entries);
  }
  return walk.result();
}

// How long the asynchronous walk works before it lets the host handle other work.
const WALK_SLICE_MS = 4;

// Walks the same policy, and yields to the event loop once a slice of `WALK_SLICE_MS` has passed.
// It checks the time before each directory read and before each entry, so selection and other
// messages run during the walk. One synchronous directory read cannot be interrupted. The default
// reader is synchronous: a read on the libuv pool costs more process CPU than the read itself.
// A canceled walk answers null, which callers must treat as no result rather than as absent rollouts.
export async function enumerateRolloutFilesAsync(
  root: string,
  signal?: AbortSignal,
  readDirectory: (dir: string) => fs.Dirent[] | Promise<fs.Dirent[]> = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }),
): Promise<SourceEnumeration | null> {
  const walk = new RolloutWalk(root);
  let slice = performance.now();
  const due = () => performance.now() - slice >= WALK_SLICE_MS;
  for (walk.collect(due); !walk.complete; walk.collect(due)) {
    if (due()) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      slice = performance.now();
      if (signal?.aborted) return null;
      continue;
    }
    if (signal?.aborted) return null;
    let entries: fs.Dirent[];
    try {
      const answer = readDirectory(walk.dir!);
      entries = answer instanceof Promise ? await answer : answer;
    } catch (error) {
      if (signal?.aborted) return null;
      walk.failed(error);
      continue;
    }
    if (signal?.aborted) return null;
    walk.read(entries);
  }
  return walk.result();
}

// Workspace sessions and the complete walked rollout list.
// Trim opening caches against `walked`, which also includes rollouts from other workspaces.
export interface CodexListing {
  sessions: SessionFile[];
  // Workspace rollout sources, including automation omitted from the session list.
  sources: { file: string }[];
  // Structural children for parent spend lookup. These entries carry no stat.
  // Visible dispatched children also appear in `sessions` with their stat.
  subagents: CodexSubagentFile[];
  walked: string[];
  enumeration: SourceEnumeration;
  admission: SourceEnumeration['status'];
}

export interface CodexSubagentFile {
  file: string;
  threadId: string;
  parentThreadId: string | null;
  agentPath: string | null;
  // The envelope time, which decides the parent turn that owns the child.
  openedAt: number | null;
  // When the child's own work can begin, which its row's duration counts from. See
  // `CodexSessionMeta.startedAt`.
  startedAt: number | null;
  threadSource: string | null;
  backgroundReview: boolean;
}

// File metadata used to order and admit rollouts.
export interface RolloutStat {
  mtimeMs: number;
  size: number;
  isFile: boolean;
  dev?: number | string;
  ino?: number | string;
}

export function readRolloutStat(file: string): RolloutStat | null {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return {
      ...revisionOf(stat),
      isFile: stat.isFile(),
    };
  } catch {
    return null;
  } // vanished mid-scan
}

// A rollout written to within this window is statted on every listing.
export const CODEX_STAT_ACTIVE_MS = 10 * 60_000;
// An older rollout reuses its held stat until the watcher reports its file or directory, or
// until the held stat is this old. The age limit covers an event the watcher never delivers.
export const CODEX_STAT_REVALIDATE_MS = 60_000;

// Cache rollout stats between listings. Watcher events invalidate affected files.
// Closing or failing watchers and stopped polling clear the cache because filesystem changes can go unobserved.
export class CodexStatCache {
  private readonly entries = new Map<string, { stat: RolloutStat; readAt: number }>();

  constructor(
    private readonly statOf: (file: string) => RolloutStat | null = readRolloutStat,
    private readonly now: () => number = Date.now,
  ) {}

  get(file: string): RolloutStat | null {
    const at = this.now();
    const held = this.entries.get(file);
    if (held && held.stat.mtimeMs < at - CODEX_STAT_ACTIVE_MS && at - held.readAt < CODEX_STAT_REVALIDATE_MS) {
      return held.stat;
    }
    const stat = this.statOf(file);
    if (stat) {
      this.entries.set(file, { stat, readAt: at });
    }
    return stat;
  }

  // A watcher event with no file name stands for every file in its directory.
  markChanged(directory: string, filename: unknown): void {
    if (typeof filename === 'string') {
      this.entries.delete(path.join(directory, filename));
      return;
    }
    for (const file of [...this.entries.keys()]) {
      if (path.dirname(file) === directory) {
        this.entries.delete(file);
      }
    }
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }
  delete(file: string): boolean {
    return this.entries.delete(file);
  }
  clear(): void {
    this.entries.clear();
  }
}

// The cold pass supplies traversal evidence and paths to its refresh, plus whether it read missing opening records.
// A canceled pass supplies no enumeration.
export interface ColdOpeningPass {
  enumeration: SourceEnumeration | null;
  walked: string[];
  read: boolean;
}

// A canceled pass answers a null enumeration and reads no opening record after the signal fires.
// Its `read` still reports the records read before cancellation, so the caller can persist them.
export async function coldOpeningPass(
  cache: CodexMetaCache,
  root: string,
  signal?: AbortSignal,
): Promise<ColdOpeningPass> {
  const enumeration = await enumerateRolloutFilesAsync(root, signal);
  if (!enumeration) return { walked: [], enumeration: null, read: false };
  const walked = [...enumeration.files];
  const read = await cache.prime(walked, undefined, undefined, undefined, signal);
  return signal?.aborted ? { walked: [], enumeration: null, read } : { walked, enumeration, read };
}

// List workspace sessions by newest activity, using each opening's recorded cwd for membership.
// Callers supply cached opening and stat readers. `walked` defaults to a fresh traversal of `root`.
export function codexSessionFiles(
  root: string,
  folders: string[],
  metaOf: (file: string) => CodexSessionMeta | null = readCodexSessionMeta,
  statOf: (file: string) => RolloutStat | null = readRolloutStat,
  walked?: string[],
  enumeration: SourceEnumeration = walked
    ? { status: 'incomplete', files: walked, uncertain: [root] }
    : enumerateRolloutFiles(root),
): CodexListing {
  walked ??= [...enumeration.files];
  let admission = enumeration.status;
  if (folders.length === 0) {
    return { sessions: [], sources: [], subagents: [], walked, enumeration, admission };
  }
  const out: SessionFile[] = [];
  const sources: { file: string }[] = [];
  const subagents: CodexSubagentFile[] = [];
  // Most rollouts share a few working directories, so each distinct cwd is matched once.
  const inFolders = folderMatcher(folders);
  const memberCwds = new Map<string, boolean>();
  const cwdInFolders = (cwd: string): boolean => {
    let member = memberCwds.get(cwd);
    if (member === undefined) {
      member = inFolders(cwd);
      memberCwds.set(cwd, member);
    }
    return member;
  };
  for (const file of walked) {
    // Check cached opening metadata before requesting a stat. Other workspaces need no stat read here.
    const meta = metaOf(file);
    // No readable opening record means no cwd, and the path holds none either, so there is
    // nothing that puts the session in this workspace.
    if (!meta || !meta.cwd) admission = 'incomplete';
    if (!meta || !meta.cwd || !cwdInFolders(meta.cwd)) {
      continue;
    }
    sources.push({ file });
    // Retain structural children for parent spend lookup. Dispatched work also appears in the session list.
    // Background automation remains hidden there.
    const structuralChild = meta.threadSource === 'subagent' || meta.parentThreadId !== null || meta.hasSubagentSource;
    if (structuralChild && meta.sessionId) {
      subagents.push({
        file,
        threadId: meta.sessionId,
        parentThreadId: meta.parentThreadId,
        agentPath: meta.agentPath,
        openedAt: meta.openedAt,
        startedAt: meta.startedAt,
        threadSource: meta.threadSource,
        backgroundReview: isHiddenThread(meta),
      });
    }
    // Omit guardian review from visible sessions before requesting its stat.
    // Dispatched children remain visible in Run by agents.
    if (isHiddenThread(meta)) {
      continue;
    }
    const stat = statOf(file);
    if (!stat) admission = 'incomplete';
    if (!stat || !stat.isFile || stat.size === 0) {
      continue;
    }
    const named = ROLLOUT_NAME.exec(path.basename(file));
    out.push({
      agent: 'codex',
      file,
      sessionId: meta.sessionId || (named ? named[1] : path.basename(file, '.jsonl')),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      cwd: meta.cwd,
      ...(stat.dev === undefined ? {} : { dev: stat.dev }),
      ...(stat.ino === undefined ? {} : { ino: stat.ino }),
      // Manually launched `codex exec` sessions also count as agent runs because their entrypoint is headless.
      agentRun: isAgentRun(meta),
    });
  }
  return { sessions: out.sort((a, b) => b.mtimeMs - a.mtimeMs), sources, subagents, walked, enumeration, admission };
}

// Find cached openings absent from the complete walk.
// Workspace sessions alone omit other projects and cannot establish which rollout files disappeared.
export function staleMetas(
  cached: Iterable<string>,
  walked: Iterable<string>,
  enumeration?: SourceEnumeration,
  absent: (file: string) => boolean = () => true,
): string[] {
  if (enumeration && enumeration.status !== 'complete') return [];
  const seen = new Set(walked);
  return [...cached].filter((file) => !seen.has(file) && absent(file));
}

// Read the first typed prompt as a fallback session title.
// The index later supplies the thread name independently of rollout activity.
export function readCodexSessionTitle(file: string, bytes = CODEX_TITLE_BYTES): string | null {
  return readCodexSessionTitlePair(file, bytes).short;
}

export function readCodexSessionTitlePair(
  file: string,
  bytes = CODEX_TITLE_BYTES,
): { short: string | null; full: string | null } {
  const lines = headLines(file, bytes);
  const opening = lines.length ? parseRecord(lines[0]) : null;
  const agentPath = opening?.kind === 'session_meta' ? codexAgentPath(opening.payload) : null;
  for (const line of lines) {
    if (!carriesUserMessage(line) && !carriesDelegation(line)) {
      continue;
    }
    const record = parseRecord(line);
    if (!record) {
      continue;
    }
    const source = codexPrompt(userMessage(record) ?? '') || codexDelegation(record, agentPath)?.text || '';
    const short = normalizeSessionTitle(source);
    if (short) {
      return { short, full: normalizeFullSessionTitle(source) };
    }
  }
  return { short: null, full: null };
}

export interface CodexSessionActivity {
  coverage?: import('./transcript').MetadataCoverage;
  activityMs: number | null;
  outcome: TurnOutcome | null;
  stats?: SessionStatFacts | null;
}

export interface CodexSessionActivityOptions {
  sessionId: string;
  meta: CodexSessionMeta | null;
}

// Read last activity and the newest turn outcome together from the rollout tail.
export function readCodexSessionActivity(
  file: string,
  bytes = 256 * 1024,
  statsFor?: CodexSessionActivityOptions,
): CodexSessionActivity {
  const tail = tailOf(file, bytes);
  const meta = statsFor ? statsFor.meta : readCodexSessionMeta(file);
  return {
    ...(tail.success ? { coverage: { whole: tail.whole, windowBytes: bytes } } : {}),
    activityMs: activityIn(tail.lines),
    outcome: codexOutcomeIn(tail.lines, meta?.agentPath ?? null),
    ...(statsFor
      ? {
          stats: sessionStatFactsOf(
            readCodexSessionLines(tail.lines, statsFor.sessionId, { maxTurns: 40 }, tail.readBytes, statsFor.meta),
          ),
        }
      : {}),
  };
}

// The thread-name index beside the sessions directory.
// Names and renames append independently of rollouts, including after a rollout stops growing.
export function codexSessionIndexPath(): string {
  return path.join(path.dirname(codexSessionsRoot()), 'session_index.jsonl');
}

// Read thread names by id from append-only JSONL. The last valid name wins.
// Missing or empty names leave earlier names intact. A whitespace-only name removes the held title.
// Normalize short and full titles for single-line display.
function parseThreadNamePairs(text: string): Pick<ThreadNames, 'names' | 'fullNames'> {
  const names = new Map<string, string>();
  const fullNames = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.indexOf('thread_name') < 0) {
      continue;
    }
    let row: { id?: unknown; thread_name?: unknown };
    try {
      row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
    } catch {
      continue;
    }
    const id = str(row.id);
    const name = str(row.thread_name);
    if (!id || !name) {
      continue;
    }
    const title = normalizeSessionTitle(name);
    const fullTitle = normalizeFullSessionTitle(name);
    if (title && fullTitle) {
      names.set(id, title);
      fullNames.set(id, fullTitle);
    } else {
      names.delete(id);
      fullNames.delete(id);
    }
  }
  return { names, fullNames };
}

export function parseThreadNames(text: string): Map<string, string> {
  return parseThreadNamePairs(text).names;
}

// What a read of the index found, with the state of the file it came from.
export interface ThreadNames {
  // The index's size and mtime, or empty when absent. Changes trigger rereads and session-name updates.
  stamp: string;
  names: Map<string, string>;
  fullNames: Map<string, string>;
}

// Reread thread names when the index's size or mtime changes.
// A thread name can arrive without any change to its rollout.
export function readThreadNames(file: string, held: ThreadNames | null): ThreadNames {
  let stamp = '';
  try {
    const st = fs.statSync(file);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    /* no index on this machine yet */
  }
  if (held && held.stamp === stamp) {
    return held;
  }
  if (!stamp) {
    return { stamp, names: new Map(), fullNames: new Map() };
  }
  try {
    const bytes = fs.readFileSync(file);
    meterRead(file, bytes.length, 0);
    return { stamp, ...parseThreadNamePairs(bytes.toString('utf8')) };
  } catch {
    return { stamp: '', names: new Map(), fullNames: new Map() };
  }
}

// Use the indexed thread name, falling back to the first prompt when no indexed name exists.
export function codexTitleFor(
  names: Map<string, string>,
  sessionId: string,
  fromRollout: string | null,
): string | null {
  return names.get(sessionId) || fromRollout || null;
}

// The VS Code extension wraps a prompt with the state of the editor: the active file, the
// selection in it, and every open tab. Everything after the marker is what the user typed,
// and a prompt from anywhere else carries no marker and is already clean.
const IDE_REQUEST = '## My request for Codex:';

export function codexPrompt(raw: string, captureSessionText = false): string {
  const at = raw.lastIndexOf(IDE_REQUEST);
  const body = at < 0 ? raw : raw.slice(at + IDE_REQUEST.length).replace(/^\r?\n/, '');
  return captureSessionText ? body : cleanPrompt(body);
}

// A hunk header, with either count able to be absent. A missing count means one line, which
// is how a unified diff writes a single-line region.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Parse unified-diff hunks into the shared patch shape.
// A trailing empty split item is not a context line. A blank context line starts with a space.
// Ignore bare empty items so parsed hunk lengths match their headers.
export function hunksFromUnifiedDiff(diff: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  for (const raw of diff.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || raw === '') {
      continue;
    }
    current.lines.push(raw);
  }
  return hunks;
}

// Tool categories for the turn's tool mix. Shell wrappers count as commands even when they read or search files.
// Web searches use the shared activity category.
export const TOOL_KIND: Readonly<Record<string, keyof ToolCounts>> = {
  apply_patch: 'edits',
  web_search: 'web',
  exec: 'commands',
  shell_command: 'commands',
  exec_command: 'commands',
  run: 'commands',
  spawn_agent: 'agents',
  wait_agent: 'coordination',
  send_message: 'coordination',
  list_agents: 'coordination',
  interrupt_agent: 'coordination',
  followup_task: 'coordination',
};

function emptyToolCounts(): ToolCounts {
  return { edits: 0, reads: 0, searches: 0, commands: 0, agents: 0, coordination: 0, web: 0, other: 0 };
}

// Script-error headings also wrap non-zero shell exit codes, including searches with no matches.
// Count a script failure only when its detail is not an exit-code report.
const SCRIPT_ERROR = 'Script error:';
const EXIT_CODE = /^Exit code:/;

export function scriptFailure(output: string): string | null {
  const at = output.indexOf(SCRIPT_ERROR);
  if (at < 0) {
    return null;
  }
  const detail =
    output
      .slice(at + SCRIPT_ERROR.length)
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) || '';
  if (!detail || EXIT_CODE.test(detail)) {
    return null;
  }
  return shortenTo(detail, 160, '...');
}

// A tool's output, which arrives either as text or as the blocks the model was handed.
function outputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (!Array.isArray(output)) {
    return '';
  }
  return output
    .map((b) => String((b as { text?: unknown } | null)?.text ?? ''))
    .filter(Boolean)
    .join('\n');
}

interface SpawnResult {
  id: string | null;
  description: string | null;
}

function spawnResult(output: string): SpawnResult | null {
  try {
    const result = JSON.parse(output) as Record<string, unknown>;
    if (typeof result !== 'object' || result === null) {
      return null;
    }
    // Task-name-only acknowledgements obtain their thread identity from separate sub_agent_activity records.
    if (typeof result.task_name === 'string') {
      return { id: null, description: null };
    }
    // multi_agent_v1 returns the child thread and the name intended for the card together.
    if (typeof result.agent_id === 'string' && typeof result.nickname === 'string') {
      return { id: result.agent_id, description: result.nickname };
    }
  } catch {
    /* not a spawn result */
  }
  return null;
}

function currentSpawnFailure(output: string): string | null {
  const message = firstLine(output);
  if (/^collab spawn failed:/i.test(message)) {
    return message;
  }
  try {
    const result = JSON.parse(output) as { error?: unknown };
    if (typeof result.error === 'string' && result.error.trim()) {
      return firstLine(result.error);
    }
    if (isRecord(result.error) && typeof result.error.message === 'string' && result.error.message.trim()) {
      return errorMessage(output);
    }
  } catch {
    /* an unrecognized result can still be completed by its collaboration item */
  }
  return null;
}

// Extract the error message from a JSON envelope, or use the first line of plain error text.
export function errorMessage(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('{')) {
    try {
      const envelope = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
      const inner = str(envelope.error?.message) ?? str(envelope.message);
      if (inner) {
        return firstLine(inner);
      }
    } catch {
      /* not an envelope after all, so it is the message */
    }
  }
  return firstLine(text);
}

function stamp(value: unknown): number {
  const t = Date.parse(String(value || ''));
  return Number.isNaN(t) ? 0 : t;
}

// Legacy child-answer messages identify their sender by agent path. Its final segment matches the requested task name.
const FINAL_ANSWER = 'FINAL_ANSWER';

// A recorded launch without a terminal result has unknown completion status. Do not label it as running.
const LAUNCHED = 'launched';

interface Entry {
  kind: string;
  wrapper?: string;
  at: number;
  payload: Record<string, unknown>;
}

export interface CodexUsageRecord {
  kind: string;
  timestamp: number;
  payload: Record<string, unknown>;
  sourceStart?: number;
  sourceEnd?: number;
}

export const CODEX_USAGE_ASSOCIATION_LIMIT = 64;

// JSON data only, so a scanner can persist it together with its file position.
export interface CodexUsageReducerState {
  nativeCacheChild?: boolean;
  provider: string | null;
  openingTimestamp: number | null;
  openingSessionId: string | null;
  nativeSpawnedAt: number | null;
  pendingOwnership: Record<string, true>;
  currentTurnRepeated: boolean;
  agentPath: string | null;
  foreignSessionMeta: boolean;
  currentTurnId: string | null;
  currentTurnCopied: boolean;
  recentTurnIds: string[];
  seenTurnIds: Record<string, true>;
  seenTurnOffsets: Record<string, number>;
  legacyReplayLinks: Array<{ id: string; evidenceOffset: number; replayOffset: number }>;
  replayResetRequired: boolean;
  copiedTurnIds: Record<string, true>;
  datedCopiedTurnIds: Record<string, true>;
  countedTurnIds: Record<string, true>;
  turnModels: Record<string, string | null>;
  turnEfforts: Record<string, string | null>;
  turnWindows: Record<string, number | null>;
  planType: string | null;
  planKnown: boolean;
  serviceTier: string | null;
  reasoningEffort: string | null;
  requestNumber: number;
  lastUsageSnapshot: { turnId: string; last: number[]; total: number[] } | null;
  pendingRequests: Record<string, UsageEvent[]>;
  pendingRequestKeys: string[];
  pendingRequestSources: Record<string, { start: number; end: number }>;
  recentClaudeInvocationIds: string[];
  seenClaudeInvocations: Record<string, true>;
  recentClaudeCommandIds: string[];
  seenClaudeCommands: Record<string, true>;
  pendingClaudeResultIds: string[];
  pendingClaudeResults: Record<string, UsageEvent>;
  closedTurns: number;
  currentTurnDidSomething: boolean;
  currentTurnCompleted: boolean;
  // How many `compacted` records this rollout has held.
  compactionCount: number;
  // The newest of those records, oldest first. `RETAINED_COMPACTIONS` bounds it, so
  // compactionCount stays the exact total and this list only describes them.
  recentCompactions: ReducerCompaction[];
  // A delayed turn context can identify an earlier turn as copied. Keep its compaction
  // ordinals so that correction removes both the count and the retained detail.
  compactionTurnOrdinals: Record<string, number[]>;
  // Following settings name the compaction's billing identity. Clear its ordinal when settings arrive or the turn closes.
  pendingCompactionBilling: number | null;
  recentResponseUsage: Array<{
    responseId: string;
    turnId: string;
    usage: TurnUsage;
    matched?: true;
    explicitSnapshot?: true;
    suppressedSnapshot?: UsageEvent;
  }>;
  recentRequestEvents: UsageEvent[];
  compactionResponseIds: string[];
  // The very first non-copied turn's startedAt, epoch milliseconds. Set once and never moved.
  firstTurnAt: number | null;
  // The latest counted turn's end, or its start when it never completed. Updated on each counted close.
  lastTurnAt: number | null;
  // The most recently begun non-copied turn's startedAt, and its endedAt once it has completed.
  currentTurnStartedAt: number | null;
  currentTurnEndedAt: number | null;
  currentTurnOutcome: TurnOutcome | null;
  lastTurnStartedAt: number | null;
  lastTurnOutcome: TurnOutcome | null;
}

export function emptyCodexUsageReducerState(
  provider: string | null = null,
  openingTimestamp: number | null = null,
  openingSessionId: string | null = null,
  agentPath: string | null = null,
  nativeSpawnedAt: number | null = null,
): CodexUsageReducerState {
  return {
    provider,
    openingTimestamp,
    openingSessionId,
    nativeSpawnedAt,
    pendingOwnership: {},
    currentTurnRepeated: false,
    agentPath,
    foreignSessionMeta: false,
    currentTurnId: null,
    currentTurnCopied: false,
    recentTurnIds: [],
    seenTurnIds: {},
    seenTurnOffsets: {},
    legacyReplayLinks: [],
    replayResetRequired: false,
    copiedTurnIds: {},
    datedCopiedTurnIds: {},
    countedTurnIds: {},
    turnModels: {},
    turnEfforts: {},
    turnWindows: {},
    planType: null,
    planKnown: false,
    serviceTier: null,
    reasoningEffort: null,
    requestNumber: 0,
    lastUsageSnapshot: null,
    pendingRequests: {},
    pendingRequestKeys: [],
    pendingRequestSources: {},
    recentClaudeInvocationIds: [],
    seenClaudeInvocations: {},
    recentClaudeCommandIds: [],
    seenClaudeCommands: {},
    pendingClaudeResultIds: [],
    pendingClaudeResults: {},
    closedTurns: 0,
    currentTurnDidSomething: false,
    currentTurnCompleted: false,
    compactionCount: 0,
    recentCompactions: [],
    compactionTurnOrdinals: {},
    pendingCompactionBilling: null,
    recentResponseUsage: [],
    recentRequestEvents: [],
    compactionResponseIds: [],
    firstTurnAt: null,
    lastTurnAt: null,
    currentTurnStartedAt: null,
    currentTurnEndedAt: null,
    currentTurnOutcome: null,
    lastTurnStartedAt: null,
    lastTurnOutcome: null,
  };
}

function rememberRecentIdentity(ids: string[], id: string): void {
  const prior = ids.indexOf(id);
  if (prior >= 0) {
    ids.splice(prior, 1);
  }
  ids.push(id);
}

function synchronizeIdentityQueue(ids: string[], current: readonly string[]): void {
  const present = new Set(current);
  for (let index = ids.length - 1; index >= 0; index--) {
    if (!present.has(ids[index])) {
      ids.splice(index, 1);
    }
  }
  const remembered = new Set(ids);
  for (const id of current) {
    if (!remembered.has(id)) {
      ids.push(id);
      remembered.add(id);
    }
  }
}

function forgetIdentity(ids: string[], id: string): void {
  const index = ids.indexOf(id);
  if (index >= 0) {
    ids.splice(index, 1);
  }
}

function discardPendingRequestKey(state: CodexUsageReducerState, requestKey: string): void {
  forgetIdentity(state.pendingRequestKeys, requestKey);
  delete state.pendingRequestSources[requestKey];
}

function releasePendingRequest(state: CodexUsageReducerState, requestKey: string): UsageEvent | null {
  for (const [turnId, events] of Object.entries(state.pendingRequests)) {
    const index = events.findIndex((event) => event.requestKey === requestKey);
    if (index < 0) {
      continue;
    }
    const [event] = events.splice(index, 1);
    if (events.length === 0) {
      delete state.pendingRequests[turnId];
    }
    discardPendingRequestKey(state, requestKey);
    return event;
  }
  discardPendingRequestKey(state, requestKey);
  return null;
}

function synchronizeCodexSpendAssociations(state: CodexUsageReducerState): void {
  synchronizeIdentityQueue(state.recentTurnIds, Object.keys(state.seenTurnIds));
  if (state.currentTurnId && state.seenTurnIds[state.currentTurnId]) {
    rememberRecentIdentity(state.recentTurnIds, state.currentTurnId);
  }
  synchronizeIdentityQueue(
    state.pendingRequestKeys,
    Object.values(state.pendingRequests).flatMap((events) => events.map((event) => event.requestKey)),
  );
  synchronizeIdentityQueue(state.recentClaudeInvocationIds, Object.keys(state.seenClaudeInvocations));
  synchronizeIdentityQueue(state.recentClaudeCommandIds, Object.keys(state.seenClaudeCommands));
  synchronizeIdentityQueue(state.pendingClaudeResultIds, Object.keys(state.pendingClaudeResults));
}

function compactCodexSpendAssociations(state: CodexUsageReducerState): UsageEvent[] {
  const released: UsageEvent[] = [];
  const unresolved = (event: UsageEvent, turnId: string): UsageEvent =>
    state.pendingOwnership[turnId] ? { ...event, incomplete: true } : event;
  while (state.recentTurnIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const turnId = state.recentTurnIds.shift();
    if (!turnId) {
      continue;
    }
    for (const event of state.pendingRequests[turnId] ?? []) {
      released.push(unresolved(event, turnId));
      discardPendingRequestKey(state, event.requestKey);
    }
    delete state.pendingRequests[turnId];
    delete state.seenTurnIds[turnId];
    delete state.seenTurnOffsets[turnId];
    delete state.copiedTurnIds[turnId];
    delete state.datedCopiedTurnIds[turnId];
    delete state.countedTurnIds[turnId];
    delete state.turnModels[turnId];
    delete state.turnEfforts[turnId];
    delete state.turnWindows[turnId];
    delete state.pendingOwnership[turnId];
    delete state.compactionTurnOrdinals[turnId];
    state.legacyReplayLinks = state.legacyReplayLinks.filter((link) => link.id !== turnId);
  }
  const retainedTurnIds = new Set(state.recentTurnIds);
  for (const turnId of Object.keys(state.pendingRequests)) {
    if (retainedTurnIds.has(turnId)) {
      continue;
    }
    for (const event of state.pendingRequests[turnId]) {
      released.push(unresolved(event, turnId));
      discardPendingRequestKey(state, event.requestKey);
    }
    delete state.pendingRequests[turnId];
  }
  for (const association of [
    state.seenTurnOffsets,
    state.copiedTurnIds,
    state.datedCopiedTurnIds,
    state.countedTurnIds,
    state.turnModels,
    state.turnEfforts,
    state.turnWindows,
    state.pendingOwnership,
  ] as Array<Record<string, unknown>>) {
    for (const turnId of Object.keys(association)) {
      if (!retainedTurnIds.has(turnId)) {
        delete association[turnId];
      }
    }
  }
  for (const turnId of Object.keys(state.compactionTurnOrdinals)) {
    if (!retainedTurnIds.has(turnId)) {
      delete state.compactionTurnOrdinals[turnId];
    }
  }
  state.legacyReplayLinks = state.legacyReplayLinks.filter((link) => retainedTurnIds.has(link.id));
  while (state.pendingRequestKeys.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const requestKey = state.pendingRequestKeys[0];
    const event = releasePendingRequest(state, requestKey);
    if (event) {
      const turnId =
        event.visibleTurnId?.replace(/^codex-turn:/, '') ?? /^codex:([^:]+):/.exec(event.requestKey)?.[1] ?? '';
      released.push(unresolved(event, turnId));
    }
  }
  while (state.recentClaudeInvocationIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const id = state.recentClaudeInvocationIds.shift();
    if (id) {
      delete state.seenClaudeInvocations[id];
    }
  }
  while (state.recentClaudeCommandIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const id = state.recentClaudeCommandIds.shift();
    if (id) {
      delete state.seenClaudeCommands[id];
    }
  }
  while (state.pendingClaudeResultIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const id = state.pendingClaudeResultIds.shift();
    if (id) {
      delete state.pendingClaudeResults[id];
    }
  }
  return released;
}

function recordedTurnStart(payload: Record<string, unknown>): number | null {
  const value = num(payload.started_at);
  if (value === null || value <= 0) {
    return null;
  }
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function utcDate(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function recordedDatePredatesOpening(
  value: unknown,
  state: Pick<CodexUsageReducerState, 'openingTimestamp' | 'foreignSessionMeta'>,
): boolean {
  if (state.openingTimestamp === null || typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const previousDate = utcDate(state.openingTimestamp - 24 * 60 * 60 * 1_000);
  if (value < previousDate) {
    return true;
  }
  if (value !== previousDate) {
    return false;
  }
  // Near midnight, a local date still precedes the UTC date. Before midday UTC, require a foreign replay record.
  const utcHour = new Date(state.openingTimestamp).getUTCHours();
  return utcHour >= 12 || state.foreignSessionMeta;
}

function pruneCodexReplayLedger(state: CodexUsageReducerState, replayFloor: number): void {
  state.legacyReplayLinks = state.legacyReplayLinks.filter((link) => {
    if (link.replayOffset < replayFloor) {
      return false;
    }
    if (link.evidenceOffset < replayFloor) {
      state.replayResetRequired = true;
      return false;
    }
    return true;
  });
  for (const id of Object.keys(state.seenTurnIds)) {
    const offset = state.seenTurnOffsets[id];
    if (offset === undefined ? replayFloor > 0 : offset < replayFloor) {
      delete state.seenTurnIds[id];
      delete state.seenTurnOffsets[id];
    }
  }
}

function beginCodexTurn(state: CodexUsageReducerState, payload: Record<string, unknown>, sourceStart?: number): void {
  const turnId = str(payload.turn_id);
  const repeated = turnId !== null && Object.hasOwn(state.seenTurnIds, turnId);
  const evidenceOffset = turnId === null ? undefined : state.seenTurnOffsets[turnId];
  const startedAt = recordedTurnStart(payload);
  const copiedByClock =
    startedAt !== null &&
    state.openingTimestamp !== null &&
    (startedAt < state.openingTimestamp - CODEX_REPLAY_CLOCK_SLACK_MS ||
      (state.nativeSpawnedAt !== null && startedAt === state.nativeSpawnedAt));
  if (startedAt !== null && !copiedByClock) {
    state.foreignSessionMeta = false;
  }
  state.currentTurnId = turnId;
  state.currentTurnRepeated = repeated;
  state.currentTurnCopied = repeated || copiedByClock;
  if (
    turnId &&
    !repeated &&
    copiedByClock &&
    !state.foreignSessionMeta &&
    startedAt !== null &&
    state.nativeSpawnedAt !== null &&
    startedAt >= state.nativeSpawnedAt - CODEX_TURN_START_ROUNDING_MS
  ) {
    state.pendingOwnership[turnId] = true;
  }
  if (turnId) {
    if (repeated && !copiedByClock && sourceStart !== undefined && evidenceOffset !== undefined) {
      state.legacyReplayLinks.push({ id: turnId, evidenceOffset, replayOffset: sourceStart });
    }
    state.seenTurnIds[turnId] = true;
    if (sourceStart !== undefined) {
      state.seenTurnOffsets[turnId] = sourceStart;
    }
    if (state.currentTurnCopied) {
      state.copiedTurnIds[turnId] = true;
    }
  }
}

function discardPendingCodexRequests(state: CodexUsageReducerState, turnId: string): void {
  for (const event of state.pendingRequests[turnId] ?? []) {
    delete state.pendingRequestSources[event.requestKey];
  }
  delete state.pendingRequests[turnId];
  delete state.pendingOwnership[turnId];
}

function retractCodexUsageCompactions(state: CodexUsageReducerState, ordinals: readonly number[]): void {
  const retracted = new Set(ordinals);
  if (!retracted.size) {
    return;
  }
  const earlierRetracted = (ordinal: number) => [...retracted].filter((item) => item < ordinal).length;
  state.compactionCount = Math.max(0, state.compactionCount - retracted.size);
  state.recentCompactions = state.recentCompactions
    .filter((item) => !retracted.has(item.ordinal))
    .map((item) => ({ ...item, ordinal: item.ordinal - earlierRetracted(item.ordinal) }));
  for (const [id, associated] of Object.entries(state.compactionTurnOrdinals)) {
    const kept = associated
      .filter((ordinal) => !retracted.has(ordinal))
      .map((ordinal) => ordinal - earlierRetracted(ordinal));
    if (kept.length) {
      state.compactionTurnOrdinals[id] = kept;
    } else {
      delete state.compactionTurnOrdinals[id];
    }
  }
  if (state.pendingCompactionBilling !== null) {
    state.pendingCompactionBilling = retracted.has(state.pendingCompactionBilling)
      ? null
      : state.pendingCompactionBilling - earlierRetracted(state.pendingCompactionBilling);
  }
}

function applyCodexTurnDate(state: CodexUsageReducerState, payload: Record<string, unknown>): void {
  const turnId = str(payload.turn_id);
  if (!turnId || (state.copiedTurnIds[turnId] && !state.pendingOwnership[turnId])) {
    return;
  }
  if (!recordedDatePredatesOpening(payload.current_date, state)) {
    return;
  }
  state.copiedTurnIds[turnId] = true;
  state.datedCopiedTurnIds[turnId] = true;
  const compactionOrdinals = state.compactionTurnOrdinals[turnId] ?? [];
  if (compactionOrdinals.length) {
    retractCodexUsageCompactions(state, compactionOrdinals);
  }
  if (turnId === state.currentTurnId) {
    state.currentTurnCopied = true;
    state.currentTurnOutcome = null;
  }
  if (state.countedTurnIds[turnId]) {
    state.closedTurns = Math.max(0, state.closedTurns - 1);
    delete state.countedTurnIds[turnId];
    // Retracting a counted turn invalidates both span boundaries. Rebuild them from subsequent counted turns.
    state.firstTurnAt = null;
    state.lastTurnAt = null;
    state.lastTurnStartedAt = null;
    state.lastTurnOutcome = null;
  }
  discardPendingCodexRequests(state, turnId);
}

function bedrockInferenceClass(model: string | null): UsageEvent['inferenceClass'] {
  return resolveModelPricing(model, 'amazon-bedrock')?.inferenceClass ?? null;
}

function requestInputTokens(usage: TurnUsage): number {
  return usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead;
}

// Codex uses the same count fields for ordinary requests and recent completed compactions.
// The latter lives under `latest_token_usage_record.usage`, while cumulative counters do not
// identify one billed request and must never price a compaction card.
export function codexRequestUsage(value: unknown): TurnUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (codexRetainedContextTokens(value) !== null) return null;
  const input = num(value.input_tokens);
  const cached = num(value.cached_input_tokens);
  const written = num(value.cache_write_input_tokens);
  const output = num(value.output_tokens);
  const thinking = num(value.reasoning_output_tokens);
  if (input === null && cached === null && written === null && output === null && thinking === null) {
    return null;
  }
  const usage = emptyUsage();
  usage.requests = 1;
  usage.input = Math.max(0, (input ?? 0) - (cached ?? 0) - (written ?? 0));
  usage.cacheRead = cached ?? 0;
  usage.cacheWrite30m = written ?? 0;
  usage.output = output ?? 0;
  usage.thinking = thinking ?? 0;
  return usage;
}

export function codexRetainedContextTokens(value: unknown): number | null {
  if (!isRecord(value) || value.input_tokens !== 0 || value.output_tokens !== 0) return null;
  if (
    ![value.cached_input_tokens, value.cache_write_input_tokens, value.reasoning_output_tokens].every(
      (count) => count === 0 || count === undefined,
    )
  )
    return null;
  return typeof value.total_tokens === 'number' && Number.isSafeInteger(value.total_tokens) && value.total_tokens > 0
    ? value.total_tokens
    : null;
}

const CODEX_USAGE_COUNTERS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;

function codexUsageCounters(value: unknown): number[] | null {
  if (!isRecord(value)) {
    return null;
  }
  const counters = CODEX_USAGE_COUNTERS.map((key) => num(value[key]));
  return counters.every((counter) => counter !== null) ? counters : null;
}

function sameCounters(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((counter, index) => counter === right[index]);
}

// Reduces records that affect request identity as well as token counts.
function sameCodexRequestUsage(left: TurnUsage, right: TurnUsage): boolean {
  return ['input', 'cacheRead', 'cacheWrite1h', 'cacheWrite5m', 'cacheWrite30m', 'output', 'thinking'].every(
    (key) => (left[key as keyof TurnUsage] ?? 0) === (right[key as keyof TurnUsage] ?? 0),
  );
}

function removeCodexRequest(event: UsageEvent): UsageEvent {
  return {
    ...event,
    usage: Object.fromEntries(Object.entries(event.usage).map(([key, value]) => [key, -value])) as unknown as TurnUsage,
  };
}

export function reduceCodexUsageEvents(state: CodexUsageReducerState, record: CodexUsageRecord): readonly UsageEvent[] {
  state.recentResponseUsage ??= [];
  state.recentRequestEvents ??= [];
  state.compactionResponseIds ??= [];
  const events = reduceCodexUsageEventsInner(state, record);
  for (const event of events) {
    const index = state.recentRequestEvents.findIndex((held) => held.requestKey === event.requestKey);
    if (index >= 0) state.recentRequestEvents.splice(index, 1);
    if ((event.usage.requests ?? 1) > 0) state.recentRequestEvents.push(event);
  }
  state.recentRequestEvents.splice(0, Math.max(0, state.recentRequestEvents.length - CODEX_USAGE_ASSOCIATION_LIMIT));
  return events;
}

function reduceCodexUsageEventsInner(state: CodexUsageReducerState, record: CodexUsageRecord): readonly UsageEvent[] {
  const { kind, payload } = record;
  if (kind === 'session_meta') {
    const sessionId = str(payload.id) ?? str(payload.session_id);
    if (state.openingTimestamp === null) {
      const replayBoundaryAt = codexReplayBoundaryAt(record.timestamp || null, payload);
      if (replayBoundaryAt !== null) {
        state.openingTimestamp = replayBoundaryAt;
        state.openingSessionId = sessionId;
        state.foreignSessionMeta = false;
      }
    } else if (sessionId && state.openingSessionId) {
      state.foreignSessionMeta = sessionId !== state.openingSessionId;
    }
    if (!state.foreignSessionMeta) {
      const meta = openingRecordOf(JSON.stringify({ type: 'session_meta', payload }));
      state.nativeCacheChild ||= meta?.parentThreadId !== null && meta?.parentThreadId !== undefined;
      state.agentPath = codexAgentPath(payload) ?? state.agentPath;
      state.nativeSpawnedAt = nativeSpawnPayloadAt(record.timestamp || null, payload) ?? state.nativeSpawnedAt;
    }
    state.provider = str(payload.model_provider) ?? state.provider;
    return [];
  }
  if (kind === 'token_usage_record') {
    const corrections: UsageEvent[] = [];
    const turnId = str(payload.turn_id);
    const responseId = str(payload.response_id);
    const usage = codexRequestUsage(payload.usage);
    if (
      turnId &&
      responseId &&
      usage &&
      !state.foreignSessionMeta &&
      !state.datedCopiedTurnIds[turnId] &&
      (!state.openingSessionId || !str(payload.thread_id) || str(payload.thread_id) === state.openingSessionId)
    ) {
      const prior = state.recentResponseUsage.find((item) => item.responseId === responseId);
      const association = prior ?? { responseId, turnId, usage };
      if (!prior) state.recentResponseUsage.push(association);
      state.recentResponseUsage.splice(
        0,
        Math.max(0, state.recentResponseUsage.length - CODEX_USAGE_ASSOCIATION_LIMIT),
      );
      const anonymous = association.matched
        ? undefined
        : [...state.recentRequestEvents, ...(state.pendingRequests[turnId] ?? [])]
            .reverse()
            .find(
              (event) =>
                !event.responseId &&
                event.visibleTurnId === `codex-turn:${turnId}` &&
                sameCodexRequestUsage(event.usage, usage),
            );
      if (anonymous) {
        anonymous.responseId = responseId;
        association.matched = true;
        if (state.compactionResponseIds.includes(responseId)) {
          const pending = releasePendingRequest(state, anonymous.requestKey);
          if (!pending) corrections.push(removeCodexRequest(anonymous));
          association.suppressedSnapshot = anonymous;
        }
      } else if (!prior && !state.compactionResponseIds.includes(responseId)) {
        const held = [...state.recentResponseUsage]
          .reverse()
          .find(
            (item) =>
              state.compactionResponseIds.includes(item.responseId) &&
              !item.explicitSnapshot &&
              item.turnId === turnId &&
              item.suppressedSnapshot &&
              sameCodexRequestUsage(item.usage, usage),
          );
        if (held?.suppressedSnapshot) {
          const restored = {
            ...held.suppressedSnapshot,
            responseId,
            requestKey: `codex-response:${responseId}`,
            requestCountExact: false as const,
          };
          restored.model ??= state.turnModels[turnId] ?? null;
          restored.contextBand = contextBandForRequest(
            restored.model,
            restored.provider,
            requestInputTokens(restored.usage),
          );
          restored.inferenceClass =
            restored.provider === 'amazon-bedrock' ? bedrockInferenceClass(restored.model) : null;
          association.suppressedSnapshot = restored;
          if (!restored.model || state.pendingOwnership[turnId]) {
            (state.pendingRequests[turnId] ??= []).push(restored);
            if (record.sourceStart !== undefined)
              state.pendingRequestSources[restored.requestKey] = {
                start: record.sourceStart,
                end: record.sourceEnd ?? record.sourceStart,
              };
          } else corrections.push(restored);
        }
      }
    }
    if (
      !turnId ||
      !state.pendingOwnership[turnId] ||
      state.foreignSessionMeta ||
      str(payload.thread_id) !== state.openingSessionId ||
      !str(payload.response_id) ||
      state.datedCopiedTurnIds[turnId]
    )
      return corrections;
    delete state.pendingOwnership[turnId];
    if (state.currentTurnId !== turnId || !state.currentTurnRepeated) delete state.copiedTurnIds[turnId];
    if (state.currentTurnId === turnId && !state.currentTurnRepeated) {
      state.currentTurnCopied = false;
      state.currentTurnDidSomething = true;
    } else if (!state.countedTurnIds[turnId]) {
      state.countedTurnIds[turnId] = true;
      state.closedTurns++;
    }
    const pending = state.pendingRequests[turnId] ?? [];
    const ready = pending.filter((event) => event.agent === 'claude' || event.model !== null);
    const waiting = pending.filter((event) => event.agent === 'codex' && event.model === null);
    if (waiting.length) state.pendingRequests[turnId] = waiting;
    else delete state.pendingRequests[turnId];
    for (const event of ready) forgetIdentity(state.pendingRequestKeys, event.requestKey);
    return [...corrections, ...ready];
  }
  if (kind === 'rate_limits') {
    state.planKnown = true;
    state.planType = str(payload.plan_type);
    return [];
  }
  if (kind === 'thread_settings_applied') {
    const settings = (payload.thread_settings || {}) as Record<string, unknown>;
    const model = str(settings.model) ?? str(settings.model_id) ?? (settings.model === '' ? '' : null);
    const provider = str(settings.model_provider_id);
    const serviceTier = str(settings.service_tier);
    state.reasoningEffort = str(settings.reasoning_effort) ?? state.reasoningEffort;
    state.serviceTier = serviceTier ?? state.serviceTier;
    state.provider = provider ?? state.provider;
    // A compaction records its own usage without the identity that billed it. This is the
    // record that names that identity, and it is the same rule the session reader applies.
    const waiting = state.pendingCompactionBilling;
    const held = waiting === null ? undefined : state.recentCompactions.find((item) => item.ordinal === waiting);
    if (held) {
      held.requestModel = model ?? held.requestModel;
      held.requestProvider = provider ?? held.requestProvider;
      held.requestServiceTier = serviceTier ?? held.requestServiceTier;
    }
    state.pendingCompactionBilling = null;
    if (!held) return [];
    const key = held.responseId ? `codex-response:${held.responseId}` : `codex-compaction:${held.ordinal}`;
    const pending = Object.values(state.pendingRequests)
      .flat()
      .find((item) => item.compactionUsage && item.requestKey === key);
    const emitted = state.recentRequestEvents.find((item) => item.compactionUsage && item.requestKey === key);
    const event = pending ?? (emitted ? { ...emitted } : undefined);
    if (!event) return [];
    event.model = held.requestModel;
    event.provider = held.requestProvider;
    event.serviceTier = held.requestServiceTier;
    event.inferenceClass = event.provider === 'amazon-bedrock' ? bedrockInferenceClass(event.model) : null;
    event.contextBand = contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage));
    if (event.model && held.responseId) delete event.incomplete;
    const turnId = event.visibleTurnId?.replace(/^codex-turn:/, '') ?? '';
    if (state.pendingOwnership[turnId]) return [];
    return pending ? [releasePendingRequest(state, key)!] : [removeCodexRequest(emitted!), event];
  }
  if (kind === 'task_started') {
    if (state.currentTurnId && !state.currentTurnCopied && state.currentTurnDidSomething) {
      state.closedTurns++;
      state.countedTurnIds[state.currentTurnId] = true;
      // The span must cover only the turns turnCount() counts. A turn that closes without
      // ever doing anything is skipped above, and it must not anchor the span either.
      if (state.firstTurnAt === null) {
        state.firstTurnAt = state.currentTurnStartedAt;
      }
      state.lastTurnAt =
        state.currentTurnCompleted && state.currentTurnEndedAt !== null
          ? state.currentTurnEndedAt
          : state.currentTurnStartedAt;
      state.lastTurnStartedAt = state.currentTurnStartedAt;
      state.lastTurnOutcome = state.currentTurnOutcome ? { ...state.currentTurnOutcome } : null;
    }
    beginCodexTurn(state, payload, record.sourceStart);
    state.currentTurnDidSomething = false;
    state.currentTurnCompleted = false;
    // A copied or replayed turn is not a new last turn. Its start and end are left alone so
    // the most recent real turn keeps standing for the session's span.
    if (!state.currentTurnCopied || (state.currentTurnId && state.pendingOwnership[state.currentTurnId])) {
      state.currentTurnStartedAt = record.timestamp;
      state.currentTurnEndedAt = null;
      state.currentTurnOutcome = {
        finished: false,
        error: false,
        interrupted: false,
        endedAt: record.timestamp,
        startedAt: record.timestamp,
      };
    } else {
      state.currentTurnOutcome = null;
    }
    const window = num(payload.model_context_window);
    if (
      state.currentTurnId &&
      window !== null &&
      (!state.currentTurnCopied || state.pendingOwnership[state.currentTurnId])
    ) {
      state.turnWindows[state.currentTurnId] = window;
    }
    return [];
  }
  if (state.currentTurnRepeated && state.nativeSpawnedAt !== null) return [];
  if (kind === 'compacted') {
    const latest = isRecord(payload.latest_token_usage_record) ? payload.latest_token_usage_record : {};
    const responseId = str(payload.compaction_response_id) ?? str(latest.response_id);
    if (responseId && state.compactionResponseIds.includes(responseId)) return [];
    const corrections: UsageEvent[] = [];
    if (!state.currentTurnCopied) {
      state.compactionCount++;
      // Retain the compaction's own request usage and the turn's model and window.
      // The following settings record supplies the request's billing identity, provider, and service tier.
      const turnId = state.currentTurnId;
      const requestUsage = codexRequestUsage(
        isRecord(payload.latest_token_usage_record) ? payload.latest_token_usage_record.usage : null,
      );
      retainNewestCompaction(state, {
        ordinal: state.compactionCount,
        at: Number.isFinite(record.timestamp) && record.timestamp > 0 ? record.timestamp : null,
        trigger: codexCompactionTrigger(
          state.currentTurnId !== null,
          state.currentTurnCopied,
          state.currentTurnDidSomething,
        ),
        requestUsage,
        requestModel: turnId ? (state.turnModels[turnId] ?? null) : null,
        requestProvider: state.provider,
        requestServiceTier: state.serviceTier,
        requestContextWindow: turnId ? (state.turnWindows[turnId] ?? null) : null,
        ...(responseId ? { responseId } : {}),
      });
      if (turnId) {
        const ordinals = (state.compactionTurnOrdinals[turnId] ??= []);
        ordinals.push(state.compactionCount);
        while (ordinals.length > RETAINED_COMPACTIONS) {
          ordinals.shift();
        }
      }
      // Identified responses and recorded usage retain the following billing settings.
      state.pendingCompactionBilling = requestUsage || responseId ? state.compactionCount : null;
      if (requestUsage && responseId) {
        if (responseId) {
          let association = state.recentResponseUsage.find((item) => item.responseId === responseId);
          if (!association) {
            association = { responseId, turnId: turnId ?? '', usage: requestUsage };
            state.recentResponseUsage.push(association);
          }
          state.recentResponseUsage.splice(
            0,
            Math.max(0, state.recentResponseUsage.length - CODEX_USAGE_ASSOCIATION_LIMIT),
          );
          state.compactionResponseIds.push(responseId);
          state.compactionResponseIds.splice(
            0,
            Math.max(0, state.compactionResponseIds.length - CODEX_USAGE_ASSOCIATION_LIMIT),
          );
          const prior = [...state.recentRequestEvents]
            .reverse()
            .find(
              (item) =>
                item.responseId === responseId ||
                (!item.responseId &&
                  item.visibleTurnId === `codex-turn:${turnId}` &&
                  sameCodexRequestUsage(item.usage, requestUsage)),
            );
          if (prior) {
            corrections.push(removeCodexRequest(prior));
            if (!association.explicitSnapshot) association.suppressedSnapshot = prior;
            association.matched = true;
          }
          const pending = Object.values(state.pendingRequests)
            .flat()
            .find(
              (item) =>
                item.responseId === responseId ||
                (!item.responseId &&
                  item.visibleTurnId === `codex-turn:${turnId}` &&
                  sameCodexRequestUsage(item.usage, requestUsage)),
            );
          if (pending) {
            releasePendingRequest(state, pending.requestKey);
            if (!association.explicitSnapshot) association.suppressedSnapshot = pending;
            association.matched = true;
          }
        }
        const event: UsageEvent = {
          timestamp: record.timestamp,
          agent: 'codex',
          provider: state.provider,
          model: null,
          contextWindow: turnId ? (state.turnWindows[turnId] ?? null) : null,
          contextBand: null,
          billingClass:
            state.provider && state.provider !== 'openai'
              ? 'metered'
              : state.planType
                ? 'subscription'
                : state.planKnown
                  ? 'metered'
                  : 'unknown',
          inferenceClass: null,
          serviceTier: state.serviceTier,
          reportedCost: null,
          visibleTurnId: turnId ? `codex-turn:${turnId}` : null,
          compactionUsage: true,
          incomplete: true,
          compactionsBefore: state.compactionCount,
          usage: requestUsage,
          requestKey: responseId ? `codex-response:${responseId}` : `codex-compaction:${state.compactionCount}`,
          ...(responseId ? { responseId } : {}),
        };
        if (turnId && state.pendingOwnership[turnId]) (state.pendingRequests[turnId] ??= []).push(event);
        else corrections.push(event);
      } else if (requestUsage) {
        corrections.push({
          timestamp: record.timestamp,
          agent: 'codex',
          provider: state.provider,
          model: null,
          contextWindow: null,
          contextBand: null,
          billingClass: 'unknown',
          inferenceClass: null,
          serviceTier: state.serviceTier,
          reportedCost: null,
          visibleTurnId: turnId ? `codex-turn:${turnId}` : null,
          compactionUsage: true,
          incomplete: true,
          requestCountExact: false,
          usage: { ...emptyUsage(), requests: 1 },
          requestKey: `codex-compaction:${state.compactionCount}`,
        });
      }
    }
    return corrections;
  }
  if (kind === 'turn_context') {
    applyCodexTurnDate(state, payload);
    const id = str(payload.turn_id);
    if (id && state.datedCopiedTurnIds[id]) {
      return state.recentRequestEvents
        .filter((event) => event.visibleTurnId === `codex-turn:${id}`)
        .map(removeCodexRequest);
    }
  }
  if (state.currentTurnId && !state.currentTurnCompleted) {
    const entry = { kind, at: record.timestamp, payload };
    if (kind === 'task_complete' || kind === 'turn_aborted') {
      state.currentTurnCompleted = true;
      // The settings record that names a compaction's billing identity arrives before its own
      // turn closes. After that, a later settings record describes a different request.
      state.pendingCompactionBilling = null;
      if (!state.currentTurnCopied || state.pendingOwnership[state.currentTurnId]) {
        state.currentTurnEndedAt = record.timestamp;
      }
    }
    if (!state.currentTurnCopied && codexTurnRecordDidSomething(entry, state.agentPath)) {
      state.currentTurnDidSomething = true;
    }
    if ((!state.currentTurnCopied || state.pendingOwnership[state.currentTurnId]) && state.currentTurnOutcome) {
      if (
        parsedUpdate(payload) ||
        kind === 'custom_tool_call' ||
        kind === 'function_call' ||
        kind === 'web_search_call' ||
        kind === 'patch_apply_end' ||
        kind === 'custom_tool_call_output' ||
        kind === 'function_call_output' ||
        kind === 'item_completed' ||
        kind === 'sub_agent_activity' ||
        kind === 'agent_message' ||
        kind === 'task_complete' ||
        kind === 'turn_aborted' ||
        kind === 'token_count'
      ) {
        state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, record.timestamp);
      }
      if (failedCodexTurn(entry)) {
        state.currentTurnOutcome.error = true;
      }
      if (finishedCodexTurn(entry)) {
        state.currentTurnOutcome.finished = true;
      }
      if (interruptedCodexTurn(entry)) {
        state.currentTurnOutcome.interrupted = true;
      }
    }
  }
  if (
    state.currentTurnCopied &&
    !(
      state.currentTurnId &&
      state.pendingOwnership[state.currentTurnId] &&
      (kind === 'turn_context' || kind === 'token_count' || kind === 'item_completed')
    )
  ) {
    return [];
  }
  if (kind === 'item_completed') {
    const result = claudeCommandResult(payload);
    if (!result || !state.currentTurnId) {
      return [];
    }
    const commandKey = result.commandId ?? `source:${record.sourceStart ?? 'unknown'}`;
    if (!result.accepted) {
      if (state.seenClaudeCommands[commandKey] || state.pendingClaudeResults[commandKey]) {
        return [];
      }
      const incomplete: UsageEvent = {
        timestamp: record.timestamp,
        agent: 'claude',
        provider: null,
        model: null,
        contextWindow: null,
        contextBand: null,
        billingClass: 'unknown',
        inferenceClass: null,
        serviceTier: null,
        reportedCost: null,
        reportedCostBasis: null,
        linkedSessionId: result.sessionId,
        linkedInvocationId: result.invocationId,
        incomplete: true,
        usage: { ...emptyUsage(), requests: 1 },
        requestKey: `claude-incomplete:${commandKey}`,
      };
      state.pendingClaudeResults[commandKey] = incomplete;
      if (state.pendingOwnership[state.currentTurnId]) {
        incomplete.visibleTurnId = `codex-turn:${state.currentTurnId}`;
        (state.pendingRequests[state.currentTurnId] ??= []).push(incomplete);
        return [];
      }
      return [incomplete];
    }
    if (state.seenClaudeCommands[commandKey] || state.seenClaudeInvocations[result.invocationId]) {
      return [];
    }
    state.seenClaudeCommands[commandKey] = true;
    state.seenClaudeInvocations[result.invocationId] = true;
    const pending = state.pendingClaudeResults[commandKey];
    delete state.pendingClaudeResults[commandKey];
    const heldIncomplete = pending?.visibleTurnId ? releasePendingRequest(state, pending.requestKey) : null;
    const replacement =
      pending && !heldIncomplete
        ? [
            {
              ...pending,
              usage: { ...pending.usage, requests: -1 },
            },
          ]
        : [];
    const accepted: UsageEvent[] = result.models.map((part, index) => ({
      timestamp: record.timestamp,
      agent: 'claude',
      provider: part.provider ?? null,
      model: part.model,
      contextWindow: part.contextWindow ?? null,
      contextBand: null,
      billingClass: 'unknown',
      inferenceClass: null,
      serviceTier: null,
      reportedCost: part.recordedCost ?? null,
      reportedCostBasis: part.costBasis ?? null,
      linkedSessionId: result.sessionId,
      linkedInvocationId: result.invocationId,
      requestCountExact: false,
      unclassifiedCacheWrite: part.unclassifiedCacheWrite,
      usage: part.usage,
      requestKey: `${result.invocationId}:${index}`,
    }));
    if (state.pendingOwnership[state.currentTurnId]) {
      const held = accepted.map((event) => ({
        ...event,
        visibleTurnId: `codex-turn:${state.currentTurnId}`,
      }));
      (state.pendingRequests[state.currentTurnId] ??= []).push(...held);
      return replacement;
    }
    return [...replacement, ...accepted];
  }
  if (kind === 'turn_context') {
    const turnId = str(payload.turn_id);
    const model = str(payload.model);
    if (!turnId) {
      return [];
    }
    const effort = str(payload.effort) ?? state.reasoningEffort;
    state.turnModels[turnId] = model;
    state.turnEfforts[turnId] = effort;
    if (!model) {
      return [];
    }
    const held = state.pendingRequests[turnId] ?? [];
    const pending = held.filter((event) => !event.compactionUsage);
    const compactions = held.filter((event) => event.compactionUsage);
    if (state.pendingOwnership[turnId]) {
      for (const event of pending) {
        if (event.agent !== 'codex') continue;
        event.model = model;
        event.effort = effort;
        event.contextBand = contextBandForRequest(model, state.provider, requestInputTokens(event.usage));
      }
      return [];
    }
    delete state.pendingRequests[turnId];
    if (compactions.length) state.pendingRequests[turnId] = compactions;
    for (const event of pending) {
      discardPendingRequestKey(state, event.requestKey);
    }
    return pending.map((event) => ({
      ...event,
      model,
      effort,
      inferenceClass: state.provider === 'amazon-bedrock' ? bedrockInferenceClass(model) : null,
      contextBand: contextBandForRequest(model, state.provider, requestInputTokens(event.usage)),
    }));
  }
  if (kind !== 'token_count' || !state.currentTurnId) {
    return [];
  }
  const rateLimits = (payload.rate_limits || {}) as Record<string, unknown>;
  if (Object.keys(rateLimits).length) {
    state.planKnown = true;
    state.planType = str(rateLimits.plan_type);
  }
  const info = (payload.info || {}) as {
    last_token_usage?: unknown;
    total_token_usage?: unknown;
    model_context_window?: unknown;
  };
  const window = num(info.model_context_window);
  if (window !== null) {
    state.turnWindows[state.currentTurnId] = window;
  }
  if (codexRetainedContextTokens(info.last_token_usage) !== null) return [];
  const lastCounters = codexUsageCounters(info.last_token_usage);
  const totalCounters = codexUsageCounters(info.total_token_usage);
  const previous = state.lastUsageSnapshot;
  const repeatedSnapshot =
    lastCounters !== null &&
    totalCounters !== null &&
    previous?.turnId === state.currentTurnId &&
    sameCounters(previous.last, lastCounters) &&
    sameCounters(previous.total, totalCounters);
  if (lastCounters !== null && totalCounters !== null) {
    state.lastUsageSnapshot = { turnId: state.currentTurnId, last: lastCounters, total: totalCounters };
  } else {
    state.lastUsageSnapshot = null;
  }
  if (repeatedSnapshot) {
    return [];
  }
  const parsedUsage = codexRequestUsage(info.last_token_usage);
  const usage = parsedUsage ?? { ...emptyUsage(), requests: 1 };
  const explicitResponseId = str(payload.response_id);
  const association = [...state.recentResponseUsage]
    .reverse()
    .find((item) => !item.matched && item.turnId === state.currentTurnId && sameCodexRequestUsage(item.usage, usage));
  const responseId = explicitResponseId ?? association?.responseId;
  let identified = explicitResponseId
    ? state.recentResponseUsage.find((item) => item.responseId === explicitResponseId)
    : association;
  if (explicitResponseId && !identified) {
    identified = { responseId: explicitResponseId, turnId: state.currentTurnId, usage };
    state.recentResponseUsage.push(identified);
    state.recentResponseUsage.splice(0, Math.max(0, state.recentResponseUsage.length - CODEX_USAGE_ASSOCIATION_LIMIT));
  } else if (
    explicitResponseId &&
    identified?.matched &&
    !identified.suppressedSnapshot &&
    !state.compactionResponseIds.includes(explicitResponseId)
  ) {
    return [];
  }
  const corrections: UsageEvent[] = [];
  const provisional =
    identified && !state.compactionResponseIds.includes(identified.responseId)
      ? identified.suppressedSnapshot
      : undefined;
  if (provisional) {
    const pending = releasePendingRequest(state, provisional.requestKey);
    const emitted = state.recentRequestEvents.find((item) => item.requestKey === provisional.requestKey);
    if (!pending && emitted) corrections.push(removeCodexRequest(emitted));
    delete identified!.suppressedSnapshot;
  }
  if (identified) {
    identified.matched = true;
    if (explicitResponseId) identified.explicitSnapshot = true;
  }
  state.requestNumber++;
  const turnId = state.currentTurnId;
  const model = state.turnModels[turnId] ?? null;
  const providerMetered = state.provider !== null && state.provider !== 'openai';
  const event: UsageEvent = {
    timestamp: record.timestamp,
    agent: 'codex',
    provider: state.provider,
    model,
    contextWindow: state.turnWindows[turnId] ?? null,
    contextBand: contextBandForRequest(model, state.provider, requestInputTokens(usage)),
    billingClass: providerMetered
      ? 'metered'
      : state.planType
        ? 'subscription'
        : state.planKnown
          ? 'metered'
          : 'unknown',
    inferenceClass: state.provider === 'amazon-bedrock' ? bedrockInferenceClass(model) : null,
    serviceTier: state.serviceTier,
    effort: state.turnEfforts[turnId] ?? state.reasoningEffort,
    toolListVersion: null,
    reportedCost: null,
    // A Codex turn opens on `task_started`, which is the visible prompt boundary itself.
    // The rollout records no cache lifetime, so the model's documented row answers instead.
    visibleTurnId: `codex-turn:${turnId}`,
    cacheLifetime: null,
    compactionsBefore: state.compactionCount,
    ...(parsedUsage ? {} : { incomplete: true }),
    ...(!explicitResponseId &&
    (provisional ||
      state.recentResponseUsage.some(
        (item) =>
          state.compactionResponseIds.includes(item.responseId) &&
          item.suppressedSnapshot &&
          sameCodexRequestUsage(item.usage, usage),
      ))
      ? { requestCountExact: false as const }
      : {}),
    usage,
    requestKey: provisional?.requestKey ?? `codex:${turnId}:${record.timestamp ?? ''}:${state.requestNumber}`,
    ...(responseId ? { responseId } : {}),
  };
  if (responseId && state.compactionResponseIds.includes(responseId)) {
    if (association && !explicitResponseId) association.suppressedSnapshot = event;
    return [];
  }
  if (!model || state.pendingOwnership[turnId]) {
    (state.pendingRequests[turnId] ??= []).push(event);
    if (record.sourceStart !== undefined) {
      state.pendingRequestSources[event.requestKey] = {
        start: record.sourceStart,
        end: record.sourceEnd ?? record.sourceStart,
      };
    }
    return corrections;
  }
  return [...corrections, event];
}

// Returns the first released usage event. Incremental scanners must use the plural reducer to retain every released request.
export function reduceCodexUsageRecord(state: CodexUsageReducerState, record: CodexUsageRecord): UsageEvent | null {
  return reduceCodexUsageEvents(state, record)[0] ?? null;
}

// Read a rollout record's kind, timestamp, and payload.
// Metadata, context, compaction, and usage records name their kind at the top level.
// Wrapped events and response items name it in the payload.
export function parseRecord(line: string): Entry | null {
  let o: { type?: string; timestamp?: unknown; payload?: unknown };
  try {
    o = JSON.parse(line) as { type?: string; timestamp?: unknown; payload?: unknown };
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const payload = o.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const wrapper = o.type || '';
  const kind = wrapper === 'event_msg' || wrapper === 'response_item' ? String(payload.type || '') : wrapper;
  return { kind, wrapper, at: stamp(o.timestamp), payload };
}

export function reduceCodexUsageLine(state: CodexUsageReducerState, line: string): UsageEvent | null {
  return reduceCodexUsageLineEvents(state, line)[0] ?? null;
}

export function reduceCodexUsageLineEvents(state: CodexUsageReducerState, line: string): readonly UsageEvent[] {
  // Rollouts are mostly prompts, replies, and tool output. Only these record kinds move
  // request identity or usage, so reject every other line before JSON.parse sees it.
  if (
    !carriesRecord(line) &&
    !/"type"\s*:\s*"(?:session_meta|rate_limits|thread_settings_applied|turn_context|token_count|token_usage_record)"/.test(
      line,
    )
  ) {
    return [];
  }
  const record = parseRecord(line);
  return record
    ? reduceCodexUsageEvents(state, {
        kind: record.kind,
        timestamp: record.at,
        payload: record.payload,
      })
    : [];
}

export interface CodexUsageLineReducer {
  nativeChildRequests(): boolean;
  parserKind: 'codex';
  pushLine(line: string): readonly UsageEvent[];
  snapshot(): CodexUsageReducerState;
  pendingRequestKeys(): readonly string[];
  currentToolTurnId(): string | null;
  currentTurnIdentity(): { id: string | null; copied: boolean };
  turnCount(): number;
  compactionCount(): number;
  recentCompactions(): readonly ReducerCompaction[];
  // Compactions recorded since the last call, oldest first. Recorded compaction usage stays
  // outside request adjacency, so the cache-expiry scan reads its boundaries here.
  takeCompactionSignals(): CompactionSignal[];
  firstTurnAt(): number | null;
  lastTurnAt(): number | null;
  newestTurnStartedAt(): number | null;
  newestTurnOutcome(): TurnOutcome | null;
}

// Count an uncopied current turn while it remains open or has recorded work.
// Use the same condition for the first-turn boundary and turn count.
function currentCodexTurnCounts(state: CodexUsageReducerState): boolean {
  return (
    Boolean(state.currentTurnId) &&
    !state.currentTurnCopied &&
    (state.currentTurnDidSomething || !state.currentTurnCompleted)
  );
}

export function createCodexUsageLineReducer(restored?: CodexUsageReducerState): CodexUsageLineReducer {
  const state: CodexUsageReducerState = restored
    ? {
        ...(JSON.parse(JSON.stringify(restored)) as CodexUsageReducerState),
        // Missing pending maps restore as empty collections.
        pendingRequests: JSON.parse(JSON.stringify(restored.pendingRequests ?? {})) as Record<string, UsageEvent[]>,
        pendingRequestKeys: [...(restored.pendingRequestKeys ?? [])],
        pendingRequestSources: JSON.parse(
          JSON.stringify(restored.pendingRequestSources ?? {}),
        ) as CodexUsageReducerState['pendingRequestSources'],
        recentClaudeInvocationIds: [...(restored.recentClaudeInvocationIds ?? [])],
        seenClaudeInvocations: JSON.parse(JSON.stringify(restored.seenClaudeInvocations ?? {})) as Record<string, true>,
        recentClaudeCommandIds: [...(restored.recentClaudeCommandIds ?? [])],
        seenClaudeCommands: JSON.parse(JSON.stringify(restored.seenClaudeCommands ?? {})) as Record<string, true>,
        pendingClaudeResultIds: [...(restored.pendingClaudeResultIds ?? [])],
        pendingClaudeResults: JSON.parse(JSON.stringify(restored.pendingClaudeResults ?? {})) as Record<
          string,
          UsageEvent
        >,
        openingTimestamp: restored.openingTimestamp ?? null,
        openingSessionId: restored.openingSessionId ?? null,
        nativeSpawnedAt: restored.nativeSpawnedAt ?? null,
        pendingOwnership: { ...(restored.pendingOwnership ?? {}) },
        agentPath: restored.agentPath ?? null,
        foreignSessionMeta: restored.foreignSessionMeta,
        currentTurnCopied: restored.currentTurnCopied,
        lastUsageSnapshot: restored.lastUsageSnapshot ?? null,
        recentTurnIds: [...(restored.recentTurnIds ?? [])],
        seenTurnIds: JSON.parse(JSON.stringify(restored.seenTurnIds ?? {})) as Record<string, true>,
        seenTurnOffsets: JSON.parse(JSON.stringify(restored.seenTurnOffsets ?? {})) as Record<string, number>,
        legacyReplayLinks: JSON.parse(
          JSON.stringify(restored.legacyReplayLinks ?? []),
        ) as CodexUsageReducerState['legacyReplayLinks'],
        replayResetRequired: restored.replayResetRequired,
        copiedTurnIds: JSON.parse(JSON.stringify(restored.copiedTurnIds ?? {})) as Record<string, true>,
        datedCopiedTurnIds: JSON.parse(JSON.stringify(restored.datedCopiedTurnIds ?? {})) as Record<string, true>,
        countedTurnIds: JSON.parse(JSON.stringify(restored.countedTurnIds ?? {})) as Record<string, true>,
        turnEfforts: JSON.parse(JSON.stringify(restored.turnEfforts ?? {})) as Record<string, string | null>,
        closedTurns: restored.closedTurns ?? 0,
        currentTurnDidSomething: restored.currentTurnDidSomething,
        currentTurnCompleted: restored.currentTurnCompleted,
        compactionCount: restored.compactionCount ?? 0,
        recentCompactions: (restored.recentCompactions ?? []).map((item) => ({ ...item })),
        compactionTurnOrdinals: JSON.parse(JSON.stringify(restored.compactionTurnOrdinals ?? {})) as Record<
          string,
          number[]
        >,
        pendingCompactionBilling: restored.pendingCompactionBilling ?? null,
        recentResponseUsage: restored.recentResponseUsage ?? [],
        recentRequestEvents: restored.recentRequestEvents ?? [],
        compactionResponseIds: restored.compactionResponseIds ?? [],
        firstTurnAt: restored.firstTurnAt ?? null,
        lastTurnAt: restored.lastTurnAt ?? null,
        currentTurnStartedAt: restored.currentTurnStartedAt ?? null,
        currentTurnEndedAt: restored.currentTurnEndedAt ?? null,
        lastTurnStartedAt: restored.lastTurnStartedAt ?? null,
      }
    : emptyCodexUsageReducerState();
  state.currentTurnOutcome ??= null;
  state.lastTurnOutcome ??= null;
  const signals: CompactionSignal[] = [];
  return {
    parserKind: 'codex',
    nativeChildRequests: () => state.nativeCacheChild === true,
    pushLine: (line) => {
      const compactionsBefore = state.compactionCount;
      const events = reduceCodexUsageLineEvents(state, line);
      // Compaction facts are the reducer's own, so a signal reads the retained entry it added.
      // The prefix a Codex compaction leaves is not recorded.
      if (state.compactionCount > compactionsBefore) {
        for (const item of state.recentCompactions) {
          if (item.ordinal > compactionsBefore) {
            signals.push({ ordinal: item.ordinal, at: item.at, prefixTokens: null });
          }
        }
        signals.splice(0, Math.max(0, signals.length - RETAINED_COMPACTIONS));
      }
      for (const event of events) delete state.pendingRequestSources[event.requestKey];
      synchronizeCodexSpendAssociations(state);
      return [...events, ...compactCodexSpendAssociations(state)];
    },
    snapshot: () => JSON.parse(JSON.stringify(state)) as CodexUsageReducerState,
    pendingRequestKeys: () => state.pendingRequestKeys,
    currentToolTurnId: () =>
      state.currentTurnId && !state.currentTurnCopied && !state.currentTurnCompleted ? state.currentTurnId : null,
    currentTurnIdentity: () => ({ id: state.currentTurnId, copied: state.currentTurnCopied }),
    turnCount: () => state.closedTurns + (currentCodexTurnCounts(state) ? 1 : 0),
    compactionCount: () => state.compactionCount,
    recentCompactions: () => state.recentCompactions.map((item) => ({ ...item })),
    takeCompactionSignals: () => signals.splice(0),
    firstTurnAt: () =>
      state.firstTurnAt !== null
        ? state.firstTurnAt
        : currentCodexTurnCounts(state)
          ? state.currentTurnStartedAt
          : null,
    lastTurnAt: () =>
      currentCodexTurnCounts(state)
        ? state.currentTurnCompleted && state.currentTurnEndedAt !== null
          ? state.currentTurnEndedAt
          : state.currentTurnStartedAt
        : state.lastTurnAt,
    newestTurnStartedAt: () => (currentCodexTurnCounts(state) ? state.currentTurnStartedAt : state.lastTurnStartedAt),
    newestTurnOutcome: () => {
      const outcome = currentCodexTurnCounts(state) ? state.currentTurnOutcome : state.lastTurnOutcome;
      return outcome ? { ...outcome } : null;
    },
  };
}

// Developer instructions that publish skill names and paths. Match completed file reads against this catalog.
const CODEX_SKILL_CATALOG = '<skills_instructions>';

// One skill the catalog published.
interface CodexSkill {
  name: string;
  description: string;
  // The description before it is cut to the row's length, for a hover that shows it whole.
  fullDescription: string;
  path: string;
  // The normalized path for matching commands. Windows paths match across slash styles and drive-letter case.
  compare: string;
}

// A root of the short paths below, written as `` - `r0` = `C:/Users/dev/.agents/skills` ``.
const CODEX_SKILL_ROOT = /^-\s+`([^`]+)`\s*=\s*`([^`]+)`$/;

// A skill entry has the form `- name: description (file: r0/name/SKILL.md)`.
// Split at the first colon followed by whitespace so plugin names retain their own colon.
const CODEX_SKILL_ENTRY = /^-\s+(\S+?):\s+(.*?)\s+\(file:\s*([^)]+)\)$/;

// Resolve a catalog path through its published root, or retain an absolute path.
// Unknown short-path roots resolve to no path.
function codexSkillPath(written: string, roots: Map<string, string>): string {
  const cut = written.indexOf('/');
  const root = cut > 0 ? roots.get(written.slice(0, cut)) : undefined;
  if (root) {
    return `${root.replace(/[\\/]+$/, '')}/${written.slice(cut + 1)}`;
  }
  return /^[A-Za-z]:[\\/]/.test(written) || written.startsWith('/') ? written : '';
}

function codexSkillCatalog(text: string): Map<string, CodexSkill> {
  const roots = new Map<string, string>();
  const skills = new Map<string, CodexSkill>();
  for (const written of text.split('\n')) {
    const line = written.trim();
    const root = CODEX_SKILL_ROOT.exec(line);
    if (root) {
      roots.set(root[1], root[2]);
      continue;
    }
    const entry = CODEX_SKILL_ENTRY.exec(line);
    if (!entry) {
      continue;
    }
    const path = codexSkillPath(entry[3], roots);
    if (!path) {
      continue;
    }
    const published = entry[2].trim() || 'no detail given';
    skills.set(entry[1], {
      name: entry[1],
      // Keep a shortened first line for the row and the full description for its tooltip.
      description: shortenTo(firstLine(published), STEP_DETAIL_LIMIT, STEP_CUT),
      fullDescription: published,
      path,
      compare: normalizeFsPath(path),
    });
  }
  return skills;
}

// Recognized file-printing commands for skill reads. Searches, hashes, and existence checks do not establish a read.
// Unrecognized readers remain unclassified.
const CODEX_FILE_READERS = new Set(['get-content', 'gc', 'cat', 'type', 'head', 'tail', 'sed', 'bat', 'more', 'less']);

// Split commands at newlines, semicolons, pipes, and ampersands. Evaluate each statement independently.
// Commas and redirects remain within a statement. Shell continuations are not joined.
// Substitutions and variable assignments do not establish reads through this fallback.
const CODEX_COMMAND_SEPARATORS = /[\n;|&]/;

// Match a skill path within a statement whose leading program is a recognized file reader.
// This fallback supplements paths supplied by the client's command parser.
function commandReadsFile(command: string, compare: string): boolean {
  // Windows paths compare in lower case even when this reader runs on another platform.
  // Normalize the statement's case separately because it begins with a program, not a drive letter.
  const windows = /^[a-z]:\//.test(compare);
  for (const statement of command.split(CODEX_COMMAND_SEPARATORS)) {
    const written = statement.trim();
    const searched = normalizeFsPath(written);
    if (!(windows ? searched.toLowerCase() : searched).includes(compare)) {
      continue;
    }
    // Read the leading program as one word or quoted path. Quoted paths retain spaces in Windows directories.
    const opening = written.replace(/^\(+/, '');
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(opening);
    const first = (quoted?.[1] ?? quoted?.[2] ?? opening.split(/\s+/)[0]).toLowerCase();
    // The program alone: without the directory it was called through, and without the suffix
    // Windows runs it by. Git Bash and the MSYS toolchains write `cat.exe` where a POSIX shell
    // writes `cat`, and the two are one program.
    const program = (first.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|com)$/, '');
    if (CODEX_FILE_READERS.has(program)) {
      return true;
    }
  }
  return false;
}

// Attribute catalogued skill reads to successful completed commands.
// Match parser-reported read paths or recognized reader statements, never paths printed in command output.
function recordCodexSkillUses(
  state: CodexSessionParserState,
  turn: Building,
  command: CompletedCommand,
  at: number,
): void {
  if (command.status !== 'done' || state.skillCatalog.size === 0) {
    return;
  }
  for (const skill of state.skillCatalog.values()) {
    const read = command.readPaths.includes(skill.compare) || commandReadsFile(command.fullDetail, skill.compare);
    if (!read) {
      continue;
    }
    addTurnSkillUse(turn, {
      // Several skill reads from one command share its source identity and timestamp.
      sourceId: command.sourceId ?? `${turn.promptId}:command:${at}`,
      name: skill.name,
      description: skill.description,
      fullDescription: skill.fullDescription,
      path: skill.path,
      at,
      evidence: 'best-effort',
    });
  }
}

// Client-injected context wrappers. These distinguish context from typed prompts when `content_item_kinds` is absent.
const INJECTED_USER_CONTEXT = [
  '<recommended_plugins>',
  '# AGENTS.md instructions for ',
  '<environment_context>',
  '<permissions instructions>',
  '<apps_instructions>',
  '<plugins_instructions>',
  CODEX_SKILL_CATALOG,
  'The following is the Codex agent history ',
];

function isInjectedUserContext(text: string): boolean {
  const trimmed = text.trimStart();
  return INJECTED_USER_CONTEXT.some((prefix) => trimmed.startsWith(prefix));
}

// Read typed prompts from legacy user-message events or user-role response items.
// Role, input block, and `user.text` metadata distinguish prompts from instructions, tool output, and injected context.
function userMessage(record: Entry): string | null {
  if (record.kind === 'user_message') {
    const text = str(record.payload.message);
    return text ? (answeredQuestions(text) ?? text) : text;
  }
  if (record.kind !== 'message' || str(record.payload.role) !== 'user') {
    return null;
  }
  const content = record.payload.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const metadata = record.payload.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
  const kinds = metadata?.content_item_kinds;
  if (Array.isArray(kinds) && !kinds.includes('user.text')) {
    return null;
  }
  if (Array.isArray(kinds) && kinds.length !== content.length) {
    return null;
  }
  const text = content
    .flatMap((block, index) => {
      const item = block as { type?: unknown; text?: unknown } | null;
      const written = !Array.isArray(kinds) || kinds[index] === 'user.text';
      if (!written || item?.type !== 'input_text' || typeof item.text !== 'string') {
        return [];
      }
      return !Array.isArray(kinds) && isInjectedUserContext(item.text) ? [] : [item.text];
    })
    .join('\n');
  return text ? (answeredQuestions(text) ?? text) : null;
}

// A user message that is only a reply envelope answers questions the model asked with
// `request_user_input_async`. The reader sees each question and its answer, never the
// envelope. A message with any other text keeps its own text, as `parseQuestionReply` holds.
function answeredQuestions(text: string): string | null {
  const replies = parseQuestionReply(text);
  return replies ? replies.map(answeredQuestion).join('\n\n') : null;
}

function answeredQuestion({ question, answer }: QuestionReply): string {
  return [question, answer].filter((line) => line.trim()).join('\n');
}

// A parent-to-child assignment has an agent message envelope rather than a reader prompt.
// The task path ties it to this child. Opaque content means part of the assignment remains
// unavailable even when the readable block holds some instructions.
function codexDelegation(record: Entry, agentPath: string | null): TurnDelegation | null {
  if (!agentPath || record.kind !== 'agent_message') {
    return null;
  }
  const text = blocksText(record.payload.content).trim();
  const matched = text.match(
    /^Message Type:[ \t]*NEW_TASK\r?\nTask name:[ \t]*(\S+)[ \t]*\r?\nSender:[ \t]*(\S+)[ \t]*\r?\nPayload:[ \t]*(?:\r?\n)?([\s\S]*)$/,
  );
  if (!matched || str(record.payload.recipient) !== agentPath || !matched[1] || !matched[2]) {
    return null;
  }
  const payload = matched[3].trim();
  const opaque =
    Array.isArray(record.payload.content) &&
    record.payload.content.some((block) => isRecord(block) && str(block.type) === 'encrypted_content');
  return payload ? { text: payload, complete: !opaque } : { text: matched[1], complete: false };
}

function finishedCodexTurn(record: Entry): boolean {
  return record.kind === 'task_complete';
}

function failedCodexTurn(record: Entry): boolean {
  return (
    record.kind === 'task_complete' &&
    typeof (record.payload.error as { message?: unknown } | undefined)?.message === 'string' &&
    ((record.payload.error as { message?: string }).message ?? '').trim().length > 0
  );
}

function interruptedCodexTurn(record: Entry): boolean {
  return record.kind === 'turn_aborted' && str(record.payload.reason) === 'interrupted';
}

function answerInTaskComplete(record: Entry): string {
  return record.kind === 'task_complete' ? (str(record.payload.last_agent_message) ?? '') : '';
}

// Remove whitespace before comparing message serializations with different newlines or content-block separators.
function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

function finalChildMessage(record: Entry): boolean {
  return (
    record.kind === 'agent_message' &&
    !!str(record.payload.author) &&
    outputText(record.payload.content).indexOf(FINAL_ANSWER) >= 0
  );
}

type ChildTerminalStatus = 'completed' | 'failed' | 'interrupted';

function subagentNotification(record: Entry): { id: string; status: ChildTerminalStatus } | null {
  if (record.kind !== 'message' || str(record.payload.role) !== 'user') {
    return null;
  }
  const content = record.payload.content;
  const metadata = record.payload.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
  const kinds = metadata?.content_item_kinds;
  if (
    !Array.isArray(content) ||
    !Array.isArray(kinds) ||
    content.length !== 1 ||
    kinds.length !== 1 ||
    kinds[0] !== 'multi_agent.subagent_notification'
  ) {
    return null;
  }
  for (let index = 0; index < content.length; index++) {
    const item = content[index] as { type?: unknown; text?: unknown } | null;
    if (item?.type !== 'input_text' || typeof item.text !== 'string') {
      continue;
    }
    const wrapper = /^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/.exec(item.text.trim());
    if (!wrapper) {
      continue;
    }
    try {
      const note = JSON.parse(wrapper[1]) as { agent_path?: unknown; status?: unknown };
      if (typeof note.agent_path !== 'string') {
        continue;
      }
      if (note.status === 'shutdown') {
        return { id: note.agent_path, status: 'interrupted' };
      }
      if (typeof note.status !== 'object' || note.status === null) {
        continue;
      }
      if (typeof (note.status as { completed?: unknown }).completed === 'string') {
        return { id: note.agent_path, status: 'completed' };
      }
      if (typeof (note.status as { errored?: unknown }).errored === 'string') {
        return { id: note.agent_path, status: 'failed' };
      }
    } catch {
      /* not a protocol notification */
    }
  }
  return null;
}

function codexOutcomeIn(lines: string[], agentPath: string | null): TurnOutcome | null {
  let current: (TurnOutcome & { worthDrawing: boolean }) | null = null;
  let latestDrawable: TurnOutcome | null = null;
  const pendingExec = new Set<string>();
  const keepCurrent = () => {
    if (!current?.worthDrawing) {
      return;
    }
    const { worthDrawing: _worthDrawing, ...outcome } = current;
    latestDrawable = outcome;
  };
  for (const line of lines) {
    if (line.length < 20 || !carriesRecord(line)) {
      continue;
    }
    const record = parseRecord(line);
    if (!record) {
      continue;
    }
    if (record.kind === 'task_started') {
      keepCurrent();
      pendingExec.clear();
      current = {
        finished: false,
        error: false,
        interrupted: false,
        endedAt: record.at,
        startedAt: record.at,
        worthDrawing: false,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (parsedUpdate(record.payload)) {
      current.worthDrawing = true;
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (record.kind === 'user_message' || record.kind === 'message') {
      if (codexPrompt(userMessage(record) ?? '')) {
        current.worthDrawing = true;
      }
      continue;
    }
    if (codexDelegation(record, agentPath)) {
      current.worthDrawing = true;
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (record.kind === 'custom_tool_call' || record.kind === 'function_call' || record.kind === 'web_search_call') {
      current.worthDrawing = true;
      current.endedAt = Math.max(current.endedAt, record.at);
      if (
        (record.kind === 'custom_tool_call' || record.kind === 'function_call') &&
        str(record.payload.name) === 'exec' &&
        str(record.payload.call_id)
      ) {
        pendingExec.add(str(record.payload.call_id) as string);
      }
      continue;
    }
    if (record.kind === 'patch_apply_end') {
      if (record.payload.success !== false && hasVisibleCodexChanges(record.payload.changes)) {
        current.worthDrawing = true;
      }
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (record.kind === 'custom_tool_call_output' || record.kind === 'function_call_output') {
      current.endedAt = Math.max(current.endedAt, record.at);
      pendingExec.delete(str(record.payload.call_id) ?? '');
      continue;
    }
    if (record.kind === 'item_completed') {
      if ((completedFileChange(record.payload) || completedCommand(record.payload)) && pendingExec.size === 1) {
        current.endedAt = Math.max(current.endedAt, record.at);
      }
      continue;
    }
    if (record.kind === 'sub_agent_activity') {
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (finalChildMessage(record)) {
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (failedCodexTurn(record)) {
      current.error = true;
      current.worthDrawing = true;
    }
    if (answerInTaskComplete(record)) {
      current.worthDrawing = true;
    }
    if (finishedCodexTurn(record)) {
      current.finished = true;
    }
    if (interruptedCodexTurn(record)) {
      current.interrupted = true;
      current.worthDrawing = true;
    }
    if (record.kind === 'task_complete' || record.kind === 'turn_aborted' || record.kind === 'token_count') {
      current.endedAt = Math.max(current.endedAt, record.at);
    }
    if (record.kind === 'task_complete' || record.kind === 'turn_aborted') {
      keepCurrent();
      current = null;
      pendingExec.clear();
    }
  }
  keepCurrent();
  return latestDrawable;
}

// Admit legacy user messages or response messages carrying all three user-input markers.
// Generic message markers alone also occur in large assistant and tool-output records.
function carriesUserMessage(line: string): boolean {
  return (
    line.indexOf('user_message') >= 0 ||
    (line.indexOf('"type":"message"') >= 0 && line.indexOf('"role":"user"') >= 0 && line.indexOf('"input_text"') >= 0)
  );
}

interface CompletedCommand {
  command: string;
  shell?: 'bash' | 'powershell';
  detail: string;
  fullDetail: string;
  sourceId: string | null;
  status: 'done' | 'failed';
  cwd: string | null;
  stdout: string;
  startedAt: number | null;
  completedAt: number | null;
  failed: boolean;
  // Normalized file paths classified as reads by the client's command parser.
  readPaths: readonly string[];
}

export function codexCommitRepositoryPairs(stdout: string): Array<{ sha: string; dir: string }> | null {
  if (Buffer.byteLength(stdout, 'utf8') > 64 * 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(value) || 'payload' in value || 'type' in value || 'stdout' in value) return null;
  const entries = isRecord(value.candidates) ? Object.values(value.candidates) : [value];
  if (entries.length === 0 || entries.length > 33) return null;
  const pairs: Array<{ sha: string; dir: string }> = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(entry.sha)) {
      return null;
    }
    const dir = localCommandCwd(entry.repository);
    if (!dir) return null;
    pairs.push({ sha: entry.sha.toLowerCase(), dir });
  }
  return pairs;
}

function recordCodexCommitRepositories(turn: Pick<Turn, 'commits' | 'promptId'>, stdout: string, at: number): void {
  const pairs = codexCommitRepositoryPairs(stdout);
  if (!pairs) return;
  for (const commit of turn.commits) {
    if (
      (commit.dir !== null && !commit.repositoryEvidence) ||
      (commit.candidates?.complete && !commit.repositoryEvidence)
    )
      continue;
    if (
      commit.repositoryEvidence &&
      pairs.some((pair) => sameCommitSha(pair.sha, commit.sha) && pair.sha !== commit.printedSha)
    ) {
      commit.repositoryEvidence.complete = false;
      commit.candidates = { dirs: commit.repositoryEvidence.dirs, complete: false };
      commit.dir = null;
      commit.place = null;
      commit.repository = null;
      continue;
    }
    const matching = pairs.filter((pair) => sameCommitSha(pair.sha, commit.printedSha ?? commit.sha));
    if (new Set(matching.map((pair) => pair.sha)).size !== 1) continue;
    const dirs = [...new Set(matching.map((pair) => pair.dir))];
    const combined = [...new Set([...(commit.candidates?.dirs ?? []), ...dirs])];
    commit.printedSha = matching[0].sha;
    commit.repositoryEvidence = {
      dirs: combined.slice(0, 33),
      at,
      turnId: turn.promptId,
      complete: combined.length <= 33 && (commit.repositoryEvidence?.complete ?? true),
    };
    commit.candidates = { dirs: combined.slice(0, 33), complete: false };
    commit.dir = null;
    commit.place = null;
    commit.repository = null;
  }
}

export interface ClaudeCommandResult {
  accepted: boolean;
  commandId: string | null;
  invocationId: string;
  sessionId: string | null;
  durationMs: number | null;
  models: ModelSpend[];
  status: 'done' | 'failed';
}

const CLAUDE_RESULT_MODEL_LIMIT = 32;
const CLAUDE_MODEL = /^claude-[a-z0-9][a-z0-9.-]*$/i;

function commandText(item: Record<string, unknown>, commandArray = false): string {
  const parsed = item.parsed_cmd;
  if (Array.isArray(parsed) && parsed.length === 1) {
    const command = str((parsed[0] as { cmd?: unknown } | null)?.cmd);
    if (command) {
      return command;
    }
  }
  if (commandArray && Array.isArray(item.command) && item.command.every((word) => typeof word === 'string')) {
    const words = item.command;
    const shell = words.findIndex((word) => /^(?:-command|-c|-lc|\/c)$/i.test(word));
    return shell >= 0 ? (words[shell + 1] ?? '') : words.join(' ');
  }
  return str(item.command) ?? '';
}

// Only the recorded runtime invocation establishes the selected command's shell grammar.
function commandShell(item: Record<string, unknown>): 'bash' | 'powershell' | undefined {
  const argv = item.command;
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) return undefined;
  const executable = (argv[0] as string | undefined)?.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
  const shell = /^(?:powershell|pwsh)(?:\.exe)?$/.test(executable ?? '')
    ? 'powershell'
    : /^bash(?:\.exe)?$/.test(executable ?? '')
      ? 'bash'
      : undefined;
  if (!shell) return undefined;
  const at = argv.findIndex(
    (arg, index) => index > 0 && (shell === 'powershell' ? /^-(?:command|c)$/i : /^-[a-z]*c$/).test(arg),
  );
  if (at < 1 || at !== argv.length - 2 || argv[at + 1] !== commandText(item)) return undefined;
  return shell;
}

interface CodexDispatchCandidate {
  turnId: string;
  occurrence: number;
  reference: ClaudeDispatchSessionReference;
  classified: boolean;
}

export interface CodexDispatchCursor {
  exportPolicy?: ExportRelationshipLimits;
  lostRecords?: boolean;
  evidence?: RelationshipEvidence;
  target?: number;
  replayFragment?: string;
  replayThrough?: number;
  offset: number;
  size: number;
  mtimeMs: number;
  fragment: string;
  fragmentStart: number | null;
  skipLongLine: boolean;
  head: string;
  anchor: string;
  dev: number | string;
  ino: number | string;
  parentSessionId: string;
  terminalApplied: boolean;
  openingTimestamp: number | null;
  openingSessionId: string | null;
  foreignSessionMeta: boolean;
  nativeSpawnedAt: number | null;
  pendingOwnershipTurnIds: string[];
  currentTurnRepeated: boolean;
  currentTurnId: string | null;
  currentOccurrence: number;
  currentTurnClassified: boolean;
  currentTurnCopied: boolean;
  lastTurnId: string | null;
  lastOccurrence: number;
  seenTurnIds: string[];
  seenBloom: string | null;
  candidates: CodexDispatchCandidate[];
}

const CODEX_DISPATCH_BLOOM_BYTES = 64 * 1024;
const CODEX_DISPATCH_ID_WINDOW = 1024;
const exactDispatchIds = new WeakMap<CodexDispatchCursor, Set<string>>();

function bloomIndexes(id: string): number[] {
  const hash = createHash('sha256').update(id).digest();
  return [0, 4, 8, 12].map((at) => hash.readUInt32LE(at) % (CODEX_DISPATCH_BLOOM_BYTES * 8));
}

function dispatchSeen(cursor: CodexDispatchCursor, id: string): boolean {
  if (cursor.exportPolicy) {
    let seen = exactDispatchIds.get(cursor);
    if (!seen) exactDispatchIds.set(cursor, (seen = new Set(cursor.seenTurnIds)));
    if (seen.has(id)) return true;
    if (cursor.seenTurnIds.length >= cursor.exportPolicy.dispatchIdentities)
      throw new ExportLimitError('dispatch identities', cursor.exportPolicy.dispatchIdentities);
    cursor.seenTurnIds.push(id);
    seen.add(id);
    return false;
  }
  if (cursor.seenBloom === null) {
    if (cursor.seenTurnIds.includes(id)) return true;
    cursor.seenTurnIds.push(id);
    if (cursor.seenTurnIds.length <= CODEX_DISPATCH_ID_WINDOW) return false;
    const bloom = Buffer.alloc(CODEX_DISPATCH_BLOOM_BYTES);
    for (const prior of cursor.seenTurnIds) {
      for (const index of bloomIndexes(prior)) bloom[index >> 3] |= 1 << (index & 7);
    }
    cursor.seenTurnIds = [];
    cursor.seenBloom = bloom.toString('base64');
    return false;
  }
  const bloom = Buffer.from(cursor.seenBloom, 'base64');
  const indexes = bloomIndexes(id);
  const seen = indexes.every((index) => (bloom[index >> 3] & (1 << (index & 7))) !== 0);
  for (const index of indexes) bloom[index >> 3] |= 1 << (index & 7);
  cursor.seenBloom = bloom.toString('base64');
  return seen;
}

export function codexDispatchCursor(
  head: string,
  dev: number | string,
  ino: number | string,
  parentSessionId: string,
): CodexDispatchCursor {
  return {
    offset: 0,
    size: 0,
    mtimeMs: 0,
    fragment: '',
    fragmentStart: null,
    skipLongLine: false,
    head,
    anchor: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    dev,
    ino,
    parentSessionId,
    terminalApplied: false,
    openingTimestamp: null,
    openingSessionId: null,
    foreignSessionMeta: false,
    nativeSpawnedAt: null,
    pendingOwnershipTurnIds: [],
    currentTurnRepeated: false,
    currentTurnId: null,
    currentOccurrence: 0,
    currentTurnClassified: false,
    currentTurnCopied: false,
    lastTurnId: null,
    lastOccurrence: 0,
    seenTurnIds: [],
    seenBloom: null,
    candidates: [],
  };
}

export function codexDispatchRecord(
  cursor: CodexDispatchCursor,
  line: string,
  parentSessionId: string,
  retractedToolUseIds: Set<string>,
): void {
  if (
    !/(?:session_meta|task_started|task_complete|turn_aborted|turn_context|token_usage_record|CommandExecution)/.test(
      line,
    )
  )
    return;
  const record = parseRecord(line);
  if (!record) return;
  const { kind, at, payload } = record;
  if (kind === 'session_meta') {
    const id = str(payload.id) ?? str(payload.session_id);
    if (cursor.openingTimestamp === null) {
      cursor.openingTimestamp = codexReplayBoundaryAt(at, payload);
      cursor.openingSessionId = id;
      cursor.foreignSessionMeta = false;
      cursor.nativeSpawnedAt = nativeSpawnPayloadAt(at, payload);
    } else if (id && cursor.openingSessionId) {
      cursor.foreignSessionMeta = id !== cursor.openingSessionId;
    }
    return;
  }
  if (kind === 'task_started') {
    const id = str(payload.turn_id);
    const startedAt = recordedTurnStart(payload);
    const oldClock =
      startedAt !== null &&
      cursor.openingTimestamp !== null &&
      (startedAt < cursor.openingTimestamp - CODEX_REPLAY_CLOCK_SLACK_MS ||
        (cursor.nativeSpawnedAt !== null && startedAt === cursor.nativeSpawnedAt));
    if (startedAt !== null && !oldClock) cursor.foreignSessionMeta = false;
    cursor.currentTurnId = id;
    cursor.currentOccurrence++;
    cursor.currentTurnClassified = false;
    const repeated = !!id && dispatchSeen(cursor, id);
    cursor.currentTurnRepeated = repeated;
    cursor.currentTurnCopied = !!id && (repeated || oldClock);
    if (
      id &&
      !repeated &&
      oldClock &&
      !cursor.foreignSessionMeta &&
      startedAt !== null &&
      cursor.nativeSpawnedAt !== null &&
      startedAt >= cursor.nativeSpawnedAt - CODEX_TURN_START_ROUNDING_MS
    ) {
      cursor.pendingOwnershipTurnIds.push(id);
      if (cursor.pendingOwnershipTurnIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
        if (cursor.exportPolicy) throw new ExportLimitError('dispatch ownership', CODEX_USAGE_ASSOCIATION_LIMIT);
        cursor.pendingOwnershipTurnIds.shift();
      }
    }
    cursor.lastTurnId = id;
    cursor.lastOccurrence = cursor.currentOccurrence;
    return;
  }
  if (kind === 'token_usage_record') {
    const id = str(payload.turn_id);
    if (
      !id ||
      !cursor.pendingOwnershipTurnIds.includes(id) ||
      cursor.foreignSessionMeta ||
      str(payload.thread_id) !== cursor.openingSessionId ||
      !str(payload.response_id)
    )
      return;
    cursor.pendingOwnershipTurnIds = cursor.pendingOwnershipTurnIds.filter((turnId) => turnId !== id);
    for (const candidate of cursor.candidates) {
      if (candidate.turnId === id) candidate.classified = true;
    }
    if (cursor.currentTurnId === id && !cursor.currentTurnRepeated) {
      cursor.currentTurnCopied = false;
      cursor.currentTurnClassified = true;
    }
    return;
  }
  if (cursor.currentTurnRepeated && cursor.nativeSpawnedAt !== null) return;
  if (kind === 'turn_context') {
    const id = str(payload.turn_id);
    if (!id || id !== cursor.lastTurnId) return;
    if (recordedDatePredatesOpening(payload.current_date, cursor)) {
      cursor.pendingOwnershipTurnIds = cursor.pendingOwnershipTurnIds.filter((turnId) => turnId !== id);
      for (const candidate of cursor.candidates) {
        if (candidate.occurrence === cursor.lastOccurrence) {
          for (const toolUseId of candidate.reference.toolUseIds) retractedToolUseIds.add(toolUseId);
        }
      }
      cursor.candidates = cursor.candidates.filter((candidate) => candidate.occurrence !== cursor.lastOccurrence);
      if (cursor.currentTurnId === id) cursor.currentTurnCopied = true;
    } else if (!cursor.pendingOwnershipTurnIds.includes(id)) {
      if (cursor.currentTurnId === id) cursor.currentTurnClassified = true;
      for (const candidate of cursor.candidates) {
        if (candidate.occurrence === cursor.lastOccurrence) candidate.classified = true;
      }
    }
    return;
  }
  if (kind === 'task_complete' || kind === 'turn_aborted') {
    cursor.currentTurnId = null;
    cursor.currentTurnCopied = false;
    return;
  }
  if (
    kind !== 'item_completed' ||
    !cursor.currentTurnId ||
    (cursor.currentTurnCopied && !cursor.pendingOwnershipTurnIds.includes(cursor.currentTurnId))
  )
    return;
  const command = completedCommand(payload, true);
  if (!command) return;
  const id = command.sourceId;
  if (!id || cursor.candidates.some((candidate) => candidate.reference.toolUseIds.includes(id))) return;
  const launch = claudeLaunchKind(command.command, command.shell);
  if (!launch || launch.kind === 'native') return;
  const receipts = shellDispatchFromOutput(command.stdout, launch);
  for (const receipt of receipts) {
    if (cursor.candidates.length >= (cursor.exportPolicy?.relationships ?? 4096)) {
      if (cursor.exportPolicy) throw new ExportLimitError('relationships', cursor.exportPolicy.relationships);
      break;
    }
    cursor.candidates.push({
      turnId: cursor.currentTurnId,
      occurrence: cursor.currentOccurrence,
      classified: cursor.currentTurnClassified,
      reference: {
        kind: 'dispatch',
        agent: receipt.agent,
        parentSessionId,
        sessionId: receipt.sessionId,
        file: null,
        toolUseIds: [id],
        name: receipt.name,
        owned: receipt.owned,
      },
    });
  }
}

interface CodexDispatchScan {
  cursor: CodexDispatchCursor;
  references: ClaudeDispatchSessionReference[];
  retractedToolUseIds: Set<string>;
  complete: boolean;
  qualified: boolean;
  reset: boolean;
  readBytes: number;
  traversed: boolean;
  unresolvedTurnIds: string[];
}

// The synchronous caller drains the same steps that worker discovery yields between.
export function scanCodexDispatchReferences(
  file: string,
  parentSessionId: string,
  previous: CodexDispatchCursor | null = null,
  budget = Number.POSITIVE_INFINITY,
  cancelled: () => boolean = () => false,
  meter?: RelationshipReadMeter,
): CodexDispatchScan {
  const steps = codexDispatchSteps(file, parentSessionId, previous, budget, cancelled, meter);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export async function scanCodexDispatchReferencesAsync(
  file: string,
  parentSessionId: string,
  previous: CodexDispatchCursor | null = null,
  budget = RELATIONSHIP_QUANTUM_BYTES,
  cancelled: () => boolean = () => false,
  meter?: RelationshipReadMeter,
  exportPolicy?: ExportRelationshipLimits,
): Promise<CodexDispatchScan> {
  const steps = codexDispatchSteps(file, parentSessionId, previous, budget, cancelled, meter, exportPolicy);
  let step = steps.next();
  while (!step.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    step = steps.next();
  }
  return step.value;
}

function* codexDispatchSteps(
  file: string,
  parentSessionId: string,
  previous: CodexDispatchCursor | null,
  budget: number,
  cancelled: () => boolean,
  meter?: RelationshipReadMeter,
  exportPolicy?: ExportRelationshipLimits,
): Generator<void, CodexDispatchScan> {
  const fd = fs.openSync(file, 'r');
  try {
    let cursor =
      previous && JSON.stringify(previous.exportPolicy) === JSON.stringify(exportPolicy)
        ? exportPolicy
          ? previous
          : (meterReadWork('cursorCopies'), structuredClone(previous))
        : null;
    const reader = new RelationshipReader(fd, file, budget, cancelled, meter, !Number.isFinite(budget));
    const stat = reader.stamp;
    let qualification: 'match' | 'pending' | 'reset' =
      cursor?.evidence && cursor.parentSessionId === parentSessionId
        ? yield* reader.qualifySteps(cursor.evidence)
        : 'reset';
    if (qualification === 'match') {
      cursor!.size = cursor!.evidence!.provisional.size;
      cursor!.mtimeMs = cursor!.evidence!.provisional.mtimeMs;
    }
    if (qualification === 'match' && cursor!.terminalApplied && cursor!.offset < stat.size) {
      const continuation = reader.read(cursor!.offset, 1, 0, false);
      if (!continuation.length) qualification = 'pending';
      else if (continuation[0] !== 10 && continuation[0] !== 13) qualification = 'reset';
    }
    const reset = !!previous && qualification === 'reset';
    if (!cursor || qualification === 'reset') {
      cursor = codexDispatchCursor(
        createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
        stat.dev,
        stat.ino,
        parentSessionId,
      );
      cursor.evidence = relationshipEvidence(stat);
      if (exportPolicy) cursor.exportPolicy = { ...exportPolicy };
      cursor.target = stat.size;
      qualification = 'match';
    }
    if (qualification === 'match') {
      cursor.size = stat.size;
      cursor.mtimeMs = stat.mtimeMs;
      if (cursor.offset === cursor.target) cursor.target = stat.size;
    }
    const retractedToolUseIds = new Set<string>();
    if (!reset && qualification === 'match')
      while (cursor.offset < cursor.target! && reader.available() > 0) {
        if (cursor.fragmentStart !== null) {
          cursor.replayThrough ??= cursor.fragmentStart;
          cursor.replayFragment ??= '';
          while (cursor.replayThrough < cursor.offset && reader.available() > 0) {
            const bytes = reader.read(cursor.replayThrough, cursor.offset - cursor.replayThrough);
            if (!bytes.length) break;
            cursor.replayFragment = Buffer.concat([Buffer.from(cursor.replayFragment, 'base64'), bytes]).toString(
              'base64',
            );
            cursor.replayThrough += bytes.length;
            yield;
          }
          if (cursor.replayThrough !== cursor.offset || reader.available() <= 0) break;
          cursor.fragment = cursor.replayFragment;
          cursor.fragmentStart = null;
          delete cursor.replayFragment;
          delete cursor.replayThrough;
        }
        const bytes = reader.read(cursor.offset, cursor.target! - cursor.offset);
        if (!bytes.length) break;
        extendRelationshipEvidence(cursor.evidence!, bytes);
        cursor.offset += bytes.length;
        if (exportPolicy) {
          const newline = bytes.indexOf(10);
          const length = Buffer.byteLength(cursor.fragment, 'base64') + (newline < 0 ? bytes.length : newline);
          if (length > exportPolicy.recordBytes) throw new ExportLimitError('record', exportPolicy.recordBytes);
        }
        const joined = Buffer.concat([Buffer.from(cursor.fragment, 'base64'), bytes]);
        const recordBytes = exportPolicy?.recordBytes ?? 4 * 1024 * 1024;
        let start = 0;
        for (let index = 0; index < joined.length; index++) {
          if (joined[index] !== 10) continue;
          if (index - start > recordBytes) {
            if (exportPolicy) throw new ExportLimitError('record', recordBytes);
            cursor.lostRecords = true;
          }
          if (!cursor.skipLongLine && !cursor.terminalApplied && index - start <= recordBytes)
            codexDispatchRecord(cursor, joined.toString('utf8', start, index), parentSessionId, retractedToolUseIds);
          cursor.terminalApplied = false;
          cursor.skipLongLine = false;
          start = index + 1;
        }
        const remaining = joined.subarray(start);
        if (remaining.length > recordBytes) {
          if (exportPolicy) throw new ExportLimitError('record', recordBytes);
          cursor.lostRecords = true;
          cursor.fragment = '';
          cursor.skipLongLine = true;
        } else cursor.fragment = remaining.toString('base64');
        yield;
      }
    if (
      !reset &&
      qualification === 'match' &&
      reader.stable &&
      !cancelled() &&
      cursor.offset === cursor.target &&
      cursor.fragment &&
      !cursor.terminalApplied &&
      !cursor.skipLongLine
    ) {
      const terminal = Buffer.from(cursor.fragment, 'base64').toString('utf8');
      if (parseRecord(terminal)) {
        codexDispatchRecord(cursor, terminal, parentSessionId, retractedToolUseIds);
        cursor.terminalApplied = true;
      }
    }
    if (
      !exportPolicy &&
      cursor.fragment &&
      Buffer.byteLength(cursor.fragment, 'base64') > 4096 &&
      cursor.replayThrough === undefined
    ) {
      const bytes = Buffer.from(cursor.fragment, 'base64');
      if (!cursor.terminalApplied) cursor.fragmentStart = cursor.offset - bytes.length;
      cursor.fragment = '';
    }
    const qualified = qualification === 'match' && reader.check();
    if (!qualified && qualification === 'match') cursor.evidence!.accepted = null;
    const traversed =
      !reset &&
      qualified &&
      cursor.offset === cursor.target &&
      cursor.target === stat.size &&
      ((cursor.fragment === '' && cursor.fragmentStart === null) || cursor.terminalApplied) &&
      !cursor.skipLongLine &&
      !cancelled();
    const unresolvedTurnIds = [
      ...new Set(cursor.candidates.filter((candidate) => !candidate.classified).map((candidate) => candidate.turnId)),
    ];
    const complete = traversed && !cursor.lostRecords && (!exportPolicy || unresolvedTurnIds.length === 0);
    const references = cursor.candidates
      .filter((candidate) => candidate.classified)
      .map((candidate) => candidate.reference);
    if (!validRelationshipEvidence(cursor.evidence, cursor.offset))
      throw new Error('Relationship evidence exceeds its limits');
    return {
      cursor,
      references,
      retractedToolUseIds,
      complete,
      qualified,
      reset,
      readBytes: reader.readBytes,
      traversed,
      unresolvedTurnIds,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function claudePrintCommand(command: string): boolean {
  const segments: string[] = [];
  let segment = '';
  let quote: "'" | '"' | null = null;
  let hereEnd: "'@" | '"@' | null = null;
  let hereLineOnlyWhitespace = false;
  let comment = false;
  const finish = (): void => {
    if (segment.trim()) {
      segments.push(segment.trim());
    }
    segment = '';
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (comment) {
      if (char === '\n' || char === '\r') {
        comment = false;
        finish();
      }
      continue;
    }
    if (hereEnd) {
      const after = command[index + 2];
      if (
        hereLineOnlyWhitespace &&
        char === hereEnd[0] &&
        next === '@' &&
        (after === undefined || after === '\n' || after === '\r')
      ) {
        segment += hereEnd;
        index++;
        hereEnd = null;
      } else {
        segment += char;
        if (char === '\n' || char === '\r') {
          hereLineOnlyWhitespace = true;
        } else if (char !== ' ' && char !== '\t') {
          hereLineOnlyWhitespace = false;
        }
      }
      continue;
    }
    if (quote) {
      segment += char;
      if (char === quote) {
        if (next === quote) {
          segment += next;
          index++;
        } else {
          quote = null;
        }
      } else if (quote === '"' && (char === '\\' || char === '`') && next) {
        segment += next;
        index++;
      }
      continue;
    }
    if (char === '@' && (next === "'" || next === '"')) {
      hereEnd = next === "'" ? "'@" : '"@';
      hereLineOnlyWhitespace = false;
      segment += char + next;
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      segment += char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(command[index - 1]))) {
      comment = true;
      continue;
    }
    if (char === ';' || char === '&' || char === '|' || char === '\n' || char === '\r') {
      finish();
      continue;
    }
    segment += char;
  }
  finish();
  return segments.some((part) => /^claude(?:\.exe|\.cmd)?\s+-p(?:\s|$)/i.test(part));
}

function nonnegative(value: unknown): number | null {
  const parsed = num(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function tokenCount(value: unknown): number | null {
  const parsed = nonnegative(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

// A Claude print-mode result is useful only when the completed command supplies both the
// execution identity and the provider's complete result object. The command check keeps
// unrelated JSON output on its ordinary activity row.
export function claudeCommandResult(payload: Record<string, unknown>): ClaudeCommandResult | null {
  const item = isRecord(payload.item) ? payload.item : null;
  if (!item || str(item.type) !== 'CommandExecution') {
    return null;
  }
  const command = commandText(item);
  if (!claudePrintCommand(command)) {
    return null;
  }
  const commandId = str(item.id);
  const failed = str(item.status) !== 'completed' || nonnegative(item.exit_code) !== 0;
  const incomplete = (sessionId: string | null = null, durationMs: number | null = null): ClaudeCommandResult => ({
    accepted: false,
    commandId,
    invocationId: `claude-command:${commandId ?? 'unknown'}`,
    sessionId,
    durationMs,
    models: [],
    status: 'failed',
  });
  const stdout = typeof item.stdout === 'string' ? item.stdout.trim() : '';
  let result: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed)) {
      return incomplete();
    }
    result = parsed;
  } catch {
    return incomplete();
  }
  const sessionId = str(result.session_id);
  const durationMs = nonnegative(result.duration_ms);
  const totalCost = nonnegative(result.total_cost_usd);
  const rawModels = isRecord(result.modelUsage) ? Object.entries(result.modelUsage) : [];
  if (
    failed ||
    result.type !== 'result' ||
    result.is_error !== false ||
    !commandId ||
    !sessionId ||
    totalCost === null ||
    !isRecord(result.modelUsage) ||
    rawModels.length > CLAUDE_RESULT_MODEL_LIMIT
  ) {
    return incomplete(sessionId, durationMs);
  }

  const parsedModels: Array<ModelSpend & { cacheCreation: number }> = [];
  let recordedTotal = 0;
  for (const [key, value] of rawModels) {
    if (key.length > 200 || !isRecord(value)) {
      return incomplete(sessionId, durationMs);
    }
    const model = str(value.canonicalModel);
    const input = tokenCount(value.inputTokens);
    const output = tokenCount(value.outputTokens);
    const cacheRead = tokenCount(value.cacheReadInputTokens);
    const cacheCreation = tokenCount(value.cacheCreationInputTokens);
    const thinking = tokenCount(value.thinkingTokens);
    const recordedCost = nonnegative(value.costUSD);
    const contextWindow = tokenCount(value.contextWindow);
    const costBasis = str(value.costBasis);
    if (
      !model ||
      !CLAUDE_MODEL.test(model) ||
      input === null ||
      output === null ||
      cacheRead === null ||
      cacheCreation === null ||
      thinking === null ||
      recordedCost === null ||
      contextWindow === null ||
      contextWindow <= 0 ||
      costBasis !== 'list'
    ) {
      return incomplete(sessionId, durationMs);
    }
    recordedTotal += recordedCost;
    // Claude Code records list price. The result's model key names the Bedrock inference
    // profile, and Bedrock bills every profile except `global.` at 1.1 times list. A scaled cost
    // takes its own basis, so the text beside it can say what it holds.
    const multiplier = bedrockClaudeListMultiplier(key, model);
    parsedModels.push({
      model,
      contextWindow,
      recordedCost: recordedCost * multiplier,
      costBasis: multiplier === 1 ? costBasis : BEDROCK_LIST_COST_BASIS,
      usage: {
        requests: 1,
        input,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead,
        output,
        thinking,
      },
      cacheCreation,
    });
  }
  if (Math.abs(recordedTotal - totalCost) > Math.max(1e-9, totalCost * 1e-9)) {
    return incomplete(sessionId, durationMs);
  }

  const aggregate = isRecord(result.usage) ? result.usage : null;
  const creation = aggregate && isRecord(aggregate.cache_creation) ? aggregate.cache_creation : null;
  const aggregateCreation = aggregate ? tokenCount(aggregate.cache_creation_input_tokens) : null;
  const oneHour = creation ? tokenCount(creation.ephemeral_1h_input_tokens) : null;
  const fiveMinute = creation ? tokenCount(creation.ephemeral_5m_input_tokens) : null;
  const creating = parsedModels.filter((part) => part.cacheCreation > 0);
  const splitCanBeAssigned =
    creating.length === 1 &&
    aggregateCreation !== null &&
    oneHour !== null &&
    fiveMinute !== null &&
    aggregateCreation === oneHour + fiveMinute &&
    aggregateCreation === creating[0].cacheCreation;
  const models = parsedModels.map(({ cacheCreation, ...part }) => {
    if (splitCanBeAssigned && cacheCreation > 0) {
      part.usage.cacheWrite1h = oneHour ?? 0;
      part.usage.cacheWrite5m = fiveMinute ?? 0;
      return part;
    }
    return cacheCreation > 0 ? { ...part, unclassifiedCacheWrite: cacheCreation } : part;
  });
  return {
    accepted: true,
    commandId,
    invocationId: `${commandId}:${sessionId}`,
    sessionId,
    durationMs,
    models,
    status: 'done',
  };
}

interface CompletedFileChange {
  changes: Record<string, unknown>;
  detail: string;
  fullDetail: string;
  paths: string[];
  sourceId: string | null;
  status: 'done' | 'failed';
}

export function codexChangePaths(changes: unknown): string[] {
  if (!isRecord(changes)) {
    return [];
  }
  const paths: string[] = [];
  for (const [written, raw] of Object.entries(changes)) {
    paths.push(written);
    const moved = isRecord(raw) ? str(raw.move_path) : null;
    if (moved) {
      paths.push(moved);
    }
  }
  return [...new Set(paths)];
}

// The rollout can come from a different platform than the reader. Keep the directory's
// recorded spelling instead of using the host's path rules to convert it.
function localCommandCwd(value: unknown): string | null {
  const cwd = str(value);
  if (!cwd) {
    return null;
  }
  if (/^(?:[a-z]:[\\/]|\/|\\\\[^\\/]+[\\/][^\\/]+)/i.test(cwd)) {
    return cwd;
  }
  const file = /^file:(?:\/\/([^/?#]*))?(\/[^?#]*)$/i.exec(cwd);
  if (!file) {
    return null;
  }
  const encodedPath = file[2];
  if (!encodedPath) {
    return null;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (!pathname.startsWith('/')) {
    return null;
  }
  const host = (file[1] ?? '').toLowerCase();
  if (host && host !== 'localhost') {
    return `\\\\${host}${pathname.replaceAll('/', '\\')}`;
  }
  return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
}

// Read one completed command from a single parsed command or a direct command string.
// By default, an argv array without a single parsed command supplies no command text.
export function completedCommand(payload: Record<string, unknown>, commandArray = false): CompletedCommand | null {
  const item = payload.item as Record<string, unknown> | undefined;
  if (!item || str(item.type) !== 'CommandExecution') {
    return null;
  }
  const command = commandText(item, commandArray);
  const detail = stepDetail({ command });
  if (!detail) {
    return null;
  }
  const exit = num(item.exit_code);
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
  const status = str(item.status);
  return {
    command,
    shell: commandShell(item),
    detail,
    fullDetail: command,
    sourceId: str(item.id),
    status: status === 'failed' || (exit !== null && exit !== 0) ? 'failed' : 'done',
    cwd: localCommandCwd(item.cwd),
    stdout:
      typeof item.stdout === 'string'
        ? item.stdout
        : typeof item.aggregated_output === 'string'
          ? item.aggregated_output
          : '',
    startedAt: num(item.started_at_ms),
    completedAt: num(item.completed_at_ms),
    failed: status !== 'completed' || exit !== 0,
    readPaths: parsed.flatMap((segment) => {
      const entry = segment as { type?: unknown; path?: unknown } | null;
      const read = str(entry?.type) === 'read' ? str(entry?.path) : null;
      return read ? [normalizeFsPath(read)] : [];
    }),
  };
}

export function completedFileChange(payload: Record<string, unknown>): CompletedFileChange | null {
  const item = payload.item as Record<string, unknown> | undefined;
  if (!item || str(item.type) !== 'FileChange') {
    return null;
  }
  const changes = isRecord(item.changes) ? item.changes : {};
  const paths = codexChangePaths(changes);
  const presented = presentedStepDetail('apply_patch', { paths });
  return {
    changes,
    detail: presented.detail,
    fullDetail: presented.fullDetail ?? presented.detail,
    paths,
    sourceId: str(item.id),
    status: str(item.status) === 'failed' ? 'failed' : 'done',
  };
}

interface ParsedUpdate {
  sourceId: string | null;
  kind: TurnUpdate['kind'];
  text: string;
  commentarySource?: 'root' | 'response';
}

function blocksText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .flatMap((block) => {
      if (typeof block === 'string') {
        return [block];
      }
      const text = str((block as { text?: unknown } | null)?.text);
      return text ? [text] : [];
    })
    .join('\n');
}

// Read assistant messages from completed nested items or direct response items.
// `phase` distinguishes Activity commentary from final answers.
function parsedMessageItem(
  payload: Record<string, unknown>,
  captureSessionText = false,
): { sourceId: string | null; phase: string | null; text: string } | null {
  const nested = isRecord(payload.item) ? payload.item : null;
  const item = nested ?? payload;
  const type = str(item.type) ?? '';
  if (type !== 'AgentMessage' && type !== 'message' && type !== 'agent_message') {
    return null;
  }
  if (type === 'message' && str(item.role) !== 'assistant') {
    return null;
  }
  const raw = blocksText(item.content) || str(item.message) || '';
  const text = captureSessionText ? raw : raw.trim();
  return text.trim() ? { sourceId: str(item.id), phase: str(item.phase), text } : null;
}

// Read asynchronous AgentMessage items as Activity, even when their phase says final_answer.
// Question details use a title followed by one option per line. Other messages retain their own text.
// `parsedFinalAnswer` excludes asynchronous delivery from turn-ending answers.
function parsedAsyncMessage(payload: Record<string, unknown>, captureSessionText = false): ParsedUpdate | null {
  const item = isRecord(payload.item) ? payload.item : null;
  if (!item || str(item.type) !== 'AgentMessage' || str(item.delivery) !== 'async') {
    return null;
  }
  const questions = (Array.isArray(item.questions) ? item.questions : []).flatMap((entry: unknown) => {
    if (!isRecord(entry)) {
      return [];
    }
    const title = str(entry.title);
    if (!title) {
      return [];
    }
    const options = (Array.isArray(entry.options) ? entry.options : []).filter(
      (option): option is string => typeof option === 'string' && option !== '',
    );
    return [[title, ...options.map((option) => `- ${option}`)].join('\n')];
  });
  const raw = blocksText(item.content);
  const text = questions.length ? questions.join('\n\n') : captureSessionText ? raw : raw.trim();
  return text ? { sourceId: str(item.id), kind: 'commentary', text } : null;
}

// Visible assistant activity only. A final answer is handled by `parsedFinalAnswer` instead,
// and opaque reasoning fields are never copied into the normalized turn.
function parsedUpdate(
  payload: Record<string, unknown>,
  captureSessionText = false,
  wrapper?: string,
): ParsedUpdate | null {
  const message = parsedMessageItem(payload, captureSessionText);
  if (message) {
    return message.phase === 'commentary'
      ? {
          sourceId: message.sourceId,
          kind: 'commentary',
          text: message.text,
          ...(!payload.item && wrapper === 'event_msg' && payload.type === 'agent_message' && !message.sourceId
            ? { commentarySource: 'root' as const }
            : !payload.item && wrapper === 'response_item' && payload.type === 'message' && message.sourceId
              ? { commentarySource: 'response' as const }
              : {}),
        }
      : null;
  }
  const nested = isRecord(payload.item) ? payload.item : null;
  const item = nested ?? payload;
  const type = str(item.type) ?? '';
  if (type !== 'Reasoning' && type !== 'reasoning') {
    return null;
  }
  const text = (blocksText(item.summary_text) || blocksText(item.summary)).trim();
  return text ? { sourceId: str(item.id), kind: 'reasoning', text } : null;
}

// Read a final-answer message. Asynchronous delivery never supplies a turn-ending answer.
// The turn completion later identifies which recorded answer supplies its response.
function parsedFinalAnswer(
  payload: Record<string, unknown>,
  captureSessionText = false,
): { sourceId: string | null; text: string } | null {
  const item = isRecord(payload.item) ? payload.item : payload;
  if (str(item.delivery) === 'async') {
    return null;
  }
  const message = parsedMessageItem(payload, captureSessionText);
  return message && message.phase === 'final_answer' ? { sourceId: message.sourceId, text: message.text } : null;
}

// Read a child rollout's billed requests, grouped by turn. Model settings and token events can arrive in either order.
type CodexOwnSpend = {
  spend: AgentSpend;
  facts: Pick<AgentSpend, 'startedAt' | 'endedAt' | 'toolUses' | 'commits' | 'commitIntents' | 'person'>;
  meta: CodexSessionMeta | null;
  launches: TurnAgent[];
  finished: boolean;
  complete: boolean;
};

function readCodexOwnSpend(file: string): CodexOwnSpend {
  const scan = readCodexOwnSpendIncremental(file);
  let next = scan.next();
  while (!next.done) next = scan.next();
  return next.value;
}

function* readCodexOwnSpendIncremental(file: string): Generator<{ bytes: number; end: boolean }, CodexOwnSpend> {
  const meta = readCodexSessionMeta(file);
  const provider = meta?.modelProvider ?? null;
  const usageState = emptyCodexUsageReducerState(
    provider,
    meta?.replayBoundaryAt ?? null,
    meta?.sessionId ?? null,
    meta?.agentPath ?? null,
  );
  const requests: UsageEvent[] = [];
  const personScan: CodexPersonScan = {
    bytes: 0,
    headless: meta?.launchSource === 'exec',
    interactive: false,
    openedAt: meta?.openedAt ?? null,
    person: false,
    prompts: [],
    fragment: Buffer.alloc(0),
    prompt: null,
    usage: emptyCodexUsageReducerState(
      provider,
      meta?.replayBoundaryAt ?? null,
      meta?.sessionId ?? null,
      meta?.agentPath ?? null,
    ),
  };
  const lifecycle = codexLifecycleReducer();
  let partial = false;
  let effort: string | null = null;
  let incompleteRequests = 0;
  let lastLine = '';
  const sourceStamp = commitSourceStamp(file);
  const revision = spendFileVersion(file);
  const child = createCodexSessionReducer(
    meta?.sessionId ?? path.basename(file, path.extname(file)),
    { maxTurns: Number.MAX_SAFE_INTEGER },
    meta,
  );
  const found = yield* scanLinesIncremental(file, (line) => {
    child.pushLine(line);
    const personRecord = parseRecord(line);
    if (personRecord) codexPersonRecord(personScan, personRecord);
    if (line.trim()) {
      lastLine = line;
    }
    if (
      line.indexOf('session_meta') < 0 &&
      line.indexOf('task_started') < 0 &&
      line.indexOf('task_complete') < 0 &&
      line.indexOf('turn_aborted') < 0 &&
      line.indexOf('turn_context') < 0 &&
      line.indexOf('thread_settings_applied') < 0 &&
      line.indexOf('rate_limits') < 0 &&
      line.indexOf('token_count') < 0 &&
      line.indexOf('token_usage_record') < 0 &&
      line.indexOf('spawn_agent') < 0 &&
      line.indexOf('CommandExecution') < 0
    ) {
      return;
    }
    const record = parseRecord(line);
    if (!record) {
      return;
    }
    lifecycle.push(record);
    const events = reduceCodexUsageEvents(usageState, {
      kind: record.kind,
      timestamp: record.at,
      payload: record.payload,
    });
    if (record.kind === 'turn_context' && !usageState.currentTurnCopied) {
      effort = str(record.payload.effort) ?? effort;
    }
    effort = events.find((event) => event.effort)?.effort ?? effort;
    requests.push(...events);
  });
  const byIdentity = new Map<string, ModelSpend>();
  for (const event of requests) {
    if (event.incomplete) {
      if (!event.linkedInvocationId) {
        incompleteRequests += event.usage.requests ?? 0;
      }
      continue;
    }
    const model = event.model;
    const contextWindow = event.contextWindow;
    const eventProvider = event.agent === 'claude' ? event.provider : (event.provider ?? provider);
    const key = JSON.stringify([
      model,
      eventProvider,
      contextWindow,
      event.reportedCostBasis ?? null,
      event.linkedInvocationId ?? null,
    ]);
    const held = byIdentity.get(key) ?? {
      model,
      ...(eventProvider ? { provider: eventProvider } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(event.reportedCost === null ? {} : { recordedCost: 0 }),
      ...(event.reportedCostBasis ? { costBasis: event.reportedCostBasis } : {}),
      usageParts: [],
      usage: emptyUsage(),
    };
    addUsage(held.usage, event.usage, event.contextBand);
    addTurnUsagePart(held, { ...event, provider: eventProvider });
    if (event.reportedCost !== null) {
      held.recordedCost = (held.recordedCost ?? 0) + event.reportedCost;
    }
    held.unclassifiedCacheWrite = (held.unclassifiedCacheWrite ?? 0) + (event.unclassifiedCacheWrite ?? 0);
    if (!held.unclassifiedCacheWrite) {
      delete held.unclassifiedCacheWrite;
    }
    byIdentity.set(key, held);
  }
  partial ||= Object.keys(usageState.pendingClaudeResults).length > 0;
  const usageIncomplete = incompleteRequests > 0;
  const turns = child.finish(0).turns;
  if (found && lastLineWhole(lastLine)) bindCommitSources(turns, file, sourceStamp);
  // Only the child's own turns are timed. Turns of other sessions in the rollout add nothing.
  const measured = summedTurnRate(turns.filter((turn) => turn.sessionId === meta?.sessionId));
  const artifacts = reduceChildArtifacts(
    { turns },
    {
      revision,
      complete: lastLineWhole(lastLine),
      pathKey: normalizeFsPath,
      sameCommit: sameCommitSha,
    },
  );
  // Guardian records and duration figures use the same catalog start clock. Other children retain their recorded turn span.
  if (meta && isHiddenThread(meta) && meta.startedAt !== null) {
    artifacts.startedAt = meta.startedAt;
  }
  const spend: AgentSpend = found
    ? {
        models: [...byIdentity.values()],
        ...measured,
        found: true,
        partial,
        effort,
        artifacts,
        ...(usageIncomplete ? { usageIncomplete: true } : {}),
      }
    : { models: [], found: false, partial: false, effort: null };
  const lastTurn = lifecycle.value();
  return {
    spend,
    facts: {
      startedAt: artifacts.startedAt ?? null,
      endedAt: artifacts.endedAt ?? null,
      toolUses: childToolCalls(artifacts) ?? 0,
      commits: turns.flatMap((turn) => turn.commits),
      commitIntents: turns.flatMap((turn) => turn.commitIntents ?? []),
      person: personScan.person,
    },
    meta,
    launches: turns.flatMap((turn) => turn.agents.filter((agent) => !agent.invocationId)),
    finished:
      lastLineWhole(lastLine) &&
      lastTurn.startSeen &&
      lastTurn.turnId === usageState.currentTurnId &&
      !usageState.currentTurnCopied &&
      (lastTurn.status === 'completed' || lastTurn.status === 'failed'),
    complete: lastLineWhole(lastLine),
  };
}

// One catalog revision's direct ownership edges. Conflicting ids or paths never resolve to
// an arbitrary source, even when one candidate appears first in the listing.
export class CodexSpendIndex {
  private readonly byParent = new Map<string, CodexSubagentFile[]>();
  private readonly byId = new Map<string, CodexSubagentFile[]>();
  private readonly byFile = new Map<string, CodexSubagentFile[]>();
  private readonly sourceKeys = new Map<string, string>();
  readonly relationshipVersion: string | null;

  constructor(children: readonly CodexSubagentFile[]) {
    const seen = new Set<string>();
    for (const child of children) {
      const file = this.sourceKey(child.file);
      const identity = JSON.stringify([child.threadId, child.parentThreadId, file, child.agentPath]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      for (const [map, key] of [
        [this.byParent, child.parentThreadId],
        [this.byId, child.threadId],
        [this.byFile, file],
      ] as const) {
        if (key === null) continue;
        const held = map.get(key) ?? [];
        held.push(child);
        map.set(key, held);
      }
    }
    this.relationshipVersion = seen.size
      ? JSON.stringify([
          'relationships',
          createHash('sha256')
            .update([...seen].sort().join('\n'))
            .digest('hex'),
        ])
      : null;
  }

  sourceKey(file: string): string {
    let key = this.sourceKeys.get(file);
    if (key === undefined) {
      let resolved = path.resolve(file);
      try {
        resolved = fs.realpathSync.native(resolved);
      } catch {
        /* missing sources keep their absolute path */
      }
      key = normalizeFsPath(resolved);
      this.sourceKeys.set(file, key);
    }
    return key;
  }

  direct(parent: string): readonly CodexSubagentFile[] {
    return this.byParent.get(parent) ?? [];
  }

  threadOf(file: string): string | null {
    const rows = this.byFile.get(this.sourceKey(file)) ?? [];
    return rows.length && rows.every((row) => row.threadId === rows[0].threadId) ? rows[0].threadId : null;
  }

  entryOf(file: string): CodexSubagentFile | null {
    const rows = this.byFile.get(this.sourceKey(file)) ?? [];
    return rows.length && this.verified(rows[0]) ? rows[0] : null;
  }

  contains(file: string): boolean {
    return this.byFile.has(this.sourceKey(file));
  }

  unowned(): readonly CodexSubagentFile[] {
    return [...this.byId.values()].flat().filter((child) => child.parentThreadId === null);
  }

  verified(child: CodexSubagentFile): boolean {
    const ids = this.byId.get(child.threadId) ?? [];
    const files = this.byFile.get(this.sourceKey(child.file)) ?? [];
    return (
      ids.every(
        (entry) =>
          entry.parentThreadId === child.parentThreadId && this.sourceKey(entry.file) === this.sourceKey(child.file),
      ) && files.every((entry) => entry.threadId === child.threadId && entry.parentThreadId === child.parentThreadId)
    );
  }

  resolve(parent: string, ref: AgentSpendRef): CodexSubagentFile | null {
    const candidates = ref.id
      ? (this.byId.get(ref.id) ?? [])
      : this.direct(parent).filter(
          (child) =>
            child.agentPath &&
            (child.agentPath === (ref.path || `/root/${ref.name}`) || child.agentPath.endsWith(`/${ref.name}`)),
        );
    const unique = new Map(
      candidates
        .filter(
          (child) =>
            (child.parentThreadId === parent || (!!ref.id && child.parentThreadId === null)) && this.verified(child),
        )
        .map((child) => [this.sourceKey(child.file), child]),
    );
    return unique.size === 1 ? [...unique.values()][0] : null;
  }
}

const codexSpendIndexes = new WeakMap<readonly CodexSubagentFile[], CodexSpendIndex>();
const codexSpendRevisions = new Map<string, CodexSpendIndex>();
export function codexSpendIndex(children: readonly CodexSubagentFile[]): CodexSpendIndex {
  let index = codexSpendIndexes.get(children);
  if (!index) {
    const revision = JSON.stringify(children);
    index = codexSpendRevisions.get(revision);
    if (!index) index = new CodexSpendIndex(children);
    codexSpendRevisions.delete(revision);
    codexSpendRevisions.set(revision, index);
    while (codexSpendRevisions.size > 4) codexSpendRevisions.delete(codexSpendRevisions.keys().next().value!);
    codexSpendIndexes.set(children, index);
  }
  return index;
}

// Relationship fields and every descendant revision share one key in the host and worker.
// Each source contributes its bytes once to the adaptive running band.
export function codexAgentSpendVersion(
  file: string,
  index: CodexSpendIndex,
  knownThreadId?: string,
  dependencies?: readonly string[],
  navigationParent?: string,
): string {
  const navigation = [
    'commit-repositories:' + CODEX_COMMIT_REPOSITORY_PARSER_VERSION,
    ...(navigationParent
      ? [`commit-parent:${JSON.stringify([index.sourceKey(navigationParent), spendFileVersion(navigationParent)])}`]
      : []),
  ];
  if (dependencies) {
    const sources = new Map([file, ...dependencies].map((source) => [index.sourceKey(source), source]));
    return [
      'codex-aggregate',
      ...navigation,
      `source:${JSON.stringify([knownThreadId ?? index.threadOf(file), index.contains(file)])}`,
      ...(index.relationshipVersion ? [index.relationshipVersion] : []),
      ...[...sources].map(([key, source]) => `${key}:${spendFileVersion(source)}`),
    ]
      .sort()
      .join('\n');
  }
  const versions = ['codex-aggregate', spendFileVersion(file), ...navigation];
  const visited = new Set([index.sourceKey(file)]);
  const threadId = knownThreadId ?? index.threadOf(file);
  const source = index.entryOf(file);
  versions.push(
    `source:${JSON.stringify(source ? [source.threadId, source.parentThreadId, source.agentPath, source.file] : [threadId, index.contains(file)])}`,
  );
  const visit = (children: readonly CodexSubagentFile[]): void => {
    for (const child of children) {
      versions.push(
        JSON.stringify([child.threadId, child.parentThreadId, child.agentPath, child.file, index.verified(child)]),
      );
      const key = index.sourceKey(child.file);
      if (visited.has(key)) continue;
      visited.add(key);
      versions.push(`${key}:${spendFileVersion(child.file)}`);
      visit(index.direct(child.threadId));
    }
  };
  if (threadId) visit(index.direct(threadId));
  visit(index.unowned());
  return versions.sort().join('\n');
}

// A reader reuses each source's own parse across aggregates. The fold keeps the source's
// pricing parts intact and leaves effort, artifacts, and commit details owned by the direct child.
export function codexAgentSpendReader(
  index: CodexSpendIndex,
  loadOwn = readCodexOwnSpend,
  visitOwn?: (file: string, parsed: CodexOwnSpend) => void,
): (file: string) => AgentSpend {
  const own = new Map<string, CodexOwnSpend>();
  return (file) => {
    const scan = codexAgentSpendScan(file, index, visitOwn);
    let next = scan.next();
    while (!next.done) {
      const key = index.sourceKey(next.value);
      let parsed = own.get(key);
      if (!parsed) {
        parsed = loadOwn(next.value);
        own.set(key, parsed);
      }
      next = scan.next(parsed);
    }
    return next.value;
  };
}

function* codexAgentSpendScan(
  file: string,
  index: CodexSpendIndex,
  visitOwn?: (file: string, parsed: CodexOwnSpend) => void,
): Generator<string, AgentSpend, CodexOwnSpend> {
  const identity = (value: ModelSpend) =>
    JSON.stringify([
      value.model,
      value.provider ?? null,
      value.contextWindow ?? null,
      value.costBasis ?? null,
      [...new Set(value.usageParts?.map((usage) => usage.linkedInvocationId ?? null) ?? [])].sort(),
    ]);
  const visited = new Set<string>();
  const active = new Set<string>();
  const ancestors = new Set<string>();
  const read = function* (source: string, edge?: CodexSubagentFile): Generator<string, AgentSpend, CodexOwnSpend> {
    const key = index.sourceKey(source);
    if (visited.has(key)) return { models: [], found: true, partial: active.has(key), effort: null };
    visited.add(key);
    active.add(key);
    const parsed = yield source;
    const ownership = edge ?? index.entryOf(source);
    if (
      (index.contains(source) && !ownership) ||
      (ownership &&
        (!index.verified(ownership) ||
          (parsed.meta &&
            (parsed.meta.sessionId !== ownership.threadId ||
              (parsed.meta.parentThreadId !== null && parsed.meta.parentThreadId !== ownership.parentThreadId)))))
    ) {
      active.delete(key);
      return { models: [], found: false, partial: true, effort: null };
    }
    visitOwn?.(source, parsed);
    const result = structuredClone(parsed.spend);
    if (parsed.spend.found && parsed.facts.commits?.length) {
      result.commits = parsed.facts.commits.map((commit) => ({ ...commit }));
    }
    if (parsed.spend.found && parsed.facts.commitIntents?.length) {
      result.commitIntents = parsed.facts.commitIntents.map((intent) => ({ ...intent }));
    }
    if (!ownership && !parsed.meta && !result.found) {
      active.delete(key);
      return result;
    }
    result.partial ||=
      !result.found ||
      !parsed.meta ||
      !parsed.complete ||
      !parsed.finished ||
      (!!ownership && parsed.meta?.parentThreadId === null);
    const parent = ownership?.threadId ?? parsed.meta?.sessionId;
    if (!edge && parsed.meta?.parentThreadId) ancestors.add(parsed.meta.parentThreadId);
    const children = [...(parent ? index.direct(parent) : [])];
    for (const launch of parsed.launches) {
      const resolved = parent
        ? index.resolve(parent, {
            id: launch.id,
            name: launch.description,
            path: launch.agentType,
            status: launch.status,
          })
        : null;
      if (!resolved) result.partial = true;
      else {
        children.push(resolved);
        if (resolved.parentThreadId !== parent) result.partial = true;
      }
    }
    for (const child of children) {
      if (ancestors.has(child.threadId)) {
        result.partial = true;
        continue;
      }
      if (!index.verified(child)) {
        result.partial = true;
        continue;
      }
      const nested = yield* read(child.file, child);
      result.partial ||= !nested.found || nested.partial;
      result.found ||= nested.found;
      result.usageIncomplete ||= nested.usageIncomplete;
      for (const part of nested.models) {
        const held = result.models.find((value) => identity(value) === identity(part));
        if (!held) result.models.push(part);
        else {
          addUsage(held.usage, part.usage);
          if (part.recordedCost !== undefined) held.recordedCost = (held.recordedCost ?? 0) + part.recordedCost;
          if (part.unclassifiedCacheWrite !== undefined)
            held.unclassifiedCacheWrite = (held.unclassifiedCacheWrite ?? 0) + part.unclassifiedCacheWrite;
          if (part.usageParts) (held.usageParts ??= []).push(...part.usageParts);
        }
      }
    }
    if (!result.usageIncomplete) delete result.usageIncomplete;
    active.delete(key);
    return result;
  };
  return yield* read(file);
}

export function readCodexAgentSpend(file: string, children: readonly CodexSubagentFile[] = []): AgentSpend {
  return codexAgentSpendReader(codexSpendIndex(children))(file);
}

export interface CodexPersonScan {
  bytes: number;
  headless: boolean;
  interactive: boolean;
  openedAt: number | null;
  fragment: Buffer;
  person: boolean;
  prompts: Array<{ turn: string | null; count: number; interactive?: true }>;
  prompt: { text: string; at: number; kind: string; turn: string | null } | null;
  usage: CodexUsageReducerState;
  dispatchCompletion?: {
    sessionId: string;
    opening: boolean;
    invalid: boolean;
    skipping: boolean;
    starts: Set<string>;
    start: string | null;
    startedAt: number;
    eligible: boolean;
    terminal: { kind: string; id: string; at: number } | null;
  };
}

function codexPersonRecord(scan: CodexPersonScan, record: Entry): void {
  const foreign = scan.usage.foreignSessionMeta;
  reduceCodexUsageEvents(scan.usage, { kind: record.kind, timestamp: record.at, payload: record.payload });
  // Interactive metadata shares prompt-turn provenance so delayed copied dates retract both.
  if (
    scan.headless &&
    record.kind === 'session_meta' &&
    (record.payload.source === 'cli' || record.payload.source === 'vscode') &&
    scan.usage.openingSessionId !== null &&
    (str(record.payload.id) ?? str(record.payload.session_id)) === scan.usage.openingSessionId &&
    scan.openedAt !== null &&
    record.at > scan.openedAt &&
    !foreign &&
    !scan.usage.foreignSessionMeta &&
    !scan.usage.currentTurnCopied
  ) {
    const turn = scan.usage.currentTurnId;
    if (turn === null) scan.interactive = true;
    else {
      let evidence = scan.prompts.find((entry) => entry.turn === turn);
      if (!evidence) scan.prompts.push((evidence = { turn, count: 0 }));
      evidence.interactive = true;
    }
  }
  const completion = scan.dispatchCompletion;
  if (completion) {
    const id = str(record.payload.turn_id);
    const terminal = record.kind === 'task_complete' || record.kind === 'turn_aborted';
    if (
      completion.terminal &&
      !(
        terminal &&
        completion.terminal.kind === record.kind &&
        completion.terminal.id === id &&
        completion.terminal.at === record.at
      ) &&
      record.kind !== 'rate_limits' &&
      record.kind !== 'thread_settings_applied'
    ) {
      completion.terminal = null;
      completion.eligible = false;
    }
    if (record.kind === 'session_meta') {
      const identity = str(record.payload.id) ?? str(record.payload.session_id);
      if (!completion.opening) {
        completion.opening =
          identity === completion.sessionId &&
          record.at > 0 &&
          scan.usage.openingSessionId === completion.sessionId &&
          scan.usage.openingTimestamp !== null;
        if (!completion.opening) completion.invalid = true;
      } else if (identity !== completion.sessionId) {
        completion.eligible = false;
        completion.terminal = null;
      }
    }
    if (record.kind === 'task_started') {
      completion.terminal = null;
      const repeated = !!id && completion.starts.has(id);
      if (id) completion.starts.add(id);
      if (completion.starts.size > CODEX_USAGE_ASSOCIATION_LIMIT) {
        completion.starts.delete(completion.starts.values().next().value!);
        completion.invalid = true;
      }
      completion.start = id;
      completion.startedAt = record.at;
      completion.eligible =
        completion.opening &&
        !completion.invalid &&
        !!id &&
        record.at > 0 &&
        !repeated &&
        !foreign &&
        !scan.usage.foreignSessionMeta &&
        !scan.usage.currentTurnCopied;
    } else if (terminal) {
      if (
        completion.eligible &&
        id &&
        id === completion.start &&
        record.at >= completion.startedAt &&
        !scan.usage.currentTurnCopied &&
        !scan.usage.foreignSessionMeta
      ) {
        completion.terminal = { kind: record.kind, id, at: record.at };
      } else {
        completion.terminal = null;
        completion.eligible = false;
      }
    } else if (record.kind === 'turn_context' && scan.usage.currentTurnCopied) {
      completion.eligible = false;
      completion.terminal = null;
    }
  }
  scan.prompts = scan.prompts.filter((entry) => !entry.turn || !scan.usage.datedCopiedTurnIds[entry.turn]);
  const interactive = !scan.headless || scan.interactive || scan.prompts.some((entry) => entry.interactive);
  scan.person = interactive && scan.prompts.reduce((sum, entry) => sum + entry.count, 0) > 1;
  if (scan.usage.currentTurnCopied || subagentNotification(record)) return;
  const text = codexPrompt(userMessage(record) ?? '');
  if (!text) return;
  const previous = scan.prompt;
  const duplicate =
    previous &&
    previous.text === text &&
    previous.turn === scan.usage.currentTurnId &&
    previous.kind !== record.kind &&
    Math.abs(previous.at - record.at) <= 2000;
  if (duplicate) return;
  const turn = scan.usage.currentTurnId;
  let evidence = scan.prompts.find((entry) => entry.turn === turn);
  if (!evidence) scan.prompts.push((evidence = { turn, count: 0 }));
  evidence.count = Math.min(2, evidence.count + 1);
  scan.person = interactive && scan.prompts.reduce((sum, entry) => sum + entry.count, 0) > 1;
  scan.prompt = { text, at: record.at, kind: record.kind, turn };
}

// Export classification consumes complete admitted lines without a second source read.
export function createCodexRunClassifier(meta: CodexSessionMeta | null) {
  const scan: CodexPersonScan = {
    bytes: 0,
    headless: meta?.launchSource === 'exec',
    interactive: false,
    openedAt: meta?.openedAt ?? null,
    person: false,
    prompts: [],
    fragment: Buffer.alloc(0),
    prompt: null,
    usage: emptyCodexUsageReducerState(
      meta?.modelProvider ?? null,
      meta?.replayBoundaryAt ?? null,
      meta?.sessionId ?? null,
      meta?.agentPath ?? null,
    ),
  };
  return {
    pushLine(line: string) {
      const record = parseRecord(line);
      if (record) codexPersonRecord(scan, record);
    },
    agentRun: () => meta !== null && isAgentRun(meta),
    person: () => scan.person,
  };
}

export function scanForCodexPerson(
  file: string,
  size: number,
  previous?: CodexPersonScan,
  dispatchSessionId?: string,
): CodexPersonScan {
  const meta = previous && previous.bytes <= size ? null : readCodexSessionMeta(file);
  const scan: CodexPersonScan =
    previous && previous.bytes <= size
      ? previous
      : {
          bytes: 0,
          headless: meta?.launchSource === 'exec',
          interactive: false,
          openedAt: meta?.openedAt ?? null,
          person: false,
          prompts: [],
          fragment: Buffer.alloc(0),
          prompt: null,
          usage: emptyCodexUsageReducerState(
            meta?.modelProvider ?? null,
            meta?.replayBoundaryAt ?? null,
            meta?.sessionId ?? null,
            meta?.agentPath ?? null,
          ),
        };
  if (dispatchSessionId && !scan.dispatchCompletion) {
    scan.dispatchCompletion = {
      sessionId: dispatchSessionId,
      opening: false,
      invalid: false,
      skipping: false,
      starts: new Set(),
      start: null,
      startedAt: 0,
      eligible: false,
      terminal: null,
    };
  }
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.allocUnsafe(Math.min(Math.max(0, size - scan.bytes), 256 * 1024));
    const read = meterRead(file, fs.readSync(fd, chunk, 0, chunk.length, scan.bytes));
    scan.bytes += read;
    let bytes = Buffer.concat([scan.fragment, chunk.subarray(0, read)]);
    const completion = scan.dispatchCompletion;
    if (completion?.skipping) {
      const newline = bytes.indexOf(0x0a);
      bytes = newline < 0 ? Buffer.alloc(0) : bytes.subarray(newline + 1);
      completion.skipping = newline < 0;
    }
    const end = bytes.lastIndexOf(0x0a);
    scan.fragment = Buffer.from(bytes.subarray(end + 1));
    if (completion && scan.fragment.length > 1024 * 1024) {
      scan.fragment = Buffer.alloc(0);
      completion.skipping = true;
      completion.invalid = true;
      completion.terminal = null;
    }
    if (end >= 0) {
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
        const record = parseRecord(line);
        if (record) codexPersonRecord(scan, record);
        else if (completion && line.trim()) {
          completion.invalid = true;
          completion.terminal = null;
          completion.eligible = false;
        }
      }
    }
  } catch {
    /* unreadable sources retain their last complete prompt evidence */
    if (scan.dispatchCompletion) {
      scan.dispatchCompletion.invalid = true;
      scan.dispatchCompletion.eligible = false;
      scan.dispatchCompletion.terminal = null;
    }
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
  return scan;
}

export interface CodexDispatchSpendEntry {
  key: string;
  band?: string;
  value: CodexOwnSpend;
}

const codexDispatchOwnSpends = new Map<string, CodexDispatchSpendEntry>();
const CODEX_DISPATCH_CACHE_BYTES = 32 * 1024 * 1024;
const codexDispatchCharges = new Map<string, number>();
let codexDispatchCacheBytes = 0;
let pendingDispatchSpend: {
  root: string;
  file: string;
  key: string;
  scan: Generator<{ bytes: number; end: boolean }, CodexOwnSpend>;
} | null = null;

function dispatchSpendKey(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch {
    return 'missing';
  }
}

export function retainCodexDispatchSpend(file: string, entry: CodexDispatchSpendEntry): void {
  const bytes = Buffer.byteLength(JSON.stringify(entry));
  codexDispatchCacheBytes -= codexDispatchCharges.get(file) ?? 0;
  codexDispatchOwnSpends.delete(file);
  codexDispatchCharges.delete(file);
  if (bytes > CODEX_DISPATCH_CACHE_BYTES) return;
  codexDispatchOwnSpends.set(file, entry);
  codexDispatchCharges.set(file, bytes);
  codexDispatchCacheBytes += bytes;
  while (codexDispatchCacheBytes > CODEX_DISPATCH_CACHE_BYTES || codexDispatchOwnSpends.size > 200) {
    const oldest = codexDispatchOwnSpends.keys().next().value!;
    codexDispatchCacheBytes -= codexDispatchCharges.get(oldest)!;
    codexDispatchCharges.delete(oldest);
    codexDispatchOwnSpends.delete(oldest);
  }
}

export function retainCodexDispatchSpendRoots(files: ReadonlySet<string>): void {
  if (pendingDispatchAggregate && !files.has(pendingDispatchAggregate.root)) discardDispatchAggregate();
}

// One aggregate retains its traversal independently of reusable source-cache eviction.
let pendingDispatchAggregate: {
  root: string;
  relationships: string | null;
  revisions: Map<string, Pick<CodexDispatchSpendEntry, 'key' | 'band'> & { value: Pick<CodexOwnSpend, 'finished'> }>;
  scan: Generator<string, AgentSpend, CodexOwnSpend>;
  next: IteratorResult<string, AgentSpend>;
} | null = null;

function discardDispatchAggregate(): void {
  pendingDispatchSpend?.scan.return(undefined as never);
  pendingDispatchSpend = null;
  pendingDispatchAggregate?.scan.return(undefined as never);
  pendingDispatchAggregate = null;
}

export type CodexDispatchSpendProgress =
  | 'dispatchSpendAggregateStarts'
  | 'dispatchSpendAggregateCompletions'
  | 'dispatchSpendRelationshipInvalidations'
  | 'dispatchSpendConsumedSourceInvalidations'
  | 'dispatchSpendSourceRestarts'
  | 'dispatchSpendParserAdvancements'
  | 'dispatchSpendRootWaits';

export function readCodexDispatchedSpendQuantum(
  file: string,
  children: readonly CodexSubagentFile[],
  now: number,
  budget: { bytes: number; deadline: number; advanced?: boolean },
  dependencies: (files: string[]) => void,
  completed: (file: string, entry: CodexDispatchSpendEntry) => void,
  progress?: (event: CodexDispatchSpendProgress) => void,
): { spend: AgentSpend; pending: boolean } {
  const index = codexSpendIndex(children);
  if (pendingDispatchAggregate?.root === file) {
    if (pendingDispatchAggregate.relationships !== index.relationshipVersion) {
      progress?.('dispatchSpendRelationshipInvalidations');
      discardDispatchAggregate();
    } else if (
      [...pendingDispatchAggregate.revisions].some(([source, entry]) => !compatibleDispatchSpend(source, entry, now))
    ) {
      progress?.('dispatchSpendConsumedSourceInvalidations');
      discardDispatchAggregate();
    }
  }
  if (pendingDispatchAggregate && pendingDispatchAggregate.root !== file) {
    progress?.('dispatchSpendRootWaits');
    return { spend: { models: [], found: false, partial: true, effort: null }, pending: true };
  }
  if (!pendingDispatchAggregate) {
    progress?.('dispatchSpendAggregateStarts');
    const scan = codexDispatchedSpendScan(file, index);
    pendingDispatchAggregate = {
      root: file,
      relationships: index.relationshipVersion,
      revisions: new Map(),
      scan,
      next: scan.next(),
    };
  }
  const aggregate = pendingDispatchAggregate;
  while (!aggregate.next.done && budget.bytes > 0 && (!budget.advanced || performance.now() < budget.deadline)) {
    const source = aggregate.next.value;
    const key = dispatchSpendKey(source);
    const band = openSpendBand(spendFileVersion(source), now);
    const held = codexDispatchOwnSpends.get(source);
    let parsed: CodexOwnSpend;
    const reusable = held && compatibleDispatchSpend(source, held, now);
    if (reusable) {
      parsed = held.value;
    } else {
      if (pendingDispatchSpend && (pendingDispatchSpend.file !== source || pendingDispatchSpend.key !== key)) {
        if (pendingDispatchSpend.file === source) progress?.('dispatchSpendSourceRestarts');
        pendingDispatchSpend.scan.return(undefined as never);
        pendingDispatchSpend = null;
      }
      pendingDispatchSpend ??= { root: file, file: source, key, scan: readCodexOwnSpendIncremental(source) };
      let next = pendingDispatchSpend.scan.next();
      progress?.('dispatchSpendParserAdvancements');
      budget.advanced = true;
      if (!next.done) {
        budget.bytes -= next.value.bytes;
        if (!next.value.end) continue;
        next = pendingDispatchSpend.scan.next();
        progress?.('dispatchSpendParserAdvancements');
        if (!next.done) break;
      }
      pendingDispatchSpend = null;
      if (dispatchSpendKey(source) !== key) {
        progress?.('dispatchSpendSourceRestarts');
        break;
      }
      parsed = next.value;
      const entry = { key, ...(band ? { band } : {}), value: parsed };
      retainCodexDispatchSpend(source, entry);
      completed(source, entry);
    }
    // Revision evidence retains no parsed source payload after its contribution enters the fold.
    aggregate.revisions.set(source, {
      key: reusable ? held.key : key,
      ...((reusable ? held.band : band) ? { band: reusable ? held.band : band! } : {}),
      value: { finished: parsed.finished },
    });
    budget.advanced = true;
    aggregate.next = aggregate.scan.next(parsed);
  }
  dependencies([...aggregate.revisions.keys(), ...(!aggregate.next.done ? [aggregate.next.value] : [])]);
  if (aggregate.next.done) {
    progress?.('dispatchSpendAggregateCompletions');
    const spend = aggregate.next.value;
    pendingDispatchAggregate = null;
    return { spend, pending: false };
  }
  return { spend: { models: [], found: false, partial: true, effort: null }, pending: true };
}

function compatibleDispatchSpend(
  source: string,
  held: Pick<CodexDispatchSpendEntry, 'key' | 'band'> & { value: Pick<CodexOwnSpend, 'finished'> },
  now: number,
): boolean {
  const key = dispatchSpendKey(source);
  const band = openSpendBand(spendFileVersion(source), now);
  const grew =
    key.split(':').slice(0, 2).join(':') === held.key.split(':').slice(0, 2).join(':') &&
    BigInt(key.split(':')[2] ?? 0) > BigInt(held.key.split(':')[2] ?? 0);
  return held.key === key || (!!band && grew && held.band === band && !held.value.finished);
}

export function readCodexDispatchedSpend(
  files: readonly string[],
  children: readonly CodexSubagentFile[] = [],
  now = Date.now(),
  dependencies?: (files: string[]) => void,
  load?: (file: string) => CodexOwnSpend,
): AgentSpend {
  const loadOwn = (file: string) => {
    if (load) return load(file);
    const key = dispatchSpendKey(file);
    let held = codexDispatchOwnSpends.get(file);
    const band = openSpendBand(spendFileVersion(file), now);
    if (!held || (held.key !== key && !(band && held.band === band && !held.value.finished))) {
      held = { key, ...(band ? { band } : {}), value: readCodexOwnSpend(file) };
      retainCodexDispatchSpend(file, held);
    }
    return held.value;
  };
  const scan = codexDispatchedSpendScan(files[0], codexSpendIndex(children));
  const visitedFiles: string[] = [];
  let next = scan.next();
  while (!next.done) {
    visitedFiles.push(next.value);
    next = scan.next(loadOwn(next.value));
  }
  dependencies?.(visitedFiles);
  return next.value;
}

function* codexDispatchedSpendScan(
  file: string | undefined,
  index: CodexSpendIndex,
): Generator<string, AgentSpend, CodexOwnSpend> {
  const spends: AgentSpend[] = [];
  const verifiedFiles: string[] = [];
  const aggregate = file
    ? yield* codexAgentSpendScan(file, index, (file, parsed) => {
        verifiedFiles.push(file);
        const spend = { ...structuredClone({ ...parsed.spend, models: [] }), ...parsed.facts };
        spend.partial ||= !parsed.finished;
        if (spend.artifacts) spend.artifacts.complete &&= parsed.finished;
        spends.push(spend);
      })
    : null;
  const own = spends[0];
  if (!own) return aggregate ?? { models: [], found: false, partial: false, effort: null };
  const artifacts = own.artifacts
    ? reduceChildArtifacts(
        {
          turns: spends.flatMap((spend) =>
            spend.artifacts
              ? [
                  {
                    files: spend.artifacts.files.map((file) => ({ ...file, edits: [], hunks: [] })),
                    commits: spend.commits ?? [],
                    toolTally: spend.artifacts.tools,
                    startedAt: spend.artifacts.startedAt,
                    endedAt: spend.artifacts.endedAt,
                  },
                ]
              : [],
          ),
        },
        {
          revision: verifiedFiles.map(spendFileVersion).join('\n'),
          complete:
            aggregate?.partial !== true && spends.every((spend) => spend.found && spend.artifacts?.complete === true),
          pathKey: normalizeFsPath,
          sameCommit: sameCommitSha,
        },
      )
    : undefined;
  if (artifacts) {
    const failedTools = new Map<string, number>();
    let failedCount = 0;
    for (const spend of spends) {
      const failed = spend.artifacts?.failed;
      failedCount += failed?.count ?? 0;
      for (const [name, count] of Object.entries(failed?.byTool ?? {})) {
        failedTools.set(name, (failedTools.get(name) ?? 0) + count);
      }
    }
    if (failedCount) artifacts.failed = { count: failedCount, byTool: Object.fromEntries(failedTools) };
    const turnCount = spends.reduce((sum, spend) => sum + (spend.artifacts?.turnCount ?? (spend.found ? 1 : 0)), 0);
    if (turnCount > 1) artifacts.turnCount = turnCount;
  }
  return {
    ...own,
    models: aggregate?.models ?? [],
    partial:
      aggregate?.partial === true ||
      spends.some((spend) => !spend.found || spend.partial || spend.artifacts?.complete === false),
    usageIncomplete: aggregate?.usageIncomplete === true,
    commits: spends.flatMap((spend) => spend.commits ?? []),
    commitIntents: spends.flatMap((spend) => spend.commitIntents ?? []),
    artifacts,
    toolUses: childToolCalls(artifacts) ?? own.toolUses,
  };
}

// Resolve a child by exact thread id. Fall back to an agent path only when it identifies one child under the parent.
export function codexSubagentFor(
  children: readonly CodexSubagentFile[],
  parentThreadId: string,
  ref: AgentSpendRef,
): CodexSubagentFile | null {
  return codexSpendIndex(children).resolve(parentThreadId, ref);
}

// Group a turn's file edits by normalized path. Drive-letter case differences must not create duplicate file rows.
type Building = Omit<Turn, 'files'> & {
  files: Map<string, TurnFileChange>;
  fileChanges: Set<string>;
};

const CODEX_SOURCE_START = Symbol('codexSourceStart');
const CODEX_SOURCE_END = Symbol('codexSourceEnd');
const CODEX_MEMBERSHIP_START = Symbol('codexMembershipStart');
type SourcedBuilding = Building & {
  [CODEX_SOURCE_START]?: number;
  [CODEX_SOURCE_END]?: number;
  [CODEX_MEMBERSHIP_START]?: number;
};

function setCodexSourceRange(value: object, start: number, end: number): void {
  Object.defineProperty(value, CODEX_SOURCE_START, {
    value: start,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(value, CODEX_SOURCE_END, {
    value: end,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function extendCodexSourceRange(value: SourcedBuilding, start: number, end: number): void {
  const currentStart = value[CODEX_SOURCE_START];
  const currentEnd = value[CODEX_SOURCE_END];
  if (currentStart === undefined || start < currentStart) {
    Object.defineProperty(value, CODEX_SOURCE_START, {
      value: start,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (currentEnd === undefined || end > currentEnd) {
    Object.defineProperty(value, CODEX_SOURCE_END, {
      value: end,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}

function setCodexMembershipStart(value: SourcedBuilding, start: number): void {
  Object.defineProperty(value, CODEX_MEMBERSHIP_START, {
    value: start,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

// A Codex file-change record rewrites a step's exact detail after the call that opened it.
const CODEX_HIDDEN_POLICY: HiddenStatePolicy = {
  start: CODEX_SOURCE_START,
  end: CODEX_SOURCE_END,
  membershipStart: CODEX_MEMBERSHIP_START,
  redefinesDetail: true,
};

// Record markers that admit lines for parsing. Skip unrelated reasoning and opening instructions before JSON.parse.
const NEEDLES = [
  'session_meta',
  'task_started',
  'task_complete',
  'turn_aborted',
  'user_message',
  'token_count',
  'token_usage_record',
  'patch_apply_end',
  'turn_context',
  'custom_tool_call',
  'function_call',
  'sub_agent_activity',
  'compacted',
  'web_search_call',
  'CommandExecution',
  // Settings identify the billing provider and service tier for both usage and session readers.
  'thread_settings_applied',
  'AgentMessage',
  'Reasoning',
  'item_completed',
  FINAL_ANSWER,
  // Retain the skill catalog so completed file reads can match published skill paths.
  CODEX_SKILL_CATALOG,
];

function carriesDelegation(line: string): boolean {
  return line.indexOf('"type":"agent_message"') >= 0 && line.indexOf('Message Type: NEW_TASK') >= 0;
}

function carriesRecord(line: string): boolean {
  return (
    carriesUserMessage(line) ||
    carriesAssistantUpdate(line) ||
    carriesDelegation(line) ||
    NEEDLES.some((needle) => line.indexOf(needle) >= 0)
  );
}

export function codexSessionLineMayAffectRead(line: string): boolean {
  return line.length >= 20 && carriesRecord(line);
}

// Admit phased assistant messages and reasoning summaries through their specific markers.
// Generic message names alone also occur in unrelated records.
function carriesAssistantUpdate(line: string): boolean {
  const phased =
    (line.indexOf('"phase":"commentary"') >= 0 || line.indexOf('"phase":"final_answer"') >= 0) &&
    (line.indexOf('"type":"message"') >= 0 || line.indexOf('"type":"agent_message"') >= 0);
  const reasoning =
    line.indexOf('"type":"reasoning"') >= 0 && (line.indexOf('"summary"') >= 0 || line.indexOf('"summary_text"') >= 0);
  return phased || reasoning;
}

// Detect visible work without building a turn. Boundary readers and incremental indexes share this record-level rule.
// Empty completed turns supply no unread card. Token usage alone does not establish visible work.
// Completed commands rely on their preceding tool calls to establish work.
function codexTurnRecordDidSomething(record: Entry, agentPath: string | null = null): boolean {
  const asked = userMessage(record);
  if (asked !== null) {
    return Boolean(codexPrompt(asked));
  }
  if (codexDelegation(record, agentPath)) {
    return true;
  }
  if (parsedUpdate(record.payload)) {
    return true;
  }
  if (record.kind === 'custom_tool_call' || record.kind === 'function_call' || record.kind === 'web_search_call') {
    return true;
  }
  if (record.kind === 'patch_apply_end') {
    return record.payload.success !== false && hasVisibleCodexChanges(record.payload.changes);
  }
  if (record.kind === 'item_completed') {
    const fileChange = completedFileChange(record.payload);
    return fileChange?.status === 'done' && hasVisibleCodexChanges(fileChange.changes);
  }
  if (record.kind === 'task_complete') {
    return Boolean(str(record.payload.last_agent_message)) || failedCodexTurn(record);
  }
  return interruptedCodexTurn(record);
}

function codexCompactionTrigger(
  turnStarted: boolean,
  turnCopied: boolean,
  turnDidSomething: boolean,
): '' | 'auto' | 'manual' {
  if (!turnStarted || turnCopied) {
    return '';
  }
  return turnDidSomething ? 'auto' : 'manual';
}

interface CodexNewestBoundaryState {
  didSomething: boolean;
  completed: boolean;
  agentPath: string | null;
}

function visitCodexBoundary(state: CodexNewestBoundaryState, line: string): boolean {
  if (line.length < 20 || !carriesRecord(line)) {
    return false;
  }
  const record = parseRecord(line);
  if (!record) {
    return false;
  }
  if (record.kind === 'task_started') {
    const found = state.didSomething || !state.completed;
    state.didSomething = false;
    state.completed = false;
    return found;
  }
  if (record.kind === 'task_complete' || record.kind === 'turn_aborted') {
    state.completed = true;
    state.didSomething = codexTurnRecordDidSomething(record, state.agentPath);
    return false;
  }
  if (codexTurnRecordDidSomething(record, state.agentPath)) {
    state.didSomething = true;
  }
  return false;
}

function codexBoundaryState(lines: readonly string[], agentPath: string | null): CodexNewestBoundaryState {
  const state = { didSomething: false, completed: false, agentPath };
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    visitCodexBoundary(state, lines[i]);
  }
  return state;
}

function turnStartsIn(lines: string[], agentPath: string | null): number[] {
  const starts: number[] = [];
  // Hold the start until visible work arrives. Keep an unclosed start at the window's end.
  let open: number | null = null;
  for (const line of lines) {
    if (line.length < 20 || !carriesRecord(line)) {
      continue;
    }
    const record = parseRecord(line);
    if (!record) {
      continue;
    }
    if (record.kind === 'task_started') {
      // Drop unreadable timestamps. `stamp` returns zero, which would incorrectly place the turn before recorded work.
      open = record.at || null;
      continue;
    }
    if (open === null) {
      continue;
    }
    // Keep completions with visible work. Empty compaction completions do not establish a turn to draw.
    if (record.kind === 'task_complete' || record.kind === 'turn_aborted') {
      if (codexTurnRecordDidSomething(record, agentPath)) {
        starts.push(open);
      }
      open = null;
      continue;
    }
    if (codexTurnRecordDidSomething(record, agentPath)) {
      starts.push(open);
      open = null;
    }
  }
  if (open !== null) {
    starts.push(open);
  }
  return starts;
}

export function readCodexTurnStarts(file: string, bytes = TURN_START_BYTES): TurnStarts {
  const agentPath = readCodexSessionMeta(file)?.agentPath ?? null;
  return readTurnStartsFromTail(file, (lines) => turnStartsIn(lines, agentPath), bytes);
}

export interface CodexReadOptions extends ReadOptions {
  // A capture supplies opening metadata admitted at its frozen source revision.
  capturedOpening?: CodexSessionMeta | null;
  // Structural child headers cover background work that has no spawn record in the parent.
  // The reducer attaches one such child only when its opening time belongs to one parsed turn.
  structuralChildren?: readonly CodexSubagentFile[];
  // Explicit capture reuses child lifecycle readings within its frozen graph.
  structuralStatusOf?: typeof structuralAgentStatus;
}

export type CodexSessionRead = SessionRead;

// Turns and compactions in the tail of one Codex rollout, each oldest first.
export function readCodexSession(file: string, sessionId: string, opts: CodexReadOptions = {}): CodexSessionRead {
  const tailBytes = opts.tailBytes ?? 4 * 1024 * 1024;
  const tail = tailOf(file, tailBytes, opts.prepareNewestTurnDiscovery === true);
  // An outer Codex exec call can run several commands, so its output cannot be paired with
  // one command. The session cwd remains a safe repository hint for opening that output.
  const meta = readCodexSessionMeta(file);
  const read = readCodexSessionLines(tail.lines, sessionId, opts, tail.readBytes, meta);
  if (
    opts.prepareNewestTurnDiscovery &&
    !tail.whole &&
    tail.cursor &&
    turnStartsIn(tail.lines, meta?.agentPath ?? null).length === 0
  ) {
    read.newestTurnCursor = tail.cursor;
    read.newestTurnState = codexBoundaryState(tail.lines, meta?.agentPath ?? null);
  }
  return read;
}

export function discoverCodexNewestTurn(
  file: string,
  cursor: BackwardLineCursor,
  opaqueState: unknown,
  options: BoundaryDiscoveryOptions = {},
): Promise<BoundaryDiscovery> {
  const restored = opaqueState as Partial<CodexNewestBoundaryState> | undefined;
  const state: CodexNewestBoundaryState = {
    didSomething: restored?.didSomething === true,
    completed: restored?.completed === true,
    agentPath: restored?.agentPath ?? readCodexSessionMeta(file)?.agentPath ?? null,
  };
  return discoverBackwardBoundary(file, cursor, (line) => visitCodexBoundary(state, line.text), options);
}

export interface CodexSessionParserState {
  version: 22;
  responseClock: CodexResponseClock;
  turns: Turn[];
  turnRanges: Array<{ start: number; end: number }>;
  turnMembershipStarts: number[];
  compactions: Compaction[];
  compactionRanges: Array<{ start: number; end: number }>;
  compactionTurnIds: Array<string | null>;
  compactionValueSources: Array<{
    context: { start: number; end: number } | null;
    model: { start: number; end: number } | null;
  }>;
  // A compacted record can carry exact usage without its billing identity. Current rollouts
  // supply that identity in the following settings record, before that compaction turn closes.
  pendingCompactionBilling: {
    at: number;
    model: string | null;
    modelSource: { start: number; end: number } | null;
    provider: string | null;
    providerSource: { start: number; end: number } | null;
    serviceTier: string | null;
    serviceTierSource: { start: number; end: number } | null;
  } | null;
  turnLimitReached: boolean;
  // The newest discarded prompt proves whether advancing the tail removed every overflow.
  turnLimitStart: number | null;
  contexts: Map<string, { model: string | null; effort: string | null; start: number; end: number }>;
  toolNames: Map<string, string>;
  // Retain published skills across turns and tail rereads. A command can read a skill long after catalog publication.
  skillCatalog: Map<string, CodexSkill>;
  stepById: Map<string, TurnStep>;
  updateById: Map<string, TurnUpdate>;
  updateByText: Map<string, TurnUpdate>;
  // One unpaired complementary commentary source. Shared update identity survives reducer snapshots.
  commentaryPair: { update: TurnUpdate; source: 'root' | 'response' } | null;
  answerById: Map<string, TurnAnswer>;
  pendingExec: Map<string, { step: TurnStep; expanded: boolean }>;
  launched: Map<string, TurnAgent>;
  // Current collaboration output can arrive before its matching completed item. This is
  // reducer-only association state, never a field on the public child row.
  currentSpawns: Set<string>;
  byName: Map<string, TurnAgent>;
  seenClaudeCommands: Record<string, { accepted: boolean; invocationId: string }>;
  usageState: CodexUsageReducerState;
  lastContext: number;
  // The last known cache lifetime. Read-only requests retain the lifetime without establishing a new write.
  lastLifetime: CacheLifetime | null;
  lastContextSource: { start: number; end: number } | null;
  lastModel: string | null;
  lastModelSource: { start: number; end: number } | null;
  lastReportedModel?: string | null;
  lastReportedModelSource?: { start: number; end: number } | null;
  pendingReportedModels?: Record<string, { model: string; start: number; end: number }>;
  reportedModelSequence?: number;
  lastProviderSource: { start: number; end: number } | null;
  lastServiceTierSource: { start: number; end: number } | null;
  updateSequence: number;
  pendingClassification: string[];
  open: SourcedBuilding | null;
  defaultDir: string | null;
  provider: string | null;
  agentPath: string | null;
  opening: { openedAt: number | null; sessionId: string | null };
  // Plain snapshot of symbol-keyed and non-enumerable turn fields. Restored reducers reattach those fields.
  hidden?: HiddenParserState;
}

export interface CodexSessionReducer {
  retainedBytes(): number;
  retainedPayloadScan(): Generator<void, number>;
  pushLine(line: string | ParserLine): void;
  trimBefore(offset: number): boolean;
  snapshot(): CodexSessionParserState;
  read(readBytes?: number): CodexSessionRead;
  // Finalizes and returns the reducer's owned state without cloning.
  finish(readBytes?: number): CodexSessionRead;
  completedTurns(): Array<{ turn: Turn; start: number; end: number }>;
  completedCompactions(): Array<{ compaction: Compaction; start: number; end: number }>;
  openRange(): { start: number; end: number } | null;
}

function emptyCodexSessionParserState(meta: CodexSessionMeta | null): CodexSessionParserState {
  const provider = meta?.modelProvider ?? null;
  const openedAt = meta?.openedAt ?? null;
  const replayBoundaryAt = meta?.replayBoundaryAt ?? null;
  const openingSessionId = meta?.sessionId ?? null;
  return {
    version: 22,
    responseClock: emptyCodexResponseClock(),
    turns: [],
    turnRanges: [],
    turnMembershipStarts: [],
    compactions: [],
    compactionRanges: [],
    compactionTurnIds: [],
    compactionValueSources: [],
    pendingCompactionBilling: null,
    turnLimitReached: false,
    turnLimitStart: null,
    contexts: new Map(),
    toolNames: new Map(),
    skillCatalog: new Map(),
    stepById: new Map(),
    updateById: new Map(),
    updateByText: new Map(),
    commentaryPair: null,
    answerById: new Map(),
    pendingExec: new Map(),
    launched: new Map(),
    currentSpawns: new Set(),
    byName: new Map(),
    seenClaudeCommands: {},
    usageState: emptyCodexUsageReducerState(
      provider,
      replayBoundaryAt,
      openingSessionId,
      meta?.agentPath ?? null,
      meta?.nativeSpawnedAt ?? null,
    ),
    lastContext: 0,
    lastLifetime: null,
    lastContextSource: null,
    lastModel: null,
    lastModelSource: null,
    lastProviderSource: null,
    lastServiceTierSource: null,
    updateSequence: 0,
    pendingClassification: [],
    open: null,
    defaultDir: meta?.cwd ?? null,
    provider,
    agentPath: meta?.agentPath ?? null,
    opening: { openedAt, sessionId: openingSessionId },
  };
}

function discardCodexTurn(state: CodexSessionParserState): void {
  if (state.open) {
    state.contexts.delete(state.open.promptId);
  }
  state.open = null;
  state.pendingExec.clear();
  state.updateById.clear();
  state.updateByText.clear();
  state.commentaryPair = null;
  state.answerById.clear();
}

function retainCodexUsageKeys(state: CodexSessionParserState, keep: Set<string>): void {
  const usage = state.usageState;
  const prune = <T>(record: Record<string, T>): void => {
    for (const id of Object.keys(record)) {
      if (!keep.has(id)) {
        delete record[id];
      }
    }
  };
  prune(usage.copiedTurnIds);
  prune(usage.datedCopiedTurnIds);
  prune(usage.countedTurnIds);
  prune(usage.turnModels);
  prune(usage.turnEfforts);
  prune(usage.turnWindows);
  prune(usage.pendingOwnership);
  if (state.pendingReportedModels) prune(state.pendingReportedModels);
  prune(usage.pendingRequests);
  const pendingRequestKeys = new Set<string>();
  for (const events of Object.values(usage.pendingRequests)) {
    for (const event of events) {
      pendingRequestKeys.add(event.requestKey);
    }
  }
  for (const key of Object.keys(usage.pendingRequestSources)) {
    if (!pendingRequestKeys.has(key)) {
      delete usage.pendingRequestSources[key];
    }
  }
}

function compactCodexAssociations(state: CodexSessionParserState, maxTurns: number): void {
  const limit = Math.max(0, Math.floor(maxTurns));
  const liveSteps = new Set<TurnStep>();
  const liveAgents = new Set<TurnAgent>();
  for (const turn of [...state.turns, ...(state.open ? [state.open] : [])]) {
    for (const step of turn.steps) {
      liveSteps.add(step);
    }
    for (const agent of turn.agents) {
      liveAgents.add(agent);
    }
  }
  for (const pending of state.pendingExec.values()) {
    liveSteps.add(pending.step);
  }
  for (const [id, step] of state.stepById) {
    if (!liveSteps.has(step)) {
      state.stepById.delete(id);
    }
  }
  for (const [id, agent] of state.launched) {
    if (!liveAgents.has(agent)) {
      state.launched.delete(id);
      state.currentSpawns.delete(id);
    }
  }
  for (const [name, agent] of state.byName) {
    if (!liveAgents.has(agent)) {
      state.byName.delete(name);
    }
  }
  for (const id of state.toolNames.keys()) {
    if (!state.stepById.has(id) && !state.launched.has(id)) {
      state.toolNames.delete(id);
    }
  }

  const openId = state.open?.promptId ?? null;
  const orphanContexts = [...state.contexts.keys()].filter((id) => id !== openId);
  for (const id of orphanContexts.slice(0, Math.max(0, orphanContexts.length - limit))) {
    state.contexts.delete(id);
  }

  const keep = new Set<string>(state.turns.map((turn) => turn.promptId).filter(Boolean));
  for (const id of state.pendingClassification) {
    if (id) {
      keep.add(id);
    }
  }
  if (openId) {
    keep.add(openId);
  }
  if (state.usageState.currentTurnId) {
    keep.add(state.usageState.currentTurnId);
  }
  for (const id of state.contexts.keys()) {
    keep.add(id);
  }
  retainCodexUsageKeys(state, keep);
}

function removeLatestPendingClassification(state: CodexSessionParserState, id: string): boolean {
  const index = state.pendingClassification.lastIndexOf(id);
  if (index < 0) {
    return false;
  }
  state.pendingClassification.splice(index, 1);
  return true;
}

function latestCodexTurnIndex(state: CodexSessionParserState, id: string): number {
  for (let index = state.turns.length - 1; index >= 0; index--) {
    if (state.turns[index].promptId === id) {
      return index;
    }
  }
  return -1;
}

function retractPendingCodexTurn(state: CodexSessionParserState, id: string): boolean {
  if (!removeLatestPendingClassification(state, id)) {
    return false;
  }
  const index = latestCodexTurnIndex(state, id);
  if (index >= 0) {
    state.turns.splice(index, 1);
    state.turnRanges.splice(index, 1);
    state.turnMembershipStarts.splice(index, 1);
  }
  return true;
}

function retractCopiedCodexCompactions(state: CodexSessionParserState, id: string): void {
  const removed = new Set<number>();
  const kept = state.compactions
    .map((compaction, index) => ({ compaction, index }))
    .filter(({ index }) => {
      if (state.compactionTurnIds[index] !== id) {
        return true;
      }
      removed.add(index);
      return false;
    });
  if (!removed.size) {
    return;
  }
  const latestWasRemoved = removed.has(state.compactions.length - 1);
  state.compactions = kept.map(({ compaction }) => compaction);
  state.compactionRanges = kept.map(({ index }) => state.compactionRanges[index]);
  state.compactionTurnIds = kept.map(({ index }) => state.compactionTurnIds[index]);
  state.compactionValueSources = kept.map(({ index }) => state.compactionValueSources[index]);
  if (latestWasRemoved) {
    state.pendingCompactionBilling = null;
  }
}

function boundCodexTurns(state: CodexSessionParserState, maxTurns: number): void {
  const limit = Math.max(0, Math.floor(maxTurns));
  if (state.pendingClassification.length > limit) {
    state.pendingClassification.splice(0, state.pendingClassification.length - limit);
  }

  // A turn id can recur, so pending classifications are occurrences rather than a Set.
  // Match each entry to the newest retained occurrence with that id. Older occurrences
  // have crossed the delayed-classification horizon and count as ordinary turns.
  const remainingById = new Map<string, number>();
  for (const id of state.pendingClassification) {
    remainingById.set(id, (remainingById.get(id) ?? 0) + 1);
  }
  const pendingIndexes = new Set<number>();
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const id = state.turns[index].promptId;
    const remaining = remainingById.get(id) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    pendingIndexes.add(index);
    remainingById.set(id, remaining - 1);
  }

  const knownIndexes: number[] = [];
  for (let index = 0; index < state.turns.length; index++) {
    if (!pendingIndexes.has(index)) {
      knownIndexes.push(index);
    }
  }
  const remove = new Set(knownIndexes.slice(0, Math.max(0, knownIndexes.length - limit)));
  if (remove.size) {
    for (const index of remove) {
      const start = state.turnMembershipStarts[index] ?? state.turnRanges[index]?.start;
      if (start !== undefined && (state.turnLimitStart === null || start > state.turnLimitStart)) {
        state.turnLimitStart = start;
      }
    }
    state.turns = state.turns.filter((_turn, index) => !remove.has(index));
    state.turnRanges = state.turnRanges.filter((_range, index) => !remove.has(index));
    state.turnMembershipStarts = state.turnMembershipStarts.filter((_start, index) => !remove.has(index));
    state.turnLimitReached = true;
  }
  if (state.compactions.length > limit) {
    const count = state.compactions.length - limit;
    state.compactions.splice(0, count);
    state.compactionRanges.splice(0, count);
    state.compactionTurnIds.splice(0, count);
    state.compactionValueSources.splice(0, count);
  }
  compactCodexAssociations(state, maxTurns);
}

function trimCodexBefore(state: CodexSessionParserState, offset: number, maxTurns: number): boolean {
  pruneCodexReplayLedger(state.usageState, offset);
  const resetRequired = state.usageState.replayResetRequired;
  if (state.turnLimitStart !== null && state.turnLimitStart < offset) {
    state.turnLimitReached = false;
    state.turnLimitStart = null;
  }
  if (state.lastContextSource && state.lastContextSource.start < offset) {
    state.lastContext = 0;
    state.lastContextSource = null;
  }
  if (state.lastModelSource && state.lastModelSource.start < offset) {
    state.lastModel = null;
    state.lastModelSource = null;
  }
  if (state.lastProviderSource && state.lastProviderSource.start < offset) {
    state.lastProviderSource = null;
  }
  if (state.lastServiceTierSource && state.lastServiceTierSource.start < offset) {
    state.lastServiceTierSource = null;
  }
  const pendingBilling = state.pendingCompactionBilling;
  if (pendingBilling) {
    if (pendingBilling.modelSource && pendingBilling.modelSource.start < offset) {
      pendingBilling.model = null;
      pendingBilling.modelSource = null;
    }
    if (pendingBilling.providerSource && pendingBilling.providerSource.start < offset) {
      pendingBilling.provider = null;
      pendingBilling.providerSource = null;
    }
    if (pendingBilling.serviceTierSource && pendingBilling.serviceTierSource.start < offset) {
      pendingBilling.serviceTier = null;
      pendingBilling.serviceTierSource = null;
    }
  }
  const remainingById = new Map<string, number>();
  for (const id of state.pendingClassification) {
    remainingById.set(id, (remainingById.get(id) ?? 0) + 1);
  }
  const pendingIndexes = new Set<number>();
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const id = state.turns[index].promptId;
    const remaining = remainingById.get(id) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    pendingIndexes.add(index);
    remainingById.set(id, remaining - 1);
  }
  const retained = state.turns
    .map((turn, index) => ({
      turn,
      range: state.turnRanges[index],
      membershipStart: state.turnMembershipStarts[index] ?? state.turnRanges[index].start,
      index,
    }))
    .filter(({ membershipStart }) => membershipStart >= offset);
  const straddlesTurnDependency = retained.some(
    ({ range, membershipStart }) => range.start < offset && membershipStart >= offset,
  );
  state.turns = retained.map(({ turn }) => turn);
  state.turnRanges = retained.map(({ range }) => range);
  state.turnMembershipStarts = retained.map(({ membershipStart }) => membershipStart);
  state.pendingClassification = retained
    .filter(({ index }) => pendingIndexes.has(index))
    .map(({ turn }) => turn.promptId)
    .filter(Boolean);
  const compactions = state.compactions
    .map((compaction, index) => ({
      compaction,
      range: state.compactionRanges[index],
      turnId: state.compactionTurnIds[index] ?? null,
      valueSources: state.compactionValueSources[index] ?? { context: null, model: null },
    }))
    .filter(({ range }) => range.start >= offset);
  for (const { compaction, valueSources } of compactions) {
    if (valueSources.context && valueSources.context.start < offset) {
      compaction.contextBefore = 0;
      valueSources.context = null;
    }
    if (valueSources.model && valueSources.model.start < offset) {
      compaction.model = null;
      valueSources.model = null;
    }
  }
  state.compactions = compactions.map(({ compaction }) => compaction);
  state.compactionRanges = compactions.map(({ range }) => range);
  state.compactionTurnIds = compactions.map(({ turnId }) => turnId);
  state.compactionValueSources = compactions.map(({ valueSources }) => valueSources);
  for (const [id, context] of state.contexts) {
    if (context.start < offset) {
      state.contexts.delete(id);
    }
  }
  boundCodexTurns(state, maxTurns);
  return resetRequired || straddlesTurnDependency;
}

function settleCodexClassifications(state: CodexSessionParserState, maxTurns: number): void {
  state.pendingClassification = [];
  boundCodexTurns(state, maxTurns);
}

function closeCodexTurn(state: CodexSessionParserState, maxTurns: number, at = 0): void {
  const open = state.open;
  if (!open) {
    boundCodexTurns(state, maxTurns);
    return;
  }
  if (!worthDrawing(open)) {
    discardCodexTurn(state);
    boundCodexTurns(state, maxTurns);
    return;
  }
  const context = state.contexts.get(open.promptId);
  const classified = context !== undefined;
  if (context) {
    open.model = context.model;
    open.effort = context.effort;
    extendCodexSourceRange(open, context.start, context.end);
    state.contexts.delete(open.promptId);
  }
  open.endedAt = Math.max(open.endedAt, at);
  for (const row of open.agents) {
    if (row.status === 'running') {
      row.status = LAUNCHED;
    }
  }
  const closingAgents = new Set(open.agents);
  for (const id of state.currentSpawns) {
    if (closingAgents.has(state.launched.get(id)!)) {
      state.currentSpawns.delete(id);
    }
  }
  const { files, fileChanges: _fileChanges, ...turn } = open;
  state.turns.push({ ...turn, files: [...files.values()] });
  const range = { start: open[CODEX_SOURCE_START] ?? 0, end: open[CODEX_SOURCE_END] ?? 0 };
  state.turnRanges.push(range);
  state.turnMembershipStarts.push(open[CODEX_MEMBERSHIP_START] ?? range.start);
  if (!classified) {
    state.pendingClassification.push(open.promptId);
  }
  state.open = null;
  state.pendingExec.clear();
  state.updateById.clear();
  state.updateByText.clear();
  state.commentaryPair = null;
  state.answerById.clear();
  boundCodexTurns(state, maxTurns);
}

function codexRequestFollowsLatestCompaction(
  state: CodexSessionParserState,
  event: UsageEvent,
  source: { start: number; end: number } | null,
): boolean {
  const compactionIndex = state.compactions.length - 1;
  const compaction = state.compactions[compactionIndex] ?? null;
  if (!compaction) {
    return true;
  }
  const compactionRange = state.compactionRanges[compactionIndex] ?? null;
  if (source && compactionRange && compactionRange.end > compactionRange.start) {
    return source.start >= compactionRange.end;
  }
  return event.timestamp > compaction.at;
}

function latestPendingCodexContext(
  state: CodexSessionParserState,
): { event: UsageEvent; source: { start: number; end: number } | null } | null {
  let latest: { event: UsageEvent; source: { start: number; end: number } | null } | null = null;
  for (const events of Object.values(state.usageState.pendingRequests)) {
    for (const event of events) {
      if (event.agent !== 'codex') continue;
      const source = state.usageState.pendingRequestSources[event.requestKey] ?? null;
      if (!codexRequestFollowsLatestCompaction(state, event, source)) {
        continue;
      }
      if (
        !latest ||
        (source && latest.source ? source.start >= latest.source.start : event.timestamp >= latest.event.timestamp)
      ) {
        latest = { event, source };
      }
    }
  }
  return latest;
}

function addCodexRequest(
  state: CodexSessionParserState,
  turn: Building | Turn,
  event: UsageEvent,
  source: { start: number; end: number },
  modelSource?: { start: number; end: number } | null,
  turnStart = source.start,
): void {
  const hasCompactionUsage = turn.usageParts?.some((part) => part.compactionUsage) === true;
  if (event.compactionUsage) {
    if ((turn.usage.requests ?? 0) > 0 || hasCompactionUsage) addTurnUsagePart(turn, event);
    return;
  }
  if ((turn.usage.requests ?? 0) === 0 && (event.usage.requests ?? 0) > 0 && !hasCompactionUsage) {
    for (const compaction of state.usageState.recentRequestEvents) {
      if (compaction.compactionUsage && compaction.visibleTurnId === `codex-turn:${turn.promptId}`)
        addTurnUsagePart(turn, compaction);
    }
  }
  addUsage(turn.usage, event.usage, event.contextBand);
  addTurnUsagePart(turn, event);
  const contextTokens = event.usage.input + event.usage.cacheRead + (event.usage.cacheWrite30m ?? 0);
  const compactionIndex = state.compactions.length - 1;
  const compaction = state.compactions[compactionIndex] ?? null;
  const requestAfterCompaction = codexRequestFollowsLatestCompaction(state, event, source);
  // A delayed turn_context can release usage from a request written before compaction.
  // Keep that usage on its historical turn, but do not let it become the current level.
  // A turn that continued past the boundary also cannot use that earlier request as its
  // end level.
  if (requestAfterCompaction || (compaction && state.open !== turn && turn.endedAt < compaction.at)) {
    turn.contextTokens = contextTokens;
    // Store the request behind the context level with the lifetime its model's pricing row defines.
    // A recorded cache write updates `lastLifetime`. An unknown lifetime remains null.
    // Model precedence is request, turn context, then the last recorded model.
    const requestModel = event.model ?? state.contexts.get(turn.promptId)?.model ?? state.lastModel;
    const lifetime = cacheLifetimeFor(requestModel, state.provider);
    const wrote = event.usage.cacheWrite30m ? lifetime : null;
    if (wrote) {
      state.lastLifetime = wrote;
    }
    turn.contextRequest = {
      at: event.timestamp,
      lifetime: lifetime === null ? null : (wrote ?? (state.lastLifetime === lifetime ? state.lastLifetime : lifetime)),
      inferenceClass: event.inferenceClass,
      serviceTier: event.serviceTier,
      readBack: event.usage.cacheRead > 0,
      outputTokens: event.usage.output,
    };
  }
  turn.contextWindow = event.contextWindow ?? turn.contextWindow;
  if (requestAfterCompaction) {
    state.lastContext = contextTokens;
    state.lastContextSource = { start: Math.min(turnStart, source.start), end: source.end };
  }
  const context = state.contexts.get(turn.promptId);
  if (event.model !== null) {
    state.lastModel = event.model;
    const modelDependency = modelSource ?? source;
    state.lastModelSource = {
      start: Math.min(turnStart, modelDependency.start),
      end: Math.max(source.end, modelDependency.end),
    };
  } else if (context?.model) {
    state.lastModel = context.model;
    state.lastModelSource = { start: context.start, end: context.end };
  }
}

function reduceCodexSessionLine(
  state: CodexSessionParserState,
  input: string | ParserLine,
  sessionId: string,
  opts: CodexReadOptions,
): void {
  const line = typeof input === 'string' ? input : input.text;
  const sourceStart = typeof input === 'string' ? 0 : (input.start ?? 0);
  const sourceEnd = typeof input === 'string' ? sourceStart : (input.end ?? sourceStart);
  const hasSourceOffset = typeof input !== 'string' && input.start !== undefined;
  if (line.length < 20 || !carriesRecord(line)) {
    return;
  }
  const record = parseRecord(line);
  if (!record) {
    return;
  }
  const { kind, at, payload } = record;
  const displaySequence = (state.reportedModelSequence ?? 0) + 1;
  state.reportedModelSequence = displaySequence;
  const displaySource = hasSourceOffset
    ? { start: sourceStart, end: sourceEnd }
    : { start: displaySequence, end: displaySequence };
  const ownershipId = kind === 'token_usage_record' ? str(payload.turn_id) : null;
  const ownershipPending = ownershipId !== null && state.usageState.pendingOwnership[ownershipId];
  const usageEvents = [
    ...reduceCodexUsageEvents(state.usageState, {
      kind,
      timestamp: at,
      payload,
      sourceStart: hasSourceOffset ? sourceStart : undefined,
      sourceEnd: hasSourceOffset ? sourceEnd : undefined,
    }),
  ];
  const rateTurn = state.open;
  const rateModel = state.usageState.currentTurnId
    ? (state.usageState.turnModels[state.usageState.currentTurnId] ?? state.lastModel)
    : null;
  if (rateTurn && state.responseClock.model && rateModel !== state.responseClock.model) {
    delete rateTurn.outputRate;
    delete rateTurn.outputRateModel;
    state.responseClock.rates = [];
  }
  const responseRate = reduceCodexResponseClock(state.responseClock, record, {
    sessionId: state.usageState.openingSessionId,
    turnId: state.usageState.currentTurnId,
    model: rateModel,
    eligible:
      !state.usageState.foreignSessionMeta &&
      !state.usageState.currentTurnCopied &&
      !state.usageState.currentTurnRepeated,
  });
  if (rateTurn && kind === 'turn_aborted') {
    delete rateTurn.outputRate;
    delete rateTurn.outputRateModel;
  }
  if (rateTurn && (responseRate || kind === 'compacted')) {
    delete rateTurn.outputRateModel;
    if (!state.responseClock.rates.length) delete rateTurn.outputRate;
    else {
      const model = state.responseClock.rates[0].model;
      if (model && model.length <= 512 && state.responseClock.rates.every((rate) => rate.model === model))
        rateTurn.outputRateModel = model;
      rateTurn.outputRate = state.responseClock.rates.reduce(
        (total, rate) => ({ output: total.output + rate.output, milliseconds: total.milliseconds + rate.milliseconds }),
        { output: 0, milliseconds: 0 },
      );
    }
  }
  synchronizeIdentityQueue(
    state.usageState.pendingRequestKeys,
    Object.values(state.usageState.pendingRequests).flatMap((events) => events.map((event) => event.requestKey)),
  );
  while (state.usageState.pendingRequestKeys.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const released = releasePendingRequest(state.usageState, state.usageState.pendingRequestKeys[0]);
    if (released) usageEvents.push({ ...released, incomplete: true });
  }
  const currentSource = { start: sourceStart, end: sourceEnd };
  const usageSources = new Map(
    usageEvents.map((event) => [
      event.requestKey,
      state.usageState.pendingRequestSources[event.requestKey] ?? currentSource,
    ]),
  );
  const releaseUsageSources = (): void => {
    for (const event of usageEvents) {
      delete state.usageState.pendingRequestSources[event.requestKey];
    }
  };
  if (kind === 'compacted' || kind === 'thread_settings_applied') {
    for (const event of usageEvents) {
      const id = event.visibleTurnId?.replace(/^codex-turn:/, '');
      const turn = state.open?.promptId === id ? state.open : state.turns[latestCodexTurnIndex(state, id ?? '')];
      if (turn) addCodexRequest(state, turn, event, usageSources.get(event.requestKey) ?? currentSource);
    }
  }

  if (kind === 'token_usage_record') {
    if (ownershipId && ownershipPending && !state.usageState.pendingOwnership[ownershipId]) {
      const context = state.pendingReportedModels?.[ownershipId];
      if (context && (!state.lastReportedModelSource || context.start >= state.lastReportedModelSource.start)) {
        state.lastReportedModel = context.model;
        state.lastReportedModelSource = { start: context.start, end: context.end };
      }
      if (state.pendingReportedModels) delete state.pendingReportedModels[ownershipId];
    }
    for (const event of usageEvents) {
      if (event.agent !== 'codex') continue;
      const id = event.visibleTurnId?.replace(/^codex-turn:/, '');
      const turn = state.open?.promptId === id ? state.open : state.turns[latestCodexTurnIndex(state, id ?? '')];
      if (turn) addCodexRequest(state, turn, event, usageSources.get(event.requestKey) ?? currentSource);
    }
    releaseUsageSources();
    boundCodexTurns(state, opts.maxTurns ?? 40);
    return;
  }

  if (state.usageState.currentTurnRepeated && state.usageState.nativeSpawnedAt !== null && kind !== 'task_started')
    return;

  // Read the skill catalog before requiring an open turn. Catalog publication can precede the first turn.
  if (kind === 'message' && str(payload.role) === 'developer') {
    const published = blocksText(payload.content);
    if (published.trimStart().startsWith(CODEX_SKILL_CATALOG)) {
      state.skillCatalog = codexSkillCatalog(published);
      return;
    }
  }

  if (kind === 'task_started') {
    // A turn still open when the next one starts is a turn whose close was never
    // written, so it is emitted rather than dropped.
    state.pendingCompactionBilling = null;
    closeCodexTurn(state, opts.maxTurns ?? 40);
    if (
      state.usageState.currentTurnCopied &&
      !(
        !state.usageState.currentTurnRepeated &&
        state.usageState.currentTurnId &&
        state.usageState.pendingOwnership[state.usageState.currentTurnId]
      )
    ) {
      return;
    }
    const turn = newTurn(
      sessionId,
      str(payload.turn_id) ?? '',
      at,
      num(payload.model_context_window),
      state.provider,
    ) as SourcedBuilding;
    setCodexSourceRange(turn, sourceStart, sourceEnd);
    setCodexMembershipStart(turn, sourceStart);
    state.open = turn;
    state.updateSequence = 0;
    return;
  }

  if (kind === 'turn_context') {
    const id = str(payload.turn_id);
    let classifiedAfterHorizon = -1;
    if (id && state.usageState.datedCopiedTurnIds[id]) {
      retractCopiedCodexCompactions(state, id);
      if (state.open && id === state.open.promptId) {
        discardCodexTurn(state);
        delete state.usageState.datedCopiedTurnIds[id];
        boundCodexTurns(state, opts.maxTurns ?? 40);
        return;
      }
      if (retractPendingCodexTurn(state, id)) {
        delete state.usageState.datedCopiedTurnIds[id];
        boundCodexTurns(state, opts.maxTurns ?? 40);
        return;
      }
      classifiedAfterHorizon = latestCodexTurnIndex(state, id);
      if (classifiedAfterHorizon < 0) {
        state.contexts.set(id, {
          model: str(payload.model),
          effort: str(payload.effort),
          start: sourceStart,
          end: sourceEnd,
        });
        boundCodexTurns(state, opts.maxTurns ?? 40);
        return;
      }
      delete state.usageState.datedCopiedTurnIds[id];
      delete state.usageState.copiedTurnIds[id];
      if (state.usageState.currentTurnId === id) {
        state.usageState.currentTurnCopied = false;
      }
      if (!state.usageState.countedTurnIds[id] && state.usageState.currentTurnId !== id) {
        state.usageState.countedTurnIds[id] = true;
        state.usageState.closedTurns++;
      }
    }
    if (
      id &&
      state.usageState.currentTurnCopied &&
      id === state.usageState.currentTurnId &&
      !state.usageState.pendingOwnership[id]
    ) {
      if (state.open && id === state.open.promptId) {
        discardCodexTurn(state);
      } else {
        retractPendingCodexTurn(state, id);
      }
      boundCodexTurns(state, opts.maxTurns ?? 40);
      return;
    }
    if (id) {
      const context = {
        model: str(payload.model),
        effort: str(payload.effort),
        start: sourceStart,
        end: sourceEnd,
      };
      if (context.model) {
        state.lastModel = context.model;
        state.lastModelSource = { start: sourceStart, end: sourceEnd };
        if (state.usageState.pendingOwnership[id] && !state.usageState.foreignSessionMeta) {
          (state.pendingReportedModels ??= {})[id] = { model: context.model, ...displaySource };
        }
        if (
          !state.usageState.currentTurnCopied &&
          !state.usageState.foreignSessionMeta &&
          !state.usageState.pendingOwnership[id]
        ) {
          state.lastReportedModel = context.model;
          state.lastReportedModelSource = displaySource;
        }
      }
      const pending = removeLatestPendingClassification(state, id);
      const closedIndex = pending ? latestCodexTurnIndex(state, id) : classifiedAfterHorizon;
      if (closedIndex >= 0) {
        const closed = state.turns[closedIndex];
        closed.model = context.model;
        closed.effort = context.effort;
        const range = state.turnRanges[closedIndex];
        if (range) {
          range.start = Math.min(range.start, sourceStart);
          range.end = Math.max(range.end, sourceEnd);
        }
        for (const event of usageEvents) {
          addCodexRequest(
            state,
            closed,
            event,
            usageSources.get(event.requestKey) ?? currentSource,
            context,
            range?.start,
          );
        }
      } else {
        state.contexts.set(id, context);
      }
      boundCodexTurns(state, opts.maxTurns ?? 40);
    }
    if (state.open && id === state.open.promptId) {
      extendCodexSourceRange(state.open, sourceStart, sourceEnd);
      for (const event of usageEvents) {
        addCodexRequest(
          state,
          state.open,
          event,
          usageSources.get(event.requestKey) ?? currentSource,
          {
            start: sourceStart,
            end: sourceEnd,
          },
          state.open[CODEX_SOURCE_START],
        );
      }
    }
    releaseUsageSources();
    return;
  }

  if (kind === 'thread_settings_applied') {
    const settings = isRecord(payload.thread_settings) ? payload.thread_settings : {};
    const model = str(settings.model) ?? str(settings.model_id) ?? (settings.model === '' ? '' : null);
    const provider = str(settings.model_provider_id);
    const serviceTier = str(settings.service_tier);
    if (model) {
      state.lastModel = model;
      state.lastModelSource = { start: sourceStart, end: sourceEnd };
      if (!state.usageState.currentTurnCopied && !state.usageState.foreignSessionMeta) {
        state.lastReportedModel = model;
        state.lastReportedModelSource = displaySource;
      }
    }
    if (provider) {
      state.lastProviderSource = { start: sourceStart, end: sourceEnd };
    }
    if (serviceTier) {
      state.lastServiceTierSource = { start: sourceStart, end: sourceEnd };
    }
    const pendingBilling = state.pendingCompactionBilling;
    if (pendingBilling) {
      const index = state.compactions.length - 1;
      const compaction = state.compactions[index];
      if (compaction?.at === pendingBilling.at) {
        compaction.model = model ?? pendingBilling.model;
        compaction.provider = provider ?? pendingBilling.provider;
        compaction.serviceTier = serviceTier ?? pendingBilling.serviceTier;
        if (compaction.model) {
          state.compactionValueSources[index].model = { start: sourceStart, end: sourceEnd };
        }
        compaction.inferenceClass =
          compaction.provider === 'amazon-bedrock' ? bedrockInferenceClass(compaction.model) : null;
      }
      state.pendingCompactionBilling = null;
    }
  }

  if (
    state.usageState.currentTurnCopied &&
    !(state.usageState.currentTurnId && state.usageState.pendingOwnership[state.usageState.currentTurnId])
  ) {
    return;
  }

  if (kind === 'compacted') {
    // Replacement history can include opaque summaries. The card reports the compaction
    // without treating encrypted content as readable summary text.
    const exactUsage = codexRequestUsage(
      isRecord(payload.latest_token_usage_record) ? payload.latest_token_usage_record.usage : null,
    );
    const pendingContext = latestPendingCodexContext(state);
    const contextBefore = exactUsage
      ? requestInputTokens(exactUsage)
      : pendingContext
        ? pendingContext.event.usage.input +
          pendingContext.event.usage.cacheRead +
          (pendingContext.event.usage.cacheWrite30m ?? 0)
        : state.lastContext;
    const provider = state.usageState.provider ?? state.provider;
    const model = state.lastModel;
    const turnId = state.usageState.currentTurnId;
    const contextWindow = turnId ? (state.usageState.turnWindows[turnId] ?? null) : null;
    state.compactions.push({
      sessionId,
      at,
      contextBefore,
      contextAfter: 0,
      droppedTokens: 0,
      durationMs: 0,
      trigger: codexCompactionTrigger(
        state.usageState.currentTurnId !== null,
        state.usageState.currentTurnCopied,
        state.usageState.currentTurnDidSomething,
      ),
      model: exactUsage ? null : model,
      summary: '',
      ...((str(payload.compaction_response_id) ??
      (isRecord(payload.latest_token_usage_record) ? str(payload.latest_token_usage_record.response_id) : null))
        ? {
            responseId: (str(payload.compaction_response_id) ??
              str((payload.latest_token_usage_record as Record<string, unknown>).response_id))!,
          }
        : {}),
      ...(exactUsage
        ? {
            usage: exactUsage,
            provider: null,
            contextWindow,
            inferenceClass: null,
            serviceTier: null,
          }
        : {}),
    });
    state.compactionRanges.push({ start: sourceStart, end: sourceEnd });
    state.compactionTurnIds.push(state.usageState.currentTurnId);
    state.compactionValueSources.push({
      context: exactUsage
        ? { start: sourceStart, end: sourceEnd }
        : pendingContext?.source
          ? { ...pendingContext.source }
          : state.lastContextSource
            ? { ...state.lastContextSource }
            : null,
      model: state.lastModelSource ? { ...state.lastModelSource } : null,
    });
    state.pendingCompactionBilling = exactUsage
      ? {
          at,
          model,
          modelSource: state.lastModelSource ? { ...state.lastModelSource } : null,
          provider,
          providerSource: state.lastProviderSource ? { ...state.lastProviderSource } : null,
          serviceTier: state.usageState.serviceTier,
          serviceTierSource: state.lastServiceTierSource ? { ...state.lastServiceTierSource } : null,
        }
      : null;
    // A later retained-context estimate or request supplies the replacement's size.
    // Clear the preceding level until that measurement arrives.
    state.lastContext = 0;
    state.lastContextSource = null;
    if (state.open) {
      state.open.contextTokens = 0;
      // Clear the request together with the context level it described.
      state.open.contextRequest = undefined;
    }
    boundCodexTurns(state, opts.maxTurns ?? 40);
    return;
  }

  if (kind === 'token_count') {
    const info = isRecord(payload.info) ? payload.info : null;
    const retained = codexRetainedContextTokens(info?.last_token_usage);
    const compaction = state.compactions.at(-1);
    if (retained !== null && compaction && at >= compaction.at) {
      const window = num(info?.model_context_window);
      compaction.retainedContext = { tokens: retained, window: window !== null && window > 0 ? window : null };
      state.lastContext = retained;
      state.lastContextSource = currentSource;
      if (state.open) {
        extendCodexSourceRange(state.open, sourceStart, sourceEnd);
        state.open.contextTokens = retained;
        state.open.contextWindow = window ?? state.open.contextWindow;
        state.open.contextRequest = undefined;
        state.open.endedAt = Math.max(state.open.endedAt, at);
      }
      releaseUsageSources();
      return;
    }
  }

  if (kind === 'task_complete' || kind === 'turn_aborted') {
    state.pendingCompactionBilling = null;
  }
  if (!state.open) {
    releaseUsageSources();
    return;
  } // No open turn exists in this window to receive the record.
  const turn = state.open;
  extendCodexSourceRange(turn, sourceStart, sourceEnd);

  switch (kind) {
    case 'task_complete': {
      // Preserve the recorded answer's exact text when the completion summary differs only in whitespace.
      // `responseAnswerIndex` needs exact equality to exclude the response from earlier answers.
      // A different completion message keeps its own text.
      const rawSummary = answerInTaskComplete(record);
      const lastAnswer = turn.answers[turn.answers.length - 1];
      turn.summary =
        lastAnswer && stripWhitespace(lastAnswer.text) === stripWhitespace(rawSummary) ? lastAnswer.text : rawSummary;
      // Extract a failed completion's error message from its object payload.
      const failed = str((payload.error as { message?: unknown } | undefined)?.message);
      turn.error = failedCodexTurn(record) && failed ? errorMessage(failed) : null;
      turn.finished = finishedCodexTurn(record);
      closeCodexTurn(state, opts.maxTurns ?? 40, at);
      break;
    }
    case 'turn_aborted': {
      turn.interrupted = interruptedCodexTurn(record);
      turn.finished = false;
      // Without a completion summary, use the last recorded answer as the response.
      // `responseAnswerIndex` then excludes that answer from Activity.
      const lastAnswer = turn.answers[turn.answers.length - 1];
      if (!turn.summary && lastAnswer) {
        turn.summary = lastAnswer.text;
      }
      closeCodexTurn(state, opts.maxTurns ?? 40, at);
      break;
    }
    case 'user_message':
    case 'message': {
      const notification = subagentNotification(record);
      if (notification) {
        const row = turn.agents.find((agent) => agent.id === notification.id);
        if (row) {
          finishSpawn(state, row, notification.status);
        }
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      // The first prompt opens the turn. Preserve later prompts with their timestamps as follow-up messages.
      const raw = userMessage(record);
      if (raw !== null) {
        state.commentaryPair = null;
        const asked = codexPrompt(raw, opts.captureSessionText);
        if (!codexPrompt(raw)) {
          break;
        }
        if (!turn.prompt) {
          turn.prompt = asked;
          break;
        }
        turn.laterPrompts.push({ text: asked, at, stepsBefore: turn.stepCount });
        if (!opts.captureSessionText && turn.laterPrompts.length > TURN_ASK_LIMIT) {
          turn.laterPrompts.shift();
        }
        break;
      }
      const update = parsedUpdate(payload, opts.captureSessionText, record.wrapper);
      if (update) {
        recordUpdate(turn, state, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload, opts.captureSessionText);
      if (answer) {
        recordAnswer(turn, state.answerById, answer, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      break;
    }
    case 'token_count': {
      const context = state.contexts.get(turn.promptId);
      for (const event of usageEvents) {
        addCodexRequest(
          state,
          turn,
          event,
          usageSources.get(event.requestKey) ?? currentSource,
          context?.model ? { start: context.start, end: context.end } : null,
          turn[CODEX_SOURCE_START],
        );
      }
      releaseUsageSources();
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    case 'patch_apply_end': {
      turn.endedAt = Math.max(turn.endedAt, at);
      if (payload.success === false) {
        const message = firstLine(String(payload.stderr || payload.stdout || ''));
        turn.failures.push({ tool: 'apply_patch', message });
        const paths = codexChangePaths(payload.changes);
        const presented = presentedStepDetail('apply_patch', { paths });
        recordStep(turn, state.stepById, 'apply_patch', presented.detail, at, '', 'failed', {
          capture: opts.captureSessionText,
          ...(presented.fullDetail !== undefined ? { fullDetail: presented.fullDetail } : {}),
        });
        break;
      }
      recordChanges(turn, (payload.changes || {}) as Record<string, unknown>);
      const paths = codexChangePaths(payload.changes);
      const presented = presentedStepDetail('apply_patch', { paths });
      recordStep(turn, state.stepById, 'apply_patch', presented.detail, at, '', 'done', {
        capture: opts.captureSessionText,
        ...(presented.fullDetail !== undefined ? { fullDetail: presented.fullDetail } : {}),
      });
      break;
    }
    case 'custom_tool_call':
    case 'function_call': {
      const recordedName = str(payload.name) ?? '';
      const name = recordedName === 'exec' ? (nestedToolName(payload.input) ?? recordedName) : recordedName;
      const id = str(payload.call_id);
      turn.toolUses++;
      turn.toolCounts[TOOL_KIND[name] ?? 'other']++;
      if (name) {
        tallyToolName(turn.toolTally, name);
      }
      if (id && name) {
        state.toolNames.set(id, name);
      }
      const command = recordedName === 'exec' ? wrappedCommand(payload.input) : null;
      const detail = command
        ? { detail: stepDetail({ command }), fullDetail: command }
        : callDetail(name, payload.arguments ?? payload.input);
      const step = name
        ? recordStep(turn, state.stepById, name, detail.detail, at, id ?? '', 'running', {
            capture: opts.captureSessionText,
            ...(id ? { sourceId: id } : {}),
            ...(detail.fullDetail !== undefined ? { fullDetail: detail.fullDetail } : {}),
          })
        : null;
      if (recordedName === 'exec' && id && step) {
        state.pendingExec.set(id, { step, expanded: false });
      }
      if (name === 'spawn_agent' && id) {
        const row = recordSpawn(turn, payload, at);
        state.launched.set(id, row);
        if (str(payload.namespace) === 'multi_agent_v1') {
          state.currentSpawns.add(id);
        }
        state.byName.set(row.description, row);
      }
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    case 'item_completed': {
      const dispatchItem = isRecord(payload.item) ? payload.item : null;
      if (dispatchItem?.type === 'CommandExecution' && typeof dispatchItem.stdout === 'string') {
        const commandId = str(dispatchItem.id);
        const launch = claudeLaunchKind(commandText(dispatchItem, true), commandShell(dispatchItem));
        if (
          commandId &&
          launch &&
          launch.kind !== 'native' &&
          shellDispatchFromOutput(dispatchItem.stdout, launch).length > 0 &&
          !(turn.dispatchToolUseIds ?? []).includes(commandId)
        ) {
          (turn.dispatchToolUseIds ??= []).push(commandId);
        }
      }
      const activity = currentSubAgentActivity(payload);
      if (activity) {
        const row = state.launched.get(activity.callId);
        if (row) {
          const previousName = row.description;
          setSpawnIdentity(row, activity.id, activity.description, null);
          if (state.byName.get(previousName) === row) {
            state.byName.delete(previousName);
          }
          state.byName.set(row.description, row);
        }
      }
      const collab = collabSpawnCompletion(payload);
      if (collab) {
        const row = state.launched.get(collab.callId);
        if (row) {
          setSpawnIdentity(row, collab.id, collab.description, collab.model, collab.effort);
          state.currentSpawns.delete(collab.callId);
          const step = state.stepById.get(collab.callId);
          if (step) {
            step.status = 'done';
          }
        }
      }
      const claudeResult = claudeCommandResult(payload);
      if (claudeResult) {
        const commandKey = claudeResult.commandId ?? `source:${sourceStart}`;
        const seen = state.seenClaudeCommands[commandKey];
        const row: TurnAgent = {
          id: claudeResult.sessionId,
          invocationId: claudeResult.invocationId,
          description: 'Claude CLI',
          agentType: 'claude-cli',
          model: null,
          effort: null,
          spend: claudeResult.models,
          spendFound: claudeResult.accepted,
          spendPartial: !claudeResult.accepted,
          durationMs: claudeResult.durationMs,
          tokens: null,
          toolUses: null,
          status: claudeResult.status,
        };
        if (!seen) {
          state.seenClaudeCommands[commandKey] = {
            accepted: claudeResult.accepted,
            invocationId: claudeResult.invocationId,
          };
          turn.agents.push(row);
        } else if (!seen.accepted && claudeResult.accepted) {
          const existing = turn.agents.findIndex((agent) => agent.invocationId === seen.invocationId);
          if (existing >= 0) {
            turn.agents[existing] = row;
          }
          state.seenClaudeCommands[commandKey] = { accepted: true, invocationId: claudeResult.invocationId };
        }
      }
      const fileChange = completedFileChange(payload);
      if (fileChange) {
        if (fileChange.status === 'done') {
          recordChanges(turn, fileChange.changes);
        }
        const candidates = [...state.pendingExec.entries()].filter(([, pending]) => !pending.expanded);
        const patchCandidates = candidates.filter(([, pending]) => pending.step.name === 'apply_patch');
        const matching = patchCandidates.filter(([, pending]) =>
          fileChange.paths.some((path) => (pending.step.fullDetail ?? pending.step.detail).split('\n').includes(path)),
        );
        const picked =
          matching.length === 1
            ? matching[0]
            : patchCandidates.length === 1
              ? patchCandidates[0]
              : candidates.length === 1
                ? candidates[0]
                : null;
        if (!picked) {
          break;
        }
        const [callId, pending] = picked;
        pending.step.name = 'apply_patch';
        turn.stepKinds[pending.step.ordinal - 1] = TOOL_KIND.apply_patch;
        pending.step.detail = fileChange.detail;
        if (fileChange.sourceId) {
          pending.step.sourceId = fileChange.sourceId;
        }
        if (fileChange.fullDetail) {
          setFullDetail(pending.step, fileChange.fullDetail);
        }
        pending.step.at = at;
        setTurnStepStatus(turn, pending.step, fileChange.status);
        pending.expanded = true;
        state.pendingExec.delete(callId);
        state.toolNames.delete(callId);
        state.stepById.delete(callId);
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      const command = completedCommand(payload);
      // Attribute skill reads before pairing the command with an Activity row. Ambiguous row pairing does not block attribution.
      if (command) {
        recordCodexSkillUses(state, turn, command, at);
        const readable = command.cwd !== null;
        const window =
          readable &&
          command.startedAt !== null &&
          command.completedAt !== null &&
          command.startedAt <= command.completedAt
            ? { from: command.startedAt, failed: command.failed }
            : null;
        recordCommits(
          turn,
          command.stdout,
          command.completedAt ?? at,
          readable
            ? { command: command.command, shell: command.shell, cwd: command.cwd, at: command.startedAt ?? at }
            : 'unreadable',
          [],
          null,
          window,
        );
        if (!command.failed) recordCodexCommitRepositories(turn, command.stdout, command.completedAt ?? at);
      }
      if (command && state.pendingExec.size === 1) {
        const pending = state.pendingExec.values().next().value;
        if (!pending) {
          break;
        }
        if (!pending.expanded) {
          pending.step.detail = command.detail;
          if (command.sourceId) {
            pending.step.sourceId = command.sourceId;
          }
          setFullDetail(pending.step, command.fullDetail);
          pending.step.at = at;
          setTurnStepStatus(turn, pending.step, command.status);
          pending.expanded = true;
        } else {
          recordStep(turn, state.stepById, 'exec', command.detail, at, '', command.status, {
            capture: opts.captureSessionText,
            ...(command.sourceId ? { sourceId: command.sourceId } : {}),
            fullDetail: command.fullDetail,
          });
        }
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      const asked = parsedAsyncMessage(payload, opts.captureSessionText);
      if (asked) {
        recordUpdate(turn, state, asked, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      const update = parsedUpdate(payload, opts.captureSessionText, record.wrapper);
      if (update) {
        recordUpdate(turn, state, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload, opts.captureSessionText);
      if (answer) {
        recordAnswer(turn, state.answerById, answer, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      break;
    }
    case 'custom_tool_call_output':
    case 'function_call_output': {
      turn.endedAt = Math.max(turn.endedAt, at);
      const text = outputText(payload.output);
      const callId = str(payload.call_id) ?? '';
      const ran = state.stepById.get(callId);
      const expanded = state.pendingExec.get(callId)?.expanded === true;
      // Outer JavaScript output has no reliable association with one completed command.
      // Keep its commit evidence unresolved rather than assigning a command's repository.
      recordCommits(turn, text, at, 'unreadable');
      const child = state.launched.get(callId);
      const result = spawnResult(text);
      if (child && result) {
        setSpawnIdentity(child, result.id, result.description, null);
        state.currentSpawns.delete(callId);
      }
      const explicitCurrentFailure = state.currentSpawns.has(callId) ? currentSpawnFailure(text) : null;
      const spawnFailure =
        child &&
        !child.id &&
        !child.agentType &&
        !result &&
        (!state.currentSpawns.has(callId) || explicitCurrentFailure)
          ? (explicitCurrentFailure ?? firstLine(text)) || 'The subagent did not start.'
          : null;
      const failed = spawnFailure || scriptFailure(text);
      if (ran && !expanded) {
        setTurnStepStatus(turn, ran, failed ? 'failed' : 'done');
      }
      if (failed) {
        turn.failures.push({ tool: state.toolNames.get(callId) || UNNAMED_TOOL, message: failed });
      }
      if (child && spawnFailure) {
        const index = turn.agents.indexOf(child);
        if (index >= 0) {
          turn.agents.splice(index, 1);
        }
        state.launched.delete(callId);
        state.currentSpawns.delete(callId);
        if (state.byName.get(child.description) === child) {
          state.byName.delete(child.description);
        }
      }
      // A successful file item can arrive after the outer JavaScript call has returned.
      // A failed call cannot own a later successful retry's item, so release it now.
      if (state.pendingExec.get(callId)?.step.name !== 'apply_patch' || failed) {
        state.pendingExec.delete(callId);
        state.toolNames.delete(callId);
        state.stepById.delete(callId);
      }
      break;
    }
    case 'web_search_call': {
      // The model's own search, which it does not call a tool to run. Counted here rather
      // than in the tool table, because nothing it writes carries a tool name.
      turn.toolUses++;
      turn.toolCounts.web++;
      tallyToolName(turn.toolTally, 'web_search');
      const action = isRecord(payload.action) ? payload.action : {};
      const query = str(action.query);
      const queries = Array.isArray(action.queries)
        ? action.queries.filter((one): one is string => typeof one === 'string')
        : [];
      const presented = presentedStepDetail('web_search', query ? { query } : { queries });
      recordStep(turn, state.stepById, 'web_search', presented.detail, at, '', 'done', {
        capture: opts.captureSessionText,
        ...(presented.fullDetail !== undefined ? { fullDetail: presented.fullDetail } : {}),
      });
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    case 'agent_message': {
      const delegation = codexDelegation(record, state.agentPath);
      if (delegation) {
        turn.delegation ??= delegation;
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const update = parsedUpdate(payload, opts.captureSessionText, record.wrapper);
      if (update) {
        recordUpdate(turn, state, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload, opts.captureSessionText);
      if (answer) {
        recordAnswer(turn, state.answerById, answer, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      // Senderless assistant commentary is not a child-answer message.
      if (!finalChildMessage(record)) {
        break;
      }
      const author = str(payload.author) as string;
      const row = state.byName.get(author.slice(author.lastIndexOf('/') + 1));
      if (row) {
        finishSpawn(state, row, 'completed');
      }
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    case 'AgentMessage':
    case 'Reasoning':
    case 'reasoning': {
      const update = parsedUpdate(payload, opts.captureSessionText, record.wrapper);
      if (update) {
        recordUpdate(turn, state, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload, opts.captureSessionText);
      if (answer) {
        recordAnswer(turn, state.answerById, answer, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      break;
    }
    case 'sub_agent_activity': {
      const row = state.launched.get(str(payload.event_id) ?? '');
      if (row) {
        row.status = str(payload.kind) === 'interrupted' ? 'interrupted' : 'running';
        row.id = str(payload.agent_thread_id) ?? row.id;
        row.agentType = str(payload.agent_path) ?? row.agentType;
      }
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    default:
      break;
  }
}

function finishCodexSession(
  state: CodexSessionParserState,
  opts: CodexReadOptions,
  readBytes: number,
): CodexSessionRead {
  const maxTurns = opts.maxTurns ?? 40;
  settleCodexClassifications(state, maxTurns);
  closeCodexTurn(state, maxTurns);
  settleCodexClassifications(state, maxTurns);
  refreshCodexStructuralAgents(
    state.turns,
    state.turns[0]?.sessionId ?? state.opening.sessionId,
    opts.structuralChildren ?? [],
    opts.agentSpendOf,
    undefined,
    opts.structuralStatusOf,
  );
  const title = normalizeSessionTitle(opts.sessionTitle);
  for (const turn of state.turns) {
    turn.sessionTitle = title;
  }
  return {
    turns: state.turns.filter((turn) => !state.usageState.pendingOwnership[turn.promptId]),
    lastReportedModel: state.lastReportedModel ?? null,
    compactions: state.compactions,
    readBytes,
    turnLimitReached: state.turnLimitReached,
  };
}

function codexLifecycleReducer() {
  let turnId: string | null = null;
  let status = 'running';
  let endedAt: number | null = null;
  let terminal = false;
  let startSeen = false;
  const push = (record: Entry): void => {
    const recordTurnId = str(record.payload.turn_id);
    if (record.kind === 'task_started') {
      turnId = recordTurnId;
      status = 'running';
      endedAt = null;
      terminal = false;
      startSeen = true;
      return;
    }
    if (record.kind !== 'task_complete' && record.kind !== 'turn_aborted') {
      return;
    }
    const differentKnownTurn = recordTurnId !== null && turnId !== null && recordTurnId !== turnId;
    if (startSeen && differentKnownTurn) {
      return;
    }
    if (turnId === null) {
      turnId = recordTurnId;
    } else if (!startSeen && differentKnownTurn) {
      turnId = recordTurnId;
      terminal = false;
    }
    if (terminal) {
      return;
    }
    status = record.kind === 'turn_aborted' ? 'interrupted' : failedCodexTurn(record) ? 'failed' : 'completed';
    endedAt = record.at;
    terminal = true;
  };
  return { push, value: () => ({ turnId, status, endedAt, startSeen }) };
}

export function structuralAgentStatus(
  child: CodexSubagentFile,
  previousLines: typeof readPreviousLines = readPreviousLines,
): { status: string; durationMs: number | null } {
  meterReadWork('childLifecycleReads');
  const chunkBytes = 256 * 1024;
  const cutRecordLimit = 1024 * 1024;
  const tail = tailOf(child.file, chunkBytes, true);
  // Include the record cut by the tail window. Large terminal records and delayed duplicates must retain their original order.
  let cutLine: string | null = null;
  let cursor = tail.cursor;
  let cutBytes = 0;
  while (cursor && cursor.end > 0 && cutBytes < cutRecordLimit) {
    const readBytes = Math.min(chunkBytes, cutRecordLimit - cutBytes);
    const priorEnd = cursor.end;
    const batch = previousLines(child.file, cursor, readBytes);
    if (!batch) {
      break;
    }
    cursor = batch.cursor;
    cutBytes += priorEnd - cursor.end;
    if (!batch.lines.length) {
      continue;
    }
    cutLine = batch.lines[0].text;
    break;
  }
  const lifecycle = codexLifecycleReducer();
  const reduce = (line: string): void => {
    const record = parseRecord(line);
    if (record) lifecycle.push(record);
  };
  if (cutLine !== null) {
    reduce(cutLine);
  }
  for (const line of tail.lines) {
    reduce(line);
  }
  const { status, endedAt } = lifecycle.value();
  // Measure duration from the child's start clock. A guardian's opening envelope can follow its first turn.
  const durationMs =
    child.startedAt !== null && endedAt !== null && endedAt >= child.startedAt ? endedAt - child.startedAt : null;
  return { status, durationMs };
}

const CODEX_STRUCTURAL_AGENT = Symbol('codexStructuralAgent');
const CODEX_STRUCTURAL_END = Symbol('codexStructuralEnd');
const CODEX_STRUCTURAL_BASE = Symbol('codexStructuralBase');
interface StructuralAgentBase {
  status: string;
  startedAt?: number | null;
  durationMs: number | null;
  spend: ModelSpend[];
  spendFound: boolean;
  spendPartial: boolean;
  effort: string | null;
}
type StructuralTurnAgent = TurnAgent & {
  [CODEX_STRUCTURAL_AGENT]?: true;
  [CODEX_STRUCTURAL_BASE]?: StructuralAgentBase;
};
type StructurallyBoundedTurn = Turn & { [CODEX_STRUCTURAL_END]?: number };

function markStructuralAgent(agent: StructuralTurnAgent): void {
  if (agent[CODEX_STRUCTURAL_AGENT]) {
    return;
  }
  Object.defineProperty(agent, CODEX_STRUCTURAL_AGENT, { value: true });
}

// Identify child rows attached from opening metadata. Reapply these identities after structured cloning drops their hidden marks.
export function codexStructuralAgentIds(turns: readonly Turn[]): string[] {
  const ids: string[] = [];
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (agent.id && (agent as StructuralTurnAgent)[CODEX_STRUCTURAL_AGENT]) {
        ids.push(agent.id);
      }
    }
  }
  return ids;
}

function rememberStructuralBase(agent: StructuralTurnAgent): void {
  agent.codexStructuralBase ??= { status: agent.status, startedAt: agent.startedAt, durationMs: agent.durationMs };
  if (agent[CODEX_STRUCTURAL_BASE]) {
    return;
  }
  Object.defineProperty(agent, CODEX_STRUCTURAL_BASE, {
    value: {
      status: agent.status,
      startedAt: agent.startedAt,
      durationMs: agent.durationMs,
      spend: agent.spend,
      spendFound: agent.spendFound,
      spendPartial: agent.spendPartial,
      effort: agent.effort,
    } satisfies StructuralAgentBase,
  });
}

function restoreStructuralBase(agent: StructuralTurnAgent): void {
  if (agent.codexStructuralBase) {
    agent.status = agent.codexStructuralBase.status;
    agent.startedAt = agent.codexStructuralBase.startedAt;
    agent.durationMs = agent.codexStructuralBase.durationMs;
  }
  const base = agent[CODEX_STRUCTURAL_BASE];
  if (!base) {
    return;
  }
  agent.status = base.status;
  agent.startedAt = base.startedAt;
  agent.durationMs = base.durationMs;
  agent.spend = base.spend;
  agent.spendFound = base.spendFound;
  agent.spendPartial = base.spendPartial;
  agent.effort = base.effort;
}

// Attach structural children to the turn containing their opening clock.
// Preserve richer parent-recorded rows for matching thread ids.
function attachCodexStructuralAgents(
  turns: Turn[],
  parentThreadId: string | null,
  children: readonly CodexSubagentFile[] | undefined,
  statusOf: typeof structuralAgentStatus = structuralAgentStatus,
): void {
  if (!parentThreadId || !children?.length || !turns.length) {
    return;
  }
  const represented = new Map<string, TurnAgent>();
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (!agent.id && !agent.invocationId) {
        const child = codexSubagentFor(children, parentThreadId, {
          id: null,
          name: agent.description,
          path: agent.agentType,
          status: agent.status,
        });
        if (child) {
          agent.id = child.threadId;
          agent.codexInferredId = true;
        }
      }
      if (agent.id) {
        const child = codexSubagentFor(children, parentThreadId, {
          id: agent.id,
          name: agent.description,
          path: agent.agentType,
          status: agent.status,
        });
        if (child && !child.backgroundReview) agent.childSessionId = child.threadId;
        represented.set(agent.id, agent);
      }
    }
  }
  const ordered = children
    .filter((child) => child.parentThreadId === parentThreadId && child.openedAt !== null)
    .sort((left, right) => (left.openedAt as number) - (right.openedAt as number));
  for (const child of ordered) {
    const existing = represented.get(child.threadId);
    if (existing) {
      if (!(existing as StructuralTurnAgent)[CODEX_STRUCTURAL_AGENT]) {
        rememberStructuralBase(existing);
      }
      existing.startedAt = child.startedAt ?? existing.startedAt;
      if (!child.backgroundReview) {
        existing.childSessionId = child.threadId;
      } else {
        delete existing.childSessionId;
      }
      const lifecycle = statusOf(child);
      if ((existing as StructuralTurnAgent)[CODEX_STRUCTURAL_AGENT]) {
        existing.status = lifecycle.status;
        existing.durationMs = lifecycle.durationMs;
        continue;
      }
      const open =
        existing.status === 'running' || existing.status === 'async_launched' || existing.status === LAUNCHED;
      if (open && lifecycle.status !== 'running') {
        existing.status = lifecycle.status;
      }
      if (lifecycle.status !== 'running') {
        existing.durationMs ??= lifecycle.durationMs;
      }
      continue;
    }
    const openedAt = child.openedAt as number;
    const containing = turns.filter((turn, index) => {
      if (openedAt < turn.startedAt) {
        return false;
      }
      if (openedAt <= turn.endedAt) {
        return true;
      }
      const open = !turn.finished && !turn.error && !turn.interrupted;
      if (!open) {
        return false;
      }
      const next = turns[index + 1];
      const exclusiveEnd = next?.startedAt ?? (turn as StructurallyBoundedTurn)[CODEX_STRUCTURAL_END];
      return exclusiveEnd !== undefined ? openedAt < exclusiveEnd : index === turns.length - 1;
    });
    if (containing.length !== 1) {
      continue;
    }
    const lifecycle = statusOf(child);
    const row: StructuralTurnAgent = {
      id: child.threadId,
      description: child.backgroundReview ? 'Background review' : 'agent',
      agentType: child.agentPath,
      model: null,
      effort: null,
      spend: [],
      spendFound: false,
      spendPartial: false,
      startedAt: child.startedAt,
      durationMs: lifecycle.durationMs,
      tokens: null,
      toolUses: null,
      status: lifecycle.status,
      ...(child.backgroundReview ? {} : { childSessionId: child.threadId }),
    };
    markStructuralAgent(row);
    containing[0].agents.push(row);
    represented.set(child.threadId, row);
  }
}

// Refresh child facts on retained turns when descendants change without changing the parent rollout.
// `structuralIds` restores structural ownership after structured cloning drops hidden marks.
// Parent-recorded rows retain their separate refresh rules.
export function refreshCodexStructuralAgents(
  turns: Turn[],
  parentThreadId: string,
  children: readonly CodexSubagentFile[],
  lookup?: AgentSpendLookup,
  structuralIds?: readonly string[],
  statusOf: typeof structuralAgentStatus = structuralAgentStatus,
): void {
  const marked = structuralIds?.length ? new Set(structuralIds) : null;
  const direct = new Set(
    children.filter((child) => child.parentThreadId === parentThreadId).map((child) => child.threadId),
  );
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (marked && agent.id && marked.has(agent.id)) {
        markStructuralAgent(agent);
      }
      restoreStructuralBase(agent);
      if (agent.codexInferredId) {
        agent.id = null;
        delete agent.codexInferredId;
      }
      delete agent.childSessionId;
    }
    turn.agents = turn.agents.filter(
      (agent) => !(agent as StructuralTurnAgent)[CODEX_STRUCTURAL_AGENT] || (agent.id !== null && direct.has(agent.id)),
    );
  }
  attachCodexStructuralAgents(turns, parentThreadId, children, statusOf);
  attachCodexAgentSpend(turns, lookup);
}

function materializeCodexSession(
  source: CodexSessionParserState,
  opts: CodexReadOptions,
  readBytes: number,
): CodexSessionRead {
  return finishCodexSession(cloneParserState(source), opts, readBytes);
}

function codexHiddenSlots(state: CodexSessionParserState) {
  return { turns: state.turns, open: state.open, pending: null };
}

// Preserve hidden reducer fields in a snapshot that crosses a structured-clone worker boundary.
function codexSnapshot(state: CodexSessionParserState): CodexSessionParserState {
  const copy = cloneParserState(state);
  copy.hidden = hiddenParserState(codexHiddenSlots(copy), CODEX_HIDDEN_POLICY);
  return copy;
}

export function createCodexSessionReducer(
  sessionId: string,
  opts: CodexReadOptions = {},
  meta: CodexSessionMeta | null = null,
  restored?: CodexSessionParserState,
): CodexSessionReducer {
  const state = restored ? cloneParserState(restored) : emptyCodexSessionParserState(meta);
  if (state.version !== 22) {
    throw new Error('Incompatible Codex parser state');
  }
  applyHiddenParserState(codexHiddenSlots(state), state.hidden, CODEX_HIDDEN_POLICY);
  delete state.hidden;
  state.usageState.seenTurnOffsets ??= {};
  state.usageState.legacyReplayLinks ??= [];
  state.usageState.replayResetRequired ??= false;
  state.usageState.pendingRequestSources ??= {};
  state.usageState.seenClaudeInvocations ??= {};
  state.usageState.seenClaudeCommands ??= {};
  state.usageState.pendingClaudeResults ??= {};
  state.seenClaudeCommands ??= {};
  state.currentSpawns ??= new Set();
  if (state.open) {
    state.open.fileChanges ??= new Set();
  }
  state.compactionValueSources ??= state.compactions.map(() => ({ context: null, model: null }));
  state.compactionTurnIds ??= state.compactions.map(() => null);
  state.pendingCompactionBilling ??= null;
  state.lastContextSource ??= null;
  state.lastModelSource ??= null;
  state.lastProviderSource ??= null;
  state.lastServiceTierSource ??= null;
  return {
    pushLine: (line) => {
      const order = opts.captureSessionText ? captureTurnTextOrder([state.open, state.turns.at(-1)]) : null;
      if (opts.exportTurnBytes && typeof line !== 'string' && state.open && line.end !== undefined) {
        const start = state.open[CODEX_SOURCE_START] ?? line.start ?? 0;
        if (line.end - start > opts.exportTurnBytes) throw new ExportLimitError('turn', opts.exportTurnBytes);
      }
      reduceCodexSessionLine(state, line, sessionId, opts);
      if (opts.captureSessionText && typeof line !== 'string') {
        order?.([state.open, state.turns.at(-1)], line.start ?? 0);
      }
    },
    retainedBytes: () => retainedParserPayload(state),
    retainedPayloadScan: () => retainedParserPayloadScan(state),
    trimBefore: (offset) => trimCodexBefore(state, offset, opts.maxTurns ?? 40),
    snapshot: () => codexSnapshot(state),
    read: (readBytes = 0) => materializeCodexSession(state, opts, readBytes),
    finish: (readBytes = 0) => finishCodexSession(state, opts, readBytes),
    completedTurns: () => {
      const completed = cloneParserState(state);
      const last = completed.turns[completed.turns.length - 1] as StructurallyBoundedTurn | undefined;
      if (last && completed.open && completed.open.startedAt > last.startedAt) {
        Object.defineProperty(last, CODEX_STRUCTURAL_END, { value: completed.open.startedAt });
      }
      refreshCodexStructuralAgents(
        completed.turns,
        sessionId,
        opts.structuralChildren ?? [],
        opts.agentSpendOf,
        undefined,
        opts.structuralStatusOf,
      );
      const title = normalizeSessionTitle(opts.sessionTitle);
      for (const turn of completed.turns) {
        turn.sessionTitle = title;
      }
      return completed.turns
        .map((turn, index) => ({
          turn,
          start: completed.turnRanges[index]?.start ?? 0,
          end: completed.turnRanges[index]?.end ?? 0,
        }))
        .filter(({ turn }) => !completed.usageState.pendingOwnership[turn.promptId]);
    },
    completedCompactions: () => {
      const completed = cloneParserState(state);
      return completed.compactions.map((compaction, index) => ({
        compaction,
        start: completed.compactionRanges[index]?.start ?? 0,
        end: completed.compactionRanges[index]?.end ?? 0,
      }));
    },
    openRange: () =>
      state.open
        ? {
            start: state.open[CODEX_SOURCE_START] ?? 0,
            end: state.open[CODEX_SOURCE_END] ?? 0,
          }
        : null,
  };
}

function attachCodexAgentSpend(turns: Turn[], lookup: AgentSpendLookup | undefined): void {
  if (!lookup) {
    return;
  }
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (agent.invocationId) {
        continue;
      }
      const spend = lookup({
        id: agent.id,
        name: agent.description,
        path: agent.agentType,
        status: agent.status,
      });
      agent.spend = spend.models;
      delete agent.outputRate;
      delete agent.outputRateModel;
      if (spend.outputRate && spend.outputRateModel) {
        agent.outputRate = { ...spend.outputRate };
        agent.outputRateModel = spend.outputRateModel;
      }
      if (!agent.effort) {
        agent.effort = spend.effort;
      }
      agent.spendFound = spend.found;
      agent.spendPartial = spend.partial;
      if (spend.commits?.length) {
        agent.commits = spend.commits.map((commit) => ({ ...commit }));
      } else {
        delete agent.commits;
      }
      if (spend.commitIntents?.length) {
        agent.commitIntents = spend.commitIntents.map((intent) => ({ ...intent }));
      } else {
        delete agent.commitIntents;
      }
      const counted = childToolCalls(agent.artifacts);
      if (spend.artifacts) {
        agent.artifacts = cloneChildArtifacts(spend.artifacts);
      } else {
        delete agent.artifacts;
      }
      // A Codex parent records no tool count for a child, so the child's own calls give the
      // row its count. A count this step set from an earlier read follows the newer one.
      if (agent.toolUses === null || agent.toolUses === counted) {
        agent.toolUses = childToolCalls(agent.artifacts);
      }
      if (spend.usageIncomplete) {
        agent.spendIncomplete = true;
      } else {
        delete agent.spendIncomplete;
      }
    }
  }
}

function readCodexSessionLines(
  lines: string[],
  sessionId: string,
  opts: CodexReadOptions,
  readBytes: number,
  meta: CodexSessionMeta | null,
): CodexSessionRead {
  const reducer = createCodexSessionReducer(sessionId, opts, meta);
  for (const line of lines) {
    reducer.pushLine(line);
  }
  return reducer.finish(readBytes);
}

// Draw a turn only when it contains a prompt, assignment, response, tool use, file change, update, error, or interruption.
// Empty compaction and realtime turns create no card. Token usage alone does not qualify.
function worthDrawing(turn: Building): boolean {
  return (
    turn.prompt !== '' ||
    turn.delegation !== undefined ||
    turn.summary !== '' ||
    turn.toolUses > 0 ||
    turn.files.size > 0 ||
    turn.updates.length > 0 ||
    turn.error !== null ||
    turn.interrupted
  );
}

function newTurn(
  sessionId: string,
  turnId: string,
  at: number,
  contextWindow: number | null,
  provider: string | null,
): Building {
  return {
    agent: 'codex',
    sessionId,
    sessionTitle: null,
    promptId: turnId,
    startedAt: at,
    endedAt: at,
    prompt: '',
    summary: '',
    // `task_complete` only ever names `last_agent_message`, the newest one. Every
    // `final_answer` message the turn closed before that, `recordAnswer` collects here.
    answers: [],
    model: null,
    provider,
    effort: null,
    files: new Map(),
    fileChanges: new Set(),
    agents: [],
    commits: [],
    usage: {
      requests: 0,
      input: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
    },
    usageParts: [],
    contextTokens: 0,
    contextWindow,
    toolUses: 0,
    toolCounts: emptyToolCounts(),
    toolTally: {},
    laterPrompts: [],
    steps: [],
    stepCount: 0,
    stepKinds: [],
    failedOrdinals: [],
    skillUses: [],
    skillUseCount: 0,
    updates: [],
    failures: [],
    interrupted: false,
    finished: false,
    error: null,
  };
}

// Optional source identity and unabridged detail for an Activity step.
interface StepMetadata {
  capture?: boolean;
  sourceId?: string;
  fullDetail?: string;
}

function setFullDetail(step: TurnStep, fullDetail: string): void {
  Object.defineProperty(step, 'fullDetail', {
    value: fullDetail,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function recordStep(
  turn: Building,
  byId: Map<string, TurnStep>,
  name: string,
  detail: string,
  at: number,
  id: string,
  status: TurnStep['status'] = 'running',
  metadata: StepMetadata = {},
): TurnStep {
  const step: TurnStep = {
    ordinal: ++turn.stepCount,
    name,
    detail,
    at,
    status,
    ...(metadata.sourceId ? { sourceId: metadata.sourceId } : {}),
  };
  // Pairing metadata is needed while building the card, but is not part of the
  // serialized activity row, so keep it off the payload's enumerable surface.
  if (id) {
    Object.defineProperty(step, 'id', { value: id });
  }
  if (metadata.fullDetail !== undefined) {
    setFullDetail(step, metadata.fullDetail);
  }
  turn.stepKinds.push(TOOL_KIND[name] ?? 'other');
  setTurnStepStatus(turn, step, status);
  turn.steps.push(step);
  if (!metadata.capture && turn.steps.length > TURN_STEP_LIMIT) {
    turn.steps.shift();
  }
  if (id) {
    byId.set(id, step);
  }
  return step;
}

function recordUpdate(
  turn: Building,
  state: CodexSessionParserState,
  parsed: ParsedUpdate,
  at: number,
  sequence: number,
): void {
  const { updateById: byId, updateByText: byText, commentaryPair: pair } = state;
  const sourceId = parsed.sourceId ?? `${turn.promptId}:${parsed.kind}:${at}:${sequence}`;
  const textKey = `${parsed.kind}:${at}:${parsed.text}`;
  const complementary =
    parsed.commentarySource &&
    pair &&
    parsed.commentarySource !== pair.source &&
    pair.update.kind === parsed.kind &&
    pair.update.text === parsed.text &&
    pair.update.stepsBefore === turn.stepCount &&
    Math.abs(at - pair.update.at) <= ANSWER_PAIRING_WINDOW_MS;
  const held = byId.get(sourceId) ?? byText.get(textKey) ?? (complementary ? pair.update : null);
  // Consume both representations once. Later occurrences get their own candidate and Activity row.
  state.commentaryPair = null;
  if (held) {
    if (parsed.text.length > held.text.length) {
      held.text = parsed.text;
    }
    held.status = 'done';
    if (sourceId.startsWith('msg_') || (complementary && parsed.commentarySource === 'response')) {
      held.sourceId = sourceId;
    }
    byId.set(sourceId, held);
    byText.set(textKey, held);
    return;
  }
  const update: TurnUpdate = {
    sourceId,
    kind: parsed.kind,
    text: parsed.text,
    at,
    status: 'done',
    stepsBefore: turn.stepCount,
  };
  turn.updates.push(update);
  if (parsed.commentarySource) {
    state.commentaryPair = { update, source: parsed.commentarySource };
  }
  byId.set(sourceId, update);
  byText.set(textKey, update);
}

// Pair identical final-answer text across records with different ids when no intervening prompt exists.
// Matching records must fall within this window. The response remains excluded from earlier answers through `responseAnswerIndex`.
const ANSWER_PAIRING_WINDOW_MS = 2000;

// Match the latest answer by exact text and time window, provided no later prompt intervened.
function recentMatchingAnswer(turn: Building, text: string, at: number): TurnAnswer | null {
  const last = turn.answers[turn.answers.length - 1];
  if (!last || last.text !== text || Math.abs(at - last.at) > ANSWER_PAIRING_WINDOW_MS) {
    return null;
  }
  const crossedPrompt = turn.laterPrompts.some(
    (ask) => ask.at > Math.min(at, last.at) && ask.at < Math.max(at, last.at),
  );
  return crossedPrompt ? null : last;
}

function recordAnswer(
  turn: Building,
  byId: Map<string, TurnAnswer>,
  parsed: { sourceId: string | null; text: string },
  at: number,
  sequence: number,
): void {
  const sourceId = parsed.sourceId ?? `${turn.promptId}:answer:${at}:${sequence}`;
  const held = byId.get(sourceId) ?? recentMatchingAnswer(turn, parsed.text, at);
  if (held) {
    if (parsed.text.length > held.text.length) {
      held.text = parsed.text;
    }
    byId.set(sourceId, held);
    return;
  }
  const answer: TurnAnswer = { text: parsed.text, at, stepsBefore: turn.stepCount };
  turn.answers.push(answer);
  byId.set(sourceId, answer);
}

// Read a tool's subject from JSON-string arguments. Invalid or unsupported arguments produce empty detail.
function callDetail(name: string, raw: unknown): { detail: string; fullDetail?: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { detail: '' };
  }
  try {
    const args = JSON.parse(raw) as unknown;
    if (!isRecord(args)) {
      return { detail: '' };
    }
    const presented = presentedStepDetail(name, args);
    return {
      detail: presented.detail,
      ...(presented.fullDetail !== undefined ? { fullDetail: presented.fullDetail } : {}),
    };
  } catch {
    const args = wrappedToolInput(name, raw);
    const presented = presentedStepDetail(name, args);
    return {
      detail: presented.detail,
      ...(presented.fullDetail !== undefined ? { fullDetail: presented.fullDetail } : {}),
    };
  }
}

function decodedString(source: string): string {
  try {
    const value = JSON.parse(source) as unknown;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function wrapperString(raw: string, field: string): string {
  return wrapperStrings(raw, field)[0] ?? '';
}

function wrapperStrings(raw: string, field: string): string[] {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = raw.matchAll(new RegExp(`(?:["']?${escaped}["']?\\s*:\\s*)("(?:\\\\.|[^"\\\\])*")`, 'g'));
  return [...matches].map((match) => decodedString(match[1])).filter(Boolean);
}

function wrapperCollection(raw: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:["']?${escaped}["']?\\s*:\\s*)\\[`).exec(raw);
  if (!match) {
    return '';
  }
  const start = match.index + match[0].lastIndexOf('[');
  let depth = 0;
  let quote = '';
  let escapedCharacter = false;
  for (let index = start; index < raw.length; index++) {
    const character = raw[index];
    if (quote) {
      if (escapedCharacter) {
        escapedCharacter = false;
        continue;
      }
      if (character === '\\') {
        escapedCharacter = true;
        continue;
      }
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      depth++;
    } else if (character === ']' && --depth === 0) {
      return raw.slice(start, index + 1);
    }
  }
  return '';
}

function patchText(raw: string): string {
  const call = /\btools\.apply_patch\s*\(\s*([A-Za-z_][A-Za-z0-9_]*|"(?:\\.|[^"\\])*")/.exec(raw);
  if (!call) {
    return '';
  }
  if (call[1].startsWith('"')) {
    return decodedString(call[1]);
  }
  const name = call[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignment = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`).exec(raw);
  return assignment ? decodedString(assignment[1]) : '';
}

function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(line);
    if (match?.[1]) {
      paths.push(match[1].trim());
    }
  }
  return [...new Set(paths)];
}

// Read only the JSON string literals used for known presentation fields. The surrounding
// JavaScript is never evaluated, and no fallback serializes the wrapper or its arguments.
function wrappedToolInput(name: string, raw: string): Record<string, unknown> {
  if (name === 'apply_patch') {
    const paths = patchPaths(patchText(raw));
    return paths.length ? { paths } : {};
  }
  if (name === 'web__run') {
    const collections: Array<[string, string]> = [
      ['search_query', 'q'],
      ['image_query', 'q'],
      ['find', 'pattern'],
      ['open', 'ref_id'],
      ['finance', 'ticker'],
      ['weather', 'location'],
      ['sports', 'team'],
      ['sports', 'league'],
      ['time', 'utc_offset'],
    ];
    for (const [collection, field] of collections) {
      const values = wrapperStrings(wrapperCollection(raw, collection), field);
      if (values.length) {
        return { [collection]: values.map((value) => ({ [field]: value })) };
      }
    }
    return {};
  }
  const input: Record<string, unknown> = {};
  for (const field of [
    'skill',
    'command',
    'cmd',
    'file_path',
    'filePath',
    'path',
    'url',
    'query',
    'pattern',
    'task_name',
    'recipient',
    'target',
    'to',
    'description',
    'prompt',
    'summary',
    'task_id',
  ]) {
    const value = wrapperString(raw, field);
    if (value) {
      input[field] = value;
    }
  }
  return input;
}

// Extract a nested tool name when a custom exec wrapper names exactly one tool kind.
// Completed items supply command and edit details. Calls without completed items retain this wrapper-derived name.
function nestedToolName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const names = new Set<string>();
  for (const match of raw.matchAll(/\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    names.add(match[1]);
  }
  if (names.size !== 1) {
    return null;
  }
  const [name] = names;
  return name === 'exec_command' || name === 'shell_command' ? null : name;
}

// Some client command wrappers have no completed CommandExecution item. Their first
// argument is still a JSON-compatible object, so read a directly written double-quoted
// command without evaluating the surrounding JavaScript.
function wrappedCommand(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const match =
    /\btools\.(?:exec_command|shell_command)\s*\(\s*\{\s*(?:"(?:cmd|command)"|cmd|command)\s*:\s*("(?:\\.|[^"\\])*")/.exec(
      raw,
    );
  if (!match) {
    return null;
  }
  try {
    const command = JSON.parse(match[1]) as unknown;
    return typeof command === 'string' && command.trim() ? command : null;
  } catch {
    return null;
  }
}

// Record a subagent launch from the parent's tool-call arguments. Child work is read separately from its rollout.
function recordSpawn(turn: Building, call: Record<string, unknown>, at: number): TurnAgent {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(String(call.arguments || '{}')) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  const row: TurnAgent = {
    id: null,
    description: str(args.task_name) ?? 'agent',
    agentType: null,
    model: str(args.model),
    effort: str(args.reasoning_effort),
    spend: [],
    spendFound: false,
    spendPartial: false,
    startedAt: at,
    durationMs: null,
    tokens: null,
    toolUses: null,
    status: 'running',
  };
  const id = str(call.call_id);
  if (id) {
    Object.defineProperty(row, 'toolUseId', { value: id });
  }
  turn.agents.push(row);
  return row;
}

interface CollabSpawnCompletion {
  callId: string;
  id: string;
  description: string | null;
  model: string | null;
  effort: string | null;
}

function collabSpawnCompletion(payload: Record<string, unknown>): CollabSpawnCompletion | null {
  const item = payload.item;
  if (
    !isRecord(item) ||
    str(item.type) !== 'CollabAgentToolCall' ||
    str(item.tool) !== 'spawn_agent' ||
    str(item.status) !== 'completed'
  ) {
    return null;
  }
  const callId = str(item.id);
  const receivers = Array.isArray(item.receiver_agents) ? item.receiver_agents : [];
  const receiver = receivers.find(isRecord);
  const receiverId = receiver ? str(receiver.thread_id) : null;
  const id = receiverId ?? (Array.isArray(item.receiver_thread_ids) ? str(item.receiver_thread_ids[0]) : null);
  if (!callId || !id) {
    return null;
  }
  return {
    callId,
    id,
    description: receiver ? str(receiver.agent_nickname) : null,
    model: str(item.model),
    effort: str(item.reasoning_effort),
  };
}

interface CurrentSubAgentActivity {
  callId: string;
  id: string;
  description: string;
}

function currentSubAgentActivity(payload: Record<string, unknown>): CurrentSubAgentActivity | null {
  const item = payload.item;
  if (!isRecord(item) || str(item.type) !== 'SubAgentActivity') {
    return null;
  }
  const callId = str(item.id);
  const id = str(item.agent_thread_id);
  const agentPath = str(item.agent_path);
  const description = agentPath?.slice(agentPath.lastIndexOf('/') + 1) ?? null;
  if (!callId || !id || !description) {
    return null;
  }
  return { callId, id, description };
}

function setSpawnIdentity(
  row: TurnAgent,
  id: string | null,
  description: string | null,
  model: string | null,
  effort: string | null = null,
): void {
  if (id) {
    row.id = id;
  }
  if (description) {
    row.description = description;
  }
  if (model) {
    row.model = model;
  }
  if (effort) {
    row.effort = effort;
  }
}

function finishSpawn(state: CodexSessionParserState, row: TurnAgent, status: ChildTerminalStatus): void {
  // A terminal result is authoritative. Shutdown can follow the delivery of an answer and
  // only closes the transport, so it must not replace a completed or failed outcome.
  if (row.status === 'completed' || row.status === 'failed') {
    return;
  }
  row.status = status;
  for (const [id, launched] of state.launched) {
    if (launched !== row) {
      continue;
    }
    state.launched.delete(id);
    state.currentSpawns.delete(id);
    state.toolNames.delete(id);
    state.stepById.delete(id);
  }
  for (const [name, launched] of state.byName) {
    if (launched === row) {
      state.byName.delete(name);
    }
  }
}

// Select a change's destination path and exclude ephemeral paths.
function visibleCodexChangePath(written: string, raw: unknown): string | null {
  const change = (raw || {}) as Record<string, unknown>;
  const filePath = str(change.move_path) ?? written;
  return filePath && !isEphemeralPath(filePath) ? filePath : null;
}

function hasVisibleCodexChanges(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  return Object.entries(raw as Record<string, unknown>).some(
    ([written, change]) => visibleCodexChangePath(written, change) !== null,
  );
}

function recordChanges(turn: Building, changes: Record<string, unknown>): void {
  for (const [written, raw] of Object.entries(changes)) {
    const change = (raw || {}) as Record<string, unknown>;
    // A renamed file is recorded under the path it had, with the path it moved to beside
    // it. The row names where the file is now, because that is the one that can be opened.
    const filePath = visibleCodexChangePath(written, raw);
    if (!filePath) {
      continue;
    }
    const fingerprint = JSON.stringify([
      written,
      str(change.type),
      str(change.move_path),
      typeof change.content === 'string' ? change.content : null,
      typeof change.unified_diff === 'string' ? change.unified_diff : null,
    ]);
    // One patch can carry both legacy and completed structured records. Keep one file edit
    // from that pair, while separate changes to the same file still form their own edits.
    if (turn.fileChanges.has(fingerprint)) {
      continue;
    }
    const kind = str(change.type);
    const content = typeof change.content === 'string' ? change.content : null;
    const hunks = typeof change.unified_diff === 'string' ? hunksFromUnifiedDiff(change.unified_diff) : [];
    let added = 0;
    let removed = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          added++;
        } else if (line.startsWith('-')) {
          removed++;
        }
      }
    }
    // Added and deleted files carry complete text. Count its lines without treating a trailing newline as an extra line.
    if (kind === 'add') {
      added = countLines(content || '');
    }
    if (kind === 'delete') {
      removed = countLines(content || '');
    }
    const key = normalizeFsPath(filePath);
    const entry = turn.files.get(key) || { path: filePath, added: 0, removed: 0, isNew: false, edits: [] };
    entry.added += added;
    entry.removed += removed;
    if (kind === 'add') {
      entry.isNew = true;
    }
    entry.edits.push({
      hunks,
      // A delete records the text it took out, which is the whole before side of the file,
      // against an after side of nothing. An update records neither side, so its diff is
      // the regions it changed and no more.
      originalFile: kind === 'delete' ? content : null,
      content: kind === 'add' ? content : kind === 'delete' ? '' : null,
      isCreate: kind === 'add',
    });
    turn.files.set(key, entry);
    turn.fileChanges.add(fingerprint);
  }
}

// A Codex turn with commands but no recorded file changes has uncertain edit coverage.
// Shell commands and scripts can write files without emitting structured file-change records.
// Other agents do not receive this Codex-specific coverage marker.
export function mayHaveUnrecordedEdits(turn: Pick<Turn, 'agent' | 'toolCounts' | 'files'>): boolean {
  return turn.agent === 'codex' && turn.toolCounts.commands > 0 && turn.files.length === 0;
}
