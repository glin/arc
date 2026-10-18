import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileAtomically } from './atomicfile';
import { arcHome } from './store';
import { payloadSha256, type RequesterIdentity } from './sessionwrites';
import type { LaunchPolicy } from './launchpolicy';
import { canonicalToolPath } from './toolownership';

export const DISPATCH_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const DISPATCH_TEXT_LIMIT = 16_000;
const JSON_BYTES = 48 * 1024;
const EVENT_BYTES = JSON_BYTES - 20 * 1024;
const STATUS_BYTES = JSON_BYTES - 4096;
const REPORT_BYTES = 8 * 1024 * 1024;
const CAPTURE_SLICE_BYTES = 64 * 1024;
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

function identity(file: string): FileIdentity {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error('The dispatch path is redirected.');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function equalIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
export function safeDispatchPath(file: string, platform = process.platform): void {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let current = paths.resolve(file);
  while (true) {
    if ([os.homedir(), os.tmpdir()].some((base) => current === paths.resolve(base))) break;
    if (platform === 'darwin' && current === '/tmp' && fs.realpathSync.native(current) === '/private/tmp') break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('The dispatch path is redirected.');
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

// Native records supply response and usage evidence. These files retain launch and consumption identity only.
export class DispatchReceipts {
  readonly root: string;
  constructor(home = arcHome()) {
    this.root = path.join(path.resolve(home), 'dispatch');
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
      throw new Error('The launch settings exceed the dispatch receipt allowance. Reduce the selected configuration.');
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
      | 'stdout.log'
      | 'stderr.log'
      | 'worker.log'
      | 'native.log'
      | 'native-source.log'
      | 'native.md'
      | 'attend.sh'
      | 'output-owner.json'
      | 'capture.json',
  ): string {
    this.launch(id);
    return this.file(id, name);
  }
  capture(id: string, aliasByteBudget = CAPTURE_SLICE_BYTES) {
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
    let state: CaptureState = fs.existsSync(checkpoint)
      ? JSON.parse(readChanging(checkpoint))
      : this.lock(
          id,
          (): CaptureState => {
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
              const initial: CaptureState = { raw: identity(rawFile), alias: aliasIdentity, bytes: 0, sources: {} };
              writeFileAtomically(checkpoint, JSON.stringify(initial), undefined, 0o600, false);
              return initial;
            } catch (error) {
              // Initialization can retain private output before its alias witness is saved.
              throw new Error('The requested log could not be prepared. Private output remains available.', {
                cause: error,
              });
            }
          },
          'capture-write',
        );
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
            writeFileAtomically(checkpoint, JSON.stringify(state), undefined, 0o600, false);
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
            writeFileAtomically(checkpoint, JSON.stringify(next), undefined, 0o600, false);
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
            writeFileAtomically(checkpoint, JSON.stringify(next), undefined, 0o600, false);
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
      this.lock(id, () => writeFileAtomically(file, text, undefined, 0o600, false));
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
      this.lock(id, () => writeFileAtomically(file, text, undefined, 0o600, false));
    }
    return fs.existsSync(file) ? JSON.parse(read(file, limit, true)) : null;
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
  monitor(id: string, channel: 'monitor' | 'output-monitor' = 'monitor'): { token: string; release: () => void } {
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
          if (!owner.released) {
            let dead = false;
            try {
              process.kill(owner.pid, 0);
            } catch (error) {
              dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
            if (!dead) throw new Error('Another process is observing this dispatch launch.');
          }
        }
        writeFileAtomically(file, JSON.stringify({ pid: process.pid, token }), undefined, 0o600, false);
      },
      lock,
    );
    return {
      token,
      release: () =>
        this.lock(
          id,
          () => {
            const owner = JSON.parse(read(file));
            if (owner.pid !== process.pid || owner.token !== token)
              throw new Error('The dispatch monitor owner changed.');
            writeFileAtomically(file, JSON.stringify({ ...owner, released: true }), undefined, 0o600, false);
          },
          lock,
        ),
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
    const binding =
      sessionId === undefined
        ? JSON.parse(read(file))
        : {
            launchId: id,
            provider: options.provider,
            sessionId,
            submissionId: 1,
            nativeTurnId: null,
            ...(this.startup(id) ? { startupRequired: true as const } : {}),
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
    kind: 'accepted' | 'background' | 'startup' | 'startup-refused',
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
          writeFileAtomically(source, text, undefined, 0o600, false);
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
          writeFileAtomically(launch.alias, text, undefined, 0o600, false);
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
    writeFileAtomically(this.file(id, 'source.json'), JSON.stringify(witness), undefined, 0o600, false);
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
    writeFileAtomically(this.file(id, 'state.json'), JSON.stringify(state), undefined, 0o600, false);
  }
  private consumption(id: string, eventId: string): EventState {
    const file = this.file(id, `${eventId}.consumption.json`);
    return fs.existsSync(file) ? JSON.parse(read(file)) : {};
  }
  private saveConsumption(id: string, eventId: string, state: EventState): void {
    writeFileAtomically(this.file(id, `${eventId}.consumption.json`), JSON.stringify(state), undefined, 0o600, false);
  }
  private lock<T>(id: string, work: () => T, name = 'write'): T {
    this.launch(id);
    const file = this.file(id, `${name}.lock`);
    const temporary = this.file(id, `${name}.${process.pid}.${randomUUID()}.lock`);
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), launchId: id });
    exclusive(temporary, owner);
    let acquired = false;
    try {
      let target = file;
      if (fs.existsSync(file)) {
        let current = file;
        for (let steps = 0; ; steps++) {
          const heldText = current === file ? readChanging(current) : read(current);
          const held = JSON.parse(heldText);
          if (held.launchId !== id || !Number.isSafeInteger(held.pid) || held.pid < 1 || !DISPATCH_ID.test(held.token))
            throw new Error('The dispatch write owner is unavailable.');
          if (steps >= 32) {
            // Retained successors keep stale readers safe when the bounded walk advances its head.
            writeFileAtomically(file, heldText, undefined, 0o600, false);
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
          target = successor;
          break;
        }
      }
      // Each immutable predecessor admits one successor, including concurrent dead-owner recovery.
      fs.linkSync(temporary, target);
      acquired = true;
      if (target !== file) writeFileAtomically(file, owner, undefined, 0o600, false);
      return work();
    } finally {
      if (acquired) exclusive(this.file(id, `${name}.${JSON.parse(owner).token}.released`), owner);
      fs.unlinkSync(temporary);
    }
  }
}
