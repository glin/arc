import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import {
  DispatchReceipts,
  DISPATCH_ID,
  safeDispatchPath,
  type DispatchEvent,
  type DispatchOutcome,
  type StandaloneOptions,
  type StandaloneObservation,
  type StandaloneStartup,
} from '../../extension/src/dispatchreceipts.ts';
import { linuxProcessStart } from '../../extension/src/store.ts';
import { payloadSha256 } from '../../extension/src/sessionwrites.ts';
import { projectSlug, readQualifiedOpening, revisionOf, type SessionFile } from '../../extension/src/transcript.ts';
import { savedDispatchResponse } from '../../extension/src/sessionreads.ts';
import { childEnv } from '../../extension/src/agenthost.ts';

const execute = promisify(execFile);
const REPORT_BYTES = 8 * 1024 * 1024;
const FRAME_BYTES = 49 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
type ReadBounds = { frameBytes: number; readBytes: number; workBytes?: number };
interface ObservationRuntime {
  now: () => number;
  identity: typeof standaloneProcessIdentity;
  yield: () => Promise<void>;
}
const OBSERVATION_RUNTIME: ObservationRuntime = {
  now: () => Date.now(),
  identity: (pid, timeout) => standaloneProcessIdentity(pid, timeout),
  yield: () => new Promise((resolve) => setImmediate(resolve)),
};
const READ_BOUNDS: ReadBounds = { frameBytes: FRAME_BYTES, readBytes: READ_BYTES };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Only non-secret launch selectors belong in a receipt. Null retains an absent selector.
const CONTEXT_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ARC_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ARC_PROJECTS_ROOT',
  'ARC_CODEX_ROOT',
  'DISPATCH_CLI_BASH',
  'CODEX_MANAGED_PACKAGE_ROOT',
  'CODEX_MANAGED_BY_NPM',
  'ELECTRON_RUN_AS_NODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'CLAUDE_CODE_PROMPT_CACHE_TTL',
];

export function standaloneContext(env: NodeJS.ProcessEnv, cwd: string): Record<string, string | null> {
  const context = Object.fromEntries(
    CONTEXT_KEYS.map((key) => [key, env[Object.keys(env).find((name) => name.toUpperCase() === key) ?? key] ?? null]),
  );
  const home = context[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] || os.homedir();
  if (context.CLAUDE_CONFIG_DIR) context.CLAUDE_CONFIG_DIR = path.resolve(cwd, context.CLAUDE_CONFIG_DIR);
  context.CODEX_HOME = path.resolve(cwd, context.CODEX_HOME || path.join(home, '.codex'));
  context.ARC_PROJECTS_ROOT = path.resolve(
    cwd,
    context.ARC_PROJECTS_ROOT || path.join(context.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
  );
  context.ARC_CODEX_ROOT = path.resolve(cwd, context.ARC_CODEX_ROOT || path.join(context.CODEX_HOME, 'sessions'));
  return context;
}

export function standaloneEnvironment(options: StandaloneOptions, inherited = process.env): NodeJS.ProcessEnv {
  const env = childEnv(inherited, {}, options.provider, options.cwd);
  for (const key of Object.keys(env)) {
    if (
      ['ARC_WINDOW', 'ARC_EDITOR_EXECUTABLE'].includes(key.toUpperCase()) ||
      (options.env && CONTEXT_KEYS.includes(key.toUpperCase()))
    )
      delete env[key];
  }
  for (const [key, value] of Object.entries(options.env ?? {}))
    if (CONTEXT_KEYS.includes(key) && value !== null) env[key] = value;
  return env;
}

export interface FinalObservation {
  sessionId: string | null;
  outcome: DispatchOutcome;
  availability: DispatchEvent['availability'];
  text: string | null;
  evidence: unknown;
}

// Exec frames identify one invocation. They do not create a hosted submission identity.
export class StandaloneFrames {
  sessionId: string | null = null;
  private conflict = false;
  private text: string | null = null;
  private oversized = false;
  private ending: unknown = null;
  private outcome: DispatchOutcome = 'unknown';
  private messageId: string | null = null;
  private started = false;
  private invalid = false;
  private count = 0;
  constructor(
    private readonly provider: 'claude' | 'codex',
    private readonly expected: string | null,
    private readonly frameBytes = FRAME_BYTES,
  ) {}
  snapshot() {
    return {
      oversized: this.oversized,
      sessionId: this.sessionId,
      conflict: this.conflict,
      text: this.text,
      ending: this.ending,
      outcome: this.outcome,
      messageId: this.messageId,
      started: this.started,
      invalid: this.invalid,
      count: this.count,
    };
  }
  restore(state: ReturnType<StandaloneFrames['snapshot']>): void {
    Object.assign(this, state);
  }
  line(line: string): void {
    if (Buffer.byteLength(line) > this.frameBytes) {
      this.invalid = true;
      return;
    }
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      this.invalid = true;
      return;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      this.invalid = true;
      return;
    }
    if (this.provider === 'claude') {
      if (row.type !== 'result') return;
      this.count++;
      this.identity(row.session_id);
      if (this.count > 1 || typeof row.is_error !== 'boolean' || typeof row.subtype !== 'string') {
        this.invalid = true;
        return;
      }
      this.outcome = row.is_error || row.subtype !== 'success' ? 'failed' : 'succeeded';
      this.oversized = typeof row.result === 'string' && Buffer.byteLength(row.result) > REPORT_BYTES;
      this.text =
        typeof row.result === 'string' && row.result.trim() && Buffer.byteLength(row.result) <= REPORT_BYTES
          ? row.result
          : null;
      this.ending = { type: row.type, subtype: row.subtype, is_error: row.is_error, sessionId: this.sessionId };
    } else {
      if (row.type === 'thread.started') this.identity(row.thread_id);
      else if (row.type === 'turn.started') {
        if (this.started || this.ending) this.invalid = true;
        this.started = true;
      } else if (row.type === 'item.completed' && row.item?.type === 'agent_message') {
        if (!this.started || this.ending || typeof row.item.id !== 'string' || !row.item.id) this.invalid = true;
        this.oversized = typeof row.item.text === 'string' && Buffer.byteLength(row.item.text) > REPORT_BYTES;
        this.text =
          typeof row.item.text === 'string' && row.item.text.trim() && Buffer.byteLength(row.item.text) <= REPORT_BYTES
            ? row.item.text
            : null;
        this.messageId = row.item.id;
      } else if (row.type === 'turn.completed' || row.type === 'turn.failed') {
        if (!this.started || this.ending) this.invalid = true;
        this.outcome = row.type === 'turn.completed' ? 'succeeded' : 'failed';
        this.ending = { type: row.type, sessionId: this.sessionId, messageId: this.messageId };
      }
    }
  }
  private identity(value: unknown): void {
    if (typeof value !== 'string' || !DISPATCH_ID.test(value) || (this.expected !== null && value !== this.expected)) {
      this.conflict = true;
      return;
    }
    if (this.sessionId && this.sessionId !== value) this.conflict = true;
    this.sessionId = value;
  }
  finish(exitCode: number | null, signal: string | null, nativeReport?: string | null): FinalObservation {
    if (this.invalid || this.conflict || !this.sessionId || !this.ending)
      return {
        sessionId: this.conflict ? null : this.sessionId,
        outcome: 'unknown',
        availability: 'pending',
        text: null,
        evidence: null,
      };
    if (this.provider === 'codex' && nativeReport !== undefined && (this.oversized || nativeReport !== this.text))
      return {
        sessionId: this.sessionId,
        outcome: 'unknown',
        availability: 'unavailable',
        text: null,
        evidence: this.ending,
      };
    const outcome = signal
      ? 'interrupted'
      : exitCode === null || (exitCode !== 0 && this.outcome === 'succeeded')
        ? 'unknown'
        : this.outcome;
    const available = this.text !== null && Buffer.byteLength(this.text) <= REPORT_BYTES;
    return {
      sessionId: this.sessionId,
      outcome,
      availability: available ? 'available' : 'unavailable',
      text: available ? this.text : null,
      evidence: this.ending,
    };
  }
}

// Keep one incomplete frame and one read chunk, independently of the log's total size.
class FrameStream {
  readonly frames: StandaloneFrames;
  private pending: Buffer[] = [];
  private bytes = 0;
  private discarded = false;
  constructor(
    options: StandaloneOptions,
    private readonly bounds: ReadBounds,
  ) {
    this.frames = new StandaloneFrames(options.provider, options.sessionHint, bounds.frameBytes);
  }
  restore(state: ReturnType<StandaloneFrames['snapshot']>, pending?: { data: string; discarded: boolean }): void {
    this.frames.restore(state);
    if (pending) {
      const bytes = Buffer.from(pending.data, 'base64');
      if (bytes.length > this.bounds.frameBytes) throw new Error('The saved output frame exceeds its allowance.');
      this.pending = bytes.length ? [bytes] : [];
      this.bytes = bytes.length;
      this.discarded = pending.discarded;
    }
  }
  checkpoint() {
    return this.frames.snapshot();
  }
  partial() {
    return { data: Buffer.concat(this.pending, this.bytes).toString('base64'), discarded: this.discarded };
  }
  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(start, end);
      if (!this.discarded && this.bytes + part.length > this.bounds.frameBytes) {
        this.discarded = true;
        this.pending = [];
        this.bytes = 0;
        this.frames.line('invalid');
      }
      if (!this.discarded) {
        this.pending.push(Buffer.from(part));
        this.bytes += part.length;
      }
      if (newline >= 0) this.finish(true);
      start = end;
    }
  }
  finish(terminated = false): void {
    try {
      if (this.discarded) this.frames.line('invalid');
      else {
        const text = new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(this.pending, this.bytes));
        if (terminated || text.trim()) this.frames.line(text.trimEnd());
      }
    } catch {
      this.frames.line('invalid');
    }
    this.pending = [];
    this.bytes = 0;
    this.discarded = false;
  }
}

function* logChunks(
  file: string,
  readBytes: number,
  cursor = { offset: 0, identity: '' },
  workBytes = Infinity,
): Generator<Buffer, boolean> {
  safeDispatchPath(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}`;
    if (!stat.isFile() || (cursor.identity && cursor.identity !== identity) || stat.size < BigInt(cursor.offset))
      throw new Error('The provider output was replaced.');
    cursor.identity = identity;
    const end = Math.min(Number(stat.size), cursor.offset + workBytes);
    const buffer = Buffer.alloc(readBytes);
    while (cursor.offset < end) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - cursor.offset), cursor.offset);
      if (!count) throw new Error('The provider output changed during the read.');
      cursor.offset += count;
      yield buffer.subarray(0, count);
    }
    const current = fs.lstatSync(file, { bigint: true });
    if (
      current.isSymbolicLink() ||
      `${current.dev}:${current.ino}` !== identity ||
      current.size < BigInt(cursor.offset)
    )
      throw new Error('The provider output was replaced.');
    return cursor.offset >= Number(stat.size);
  } finally {
    fs.closeSync(fd);
  }
}

export async function standaloneProcessIdentity(
  pid: number,
  timeoutMs = 5000,
): Promise<{ command: string; commandLine: string; startedAt: string } | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const deadline = Date.now() + timeoutMs;
  try {
    if (process.platform === 'linux') {
      const before = linuxProcessStart(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      const command = fs.readlinkSync(`/proc/${pid}/exe`);
      const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const after = linuxProcessStart(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      if (!before || !after || before.start !== after.start || ['Z', 'X'].includes(after.state)) return null;
      return { command, commandLine, startedAt: `${boot}:${after.start}` };
    }
    if (process.platform === 'win32') {
      const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p -and $p.CreationDate -and $p.ExecutablePath -and $p.CommandLine){@{command=$p.ExecutablePath;commandLine=$p.CommandLine;startedAt=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`;
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
        maxBuffer: 48 * 1024,
      });
      const row = JSON.parse(stdout);
      return typeof row.command === 'string' && typeof row.commandLine === 'string' && typeof row.startedAt === 'string'
        ? row
        : null;
    }
    if (process.platform === 'darwin') {
      const read = async () =>
        (
          await execute('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'comm=', '-o', 'args='], {
            timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
            maxBuffer: 48 * 1024,
          })
        ).stdout.trim();
      const before = await read();
      if (!before || before.slice(0, 24) !== (await read()).slice(0, 24)) return null;
      const match = /^(.{24})\s+(\S+)\s+(.+)$/.exec(before);
      return match ? { startedAt: match[1], command: match[2], commandLine: match[3] } : null;
    }
  } catch {
    /* Missing native identity supplies no process ownership. */
  }
  return null;
}

export interface RegistryClock {
  started: number;
  seen: boolean;
  blockedAt: number | null;
  errors: number;
}
export function registryStep(
  state: RegistryClock,
  snapshot: string | null,
  session: string,
  now: number,
): { done: boolean; outcome: DispatchOutcome; reason: string; entry?: any } {
  let rows: any;
  try {
    rows = JSON.parse(snapshot ?? '');
  } catch {
    rows = null;
  }
  if (
    !Array.isArray(rows) ||
    rows.some((entry) => !entry || typeof entry !== 'object' || typeof entry.id !== 'string')
  ) {
    state.errors++;
    return { done: state.errors >= 3, outcome: 'unknown', reason: 'Claude registry is unavailable.' };
  }
  const matches = rows.filter(
    (entry) =>
      entry.id === session ||
      (/^[a-f0-9]{8}$/i.test(session) && entry.id.toLowerCase().startsWith(session.toLowerCase())),
  );
  if (matches.length > 1) return { done: true, outcome: 'unknown', reason: 'Claude session identity is ambiguous.' };
  state.errors = 0;
  if (!matches.length)
    return {
      done: state.seen || now - state.started >= 60_000,
      outcome: 'unknown',
      reason: state.seen
        ? 'Claude left its registry. Worker exit remains unknown.'
        : 'Claude has not appeared in its registry.',
    };
  state.seen = true;
  const entry = matches[0];
  const status = entry.state ?? entry.status;
  if (['working', 'busy', 'starting'].includes(status)) {
    state.blockedAt = null;
    return { done: false, outcome: 'running', reason: 'Claude is working.', entry };
  }
  if (['blocked', 'idle'].includes(status)) {
    state.blockedAt ??= now;
    return {
      done: now - state.blockedAt >= 45_000,
      outcome: 'needs-input',
      reason: `Claude requires attention (${status}).`,
      entry,
    };
  }
  if (['failed', 'stopped', 'killed', 'error'].includes(status))
    return {
      done: true,
      outcome: status === 'stopped' || status === 'killed' ? 'interrupted' : 'failed',
      reason: `Claude ended with state ${status}.`,
      entry,
    };
  return { done: true, outcome: 'unknown', reason: 'Claude registry state is unavailable.', entry };
}

export function backgroundIdentity(output: string, name: string): string | null {
  const rows = output
    .split(/\r?\n/)
    .map((line) =>
      /^backgrounded · ([a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?) · (.*)$/i.exec(line),
    );
  const matches = rows.filter((row) => row && row[2] === name);
  return matches.length === 1 ? matches[0]![1].toLowerCase() : null;
}

export function bindBackgroundLaunch(
  receipts: DispatchReceipts,
  id: string,
  ending: { exitCode: number | null; signal: string | null; backgroundOutput: string; timedOut?: boolean },
): string | null {
  const options = receipts.launch(id).standalone;
  if (!options || options.provider !== 'claude' || !options.background) return null;
  const backgroundId =
    ending.exitCode === 0 && ending.signal === null && !ending.timedOut
      ? backgroundIdentity(ending.backgroundOutput, options.name)
      : null;
  if (backgroundId) receipts.background(id, backgroundId);
  return backgroundId;
}

export function backgroundCommand(receipts: DispatchReceipts, id: string, action: 'logs' | 'attach' | 'stop' | 'rm') {
  const launch = receipts.launch(id);
  requireBackgroundContext(launch.standalone);
  const backgroundId = receipts.background(id);
  if (!backgroundId) throw new Error('The Claude background launch identity is unavailable.');
  const options = launch.standalone!;
  const offset = options.args.indexOf('--bg');
  if (offset < 0) throw new Error('The Claude background launch command is unavailable.');
  if (action === 'rm')
    throw new Error(
      'Claude record removal is unavailable until conversation and directory preservation is established.',
    );
  return { command: options.command, args: [...options.args.slice(0, offset), action, backgroundId], cwd: options.cwd };
}

function requireBackgroundContext(options: StandaloneOptions | undefined): void {
  if (
    !options?.env ||
    !Object.hasOwn(options.env, 'CLAUDE_CONFIG_DIR') ||
    !options.env.ARC_PROJECTS_ROOT ||
    !path.isAbsolute(options.env.ARC_PROJECTS_ROOT)
  )
    throw new Error('The original Claude configuration is unavailable. Saved reports remain readable.');
}

export async function runBackgroundManagement(
  action: 'logs' | 'attach' | 'stop' | 'rm',
  args: string[],
  receipts = new DispatchReceipts(),
): Promise<string> {
  if (args.length !== 1) throw new Error(`Usage: arc dispatch ${action} LAUNCH_ID`);
  const id = args[0];
  const plan = backgroundCommand(receipts, id, action);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: standaloneEnvironment(receipts.launch(id).standalone!),
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) =>
      code === 0 && !signal ? resolve() : reject(new Error(`Claude ${action} did not complete successfully.`)),
    );
  });
  return JSON.stringify({ launchId: id, provider: 'claude', action, status: 'completed' });
}

export function readNativeReport(file: string): string | null {
  try {
    safeDispatchPath(file);
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(descriptor, { bigint: true });
      if (!stat.isFile() || stat.size > BigInt(REPORT_BYTES)) return null;
      const bytes = Buffer.alloc(REPORT_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      const current = fs.lstatSync(file, { bigint: true });
      if (length > REPORT_BYTES || current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink())
        return null;
      const text = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, length));
      return text.trim() ? text : null;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
}

// A new native user record binds the print launch before its final stdout arrives.
function claudeStartup(
  options: StandaloneOptions,
  prompt: string,
  bounds: ReadBounds,
  retain: (evidence: StandaloneStartup) => void,
) {
  if (options.provider !== 'claude' || options.background || !options.sessionHint || !options.env?.ARC_PROJECTS_ROOT)
    return null;
  const file = path.join(options.env.ARC_PROJECTS_ROOT, projectSlug(options.cwd), `${options.sessionHint}.jsonl`);
  let ancestor = path.dirname(file);
  let directory: string;
  let cwd: string;
  try {
    try {
      fs.lstatSync(file);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    while (true) {
      try {
        fs.lstatSync(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        ancestor = path.dirname(ancestor);
      }
    }
    safeDispatchPath(ancestor);
    const stat = fs.statSync(ancestor, { bigint: true });
    directory = `${stat.dev}:${stat.ino}`;
    cwd = fs.realpathSync.native(options.cwd);
  } catch {
    return null;
  }
  let identity: string | null = null;
  let opening = Buffer.alloc(0);
  let parsed = 0;
  let accepted = false;
  let refused = false;
  return (): string | null => {
    if (refused) return null;
    try {
      safeDispatchPath(file);
      const parent = fs.statSync(ancestor, { bigint: true });
      if (`${parent.dev}:${parent.ino}` !== directory || fs.realpathSync.native(options.cwd) !== cwd) {
        refused = true;
        return null;
      }
      const qualified = readQualifiedOpening(file, (fd) => {
        const stat = fs.fstatSync(fd, { bigint: true });
        const current = `${stat.dev}:${stat.ino}`;
        if ((identity && current !== identity) || stat.size < BigInt(opening.length)) return { refused: true };
        const buffer = Buffer.alloc(Math.min(bounds.readBytes, READ_BYTES));
        let offset = 0;
        while (offset < opening.length) {
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, opening.length - offset), offset);
          if (!count || !buffer.subarray(0, count).equals(opening.subarray(offset, offset + count)))
            return { refused: true };
          offset += count;
        }
        const count = accepted
          ? 0
          : fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(stat.size) - offset), offset);
        return { refused: false, identity: current, bytes: Buffer.from(buffer.subarray(0, count)) };
      });
      safeDispatchPath(file);
      if (!qualified) return null;
      if (qualified.value.refused) {
        refused = true;
        return null;
      }
      identity = qualified.value.identity!;
      if (accepted) return options.sessionHint;
      opening = Buffer.concat([opening, qualified.value.bytes!]);
      if (opening.length > bounds.frameBytes) {
        refused = true;
        return null;
      }
      while (true) {
        const end = opening.indexOf(10, parsed);
        if (end < 0) return null;
        const row = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(opening.subarray(parsed, end)));
        parsed = end + 1;
        if (row.type !== 'user') continue;
        const content = row.message?.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content) && content.every((part) => part?.type === 'text' && typeof part.text === 'string')
              ? content.map((part) => part.text).join('\n')
              : null;
        accepted =
          row.sessionId === options.sessionHint &&
          row.message?.role === 'user' &&
          !row.isSidechain &&
          !row.isMeta &&
          typeof row.uuid === 'string' &&
          !!row.uuid &&
          typeof row.cwd === 'string' &&
          fs.realpathSync.native(row.cwd) === cwd &&
          text === prompt;
        refused = !accepted;
        if (accepted)
          retain({
            file,
            identity,
            ancestor,
            directory,
            cwd,
            bytes: opening.length,
            sha256: createHash('sha256').update(opening).digest('hex'),
          });
        return accepted ? options.sessionHint : null;
      }
    } catch (error) {
      if (identity || (error as NodeJS.ErrnoException).code !== 'ENOENT') refused = true;
      return null;
    }
  };
}

async function startupContinuous(
  receipts: DispatchReceipts,
  id: string,
  options: StandaloneOptions,
  bounds: ReadBounds,
  runtime: ObservationRuntime,
  deadline: number,
): Promise<boolean> {
  const refuse = () => {
    receipts.startupRefused(id, true);
    return false;
  };
  try {
    if (receipts.startupRefused(id)) return false;
    const held = receipts.startup(id);
    if (!held) return true;
    const checkPaths = () => {
      safeDispatchPath(held.file);
      const parent = fs.statSync(held.ancestor, { bigint: true });
      return `${parent.dev}:${parent.ino}` === held.directory && fs.realpathSync.native(options.cwd) === held.cwd;
    };
    if (!checkPaths()) return refuse();
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(bounds.readBytes, READ_BYTES));
    let offset = 0;
    let refused = false;
    do {
      const qualified = readQualifiedOpening(held.file, (fd) => {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (`${stat.dev}:${stat.ino}` !== held.identity || stat.size < BigInt(held.bytes)) {
          refused = true;
          return false;
        }
        if (runtime.now() >= deadline || held.bytes > (bounds.workBytes ?? 64 * 1024 * 1024)) return false;
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, held.bytes - offset), offset);
        if (!count && offset < held.bytes) return false;
        digest.update(buffer.subarray(0, count));
        offset += count;
        return true;
      });
      if (refused) return refuse();
      if (!qualified?.value) return false;
      if (offset < held.bytes) await runtime.yield();
    } while (offset < held.bytes);
    if (!checkPaths()) return refuse();
    return digest.digest('hex') === held.sha256 || refuse();
  } catch (error) {
    if (String(error).includes('The dispatch path is redirected.')) return refuse();
    return false;
  }
}

export async function observeProcess(
  child: ChildProcess,
  options: StandaloneOptions,
  onIdentity: (id: string) => void,
  stdout: number,
  stderr: number,
  readLogs?: (cursor?: { offset: number; identity: string }) => Iterable<Buffer>,
  bounds = READ_BOUNDS,
  runtime = OBSERVATION_RUNTIME,
  startupIdentity?: (() => string | null) | null,
): Promise<{
  exitCode: number | null;
  signal: string | null;
  frames: StandaloneFrames;
  backgroundOutput: string;
  timedOut?: boolean;
}> {
  const stream = new FrameStream(options, bounds);
  const frames = stream.frames;
  let backgroundOutput = '';
  const feed = (chunk: Buffer) => {
    if (!readLogs) fs.writeSync(stdout, chunk);
    if (options.background) {
      if (Buffer.byteLength(backgroundOutput) + chunk.length <= 48 * 1024) backgroundOutput += chunk.toString('utf8');
      return;
    }
    stream.push(chunk);
    const state = frames.snapshot();
    if (!state.invalid && !state.conflict && state.sessionId) onIdentity(state.sessionId);
  };
  child.stdout?.on('data', feed);
  child.stderr?.on('data', (chunk: Buffer) => {
    fs.writeSync(stderr, chunk);
    if (options.background && Buffer.byteLength(backgroundOutput) + chunk.length <= 48 * 1024)
      backgroundOutput += chunk.toString('utf8');
  });
  // The supervisor publishes startup identity. The launching command only reads it.
  const startup = new FrameStream(options, bounds);
  const startupCursor = { offset: 0, identity: '' };
  const identityTimer: ReturnType<typeof setInterval> | null =
    (readLogs && options.provider === 'codex' && !options.background) || startupIdentity
      ? setInterval(() => {
          try {
            if (startupIdentity) {
              const sessionId = startupIdentity();
              if (sessionId) {
                onIdentity(sessionId);
                clearInterval(identityTimer!);
              }
              return;
            }
            for (const bytes of readLogs!(startupCursor)) startup.push(bytes);
            const state = startup.checkpoint();
            if (state.invalid || state.conflict) clearInterval(identityTimer!);
            else if (state.sessionId) {
              onIdentity(state.sessionId);
              clearInterval(identityTimer!);
            }
          } catch {
            clearInterval(identityTimer!);
          }
        }, 100)
      : null;
  const deadline = runtime.now() + options.deadlineMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    let ending: { exitCode: number | null; signal: string | null } | null = null;
    const timeout = () => {
      if (settled) return;
      settled = true;
      child.unref();
      if (identityTimer) clearInterval(identityTimer);
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: ending?.exitCode ?? null,
        signal: ending?.signal ?? null,
        frames,
        backgroundOutput,
        timedOut: true,
      });
    };
    const timer = readLogs ? setTimeout(timeout, options.deadlineMs) : null;
    child.once('error', (error) => {
      if (identityTimer) clearInterval(identityTimer);
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', async (exitCode, signal) => {
      if (identityTimer) clearInterval(identityTimer);
      if (settled) return;
      ending = { exitCode, signal };
      if (readLogs) {
        let work = 0;
        try {
          const chunks = readLogs()[Symbol.iterator]();
          for (let step = chunks.next(); ; step = chunks.next()) {
            if (step.done) {
              if (step.value === false) timeout();
              break;
            }
            const bytes = step.value;
            if (settled || runtime.now() >= deadline || work + bytes.length > (bounds.workBytes ?? 64 * 1024 * 1024)) {
              timeout();
              chunks.return?.();
              break;
            }
            feed(bytes);
            work += bytes.length;
            await runtime.yield();
          }
        } catch {
          frames.line('invalid');
        }
      }
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!options.background) stream.finish();
      resolve({ exitCode, signal, frames, backgroundOutput });
    });
  });
}

async function registry(options: StandaloneOptions): Promise<string | null> {
  requireBackgroundContext(options);
  // The launch's leading package script remains part of registry commands.
  const offset = options.args.findIndex((arg) => arg === '--bg');
  try {
    return (
      await execute(options.command, [...options.args.slice(0, offset), 'agents', '--json'], {
        cwd: options.cwd,
        env: standaloneEnvironment(options),
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      })
    ).stdout;
  } catch {
    return null;
  }
}

function savedBackground(
  options: StandaloneOptions,
  sessionId: string | null,
  prompt: string,
): FinalObservation | null {
  if (!sessionId || !DISPATCH_ID.test(sessionId) || !options.env?.ARC_PROJECTS_ROOT) return null;
  const file = path.join(options.env.ARC_PROJECTS_ROOT, projectSlug(options.cwd), `${sessionId}.jsonl`);
  try {
    const revision = revisionOf(fs.statSync(file, { bigint: true }));
    const source = { ...revision, file, sessionId, agent: 'claude' } as SessionFile;
    const response = savedDispatchResponse(source, '1');
    if (!response?.finished || response.prompt !== prompt || !response.responseIds.length) return null;
    const text = response.text.trim() && Buffer.byteLength(response.text) <= REPORT_BYTES ? response.text : null;
    return {
      sessionId,
      outcome: response.interrupted ? 'interrupted' : response.failed ? 'failed' : 'succeeded',
      availability: text ? 'available' : 'unavailable',
      text,
      evidence: {
        provider: 'claude',
        sessionId,
        source: file,
        responseIds: response.responseIds,
        promptSha256: payloadSha256(response.prompt),
        finished: true,
      },
    };
  } catch {
    return null;
  }
}

async function observeBackground(
  receipts: DispatchReceipts,
  id: string,
  observation: StandaloneObservation,
  options: StandaloneOptions,
  prompt: string,
  publishObservation: () => Promise<boolean>,
  capture?: ReturnType<typeof liveLogCapture>,
): Promise<FinalObservation> {
  const backgroundId = receipts.background(id);
  if (!backgroundId) throw new Error('The Claude background launch identity is unavailable.');
  const started = Date.now();
  const state: RegistryClock = { started, seen: false, blockedAt: null, errors: 0 };
  let delay = 2_000;
  while (Date.now() - started < options.deadlineMs) {
    const step = registryStep(state, await registry(options), backgroundId, Date.now());
    if (capture) {
      const plan = backgroundCommand(receipts, id, 'logs');
      try {
        const logs = await execute(plan.command, plan.args, {
          cwd: plan.cwd,
          env: standaloneEnvironment(options),
          windowsHide: true,
          timeout: 20_000,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'buffer',
        });
        capture.native(logs.stdout);
      } catch {
        /* Native diagnostics establish no final response or worker exit. */
      }
    }
    if (step.entry && typeof step.entry.sessionId === 'string' && DISPATCH_ID.test(step.entry.sessionId))
      observation.sessionId = receipts.standaloneSession(id, step.entry.sessionId);
    // Registry PIDs alone establish no process ownership. No registry process is terminated.
    const saved = savedBackground(options, observation.sessionId, prompt);
    if (saved) {
      observation.monitor = 'finished';
      observation.reason = undefined;
      return saved;
    }
    if (!(await publishObservation())) break;
    if (step.done) {
      observation.monitor = step.outcome === 'needs-input' ? 'finished' : 'unavailable';
      observation.reason = step.reason;
      return {
        sessionId: observation.sessionId,
        outcome: step.outcome,
        availability: 'pending',
        text: null,
        evidence: null,
      };
    }
    await pause(Math.min(delay, options.deadlineMs - (Date.now() - started)));
    delay = Math.min(delay * 2, 30_000);
  }
  observation.monitor = 'timed-out';
  observation.reason = 'Observation timed out. Worker exit remains unknown.';
  return { sessionId: observation.sessionId, outcome: 'unknown', availability: 'pending', text: null, evidence: null };
}

function logCapture(receipts: DispatchReceipts, id: string, bounds: ReadBounds) {
  const capture = receipts.capture(id, bounds.readBytes);
  const sources = (['stdout.log', 'stderr.log'] as const).map((name) => ({
    name,
    file: receipts.artifact(id, name),
    cursor: capture.cursor(name),
  }));
  const flush = (bytes: number) => {
    for (const source of sources) {
      if (!fs.existsSync(source.file)) continue;
      try {
        source.cursor = capture.cursor(source.name);
        for (const chunk of logChunks(source.file, bounds.readBytes, source.cursor, bytes))
          capture.write(chunk, source.name, source.cursor);
      } catch (error) {
        source.cursor = capture.cursor(source.name);
        throw error;
      }
    }
    const aliasPending = capture.flushAlias();
    return !aliasPending && sources.every((source) => source.cursor.offset === fs.statSync(source.file).size);
  };
  return { native: capture.native, flush, flushAlias: capture.flushAlias, close: capture.close };
}

function liveLogCapture(receipts: DispatchReceipts, id: string, bounds: ReadBounds) {
  const capture = logCapture(receipts, id, bounds);
  const timer = setInterval(() => {
    try {
      capture.flush(bounds.readBytes);
    } catch {
      /* Original channel files remain available. */
    }
  }, 50);
  return {
    native: capture.native,
    close: async (deadline: number, runtime: ObservationRuntime) => {
      clearInterval(timer);
      try {
        try {
          if (capture.flush(bounds.workBytes ?? 64 * 1024 * 1024)) return true;
        } catch {
          /* Original channel files remain available. */
        }
        while (runtime.now() < deadline) {
          await runtime.yield();
          if (runtime.now() >= deadline) break;
          try {
            if (!capture.flushAlias()) return true;
          } catch {
            /* A later pass retries unavailable alias delivery. */
          }
        }
        return false;
      } finally {
        capture.close();
      }
    },
  };
}

function outputProducer(receipts: DispatchReceipts, id: string, entry: string, stdout: number, stderr: number) {
  const adapter = spawn(process.execPath, [entry, '__standalone-produce', id], {
    cwd: receipts.launch(id).standalone!.cwd,
    env: {
      ...standaloneEnvironment(receipts.launch(id).standalone!),
      ARC_HOME: path.resolve(path.dirname(receipts.root)),
    },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr, 'ipc'],
  });
  // This handle forwards only the native child's identity and ending, never the adapter's PID or exit.
  const worker = new ChildProcess();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  let ended = false;
  const fail = () => {
    started();
    if (!ended) {
      ended = true;
      worker.emit('error', new Error('The worker output connection closed. Worker exit remains unknown.'));
    }
  };
  adapter.on('message', (message: any) => {
    if (message?.type === 'started' && Number.isSafeInteger(message.pid) && message.pid > 0) {
      Object.defineProperty(worker, 'pid', { value: message.pid });
      started();
    } else if (message?.type === 'ended' && !ended) {
      ended = true;
      worker.emit('close', message.code, message.signal);
    } else if (message?.type === 'failed') fail();
  });
  adapter.once('error', fail);
  adapter.once('close', fail);
  worker.unref = () => {
    if (adapter.connected) adapter.disconnect();
    adapter.unref();
    return worker;
  };
  return { worker, ready };
}

export async function produceStandaloneOutput(receipts: DispatchReceipts, id: string): Promise<void> {
  const options = receipts.launch(id).standalone;
  if (!options?.logAlias) throw new Error('This launch has no independent log.');
  if (options.background) return produceBackgroundOutput(receipts, id, options);
  const ownerFile = receipts.artifact(id, 'output-owner.json');
  let producerPid: number | null = null;
  const save = (state: string, reason?: string) =>
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, producerPid, state, reason }), { mode: 0o600 });
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, producerPid, state: 'starting' }), {
    flag: 'wx',
    mode: 0o600,
  });
  let capture: ReturnType<typeof logCapture>;
  try {
    capture = logCapture(receipts, id, READ_BOUNDS);
  } catch (error) {
    save('unavailable', String(error).slice(0, 512));
    throw error;
  }
  const send = (message: object) => {
    if (process.connected) process.send?.(message, () => {});
  };
  const args = [
    ...options.args,
    ...(options.provider === 'codex' ? ['-o', receipts.artifact(id, 'native.md'), '-'] : []),
  ];
  const worker = spawn(options.command, args, {
    cwd: options.cwd,
    env: standaloneEnvironment(options),
    windowsHide: true,
    detached: true,
    stdio: ['pipe', 1, 2],
  });
  let ended = false;
  worker.once('spawn', () => {
    producerPid = worker.pid!;
    save('capturing');
    send({ type: 'started', pid: producerPid });
  });
  worker.once('error', () => {
    ended = true;
    send({ type: 'failed' });
  });
  worker.once('close', (code, signal) => {
    ended = true;
    send({ type: 'ended', code, signal });
  });
  worker.stdin!.on('error', () => {});
  worker.stdin!.end(receipts.input(id));
  let progressAt = Date.now();
  let drainDeadline: number | undefined;
  try {
    while (true) {
      let complete: boolean;
      try {
        complete = capture.flush(READ_BYTES);
        progressAt = Date.now();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const busy =
          code === 'EEXIST' ||
          code === 'EPERM' ||
          /Another process holds this dispatch write|dispatch write changed during recovery/.test(String(error));
        if (!busy || Date.now() - progressAt >= options.deadlineMs) throw error;
        await pause(50);
        continue;
      }
      if (ended && complete) break;
      if (ended) {
        drainDeadline ??= Date.now() + options.deadlineMs;
        if (Date.now() >= drainDeadline)
          throw new Error('The requested log is incomplete. Private output remains available.');
      }
      if (ended || !complete) await OBSERVATION_RUNTIME.yield();
      else await pause(50);
    }
    save('finished');
  } catch (error) {
    save('unavailable', String(error).slice(0, 512));
    // The native child retains its output files after capture failure.
    worker.unref();
  } finally {
    capture.close();
    if (process.connected) process.disconnect();
  }
}

function startBackgroundOutput(receipts: DispatchReceipts, id: string, entry?: string) {
  if (!entry || !receipts.launch(id).standalone?.logAlias) return;
  requireBackgroundContext(receipts.launch(id).standalone);
  const diagnostic = fs.openSync(receipts.artifact(id, 'stderr.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [entry, '__standalone-produce', id], {
      cwd: receipts.launch(id).standalone!.cwd,
      env: {
        ...standaloneEnvironment(receipts.launch(id).standalone!),
        ARC_HOME: path.resolve(path.dirname(receipts.root)),
      },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', diagnostic],
    });
    child.on('error', () => {});
    child.unref();
  } finally {
    fs.closeSync(diagnostic);
  }
}

async function produceBackgroundOutput(receipts: DispatchReceipts, id: string, options: StandaloneOptions) {
  const plan = backgroundCommand(receipts, id, 'logs');
  const backgroundId = receipts.background(id)!;
  let lease: ReturnType<DispatchReceipts['monitor']>;
  try {
    lease = receipts.monitor(id, 'output-monitor');
  } catch (error) {
    if (error instanceof Error && error.message === 'Another process is observing this dispatch launch.') return;
    throw error;
  }
  const ownerFile = receipts.artifact(id, 'output-owner.json');
  const save = (state: string, reason?: string) =>
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, backgroundId, state, reason }), { mode: 0o600 });
  let capture: ReturnType<typeof logCapture> | undefined;
  let nativeCapture: ReturnType<DispatchReceipts['capture']> | undefined;
  try {
    save('capturing');
    capture = logCapture(receipts, id, READ_BOUNDS);
    nativeCapture = receipts.capture(id);
    const source = receipts.artifact(id, 'native-source.log');
    if (fs.existsSync(source)) safeDispatchPath(source);
    else fs.writeFileSync(source, '', { flag: 'wx', mode: 0o600 });
    const state: RegistryClock = { started: Date.now(), seen: false, blockedAt: null, errors: 0 };
    while (true) {
      // Only a native terminal state for this job ends capture. Missing registry rows retain unknown exit.
      const step = registryStep(state, await registry(options), backgroundId, Date.now());
      const descriptor = fs.openSync(source, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        fs.ftruncateSync(descriptor, 0);
        await new Promise<void>((resolve, reject) => {
          const child = spawn(plan.command, plan.args, {
            cwd: plan.cwd,
            env: standaloneEnvironment(options),
            windowsHide: true,
            timeout: 20_000,
            stdio: ['ignore', descriptor, 'ignore'],
          });
          child.once('error', reject);
          child.once('close', (code, signal) =>
            code === 0 && signal === null ? resolve() : reject(new Error('The native log is unavailable.')),
          );
        });
      } finally {
        fs.closeSync(descriptor);
      }
      let progressAt = Date.now();
      const drainDeadline = Date.now() + options.deadlineMs;
      while (true) {
        try {
          const cursor = nativeCapture.cursor('native-source.log');
          for (const bytes of logChunks(source, READ_BYTES, cursor, READ_BYTES)) nativeCapture.native(bytes, cursor);
          const complete = capture.flush(READ_BYTES);
          if (complete && cursor.offset === fs.statSync(source).size) break;
          if (Date.now() >= drainDeadline)
            throw new Error('The requested log is incomplete. Private output remains available.');
          progressAt = Date.now();
          await OBSERVATION_RUNTIME.yield();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            (code !== 'EEXIST' &&
              code !== 'EPERM' &&
              !/Another process holds this dispatch write|dispatch write changed during recovery/.test(
                String(error),
              )) ||
            Date.now() - progressAt >= options.deadlineMs
          )
            throw error;
          await pause(50);
        }
      }
      const status = step.entry?.state ?? step.entry?.status;
      if (['failed', 'stopped', 'killed', 'error'].includes(status)) break;
      await pause(2_000);
    }
    save('finished');
  } catch (error) {
    save('unavailable', String(error).slice(0, 512));
  } finally {
    nativeCapture?.close();
    capture?.close();
    lease.release();
  }
}

export async function superviseStandalone(
  receipts: DispatchReceipts,
  id: string,
  recovery: boolean,
  bounds = READ_BOUNDS,
  runtime = OBSERVATION_RUNTIME,
  onBackground?: () => Promise<void>,
  attended = false,
  outputEntry?: string,
): Promise<unknown> {
  const launch = receipts.launch(id);
  const options = launch.standalone;
  if (launch.transport !== 'standalone' || !options) throw new Error('This launch has no standalone adapter.');
  if (options.background) {
    try {
      requireBackgroundContext(options);
    } catch (error) {
      if (recovery && receipts.latest(id)?.availability === 'available') return receipts.status(id);
      throw error;
    }
  }
  if (recovery && !receipts.observation(id)) return receipts.status(id);
  const lease = receipts.monitor(id);
  const retained = receipts.observation(id);
  const observation: StandaloneObservation = retained ?? {
    supervisor: { pid: process.pid, token: lease.token },
    worker: null,
    sessionId: null,
    exitCode: null,
    signal: null,
    monitor: 'starting',
  };
  observation.supervisor = { pid: process.pid, token: lease.token };
  const observationDeadline = runtime.now() + options.deadlineMs;
  let publicationError: unknown;
  const publishObservation = async () => {
    while (true) {
      try {
        receipts.observation(id, observation);
        publicationError = undefined;
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          !['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(code ?? '') &&
          !/Another process holds this dispatch write|dispatch write changed during recovery/.test(String(error))
        )
          throw error;
        publicationError = error;
        if (runtime.now() >= observationDeadline) return false;
        await pause(Math.min(50, observationDeadline - runtime.now()));
      }
    }
  };
  let capture: ReturnType<typeof liveLogCapture> | undefined;
  const finishObservation = async () => {
    const current = capture;
    capture = undefined;
    if (current && !(await current.close(observationDeadline, runtime))) {
      observation.monitor = 'timed-out';
      observation.reason = 'Observation timed out before all worker output was read.';
    }
    await publishObservation();
    if (publicationError) throw publicationError;
    return receipts.status(id);
  };
  try {
    if (recovery && !retained) return receipts.status(id);
    if (
      recovery &&
      !observation.worker &&
      observation.monitor === 'unavailable' &&
      receipts.latest(id)?.outcome === 'failed'
    )
      return receipts.status(id);
    const prompt = receipts.input(id);
    if (options.logAlias && !outputEntry && (!recovery || options.background))
      capture = liveLogCapture(receipts, id, bounds);
    if (recovery && !options.background) {
      const stream = new FrameStream(options, bounds);
      const log = receipts.artifact(id, 'stdout.log');
      const deadline = runtime.now() + options.deadlineMs;
      const saved = receipts.scan(id) as {
        version: number;
        offset: number;
        identity: string;
        frames: ReturnType<StandaloneFrames['snapshot']>;
        pending?: { data: string; discarded: boolean };
      } | null;
      const compatible = saved?.version === 1 || saved?.version === 2;
      const cursor = compatible ? { offset: saved.offset, identity: saved.identity } : { offset: 0, identity: '' };
      // Admit cached frames only while the original output still supplies their source.
      try {
        for (const _bytes of logChunks(log, bounds.readBytes, cursor, 0)) {
          /* A zero-byte pass checks the source without consuming it. */
        }
        if (compatible) stream.restore(saved.frames, saved.version === 2 ? saved.pending : undefined);
      } catch {
        observation.monitor = 'unavailable';
        observation.reason = 'The original worker output is unavailable. No worker was restarted.';
        receipts.observation(id, observation);
        return receipts.status(id);
      }
      if (options.logAlias) capture = liveLogCapture(receipts, id, bounds);
      observation.monitor = 'observing';
      receipts.observation(id, observation);
      let work = 0;
      let incomplete = false;
      let sourceFailed = false;
      let ended = observation.exitCode !== null || observation.signal !== null;
      let unflushed: {
        frames: ReturnType<FrameStream['checkpoint']>;
        pending: ReturnType<FrameStream['partial']>;
      } | null = null;
      let recovered: FinalObservation;
      while (true) {
        let complete = true;
        try {
          for (const bytes of logChunks(
            log,
            bounds.readBytes,
            cursor,
            Math.max(0, (bounds.workBytes ?? 64 * 1024 * 1024) - work),
          )) {
            if (runtime.now() >= deadline || work + bytes.length > (bounds.workBytes ?? 64 * 1024 * 1024)) {
              cursor.offset -= bytes.length;
              complete = false;
              incomplete = true;
              break;
            }
            stream.push(bytes);
            work += bytes.length;
            await runtime.yield();
          }
          if (cursor.offset < fs.statSync(log).size) {
            if (work < (bounds.workBytes ?? 64 * 1024 * 1024) && runtime.now() < deadline) continue;
            complete = false;
            incomplete = true;
          }
        } catch {
          stream.frames.line('invalid');
          sourceFailed = true;
        }
        recovered = stream.frames.finish(
          observation.exitCode,
          observation.signal,
          options.provider === 'codex' ? readNativeReport(receipts.artifact(id, 'native.md')) : undefined,
        );
        if (sourceFailed) break;
        if (!complete || runtime.now() >= deadline) {
          incomplete = true;
          break;
        }
        if (recovered.text) break;
        if (ended) {
          unflushed = { frames: stream.checkpoint(), pending: stream.partial() };
          stream.finish();
          recovered = stream.frames.finish(
            observation.exitCode,
            observation.signal,
            options.provider === 'codex' ? readNativeReport(receipts.artifact(id, 'native.md')) : undefined,
          );
          break;
        }
        const worker = observation.worker ?? observation.launcher;
        let current = null;
        try {
          current = worker ? await runtime.identity(worker.pid, deadline - runtime.now()) : null;
        } catch {
          /* Unavailable identity is retried within this observation. */
        }
        let absent = false;
        if (worker && !current) {
          try {
            process.kill(worker.pid, 0);
          } catch (error) {
            absent = (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }
        if (current && current.startedAt !== worker?.startedAt) break;
        if (absent) {
          ended = true;
          continue;
        }
        if (runtime.now() >= deadline) {
          incomplete = true;
          break;
        }
        await pause(Math.min(100, deadline - runtime.now()));
      }
      if (!sourceFailed)
        receipts.scan(id, {
          version: 2,
          offset: cursor.offset,
          identity: cursor.identity,
          frames: unflushed?.frames ?? stream.checkpoint(),
          pending: unflushed?.pending ?? stream.partial(),
        });
      const last = receipts.latest(id);
      const continuous = await startupContinuous(receipts, id, options, bounds, runtime, deadline);
      if (!continuous)
        recovered = { sessionId: null, outcome: 'unknown', availability: 'pending', text: null, evidence: null };
      if (
        continuous &&
        !sourceFailed &&
        !incomplete &&
        (last || recovered.evidence || recovered.text) &&
        (!last || last.outcome === 'unknown' || recovered.outcome !== 'unknown') &&
        (last?.outcome !== recovered.outcome ||
          last?.availability !== recovered.availability ||
          !isDeepStrictEqual(last?.nativeEnding, recovered.evidence) ||
          last?.askId !== null ||
          (last?.report?.sha256 ?? null) !== (recovered.text === null ? null : payloadSha256(recovered.text)))
      )
        receipts.publish(
          id,
          {
            outcome: recovered.outcome,
            availability: recovered.availability,
            nativeEnding: recovered.evidence,
            askId: null,
          },
          recovered.text,
        );
      if (continuous && !sourceFailed && !incomplete && recovered.sessionId && recovered.evidence)
        receipts.standaloneSession(id, recovered.sessionId);
      observation.sessionId = recovered.sessionId;
      observation.monitor = incomplete ? 'timed-out' : recovered.text ? 'finished' : 'unavailable';
      observation.reason = sourceFailed
        ? 'The original worker output is unavailable. No worker was restarted.'
        : observation.exitCode === null && observation.signal === null
          ? 'Original worker exit remains unknown. No worker was restarted.'
          : undefined;
      return await finishObservation();
    }
    let final: FinalObservation;
    if (recovery) {
      if (!receipts.background(id))
        throw new Error('The background session identity is unavailable. No worker was restarted.');
      startBackgroundOutput(receipts, id, outputEntry);
      if (receipts.latest(id)?.availability === 'available') return await finishObservation();
      observation.monitor = 'observing';
      final = await observeBackground(receipts, id, observation, options, prompt, publishObservation, capture);
    } else {
      if (retained) throw new Error('This standalone launch already started. No worker was restarted.');
      receipts.observation(id, observation);
      if (attended && options.provider === 'codex') {
        try {
          const worker = spawn(options.command, [...options.args, prompt], {
            cwd: options.cwd,
            env: standaloneEnvironment(options),
            windowsHide: true,
            stdio: 'inherit',
          });
          observation.monitor = 'observing';
          receipts.observation(id, observation);
          const ending = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
            worker.once('error', reject);
            worker.once('close', (code, signal) => resolve({ code, signal }));
          });
          observation.exitCode = ending.code;
          observation.signal = ending.signal;
          observation.monitor = 'finished';
          observation.reason = 'The attended session closed. Its final response is unavailable.';
        } catch {
          observation.monitor = 'unavailable';
          observation.reason = 'The attended provider did not start.';
        }
        receipts.observation(id, observation);
        receipts.publish(
          id,
          { outcome: 'unknown', availability: 'unavailable', nativeEnding: null, askId: null },
          null,
        );
        return receipts.status(id);
      }
      const stdout = fs.openSync(receipts.artifact(id, 'stdout.log'), 'wx', 0o600);
      const stderr = fs.openSync(receipts.artifact(id, 'stderr.log'), 'a', 0o600);
      try {
        const args = [
          ...options.args,
          ...(options.provider === 'codex' ? ['-o', receipts.artifact(id, 'native.md'), '-'] : []),
        ];
        // Worker output uses inherited files, so an observation deadline does not close its output pipes.
        const observerDeadline = observationDeadline;
        const startup = claudeStartup(options, prompt, bounds, (evidence) => receipts.startup(id, evidence));
        const producer =
          outputEntry && options.logAlias && !options.background
            ? outputProducer(receipts, id, outputEntry, stdout, stderr)
            : null;
        const worker =
          producer?.worker ??
          spawn(options.command, args, {
            cwd: options.cwd,
            env: standaloneEnvironment(options),
            windowsHide: true,
            detached: true,
            stdio: ['pipe', stdout, stderr],
          });
        const outputStat = fs.fstatSync(stdout, { bigint: true });
        const outputIdentity = `${outputStat.dev}:${outputStat.ino}`;
        const seen = observeProcess(
          worker,
          options,
          (sessionId) => {
            if (observation.sessionId === sessionId) return;
            observation.sessionId = receipts.standaloneSession(id, sessionId);
          },
          stdout,
          stderr,
          (cursor = { offset: 0, identity: outputIdentity }) => {
            if (!cursor.identity) cursor.identity = outputIdentity;
            return logChunks(
              receipts.artifact(id, 'stdout.log'),
              bounds.readBytes,
              cursor,
              Math.max(0, (bounds.workBytes ?? 64 * 1024 * 1024) - (cursor?.offset ?? 0)),
            );
          },
          bounds,
          runtime,
          startup,
        );
        worker.stdin?.on('error', () => {
          /* Exit and final evidence determine the observation. */
        });
        worker.stdin?.end(prompt);
        // Attach rejection handling before native identity lookup awaits another process.
        const result = seen.then(
          (ending) => ({ ending, error: null }),
          (error: Error) => ({ ending: null, error }),
        );
        if (producer) await Promise.race([producer.ready, result]);
        const identity =
          worker.pid && !options.background
            ? await runtime.identity(worker.pid, observerDeadline - runtime.now())
            : null;
        const originalProcess =
          worker.pid && identity
            ? {
                pid: worker.pid,
                command: identity.command,
                startedAt: identity.startedAt,
                argsSha256: payloadSha256(JSON.stringify(args)),
                commandLineSha256: payloadSha256(identity.commandLine),
              }
            : null;
        const executable = identity ? path.basename(identity.command).toLowerCase() : '';
        const launcher =
          /^(?:env|cmd|powershell|pwsh|bash|sh|zsh)(?:\.exe)?$/.test(executable) ||
          (options.provider === 'codex' && /^(?:node|bun|deno)(?:\.exe)?$/.test(executable));
        // Interpreter launchers provide observation identity, without proving a native worker handoff.
        observation.launcher = launcher ? originalProcess : null;
        observation.worker = launcher ? null : originalProcess;
        observation.monitor = 'observing';
        await publishObservation();
        const observed = await result;
        if (producer) worker.unref();
        if (observed.error || !observed.ending) {
          const started = !!producer && !!worker.pid;
          if (!started) observation.worker = null;
          observation.monitor = 'unavailable';
          observation.reason = started
            ? 'The worker output connection closed. Worker exit remains unknown.'
            : 'The provider did not start.';
          await publishObservation();
          receipts.publish(
            id,
            {
              outcome: started ? 'unknown' : 'failed',
              availability: started ? 'pending' : 'unavailable',
              nativeEnding: null,
              askId: null,
            },
            null,
          );
          if (publicationError) throw publicationError;
          return receipts.status(id);
        }
        const ending = observed.ending;
        observation.exitCode = ending.exitCode;
        observation.signal = ending.signal;
        if (ending.timedOut) {
          observation.monitor = 'timed-out';
          observation.reason =
            ending.exitCode === null && ending.signal === null
              ? 'Observation timed out. Worker exit remains unknown.'
              : 'Observation timed out before all worker output was read.';
          final = { sessionId: null, outcome: 'unknown', availability: 'pending', text: null, evidence: null };
        } else if (options.background) {
          const backgroundId = bindBackgroundLaunch(receipts, id, ending);
          observation.sessionId = null;
          // The background launcher exit does not establish the background worker exit.
          observation.worker = null;
          observation.exitCode = null;
          if (!backgroundId) {
            observation.monitor = 'unavailable';
            observation.reason = 'Claude background launch identity is unavailable. No replacement was started.';
            final = { sessionId: null, outcome: 'unknown', availability: 'pending', text: null, evidence: null };
          } else {
            startBackgroundOutput(receipts, id, outputEntry);
            if (onBackground) {
              try {
                await onBackground();
              } catch {
                fs.writeSync(stderr, 'The terminal did not open. Use arc dispatch attach with this launch ID.\n');
              }
            }
            final = await observeBackground(receipts, id, observation, options, prompt, publishObservation, capture);
          }
        } else {
          final = ending.frames.finish(
            ending.exitCode,
            ending.signal,
            options.provider === 'codex' ? readNativeReport(receipts.artifact(id, 'native.md')) : undefined,
          );
          observation.monitor = 'finished';
        }
      } finally {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
      }
    }
    if (!options.background) {
      if (!(await startupContinuous(receipts, id, options, bounds, runtime, observationDeadline)))
        final = { sessionId: null, outcome: 'unknown', availability: 'pending', text: null, evidence: null };
      if (final.sessionId && final.evidence) receipts.standaloneSession(id, final.sessionId);
      if (observation.monitor === 'finished') observation.sessionId = final.sessionId;
    }
    const last = receipts.latest(id);
    if (
      !last ||
      last.outcome !== final.outcome ||
      last.report?.sha256 !== (final.text === null ? undefined : payloadSha256(final.text))
    )
      receipts.publish(
        id,
        { outcome: final.outcome, availability: final.availability, nativeEnding: final.evidence, askId: null },
        final.text,
      );
    return await finishObservation();
  } finally {
    try {
      await capture?.close(observationDeadline, runtime);
    } finally {
      lease.release();
    }
  }
}

export async function waitStandaloneIdentity(
  receipts: DispatchReceipts,
  id: string,
  deadlineMs: number,
): Promise<string | null> {
  const options = receipts.launch(id).standalone;
  if (!options) throw new Error('This launch has no standalone session.');
  const deadline = Date.now() + deadlineMs;
  while (true) {
    const accepted = receipts.standaloneSession(id);
    if (accepted) return accepted;
    if (receipts.latest(id) || Date.now() >= deadline) return null;
    await pause(Math.min(100, deadline - Date.now()));
  }
}

export async function waitStandalone(receipts: DispatchReceipts, id: string, deadlineMs: number): Promise<unknown> {
  const launch = receipts.launch(id);
  if (launch.transport !== 'standalone' && launch.completion !== 'wait')
    throw new Error('This dispatch launch did not select waited completion.');
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const event = receipts.latest(id);
    if (event)
      return {
        launchId: id,
        state: 'observed',
        eventId: event.eventId,
        outcome: event.outcome,
        availability: event.availability,
      };
    await pause(Math.min(100, deadline - Date.now()));
  }
  return { launchId: id, state: 'deadline' };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function terminalPlan(
  command: string,
  args: string[],
  cwd: string,
  file: string,
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
  launcher = terminalLauncher(cwd, platform, env, exists),
): { command: string; args: string[] } {
  file = path.resolve(file);
  const shellPath = (value: string) => (platform === 'win32' ? value.replaceAll('\\', '/') : value);
  const context = standaloneContext(env, cwd);
  const exports = Object.entries(context)
    .map(([key, value]) => (value === null ? `unset ${key}` : `export ${key}=${shellQuote(value)}`))
    .join('\n');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env bash\n${exports}\ncd ${shellQuote(shellPath(cwd))} || exit 1\nexec ${[shellPath(command), ...args].map(shellQuote).join(' ')}\n`,
    { flag: 'wx', mode: 0o700 },
  );
  return launcher(file);
}

export function terminalLauncher(
  cwd: string,
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
): (file: string) => { command: string; args: string[] } {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const search = (name: string) =>
    (env.PATH ?? env.Path ?? '')
      .split(platform === 'win32' ? ';' : ':')
      .filter((dir) => paths.isAbsolute(dir))
      .map((dir) => paths.join(dir, name))
      .find(exists);
  if (platform === 'win32') {
    const git = search('git.exe');
    let bash = env.DISPATCH_CLI_BASH;
    if (!bash && git) {
      let ancestor = paths.dirname(git);
      for (let depth = 0; depth < 5 && !bash; depth++) {
        bash = [paths.join(ancestor, 'bin', 'bash.exe'), paths.join(ancestor, 'usr', 'bin', 'bash.exe')].find(exists);
        ancestor = paths.dirname(ancestor);
      }
    }
    const terminal = search('wt.exe');
    if (!terminal || !bash || !exists(bash))
      throw new Error('Windows Terminal and Git Bash are required for --attach.');
    const selectedBash = bash;
    return (file) => ({ command: terminal, args: ['-d', cwd, selectedBash, file.replaceAll('\\', '/')] });
  }
  if (platform === 'darwin')
    return (file) => ({
      command: 'osascript',
      args: ['-e', `tell application "Terminal" to do script ${JSON.stringify(`bash ${shellQuote(file)}`)}`],
    });
  if (env.TMUX) return (file) => ({ command: 'tmux', args: ['new-window', `bash ${shellQuote(file)}`] });
  const terminal = search('x-terminal-emulator');
  if (terminal) return (file) => ({ command: terminal, args: ['-e', 'bash', file] });
  const gnome = search('gnome-terminal');
  if (gnome) return (file) => ({ command: gnome, args: ['--', 'bash', file] });
  throw new Error('A supported terminal is required for --attach.');
}
