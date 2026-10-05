import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
  BackwardLineCursor,
  BoundaryDiscovery,
  BoundaryDiscoveryOptions,
  CacheLifetime,
  Compaction,
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
  isInside,
  normalizeFsPath,
  sameCommitSha,
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
  scanLines,
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

// Reads OpenAI Codex session rollouts (JSONL under ~/.codex/sessions/YYYY/MM/DD/) and
// groups them into the same `Turn` shape the Claude Code reader produces, so everything
// downstream draws both without knowing which agent wrote which. Read-only: nothing here
// writes to a rollout.
//
// Three differences from the Claude reader govern the whole file.
//
// Turn boundaries are recorded rather than inferred. `task_started` and `task_complete`
// carry one `turn_id`, so none of the queued-prompt machinery in `transcript.ts` is needed
// here.
//
// A directory name says nothing about which project a session belongs to, because the tree
// is sharded by date. Every file has to be opened to find out, which makes the safe answer
// the only answer available.
//
// Token counts are the other way round. OpenAI's `input_tokens` includes the cached part
// and Anthropic's excludes it, so reading the field straight across would charge every
// cached token twice.

// Where Codex writes its session rollouts. Date sharded as YYYY/MM/DD with no per-project
// directory, so unlike Claude Code's tree the name of a directory says nothing about which
// project a session belongs to.
export function codexSessionsRoot(): string {
  return process.env[`${ARC_IDENTITY.environmentPrefix}CODEX_ROOT`] || path.join(codexHome(), 'sessions');
}

// What a rollout's opening record says about the session: which project it ran in, how it
// was launched, and whether it is one of Codex's internal threads. Read from the head,
// because the first line carries all three and the file behind it runs to hundreds of
// megabytes.
//
// The record holds a good deal more, none of which anything reads: the originator, the git
// branch and commit, the fork a session was resumed from and the nickname a subagent was
// given. They are left where they are rather than carried here, so nothing on this type is
// a field waiting for a reader.
//
// A stored copy of this record outlives the build that read it. A field added or taken out
// here bumps `CODEX_META_VERSION` in `codexopenings.ts`.
export interface CodexSessionMeta {
  sessionId: string | null;
  cwd: string | null;
  modelProvider: string | null;
  // Envelope time on the first record. A replayed turn keeps its original started_at,
  // which lets readers distinguish inherited history from work done by this rollout.
  openedAt: number | null;
  // When the rollout's own work can begin. A guardian can write its envelope after its own
  // first turn begins, so a guardian begins at the clock in its payload. Every other rollout
  // begins at its envelope.
  startedAt: number | null;
  // The clock the usage reducer measures a turn's recorded start against to tell inherited
  // history from work done by this rollout. See `codexReplayBoundaryAt`.
  replayBoundaryAt: number | null;
  // The public entrypoint that started the rollout. `exec` is Codex's headless entrypoint;
  // `vscode` and `cli` are sessions a reader can hold directly.
  launchSource: string | null;
  // 'subagent' for a thread Codex spawned for itself, 'user' where the writer said so.
  // Absent on sessions written before the field existed, which are all the user's own.
  threadSource: string | null;
  // The thread this rollout was spawned under. Only a non-empty string counts: a thread
  // with a parent is one something else started, whatever its thread_source says.
  parentThreadId: string | null;
  // The stable path Codex assigned this child, such as `/root/review_sol`. Null for a user
  // session and for internal services such as the background guardian.
  agentPath: string | null;
  // The structured subtype inside `source.subagent.other`, when Codex wrote one.
  subagentKind: string | null;
  // Whether `source` is an object holding a `subagent` object, which is the shape Codex
  // gives a thread it started for itself. A user session writes `source` as a string
  // ('vscode', 'exec', 'cli'), so a string never counts, and nothing inside the subagent
  // object is read for structural classification.
  hasSubagentSource: boolean;
}

// How many opening records `CodexMetaCache.prime` reads at once. Enough to keep Node's file
// system threads busy, and few enough that a cold pass holds only this many head buffers.
export const COLD_OPENING_READS = 8;

// How long walks wait to read a rollout again after a refused read, from the second refusal on.
// A failed open costs tens of microseconds on the main thread, so thousands of refused rollouts
// read on every walk would cost each walk over 100 ms.
export const REFUSED_OPENING_RETRY_MS = 30_000;

// How long walks wait to read a rollout again after its first refused read. A writer or a scanner
// that holds a new rollout for a moment then delays its session by about a second, not by a full
// retry interval. The short wait costs each refused rollout one more failed open.
export const REFUSED_OPENING_FIRST_RETRY_MS = 1_000;

// Opening metadata is immutable once a rollout has written it, so a readable record never
// needs another head read or stat. A rollout can briefly exist before its first line is
// complete, though: retry an initial miss once after measuring it, then only after growth.
// A malformed file that stays still therefore pays two head reads, not one per poll. A read
// the file system refuses leaves a refusal entry and no size marker, so a finished rollout that
// never grows is read again. The next read waits `REFUSED_OPENING_FIRST_RETRY_MS`, and each read
// after a later refusal waits `REFUSED_OPENING_RETRY_MS`. The clock is monotonic by default.
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
      // A clock that stepped back behind the last read makes the read due, so a readable rollout
      // never stays hidden longer than its wait.
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
    // A refused read leaves no size marker, because a file another process holds for a moment
    // says nothing about its head. The refusal entry holds when this read ran and how long walks
    // wait before the next one.
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

  // Reads the opening record of every file this cache holds no answer for, `limit` at a time, and
  // settles once every read has. Each read leaves the main thread free while the disk works, so
  // a machine of cold rollouts no longer stalls the editor. A file that `get` read meanwhile
  // keeps that answer. A read that finds no record leaves the retry marker a first `get` leaves,
  // with the size measured off the main thread. `get` then reads the file again only after it
  // grows. A file `get` found refused, before or during the pass, has no answer, so the pass reads
  // it and its answer replaces the refusal entry. A read that rejects leaves the entry as it was,
  // because a file another process holds for a moment says nothing about its head. The next `get`
  // reads a file with no entry as a file the pass never reached, and a file with a refusal entry
  // after that entry's wait. True when the pass added a row the stored records lacked.
  async prime(
    files: readonly string[],
    readAsync: (file: string, buf: Buffer) => Promise<CodexSessionMeta | null> = readCodexSessionMetaAsync,
    limit = COLD_OPENING_READS,
    sizeAsync: (file: string) => Promise<number | null> = fileSizeAsync,
  ): Promise<boolean> {
    const missing = files.filter((file) => this.entries.get(file)?.meta === undefined);
    const before = this.changed;
    let next = 0;
    const lane = async (): Promise<void> => {
      const buf = Buffer.allocUnsafe(META_BYTES);
      while (next < missing.length) {
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

// Background review is automation rather than a session somebody dispatched. It has
// the same parent and subagent metadata as an ordinary child, so its explicit source is the
// distinction that keeps it out of the rail.
export function isHiddenThread(meta: CodexSessionMeta): boolean {
  return isGuardianSource(meta.threadSource, meta.subagentKind);
}

// Current guardian rollouts name `guardian_review` as their thread source. Older ones use the
// ordinary `subagent` source and name the guardian in `source.subagent.other`.
function isGuardianSource(threadSource: string | null, subagentKind: string | null): boolean {
  return threadSource === 'guardian_review' || (threadSource === 'subagent' && subagentKind === 'guardian');
}

// Whether another agent started this rollout. Codex records either a headless entrypoint or
// structural child metadata. The structural forms are checked independently because versions
// have written different subsets of them. Unknown values with none of these signs stay in the
// reader's day buckets.
export function isAgentRun(meta: CodexSessionMeta): boolean {
  return (
    meta.launchSource === 'exec' ||
    meta.threadSource === 'subagent' ||
    meta.parentThreadId !== null ||
    meta.hasSubagentSource
  );
}

// Enough of the head to hold the opening record whole. It carries the model's base
// instructions, so it is tens of kilobytes rather than the few hundred bytes a Claude
// transcript opens with.
const META_BYTES = 128 * 1024;

// How far into a rollout the first prompt can sit. Everything the model was told opens the
// file ahead of it: the instructions, the sandbox rules and a snapshot of the workspace.
const TITLE_BYTES = 512 * 1024;

// How many directory levels below the sessions root to look for rollouts. The tree is
// YYYY/MM/DD today, which is three, and the fourth is the room a shard could be added in
// without the reader going blind. Bounded so a stray link cannot walk the disk.
const WALK_DEPTH = 4;

// The first read of a rollout's head. Most opening records end inside it.
const FIRST_LINE_WINDOW = 16 * 1024;

// One buffer for every synchronous head read. A read runs to its end without yielding, so no
// two reads share it at once. Asynchronous reads each carry their own.
let headBuffer: Buffer | null = null;

// What one read of a head window settles. A string is the first line, null is a head with no
// first line, and undefined asks for the next, larger window.
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

// The first line of a file, read in growing windows up to `META_BYTES` and decoded only up to
// its newline. A file that ends before a newline and inside `META_BYTES` is one line. A head
// with no newline inside `META_BYTES` has no first line, which is what `headLines` answers. A
// failed open or read throws.
function firstLineOf(file: string): string | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const buf = (headBuffer ??= Buffer.allocUnsafe(META_BYTES));
    let have = 0;
    let window = FIRST_LINE_WINDOW;
    for (;;) {
      const want = window - have;
      const read = fs.readSync(fd, buf, have, want, have);
      const line = firstLineStep(buf, have, read, want);
      if (line !== undefined) {
        return line;
      }
      have += read;
      window = Math.min(window * 2, META_BYTES);
    }
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

// `firstLineOf` with the file system calls handed to the thread pool. `buf` holds
// `META_BYTES` and belongs to this read until it settles. A failed open or read rejects, so
// `CodexMetaCache.prime` can tell a refused read from a head with no record.
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

// The opening record of a rollout, null when the file does not start with one, or undefined when
// the file system refuses the read.
//
// Every rollout's record is stored once per machine and never read again. A change to what
// this returns, or to a helper it derives a stored field with, bumps `CODEX_META_VERSION` in
// `codexopenings.ts`. Its comment names the helpers.
function readCodexOpeningRecord(file: string): CodexSessionMeta | null | undefined {
  let line: string | null;
  try {
    line = firstLineOf(file);
  } catch {
    return undefined;
  }
  return openingRecordOf(line);
}

function openingRecordOf(line: string | null): CodexSessionMeta | null {
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
  // `id` rather than `session_id`, which reads like the better name and is not: it is shared
  // between rollouts, 237 distinct values over 605 records on this machine against one per
  // file for `id`. Two files under one id would draw as one session on the panel.
  //
  // Nothing here reads `context_window` either, whatever the name suggests. It holds an
  // object naming the compaction window the session is in, and the size a turn ran against
  // is recorded per turn, on `task_started` and on every `token_count`.
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
  return guardianPayloadAt(payload, threadSource, subagentKind) ?? openedAt;
}

// The usage reducer counts a turn as inherited history when its recorded start falls more than
// this slack before the replay boundary. For most rollouts the boundary is the envelope, and
// the slack covers an envelope written a little after the rollout's own first turn began.
const CODEX_REPLAY_CLOCK_SLACK_MS = 5_000;
// A turn records its start rounded down to the whole second, so a guardian's own first turn
// can read up to a second before the clock in the guardian's payload.
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
  return payloadAt === null ? openedAt : payloadAt + CODEX_REPLAY_CLOCK_SLACK_MS - CODEX_TURN_START_ROUNDING_MS;
}

// The thread id at the end of `rollout-<ISO8601>-<uuid>.jsonl`, for a file whose opening
// record did not name one.
const ROLLOUT_NAME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// Every rollout under `root`, whatever it holds.
//
// The whole tree is walked, and nothing prunes it by the date a directory is named after.
// Two reasons, and the second is the one that lasts. A directory holds a session's *start*
// date while its mtime tracks its last activity, so a cutoff would drop a session resumed
// days later while it sat at the top of the list by mtime. And the walk is cheap enough
// that it does not have to be right about how Codex resumes a session at all: pruning
// would be correct only for as long as that implementation detail held.
export function rolloutFiles(root: string): string[] {
  const out: string[] = [];
  // `depth` counts the levels already descended, so the root itself is zero and a directory
  // is entered while that count is still under the limit.
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < WALK_DEPTH) {
          walk(full, depth + 1);
        }
      } else if (entry.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

// What one listing found: the sessions belonging to the workspace, and every rollout the
// walk passed over on the way to them.
//
// Both halves are needed. The caller caches an opening record per rollout, so it has to
// know which rollouts still exist, and that is a much longer list than the sessions: on
// this machine, 506 against 5. A cache trimmed to the sessions would be emptied on every
// repaint, and the head reads it exists to prevent would all run again.
export interface CodexListing {
  sessions: SessionFile[];
  // Every rollout whose recorded cwd belongs to this workspace, including automation that
  // is intentionally absent from the session rail.
  sources: { file: string }[];
  // Structural child rollouts belonging to these folders, retained for parent spend lookup.
  // This lightweight record carries no stat; a visible dispatched child separately appears
  // in `sessions`, where it is statted like any other session.
  subagents: CodexSubagentFile[];
  walked: string[];
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

// Every Codex session belonging to these workspace folders, newest activity first.
//
// Membership is decided per file, from the cwd that file recorded, and never from anything
// else. There is no directory name to be wrong about here, which makes the safe rule the
// only one available, and nothing should later be added to shortcut it.
//
// `metaOf` is injected for the same reason the Claude reader injects `cwdOf`: a session's
// opening record never changes once written, so the panel reads it once per file rather
// than once per poll.
export interface RolloutStat {
  mtimeMs: number;
  size: number;
  isFile: boolean;
}

export function readRolloutStat(file: string): RolloutStat | null {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
  } catch {
    return null;
  } // vanished mid-scan
}

// A rollout written to within this window is statted on every listing.
export const CODEX_STAT_ACTIVE_MS = 10 * 60_000;
// An older rollout reuses its held stat until the watcher reports its file or directory, or
// until the held stat is this old. The age limit covers an event the watcher never delivers.
export const CODEX_STAT_REVALIDATE_MS = 60_000;

// The stat of each listed rollout, so a listing does not stat every idle session on every
// poll. The panel marks a file when the watcher reports it, and clears the cache whenever a
// watcher closes or fails, because events can be lost then. Stopping the poll clears it too,
// because a hidden panel opens no watcher and reads no stat from here while it waits.
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
    } else {
      this.entries.delete(file);
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

// What the cold pass hands the first catalog walk: the rollouts it walked, and whether it read a
// row the stored opening records lacked. The walk lists from `walked`, so a startup walks the
// rollout tree once.
export interface ColdOpeningPass {
  walked: string[];
  read: boolean;
}

export async function coldOpeningPass(cache: CodexMetaCache, root: string): Promise<ColdOpeningPass> {
  const walked = rolloutFiles(root);
  return { walked, read: await cache.prime(walked) };
}

// `walked` is a rollout list the caller already holds. Without it, the listing walks `root`.
export function codexSessionFiles(
  root: string,
  folders: string[],
  metaOf: (file: string) => CodexSessionMeta | null = readCodexSessionMeta,
  statOf: (file: string) => RolloutStat | null = readRolloutStat,
  walked: string[] = rolloutFiles(root),
): CodexListing {
  if (folders.length === 0) {
    return { sessions: [], sources: [], subagents: [], walked };
  }
  const out: SessionFile[] = [];
  const sources: { file: string }[] = [];
  const subagents: CodexSubagentFile[] = [];
  for (const file of walked) {
    // Membership is settled before the file is touched again, and that order is what makes
    // this affordable to repeat. A rollout's opening record never changes, so `metaOf`
    // answers from the caller's cache after the first pass, while `mtimeMs` has to be read
    // fresh every time because it moves as a session grows. Statting first would put a
    // system call on every rollout on the machine, on every poll, to learn nothing new
    // about the ones that belong to another project.
    const meta = metaOf(file);
    // No readable opening record means no cwd, and the path holds none either, so there is
    // nothing that puts the session in this workspace.
    if (!meta || !meta.cwd || !isInside(meta.cwd, folders)) {
      continue;
    }
    sources.push({ file });
    // Structural children stay available for their parent's spend lookup. Dispatched work
    // also stays on the rail as an agent-run session; only background automation is
    // omitted from the visible session list.
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
    // Background review is omitted before the stat, so automation never reaches the recent
    // list, the picker, the search corpus, the cards, or any per-session figure. A dispatched
    // child stays visible and is marked below for the folded agent bucket.
    if (isHiddenThread(meta)) {
      continue;
    }
    const stat = statOf(file);
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
      // A manually launched `codex exec` has the same record as a headless dispatch and is
      // grouped the same way; there is no parent field with which to tell them apart.
      agentRun: isAgentRun(meta),
    });
  }
  return { sessions: out.sort((a, b) => b.mtimeMs - a.mtimeMs), sources, subagents, walked };
}

// Which cached opening records a listing has left behind, so the caller can drop them.
//
// Against what the walk saw, never against the sessions it returned. The cache holds an
// entry for every rollout on the machine, because membership is decided by reading one, and
// nearly all of them belong to other projects. Trimmed to the sessions, it would keep five
// entries out of five hundred and the whole head-read pass would run again on the next poll,
// which is the pass the cache exists to make happen once.
export function staleMetas(cached: Iterable<string>, walked: Iterable<string>): string[] {
  const seen = new Set(walked);
  return [...cached].filter((file) => !seen.has(file));
}

// What to call a Codex session in a list of them.
//
// Codex names no session, so the first thing the user typed is the name, which is the
// fallback the Claude reader already uses for a session too young to have been named.
// Read from the head rather than the tail, because that first prompt is the one wanted and
// a tail window wide enough to be sure of reaching it would be the whole file.
export function readCodexSessionTitle(file: string, bytes = TITLE_BYTES): string | null {
  return readCodexSessionTitlePair(file, bytes).short;
}

export function readCodexSessionTitlePair(
  file: string,
  bytes = TITLE_BYTES,
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

// The title comes from a rollout's head, but its last activity and newest turn outcome are
// both in the tail. Keep those answers together so naming every rail row does not read it
// twice.
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

// Where Codex records the name it gives a thread.
//
// Beside the sessions tree rather than inside it, and one file for every session on the
// machine. A rollout is written while the session runs, and the name is decided from a
// summary of it afterwards and appended here, so the two files move independently: a rollout
// that will never be written to again still gains a name minutes later.
export function codexSessionIndexPath(): string {
  return path.join(path.dirname(codexSessionsRoot()), 'session_index.jsonl');
}

// The name Codex has given each thread, by session id.
//
// Append-only JSONL, so renaming a thread adds a row rather than rewriting the one already
// there and the last row for an id wins. A row with no name leaves any earlier name standing,
// because an id that appears twice is a rename and not an erasure.
//
// Capped and flattened like the prompt titles beside it. A name is Codex's own short summary
// and has always been one line, but every display path draws a title as text, so a stray
// newline in one would otherwise reach the rail verbatim.
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
  // The file's size and mtime when it was read, or empty where there is no file. Compared
  // rather than the names themselves: it is both what says a re-read is needed and what
  // tells the panel a name landed.
  stamp: string;
  names: Map<string, string>;
  fullNames: Map<string, string>;
}

// The thread names, re-read only when the file behind them moved.
//
// The stamp is the only signal there is. A name arrives after its rollout has stopped being
// written, so nothing about the rollout changes when a session is named, and a reader
// watching only the rollouts would hold the nameless answer for as long as the session sat
// still.
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
    const text = fs.readFileSync(file, 'utf8');
    return { stamp, ...parseThreadNamePairs(text) };
  } catch {
    return { stamp: '', names: new Map(), fullNames: new Map() };
  }
}

// What to call a Codex session: the name Codex gave the thread, else its first prompt.
//
// The name wins wherever there is one. It is Codex's own summary of the session, which
// is the same thing the Claude reader's title is; the first prompt stands in only because
// Codex used to name nothing, and it reads as a truncated sentence beside a real name.
//
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

export function codexPrompt(raw: string): string {
  const at = raw.lastIndexOf(IDE_REQUEST);
  return cleanPrompt(at < 0 ? raw : raw.slice(at + IDE_REQUEST.length));
}

// A hunk header, with either count able to be absent. A missing count means one line, which
// is how a unified diff writes a single-line region.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// The hunks of a `unified_diff`, in the shape the whole diff view already speaks.
//
// The one trap is the blank line. `unified_diff` ends with a newline, so splitting on it
// yields a trailing empty string that is not a line of the file at all, while a genuinely
// blank line inside a hunk is written as a single space. Treating a bare empty string as a
// blank context line puts a line into the hunk that its header did not count, and every
// hunk after it is then off by however many it collected.
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

// Which kind of work a Codex tool call is, for the turn's tool mix.
//
// There is no read tool and no search tool: both run as shell commands inside `exec`, so a
// Codex turn's read and search counts stay at zero however much of the repo it read. A
// panel that draws a zero there is saying the tool does not exist, not that the turn used
// it none.
//
// Web searches arrive as separate records and share the activity category table.
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

// The exec sandbox reports a thrown script under this heading. It is not by itself a
// failure: a `tools.shell_command` whose command exits non-zero throws too, and a `grep`
// that matched nothing exits 1 on every successful search. What follows the heading is what
// tells the two apart, so only the ones that are not an exit code are counted. Codex
// records no flag for a failed tool call, and under-reporting a failure is better than a
// card claiming a clean turn went wrong.
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
    // The original collaboration protocol only acknowledged the task name. Its thread
    // identity arrives separately in sub_agent_activity.
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

// What a failed request said, as a sentence a reader can act on.
//
// Most of them are already one. Two of the fifteen recorded on this machine are the
// service's wire envelope instead, with the sentence nested inside it, and a card carrying
// the envelope shows a status code and a type name where it should say that the model is
// not available on this account.
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

// A subagent hands its answer back as a message to whoever spawned it, and that message is
// the only thing a rollout records about the run finishing. There is no completion event.
// The message names its sender as a path, `/root/review_sol`, whose last part is the name
// the spawn asked for.
const FINAL_ANSWER = 'FINAL_ANSWER';

// What the turn is left saying about a subagent whose answer never arrived in the window.
// Not 'running': the turn it belonged to ended, and a card drawing it as work still in
// flight would be wrong about every turn ever recorded. What the rollout supports is that
// the turn launched it, and no more.
const LAUNCHED = 'launched';

interface Entry {
  kind: string;
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
  provider: string | null;
  openingTimestamp: number | null;
  openingSessionId: string | null;
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
  // The ordinal of a compaction still waiting for the settings record that names its billing
  // identity. Cleared when that record arrives, and when the compaction's turn closes without
  // one. Only a compaction whose own usage the record carried ever waits.
  pendingCompactionBilling: number | null;
  // The very first non-copied turn's startedAt, epoch milliseconds. Set once and never moved.
  firstTurnAt: number | null;
  // The most recently closed counted turn's endedAt, or its startedAt if it never completed.
  // Updated on every close, unlike firstTurnAt, since it stands for the latest, not the first.
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
): CodexUsageReducerState {
  return {
    provider,
    openingTimestamp,
    openingSessionId,
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
  while (state.recentTurnIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const turnId = state.recentTurnIds.shift();
    if (!turnId) {
      continue;
    }
    for (const event of state.pendingRequests[turnId] ?? []) {
      released.push(event);
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
    delete state.compactionTurnOrdinals[turnId];
    state.legacyReplayLinks = state.legacyReplayLinks.filter((link) => link.id !== turnId);
  }
  const retainedTurnIds = new Set(state.recentTurnIds);
  for (const turnId of Object.keys(state.pendingRequests)) {
    if (retainedTurnIds.has(turnId)) {
      continue;
    }
    for (const event of state.pendingRequests[turnId]) {
      released.push(event);
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
      released.push(event);
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
  // A local date can still be the previous UTC date near midnight. After midday UTC no
  // supported timezone remains on that date; before then, require a foreign replay record.
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
  const repeated = turnId !== null && state.seenTurnIds[turnId];
  const evidenceOffset = turnId === null ? undefined : state.seenTurnOffsets[turnId];
  const startedAt = recordedTurnStart(payload);
  const copiedByClock =
    startedAt !== null &&
    state.openingTimestamp !== null &&
    startedAt < state.openingTimestamp - CODEX_REPLAY_CLOCK_SLACK_MS;
  if (startedAt !== null && !copiedByClock) {
    state.foreignSessionMeta = false;
  }
  state.currentTurnId = turnId;
  state.currentTurnCopied = repeated || copiedByClock;
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
  if (!turnId || state.copiedTurnIds[turnId]) {
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
    // The retracted turn may have set either boundary, and its own start and end are gone
    // from the state that remains. Reporting a stale span would disagree with the turn
    // count above, so both boundaries drop together and wait for the next turn that counts.
    state.firstTurnAt = null;
    state.lastTurnAt = null;
    state.lastTurnStartedAt = null;
    state.lastTurnOutcome = null;
  }
  discardPendingCodexRequests(state, turnId);
}

function bedrockInferenceClass(model: string | null): UsageEvent['inferenceClass'] {
  if (!model || !/openai\.gpt-5\.6-(?:sol|terra|luna)$/.test(model)) {
    return null;
  }
  if (model.startsWith('global.')) {
    return 'global';
  }
  if (/^[a-z]{2}\./.test(model)) {
    return 'geo';
  }
  return 'in-region';
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
export function reduceCodexUsageEvents(state: CodexUsageReducerState, record: CodexUsageRecord): readonly UsageEvent[] {
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
      state.agentPath = codexAgentPath(payload) ?? state.agentPath;
    }
    state.provider = str(payload.model_provider) ?? state.provider;
    return [];
  }
  if (kind === 'rate_limits') {
    state.planKnown = true;
    state.planType = str(payload.plan_type);
    return [];
  }
  if (kind === 'thread_settings_applied') {
    const settings = (payload.thread_settings || {}) as Record<string, unknown>;
    const model = str(settings.model) ?? str(settings.model_id);
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
    return [];
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
    if (!state.currentTurnCopied) {
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
    if (!state.currentTurnCopied && state.currentTurnId && window !== null) {
      state.turnWindows[state.currentTurnId] = window;
    }
    return [];
  }
  if (kind === 'compacted') {
    if (!state.currentTurnCopied) {
      state.compactionCount++;
      // A compacted record carries the compaction request's own usage. It does not carry that
      // request's billing identity, which current rollouts supply in the following settings
      // record. The model and window this turn ran under are retained, and the provider and
      // service tier are left for a reader that resolves them the way the session reader does.
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
      });
      if (turnId) {
        const ordinals = (state.compactionTurnOrdinals[turnId] ??= []);
        ordinals.push(state.compactionCount);
        while (ordinals.length > RETAINED_COMPACTIONS) {
          ordinals.shift();
        }
      }
      // Only a compaction that billed a request of its own has an identity worth waiting for.
      state.pendingCompactionBilling = requestUsage ? state.compactionCount : null;
    }
    return [];
  }
  if (kind === 'turn_context') {
    applyCodexTurnDate(state, payload);
  }
  if (state.currentTurnId && !state.currentTurnCompleted) {
    const entry = { kind, at: record.timestamp, payload };
    if (kind === 'task_complete' || kind === 'turn_aborted') {
      state.currentTurnCompleted = true;
      // The settings record that names a compaction's billing identity arrives before its own
      // turn closes. After that, a later settings record describes a different request.
      state.pendingCompactionBilling = null;
      if (!state.currentTurnCopied) {
        state.currentTurnEndedAt = record.timestamp;
      }
    }
    if (!state.currentTurnCopied && codexTurnRecordDidSomething(entry, state.agentPath)) {
      state.currentTurnDidSomething = true;
    }
    if (!state.currentTurnCopied && state.currentTurnOutcome) {
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
  if (state.currentTurnCopied) {
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
      return [incomplete];
    }
    if (state.seenClaudeCommands[commandKey] || state.seenClaudeInvocations[result.invocationId]) {
      return [];
    }
    state.seenClaudeCommands[commandKey] = true;
    state.seenClaudeInvocations[result.invocationId] = true;
    const pending = state.pendingClaudeResults[commandKey];
    delete state.pendingClaudeResults[commandKey];
    const replacement = pending
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
    const pending = state.pendingRequests[turnId] ?? [];
    delete state.pendingRequests[turnId];
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
    usage,
    requestKey: `codex:${turnId}:${record.timestamp ?? ''}:${state.requestNumber}`,
  };
  if (!model) {
    (state.pendingRequests[turnId] ??= []).push(event);
    if (record.sourceStart !== undefined) {
      state.pendingRequestSources[event.requestKey] = {
        start: record.sourceStart,
        end: record.sourceEnd ?? record.sourceStart,
      };
    }
    return [];
  }
  return [event];
}

// Kept for callers that process one token_count at a time. Incremental scanners should use
// the plural reducer because one late turn_context can release several held requests.
export function reduceCodexUsageRecord(state: CodexUsageReducerState, record: CodexUsageRecord): UsageEvent | null {
  return reduceCodexUsageEvents(state, record)[0] ?? null;
}

// One line of a rollout, reduced to what kind of record it is and what it carries.
//
// `session_meta`, `turn_context` and `compacted` name themselves on the record. Everything
// else is wrapped in an `event_msg` or a `response_item` and names itself on the payload,
// so the kind is read from whichever of the two said something.
function parseRecord(line: string): Entry | null {
  let o: { type?: string; timestamp?: unknown; payload?: unknown };
  try {
    o = JSON.parse(line) as { type?: string; timestamp?: unknown; payload?: unknown };
  } catch {
    return null;
  }
  const payload = o.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const wrapper = o.type || '';
  const kind = wrapper === 'event_msg' || wrapper === 'response_item' ? String(payload.type || '') : wrapper;
  return { kind, at: stamp(o.timestamp), payload };
}

export function reduceCodexUsageLine(state: CodexUsageReducerState, line: string): UsageEvent | null {
  return reduceCodexUsageLineEvents(state, line)[0] ?? null;
}

export function reduceCodexUsageLineEvents(state: CodexUsageReducerState, line: string): readonly UsageEvent[] {
  // Rollouts are mostly prompts, replies, and tool output. Only these record kinds move
  // request identity or usage, so reject every other line before JSON.parse sees it.
  if (
    !carriesRecord(line) &&
    !/"type"\s*:\s*"(?:session_meta|rate_limits|thread_settings_applied|turn_context|token_count)"/.test(line)
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
  parserKind: 'codex';
  pushLine(line: string): readonly UsageEvent[];
  snapshot(): CodexUsageReducerState;
  pendingRequestKeys(): readonly string[];
  currentToolTurnId(): string | null;
  turnCount(): number;
  compactionCount(): number;
  recentCompactions(): readonly ReducerCompaction[];
  firstTurnAt(): number | null;
  lastTurnAt(): number | null;
  newestTurnStartedAt(): number | null;
  newestTurnOutcome(): TurnOutcome | null;
}

// The current turn counts toward turnCount() as soon as it starts, on the optimistic
// assumption that it will do something before it closes. firstTurnAt() must apply the same
// test, or the span it reports can start before the turn turnCount() actually counted.
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
        // Ledgers written before delayed-context buffering have no pending map.
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
        firstTurnAt: restored.firstTurnAt ?? null,
        lastTurnAt: restored.lastTurnAt ?? null,
        currentTurnStartedAt: restored.currentTurnStartedAt ?? null,
        currentTurnEndedAt: restored.currentTurnEndedAt ?? null,
        currentTurnOutcome: restored.currentTurnOutcome ?? null,
        lastTurnStartedAt: restored.lastTurnStartedAt ?? null,
        lastTurnOutcome: restored.lastTurnOutcome ?? null,
      }
    : emptyCodexUsageReducerState();
  return {
    parserKind: 'codex',
    pushLine: (line) => {
      const events = reduceCodexUsageLineEvents(state, line);
      synchronizeCodexSpendAssociations(state);
      return [...events, ...compactCodexSpendAssociations(state)];
    },
    snapshot: () => JSON.parse(JSON.stringify(state)) as CodexUsageReducerState,
    pendingRequestKeys: () => state.pendingRequestKeys,
    currentToolTurnId: () =>
      state.currentTurnId && !state.currentTurnCopied && !state.currentTurnCompleted ? state.currentTurnId : null,
    turnCount: () => state.closedTurns + (currentCodexTurnCounts(state) ? 1 : 0),
    compactionCount: () => state.compactionCount,
    recentCompactions: () => state.recentCompactions.map((item) => ({ ...item })),
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

// The developer instructions listing every skill Codex can use, and where each one's
// instructions live.
//
// Codex has no skill tool and no read tool. It publishes this list once and then reads a
// `SKILL.md` with an ordinary shell command, so this record is the only one that says which
// files on disk are skills at all. Nothing else in a rollout distinguishes reading a skill
// from reading any other markdown file.
const CODEX_SKILL_CATALOG = '<skills_instructions>';

// One skill the catalog published.
interface CodexSkill {
  name: string;
  description: string;
  // The description before it is cut to the row's length, for a hover that shows it whole.
  fullDescription: string;
  path: string;
  // The same path in the form a command's text is compared against. The catalog writes
  // forward slashes and a shell on Windows writes backslashes, and either can write the
  // drive letter in either case.
  compare: string;
}

// A root of the short paths below, written as `` - `r0` = `C:/Users/dev/.agents/skills` ``.
const CODEX_SKILL_ROOT = /^-\s+`([^`]+)`\s*=\s*`([^`]+)`$/;

// One published skill, written as `- name: description (file: r0/name/SKILL.md)`. A name can
// hold a colon of its own, which a plugin's skill does, so the description starts at the
// first colon with a space after it rather than at the first colon.
const CODEX_SKILL_ENTRY = /^-\s+(\S+?):\s+(.*?)\s+\(file:\s*([^)]+)\)$/;

// The file one catalog entry names. Current catalogs write a short path whose first segment
// names a published root, and older ones write the absolute path itself. A short path naming
// a root the catalog never published resolves to nothing: a skill the panel cannot open is
// better than one it opens in the wrong place.
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
      // One line, cut where a step's detail is cut. The published descriptions run to a
      // paragraph each, and the row under the heading draws one line of it.
      description: shortenTo(firstLine(published), STEP_DETAIL_LIMIT, STEP_CUT),
      fullDescription: published,
      path,
      compare: normalizeFsPath(path),
    });
  }
  return skills;
}

// The programs that exist to print a file. Naming a skill's file anywhere else in a command
// says the file was named, which is not the same as reading it: a search over it, a hash of
// it, and a test that it exists all name it and take none of its instructions.
//
// This list refuses a load it cannot recognize, and the other shape of the rule refuses
// nothing it has not been told about. Measured over this machine's rollouts, June to
// September, commands naming a catalogued file: 27 searched it with `rg`, 17 with
// `Select-String`, 27 hashed it and 20 tested it. Every one of those becomes a skill the card
// says the turn loaded, under a list of programs to refuse. A skill missing from the card is
// the cost of the list that refuses instead, and the sentence under the row promises the
// instructions were read.
const CODEX_FILE_READERS = new Set(['get-content', 'gc', 'cat', 'type', 'head', 'tail', 'sed', 'bat', 'more', 'less']);

// Where one command ends and the next begins. These four characters are the whole of it, and
// the pairs `&&`, `||` and `|&` part on their own characters. A statement that keeps a
// neighbour's text carries a neighbour's program, which is how a search rides in behind a
// reader that never touched the file.
//
// Three candidates were checked and left out. A comma parts a PowerShell argument rather than
// a command, and parting there would break `Get-Content a,b`. A redirection names a file and
// starts nothing. A line continuation, a backtick in PowerShell or a backslash in a POSIX
// shell, joins two lines rather than parting them, and joining those back together is the one
// change here that could turn a silence into a false claim: a line ending inside a path would
// fold a search into whatever reader stood in front of it.
//
// A read reached through a substitution or a variable, as `rg -n TODO $(cat x)` or
// `$x = Get-Content x; rg -n TODO $x`, is not read here. Following a value through a shell is
// more machinery than one row is worth, and what it leaves is the same silence as the script
// loops above.
const CODEX_COMMAND_SEPARATORS = /[\n;|&]/;

// Whether one command read one file, decided at each place the command names it rather than
// once for the whole command. A command that searches one skill's file and reads another is
// ordinary, and either answer taken for the whole command is wrong about one of them.
//
// The shell text is the last resort. The client's own parser resolves a read for roughly two
// mentions in five, and every other one arrives inside a segment it classified as unknown,
// with nothing but the text to read it from.
function commandReadsFile(command: string, compare: string): boolean {
  // A Windows-shaped key is lower case on every platform. A statement starts with its program,
  // not its drive letter, so normalizeFsPath folds its case only on Windows, and a statement
  // read on another platform needs the same fold before the key can match it.
  const windows = /^[a-z]:\//.test(compare);
  for (const statement of command.split(CODEX_COMMAND_SEPARATORS)) {
    const written = statement.trim();
    const searched = normalizeFsPath(written);
    if (!(windows ? searched.toLowerCase() : searched).includes(compare)) {
      continue;
    }
    // What the statement runs, which is its first word unless a quote holds the word together.
    // A Windows program is called through a directory with a space in it often enough that
    // splitting on whitespace alone would lose the name of the program on those lines.
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

// Every catalogued skill one completed command read.
//
// The command is the whole of the evidence, which is why it is best effort: it proves Codex
// read the instructions and says nothing about why Codex selected them. A command that failed
// read nothing worth reporting, and a command the rollout never completed proves nothing yet.
// The match is on the command's own text, never on its output, so a search that prints a
// skill path is not a read of one.
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
      // One command can read several of these files, and every load it made shares the
      // command's identity and clock, because the command is the only record of any of them.
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

// Context the Codex client adds around a turn. Older current-format rollouts do not always
// carry `content_item_kinds`, so the wrapper itself is the only distinction left between
// this product-owned context and text the reader entered.
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

// The text the reader typed, across both rollout shapes Codex has written.
//
// Older versions use `event_msg/user_message`. Current versions use the ordinary message
// response item. The role, input block and `user.text` metadata distinguish the prompt from
// developer instructions, assistant commentary, output blocks and user-role context injected
// before the text the reader wrote.
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

// All whitespace removed, to compare two serializations of the same message that can differ
// only in a trailing newline or in what character joins several content blocks.
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

// The current prompt shape cannot put the generic words `message` or `input_text` into the
// fast list below: both occur on large assistant and tool-output records that the reader is
// deliberately avoiding. Requiring all three markers admits only the user message line.
function carriesUserMessage(line: string): boolean {
  return (
    line.indexOf('user_message') >= 0 ||
    (line.indexOf('"type":"message"') >= 0 && line.indexOf('"role":"user"') >= 0 && line.indexOf('"input_text"') >= 0)
  );
}

interface CompletedCommand {
  command: string;
  detail: string;
  fullDetail: string;
  sourceId: string | null;
  status: 'done' | 'failed';
  cwd: string | null;
  stdout: string;
  startedAt: number | null;
  completedAt: number | null;
  failed: boolean;
  // The files the client's own parser says this command read, in the compared spelling. It
  // classifies a segment as a read and gives the file it resolved, which is the only place a
  // rollout states that a command read a file rather than merely naming one.
  readPaths: readonly string[];
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
  offset: number;
  size: number;
  mtimeMs: number;
  fragment: string;
  fragmentStart: number | null;
  skipLongLine: boolean;
  head: string;
  anchor: string;
  dev: number;
  ino: number;
  parentSessionId: string;
  terminalApplied: boolean;
  openingTimestamp: number | null;
  openingSessionId: string | null;
  foreignSessionMeta: boolean;
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

function bloomIndexes(id: string): number[] {
  const hash = createHash('sha256').update(id).digest();
  return [0, 4, 8, 12].map((at) => hash.readUInt32LE(at) % (CODEX_DISPATCH_BLOOM_BYTES * 8));
}

function dispatchSeen(cursor: CodexDispatchCursor, id: string): boolean {
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

function codexDispatchCursor(head: string, dev: number, ino: number, parentSessionId: string): CodexDispatchCursor {
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

function codexDispatchRecord(
  cursor: CodexDispatchCursor,
  line: string,
  parentSessionId: string,
  retractedToolUseIds: Set<string>,
): void {
  if (!/(?:session_meta|task_started|task_complete|turn_aborted|turn_context|CommandExecution)/.test(line)) return;
  const record = parseRecord(line);
  if (!record) return;
  const { kind, at, payload } = record;
  if (kind === 'session_meta') {
    const id = str(payload.id) ?? str(payload.session_id);
    if (cursor.openingTimestamp === null) {
      cursor.openingTimestamp = codexReplayBoundaryAt(at, payload);
      cursor.openingSessionId = id;
      cursor.foreignSessionMeta = false;
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
      startedAt < cursor.openingTimestamp - CODEX_REPLAY_CLOCK_SLACK_MS;
    if (startedAt !== null && !oldClock) cursor.foreignSessionMeta = false;
    cursor.currentTurnId = id;
    cursor.currentOccurrence++;
    cursor.currentTurnClassified = false;
    cursor.currentTurnCopied = !!id && (dispatchSeen(cursor, id) || oldClock);
    cursor.lastTurnId = id;
    cursor.lastOccurrence = cursor.currentOccurrence;
    return;
  }
  if (kind === 'turn_context') {
    const id = str(payload.turn_id);
    if (!id || id !== cursor.lastTurnId) return;
    if (recordedDatePredatesOpening(payload.current_date, cursor)) {
      for (const candidate of cursor.candidates) {
        if (candidate.occurrence === cursor.lastOccurrence) {
          for (const toolUseId of candidate.reference.toolUseIds) retractedToolUseIds.add(toolUseId);
        }
      }
      cursor.candidates = cursor.candidates.filter((candidate) => candidate.occurrence !== cursor.lastOccurrence);
      if (cursor.currentTurnId === id) cursor.currentTurnCopied = true;
    } else {
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
  if (kind !== 'item_completed' || cursor.currentTurnCopied || !cursor.currentTurnId) return;
  const item = isRecord(payload.item) ? payload.item : null;
  if (!item || item.type !== 'CommandExecution' || typeof item.stdout !== 'string') return;
  const id = str(item.id);
  if (!id || cursor.candidates.some((candidate) => candidate.reference.toolUseIds.includes(id))) return;
  const launch = claudeLaunchKind(commandText(item, true), commandShell(item));
  if (!launch || launch.kind === 'native') return;
  const receipts = shellDispatchFromOutput(item.stdout, launch);
  for (const receipt of receipts) {
    if (cursor.candidates.length >= 4096) break;
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

// A cursor stores only accepted launch evidence and replay identity. An append reads its
// new bytes, while a replacement or truncated file starts again from the opening record.
export function scanCodexDispatchReferences(
  file: string,
  parentSessionId: string,
  previous: CodexDispatchCursor | null = null,
  budget = Number.POSITIVE_INFINITY,
  cancelled: () => boolean = () => false,
): {
  cursor: CodexDispatchCursor;
  references: ClaudeDispatchSessionReference[];
  retractedToolUseIds: Set<string>;
  complete: boolean;
  readBytes: number;
} {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const headBuffer = Buffer.alloc(Math.min(stat.size, 256));
    const headBytes = fs.readSync(fd, headBuffer, 0, headBuffer.length, 0);
    const head = createHash('sha256').update(headBuffer.subarray(0, headBytes)).digest('hex');
    const anchorAt = previous ? Math.max(0, previous.offset - 4096) : 0;
    const anchorBytes = previous ? Buffer.alloc(previous.offset - anchorAt) : Buffer.alloc(0);
    if (previous) fs.readSync(fd, anchorBytes, 0, anchorBytes.length, anchorAt);
    const anchor = createHash('sha256').update(anchorBytes).digest('hex');
    const nextByte = Buffer.alloc(1);
    let nextByteRead = 0;
    if (previous && previous.terminalApplied && previous.offset < stat.size) {
      nextByteRead = fs.readSync(fd, nextByte, 0, 1, previous.offset);
    }
    const cursor =
      previous &&
      previous.parentSessionId === parentSessionId &&
      previous.dev === stat.dev &&
      previous.ino === stat.ino &&
      previous.offset <= stat.size &&
      (stat.size > previous.size || (stat.size === previous.size && stat.mtimeMs === previous.mtimeMs)) &&
      previous.head === head &&
      previous.anchor === anchor &&
      (!previous.terminalApplied || previous.offset === stat.size || nextByte[0] === 10 || nextByte[0] === 13)
        ? previous
        : codexDispatchCursor(head, stat.dev, stat.ino, parentSessionId);
    const startOffset = cursor.offset;
    let readBytes = headBytes + anchorBytes.length + nextByteRead;
    const retractedToolUseIds = new Set<string>();
    while (cursor.offset < stat.size && readBytes < budget && !cancelled()) {
      const replayBytes = cursor.fragmentStart === null ? 0 : cursor.offset - cursor.fragmentStart;
      const available = budget - readBytes - replayBytes - 4096;
      const size = Math.min(256 * 1024, stat.size - cursor.offset, available);
      if (size <= 0) break;
      const bytes = Buffer.allocUnsafe(size);
      const count = fs.readSync(fd, bytes, 0, size, cursor.offset);
      if (count <= 0) break;
      cursor.offset += count;
      readBytes += count;
      let fragment = Buffer.from(cursor.fragment, 'base64');
      if (cursor.fragmentStart !== null) {
        fragment = Buffer.alloc(cursor.offset - count - cursor.fragmentStart);
        fs.readSync(fd, fragment, 0, fragment.length, cursor.fragmentStart);
        readBytes += fragment.length;
        cursor.fragmentStart = null;
      }
      const joined = Buffer.concat([fragment, bytes.subarray(0, count)]);
      let start = 0;
      for (let index = 0; index < joined.length; index++) {
        if (joined[index] !== 10) continue;
        if (!cursor.skipLongLine && !cursor.terminalApplied && index - start <= 4 * 1024 * 1024) {
          codexDispatchRecord(cursor, joined.toString('utf8', start, index), parentSessionId, retractedToolUseIds);
        }
        cursor.terminalApplied = false;
        cursor.skipLongLine = false;
        start = index + 1;
      }
      const remaining = joined.subarray(start);
      if (remaining.length > 4 * 1024 * 1024) {
        cursor.fragment = '';
        cursor.skipLongLine = true;
      } else {
        cursor.fragment = remaining.toString('base64');
      }
    }
    if (cursor.offset === stat.size && cursor.fragment && !cursor.terminalApplied && !cursor.skipLongLine) {
      const terminal = Buffer.from(cursor.fragment, 'base64').toString('utf8');
      if (parseRecord(terminal)) {
        codexDispatchRecord(cursor, terminal, parentSessionId, retractedToolUseIds);
        cursor.terminalApplied = true;
      }
    }
    if (cursor.fragment && Buffer.byteLength(cursor.fragment, 'base64') > 4096) {
      const bytes = Buffer.from(cursor.fragment, 'base64');
      if (!cursor.terminalApplied) cursor.fragmentStart = cursor.offset - bytes.length;
      cursor.fragment = '';
    }
    if (cursor.offset !== startOffset) {
      const anchorStart = Math.max(0, cursor.offset - 4096);
      const anchorBuffer = Buffer.alloc(cursor.offset - anchorStart);
      fs.readSync(fd, anchorBuffer, 0, anchorBuffer.length, anchorStart);
      readBytes += anchorBuffer.length;
      cursor.anchor = createHash('sha256').update(anchorBuffer).digest('hex');
    }
    cursor.size = stat.size;
    cursor.mtimeMs = stat.mtimeMs;
    const complete =
      cursor.offset === stat.size &&
      ((cursor.fragment === '' && cursor.fragmentStart === null) || cursor.terminalApplied) &&
      !cursor.skipLongLine &&
      !cancelled();
    const references = cursor.candidates
      .filter((candidate) => candidate.classified)
      .map((candidate) => candidate.reference);
    return { cursor, references, retractedToolUseIds, complete, readBytes };
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

function codexChangePaths(changes: unknown): string[] {
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

// One command the exec runtime says it completed.
//
// `parsed_cmd` is the shell text without the runtime executable and its invocation flags.
// Only one parsed command is unambiguous. A direct string in `command` is unambiguous too;
// an argv array without the parsed form is not, because the reader would have to decide
// which elements are shell plumbing and which are the command the reader recognises.
function completedCommand(payload: Record<string, unknown>): CompletedCommand | null {
  const item = payload.item as Record<string, unknown> | undefined;
  if (!item || str(item.type) !== 'CommandExecution') {
    return null;
  }
  const command = commandText(item);
  const detail = stepDetail({ command });
  if (!detail) {
    return null;
  }
  const exit = num(item.exit_code);
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
  const status = str(item.status);
  return {
    command,
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

function completedFileChange(payload: Record<string, unknown>): CompletedFileChange | null {
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

// An assistant message item, read from either an `item_completed` event's nested `item` or
// a `response_item` naming the message directly. `phase` distinguishes commentary written
// while the model worked from the final answer that closed the turn.
function parsedMessageItem(
  payload: Record<string, unknown>,
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
  const text = (blocksText(item.content) || str(item.message) || '').trim();
  return text ? { sourceId: str(item.id), phase: str(item.phase), text } : null;
}

// A message the model sent without ending its turn: `delivery: "async"` on a completed
// `AgentMessage` item, which `request_user_input_async` and `send_message_to_user_async`
// both write with `phase: "final_answer"`. The `item_completed` case reads it as Activity,
// and `parsedFinalAnswer` refuses it in every record shape. A question reads
// as its title with one option per line behind `- `, the text the live wire records for the
// same item id, so a reload draws the row the running turn drew. A message with no titled
// question reads as its own text.
function parsedAsyncMessage(payload: Record<string, unknown>): ParsedUpdate | null {
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
  const text = questions.length ? questions.join('\n\n') : blocksText(item.content).trim();
  return text ? { sourceId: str(item.id), kind: 'commentary', text } : null;
}

// Visible assistant activity only. A final answer is handled by `parsedFinalAnswer` instead,
// and opaque reasoning fields are never copied into the normalized turn.
function parsedUpdate(payload: Record<string, unknown>): ParsedUpdate | null {
  const message = parsedMessageItem(payload);
  if (message) {
    return message.phase === 'commentary'
      ? { sourceId: message.sourceId, kind: 'commentary', text: message.text }
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

// The text of a message the model closed a turn with before a later prompt kept the turn
// open. `task_complete` still supplies the turn's `summary`, so a final answer that matches
// it is the response and every earlier one is kept only so the card can show it as a reply,
// the same way the Claude reader keeps a reply that a later message overtook. A message
// with `delivery: "async"` carries `phase: "final_answer"` without ending the turn, so it is
// never an answer.
function parsedFinalAnswer(payload: Record<string, unknown>): { sourceId: string | null; text: string } | null {
  const item = isRecord(payload.item) ? payload.item : payload;
  if (str(item.delivery) === 'async') {
    return null;
  }
  const message = parsedMessageItem(payload);
  return message && message.phase === 'final_answer' ? { sourceId: message.sourceId, text: message.text } : null;
}

// All billed requests in one spawned Codex rollout. Usage is collected by turn first,
// because a turn's model and its token events are separate records and either can arrive
// first in a format written as an append-only event stream.
function readCodexOwnSpend(file: string): {
  spend: AgentSpend;
  facts: Pick<AgentSpend, 'startedAt' | 'endedAt' | 'toolUses' | 'commits' | 'commitIntents' | 'person'>;
  meta: CodexSessionMeta | null;
  launches: TurnAgent[];
  finished: boolean;
  complete: boolean;
} {
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
  const revision = spendFileVersion(file);
  const child = createCodexSessionReducer(
    meta?.sessionId ?? path.basename(file, path.extname(file)),
    { maxTurns: Number.MAX_SAFE_INTEGER },
    meta,
  );
  const found = scanLines(file, (line) => {
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
  const artifacts = reduceChildArtifacts(
    { turns },
    {
      revision,
      complete: lastLineWhole(lastLine),
      pathKey: normalizeFsPath,
      sameCommit: sameCommitSha,
    },
  );
  // A guardian's duration figure already reads its Started from the payload clock, so its
  // record must open on the same clock. `meta.startedAt` carries that value and the same
  // fallback to the opening record `codexStartedAt` uses, so the record takes Started from
  // the same payload clock its figure starts from. Every other child keeps the span its own
  // turns recorded.
  if (meta && isHiddenThread(meta) && meta.startedAt !== null) {
    artifacts.startedAt = meta.startedAt;
  }
  const spend: AgentSpend = found
    ? {
        models: [...byIdentity.values()],
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
): string {
  if (dependencies) {
    const sources = new Map([file, ...dependencies].map((source) => [index.sourceKey(source), source]));
    return [
      'codex-aggregate',
      `source:${JSON.stringify([knownThreadId ?? index.threadOf(file), index.contains(file)])}`,
      ...(index.relationshipVersion ? [index.relationshipVersion] : []),
      ...[...sources].map(([key, source]) => `${key}:${spendFileVersion(source)}`),
    ]
      .sort()
      .join('\n');
  }
  const versions = ['codex-aggregate', spendFileVersion(file)];
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
// pricing parts intact and leaves effort and artifacts owned by the direct child.
export function codexAgentSpendReader(
  index: CodexSpendIndex,
  loadOwn = readCodexOwnSpend,
  visitOwn?: (file: string, parsed: ReturnType<typeof readCodexOwnSpend>) => void,
): (file: string) => AgentSpend {
  const own = new Map<string, ReturnType<typeof readCodexOwnSpend>>();
  const identity = (value: ModelSpend) =>
    JSON.stringify([
      value.model,
      value.provider ?? null,
      value.contextWindow ?? null,
      value.costBasis ?? null,
      [...new Set(value.usageParts?.map((usage) => usage.linkedInvocationId ?? null) ?? [])].sort(),
    ]);
  return (file) => {
    const visited = new Set<string>();
    const active = new Set<string>();
    const ancestors = new Set<string>();
    const read = (source: string, edge?: CodexSubagentFile): AgentSpend => {
      const key = index.sourceKey(source);
      if (visited.has(key)) return { models: [], found: true, partial: active.has(key), effort: null };
      visited.add(key);
      active.add(key);
      let parsed = own.get(key);
      if (!parsed) {
        parsed = loadOwn(source);
        own.set(key, parsed);
      }
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
        const nested = read(child.file, child);
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
    return read(file);
  };
}

export function readCodexAgentSpend(file: string, children: readonly CodexSubagentFile[] = []): AgentSpend {
  return codexAgentSpendReader(codexSpendIndex(children))(file);
}

export interface CodexPersonScan {
  bytes: number;
  fragment: Buffer;
  person: boolean;
  prompts: Array<{ turn: string | null; count: number }>;
  prompt: { text: string; at: number; kind: string; turn: string | null } | null;
  usage: CodexUsageReducerState;
}

function codexPersonRecord(scan: CodexPersonScan, record: Entry): void {
  reduceCodexUsageEvents(scan.usage, { kind: record.kind, timestamp: record.at, payload: record.payload });
  scan.prompts = scan.prompts.filter((entry) => !entry.turn || !scan.usage.datedCopiedTurnIds[entry.turn]);
  scan.person = scan.prompts.reduce((sum, entry) => sum + entry.count, 0) > 1;
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
  scan.person = scan.prompts.reduce((sum, entry) => sum + entry.count, 0) > 1;
  scan.prompt = { text, at: record.at, kind: record.kind, turn };
}

export function scanForCodexPerson(file: string, size: number, previous?: CodexPersonScan): CodexPersonScan {
  const meta = previous && previous.bytes <= size ? null : readCodexSessionMeta(file);
  const scan: CodexPersonScan =
    previous && previous.bytes <= size
      ? previous
      : {
          bytes: 0,
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
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.allocUnsafe(Math.min(Math.max(0, size - scan.bytes), 256 * 1024));
    const read = fs.readSync(fd, chunk, 0, chunk.length, scan.bytes);
    scan.bytes += read;
    const bytes = Buffer.concat([scan.fragment, chunk.subarray(0, read)]);
    const end = bytes.lastIndexOf(0x0a);
    scan.fragment = Buffer.from(bytes.subarray(end + 1));
    if (end >= 0) {
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
        const record = parseRecord(line);
        if (record) codexPersonRecord(scan, record);
      }
    }
  } catch {
    /* unreadable sources retain their last complete prompt evidence */
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
  return scan;
}

const codexDispatchOwnSpends = new Map<string, { key: string; value: ReturnType<typeof readCodexOwnSpend> }>();

export function readCodexDispatchedSpend(
  files: readonly string[],
  children: readonly CodexSubagentFile[] = [],
  now = Date.now(),
  dependencies?: (files: string[]) => void,
): AgentSpend {
  const index = codexSpendIndex(children);
  const unique = [...new Map(files.map((file) => [index.sourceKey(file), file])).values()];
  const visitedFiles: string[] = [];
  const loadOwn = (file: string) => {
    visitedFiles.push(file);
    const version = spendFileVersion(file);
    const band = openSpendBand(version, now);
    const key = band === null ? version : `open:${band}`;
    const canonical = index.sourceKey(file);
    let held = codexDispatchOwnSpends.get(canonical);
    if (!held || held.key !== key) {
      held = { key, value: readCodexOwnSpend(file) };
      codexDispatchOwnSpends.delete(canonical);
      codexDispatchOwnSpends.set(canonical, held);
      while (codexDispatchOwnSpends.size > 200)
        codexDispatchOwnSpends.delete(codexDispatchOwnSpends.keys().next().value!);
    }
    return held.value;
  };
  const spends: AgentSpend[] = [];
  const verifiedFiles: string[] = [];
  const aggregate = unique[0]
    ? codexAgentSpendReader(index, loadOwn, (file, parsed) => {
        verifiedFiles.push(file);
        const spend = { ...structuredClone(parsed.spend), ...parsed.facts };
        spend.partial ||= !parsed.finished;
        if (spend.artifacts) spend.artifacts.complete &&= parsed.finished;
        spends.push(spend);
      })(unique[0])
    : null;
  dependencies?.(visitedFiles);
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

// The child file one row names. The thread id is the exact association. The path is only a
// fallback for older tails that did not reach the activity event carrying that id, and it is
// accepted only when one child under the parent has that path.
export function codexSubagentFor(
  children: readonly CodexSubagentFile[],
  parentThreadId: string,
  ref: AgentSpendRef,
): CodexSubagentFile | null {
  return codexSpendIndex(children).resolve(parentThreadId, ref);
}

// A turn being built. `files` is a map so several edits to one file collapse into one row,
// keyed by the compared form of the path rather than the written one: Codex writes the same
// file with either case of drive letter, and two keys would draw it as two files.
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

// Every record kind the reader acts on. A line holding none of these is skipped before it
// reaches JSON.parse, which is what keeps the reasoning blocks and the model's opening
// instructions from being parsed only to be thrown away.
const NEEDLES = [
  'session_meta',
  'task_started',
  'task_complete',
  'turn_aborted',
  'user_message',
  'token_count',
  'patch_apply_end',
  'turn_context',
  'custom_tool_call',
  'function_call',
  'sub_agent_activity',
  'compacted',
  'web_search_call',
  'CommandExecution',
  // The record naming the billing tier and the provider. The usage reader admits it and the
  // session reader did not, so a session on a tier this table cannot price still reached
  // a figure quoted at the standard rate.
  'thread_settings_applied',
  'AgentMessage',
  'Reasoning',
  'item_completed',
  FINAL_ANSWER,
  // The published skill list. Nothing else in a rollout names the files that are skills, so
  // a window that drops this record cannot tell a skill read from any other file read.
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

// Current response items use generic names for assistant prose, so admit only the narrow
// shapes that can become visible activity or a final answer instead of parsing every message
// line. A phased `response_item` message or `event_msg` agent_message needs this check too:
// neither one carries any of the other NEEDLES, so a final answer written only in one of
// those shapes would otherwise never reach the parser that reads its phase.
function carriesAssistantUpdate(line: string): boolean {
  const phased =
    (line.indexOf('"phase":"commentary"') >= 0 || line.indexOf('"phase":"final_answer"') >= 0) &&
    (line.indexOf('"type":"message"') >= 0 || line.indexOf('"type":"agent_message"') >= 0);
  const reasoning =
    line.indexOf('"type":"reasoning"') >= 0 && (line.indexOf('"summary"') >= 0 || line.indexOf('"summary_text"') >= 0);
  return phased || reasoning;
}

// When each turn in the tail of one rollout began, and whether the window reached the start
// of the file. The Claude side's `readSessionTurnStarts`, for a rollout.
//
// A Codex turn's boundary is recorded rather than inferred, so this reads `task_started`
// where the Claude side has to decide what a human prompt is. A turn whose start is inside
// the window and whose prompt is not is still a turn the reader has not seen, and both
// readers answer the same question: how many times did this session begin work.
//
// A turn that recorded nothing is not counted. Compacting and a session left in realtime
// mode can each open and close a turn with nothing inside it. Counting those puts an unread
// mark on a session where no card exists to clear it by opening.
//
// `worthDrawing` itself needs the built turn, which is the parse this exists to avoid, so
// the boundary reader and the incremental index share the record-level equivalent below.
// It admits typed prompts, visible assistant updates, tool calls, visible file changes,
// answered or failed completions, and interruptions.
//
// A completed command is not on the list, though the session reader draws a row from one.
// The call that ran it is a `custom_tool_call`, and a rollout writes that call before the
// command it completes, so the outer call has already counted the turn by then.
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
  // The start being built, held until a record proves the turn did something. A start still
  // held when the window ends is kept: the turn is the one running now, and a running turn
  // that has not yet recorded its prompt is still a turn the reader has not seen.
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
      // `stamp` answers 0 for a time it cannot read, and a 0 would sort as the oldest turn
      // the session ever had, so an unreadable one is dropped rather than counted.
      open = record.at || null;
      continue;
    }
    if (open === null) {
      continue;
    }
    // An answer counts, and an empty one does not: a compaction's own turn closes with no
    // `last_agent_message`, which is exactly the turn being kept out.
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
  // Structural child headers cover background work that has no spawn record in the parent.
  // The reducer attaches one such child only when its opening time belongs to one parsed turn.
  structuralChildren?: readonly CodexSubagentFile[];
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
  version: 13;
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
  // The skills the client published, by name. Session state rather than turn state: the
  // catalog is written before the first turn starts, and the command that reads one of its
  // files can come many turns later, so it is held here and survives a reread of the tail.
  skillCatalog: Map<string, CodexSkill>;
  stepById: Map<string, TurnStep>;
  updateById: Map<string, TurnUpdate>;
  updateByText: Map<string, TurnUpdate>;
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
  // The last lifetime this session recorded. A request that only reads the prefix back
  // names none of its own and still sits inside the one an earlier request bought.
  lastLifetime: CacheLifetime | null;
  lastContextSource: { start: number; end: number } | null;
  lastModel: string | null;
  lastModelSource: { start: number; end: number } | null;
  lastProviderSource: { start: number; end: number } | null;
  lastServiceTierSource: { start: number; end: number } | null;
  updateSequence: number;
  pendingClassification: string[];
  open: SourcedBuilding | null;
  defaultDir: string | null;
  provider: string | null;
  agentPath: string | null;
  opening: { openedAt: number | null; sessionId: string | null };
  // What the retained turns hold on symbol keys and non-enumerable fields, lifted into plain
  // state. `snapshot` writes it, and a reducer built from a restored state puts it back.
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
    version: 13,
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
    answerById: new Map(),
    pendingExec: new Map(),
    launched: new Map(),
    currentSpawns: new Set(),
    byName: new Map(),
    seenClaudeCommands: {},
    usageState: emptyCodexUsageReducerState(provider, replayBoundaryAt, openingSessionId, meta?.agentPath ?? null),
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
    // The request behind that level, dated and priced as itself. A write Codex could not put
    // in a lifetime is held apart as unclassified, so a recorded prompt-cache write is the
    // only thing here that names one. A request that wrote nothing still sits inside the
    // lifetime an earlier one bought.
    //
    // How long that lifetime is belongs to the model, and `pricing.ts` carries it on the price
    // row beside the rate it applies to. OpenAI documents thirty minutes for the GPT-5.6
    // family and GPT-6 only, so a row naming none records none and the panel shows both
    // bounds rather than quoting the cheap rate over a cache that has already gone.
    //
    // The model is read with the same precedence the bookkeeping below uses: this request's own model, then
    // the one its turn context named, then the last model the rollout recorded.
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
  const usageEvents = reduceCodexUsageEvents(state.usageState, {
    kind,
    timestamp: at,
    payload,
    sourceStart: hasSourceOffset ? sourceStart : undefined,
    sourceEnd: hasSourceOffset ? sourceEnd : undefined,
  });
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

  // Read before the open-turn guard below, because the catalog arrives before the first
  // turn starts and is what every later turn's skill reads are recognized by.
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
    if (state.usageState.currentTurnCopied) {
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
    if (id && state.usageState.currentTurnCopied && id === state.usageState.currentTurnId) {
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
    const model = str(settings.model) ?? str(settings.model_id);
    const provider = str(settings.model_provider_id);
    const serviceTier = str(settings.service_tier);
    if (model) {
      state.lastModel = model;
      state.lastModelSource = { start: sourceStart, end: sourceEnd };
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

  if (state.usageState.currentTurnCopied) {
    return;
  }

  if (kind === 'compacted') {
    // Codex replaces the history with the user's own earlier prompts rather than with a
    // summary of it, so there is nothing to render as one. The card can say a compaction
    // happened and how much context it stood at; it does not pretend to know more.
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
    // The old level describes the history that was just replaced. Codex does not record
    // the size of the replacement here, so it cannot remain the session's current
    // level. Automatic compaction can arrive inside an open turn, whose last request
    // otherwise carries the same stale figure through to the completed turn.
    state.lastContext = 0;
    state.lastContextSource = null;
    if (state.open) {
      state.open.contextTokens = 0;
      // The request that set it goes with it. Nothing reads a request whose level is gone,
      // and a fact left behind its own subject is one a later reader has to rule out.
      state.open.contextRequest = undefined;
    }
    boundCodexTurns(state, opts.maxTurns ?? 40);
    return;
  }

  if (kind === 'task_complete' || kind === 'turn_aborted') {
    state.pendingCompactionBilling = null;
  }
  if (!state.open) {
    releaseUsageSources();
    return;
  } // a turn that began before the window; nothing to attach to
  const turn = state.open;
  extendCodexSourceRange(turn, sourceStart, sourceEnd);

  switch (kind) {
    case 'task_complete': {
      // `last_agent_message` and the recorded final_answer can serialize the same message
      // differently: one can carry a trailing newline the other lacks, and a message with
      // several content blocks can be joined with newlines in one and with nothing in the
      // other. `responseAnswerIndex` needs `summary` exactly equal to the answer it came
      // from to keep the response out of the turn's earlier-answers list, so when the two
      // texts agree apart from whitespace, `summary` takes the recorded answer's own text
      // rather than the newly read one. A turn whose last recorded answer is a different
      // message entirely, such as a final_answer read out of order with commentary, keeps
      // reading `last_agent_message` untouched.
      const rawSummary = answerInTaskComplete(record);
      const lastAnswer = turn.answers[turn.answers.length - 1];
      turn.summary =
        lastAnswer && stripWhitespace(lastAnswer.text) === stripWhitespace(rawSummary) ? lastAnswer.text : rawSummary;
      // The request that ended the turn, when one failed: a usage limit reached, or the
      // service refusing the call. It is written as an object rather than as text, and
      // only the message inside it is worth putting on a card.
      const failed = str((payload.error as { message?: unknown } | undefined)?.message);
      turn.error = failedCodexTurn(record) && failed ? errorMessage(failed) : null;
      turn.finished = finishedCodexTurn(record);
      closeCodexTurn(state, opts.maxTurns ?? 40, at);
      break;
    }
    case 'turn_aborted': {
      turn.interrupted = interruptedCodexTurn(record);
      turn.finished = false;
      // `task_complete` never arrives to supply `summary`, so a final answer the turn
      // wrote before the stop would otherwise draw only in Activity while the headline
      // reads as though the turn never answered. The last recorded answer becomes the
      // summary instead, the same text `responseAnswerIndex` then excludes from Activity.
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
      // A turn holds one prompt in nearly every session recorded, but not in all of
      // them, and a second one dropped is a card saying less than the turn was asked.
      // The first one opens the turn and the rest are what the reader typed while it
      // ran, kept apart with their times so the card can draw them where they happened.
      // The Claude reader says the same thing about the same event.
      const raw = userMessage(record);
      if (raw !== null) {
        const asked = codexPrompt(raw);
        if (!asked) {
          break;
        }
        if (!turn.prompt) {
          turn.prompt = asked;
          break;
        }
        turn.laterPrompts.push({ text: asked, at, stepsBefore: turn.stepCount });
        if (turn.laterPrompts.length > TURN_ASK_LIMIT) {
          turn.laterPrompts.shift();
        }
        break;
      }
      const update = parsedUpdate(payload);
      if (update) {
        recordUpdate(turn, state.updateById, state.updateByText, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload);
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
          ...(presented.fullDetail !== undefined ? { fullDetail: presented.fullDetail } : {}),
        });
        break;
      }
      recordChanges(turn, (payload.changes || {}) as Record<string, unknown>);
      const paths = codexChangePaths(payload.changes);
      const presented = presentedStepDetail('apply_patch', { paths });
      recordStep(turn, state.stepById, 'apply_patch', presented.detail, at, '', 'done', {
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
            ...(id ? { sourceId: id } : {}),
            ...(detail.fullDetail !== undefined ? { fullDetail: detail.fullDetail } : {}),
          })
        : null;
      if (recordedName === 'exec' && id && step) {
        state.pendingExec.set(id, { step, expanded: false });
      }
      if (name === 'spawn_agent' && id) {
        const row = recordSpawn(turn, payload);
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
      // Before the pairing below, which decides which Activity row the command expands. A
      // command whose row is ambiguous still ran and still read whatever it read.
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
          readable ? { command: command.command, cwd: command.cwd, at: command.startedAt ?? at } : 'unreadable',
          [],
          readable ? null : state.defaultDir,
          window,
        );
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
            ...(command.sourceId ? { sourceId: command.sourceId } : {}),
            fullDetail: command.fullDetail,
          });
        }
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      const asked = parsedAsyncMessage(payload);
      if (asked) {
        recordUpdate(turn, state.updateById, state.updateByText, asked, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      const update = parsedUpdate(payload);
      if (update) {
        recordUpdate(turn, state.updateById, state.updateByText, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload);
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
      // The output belongs to the outer JavaScript call, while completed-command records
      // have no outer call id and one outer call can run several commands. That is not a
      // sound command-to-output pairing for the commit filter, so legacy Codex output is
      // still read as unreadable and a commit Codex made keeps its row.
      recordCommits(turn, text, at, 'unreadable', [], state.defaultDir);
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
      const update = parsedUpdate(payload);
      if (update) {
        recordUpdate(turn, state.updateById, state.updateByText, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload);
      if (answer) {
        recordAnswer(turn, state.answerById, answer, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      // The commentary the model writes as it works carries no sender, and is not this.
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
      const update = parsedUpdate(payload);
      if (update) {
        recordUpdate(turn, state.updateById, state.updateByText, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload);
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
  );
  const title = normalizeSessionTitle(opts.sessionTitle);
  for (const turn of state.turns) {
    turn.sessionTitle = title;
  }
  return {
    turns: state.turns,
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
  const chunkBytes = 256 * 1024;
  const cutRecordLimit = 1024 * 1024;
  const tail = tailOf(child.file, chunkBytes, true);
  // Include the record cut by the fixed tail. It may be a large terminal record followed by
  // a delayed duplicate, so lifecycle events must be reduced in their original order.
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
  // A guardian can write its opening record after its own first turn starts, so the row counts
  // from the child's start clock rather than from that record.
  const durationMs =
    child.startedAt !== null && endedAt !== null && endedAt >= child.startedAt ? endedAt - child.startedAt : null;
  return { status, durationMs };
}

const CODEX_STRUCTURAL_AGENT = Symbol('codexStructuralAgent');
const CODEX_STRUCTURAL_END = Symbol('codexStructuralEnd');
const CODEX_STRUCTURAL_BASE = Symbol('codexStructuralBase');
interface StructuralAgentBase {
  status: string;
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

// The id of every row this file attached from a child's own opening record. A structured
// clone keeps none of the marks below, so a caller that sends turns across the worker
// boundary reads these ids and names them again on the way back.
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
  agent.codexStructuralBase ??= { status: agent.status, durationMs: agent.durationMs };
  if (agent[CODEX_STRUCTURAL_BASE]) {
    return;
  }
  Object.defineProperty(agent, CODEX_STRUCTURAL_BASE, {
    value: {
      status: agent.status,
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
    agent.durationMs = agent.codexStructuralBase.durationMs;
  }
  const base = agent[CODEX_STRUCTURAL_BASE];
  if (!base) {
    return;
  }
  agent.status = base.status;
  agent.durationMs = base.durationMs;
  agent.spend = base.spend;
  agent.spendFound = base.spendFound;
  agent.spendPartial = base.spendPartial;
  agent.effort = base.effort;
}

// Background Codex work can identify its parent only in the child's opening record. Attach
// that structural edge to one turn by the child's opening clock, while preserving any richer
// row the parent protocol recorded for the same thread id.
function attachCodexStructuralAgents(
  turns: Turn[],
  parentThreadId: string | null,
  children: readonly CodexSubagentFile[] | undefined,
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
      if (!child.backgroundReview) {
        existing.childSessionId = child.threadId;
      } else {
        delete existing.childSessionId;
      }
      const lifecycle = structuralAgentStatus(child);
      if ((existing as StructuralTurnAgent)[CODEX_STRUCTURAL_AGENT]) {
        existing.status = lifecycle.status;
        existing.durationMs = lifecycle.durationMs;
        continue;
      }
      rememberStructuralBase(existing);
      const open =
        existing.status === 'running' || existing.status === 'async_launched' || existing.status === LAUNCHED;
      if (open && lifecycle.status !== 'running') {
        existing.status = lifecycle.status;
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
    const lifecycle = structuralAgentStatus(child);
    const row: StructuralTurnAgent = {
      id: child.threadId,
      description: child.backgroundReview ? 'Background review' : 'agent',
      agentType: child.agentPath,
      model: null,
      effort: null,
      spend: [],
      spendFound: false,
      spendPartial: false,
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

// Reapply child facts to turns retained outside the transcript tail. The host calls this
// when a child or descendant changes without changing its parent rollout.
//
// `structuralIds` names the rows a reader attached from a child's own opening record, for
// turns that crossed a structured clone and lost their mark. Without it those rows read as
// parent-recorded, and a child that finished and started again keeps the finished status.
export function refreshCodexStructuralAgents(
  turns: Turn[],
  parentThreadId: string,
  children: readonly CodexSubagentFile[],
  lookup?: AgentSpendLookup,
  structuralIds?: readonly string[],
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
  attachCodexStructuralAgents(turns, parentThreadId, children);
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

// The snapshot a caller may send across the progressive worker boundary, where a structured
// clone drops every symbol key and non-enumerable field the reducer hangs on its turns.
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
  if (state.version !== 13) {
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
    pushLine: (line) => reduceCodexSessionLine(state, line, sessionId, opts),
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
      refreshCodexStructuralAgents(completed.turns, sessionId, opts.structuralChildren ?? [], opts.agentSpendOf);
      const title = normalizeSessionTitle(opts.sessionTitle);
      for (const turn of completed.turns) {
        turn.sessionTitle = title;
      }
      return completed.turns.map((turn, index) => ({
        turn,
        start: completed.turnRanges[index]?.start ?? 0,
        end: completed.turnRanges[index]?.end ?? 0,
      }));
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
      if (!agent.effort) {
        agent.effort = spend.effort;
      }
      agent.spendFound = spend.found;
      agent.spendPartial = spend.partial;
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

// Whether a turn recorded anything a reader could look at.
//
// Not every `task_started` is work. Compacting opens and closes a turn of its own with no
// prompt, no answer and no tool call inside it, and so does a session that was left in
// realtime mode; a quarter of the turns in the rollouts on this machine are one or the
// other. Drawing them puts an empty card beside the compaction the panel already shows.
//
// Token counts are deliberately not on this list. A compaction turn has them, because
// summarising the session costs tokens, and they are what the compaction card is
// priced from rather than a sign that the turn did something.
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

// One thing the turn did, kept in order. The same rule as the Claude side, in this file
// because a rollout names its calls differently: the arguments of a `function_call` are a
// JSON string, and a `custom_tool_call` carries a JavaScript program the exec sandbox ran
// rather than fields. Only an unambiguous `tools.<name>(` is read from that wrapper. A later
// completed item can replace its preview when the association is unambiguous.
interface StepMetadata {
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
  if (turn.steps.length > TURN_STEP_LIMIT) {
    turn.steps.shift();
  }
  if (id) {
    byId.set(id, step);
  }
  return step;
}

function recordUpdate(
  turn: Building,
  byId: Map<string, TurnUpdate>,
  byText: Map<string, TurnUpdate>,
  parsed: ParsedUpdate,
  at: number,
  sequence: number,
): void {
  const sourceId = parsed.sourceId ?? `${turn.promptId}:${parsed.kind}:${at}:${sequence}`;
  const textKey = `${parsed.kind}:${at}:${parsed.text}`;
  const held = byId.get(sourceId) ?? byText.get(textKey);
  if (held) {
    if (parsed.text.length > held.text.length) {
      held.text = parsed.text;
    }
    held.status = 'done';
    if (sourceId.startsWith('msg_')) {
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
  byId.set(sourceId, update);
  byText.set(textKey, update);
}

// A final answer, kept in the order the turn closed it. Codex writes the same message twice,
// once as an `item_completed` event carrying an `item-N` id and once as the matching
// `response_item` carrying a `msg_...` id, one to ten ms apart, so neither the id nor an
// exact timestamp pairs them the way `recordUpdate` pairs a commentary message. The second
// write of the same text, arriving within the pairing window of the turn's last recorded
// answer with no later prompt between the two, is that same message rather than a new one.
// `responseAnswerIndex` picks the one `task_complete` reused as `summary` back out of this
// list, the same rule the Claude reader uses to keep its response out of its own
// earlier-answers list.
const ANSWER_PAIRING_WINDOW_MS = 2000;

// The turn's last recorded answer, when its text matches and it arrived inside the pairing
// window with no later prompt between the two records. A prompt in between means the reader
// typed between two genuinely separate answers that happen to share text, which stays rare
// enough that this dedup does not need to guard same-text answers any further apart than the
// window.
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

// What a call acted on, from the arguments a rollout wrote as a string. Anything that is
// not the JSON object this expects leaves the detail empty, which is what a step with
// nothing readable to say should say.
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

// A custom exec call is the wrapper used for tools exposed by this client. The completed
// item carries the useful detail for commands and edits, but calls such as update_plan have
// no second record. Keep the nested tool name when the wrapper names exactly one kind of
// tool, so the activity row says what happened instead of showing a bare exec.
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

// A subagent Codex spawned for itself. Its own work goes to a rollout of its own, so
// nothing of it reaches this file except the launch and what the parent was told after.
function recordSpawn(turn: Building, call: Record<string, unknown>): TurnAgent {
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

// The files one applied patch changed. Codex records structured changes in `patch_apply_end`
// and completed `FileChange` items, rather than in the tool call that produced them. The
// plumbing moved once already, from a top-level `apply_patch` call to one made inside the exec sandbox.
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
    // A file added or removed whole carries its text rather than a patch, so the count of
    // lines in that text is the whole of what moved. A trailing newline ends the last line
    // rather than opening another, and an empty file has none at all.
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

// Whether a turn may have changed more files than it recorded.
//
// A file written by shell redirection, by `Set-Content`, or by a script the agent ran leaves
// no `patch_apply_end` behind, and nothing else in a rollout can recover it. So a Codex turn
// that ran commands and recorded no patch is not necessarily a turn that changed nothing,
// and a panel drawing it as a confident zero would be saying more than it knows.
//
// The answer for any other agent is no, and the agent is tested here rather than at the
// call site so that a reader of the mark is told what the question means. Claude Code
// records every edit as a tool result, so a turn of its own that ran commands and changed
// nothing changed nothing.
export function mayHaveUnrecordedEdits(turn: Pick<Turn, 'agent' | 'toolCounts' | 'files'>): boolean {
  return turn.agent === 'codex' && turn.toolCounts.commands > 0 && turn.files.length === 0;
}
