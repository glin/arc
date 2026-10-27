import { sessionQueryNeedsShorthand } from './domain/session-query.ts';
import { FILTER_LIMITS } from './sessionfilter.ts';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { writeFileAtomically } from './atomicfile.ts';
import { ARC_IDENTITY } from './identity.ts';
import { arcHome } from './store.ts';
import {
  WindowsPipeServer,
  reportWindowTransport,
  windowTransportErrorCode,
  type WindowTransportSink,
} from './windowpipe.ts';
import {
  GUARDED_SEND_REASONS,
  SessionWriteRequests,
  guardedRefusal,
  sessionWriteBinding,
  validSessionWrite,
  type GuardedSendResult,
  type ReadWriteResult,
  type RequesterProvider,
  type SessionWriteParams,
} from './sessionwrites.ts';
import { RAIL_FILTER_QUERY_LIMIT } from './domain/rail-filters.ts';
import { listingQueryError, sessionQueryError } from './domain/session-query.ts';
import { validCompactCancel, validCompactPayload } from './compactrequest.ts';
import { DISPATCH_ID } from './dispatchreceipts';
import {
  TERMINAL_OWNERSHIP_CAPABILITY,
  collectProcessAncestry,
  integratedTerminal,
  localTerminalPlacement,
  PROCESS_COLLECTION_EXPIRED,
  validAncestry,
  validTerminalOrigin,
  validTerminalOwner,
  type ProcessAncestry,
  type TerminalOrigin,
  type terminalOwnership,
} from './terminalownership.ts';
import { leaseWindowsPipe } from './windowpipe.ts';

export const SESSION_REQUEST_VERSION = 1;
export const SESSION_REQUEST_LIMITS = {
  lineBytes: 64 * 1024,
  lineDeadlineMs: 1_000,
  connections: 16,
  inFlight: 32,
} as const;
const HOST_ID = /^[a-f0-9]{24}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const REGISTRY_BYTES = 64 * 1024;
export const WINDOW_DISCOVERY_LIMITS = { directoryEntries: 1024, hosts: 256, concurrency: 8, diagnostics: 32 } as const;

export interface WindowState {
  folders: string[];
  scopeReady: boolean;
  panelReady: boolean;
  panelVisible: boolean;
}

export interface WindowInfo extends WindowState {
  hostId: string;
  pid: number;
  version: number;
  // Request fields this window accepts beyond its version. A window without the list accepts none.
  capabilities?: string[];
}

// The window accepts `requesterProvider` on start, send, and session requests.
export const SESSION_QUERY_CAPABILITY = 'sessionQuery';
export const SESSION_QUERY_SHORTHAND_CAPABILITY = 'sessionQueryShorthandV1';
export { FILTER_LIMITS } from './sessionfilter.ts';

export const REQUESTER_PROVIDER_CAPABILITY = 'requesterProvider';
export const SESSION_READ_CAPABILITY = 'sessionRead';

export interface HostRegistration extends WindowInfo {
  address: string;
  token: string;
  transportPid?: number;
}

export interface WindowDiscovery {
  windows: WindowInfo[];
  complete: boolean;
  diagnostics?: WindowDiagnostic[];
}

export interface WindowDiagnostic {
  code: 'ENOENT' | 'EACCES' | 'EPERM';
  stage: 'registry' | 'connection';
  hostId?: string;
}

// A sessions cursor is base64url text that the host validates. The wire admits its length and alphabet only.
export const SESSION_CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export interface SessionRequest {
  id: string;
  version: typeof SESSION_REQUEST_VERSION;
  token: string;
  method:
    | 'terminal-owner'
    | 'ping'
    | 'filter'
    | 'sessions'
    | 'session'
    | 'setups'
    | 'start'
    | 'curate'
    | 'send'
    | 'read'
    | 'compact-ready'
    | 'compact-request'
    | 'compact-status'
    | 'compact-cancel'
    | 'dispatch';
  terminalOrigin?: TerminalOrigin;
  requester: string | null;
  // The requester's provider. The CLI sends it on send, session reads, and `arc start --arc-dispatch`, and only
  // when exactly one provider variable is set and the window lists `REQUESTER_PROVIDER_CAPABILITY`.
  requesterProvider?: RequesterProvider;
  params: SessionWriteParams & {
    requestId?: string;
    window?: string;
    self?: true;
    afterTurn?: true;
    ancestry?: ProcessAncestry;
  };
  // The channel sets the payload allowance for sessions requests. The wire parser refuses this key.
  replyBytes?: number;
  filterContext?: { deadline: number; signal: AbortSignal };
}

export type SessionReply = { id: string | null; result: unknown } | { id: string | null; error: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function windowFailureCode(error: unknown): WindowDiagnostic['code'] | undefined {
  if (record(error) && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM'))
    return error.code;
  return undefined;
}

function windowInfo(value: unknown): value is WindowInfo {
  return (
    record(value) &&
    typeof value.hostId === 'string' &&
    HOST_ID.test(value.hostId) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    value.version === SESSION_REQUEST_VERSION &&
    Array.isArray(value.folders) &&
    value.folders.length <= 64 &&
    value.folders.every((folder) => typeof folder === 'string' && folder.length <= 2048) &&
    typeof value.scopeReady === 'boolean' &&
    typeof value.panelReady === 'boolean' &&
    typeof value.panelVisible === 'boolean' &&
    (value.capabilities === undefined ||
      (Array.isArray(value.capabilities) &&
        value.capabilities.length <= 16 &&
        value.capabilities.every((one) => typeof one === 'string' && one.length <= 64)))
  );
}

// Ordinary commands keep the attribution they always had. Only an unambiguous environment names a provider.
export function requesterIdentity(env: NodeJS.ProcessEnv = process.env): {
  requester: string | null;
  provider: RequesterProvider | null;
  ambiguous: boolean;
} {
  const claude = env.CLAUDE_CODE_SESSION_ID || null;
  const codex = env.CODEX_THREAD_ID || null;
  return {
    requester: claude || codex || null,
    provider: claude && codex ? null : claude ? 'claude' : codex ? 'codex' : null,
    ambiguous: !!claude && !!codex,
  };
}

export function parseSessionRequest(value: unknown): SessionRequest | null {
  const keys = record(value)
    ? Object.keys(value)
        .filter((key) => key !== 'terminalOrigin')
        .sort()
        .join(',')
    : '';
  if (
    record(value) &&
    value.terminalOrigin !== undefined &&
    (!validTerminalOrigin(value.terminalOrigin) ||
      [
        'ping',
        'terminal-owner',
        'dispatch',
        'compact-ready',
        'compact-request',
        'compact-status',
        'compact-cancel',
      ].includes(value.method as string))
  )
    return null;
  if (
    !record(value) ||
    (keys !== 'id,method,params,requester,token,version' &&
      keys !== 'id,method,params,requester,requesterProvider,token,version')
  )
    return null;
  if (
    value.requesterProvider !== undefined &&
    (!['claude', 'codex'].includes(value.requesterProvider as string) ||
      !['start', 'send', 'read', 'session'].includes(value.method as string) ||
      value.requester === null)
  )
    return null;
  if (
    typeof value.id !== 'string' ||
    !value.id.length ||
    value.id.length > 128 ||
    value.version !== SESSION_REQUEST_VERSION ||
    typeof value.token !== 'string' ||
    !TOKEN.test(value.token) ||
    ![
      'ping',
      'terminal-owner',
      'sessions',
      'filter',
      'session',
      'setups',
      'start',
      'curate',
      'send',
      'read',
      'compact-ready',
      'compact-request',
      'compact-status',
      'compact-cancel',
      'dispatch',
    ].includes(value.method as string) ||
    !(
      value.requester === null ||
      (typeof value.requester === 'string' && value.requester.length > 0 && value.requester.length <= 256)
    ) ||
    !record(value.params)
  )
    return null;
  if (value.method === 'terminal-owner') {
    if (Object.keys(value.params).join(',') !== 'ancestry' || !validAncestry(value.params.ancestry)) return null;
  } else if (value.method === 'dispatch') {
    const params = value.params;
    const fields =
      params.dispatchAction === 'result'
        ? 'dispatchAction,eventId,launchId'
        : params.dispatchAction === 'wait'
          ? 'deadlineMs,dispatchAction,launchId'
          : 'dispatchAction,launchId';
    const paging = params.dispatchAction === 'status' || params.dispatchAction === 'refresh';
    if (
      Object.keys(params)
        .filter((key) => !(paging && ['cursor', 'limit'].includes(key)))
        .sort()
        .join(',') !== fields
    )
      return null;
    if (
      !Object.keys(params).every((key) =>
        ['dispatchAction', 'launchId', 'eventId', 'deadlineMs', ...(paging ? ['cursor', 'limit'] : [])].includes(key),
      ) ||
      typeof params.launchId !== 'string' ||
      !DISPATCH_ID.test(params.launchId) ||
      (params.cursor !== undefined &&
        (typeof params.cursor !== 'string' || !new RegExp(`^${params.launchId}:[0-9]{1,16}$`).test(params.cursor))) ||
      (params.limit !== undefined &&
        (!Number.isSafeInteger(params.limit) || (params.limit as number) < 1 || (params.limit as number) > 128)) ||
      !['result', 'status', 'wait', 'refresh'].includes(params.dispatchAction as string) ||
      (params.dispatchAction === 'result' &&
        (typeof params.eventId !== 'string' || !DISPATCH_ID.test(params.eventId))) ||
      (params.dispatchAction === 'wait' &&
        (!Number.isSafeInteger(params.deadlineMs) ||
          (params.deadlineMs as number) < 1 ||
          (params.deadlineMs as number) > 110_000))
    )
      return null;
  } else if (value.method === 'compact-ready' || value.method === 'compact-request') {
    if (
      !validCompactPayload(value.params) ||
      (value.method === 'compact-request' && value.id !== value.params.requestId)
    )
      return null;
  } else if (value.method === 'compact-cancel') {
    if (!validCompactCancel(value.params)) return null;
  } else if (value.method === 'compact-status') {
    if (
      Object.keys(value.params).join(',') !== 'requestId' ||
      typeof value.params.requestId !== 'string' ||
      !/^[a-f0-9]{24}:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.params.requestId)
    )
      return null;
  } else if (value.method === 'session') {
    if (
      Object.keys(value.params).sort().join(',') !== 'sessionId,turns' ||
      typeof value.params.sessionId !== 'string' ||
      !value.params.sessionId.length ||
      value.params.sessionId.length > 256 ||
      !Number.isSafeInteger(value.params.turns) ||
      (value.params.turns as number) < 1 ||
      (value.params.turns as number) > 20
    )
      return null;
  } else if (['setups', 'start', 'curate', 'send', 'read'].includes(value.method as string)) {
    if (!validSessionWrite(value.method as string, value.params)) return null;
    if (value.method === 'read' && (!value.requester || !value.requesterProvider)) return null;
  } else if (value.method === 'filter') {
    if (
      Object.keys(value.params).join(',') !== 'query' ||
      typeof value.params.query !== 'string' ||
      value.params.query.length > RAIL_FILTER_QUERY_LIMIT ||
      sessionQueryError(value.params.query)
    )
      return null;
  } else if (value.method === 'sessions') {
    const { cursor, limit, query, ...rest } = value.params;
    if (
      Object.keys(rest).length !== 0 ||
      (query !== undefined &&
        (typeof query !== 'string' || query.length > RAIL_FILTER_QUERY_LIMIT || listingQueryError(query))) ||
      (cursor !== undefined && (typeof cursor !== 'string' || !SESSION_CURSOR.test(cursor))) ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 128))
    )
      return null;
  } else if (Object.keys(value.params).length !== 0) return null;
  return value as unknown as SessionRequest;
}

export function hostAddress(
  home: string,
  hostId: string,
  platform: NodeJS.Platform = process.platform,
  temporaryRoot: string = os.tmpdir(),
): string {
  if (!HOST_ID.test(hostId)) throw new Error('Invalid Arc window identifier.');
  if (platform === 'win32') return `\\\\.\\pipe\\arc-${hostId}`;
  const normal = path.posix.join(path.posix.resolve(home), 'hosts', `${hostId}.sock`);
  if (Buffer.byteLength(normal) < 104) return normal;
  const suffix = path.posix.join(fallbackDirectory(home), `${hostId}.sock`);
  for (const root of [temporaryRoot, '/tmp']) {
    const fallback = path.posix.join(path.posix.resolve(root), suffix);
    if (Buffer.byteLength(fallback) < 104) return fallback;
  }
  throw new Error('The Arc window channel path is too long.');
}

function fallbackDirectory(home: string): string {
  const key = crypto.createHash('sha256').update(path.posix.resolve(home)).digest('hex').slice(0, 16);
  return `a-${key}`;
}

export function validHostAddress(
  home: string,
  hostId: string,
  address: unknown,
  platform = process.platform,
): address is string {
  if (!HOST_ID.test(hostId) || typeof address !== 'string') return false;
  if (platform === 'win32') return address === hostAddress(home, hostId, platform);
  if (
    address.includes('\0') ||
    !path.posix.isAbsolute(address) ||
    path.posix.normalize(address) !== address ||
    Buffer.byteLength(address) >= 104
  )
    return false;
  const normal = path.posix.join(path.posix.resolve(home), 'hosts', `${hostId}.sock`);
  return (
    address === normal ||
    (path.posix.basename(address) === `${hostId}.sock` &&
      path.posix.basename(path.posix.dirname(address)) === fallbackDirectory(home))
  );
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('The Arc window directory is unavailable.');
  }
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

// Each connection holds at most one bounded unfinished line. Its deadline never advances on partial input.
function receiveLines(
  socket: Duplex,
  limits: typeof SESSION_REQUEST_LIMITS | RequestLimits,
  line: (text: string) => void,
  idleDeadlineMs = limits.lineDeadlineMs,
): void {
  let pending = Buffer.alloc(0);
  let idle = false;
  let deadline = setTimeout(() => socket.destroy(), limits.lineDeadlineMs);
  const restart = (ms = idleDeadlineMs, betweenLines = true) => {
    idle = betweenLines;
    clearTimeout(deadline);
    deadline = setTimeout(() => socket.destroy(), ms);
  };
  socket.on('close', () => clearTimeout(deadline));
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length && !socket.destroyed) {
      if (idle) restart(limits.lineDeadlineMs, false);
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (pending.length + end - start > limits.lineBytes) {
        socket.destroy();
        return;
      }
      pending = Buffer.concat([pending, chunk.subarray(start, end)]);
      if (newline < 0) return;
      const text = pending.toString('utf8');
      pending = Buffer.alloc(0);
      restart();
      line(text);
      start = newline + 1;
    }
  });
}

export interface RequestLimits {
  lineBytes: number;
  lineDeadlineMs: number;
  connections: number;
  inFlight: number;
}

export class WindowChannel {
  readonly hostId = crypto.randomBytes(12).toString('hex');
  private readonly writes = new SessionWriteRequests(this.hostId);
  private readonly token = crypto.randomBytes(32).toString('hex');
  private readonly address: string;
  private readonly registryFile: string;
  private readonly sockets = new Set<Duplex>();
  private server!: net.Server;
  private windowsServer: WindowsPipeServer | null = null;
  private generation = 0;
  private failedGeneration = -1;
  private retirement: Promise<void> = Promise.resolve();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private healthy: ReturnType<typeof setTimeout> | null = null;
  private replacements = 0;
  private state: WindowState | null = null;
  private registeredBytes: string | null = null;
  private listening = false;
  private starting: Promise<void> | null = null;
  private closed = false;
  private inFlight = 0;
  private disposal: Promise<void> | null = null;
  private requestHandler: ((request: SessionRequest) => unknown | Promise<unknown>) | null = null;
  private compactHandler: ((request: SessionRequest) => unknown | Promise<unknown>) | null = null;
  private dispatchHandler: ((request: SessionRequest) => unknown | Promise<unknown>) | null = null;
  private diagnostics?: WindowTransportSink;

  private ownership: ReturnType<typeof terminalOwnership> | null = null;
  setTerminalOwnership(ownership: ReturnType<typeof terminalOwnership>): void {
    this.ownership = ownership;
    if (this.listening) this.publish();
  }

  setDiagnostics(diagnostics: WindowTransportSink): void {
    this.diagnostics = diagnostics;
  }

  setDispatchHandler(handler: (request: SessionRequest) => unknown | Promise<unknown>): void {
    this.dispatchHandler = handler;
  }
  private guardedSendHandler: ((request: SessionRequest) => Promise<GuardedSendResult>) | null = null;
  private guardedReadHandler: ((request: SessionRequest) => Promise<ReadWriteResult>) | null = null;

  setGuardedReadHandler(handler: (request: SessionRequest) => Promise<ReadWriteResult>): void {
    this.guardedReadHandler = handler;
    if (this.listening) this.publish();
  }

  setRequestHandler(handler: (request: SessionRequest) => unknown | Promise<unknown>): void {
    this.requestHandler = handler;
  }

  setCompactRequestHandler(handler: (request: SessionRequest) => unknown | Promise<unknown>): void {
    this.compactHandler = handler;
  }

  // Without a handler, every send refuses before input because no session has a recorded owner.
  setGuardedSendHandler(handler: (request: SessionRequest) => Promise<GuardedSendResult>): void {
    this.guardedSendHandler = handler;
    if (this.listening) this.publish();
  }

  constructor(
    private readonly home = arcHome(),
    private readonly limits: RequestLimits = SESSION_REQUEST_LIMITS,
    private readonly ping: (info: WindowInfo) => WindowInfo | Promise<WindowInfo> = (info) => info,
  ) {
    this.address = hostAddress(home, this.hostId);
    this.registryFile = path.join(home, 'hosts', `${this.hostId}.json`);
    this.createTransport();
  }

  private createTransport(): void {
    const generation = ++this.generation;
    this.server = net.createServer((socket) => this.accept(socket, generation));
    this.windowsServer =
      process.platform === 'win32' ? new WindowsPipeServer((event, record) => this.diagnostics?.(event, record)) : null;
    const server = this.server;
    this.windowsServer?.on('connection', (socket: Duplex) => this.accept(socket, generation));
    this.windowsServer?.on('error', (error: Error) => server.emit('error', error));
    this.server.on('error', (error) => {
      if (generation !== this.generation || this.closed) return;
      reportWindowTransport(this.diagnostics, 'channelError', { errorCode: windowTransportErrorCode(error) });
      this.failTransport(generation);
    });
  }

  // The provider calls update only after it restores saved state.
  async update(state: WindowState): Promise<void> {
    if (this.closed) return Promise.resolve();
    const generation = this.generation;
    try {
      this.state = { ...state, folders: [...state.folders] };
      if (this.listening) {
        this.publish();
        return;
      }
      if (this.retry || this.failedGeneration === this.generation) return;
      if (!this.starting) this.startTransport();
      await this.starting;
    } catch (error) {
      if (this.closed) return;
      reportWindowTransport(this.diagnostics, 'channelSetupRejected', { errorCode: windowTransportErrorCode(error) });
      this.failTransport(generation);
      throw error;
    }
  }

  get windowId(): string | null {
    return this.closed ? null : this.hostId;
  }

  private info(): WindowInfo {
    return {
      ...this.state!,
      folders: [...this.state!.folders],
      hostId: this.hostId,
      pid: process.pid,
      version: SESSION_REQUEST_VERSION,
      capabilities: [
        ...(this.ownership ? [TERMINAL_OWNERSHIP_CAPABILITY] : []),
        REQUESTER_PROVIDER_CAPABILITY,
        SESSION_QUERY_CAPABILITY,
        SESSION_QUERY_SHORTHAND_CAPABILITY,
        'launchPolicy',
        ...(this.dispatchHandler ? ['dispatchResults'] : []),
        ...(this.guardedReadHandler ? [SESSION_READ_CAPABILITY] : []),
        ...(this.guardedSendHandler ? ['agentMessageQueue', 'agentMessageSend'] : []),
      ],
    };
  }

  private publish(): void {
    if (this.closed || !this.state || !this.listening) return;
    const registration: HostRegistration = {
      ...this.info(),
      address: this.address,
      token: this.token,
      ...(this.windowsServer ? { transportPid: this.windowsServer.pid } : {}),
    };
    if (!windowInfo(registration)) throw new Error('The Arc window state is too large.');
    const bytes = JSON.stringify(registration);
    if (Buffer.byteLength(bytes) > REGISTRY_BYTES) throw new Error('The Arc window state is too large.');
    if (bytes === this.registeredBytes) {
      try {
        if (readRegistration(this.registryFile) === bytes) return;
      } catch {
        /* Restore a missing or unreadable registration on the next state publication. */
      }
    }
    writeFileAtomically(this.registryFile, bytes, fs.renameSync, 0o600, false);
    this.registeredBytes = bytes;
  }

  private startTransport(): void {
    const generation = this.generation;
    const starting = this.listen(generation).finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
  }

  private async listen(generation: number): Promise<void> {
    privateDirectory(path.dirname(this.registryFile));
    if (process.platform !== 'win32') privateDirectory(path.dirname(this.address));
    if (this.windowsServer) {
      await this.windowsServer.listen(this.address);
    } else {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        this.server.once('error', failed);
        this.server.listen(this.address, () => {
          this.server.removeListener('error', failed);
          resolve();
        });
      });
    }
    if (this.closed || generation !== this.generation || this.failedGeneration === generation) return;
    this.listening = true;
    if (process.platform !== 'win32') fs.chmodSync(this.address, 0o600);
    this.publish();
    this.healthy = setTimeout(() => {
      this.healthy = null;
      if (!this.closed && generation === this.generation && this.listening) this.replacements = 0;
    }, 30_000);
    this.healthy.unref?.();
  }

  private failTransport(generation: number): void {
    if (this.closed || generation !== this.generation || this.failedGeneration === generation) return;
    this.failedGeneration = generation;
    this.listening = false;
    if (this.healthy) clearTimeout(this.healthy);
    this.healthy = null;
    const server = this.server;
    const windows = this.windowsServer;
    const starting = this.starting;
    for (const socket of this.sockets) socket.destroy();
    this.retirement = this.retireTransport(server, windows, starting);
    void this.retirement.then(() => {
      if (this.closed || generation !== this.generation) return;
      const delay = [100, 500, 2000][this.replacements];
      if (delay === undefined) {
        void this.dispose();
        return;
      }
      this.replacements++;
      this.retry = setTimeout(() => {
        this.retry = null;
        if (this.closed || generation !== this.generation) return;
        this.createTransport();
        this.startTransport();
        void this.starting!.catch((error) => {
          if (this.closed) return;
          reportWindowTransport(this.diagnostics, 'channelSetupRejected', {
            errorCode: windowTransportErrorCode(error),
          });
          this.failTransport(this.generation);
        });
      }, delay);
      this.retry.unref?.();
    });
  }

  private async retireTransport(
    server: net.Server,
    windows: WindowsPipeServer | null,
    starting: Promise<void> | null,
  ): Promise<void> {
    if (windows) await windows.close();
    await starting?.catch(() => {});
    if (!windows && server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: Duplex, generation: number): void {
    if (
      this.closed ||
      generation !== this.generation ||
      this.failedGeneration === generation ||
      this.sockets.size >= this.limits.connections
    ) {
      socket.on('error', () => {});
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    receiveLines(
      socket,
      this.limits,
      (text) => {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          this.answer(socket, { id: null, error: 'Invalid request.' });
          return;
        }
        if (
          record(value) &&
          Object.keys(value).join(',') === 'challenge' &&
          typeof value.challenge === 'string' &&
          TOKEN.test(value.challenge)
        ) {
          const proof = crypto
            .createHmac('sha256', Buffer.from(this.token, 'hex'))
            .update(value.challenge)
            .digest('hex');
          const bytes = JSON.stringify({ proof }) + '\n';
          if (socket.writableLength + Buffer.byteLength(bytes) > this.limits.lineBytes) socket.destroy();
          else socket.write(bytes);
          return;
        }
        const request = parseSessionRequest(value);
        if (!request) {
          this.answer(socket, { id: null, error: 'Invalid request.' });
          return;
        }
        if (!crypto.timingSafeEqual(Buffer.from(request.token, 'hex'), Buffer.from(this.token, 'hex'))) {
          this.answer(socket, { id: request.id, error: 'Access denied.' });
          return;
        }
        if (this.inFlight >= this.limits.inFlight) {
          socket.destroy();
          return;
        }
        const cancellation =
          request.method === 'filter' || request.method === 'dispatch' ? new AbortController() : null;
        const disconnected = () => cancellation?.abort();
        if (cancellation) {
          request.filterContext = { deadline: Date.now() + FILTER_LIMITS.operationMs, signal: cancellation.signal };
          socket.once('close', disconnected);
        }
        this.inFlight++;
        void Promise.resolve()
          .then<unknown>(async () => {
            if (this.closed) throw new Error('Window unavailable.');
            if (request.method === 'ping') return this.ping(this.info());
            if (request.method === 'terminal-owner') {
              const data = this.ownership
                ? await this.ownership.inquire(request.params.ancestry!)
                : { status: 'unknown' };
              if (this.closed || generation !== this.generation || socket.destroyed)
                throw new Error('Window unavailable.');
              return { window: this.info(), data };
            }
            if (request.terminalOrigin) {
              const admitted = this.ownership && (await this.ownership.admit(request.terminalOrigin));
              if (
                !admitted ||
                this.closed ||
                generation !== this.generation ||
                this.failedGeneration === generation ||
                socket.destroyed
              )
                throw new Error('The terminal no longer belongs to this Arc window. Select a window with --window.');
            }
            if (request.method === 'dispatch') {
              if (!this.dispatchHandler) throw new Error('This Arc window does not support dispatch results.');
              return Promise.resolve(this.dispatchHandler(request)).then((data) => {
                const result = { window: this.info(), data };
                if (Buffer.byteLength(JSON.stringify({ id: request.id, result }) + '\n') > this.limits.lineBytes)
                  throw new Error('The dispatch reply exceeds this window channel allowance. Read one event.');
                return result;
              });
            }
            if (request.method.startsWith('compact-')) {
              const data = this.compactHandler
                ? this.compactHandler(request)
                : request.method === 'compact-ready'
                  ? { ready: false }
                  : { requestId: request.params.requestId, state: 'unavailable' };
              return Promise.resolve(data).then((data) => {
                const result = { window: this.info(), data };
                if (Buffer.byteLength(JSON.stringify({ id: request.id, result }) + '\n') > this.limits.lineBytes)
                  throw new Error("The compaction response exceeds this window's channel limit.");
                return result;
              });
            }
            const write = request.method === 'start' || request.method === 'curate' || request.method === 'send';
            if (request.method === 'read') {
              const apply = () =>
                this.guardedReadHandler
                  ? this.guardedReadHandler(request)
                  : Promise.resolve({
                      version: 1,
                      status: 'refused',
                      requestId: request.id,
                      sessionId: request.params.sessionId,
                      requester: null,
                      marked: [],
                      reason: 'This Arc window does not support marking sessions read.',
                    });
              return this.writes
                .run(request.id, this.binding(request), apply)
                .then((data) => ({ window: this.info(), data }));
            }
            if (request.method === 'send') {
              const send = () =>
                this.guardedSendHandler
                  ? this.guardedSendHandler(request)
                  : guardedRefusal(request.id, request.params.prompt ?? '', GUARDED_SEND_REASONS.unrelated);
              return this.writes
                .runGuarded(request.id, this.binding(request), send)
                .then((data) => ({ window: this.info(), data: { ...(data as object), requestId: request.id } }));
            }
            if (!this.requestHandler) throw new Error('Session reads are unavailable in this window.');
            // A sessions reply reuses this window object, so its payload can fill the rest of the line.
            const window = request.method === 'sessions' ? this.info() : null;
            const handled = window
              ? {
                  ...request,
                  replyBytes:
                    this.limits.lineBytes -
                    Buffer.byteLength(JSON.stringify({ id: request.id, result: { window, data: null } }) + '\n') +
                    Buffer.byteLength('null'),
                }
              : request;
            const apply = () => this.requestHandler!(handled);
            // A curation dry run changes nothing, so it is evaluated afresh each time and fills no retention.
            const data =
              request.method === 'curate' && request.params.dryRun === true
                ? this.writes.evaluate(request.id, this.binding(request), apply)
                : write
                  ? this.writes.run(request.id, this.binding(request), apply)
                  : Promise.resolve().then(apply);
            return Promise.resolve(data).then((data) => {
              if (write) data = { ...(data as object), requestId: request.id };
              const result = { window: window ?? this.info(), data };
              if (Buffer.byteLength(JSON.stringify({ id: request.id, result }) + '\n') > this.limits.lineBytes)
                throw new Error("The session response exceeds this window's channel limit.");
              return result;
            });
          })
          .then(
            (result) => this.answer(socket, { id: request.id, result }),
            (error: unknown) =>
              this.answer(socket, {
                id: request.id,
                error: error instanceof Error ? error.message : 'Window unavailable.',
              }),
          )
          .finally(() => {
            socket.removeListener('close', disconnected);
            this.inFlight--;
          });
      },
      120_000,
    );
  }

  private binding(request: SessionRequest): unknown {
    return sessionWriteBinding(
      this.hostId,
      request.method,
      request.params,
      request.requester,
      request.requesterProvider ?? null,
    );
  }

  private answer(socket: Duplex, reply: SessionReply): void {
    if (this.closed || socket.destroyed) return;
    const bytes = JSON.stringify(reply) + '\n';
    if (socket.writableLength + Buffer.byteLength(bytes) > this.limits.lineBytes) socket.destroy();
    else socket.write(bytes);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    reportWindowTransport(this.diagnostics, 'channelDispose', { sockets: this.sockets.size });
    this.closed = true;
    this.listening = false;
    if (this.retry) clearTimeout(this.retry);
    if (this.healthy) clearTimeout(this.healthy);
    this.retry = this.healthy = null;
    for (const socket of this.sockets) socket.destroy();
    this.disposal = this.close();
    return this.disposal;
  }

  private async close(): Promise<void> {
    await this.retireTransport(this.server, this.windowsServer, this.starting);
    await this.retirement;
    removeOwnedRegistration(this.registryFile, this.registeredBytes, this.address, this.home, true, this.diagnostics);
    this.server.removeAllListeners();
  }
}

function removeOwnedRegistration(
  file: string,
  expected: string | null,
  address: string,
  home: string,
  removeSocket = true,
  diagnostics?: WindowTransportSink,
): boolean {
  if (expected === null) {
    reportWindowTransport(diagnostics, 'registrationRemoval', {
      outcome: 'noExpectedBytes',
      registrationRemoved: false,
    });
    return false;
  }
  let removed = false;
  type RemovalStage = 'read' | 'unlink' | 'socketStat' | 'socketUnlink' | 'directoryRemove';
  let stage: RemovalStage = 'read';
  let failure: { stage: RemovalStage; errorCode: string } | undefined;
  try {
    if (readRegistration(file) !== expected) {
      reportWindowTransport(diagnostics, 'registrationRemoval', {
        outcome: 'ownershipMismatch',
        stage,
        registrationRemoved: false,
      });
      return false;
    }
    stage = 'unlink';
    fs.unlinkSync(file);
    removed = true;
    if (removeSocket && process.platform !== 'win32') {
      stage = 'socketStat';
      if (fs.lstatSync(address).isSocket()) {
        stage = 'socketUnlink';
        fs.unlinkSync(address);
      }
    }
  } catch (error) {
    const errorCode = windowTransportErrorCode(error);
    if (stage !== 'socketStat' || errorCode !== 'ENOENT') failure = { stage, errorCode };
    /* Preserve paths whose ownership cannot be established. */
  }
  if (
    removeSocket &&
    process.platform !== 'win32' &&
    path.dirname(address) !== path.join(path.resolve(home), 'hosts')
  ) {
    try {
      stage = 'directoryRemove';
      fs.rmdirSync(path.dirname(address));
    } catch (error) {
      failure ??= { stage, errorCode: windowTransportErrorCode(error) };
      /* Another host retains the shared directory. */
    }
  }
  reportWindowTransport(diagnostics, 'registrationRemoval', {
    outcome: failure ? 'failed' : 'removed',
    registrationRemoved: removed,
    ...(failure ?? { stage }),
  });
  return removed;
}

// Folderless ownership's bounded reader has a different byte allowance and no registry file-kind check.
function readRegistration(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Invalid Arc window registration.');
    const buffer = Buffer.alloc(REGISTRY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > REGISTRY_BYTES) throw new Error('Invalid Arc window registration.');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

async function exchangeWindow(
  entry: HostRegistration,
  deadlineMs = 1_000,
  registrationFile = '',
  method: SessionRequest['method'] = 'ping',
  params: SessionRequest['params'] = {},
  requestId?: string,
  attributed = false,
  onTimeout?: () => void,
  onFailure?: (code: WindowDiagnostic['code']) => void,
  terminalOrigin?: TerminalOrigin,
): Promise<unknown | null> {
  if (process.platform === 'win32' && (!Number.isSafeInteger(entry.transportPid) || entry.transportPid! <= 0))
    return null;
  const id = requestId ?? `${entry.hostId}:${crypto.randomBytes(12).toString('hex')}`;
  if (
    method === 'start' &&
    (params.readOnly !== undefined || params.readTools !== undefined || params.cwd !== undefined) &&
    !entry.capabilities?.includes('launchPolicy')
  )
    throw new Error(
      'The selected Arc window does not support read-only starts or scoped launch folders. No session was started.',
    );
  if ((method === 'terminal-owner' || terminalOrigin) && !entry.capabilities?.includes(TERMINAL_OWNERSHIP_CAPABILITY))
    throw new Error('Reload this Arc window or select it explicitly with --window.');
  const identity = requesterIdentity();
  const request: SessionRequest = {
    id,
    version: SESSION_REQUEST_VERSION,
    token: entry.token,
    method,
    requester: identity.requester,
    ...(terminalOrigin ? { terminalOrigin } : {}),
    ...(attributed && identity.provider && providerCapable(entry) ? { requesterProvider: identity.provider } : {}),
    params,
  };
  const line = JSON.stringify(request) + '\n';
  // A line above the channel bound would close the connection after the write. Refuse it before connecting.
  if (Buffer.byteLength(line) > SESSION_REQUEST_LIMITS.lineBytes)
    throw new Error('The request exceeds the Arc window channel limit. Nothing was sent.');
  let socket: Duplex;
  try {
    socket =
      process.platform === 'win32'
        ? await WindowsPipeServer.connect(entry.address, entry.pid, entry.transportPid!, registrationFile, deadlineMs)
        : net.createConnection(entry.address);
  } catch (error) {
    const code = windowFailureCode(error);
    if (process.platform !== 'win32' && code) onFailure?.(code);
    return null;
  }
  return new Promise((resolve, reject) => {
    const challenge = crypto.randomBytes(32).toString('hex');
    let connected = false;
    let authenticated = false;
    let settled = false;
    const finish = (info: unknown | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(info);
    };
    const deadline = setTimeout(() => {
      if (connected) onTimeout?.();
      finish(null);
    }, deadlineMs);
    socket.on('error', (error: unknown) => {
      const code = windowFailureCode(error);
      if (!settled && code) onFailure?.(code);
      finish(null);
    });
    socket.on('close', () => finish(null));
    receiveLines(socket, { ...SESSION_REQUEST_LIMITS, lineDeadlineMs: deadlineMs }, (text) => {
      try {
        const reply: unknown = JSON.parse(text);
        if (!authenticated) {
          const expected = crypto.createHmac('sha256', Buffer.from(entry.token, 'hex')).update(challenge).digest('hex');
          if (
            !record(reply) ||
            typeof reply.proof !== 'string' ||
            !TOKEN.test(reply.proof) ||
            !crypto.timingSafeEqual(Buffer.from(reply.proof, 'hex'), Buffer.from(expected, 'hex'))
          ) {
            finish(null);
            return;
          }
          authenticated = true;
          socket.write(line);
          return;
        }
        if (record(reply) && reply.id === id && typeof reply.error === 'string') {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          socket.destroy();
          reject(new Error(reply.error));
          return;
        }
        const info =
          method === 'ping'
            ? record(reply)
              ? reply.result
              : null
            : record(reply) && record(reply.result)
              ? reply.result.window
              : null;
        if (
          !record(reply) ||
          reply.id !== id ||
          !windowInfo(info) ||
          info.hostId !== entry.hostId ||
          info.pid !== entry.pid
        ) {
          finish(null);
          return;
        }
        const { hostId, pid, version, folders, scopeReady, panelReady, panelVisible, capabilities } = info;
        finish(
          method === 'ping'
            ? {
                hostId,
                pid,
                version,
                folders,
                scopeReady,
                panelReady,
                panelVisible,
                ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }),
              }
            : (reply.result as Record<string, unknown>).data,
        );
      } catch {
        finish(null);
      }
    });
    socket.on('connect', () => {
      connected = true;
      socket.write(JSON.stringify({ challenge }) + '\n');
    });
  });
}

export async function pingWindow(
  entry: HostRegistration,
  deadlineMs = 1_000,
  registrationFile = '',
  onFailure?: (code: WindowDiagnostic['code']) => void,
): Promise<WindowInfo | null> {
  return (await exchangeWindow(
    entry,
    deadlineMs,
    registrationFile,
    'ping',
    {},
    undefined,
    false,
    undefined,
    onFailure,
  ).catch(() => null)) as WindowInfo | null;
}

// A window that predates `requesterProvider` refuses any request that carries it, so the CLI sends it only when listed.
function providerCapable(entry: WindowInfo): boolean {
  return entry.capabilities?.includes(REQUESTER_PROVIDER_CAPABILITY) ?? false;
}

// Guarded starts carry requester identity. Dispatch fields require dispatchResults admission.
export class WindowUnavailableError extends Error {}

export async function requestWindow(
  method: Exclude<SessionRequest['method'], 'ping'>,
  params: SessionRequest['params'],
  selector = process.env[`${ARC_IDENTITY.environmentPrefix}WINDOW`],
  home = arcHome(),
  requestId?: string,
  guardedStart = false,
): Promise<unknown> {
  if (method === 'read' && !requestId) throw new Error('Marking read requires an explicit request ID.');
  if (!selector && (method.startsWith('compact-') || method === 'dispatch'))
    throw new Error('Select an Arc window with --window.');
  const automatic = !selector && integratedTerminal();
  const release = automatic ? await leaseWindowsPipe() : () => {};
  try {
    let ancestry: ProcessAncestry | undefined;
    if (automatic) {
      if (!localTerminalPlacement()) throw new Error('Select this Arc window with --window in this terminal.');
      try {
        ancestry = await collectProcessAncestry();
      } catch (error) {
        if (error instanceof Error && error.message === PROCESS_COLLECTION_EXPIRED)
          throw new Error(
            'Reading the terminal process list took too long. Run the command again or select this Arc window with --window.',
            { cause: error },
          );
        throw new Error('The terminal owner is unavailable. Select this Arc window with --window.', { cause: error });
      }
    }
    let origin: TerminalOrigin | undefined;
    let selected = selector;
    if (!selected) {
      const discovery = await discoverWindows(home);
      if (!discovery.complete) throw new Error('Arc window discovery is incomplete. Select a window with --window.');
      if (ancestry) {
        if (
          !discovery.windows.length ||
          discovery.windows.some((window) => !window.capabilities?.includes(TERMINAL_OWNERSHIP_CAPABILITY))
        )
          throw new Error('Reload Arc windows or select the intended window with --window.');
        const replies = await Promise.all(
          discovery.windows.map(async (window) => {
            try {
              return { window, owner: await requestWindow('terminal-owner', { ancestry }, window.hostId, home) };
            } catch {
              return { window, owner: null };
            }
          }),
        );
        if (replies.some(({ owner }) => !validTerminalOwner(owner) || owner.status === 'unknown'))
          throw new Error('The terminal owner is unavailable. Select this Arc window with --window.');
        const matches = replies.filter(({ owner }) => validTerminalOwner(owner) && owner.status === 'match');
        if (matches.length !== 1)
          throw new Error('Select this Arc window with --window. The terminal owner is not unique.');
        const match = matches[0];
        if (!validTerminalOwner(match.owner) || match.owner.status !== 'match')
          throw new Error('Terminal unavailable.');
        selected = match.window.hostId;
        origin = {
          platform: ancestry.platform,
          caller: { pid: ancestry.chain[0].pid, birth: ancestry.chain[0].birth },
          root: match.owner.root,
        };
      } else {
        if (discovery.windows.length !== 1)
          throw new Error(`Select one Arc window with --window or ${ARC_IDENTITY.environmentPrefix}WINDOW.`);
        selected = discovery.windows[0].hostId;
      }
    }
    if (!HOST_ID.test(selected)) throw new Error('Invalid Arc window identifier.');
    const file = path.join(home, 'hosts', `${selected}.json`);
    let entry: HostRegistration;
    try {
      const value: unknown = JSON.parse(readRegistration(file));
      if (
        !windowInfo(value) ||
        !record(value) ||
        value.hostId !== selected ||
        typeof value.token !== 'string' ||
        !TOKEN.test(value.token) ||
        !validHostAddress(home, selected, value.address)
      )
        throw new Error();
      entry = value as unknown as HostRegistration;
    } catch (error) {
      const code = windowFailureCode(error);
      if (code === 'ENOENT') {
        const variable = `${ARC_IDENTITY.environmentPrefix}WINDOW`;
        const current = process.env[variable];
        const shown = current !== undefined && HOST_ID.test(current) && current !== selected;
        throw new WindowUnavailableError(
          `Arc window ${selected} is not registered. ${shown ? `${variable} is ${current} for this command. ` : ''}Run arc windows --json and select the intended folders.`,
        );
      }
      if (code === 'EACCES' || code === 'EPERM')
        throw new WindowUnavailableError(
          `Local access to Arc window ${selected} failed (${code}). Check that your current permissions allow reading this window's local details.`,
        );
      throw new WindowUnavailableError('The selected Arc window is unavailable.');
    }
    const id = requestId ?? `${entry.hostId}:${crypto.randomBytes(12).toString('hex')}`;
    if (requestId && !requestId.startsWith(entry.hostId + ':'))
      throw new Error(`Request ${requestId} has an unknown outcome in this activation.`);
    if (method === 'send' && !providerCapable(entry))
      throw new Error('The selected Arc window must reload before it can accept send. No prompt was sent.');
    if (method === 'send' && params.delivery === 'auto' && !entry.capabilities?.includes('agentMessageSend'))
      throw new Error('The selected Arc window must reload before it can deliver messages. No prompt was sent.');
    if (
      method === 'send' &&
      params.delivery !== 'auto' &&
      !Object.prototype.hasOwnProperty.call(params, 'observation') &&
      !entry.capabilities?.includes('agentMessageQueue')
    )
      throw new Error('The selected Arc window must reload before it can queue messages. No prompt was sent.');
    if (
      (method === 'dispatch' || (method === 'start' && params.dispatch)) &&
      !entry.capabilities?.includes('dispatchResults')
    )
      throw new Error('The selected Arc window must reload before it can accept dispatch results. No prompt was sent.');
    if (method === 'read' && (!providerCapable(entry) || !entry.capabilities?.includes(SESSION_READ_CAPABILITY)))
      throw new Error('The selected Arc window does not support marking sessions read.');
    if (
      (method === 'filter' || (method === 'sessions' && params.query !== undefined)) &&
      !entry.capabilities?.includes(SESSION_QUERY_CAPABILITY)
    )
      throw new Error('The selected Arc window must reload before it can accept filter queries.');
    if (
      (method === 'filter' || method === 'sessions') &&
      params.query !== undefined &&
      sessionQueryNeedsShorthand(params.query) &&
      !entry.capabilities?.includes(SESSION_QUERY_SHORTHAND_CAPABILITY)
    )
      throw new Error('The selected Arc window must reload before it can accept session ID shorthand.');
    const write =
      method === 'start' ||
      method === 'curate' ||
      method === 'send' ||
      method === 'read' ||
      method === 'compact-request';
    const attributed =
      method === 'send' || method === 'read' || method === 'session' || (method === 'start' && guardedStart);
    let timedOut = false;
    let failureCode: WindowDiagnostic['code'] | undefined;
    const result = await exchangeWindow(
      entry,
      method === 'filter'
        ? FILTER_LIMITS.transportMs
        : method === 'dispatch' && params.dispatchAction === 'wait'
          ? (params.deadlineMs ?? 110_000) + 5_000
          : write
            ? 120_000
            : 5_000,
      file,
      method,
      params,
      id,
      attributed,
      () => {
        timedOut = true;
      },
      (code) => {
        failureCode = code;
      },
      origin,
    );
    if (result === null) {
      if (method === 'dispatch' && params.dispatchAction === 'wait')
        return {
          launchId: params.launchId,
          state: 'uncertain',
          reason: 'The wait disconnected. Read dispatch status or recover this receipt.',
        };
      if (method === 'filter')
        return {
          version: 1,
          status: 'unknown',
          reason: 'The filter outcome is unknown. Read the panel before retrying.',
        };
      if (method === 'compact-request')
        return {
          version: 1,
          state: 'uncertain',
          requestId: id,
          window: entry.hostId,
          reason: 'Admission is uncertain. Observe this request without retrying or switching transports.',
        };
      if (write)
        return {
          version: 1,
          status: 'unknown',
          requestId: id,
          window: entry.hostId,
          reason: 'Delivery is unknown. Retry only this request ID in this window.',
        };
      if (failureCode === 'EACCES' || failureCode === 'EPERM')
        throw new WindowUnavailableError(
          `Local access to Arc window ${entry.hostId} failed (${failureCode}). Check that your current permissions allow connecting to this window's local socket.`,
        );
      throw new Error(
        timedOut ? 'The selected Arc window did not answer in time.' : 'The selected Arc window is unavailable.',
      );
    }
    return result;
  } finally {
    release();
  }
}

function processIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export async function discoverWindows(home = arcHome()): Promise<WindowDiscovery> {
  const directory = path.join(home, 'hosts');
  let entries: fs.Dir;
  try {
    entries = await fs.promises.opendir(directory, { bufferSize: WINDOW_DISCOVERY_LIMITS.concurrency });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { windows: [], complete: true };
    throw new Error('Arc windows are unavailable.', { cause: error });
  }
  const live: WindowInfo[] = [];
  const diagnostics: WindowDiagnostic[] = [];
  const observe = (error: unknown, stage: WindowDiagnostic['stage'], hostId: string) => {
    const code = windowFailureCode(error);
    if (code && diagnostics.length < WINDOW_DISCOVERY_LIMITS.diagnostics) diagnostics.push({ code, stage, hostId });
    return code;
  };
  let complete = true;
  let visited = 0;
  let admitted = 0;
  let batch: Promise<void>[] = [];
  try {
    while (true) {
      const next = await entries.read();
      if (!next) break;
      if (visited++ >= WINDOW_DISCOVERY_LIMITS.directoryEntries || admitted >= WINDOW_DISCOVERY_LIMITS.hosts) {
        complete = false;
        break;
      }
      const name = next.name;
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      let bytes: string;
      let entry: HostRegistration;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > REGISTRY_BYTES) continue;
        bytes = readRegistration(file);
        const value: unknown = JSON.parse(bytes);
        if (
          !windowInfo(value) ||
          !record(value) ||
          typeof value.token !== 'string' ||
          !TOKEN.test(value.token) ||
          value.hostId !== name.slice(0, -5) ||
          !validHostAddress(home, value.hostId, value.address) ||
          (process.platform === 'win32' &&
            (!Number.isSafeInteger(value.transportPid) || (value.transportPid as number) <= 0))
        )
          continue;
        entry = value as unknown as HostRegistration;
      } catch (error) {
        const code = windowFailureCode(error);
        if (code !== 'ENOENT') observe(error, 'registry', name.slice(0, -5));
        if (code === 'EACCES' || code === 'EPERM') complete = false;
        continue;
      }
      admitted++;
      batch.push(
        (async () => {
          let failureCode: WindowDiagnostic['code'] | undefined;
          const info = await pingWindow(entry, 1_000, file, (code) => {
            failureCode = code;
          }).catch(() => null);
          if (info) live.push(info);
          else if (!processIsDead(entry.pid) || !removeOwnedRegistration(file, bytes, entry.address, home, false)) {
            complete = false;
            if (failureCode) observe({ code: failureCode }, 'connection', entry.hostId);
          }
        })(),
      );
      if (batch.length === WINDOW_DISCOVERY_LIMITS.concurrency) {
        await Promise.all(batch);
        batch = [];
      }
    }
  } catch (error) {
    throw new Error('Arc windows are unavailable.', { cause: error });
  } finally {
    try {
      await Promise.all(batch);
    } finally {
      await entries.close();
    }
  }
  return {
    windows: live.sort((a, b) => a.hostId.localeCompare(b.hostId)),
    complete,
    ...(diagnostics.length
      ? {
          diagnostics: diagnostics.sort(
            (a, b) =>
              a.hostId!.localeCompare(b.hostId!) || a.stage.localeCompare(b.stage) || a.code.localeCompare(b.code),
          ),
        }
      : {}),
  };
}
