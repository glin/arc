import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { retryingReplace, writeFileAtomically, type ReplacementPolicy } from './atomicfile';
import { arcHome } from './store';
import { payloadSha256, type RequesterIdentity } from './sessionwrites';
import type { LaunchPolicy } from './launchpolicy';
import { canonicalToolPath } from './toolownership';
import { meterRead } from './readmeter';
import { isCompressedRollout } from './compressedrollouts';
import type { ClaudeDispatchSessionReference, SessionFile } from './transcript';

export const DISPATCH_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const DISPATCH_TEXT_LIMIT = 16_000;
const JSON_BYTES = 48 * 1024;
const EVENT_BYTES = JSON_BYTES - 20 * 1024;
const STATUS_BYTES = JSON_BYTES - 4096;
const REPORT_BYTES = 8 * 1024 * 1024;
const CAPTURE_SLICE_BYTES = 64 * 1024;
// The checkpoint holds this many unpublished slices, well inside its read allowance. Later boundaries wait in the queue file.
const PENDING_SLICES = 256;
// Each boundary in the queue file is one fixed-width line: padded JSON, then a checksum of the JSON, then a newline.
const QUEUE_RECORD_BYTES = 128;
const QUEUE_SUM_BYTES = 8;
const QUEUE_BODY_BYTES = QUEUE_RECORD_BYTES - QUEUE_SUM_BYTES - 1;
const queueSum = (body: Uint8Array) => createHash('sha256').update(body).digest('hex').slice(0, QUEUE_SUM_BYTES);
const OWNER = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOKEN = /^[a-f0-9]{64}$/;
type FileIdentity = { dev: string; ino: string };
type CaptureSource = 'stdout.log' | 'stderr.log' | 'native-source.log';
type CaptureCursor = { offset: number; identity: string };
interface CaptureState {
  raw: FileIdentity;
  alias: FileIdentity | null;
  aliasBytes?: number;
  bytes: number;
  sources: Partial<Record<CaptureSource, CaptureCursor>>;
}
type PendingSlice = CaptureCursor & { name: 'stdout.log' | 'stderr.log' };
type SourceCaptureState = CaptureState & {
  sourceFiles: true;
  // Unpublished channel slices in arrival order. The first slice is the one in publication.
  pending?: PendingSlice[];
  // Every queued boundary has a record in `capture-queue.log`, in arrival order. Records from `read` to `end` wait to
  // join `pending`. Records past `end` are boundaries that a capture wrote and did not save.
  // `ends` holds the last position of each channel in the queue file.
  records?: { read: number; end: number; ends: Partial<Record<PendingSlice['name'], number>> };
};
export type DispatchOutcome = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'needs-input' | 'unknown';
export interface DispatchLaunch {
  launchId: string;
  origin: string;
  transport: 'hosted' | 'standalone';
  requester: RequesterIdentity | null;
  policy: LaunchPolicy | null;
  promptSha256: string;
  completion: 'manual' | 'wait';
  alias: string | null;
  aliasParent?: FileIdentity;
  standalone?: StandaloneOptions;
}
export interface StandaloneOptions {
  provider: 'claude' | 'codex';
  command: string;
  args: string[];
  cwd: string;
  model: string;
  effort: string;
  name: string;
  agentRun: boolean;
  background: boolean;
  sessionHint: string | null;
  logAlias: string | null;
  logAliasParent?: FileIdentity;
  deadlineMs: number;
  env?: Record<string, string | null>;
}
export interface StandaloneObservation {
  supervisor: { pid: number; token: string };
  worker: { pid: number; command: string; argsSha256: string; startedAt: string; commandLineSha256: string } | null;
  launcher?: StandaloneObservation['worker'];
  sessionId: string | null;
  exitCode: number | null;
  signal: string | null;
  monitor: 'starting' | 'observing' | 'finished' | 'unavailable' | 'timed-out';
  reason?: string;
}
export interface StandaloneStartup {
  file: string;
  identity: string;
  ancestor: string;
  directory: string;
  cwd: string;
  bytes: number;
  sha256: string;
}
export interface StandaloneSourceBaseline {
  root: string;
  ancestor: string;
  directory: string;
  cwd: string;
  state: 'ready' | 'unavailable';
  binary?: { file: string; identity: string; bytes: number; count: number; sha256: string };
}
export interface DispatchEvent {
  launchId: string;
  eventId: string;
  assignment: 1;
  outcome: DispatchOutcome;
  availability: 'pending' | 'available' | 'unavailable';
  nativeEnding: unknown;
  askId: string | null;
  report: { path: string; sha256: string; bytes: number } | null;
}
interface Anchor {
  launchId: string;
  directory: FileIdentity;
  receipt: FileIdentity;
  sha256: string;
}
interface EventState {
  owner?: string;
  token?: string;
  disposition?: string;
  dispositionSha256?: string;
}

class DispatchPathRedirected extends Error {
  constructor() {
    super('The dispatch path is redirected.');
  }
}
type LockHold = { owner?: string; keep: () => boolean };

// An alias publication that failed, or waits behind an earlier unpublished slice, keeps its slice queued for a retry.
export class CapturePublicationPending extends Error {
  readonly code = 'EPERM';
  constructor(cause?: unknown) {
    super('The requested log is temporarily unavailable.', { cause });
  }
}
// A lookup of the lost order marker that failed leaves the order of new output unknown for a retry. The saved queue
// keeps its known order and can still publish.
export class CaptureOrderPending extends Error {
  readonly code = 'EPERM';
  constructor(cause?: unknown) {
    super('The requested log is temporarily unavailable.', { cause });
  }
}
// A lookup of the lost order marker that failed with a fault outside the transient set leaves the order of new output
// unknown. The flush catches it only at the deferral of the saved queue. The error ends capture only at a live
// capture's final drain or in the producer loop, because the 50 ms timer flush retries. The error writes no marker,
// so without held boundaries a later recovery looks the marker up again. A capture that closes with held boundaries
// still marks the order lost, unless its close retry saves them.
export class CaptureOrderUnknown extends Error {
  constructor(cause: unknown) {
    super('The requested log order cannot be checked.', { cause });
  }
}
function identity(file: string): FileIdentity {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink()) throw new DispatchPathRedirected();
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function equalIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
export function safeDispatchPath(file: string, platform = process.platform): void {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalized = (value: string) =>
    platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  let current = paths.resolve(file);
  while (true) {
    if ([os.homedir(), os.tmpdir()].some((base) => normalized(current) === normalized(base))) break;
    if (platform === 'darwin' && current === '/tmp' && fs.realpathSync.native(current) === '/private/tmp') break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new DispatchPathRedirected();
    const parent = paths.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
const safePath = safeDispatchPath;
export function outsideDispatchStorage(root: string, file: string, platform = process.platform): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const relative = paths.relative(root, file);
  return (
    paths.isAbsolute(file) && (paths.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${paths.sep}`))
  );
}
class DispatchFileChanged extends Error {}

function read(file: string, limit = JSON_BYTES, exactSize = false): string {
  safePath(file);
  const before = identity(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(limit)) throw new Error('The dispatch file is unavailable or replaced.');
    if (!equalIdentity(before, { dev: String(stat.dev), ino: String(stat.ino) }))
      throw new DispatchFileChanged('The dispatch file is unavailable or replaced.');
    const buffer = Buffer.alloc((exactSize ? Number(stat.size) : limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit || (exactSize && length > Number(stat.size)))
      throw new Error('The dispatch file exceeds its read allowance.');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    if (!equalIdentity(before, identity(file)))
      throw new DispatchFileChanged('The dispatch file changed during the read.');
    if (Buffer.byteLength(text) > limit) throw new Error('The dispatch file changed during the read.');
    return text;
  } finally {
    fs.closeSync(fd);
  }
}
function readChanging(file: string): string {
  try {
    return read(file);
  } catch (error) {
    if (error instanceof DispatchFileChanged)
      throw new Error('The dispatch write changed during recovery. Try again.', { cause: error });
    throw error;
  }
}
function exclusive(file: string, text: string): void {
  safePath(path.dirname(file));
  fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
// Access and sharing faults that clear when another process, such as a scanner or a sync client, releases the file.
const TRANSIENT_FAULTS = ['EPERM', 'EACCES', 'EBUSY'];
// A marker that exists, as any file type, stays written. Only a confirmed absence counts as no marker. A failed lookup
// settles neither and writes nothing. After a transient fault the caller retries. Any other fault ends capture only
// at a live capture's final drain or in the producer loop, because the 50 ms timer flush retries. A capture without
// held boundaries writes no marker, and a capture that closes with held boundaries writes it unless its close retry
// saves them.
function marked(file: string): boolean {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  } catch (cause) {
    if (TRANSIENT_FAULTS.includes((cause as NodeJS.ErrnoException).code ?? '')) throw new CaptureOrderPending(cause);
    throw new CaptureOrderUnknown(cause);
  }
}
function mark(file: string, text: string): void {
  try {
    exclusive(file, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
function validId(id: string): void {
  if (!DISPATCH_ID.test(id)) throw new Error('The dispatch identity is invalid.');
}
function statusLaunch(launch: DispatchLaunch) {
  return {
    launchId: launch.launchId,
    transport: launch.transport,
    completion: launch.completion,
    origin: launch.origin,
  };
}

export interface DispatchRelationshipAllowance {
  entries: number;
  bytes: number;
  checks: number;
}
// The requester and dispatched session that a receipt names, which its catalog lookup matches by provider and session ID.
// A launch rejected at its requester names no dispatched session, because its read stopped before the accepted record.
export interface DispatchRelationshipIdentities {
  requester: { agent: 'claude' | 'codex'; sessionId: string };
  child?: { agent: 'claude' | 'codex'; sessionId: string };
}
export interface DispatchRelationshipStep extends DispatchRelationshipAllowance {
  reference?: ClaudeDispatchSessionReference;
  refusal?: { error: unknown } & ({ launchId: string } | { storeOpened: boolean });
  // The final step of one launch names it. Identities are present when its read reached a catalog lookup.
  launchId?: string;
  identities?: DispatchRelationshipIdentities;
}

type RelationshipScan<T> = Generator<DispatchRelationshipStep, T, DispatchRelationshipAllowance>;

// The root directory revisions observed before a complete receipt scan.
export interface DispatchStoreRevision {
  store: string;
}
// A write inside this margin of a stat can keep the directory's modification time on a filesystem with coarse times, so a
// directory this young proves nothing about the next write.
const STORE_REVISION_MARGIN_MS = 2_000;
function relationshipRevision(stat: fs.BigIntStats | null): string | null {
  if (!stat) return null;
  return stat.isDirectory()
    ? `${stat.dev}:${stat.ino}:directory`
    : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
const emptyRelationshipStep = (): DispatchRelationshipStep => ({ entries: 0, bytes: 0, checks: 0 });

// Each next call grants one filesystem operation. Zero grants preserve its position.
class RelationshipReader {
  progress = emptyRelationshipStep();
  refusal: { error: unknown } | null = null;
  identities?: DispatchRelationshipIdentities;
  readonly revisions = new Map<string, string | null>();
  readonly digests = new Map<string, string>();
  private readonly descriptors = new Set<number>();
  constructor(
    readonly signal?: AbortSignal,
    readonly platform = process.platform,
  ) {
    signal?.addEventListener('abort', this.close, { once: true });
  }
  close = (): void => {
    for (const fd of this.descriptors) fs.closeSync(fd);
    this.descriptors.clear();
  };
  dispose(): void {
    this.signal?.removeEventListener('abort', this.close);
    this.close();
  }
  *operation<T>(kind: keyof DispatchRelationshipAllowance, work: (allowance: number) => T): RelationshipScan<T> {
    let allowance = yield this.progress;
    this.progress = emptyRelationshipStep();
    while (!this.signal?.aborted && (!allowance || !Number.isSafeInteger(allowance[kind]) || allowance[kind] < 1))
      allowance = yield emptyRelationshipStep();
    if (this.signal?.aborted) throw new Error('The dispatch relationship scan stopped.');
    if (kind !== 'bytes') this.progress[kind] = 1;
    try {
      return work(allowance[kind]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (!this.signal?.aborted && code !== 'ENOENT' && code !== 'ENOTDIR') this.refusal ??= { error };
      throw error;
    }
  }
  *stat(file: string): RelationshipScan<fs.BigIntStats | null> {
    const stat = yield* this.operation('checks', () => {
      try {
        return fs.lstatSync(file, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    });
    if (stat?.isSymbolicLink()) throw new DispatchPathRedirected();
    const revision = relationshipRevision(stat);
    if (this.revisions.has(file) && this.revisions.get(file) !== revision)
      throw new Error('The dispatch relationship evidence changed.');
    this.revisions.set(file, revision);
    return stat;
  }
  *path(file: string, allowMissing = false): RelationshipScan<void> {
    // safeDispatchPath owns the synchronous counterpart of this resumable path contract.
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    const normalized = (value: string) =>
      this.platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
    for (let current = paths.resolve(file); ; current = paths.dirname(current)) {
      if ([os.homedir(), os.tmpdir()].some((base) => normalized(current) === normalized(base))) break;
      if (this.platform === 'darwin' && current === '/tmp') {
        const physical = yield* this.operation('checks', () => fs.realpathSync.native(current));
        if (physical === '/private/tmp') break;
      }
      if (!(yield* this.stat(current)) && !allowMissing)
        throw new Error('The dispatch relationship path is unavailable.');
      if (current === paths.dirname(current)) break;
    }
  }
  *read(file: string, prefix?: StandaloneStartup): RelationshipScan<string> {
    yield* this.path(file);
    const before = yield* this.stat(file);
    if (!before?.isFile() || (!prefix && before.size > BigInt(JSON_BYTES)))
      throw new Error('The dispatch relationship file is unavailable.');
    const fd = yield* this.operation('checks', () => {
      const opened = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      this.descriptors.add(opened);
      if (this.signal?.aborted) {
        this.close();
        throw new Error('The dispatch relationship scan stopped.');
      }
      return opened;
    });
    try {
      const stat = yield* this.operation('checks', () => fs.fstatSync(fd, { bigint: true }));
      if (stat.dev !== before.dev || stat.ino !== before.ino || !stat.isFile())
        throw new Error('The dispatch relationship file was replaced.');
      if (!prefix && stat.size > BigInt(JSON_BYTES)) throw new Error('The dispatch relationship file is unavailable.');
      const length = prefix ? prefix.bytes : Number(stat.size);
      if (prefix && (`${stat.dev}:${stat.ino}` !== prefix.identity || stat.size < BigInt(length)))
        throw new Error('The original dispatch source changed.');
      if (prefix && (stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs))
        throw new Error('The dispatch relationship file changed during validation.');
      const chunks: Buffer[] = [];
      const digest = createHash('sha256');
      let position = 0;
      while (position < length) {
        const bytes = yield* this.operation('bytes', (remaining) => {
          const buffer = Buffer.allocUnsafe(Math.min(remaining, 64 * 1024, length - position));
          this.progress.bytes = buffer.length;
          const count = fs.readSync(fd, buffer, 0, buffer.length, position);
          meterRead(file, count, position);
          return buffer.subarray(0, count);
        });
        if (!bytes.length) throw new Error('The dispatch relationship file ended during validation.');
        position += bytes.length;
        digest.update(bytes);
        if (!prefix) chunks.push(bytes);
      }
      const after = yield* this.operation('checks', () => fs.fstatSync(fd, { bigint: true }));
      if (
        !after.isFile() ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        stat.size !== after.size ||
        stat.mtimeNs !== after.mtimeNs ||
        stat.ctimeNs !== after.ctimeNs
      )
        throw new Error('The dispatch relationship file changed during validation.');
      const sha256 = digest.digest('hex');
      if (prefix && sha256 !== prefix.sha256) throw new Error('The original dispatch source changed.');
      yield* this.stat(file);
      this.digests.set(file, sha256);
      return prefix ? '' : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    } finally {
      if (this.descriptors.delete(fd)) fs.closeSync(fd);
    }
  }
  *recheck(): RelationshipScan<void> {
    for (const file of this.revisions.keys()) yield* this.stat(file);
  }
}

// Native records supply response and usage evidence. These files retain launch and consumption identity only.
export class DispatchReceipts {
  readonly root: string;
  private readonly verifiedRelationships = new Map<string, string>();
  private readonly replace: (temporary: string, target: string) => void;
  constructor(
    home = arcHome(),
    readonly platform = process.platform,
    replacement: ReplacementPolicy = {},
  ) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    this.root = paths.join(paths.resolve(home), 'dispatch');
    this.replace = retryingReplace(replacement);
  }
  // The device and inode of the store directory, or an empty string when the directory cannot be read.
  storeIdentity(): string {
    try {
      const stat = fs.statSync(this.root, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return '';
    }
  }
  // The device, inode and modification time of the store and relationship cache directories, or undefined when a directory is
  // too young to prove the next write or cannot be read. Writes inside a launch directory wait for the full pass age bound.
  storeRevision(now = Date.now()): string | undefined {
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    const parts: string[] = [];
    for (const directory of [this.root, paths.dirname(this.relationshipCacheFile(''))]) {
      let stat: fs.BigIntStats | undefined;
      try {
        stat = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
      } catch {
        return undefined;
      }
      if (stat && (!stat.isDirectory() || Number(stat.mtimeMs) > now - STORE_REVISION_MARGIN_MS)) return undefined;
      parts.push(stat ? `${stat.dev}:${stat.ino}:${stat.mtimeNs}` : '');
    }
    return parts.join('\0');
  }
  private relationshipCacheFile(id: string): string {
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    return paths.join(paths.dirname(this.root), 'cache', 'dispatch-relationships', `${id}.json`);
  }
  // Callers publish completed verification separately from receipt discovery.
  checkpointRelationships(): void {
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    for (const [id, digest] of this.verifiedRelationships) {
      try {
        const file = this.relationshipCacheFile(id);
        try {
          if (JSON.parse(read(file)) === digest) {
            this.verifiedRelationships.delete(id);
            continue;
          }
        } catch {
          // Missing cache evidence requires a complete verification before publication.
        }
        this.lock(id, () => {
          try {
            if (JSON.parse(read(file)) === digest) return;
          } catch {
            // Publication requires a fresh equality check under the launch write lock.
          }
          const home = paths.dirname(this.root);
          safePath(home);
          for (const directory of [paths.join(home, 'cache'), paths.dirname(file)]) {
            if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
            safePath(directory);
          }
          writeFileAtomically(file, JSON.stringify(digest), this.replace, 0o600, false);
        });
      } catch {
        // Unavailable cache storage leaves the verified relationship in memory.
        continue;
      }
      this.verifiedRelationships.delete(id);
    }
  }
  // The first next call yields without reading. Each later call needs a remaining work allowance.
  *relationship(
    id: string,
    catalog: readonly SessionFile[] | (() => readonly SessionFile[]),
    signal?: AbortSignal,
  ): RelationshipScan<ClaudeDispatchSessionReference | null> {
    const reader = new RelationshipReader(signal, this.platform);
    try {
      const reference = yield* this.readRelationship(id, catalog, reader);
      yield {
        ...reader.progress,
        launchId: id,
        ...(reader.identities ? { identities: reader.identities } : {}),
        ...(reference ? { reference } : {}),
      };
      reader.progress = emptyRelationshipStep();
      return reference;
    } catch {
      yield {
        ...reader.progress,
        launchId: id,
        ...(reader.identities ? { identities: reader.identities } : {}),
        ...(reader.refusal ? { refusal: { ...reader.refusal, launchId: id } } : {}),
      };
      return null;
    } finally {
      reader.dispose();
    }
  }
  // Each iterator is one epoch. New epochs revisit delayed bindings and changed catalog scope.
  *relationships(
    catalog: readonly SessionFile[] | (() => readonly SessionFile[]),
    signal?: AbortSignal,
  ): RelationshipScan<void> {
    const reader = new RelationshipReader(signal, this.platform);
    const launches = new Set<string>();
    let directory: fs.Dir | undefined;
    const close = () => {
      if (directory) {
        directory.closeSync();
        directory = undefined;
      }
    };
    signal?.addEventListener('abort', close, { once: true });
    try {
      yield* reader.path(this.root);
      directory = yield* reader.operation('checks', () => {
        const opened = fs.opendirSync(this.root, { bufferSize: 1 });
        directory = opened;
        if (signal?.aborted) {
          close();
          throw new Error('The dispatch relationship scan stopped.');
        }
        return opened;
      });
      for (;;) {
        const entry = yield* reader.operation('entries', () => directory!.readSync());
        yield reader.progress;
        reader.progress = emptyRelationshipStep();
        if (!entry) break;
        if (!entry.isDirectory() || !DISPATCH_ID.test(entry.name)) continue;
        launches.add(entry.name);
        yield* this.relationship(entry.name, catalog, signal);
      }
      yield reader.progress;
    } catch {
      yield {
        ...reader.progress,
        ...(reader.refusal ? { refusal: { ...reader.refusal, storeOpened: !!directory } } : {}),
      };
    } finally {
      signal?.removeEventListener('abort', close);
      close();
      reader.dispose();
    }
    if (!reader.refusal && !signal?.aborted) yield* this.pruneRelationshipCache(launches, signal);
  }
  private *pruneRelationshipCache(launches: ReadonlySet<string>, signal?: AbortSignal): RelationshipScan<void> {
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    const cache = paths.dirname(this.relationshipCacheFile(''));
    const reader = new RelationshipReader(signal, this.platform);
    let directory: fs.Dir | undefined;
    const close = () => {
      if (directory) {
        directory.closeSync();
        directory = undefined;
      }
    };
    signal?.addEventListener('abort', close, { once: true });
    try {
      yield* reader.path(this.root, true);
      yield* reader.path(cache);
      directory = yield* reader.operation('checks', () => {
        const opened = fs.opendirSync(cache, { bufferSize: 1 });
        directory = opened;
        if (signal?.aborted) {
          close();
          throw new Error('The dispatch relationship scan stopped.');
        }
        return opened;
      });
      for (;;) {
        const entry = yield* reader.operation('entries', () => directory!.readSync());
        if (!entry) break;
        const id = entry.name.slice(0, -5);
        if (!entry.isFile() || !entry.name.endsWith('.json') || !DISPATCH_ID.test(id) || launches.has(id)) continue;
        if (yield* reader.stat(paths.join(this.root, id))) continue;
        yield* reader.operation('checks', () => fs.unlinkSync(paths.join(cache, entry.name)));
        this.verifiedRelationships.delete(id);
      }
    } catch {
      // Later discovery retries unavailable cache cleanup without refusing receipt evidence.
    } finally {
      signal?.removeEventListener('abort', close);
      close();
      reader.dispose();
    }
    yield reader.progress;
  }
  private *readRelationship(
    id: string,
    catalog: readonly SessionFile[] | (() => readonly SessionFile[]),
    reader: RelationshipReader,
  ): RelationshipScan<ClaudeDispatchSessionReference | null> {
    validId(id);
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    const directory = paths.join(this.root, id);
    const file = paths.join(directory, 'receipt.json');
    const anchor = JSON.parse(yield* reader.read(paths.join(this.root, `${id}.json`))) as Anchor;
    const text = yield* reader.read(file);
    const folder = yield* reader.stat(directory);
    const receipt = yield* reader.stat(file);
    if (
      !folder?.isDirectory() ||
      !receipt ||
      anchor.launchId !== id ||
      !equalIdentity(anchor.directory, { dev: String(folder.dev), ino: String(folder.ino) }) ||
      !equalIdentity(anchor.receipt, { dev: String(receipt.dev), ino: String(receipt.ino) }) ||
      payloadSha256(text) !== anchor.sha256
    )
      return null;
    const launch = JSON.parse(text) as DispatchLaunch;
    const options = launch.standalone;
    if (
      launch.launchId !== id ||
      !/^[a-f0-9]{24}$/.test(launch.origin) ||
      launch.transport !== 'standalone' ||
      !options ||
      !launch.requester ||
      !DISPATCH_ID.test(launch.requester.id) ||
      !['claude', 'codex'].includes(launch.requester.provider) ||
      !['claude', 'codex'].includes(options.provider) ||
      typeof options.agentRun !== 'boolean'
    )
      return null;
    const requester = { agent: launch.requester.provider, sessionId: launch.requester.id };
    const sessions = () => (typeof catalog === 'function' ? catalog() : catalog);
    const requesterRows = (rows: readonly SessionFile[]) =>
      rows.filter((value) => value.agent === requester.agent && value.sessionId === requester.sessionId);
    // The catalog lookup needs one row for the requester, so the read ends here without one. The final step names the
    // requester, and a later catalog that changes its rows reads the launch again.
    if (requesterRows(sessions()).length !== 1) {
      reader.identities = { requester };
      return null;
    }
    const binding = function* (kind: 'accepted' | 'startup'): RelationshipScan<Record<string, unknown>> {
      const boundFile = paths.join(directory, `${kind}.json`);
      const boundText = yield* reader.read(boundFile);
      const witness = JSON.parse(yield* reader.read(paths.join(paths.dirname(directory), `${id}.${kind}.json`)));
      const stat = yield* reader.stat(boundFile);
      const value = JSON.parse(boundText);
      if (
        !stat ||
        witness.launchId !== id ||
        witness.sha256 !== payloadSha256(boundText) ||
        !equalIdentity(witness.identity, { dev: String(stat.dev), ino: String(stat.ino) }) ||
        value.launchId !== id
      )
        throw new Error('The committed dispatch identity changed.');
      return value;
    };
    for (const refused of [
      paths.join(directory, 'startup-refused.json'),
      paths.join(this.root, `${id}.startup-refused.json`),
      paths.join(this.root, `${id}.startup-refused.accepting.json`),
    ])
      if (yield* reader.stat(refused)) return null;
    const accepted = yield* binding('accepted');
    if (
      accepted.provider !== options.provider ||
      typeof accepted.sessionId !== 'string' ||
      !DISPATCH_ID.test(accepted.sessionId) ||
      accepted.submissionId !== 1 ||
      accepted.nativeTurnId !== null ||
      (options.sessionHint !== null && options.sessionHint !== accepted.sessionId)
    )
      return null;
    // Either provider needs the producer's durable opening, including older accepted bindings.
    const startup = (yield* binding('startup')) as unknown as StandaloneStartup;
    if (
      ![startup.file, startup.ancestor, startup.cwd].every(
        (value) => typeof value === 'string' && paths.isAbsolute(value),
      ) ||
      ![startup.identity, startup.directory].every((value) => typeof value === 'string' && /^\d+:\d+$/.test(value)) ||
      !Number.isSafeInteger(startup.bytes) ||
      startup.bytes < 1 ||
      startup.bytes > 49 * 1024 * 1024 ||
      !TOKEN.test(startup.sha256)
    )
      return null;
    // The receipt check reads plain transcripts only. A compressed child transcript counts as missing.
    if (isCompressedRollout(startup.file)) return null;
    reader.identities = { requester, child: { agent: options.provider, sessionId: accepted.sessionId } };
    const lookup = () => {
      const rows = sessions();
      const parents = requesterRows(rows);
      const children = rows.filter(
        (value) => value.agent === options.provider && value.sessionId === accepted.sessionId,
      );
      return parents.length === 1 && children.length === 1 ? { parent: parents[0], child: children[0] } : null;
    };
    const scoped = lookup();
    if (!scoped || scoped.child.childTranscript || scoped.parent.sessionId === accepted.sessionId) return null;
    const normalize = (value: string) =>
      this.platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
    if (normalize(startup.file) !== normalize(scoped.child.file)) return null;
    yield* reader.path(startup.ancestor);
    const ancestor = yield* reader.stat(startup.ancestor);
    if (!ancestor?.isDirectory() || `${ancestor.dev}:${ancestor.ino}` !== startup.directory) return null;
    // Bind retained cwd agreement to the exact receipt, witnesses, bindings and their physical identities.
    const verification = payloadSha256(JSON.stringify([this.platform, [...reader.revisions], [...reader.digests]]));
    const cwdPresent = yield* reader.stat(options.cwd);
    yield* reader.path(options.cwd, !cwdPresent);
    if (cwdPresent) {
      const cwd = yield* reader.operation('checks', () => fs.realpathSync.native(options.cwd));
      if (cwd !== startup.cwd) return null;
    } else if (this.verifiedRelationships.get(id) !== verification) {
      const retained = JSON.parse(yield* reader.read(this.relationshipCacheFile(id)));
      if (retained !== verification) return null;
    }
    yield* reader.read(startup.file, startup);
    yield* reader.recheck();
    const current = lookup();
    if (
      reader.signal?.aborted ||
      !current ||
      current.child.childTranscript ||
      normalize(current.child.file) !== normalize(scoped.child.file)
    )
      return null;
    if (cwdPresent) this.verifiedRelationships.set(id, verification);
    return {
      kind: 'dispatch',
      agent: options.provider,
      parentSessionId: current.parent.sessionId,
      sessionId: accepted.sessionId,
      file: current.child.file,
      toolUseIds: [],
      name: options.name,
      owned: !options.agentRun,
    };
  }
  reserve(
    input: Omit<DispatchLaunch, 'launchId' | 'transport'> & { transport?: DispatchLaunch['transport'] },
  ): DispatchLaunch {
    if (
      !/^[a-f0-9]{24}$/.test(input.origin) ||
      !TOKEN.test(input.promptSha256) ||
      (input.requester &&
        (!DISPATCH_ID.test(input.requester.id) || !['claude', 'codex'].includes(input.requester.provider)))
    )
      throw new Error('The dispatch origin or requester is invalid.');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    safePath(this.root);
    if (input.standalone?.logAlias) {
      const alias = input.standalone.logAlias;
      if (!outsideDispatchStorage(canonicalToolPath(this.root), canonicalToolPath(alias)))
        throw new Error('A log alias must stay outside private dispatch storage.');
      safePath(path.dirname(alias));
      if (fs.existsSync(alias)) {
        safePath(alias);
        if (!fs.lstatSync(alias).isFile()) throw new Error('A log alias must name a regular file.');
      }
    }
    if (input.alias) {
      if (input.standalone?.logAlias && canonicalToolPath(input.alias) === canonicalToolPath(input.standalone.logAlias))
        throw new Error('Choose separate paths for the log and final report.');
      if (
        !path.isAbsolute(input.alias) ||
        !outsideDispatchStorage(canonicalToolPath(this.root), canonicalToolPath(input.alias))
      )
        throw new Error('A report alias must stay outside private dispatch storage.');
      safePath(path.dirname(input.alias));
      for (let parent = fs.realpathSync.native(path.dirname(input.alias)); ; parent = path.dirname(parent)) {
        if (equalIdentity(identity(parent), identity(this.root)))
          throw new Error('A report alias must stay outside private dispatch storage.');
        if (parent === path.dirname(parent)) break;
      }
      if (fs.existsSync(input.alias)) {
        safePath(input.alias);
        if (!fs.lstatSync(input.alias).isFile()) throw new Error('A report alias must name a regular file.');
      }
    }
    const launchId = randomUUID();
    const directory = path.join(this.root, launchId);
    const launch: DispatchLaunch = {
      ...input,
      ...(input.standalone?.logAlias
        ? {
            standalone: {
              ...input.standalone,
              logAliasParent: identity(fs.realpathSync.native(path.dirname(input.standalone.logAlias))),
            },
          }
        : {}),
      ...(input.alias ? { aliasParent: identity(fs.realpathSync.native(path.dirname(input.alias))) } : {}),
      launchId,
      transport: input.transport ?? 'hosted',
    };
    const receipt = JSON.stringify(launch);
    if (Buffer.byteLength(receipt) > JSON_BYTES)
      throw new Error('The launch settings are too large for one dispatch receipt. Reduce the selected configuration.');
    this.checkStatusEnvelope(
      launch,
      launch.standalone
        ? {
            supervisor: { pid: Number.MAX_SAFE_INTEGER, token: 'f'.repeat(64) },
            worker: {
              pid: Number.MAX_SAFE_INTEGER,
              command: launch.standalone.command,
              argsSha256: 'f'.repeat(64),
              commandLineSha256: 'f'.repeat(64),
              startedAt: '9999-12-31T23:59:59.9999999+00:00',
            },
            sessionId: 'f'.repeat(36),
            exitCode: Number.MIN_SAFE_INTEGER,
            signal: 'SIGTERM',
            monitor: 'unavailable',
            reason: 'The original worker output is unavailable. No worker was restarted.',
          }
        : null,
    );
    fs.mkdirSync(directory, { mode: 0o700 });
    exclusive(path.join(directory, 'receipt.json'), receipt);
    const anchor: Anchor = {
      launchId,
      directory: identity(directory),
      receipt: identity(path.join(directory, 'receipt.json')),
      sha256: payloadSha256(receipt),
    };
    exclusive(path.join(this.root, `${launchId}.json`), JSON.stringify(anchor));
    exclusive(path.join(directory, 'state.json'), JSON.stringify({ launchId, events: [] }));
    return launch;
  }
  launch(id: string): DispatchLaunch {
    validId(id);
    const anchor = JSON.parse(read(path.join(this.root, `${id}.json`))) as Anchor;
    const directory = path.join(this.root, id);
    const file = path.join(directory, 'receipt.json');
    const text = read(file);
    if (
      anchor.launchId !== id ||
      !equalIdentity(anchor.directory, identity(directory)) ||
      !equalIdentity(anchor.receipt, identity(file)) ||
      payloadSha256(text) !== anchor.sha256
    )
      throw new Error('The authoritative dispatch receipt was replaced.');
    const launch = JSON.parse(text) as DispatchLaunch;
    if (
      launch.launchId !== id ||
      !['hosted', 'standalone'].includes(launch.transport) ||
      !/^[a-f0-9]{24}$/.test(launch.origin)
    )
      throw new Error('The dispatch receipt identity is invalid.');
    return launch;
  }
  input(id: string, text?: string): string {
    const launch = this.launch(id);
    const file = this.file(id, 'prompt.txt');
    if (text !== undefined) {
      if (Buffer.byteLength(text) > 48 * 1024 || payloadSha256(text) !== launch.promptSha256)
        throw new Error('The dispatch prompt does not match its receipt.');
      exclusive(file, text);
    }
    const saved = read(file);
    if (payloadSha256(saved) !== launch.promptSha256) throw new Error('The dispatch prompt changed.');
    return saved;
  }
  artifact(
    id: string,
    name:
      | 'source-paths.bin'
      | 'stdout.log'
      | 'stderr.log'
      | 'worker.log'
      | 'native.log'
      | 'native-source.log'
      | 'native.md'
      | 'attend.sh'
      | 'output-owner.json'
      | 'capture.json'
      | 'capture-queue.log',
  ): string {
    this.launch(id);
    return this.file(id, name);
  }
  private captureSourceFiles(id: string, aliasByteBudget: number, options: StandaloneOptions) {
    const alias = options.logAlias!;
    const checkpoint = this.file(id, 'capture.json');
    const marker = this.artifact(id, 'worker.log');
    const load = () => {
      this.launch(id);
      const state = JSON.parse(readChanging(checkpoint)) as SourceCaptureState;
      if (!state.sourceFiles || !Number.isSafeInteger(state.bytes) || state.bytes < 0)
        throw new Error('The saved log position is unavailable.');
      safePath(marker);
      if (!equalIdentity(state.raw, identity(marker))) throw new Error('The captured worker output was replaced.');
      const sources = Object.entries(state.sources);
      const ends: Partial<Record<CaptureSource, number>> = {};
      if (state.pending !== undefined) {
        if (!Array.isArray(state.pending) || !state.pending.length)
          throw new Error('The saved log position is unavailable.');
        for (const slice of state.pending) {
          if (slice.offset <= (ends[slice.name] ?? state.sources[slice.name]?.offset ?? 0))
            throw new Error('The saved log position is unavailable.');
          ends[slice.name] = slice.offset;
          sources.push([slice.name, slice]);
        }
      }
      if (state.records !== undefined) {
        const { read, end, ends: queued } = state.records;
        if (
          !state.pending ||
          !Number.isSafeInteger(read) ||
          !Number.isSafeInteger(end) ||
          read < 0 ||
          end < read ||
          read % QUEUE_RECORD_BYTES ||
          end % QUEUE_RECORD_BYTES ||
          typeof queued !== 'object' ||
          !queued
        )
          throw new Error('The saved log position is unavailable.');
        // Records already moved into `pending` can share their channel's last position with it.
        for (const [name, offset] of Object.entries(queued) as [CaptureSource, number][]) {
          if (
            (name !== 'stdout.log' && name !== 'stderr.log') ||
            !Number.isSafeInteger(offset) ||
            offset < (ends[name] ?? state.sources[name]?.offset ?? 0)
          )
            throw new Error('The saved log position is unavailable.');
          ends[name] = offset;
        }
      }
      // Each channel is read once, however many queued slices it has.
      const stats = new Map<string, fs.BigIntStats>();
      for (const [name, cursor] of sources) {
        if (name !== 'stdout.log' && name !== 'stderr.log') throw new Error('The log source is invalid.');
        let stat = stats.get(name);
        if (!stat) {
          const file = this.file(id, name);
          safePath(file);
          stat = fs.statSync(file, { bigint: true });
          stats.set(name, stat);
        }
        if (
          !stat.isFile() ||
          `${stat.dev}:${stat.ino}` !== cursor.identity ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0 ||
          stat.size < BigInt(cursor.offset)
        )
          throw new Error('The original worker output was replaced or truncated.');
      }
      return state;
    };
    load();
    // A transient checkpoint or queue file failure keeps the previous checkpoint, and the caller retries.
    const transient = <T>(operation: () => T): T => {
      try {
        return operation();
      } catch (cause) {
        if (!TRANSIENT_FAULTS.includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
        throw Object.assign(new Error('The requested log is temporarily unavailable.', { cause }), { code: 'EPERM' });
      }
    };
    const save = (state: SourceCaptureState) =>
      transient(() => writeFileAtomically(checkpoint, JSON.stringify(state), this.replace, 0o600, false));
    const openAlias = (state: SourceCaptureState) => {
      if (!state.alias) return null;
      try {
        safePath(alias);
        if (
          !equalIdentity(options.logAliasParent!, identity(fs.realpathSync.native(path.dirname(alias)))) ||
          !equalIdentity(state.alias, identity(alias))
        )
          return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof DispatchPathRedirected) return null;
        throw error;
      }
      const fd = fs.openSync(alias, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (
          !stat.isFile() ||
          !equalIdentity(state.alias, { dev: String(stat.dev), ino: String(stat.ino) }) ||
          stat.size < BigInt(state.aliasBytes ?? 0)
        ) {
          fs.closeSync(fd);
          return null;
        }
        return fd;
      } catch (error) {
        fs.closeSync(fd);
        throw error;
      }
    };
    const queueFile = this.file(id, 'capture-queue.log');
    const openQueue = (flags: number) => {
      safePath(path.dirname(queueFile));
      if (fs.existsSync(queueFile)) safePath(queueFile);
      const fd = fs.openSync(queueFile, flags | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      if (!fs.fstatSync(fd).isFile()) {
        fs.closeSync(fd);
        throw new Error('The saved log position is unavailable.');
      }
      return fd;
    };
    // Reads `count` records from `position`, as far as the file reaches. An unreadable record reads as null.
    const readQueue = (position: number, count: number) =>
      transient(() => {
        const buffer = Buffer.alloc(count * QUEUE_RECORD_BYTES);
        const fd = openQueue(fs.constants.O_RDONLY);
        let read = 0;
        try {
          while (read < buffer.length) {
            const bytes = fs.readSync(fd, buffer, read, buffer.length - read, position + read);
            if (!bytes) break;
            read += bytes;
          }
        } finally {
          fs.closeSync(fd);
        }
        return Array.from({ length: Math.floor(read / QUEUE_RECORD_BYTES) }, (_, index): PendingSlice | null => {
          const start = index * QUEUE_RECORD_BYTES;
          const body = buffer.subarray(start, start + QUEUE_BODY_BYTES);
          if (
            buffer[start + QUEUE_RECORD_BYTES - 1] !== 0x0a ||
            buffer.toString('latin1', start + QUEUE_BODY_BYTES, start + QUEUE_RECORD_BYTES - 1) !== queueSum(body)
          )
            return null;
          try {
            const slice = JSON.parse(body.toString('utf8')) as PendingSlice;
            if (
              (slice?.name === 'stdout.log' || slice?.name === 'stderr.log') &&
              Number.isSafeInteger(slice.offset) &&
              typeof slice.identity === 'string'
            )
              return { name: slice.name, offset: slice.offset, identity: slice.identity };
          } catch {
            /* The caller decides what an unreadable record means. */
          }
          return null;
        });
      });
    // A new queue truncates the file, so a record that stops partway never lies over a complete older one.
    const appendQueue = (position: number, slices: readonly PendingSlice[], truncate: boolean) =>
      transient(() => {
        const records = slices.map((slice) => {
          const body = Buffer.from(JSON.stringify(slice).padEnd(QUEUE_BODY_BYTES));
          return Buffer.concat([body, Buffer.from(`${queueSum(body)}\n`)]);
        });
        if (records.some((record) => record.length !== QUEUE_RECORD_BYTES))
          throw new Error('The saved log position is unavailable.');
        const fd = openQueue(fs.constants.O_WRONLY | fs.constants.O_CREAT | (truncate ? fs.constants.O_TRUNC : 0));
        try {
          records.forEach((record, index) => {
            for (let written = 0; written < record.length;) {
              const at = position + index * QUEUE_RECORD_BYTES + written;
              const count = fs.writeSync(fd, record, written, record.length - written, at);
              if (!count) throw new Error('The saved log position is unavailable.');
              written += count;
            }
          });
        } finally {
          fs.closeSync(fd);
        }
      });
    // Output past the last boundary on record has no known place after the boundaries that an ended capture observed
    // and did not write, or after a queue record that stops partway or fails its checksum. The marker stays.
    const lostFile = this.file(id, 'capture-write.lost');
    const orderLost = () => marked(lostFile);
    const loseOrder = () => mark(lostFile, '');
    const queuedEnd = (state: SourceCaptureState, name: PendingSlice['name']) => {
      let offset = state.sources[name]?.offset ?? 0;
      for (const slice of state.pending ?? []) if (slice.name === name) offset = slice.offset;
      return Math.max(offset, state.records?.ends[name] ?? 0);
    };
    // Records past the saved end are boundaries that a capture wrote before a save that never happened, because the
    // capture ended or its save failed. They keep their file order ahead of later output, as far as `limit`.
    // A complete record that does not pass its channel's queued end is left from a queue that drained, and ends them.
    // A record that stops partway or fails its checksum ends them and leaves the order of later output unknown.
    const unsaved = (state: SourceCaptureState, limit = Infinity) => {
      const end = state.records?.end ?? 0;
      const stat = transient(() => fs.statSync(queueFile, { throwIfNoEntry: false }));
      const size = Math.min(stat?.size ?? 0, limit);
      const ends = { 'stdout.log': queuedEnd(state, 'stdout.log'), 'stderr.log': queuedEnd(state, 'stderr.log') };
      const slices: PendingSlice[] = [];
      // The first read takes one record, so a record left from a drained queue costs one record. Each later read doubles.
      for (let position = end, count = 1; position < size; count *= 2) {
        const records = readQueue(position, Math.min(count, Math.ceil((size - position) / QUEUE_RECORD_BYTES)));
        if (!records.length) {
          loseOrder();
          return slices;
        }
        for (const slice of records) {
          if (!slice) {
            loseOrder();
            return slices;
          }
          if (slice.offset <= ends[slice.name]) return slices;
          ends[slice.name] = slice.offset;
          slices.push(slice);
          position += QUEUE_RECORD_BYTES;
        }
      }
      return slices;
    };
    // Each boundary follows its own record in the queue file. A boundary in the last slice's channel extends that
    // slice, and other boundaries start a slice, while the checkpoint has room. Later records wait in the file.
    const enqueue = (state: SourceCaptureState, slice: PendingSlice) => {
      const pending = state.pending!;
      const records = (state.records ??= { read: 0, end: 0, ends: {} });
      const waiting = records.read < records.end;
      records.end += QUEUE_RECORD_BYTES;
      records.ends[slice.name] = slice.offset;
      if (waiting) return;
      const last = pending[pending.length - 1];
      if (pending.length > 1 && last.name === slice.name) last.offset = slice.offset;
      else if (pending.length < PENDING_SLICES) pending.push({ ...slice });
      else return;
      records.read = records.end;
    };
    // Queue file records move into the checkpoint in file order as its slices publish.
    const refill = (state: SourceCaptureState) => {
      const records = state.records;
      if (!records) return;
      const pending = (state.pending ??= []);
      const count = Math.min(PENDING_SLICES - pending.length, (records.end - records.read) / QUEUE_RECORD_BYTES);
      if (count <= 0) return;
      const slices = readQueue(records.read, count);
      if (slices.length < count) throw new Error('The saved log position is unavailable.');
      for (const slice of slices) {
        if (!slice) throw new Error('The saved log position is unavailable.');
        const last = pending[pending.length - 1];
        if (pending.length > 1 && last.name === slice.name) last.offset = slice.offset;
        else pending.push(slice);
      }
      records.read += count * QUEUE_RECORD_BYTES;
    };
    // Boundaries that a failed queue file write did not keep, in arrival order, and the position where they start.
    // The next deferral writes them first. Until then this capture keeps the write lock, so no other capture
    // publishes output that follows them.
    let held: PendingSlice[] = [];
    let heldAt = 0;
    const hold: LockHold = { keep: () => held.length > 0 };
    const capture = {
      delivered: () => load().aliasBytes ?? 0,
      pendingSources: () => load().pending ?? [],
      // Output that arrives behind an unpublished slice joins its queue, so recovery keeps the arrival order of both channels.
      // Each limit queues at most `limit` bytes past the channel's queued end, and never past `end`.
      // All channels join in one checkpoint write.
      defer: (limits: readonly (readonly [name: 'stdout.log' | 'stderr.log', limit: number, end?: number])[]) =>
        this.lock(
          id,
          () => {
            const state = load();
            if (!state.pending) {
              if (!held.length) return;
              // The saved queue drained while the boundaries waited, so they start a new queue file.
              heldAt = 0;
              state.pending = [];
            }
            const stats = new Map<string, fs.BigIntStats>();
            const source = (name: PendingSlice['name']) => {
              let stat = stats.get(name);
              if (!stat) {
                const file = this.artifact(id, name);
                safePath(file);
                stat = fs.statSync(file, { bigint: true });
                const committed = state.sources[name];
                if (!stat.isFile() || (committed && committed.identity !== `${stat.dev}:${stat.ino}`))
                  throw new Error('The original worker output was replaced or truncated.');
                stats.set(name, stat);
              }
              return stat;
            };
            const boundaries = unsaved(state, held.length ? heldAt : Infinity);
            const written = boundaries.length;
            const ends = { 'stdout.log': queuedEnd(state, 'stdout.log'), 'stderr.log': queuedEnd(state, 'stderr.log') };
            for (const slice of boundaries) ends[slice.name] = slice.offset;
            let lookup: unknown;
            let lost = false;
            try {
              lost = orderLost();
            } catch (error) {
              lookup = error;
            }
            // Held boundaries past a lost boundary have no known place either.
            for (const slice of lost ? [] : held)
              if (slice.offset > ends[slice.name]) {
                boundaries.push(slice);
                ends[slice.name] = slice.offset;
              }
            for (const slice of boundaries) {
              const stat = source(slice.name);
              if (slice.identity !== `${stat.dev}:${stat.ino}`)
                throw new Error('The original worker output was replaced or truncated.');
            }
            // Output past a lost boundary joins no queue.
            for (const [name, limit, end = Infinity] of lost ? [] : limits) {
              if (limit <= 0) continue;
              const stat = source(name);
              const offset = Math.min(Number(stat.size), ends[name] + limit, end);
              if (offset > ends[name]) {
                boundaries.push({ name, offset, identity: `${stat.dev}:${stat.ino}` });
                ends[name] = offset;
              }
            }
            held = boundaries.slice(written);
            if (held.length) heldAt = (state.records?.end ?? 0) + written * QUEUE_RECORD_BYTES;
            // A lookup that fails leaves the order unknown. The new boundaries wait in `held` with the write lock, ahead
            // of later output, until a later lookup settles it.
            if (lookup) throw lookup;
            if (!boundaries.length) return;
            // The queue file names each boundary before the checkpoint does, so the next capture finds the boundaries
            // of a save that never happened.
            if (held.length) appendQueue(heldAt, held, !state.records && !written);
            held = [];
            for (const slice of boundaries) enqueue(state, slice);
            save(state);
          },
          'capture-write',
          hold,
          true,
        ),
      cursor: (name: CaptureSource): CaptureCursor => ({ ...(load().sources[name] ?? { offset: 0, identity: '' }) }),
      write: (bytes: Buffer, name?: CaptureSource, cursor?: CaptureCursor) =>
        this.lock(
          id,
          () => {
            const state = load();
            if (!name || name === 'native-source.log' || !cursor || bytes.length > aliasByteBudget)
              throw new Error('The requested log exceeds its byte allowance or has no output file.');
            const file = this.artifact(id, name);
            safePath(file);
            const stat = fs.statSync(file, { bigint: true });
            if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== cursor.identity || stat.size < BigInt(cursor.offset))
              throw new Error('The original worker output was replaced or truncated.');
            const committed = state.sources[name];
            const start = cursor.offset - bytes.length;
            if (
              !Number.isSafeInteger(cursor.offset) ||
              start < 0 ||
              start > (committed?.offset ?? 0) ||
              (committed && committed.identity !== cursor.identity)
            )
              throw new Error('The original worker output position changed.');
            if (committed && cursor.offset <= committed.offset) {
              Object.assign(cursor, committed);
              return;
            }
            bytes = bytes.subarray(Math.max(0, (committed?.offset ?? 0) - start));
            const queue = (state.pending ??= []);
            const queued = queue.length > 0;
            if (queued) {
              if (queue[0].name !== name || cursor.offset > queue[0].offset) throw new CapturePublicationPending();
            } else {
              // Output outside the saved queue waits until a deferral writes the held boundaries.
              if (held.length) throw new CapturePublicationPending();
              if (orderLost()) throw new Error('The requested log is incomplete. Private output remains available.');
              // Save the slice's position before alias publication can fail.
              queue.push({ name, ...cursor });
              save(state);
            }
            // The next slices are read before alias publication, so a record that cannot be read leaves this slice
            // unpublished and the checkpoint unchanged.
            if (cursor.offset === queue[0].offset) {
              queue.shift();
              refill(state);
            }
            // Boundaries that another capture wrote and did not save follow the drained queue.
            if (queued && !queue.length) for (const slice of unsaved(state)) enqueue(state, slice);
            if (!queue.length) {
              delete state.pending;
              delete state.records;
            }
            let fd: number | null = null;
            try {
              fd = openAlias(state);
              if (fd !== null) {
                let written = 0;
                while (written < bytes.length) {
                  const count = fs.writeSync(fd, bytes, written, bytes.length - written, state.bytes + written);
                  if (!count) throw new Error('The requested log write is incomplete.');
                  written += count;
                }
                state.aliasBytes = state.bytes + written;
              } else state.alias = null;
            } catch (cause) {
              // The saved pending slice keeps its position ahead of later channel output.
              throw new CapturePublicationPending(cause);
            } finally {
              if (fd !== null) fs.closeSync(fd);
            }
            state.bytes += bytes.length;
            state.sources[name] = { ...cursor };
            save(state);
            // The checkpoint names no position in the queue file of a drained queue.
            if (queued && !state.pending)
              try {
                safePath(path.dirname(queueFile));
                fs.rmSync(queueFile, { force: true });
              } catch {
                /* A record left behind does not pass its channel's queued end, and the next queue truncates it. */
              }
          },
          'capture-write',
          hold,
        ),
      flushAlias: () => {
        const state = load();
        // A failed checkpoint can leave an alias tail that the next source slice will overwrite.
        if (!state.alias) return false;
        try {
          safePath(alias);
          if (equalIdentity(state.alias, identity(alias)) && fs.statSync(alias).size === (state.aliasBytes ?? 0))
            return false;
        } catch {
          /* The locked check below decides whether the alias remains available. */
        }
        return this.lock(
          id,
          () => {
            const current = load();
            let fd: number | null;
            try {
              fd = openAlias(current);
            } catch {
              // An alias that cannot be opened now, such as one denied or swapped for a link, keeps its tail for a retry.
              return true;
            }
            if (fd !== null) {
              try {
                fs.ftruncateSync(fd, current.aliasBytes ?? 0);
              } catch {
                // A mapped alias can retain an uncommitted tail until its reader releases the view.
                return true;
              } finally {
                fs.closeSync(fd);
              }
            } else if (current.alias) {
              current.alias = null;
              save(current);
            }
            return false;
          },
          'capture-write',
          hold,
        );
      },
      native: (_bytes: Buffer, _cursor?: CaptureCursor) => {
        throw new Error('This launch has no native log capture.');
      },
      // A capture that closes with boundaries it could not write marks the order of later output lost, and then
      // releases the write lock. If the marker write fails, the capture keeps the lock, and the capture that takes the
      // lock after this process ends writes the marker.
      close: () => {
        if (held.length)
          try {
            capture.defer([]);
          } catch {
            /* A failed queue file write keeps the boundaries held, and a failed save leaves them in the file. */
          }
        if (!hold.owner) return;
        try {
          if (held.length) {
            loseOrder();
            held = [];
          }
          this.release(id, 'capture-write', hold.owner, hold);
        } catch {
          /* A lock whose owner process ended admits the next capture. */
        }
      },
    };
    return capture;
  }
  capture(id: string, aliasByteBudget = CAPTURE_SLICE_BYTES, sourceFiles = false) {
    if (!Number.isSafeInteger(aliasByteBudget) || aliasByteBudget <= 0)
      throw new Error('The log byte allowance must be a positive integer.');
    const options = this.launch(id).standalone;
    if (!options?.logAlias) throw new Error('This launch has no requested log.');
    const alias = options.logAlias;
    safePath(path.dirname(alias));
    if (
      !options.logAliasParent ||
      !equalIdentity(options.logAliasParent, identity(fs.realpathSync.native(path.dirname(alias))))
    )
      throw new Error('The log folder was replaced.');
    const rawFile = this.artifact(id, 'worker.log');
    const checkpoint = this.file(id, 'capture.json');
    let state: CaptureState & { sourceFiles?: true } = fs.existsSync(checkpoint)
      ? JSON.parse(readChanging(checkpoint))
      : this.lock(
          id,
          (): CaptureState & { sourceFiles?: true } => {
            if (fs.existsSync(checkpoint)) return JSON.parse(readChanging(checkpoint));
            try {
              // A capture without an alias witness cannot claim its current pathname.
              const existing = fs.existsSync(rawFile);
              if (existing) safePath(rawFile);
              else exclusive(rawFile, '');
              let aliasIdentity: FileIdentity | null = null;
              if (!existing) {
                if (fs.existsSync(alias)) safePath(alias);
                const temporary = path.join(path.dirname(alias), `.arc-log-${randomUUID()}`);
                fs.writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
                try {
                  fs.renameSync(temporary, alias);
                } catch (error) {
                  fs.unlinkSync(temporary);
                  throw error;
                }
                aliasIdentity = identity(alias);
              }
              const initial = {
                ...(sourceFiles && !options.background && !existing ? { sourceFiles: true as const } : {}),
                raw: identity(rawFile),
                alias: aliasIdentity,
                bytes: 0,
                sources: {},
              };
              writeFileAtomically(checkpoint, JSON.stringify(initial), this.replace, 0o600, false);
              return initial;
            } catch (error) {
              // Initialization can retain private output before its alias witness is saved.
              throw new Error('The requested log is unavailable. Private output remains available.', {
                cause: error,
              });
            }
          },
          'capture-write',
        );
    if (state.sourceFiles) return this.captureSourceFiles(id, aliasByteBudget, options);
    safePath(rawFile);
    if (!Number.isSafeInteger(state.bytes) || state.bytes < 0 || !equalIdentity(state.raw, identity(rawFile)))
      throw new Error('The captured worker output was replaced.');
    const raw = fs.openSync(rawFile, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const rawStat = fs.fstatSync(raw, { bigint: true });
      if (!rawStat.isFile() || !equalIdentity(state.raw, { dev: String(rawStat.dev), ino: String(rawStat.ino) }))
        throw new Error('The captured worker output was replaced.');
      if (rawStat.size < BigInt(state.bytes)) throw new Error('The captured worker output was truncated.');
    } catch (error) {
      fs.closeSync(raw);
      throw error;
    }
    const reload = () => {
      const current = JSON.parse(readChanging(checkpoint)) as CaptureState;
      safePath(rawFile);
      if (!equalIdentity(current.raw, identity(rawFile)) || !equalIdentity(state.raw, current.raw))
        throw new Error('The captured worker output was replaced.');
      if (!Number.isSafeInteger(current.bytes) || current.bytes < 0 || fs.fstatSync(raw).size < current.bytes)
        throw new Error('The captured worker output was truncated.');
      state = current;
    };
    const publishAlias = (end = options.background ? state.sources['native-source.log']?.offset : state.bytes) => {
      let source: number | undefined;
      try {
        safePath(alias);
        if (!state.alias || !equalIdentity(state.alias, identity(alias))) return;
        const descriptor = fs.openSync(alias, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          const stat = fs.fstatSync(descriptor, { bigint: true });
          if (!stat.isFile() || !equalIdentity(state.alias, { dev: String(stat.dev), ino: String(stat.ino) })) return;
          if (options.background) {
            const file = this.artifact(id, 'native.log');
            safePath(file);
            source = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          }
          const input = source ?? raw;
          const captured = fs.fstatSync(input);
          end ??= captured.size;
          if (!captured.isFile() || captured.size < end) return;
          let offset = state.aliasBytes ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > end || stat.size < BigInt(offset)) return;
          state.aliasBytes = offset;
          const passEnd = Math.min(end, offset + aliasByteBudget);
          const buffer = Buffer.alloc(Math.min(CAPTURE_SLICE_BYTES, passEnd - offset));
          while (offset < passEnd) {
            const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, passEnd - offset), offset);
            if (!count) return;
            const written = fs.writeSync(descriptor, buffer, 0, count, offset);
            if (!written) return;
            offset += written;
            state.aliasBytes = offset;
          }
          if (offset === end) fs.ftruncateSync(descriptor, end);
        } finally {
          try {
            if (source !== undefined) fs.closeSync(source);
          } finally {
            fs.closeSync(descriptor);
          }
        }
      } catch {
        /* Private channel output remains available after an alias changes. */
      }
    };
    const aliasEnd = () =>
      options.background
        ? (state.sources['native-source.log']?.offset ??
          (fs.existsSync(this.artifact(id, 'native.log')) ? fs.statSync(this.artifact(id, 'native.log')).size : 0))
        : state.bytes;
    let flushed = false;
    const flushAlias = () => {
      if (flushed) {
        try {
          reload();
          const end = aliasEnd();
          const names = options.background ? (['native-source.log'] as const) : (['stdout.log', 'stderr.log'] as const);
          const complete = names.every((name) => {
            const file = this.artifact(id, name);
            const cursor = state.sources[name];
            if (!fs.existsSync(file)) return !cursor;
            safePath(file);
            const stat = fs.statSync(file, { bigint: true });
            return (
              stat.isFile() &&
              stat.size === BigInt(cursor?.offset ?? 0) &&
              (!cursor || cursor.identity === `${stat.dev}:${stat.ino}`)
            );
          });
          if (complete && fs.fstatSync(raw).size === state.bytes) {
            let nativeComplete = !options.background;
            if (options.background) {
              const native = this.artifact(id, 'native.log');
              safePath(native);
              const stat = fs.statSync(native);
              nativeComplete = stat.isFile() && stat.size === end;
            }
            if (nativeComplete) {
              if (!state.alias) return false;
              try {
                safePath(alias);
                if (!equalIdentity(state.alias, identity(alias))) return false;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw error;
              }
              if (state.aliasBytes === end && fs.statSync(alias).size === end) return false;
            }
          }
        } catch {
          /* Changed or unavailable files retain the locked repair path. */
        }
      }
      const pending = this.lock(
        id,
        () => {
          reload();
          fs.ftruncateSync(raw, state.bytes);
          const delivered = state.aliasBytes;
          publishAlias();
          if (state.aliasBytes !== delivered)
            writeFileAtomically(checkpoint, JSON.stringify(state), this.replace, 0o600, false);
          const end = aliasEnd();
          if (!state.alias || (state.aliasBytes ?? 0) >= end) return false;
          try {
            safePath(alias);
            return equalIdentity(state.alias, identity(alias));
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return code === 'EPERM' || code === 'EACCES';
          }
        },
        'capture-write',
      );
      flushed = true;
      return pending;
    };
    try {
      flushAlias();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== 'EEXIST' &&
        code !== 'EPERM' &&
        !/Another process holds this dispatch write|dispatch write changed during recovery/.test(String(error))
      ) {
        fs.closeSync(raw);
        throw error;
      }
    }
    return {
      flushAlias,
      pendingSources: () => [],
      defer: (_limits: readonly (readonly [name: 'stdout.log' | 'stderr.log', limit: number, end?: number])[]) => {},
      delivered: () => {
        reload();
        return state.aliasBytes ?? 0;
      },
      cursor: (name: CaptureSource): CaptureCursor =>
        (() => {
          reload();
          return { ...(state.sources[name] ?? { offset: 0, identity: '' }) };
        })(),
      write: (bytes: Buffer, name?: CaptureSource, cursor?: CaptureCursor) =>
        this.lock(
          id,
          () => {
            reload();
            if (name && cursor) {
              const committed = state.sources[name];
              const start = cursor.offset - bytes.length;
              if (committed) {
                if (committed.identity !== cursor.identity || start > committed.offset)
                  throw new Error('The original worker output position changed.');
                if (cursor.offset <= committed.offset) {
                  Object.assign(cursor, committed);
                  return;
                }
                bytes = bytes.subarray(Math.max(0, committed.offset - start));
              } else if (start !== 0) throw new Error('The original worker output position is unavailable.');
            }
            fs.writeSync(raw, bytes, 0, bytes.length, state.bytes);
            fs.ftruncateSync(raw, state.bytes + bytes.length);
            if (!options.background) publishAlias(state.bytes + bytes.length);
            const next = {
              ...state,
              bytes: state.bytes + bytes.length,
              sources: { ...state.sources, ...(name && cursor ? { [name]: { ...cursor } } : {}) },
            };
            writeFileAtomically(checkpoint, JSON.stringify(next), this.replace, 0o600, false);
            state = next;
          },
          'capture-write',
        ),
      native: (bytes: Buffer, cursor?: CaptureCursor) =>
        this.lock(
          id,
          () => {
            reload();
            const committed = state.sources['native-source.log'];
            if (cursor) {
              const start = cursor.offset - bytes.length;
              if (committed) {
                if (committed.identity !== cursor.identity || start > committed.offset)
                  throw new Error('The original native log position changed.');
                if (cursor.offset <= committed.offset) {
                  Object.assign(cursor, committed);
                  return;
                }
                bytes = bytes.subarray(Math.max(0, committed.offset - start));
              } else if (start !== 0) throw new Error('The original native log position is unavailable.');
            } else if (committed) return;
            const offset = cursor ? (committed?.offset ?? 0) : 0;
            const file = this.artifact(id, 'native.log');
            if (fs.existsSync(file)) safePath(file);
            const descriptor = fs.openSync(
              file,
              fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0),
              0o600,
            );
            try {
              if (!fs.fstatSync(descriptor).isFile() || fs.fstatSync(descriptor).size < offset)
                throw new Error('The captured native log was truncated.');
              fs.writeSync(descriptor, bytes, 0, bytes.length, offset);
              fs.ftruncateSync(descriptor, offset + bytes.length);
            } finally {
              fs.closeSync(descriptor);
            }
            if (!cursor) state.aliasBytes = 0;
            publishAlias(offset + bytes.length);
            const next = {
              ...state,
              sources: { ...state.sources, ...(cursor ? { 'native-source.log': { ...cursor } } : {}) },
            };
            writeFileAtomically(checkpoint, JSON.stringify(next), this.replace, 0o600, false);
            state = next;
          },
          'capture-write',
        ),
      close: () => fs.closeSync(raw),
    };
  }

  observation(id: string, value?: StandaloneObservation): StandaloneObservation | null {
    const launch = this.launch(id);
    if (launch.transport !== 'standalone') return null;
    const file = this.file(id, 'observation.json');
    if (value) {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > JSON_BYTES) throw new Error('The worker observation exceeds its saved allowance.');
      this.checkStatusEnvelope(launch, value);
      this.lock(id, () => writeFileAtomically(file, text, this.replace, 0o600, false));
    }
    return fs.existsSync(file) ? JSON.parse(read(file)) : null;
  }
  scan(id: string, value?: unknown): unknown {
    if (this.launch(id).transport !== 'standalone') return null;
    const file = this.file(id, 'scan.json');
    // Base64 retains one pending frame. Completed evidence includes the report and two copies of its native message identity.
    const frameBytes = 49 * 1024 * 1024;
    const limit = 4 * Math.ceil(frameBytes / 3) + 2 * frameBytes + 6 * REPORT_BYTES + JSON_BYTES;
    if (value !== undefined) {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > limit) throw new Error('The saved output position exceeds its allowance.');
      this.lock(id, () => writeFileAtomically(file, text, this.replace, 0o600, false));
    }
    return fs.existsSync(file) ? JSON.parse(read(file, limit, true)) : null;
  }
  sourceBaseline(id: string, evidence?: StandaloneSourceBaseline): StandaloneSourceBaseline | null {
    if (this.launch(id).transport !== 'standalone') return null;
    const file = this.file(id, 'source-baseline.json');
    if (!evidence && !fs.existsSync(file)) {
      if (
        fs.existsSync(path.join(this.root, `${id}.source-baseline.json`)) ||
        fs.existsSync(path.join(this.root, `${id}.source-baseline.accepting.json`))
      )
        throw new Error('The original session source is unavailable.');
      return null;
    }
    if (!evidence && !fs.existsSync(path.join(this.root, `${id}.source-baseline.json`)))
      throw new Error('The original session source is unavailable.');
    const binding = evidence ? { launchId: id, ...evidence } : JSON.parse(read(file));
    if (
      binding.launchId !== id ||
      ![binding.root, binding.ancestor, binding.cwd].every(
        (value) => typeof value === 'string' && path.isAbsolute(value),
      ) ||
      !/^\d+:\d+$/.test(binding.directory) ||
      !['ready', 'unavailable'].includes(binding.state) ||
      (binding.state === 'ready' &&
        (!binding.binary ||
          binding.binary.file !== this.file(id, 'source-paths.bin') ||
          !/^\d+:\d+$/.test(binding.binary.identity) ||
          !Number.isSafeInteger(binding.binary.count) ||
          binding.binary.count < 0 ||
          binding.binary.bytes !== binding.binary.count * 32 ||
          !TOKEN.test(binding.binary.sha256))) ||
      Buffer.byteLength(JSON.stringify(binding)) > JSON_BYTES
    )
      throw new Error('The original session source is invalid.');
    this.bindIdentity(id, 'source-baseline', binding);
    this.bindIdentity(id, 'source-baseline-witness', {
      launchId: id,
      identity: identity(path.join(this.root, `${id}.source-baseline.json`)),
    });
    return binding;
  }
  sourceCandidate(id: string, evidence?: StandaloneStartup): StandaloneStartup | null {
    const file = this.file(id, 'source-candidate.json');
    if (!evidence && !fs.existsSync(file)) {
      if (
        fs.existsSync(path.join(this.root, `${id}.source-candidate.json`)) ||
        fs.existsSync(path.join(this.root, `${id}.source-candidate.accepting.json`))
      )
        throw new Error('The original session source is unavailable.');
      return null;
    }
    if (!evidence && !fs.existsSync(path.join(this.root, `${id}.source-candidate.json`)))
      throw new Error('The original session source is unavailable.');
    const binding = evidence ? { launchId: id, ...evidence } : JSON.parse(read(file));
    if (
      binding.launchId !== id ||
      ![binding.file, binding.ancestor, binding.cwd].every(
        (value) => typeof value === 'string' && path.isAbsolute(value),
      ) ||
      ![binding.identity, binding.directory].every((value) => typeof value === 'string' && /^\d+:\d+$/.test(value)) ||
      !TOKEN.test(binding.sha256) ||
      Buffer.byteLength(JSON.stringify(binding)) > JSON_BYTES ||
      !Number.isSafeInteger(binding.bytes) ||
      binding.bytes < 1 ||
      binding.bytes > 49 * 1024 * 1024
    )
      throw new Error('The original session source is invalid.');
    this.bindIdentity(id, 'source-candidate', binding);
    return binding;
  }
  startup(id: string, evidence?: StandaloneStartup): StandaloneStartup | null {
    if (this.launch(id).transport !== 'standalone') return null;
    const file = this.file(id, 'startup.json');
    if (
      !evidence &&
      !fs.existsSync(file) &&
      !fs.existsSync(path.join(this.root, `${id}.startup.json`)) &&
      !fs.existsSync(path.join(this.root, `${id}.startup.accepting.json`))
    ) {
      const accepted = this.file(id, 'accepted.json');
      if (
        fs.existsSync(accepted) ||
        fs.existsSync(path.join(this.root, `${id}.accepted.json`)) ||
        fs.existsSync(path.join(this.root, `${id}.accepting.json`))
      ) {
        const binding = JSON.parse(read(accepted));
        this.bindIdentity(id, 'accepted', binding);
        if (binding.startupRequired) throw new Error('The standalone session identity is invalid.');
      }
      return null;
    }
    const binding = evidence ? { launchId: id, ...evidence } : JSON.parse(read(file));
    if (
      binding.launchId !== id ||
      ![binding.file, binding.ancestor, binding.cwd].every(
        (value) => typeof value === 'string' && path.isAbsolute(value),
      ) ||
      ![binding.identity, binding.directory].every((value) => typeof value === 'string' && /^\d+:\d+$/.test(value)) ||
      !Number.isSafeInteger(binding.bytes) ||
      binding.bytes < 1 ||
      binding.bytes > 49 * 1024 * 1024 ||
      !TOKEN.test(binding.sha256)
    )
      throw new Error('The standalone session identity is invalid.');
    this.bindIdentity(id, 'startup', binding);
    return binding;
  }
  startupRefused(id: string, refuse = false): boolean {
    this.launch(id);
    if (
      !refuse &&
      !fs.existsSync(this.file(id, 'startup-refused.json')) &&
      !fs.existsSync(path.join(this.root, `${id}.startup-refused.json`)) &&
      !fs.existsSync(path.join(this.root, `${id}.startup-refused.accepting.json`))
    )
      return false;
    this.bindIdentity(id, 'startup-refused', { launchId: id });
    return true;
  }
  monitor(
    id: string,
    channel: 'monitor' | 'output-monitor' = 'monitor',
  ): { token: string; releaseNative: () => void; release: () => void } {
    if (this.launch(id).transport !== 'standalone') throw new Error('Hosted dispatch has no standalone monitor.');
    const file = this.file(id, `${channel}.json`);
    const token = randomUUID();
    const lock = channel === 'output-monitor' ? channel : 'write';
    this.lock(
      id,
      () => {
        if (fs.existsSync(file)) {
          const owner = JSON.parse(read(file));
          if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !DISPATCH_ID.test(owner.token))
            throw new Error('The dispatch monitor identity is unavailable.');
          if (
            owner.phase !== undefined &&
            (owner.phase !== 'witness-pending' || owner.released !== true || channel !== 'monitor')
          )
            throw new Error('The dispatch monitor identity is unavailable.');
          if (!owner.released || owner.phase === 'witness-pending') {
            let dead = false;
            try {
              process.kill(owner.pid, 0);
            } catch (error) {
              dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
            if (!dead) throw new Error('Another process is observing this dispatch launch.');
          }
        }
        writeFileAtomically(file, JSON.stringify({ pid: process.pid, token }), this.replace, 0o600, false);
      },
      lock,
    );
    const release = (pending: boolean) => {
      if (pending && channel !== 'monitor') throw new Error('This dispatch capture has no pending session source.');
      this.lock(
        id,
        () => {
          const owner = JSON.parse(read(file));
          if (owner.pid !== process.pid || owner.token !== token)
            throw new Error('The dispatch monitor owner changed.');
          const { phase: _phase, ...native } = owner;
          writeFileAtomically(
            file,
            JSON.stringify({ ...native, released: true, ...(pending ? { phase: 'witness-pending' } : {}) }),
            this.replace,
            0o600,
            false,
          );
        },
        lock,
      );
    };
    return {
      token,
      releaseNative: () => release(true),
      release: () => release(false),
    };
  }
  bind(
    id: string,
    binding: {
      provider: 'claude' | 'codex';
      sessionId: string;
      submissionId: number;
      nativeTurnId: string | null;
      startupRequired?: true;
    },
  ): void {
    this.launch(id);
    if (
      !DISPATCH_ID.test(binding.sessionId) ||
      !Number.isSafeInteger(binding.submissionId) ||
      binding.submissionId < 1 ||
      (binding.nativeTurnId !== null &&
        !(binding.provider === 'codex'
          ? typeof binding.nativeTurnId === 'string' &&
            binding.nativeTurnId.length > 0 &&
            binding.nativeTurnId.length <= 4096 &&
            !/[\u0000-\u001f]/.test(binding.nativeTurnId)
          : /^[1-9][0-9]*$/.test(binding.nativeTurnId)))
    )
      throw new Error('The dispatch worker identity is invalid.');
    this.bindIdentity(id, 'accepted', { launchId: id, ...binding });
  }
  background(id: string, backgroundId?: string): string | null {
    const launch = this.launch(id);
    const options = launch.standalone;
    if (launch.transport !== 'standalone' || options?.provider !== 'claude' || !options.background)
      throw new Error('This launch has no Claude background session.');
    const file = this.file(id, 'background.json');
    if (backgroundId === undefined && !fs.existsSync(file)) return null;
    const binding =
      backgroundId === undefined
        ? JSON.parse(read(file))
        : { launchId: id, provider: 'claude', cwd: options.cwd, backgroundId };
    if (
      binding.launchId !== id ||
      binding.provider !== 'claude' ||
      binding.cwd !== options.cwd ||
      typeof binding.backgroundId !== 'string' ||
      !/^(?:[a-f0-9]{8}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.test(binding.backgroundId)
    )
      throw new Error('The Claude background identity is invalid.');
    if (backgroundId === undefined && !fs.existsSync(path.join(this.root, `${id}.background.json`)))
      throw new Error('The Claude background identity is unavailable.');
    this.bindIdentity(id, 'background', binding);
    return binding.backgroundId;
  }
  standaloneSession(id: string, sessionId?: string): string | null {
    const launch = this.launch(id);
    const options = launch.standalone;
    if (launch.transport !== 'standalone' || !options) throw new Error('This launch has no standalone session.');
    const file = this.file(id, 'accepted.json');
    if (sessionId === undefined && !fs.existsSync(file)) return null;
    const startup = fs.existsSync(file) ? null : this.startup(id);
    const binding =
      sessionId === undefined
        ? JSON.parse(read(file))
        : {
            launchId: id,
            provider: options.provider,
            sessionId,
            submissionId: 1,
            nativeTurnId: null,
            ...((fs.existsSync(file) ? JSON.parse(read(file)).startupRequired : startup)
              ? { startupRequired: true as const }
              : {}),
          };
    if (
      binding.launchId !== id ||
      binding.provider !== options.provider ||
      binding.submissionId !== 1 ||
      binding.nativeTurnId !== null ||
      (options.sessionHint !== null && binding.sessionId !== options.sessionHint)
    )
      throw new Error('The standalone session identity is invalid.');
    if (sessionId === undefined && !fs.existsSync(path.join(this.root, `${id}.accepted.json`))) return null;
    this.bind(id, {
      provider: binding.provider,
      sessionId: binding.sessionId,
      submissionId: 1,
      nativeTurnId: null,
      ...(binding.startupRequired ? { startupRequired: true } : {}),
    });
    return binding.sessionId;
  }
  private bindIdentity(
    id: string,
    kind:
      | 'accepted'
      | 'background'
      | 'startup'
      | 'startup-refused'
      | 'source-baseline'
      | 'source-candidate'
      | 'source-baseline-witness',
    binding: unknown,
  ): void {
    const file = this.file(id, `${kind}.json`);
    const text = JSON.stringify(binding);
    const witnessFile = path.join(this.root, `${id}.${kind}.json`);
    const checkWitness = () => {
      if (!fs.existsSync(witnessFile)) return false;
      const witness = JSON.parse(read(witnessFile));
      if (
        witness.launchId !== id ||
        read(file) !== text ||
        witness.sha256 !== payloadSha256(text) ||
        !equalIdentity(witness.identity, identity(file))
      )
        throw new Error('The accepted dispatch turn cannot change.');
      return true;
    };
    if (checkWitness()) return;
    this.lock(id, () => {
      if (checkWitness()) return;
      const intentFile = path.join(this.root, `${id}.${kind === 'accepted' ? 'accepting' : `${kind}.accepting`}.json`);
      if (!fs.existsSync(intentFile)) {
        if (fs.existsSync(file)) throw new Error('The accepted dispatch turn has no retained identity.');
        const name = `${kind}.${randomUUID()}.pending`;
        const prepared = this.file(id, name);
        exclusive(prepared, text);
        exclusive(
          intentFile,
          JSON.stringify({ launchId: id, name, identity: identity(prepared), sha256: payloadSha256(text) }),
        );
      }
      const intent = JSON.parse(read(intentFile));
      if (
        intent.launchId !== id ||
        !new RegExp(`^${kind}[.][a-f0-9-]{36}[.]pending$`).test(intent.name) ||
        intent.sha256 !== payloadSha256(text)
      )
        throw new Error('The accepted dispatch turn cannot change.');
      const prepared = this.file(id, intent.name);
      if (!fs.existsSync(file)) {
        if (read(prepared) !== text || !equalIdentity(intent.identity, identity(prepared)))
          throw new Error('The accepted dispatch turn was replaced.');
        fs.linkSync(prepared, file);
      }
      if (read(file) !== text || !equalIdentity(intent.identity, identity(file)))
        throw new Error('The accepted dispatch turn was replaced.');
      exclusive(witnessFile, JSON.stringify({ launchId: id, identity: intent.identity, sha256: intent.sha256 }));
      if (fs.existsSync(prepared)) fs.unlinkSync(prepared);
    });
  }
  publish(
    id: string,
    input: Omit<DispatchEvent, 'launchId' | 'eventId' | 'assignment' | 'report'>,
    text: string | null,
  ): DispatchEvent {
    const launch = this.launch(id);
    if (text !== null && input.availability !== 'available')
      throw new Error('The dispatch response exceeds its saved report allowance.');
    if (text !== null && Buffer.byteLength(text) > REPORT_BYTES) {
      text = null;
      input = { ...input, availability: 'unavailable' };
    }
    return this.lock(id, () => {
      const state = this.state(id);
      if (state.events.length >= 256) {
        const archive = this.file(id, `state.${state.segment ?? 0}.json`);
        const serializedState = JSON.stringify(state);
        if (fs.existsSync(archive)) {
          if (read(archive, 4 * JSON_BYTES) !== serializedState)
            throw new Error('The retained dispatch events conflict.');
        } else exclusive(archive, serializedState);
        state.segment = (state.segment ?? 0) + 1;
        state.events = [];
      }
      const eventId = randomUUID();
      const reportFile = this.file(id, `${eventId}.md`);
      const report =
        text === null ? null : { path: reportFile, sha256: payloadSha256(text), bytes: Buffer.byteLength(text) };
      if (text !== null) exclusive(reportFile, text);
      const event: DispatchEvent = { ...input, launchId: id, eventId, assignment: 1, report };
      const serialized = JSON.stringify(event);
      if (Buffer.byteLength(serialized) > EVENT_BYTES) throw new Error('The dispatch event exceeds its allowance.');
      exclusive(this.file(id, `${eventId}.json`), serialized);
      const held = {
        id: eventId,
        sha256: payloadSha256(serialized),
        identity: identity(this.file(id, `${eventId}.json`)),
        reportIdentity: report ? identity(reportFile) : null,
      };
      state.events.push(held);
      exclusive(this.file(id, `${eventId}.anchor.json`), JSON.stringify(held));
      this.save(id, state);
      if (text !== null) {
        try {
          const source = this.file(id, 'current.md');
          if (fs.existsSync(source)) {
            const witness = JSON.parse(read(this.file(id, 'source.json')));
            if (!equalIdentity(witness, identity(source))) throw new Error('The dispatch report source was replaced.');
          }
          writeFileAtomically(source, text, this.replace, 0o600, false);
          this.saveSource(id, identity(source));
        } catch {
          /* The immutable event remains available. */
        }
      }
      if (launch.alias && text !== null) {
        // An alias never supplies authoritative report bytes.
        try {
          safePath(path.dirname(launch.alias));
          if (
            !launch.aliasParent ||
            !equalIdentity(launch.aliasParent, identity(fs.realpathSync.native(path.dirname(launch.alias))))
          )
            throw new Error('The report alias folder was replaced.');
          if (fs.existsSync(launch.alias)) safePath(launch.alias);
          writeFileAtomically(launch.alias, text, this.replace, 0o600, false);
        } catch {
          /* The private report remains readable. */
        }
      }
      return event;
    });
  }
  event(id: string, eventId: string): DispatchEvent {
    this.launch(id);
    validId(eventId);
    const anchor = this.file(id, `${eventId}.anchor.json`);
    const held = fs.existsSync(anchor)
      ? JSON.parse(read(anchor))
      : this.state(id).events.find((one) => one.id === eventId);
    const file = this.file(id, `${eventId}.json`);
    if (!held) throw new Error('The dispatch event is unknown.');
    const text = read(file);
    const event = JSON.parse(text) as DispatchEvent;
    if (
      event.launchId !== id ||
      event.eventId !== eventId ||
      payloadSha256(text) !== held.sha256 ||
      !equalIdentity(held.identity, identity(file))
    )
      throw new Error('The authoritative dispatch event was replaced.');
    if (event.report) {
      const expected = this.file(id, `${eventId}.md`);
      if (
        event.report.path !== expected ||
        !held.reportIdentity ||
        !equalIdentity(held.reportIdentity, identity(expected))
      )
        throw new Error('The authoritative dispatch report was replaced.');
    }
    return event;
  }
  result(id: string, eventId: string): unknown {
    const event = this.event(id, eventId);
    const text = event.report ? read(event.report.path, REPORT_BYTES) : null;
    if (
      text !== null &&
      (payloadSha256(text) !== event.report!.sha256 || Buffer.byteLength(text) !== event.report!.bytes)
    )
      throw new Error('The frozen dispatch report changed.');
    const consumption = this.consumption(id, eventId);
    delete consumption.token;
    const reply = { ...event, consumption, text: text !== null && text.length <= DISPATCH_TEXT_LIMIT ? text : null };
    if (Buffer.byteLength(JSON.stringify(reply)) > JSON_BYTES) reply.text = null;
    return reply;
  }
  status(
    id: string,
    cursor?: string,
    limit = 32,
  ): {
    launch: ReturnType<typeof statusLaunch>;
    version: 1;
    next: string | null;
    reportSource: string | null;
    observation?: StandaloneObservation | null;
    events: (Omit<DispatchEvent, 'nativeEnding'> & {
      consumption: Omit<EventState, 'disposition' | 'token'>;
      delivery: 'unavailable';
    })[];
  } {
    const launch = this.launch(id);
    const current = this.state(id);
    const start = cursor === undefined ? 0 : Number(cursor.slice(id.length + 1));
    const total = (current.segment ?? 0) * 256 + current.events.length;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 128 ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > total ||
      (cursor !== undefined && cursor !== `${id}:${start}`)
    )
      throw new Error('The dispatch page is invalid.');
    const result: ReturnType<DispatchReceipts['status']> = {
      version: 1,
      launch: statusLaunch(launch),
      next: null,
      reportSource: fs.existsSync(this.file(id, 'current.md')) ? this.file(id, 'current.md') : null,
      events: [],
      ...(launch.transport === 'standalone' ? { observation: this.observation(id) } : {}),
    };
    let index = start;
    for (; index < total && result.events.length < limit; index++) {
      const segment = Math.floor(index / 256);
      const state = segment === (current.segment ?? 0) ? current : this.state(id, segment);
      const event = this.event(id, state.events[index % 256].id);
      const { token: _token, disposition: _disposition, ...consumption } = this.consumption(id, event.eventId);
      const { nativeEnding: _ending, ...listed } = event;
      result.events.push({ ...listed, consumption, delivery: 'unavailable' });
      result.next = index + 1 < total ? `${id}:${index + 1}` : null;
      if (Buffer.byteLength(JSON.stringify(result)) > STATUS_BYTES) {
        result.events.pop();
        if (!result.events.length) throw new Error('The dispatch event cannot fit its status page.');
        break;
      }
    }
    result.next = index < total ? `${id}:${index}` : null;
    if (Buffer.byteLength(JSON.stringify(result)) > STATUS_BYTES)
      throw new Error('The dispatch status exceeds its page allowance.');
    return result;
  }
  private checkStatusEnvelope(launch: DispatchLaunch, observation: StandaloneObservation | null): void {
    const metadata = {
      version: 1,
      launch: statusLaunch(launch),
      next: `${launch.launchId}:${Number.MAX_SAFE_INTEGER}`,
      reportSource: path.join(this.root, launch.launchId, 'current.md'),
      events: [],
      ...(launch.transport === 'standalone' ? { observation } : {}),
    };
    const listedState = {
      consumption: { owner: 'x'.repeat(128), dispositionSha256: 'f'.repeat(64) },
      delivery: 'unavailable',
    };
    if (
      Buffer.byteLength(JSON.stringify(metadata)) + EVENT_BYTES + Buffer.byteLength(JSON.stringify(listedState)) >
      STATUS_BYTES
    )
      throw new Error('The launch identity or worker observation exceeds the dispatch status allowance.');
  }
  latest(id: string): DispatchEvent | null {
    this.launch(id);
    const one = this.state(id).events.at(-1);
    return one ? this.event(id, one.id) : null;
  }
  claim(id: string, eventId: string, origin: string, owner: string): unknown {
    if (this.launch(id).origin !== origin || !OWNER.test(owner))
      throw new Error('The dispatch claim origin or owner is invalid.');
    return this.lock(id, () => {
      const event = this.event(id, eventId);
      const state = this.consumption(id, eventId);
      if (state.owner && state.owner !== owner) throw new Error('Another owner holds this dispatch event.');
      const status = state.disposition !== undefined ? 'consumed' : state.owner ? 'already-claimed' : 'claimed';
      if (!state.owner) {
        state.owner = owner;
        state.token = randomBytes(32).toString('hex');
        this.saveConsumption(id, eventId, state);
      }
      return { launchId: id, eventId, status, ...state, reportSha256: event.report?.sha256 ?? null };
    });
  }
  ack(id: string, eventId: string, origin: string, owner: string, token: string, disposition: string): unknown {
    if (
      this.launch(id).origin !== origin ||
      !OWNER.test(owner) ||
      !TOKEN.test(token) ||
      Buffer.byteLength(disposition) > 16 * 1024 ||
      Buffer.byteLength(JSON.stringify({ disposition })) > JSON_BYTES - 4096
    )
      throw new Error('The dispatch acknowledgment is invalid.');
    return this.lock(id, () => {
      const event = this.event(id, eventId);
      if (
        Buffer.byteLength(
          JSON.stringify({
            ...event,
            consumption: { disposition, owner, dispositionSha256: payloadSha256(disposition) },
            text: null,
          }),
        ) > JSON_BYTES
      )
        throw new Error('The dispatch acknowledgment exceeds its JSON allowance.');
      const state = this.consumption(id, eventId);
      const digest = payloadSha256(disposition);
      if (state.owner !== owner || state.token !== token)
        throw new Error('The dispatch claim token does not match this event.');
      if (state.dispositionSha256 && state.dispositionSha256 !== digest)
        throw new Error('This dispatch event has a different saved disposition.');
      const file = this.file(id, `${eventId}.disposition.md`);
      if (fs.existsSync(file)) {
        if (read(file, 16 * 1024) !== disposition) throw new Error('The saved dispatch disposition conflicts.');
      } else exclusive(file, disposition);
      state.disposition = disposition;
      state.dispositionSha256 = digest;
      this.saveConsumption(id, eventId, state);
      return { launchId: id, eventId, status: 'consumed', disposition };
    });
  }
  refresh(id: string): DispatchEvent | null {
    const last = this.latest(id);
    if (!last?.report) return null;
    const source = this.file(id, 'current.md');
    const witness = JSON.parse(read(this.file(id, 'source.json')));
    if (!equalIdentity(witness, identity(source))) throw new Error('The dispatch report source was replaced.');
    const text = read(source, REPORT_BYTES);
    if (payloadSha256(text) === last.report.sha256) return null;
    return this.publish(
      id,
      { outcome: last.outcome, availability: 'available', nativeEnding: last.nativeEnding, askId: null },
      text,
    );
  }
  private file(id: string, name: string): string {
    return path.join(this.root, id, name);
  }
  private saveSource(id: string, witness: FileIdentity): void {
    writeFileAtomically(this.file(id, 'source.json'), JSON.stringify(witness), this.replace, 0o600, false);
  }
  private state(
    id: string,
    segment?: number,
  ): {
    launchId: string;
    segment?: number;
    events: { id: string; sha256: string; identity: FileIdentity; reportIdentity: FileIdentity | null }[];
  } {
    const state = JSON.parse(
      read(this.file(id, segment === undefined ? 'state.json' : `state.${segment}.json`), 4 * JSON_BYTES),
    );
    if (state.launchId !== id || !Array.isArray(state.events) || state.events.length > 256)
      throw new Error('The dispatch state is invalid.');
    return state;
  }
  private save(id: string, state: unknown): void {
    writeFileAtomically(this.file(id, 'state.json'), JSON.stringify(state), this.replace, 0o600, false);
  }
  private consumption(id: string, eventId: string): EventState {
    const file = this.file(id, `${eventId}.consumption.json`);
    return fs.existsSync(file) ? JSON.parse(read(file)) : {};
  }
  private saveConsumption(id: string, eventId: string, state: EventState): void {
    writeFileAtomically(
      this.file(id, `${eventId}.consumption.json`),
      JSON.stringify(state),
      this.replace,
      0o600,
      false,
    );
  }
  // A caller that passes `hold` keeps the lock after `work` while `hold.keep()` is true, and reenters it on its next
  // call. Other callers find a live owner until a later call or `release` ends the hold.
  // A caller that passes `observes` names it in the owner record. A caller that takes the lock from such an owner
  // after that owner ended first writes `<name>.lost`, because the ended owner can have lost what it observed.
  private lock<T>(id: string, work: () => T, name = 'write', hold?: LockHold, observes = false): T {
    this.launch(id);
    const file = this.file(id, `${name}.lock`);
    const kept = hold?.owner;
    const temporary = kept ? null : this.file(id, `${name}.${process.pid}.${randomUUID()}.lock`);
    const owner =
      kept ??
      JSON.stringify({ pid: process.pid, token: randomUUID(), launchId: id, ...(observes ? { observes } : {}) });
    if (temporary) exclusive(temporary, owner);
    let acquired = Boolean(kept);
    let failure: { error: unknown } | undefined;
    let result: T | undefined;
    try {
      let target = file;
      if (kept) {
        /* This caller already holds the lock. */
      } else if (fs.existsSync(file)) {
        let current = file;
        for (let steps = 0; ; steps++) {
          const heldText = current === file ? readChanging(current) : read(current);
          const held = JSON.parse(heldText);
          if (held.launchId !== id || !Number.isSafeInteger(held.pid) || held.pid < 1 || !DISPATCH_ID.test(held.token))
            throw new Error('The dispatch write owner is unavailable.');
          if (steps >= 32) {
            // Retained successors keep stale readers safe when the bounded walk advances its head.
            writeFileAtomically(file, heldText, this.replace, 0o600, false);
            throw new Error('The dispatch write changed during recovery. Try again.');
          }
          const successor = this.file(id, `${name}.${held.token}.next.lock`);
          if (fs.existsSync(successor)) {
            current = successor;
            continue;
          }
          const released = this.file(id, `${name}.${held.token}.released`);
          if (fs.existsSync(released) && read(released) === heldText) {
            target = successor;
            break;
          }
          let dead = false;
          try {
            process.kill(held.pid, 0);
          } catch (error) {
            dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
          if (!dead) throw new Error('Another process holds this dispatch write.');
          if (held.observes === true) mark(this.file(id, `${name}.lost`), heldText);
          target = successor;
          break;
        }
      }
      if (temporary) {
        // Each immutable predecessor admits one successor, including concurrent dead-owner recovery.
        fs.linkSync(temporary, target);
        acquired = true;
        if (target !== file) writeFileAtomically(file, owner, this.replace, 0o600, false);
      }
      result = work();
    } catch (error) {
      failure = { error };
    }
    try {
      if (acquired && hold?.keep()) hold.owner = owner;
      else if (acquired) this.release(id, name, owner, hold);
      if (temporary) fs.unlinkSync(temporary);
    } catch (error) {
      if (failure)
        throw Object.assign(
          new AggregateError([failure.error, error], String(failure.error), { cause: failure.error }),
          {
            code: (failure.error as NodeJS.ErrnoException)?.code,
          },
        );
      throw error;
    }
    if (failure) throw failure.error;
    return result!;
  }
  private release(id: string, name: string, owner: string, hold?: LockHold) {
    exclusive(this.file(id, `${name}.${JSON.parse(owner).token}.released`), owner);
    if (hold) hold.owner = undefined;
  }
}
