import { MEASUREMENT_ENVIRONMENT } from './identity';
import { unavailableDefaults, type AppliedDefaults } from './view/model-picks';
import { CONTEXT_FRAME_BYTES, CONTEXT_PREFIX_BYTES, type ContextFrameGate } from './contextframe';
// Owns this window's agent children, stdout framing, session ownership, and shutdown.
// Wire adapters handle each provider's protocol. Process operations use an injected spawner.
// A live child serves successive turns until retirement, shutdown, or a session reset.

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  ClaudeWire,
  PermissionMode,
  SpawnOptions,
  readUsage,
  readModels as readClaudeModels,
  spawnArgs,
} from './claudewire';
import {
  CodexWire,
  ApprovalPolicy,
  ApprovalsReviewer,
  ClientInfo,
  SandboxMode,
  appServerArgs,
  readRateLimits,
  readModels as readCodexModels,
} from './codexwire';
import {
  WireEvent,
  Ask,
  AskAnswer,
  McpServer,
  ModelChoice,
  ModelList,
  PromptEntry,
  UsageReading,
  AgentPromptInput,
} from './agentwire';
import {
  AskMode,
  SessionSettingSelection,
  chosenModel,
  clearCommand,
  compactCommand,
  effortChoices,
} from './composerview';
import { confirmClaudeRename } from './sessionrename';
import { readCustomTitleSidecar } from './transcript';
import { ARC_IDENTITY } from './identity';

// The child-process methods used by the host. Tests supply these methods without starting a CLI.
export interface ChildLike {
  stdin: { write(chunk: string): void; end(): void };
  stdout: { on(event: 'data', listener: (chunk: string | Buffer) => void): void; setEncoding(encoding: string): void };
  stderr: { on(event: 'data', listener: (chunk: string | Buffer) => void): void; setEncoding(encoding: string): void };
  kill(): void;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

export type Spawner = (
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  agent?: AgentName,
  cli?: ArcCliEnvironment,
) => ChildLike;

// Returns a refusal for Windows batch shims, which cannot be spawned directly without a shell.
// `composerview.ts` resolves a shim's package script or executable before launch.
export function unstartable(command: string, platform: string): string | null {
  const lower = command.toLowerCase();
  if (platform !== 'win32') {
    return null;
  }
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) {
    return null;
  }
  return (
    `${command} is a batch shim, which cannot be started directly. ` +
    "Point the setting at the real executable, or at the package's own script."
  );
}

// Inherited Claude client identity variables are removed before launch variables are applied.
// These variables affect request attribution, session links, generated titles, and child-session behavior.
// Every case variant is removed, including on Windows.
// `childEnv` sets `ELECTRON_RUN_AS_NODE` so VS Code's Electron executable can run a package script.
// Launch variables restore package-specific settings. An explicit Claude billing label can override attribution.
const HOST_IDENTITY_ENV_NAMES = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CONTAINER_ID',
];

export interface ArcCliEnvironment {
  directory: string;
  editorExecutable: string;
  windowId: string | null;
  platform?: string;
}

export function childEnv(
  inherited: Record<string, string | undefined>,
  wanted: Record<string, string>,
  agent?: AgentName,
  cwd?: string,
  cli?: ArcCliEnvironment,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...inherited, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(env)) {
    if (HOST_IDENTITY_ENV_NAMES.includes(key.toUpperCase())) {
      delete env[key];
    }
  }
  Object.assign(env, wanted);
  if (cli) {
    const windowKey = `${ARC_IDENTITY.environmentPrefix}WINDOW`;
    const editorKey = `${ARC_IDENTITY.environmentPrefix}EDITOR_EXECUTABLE`;
    const windows = (cli.platform ?? process.platform) === 'win32';
    const pathKeys = (source: Record<string, string | undefined>) =>
      Object.keys(source)
        .filter((key) => (windows ? key.toUpperCase() === 'PATH' : key === 'PATH'))
        .sort();
    const inheritedKey = pathKeys(inherited)[0];
    const wantedKey = pathKeys(wanted)[0];
    const value = wantedKey ? wanted[wantedKey] : inheritedKey ? inherited[inheritedKey] : undefined;
    for (const key of pathKeys(env)) delete env[key];
    env[inheritedKey ?? 'PATH'] = cli.directory + (value ? (windows ? ';' : ':') + value : '');
    for (const key of Object.keys(env)) {
      if ([windowKey, editorKey].includes(key.toUpperCase())) delete env[key];
    }
    env[editorKey] = windows ? cli.editorExecutable.replaceAll('\\', '/') : cli.editorExecutable;
    if (cli.windowId !== null) env[windowKey] = cli.windowId;
  }
  // The editor environment takes precedence over the session directory's billing selector.
  const selectorKey = Object.keys(inherited).find(
    (key) => key.toUpperCase() === `${ARC_IDENTITY.environmentPrefix}CLAUDE_BILLING_LABEL`,
  );
  let label = selectorKey ? inherited[selectorKey]?.trim() : undefined;
  if (agent === 'claude' && label === undefined && cwd) {
    try {
      const local = parseEnv(readFileSync(join(cwd, '.env'), 'utf8'));
      const localKey = Object.keys(local).find(
        (key) => key.toUpperCase() === `${ARC_IDENTITY.environmentPrefix}CLAUDE_BILLING_LABEL`,
      );
      label = localKey ? local[localKey]?.trim() : undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  if (agent === 'claude' && (label === 'sdk-cli' || label === 'claude-vscode' || label === 'omit')) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'CLAUDE_CODE_ENTRYPOINT' || key.toUpperCase() === 'CLAUDE_CODE_ATTRIBUTION_HEADER') {
        delete env[key];
      }
    }
    env.CLAUDE_CODE_ENTRYPOINT = label === 'claude-vscode' ? label : 'sdk-cli';
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = label === 'omit' ? '0' : '1';
  }
  return env;
}

export const spawnCli: Spawner = (command, args, cwd, env, agent, cli) => {
  if (process.env[MEASUREMENT_ENVIRONMENT.blockAgents] === '1')
    throw new Error('Agent connections are disabled in this measurement window.');
  const refusal = unstartable(command, process.platform);
  if (refusal) {
    throw new Error(refusal);
  }
  return nodeSpawn(command, args, {
    cwd,
    env: childEnv(process.env, env, agent, cwd, cli),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
};

export function arcCliSpawner(environment: () => ArcCliEnvironment, spawner: Spawner = spawnCli): Spawner {
  return (command, args, cwd, env, agent) => spawner(command, args, cwd, env, agent, environment());
}

export type AgentName = 'claude' | 'codex';

// The running agent state displayed by the panel. Stop and running-state wording use `busy`.
// The panel displays pending requests from `asks`.
export interface SessionState {
  key: string;
  agent: AgentName;
  cwd: string;
  sessionId: string | null;
  busy: boolean;
  asks: Ask[];
  commands: PromptEntry[];
  lastError: string | null;
  ready: boolean;
  exited: boolean;
}

export interface SessionEvent {
  key: string;
  event: WireEvent;
  // Names the accepted submission that owns this response or ending.
  turnId?: number;
}

// The shared operations an agent session calls. Each wire adapter implements its provider's operations without a common base class.
export interface Driver {
  contextUsage?(): Promise<unknown>;
  contextFrame?(text: string): string | null;
  contextOverflow?(id: string): void;
  receive(line: string): void;
  // Completes initialization. Session plans also open a Codex thread after reading skills.
  open(): Promise<PromptEntry[]>;
  prompt(prompt: AgentPromptInput): Promise<void | string>;
  compact(): Promise<void>;
  clear(name?: string): Promise<void>;
  answer(id: string, answer: AskAnswer): boolean;
  interrupt(): Promise<void>;
  sessionId(): string | null;
  close(reason: string): void;
  // A successful Claude interrupt cancels the active prompt and everything already queued
  // behind it. The session removes those prompts because the CLI sends no ending for each
  // canceled queue entry.
  interruptClearsOpenTurns?: boolean;
  // Codex can accept several prompts into one server turn and end them with one event. Its
  // wire therefore owns the count. Claude ends each prompt separately, so the session can
  // count those events without asking its wire.
  hasOpenTurns?(): boolean;
  // Whether an ask stays open when its turn ends. Most asks hold a request the agent stops
  // waiting on when the turn ends. A Codex async question holds none, and the reader can
  // answer it later.
  outlivesTurn?(id: string): boolean;
  // Requested spend and context reads. Claude exposes these controls. Codex reports these figures through notifications.
  usage?(): Promise<{ usage: unknown; context: unknown }>;
  // Normalized account usage. Both providers answer without a session or model request.
  rateLimits?(refreshAuthentication?: boolean): Promise<UsageReading | null>;
  // The provider's model catalog. The control read uses no model tokens.
  models?(): Promise<ModelList | null>;
  appliedDefaults?(): Promise<AppliedDefaults>;
  // Changes the session's permission mode. Claude applies a control request immediately.
  // Codex stores approval fields for the next prompt. Completion acknowledges the setting rather than a recorded turn.
  setAskMode?(mode: AskMode): Promise<void>;
  // Changes the session model. Claude applies a control request immediately. Codex sends the model on the next turn.
  setModel?(model: string): Promise<void>;
  // Changes reasoning effort. Codex sends the level beside the model on the next turn.
  // Claude uses `/effort` because its control channel has no effort-level subtype.
  setEffort?(effort: string): Promise<void>;
  // Whether changing effort starts a command turn. Claude emits a `result` ending for `/effort`.
  // Codex stores a field without starting a turn.
  effortStartsTurn?: boolean;
  // Reads normalized MCP status when the adapter exposes that operation.
  // Claude and Codex both answer. Only Claude exposes the server-changing controls below.
  // Each call requests status. Codex startup notifications join the next list reading.
  mcpStatus?(): Promise<McpServer[] | null>;
  // Sets one server's enabled state explicitly. The request preserves the state the reader selected.
  mcpToggle?(serverName: string, enabled: boolean): Promise<void>;
  // Retries a failed server and returns its connection failure to the caller.
  mcpReconnect?(serverName: string): Promise<void>;
  // Renames a session without a model turn. Claude uses `rename_session`. Codex uses `thread/name/set`.
  rename?(sessionId: string, title: string): Promise<void>;
}

// What to start, and how to talk to it once it is running.
export interface AgentPlan {
  agent: AgentName;
  // The provider session identity supplied by the launch plan. A fresh Codex child receives its identity during opening.
  sessionId: string | null;
  command: string;
  args: string[];
  cwd: string;
  // Launch-specific environment values applied after inherited client identity variables are removed.
  env: Record<string, string>;
  driver(send: (line: string) => void, emit: (event: WireEvent) => void): Driver;
}

export type AgentPlanSource = AgentPlan | (() => AgentPlan);

// The executable, leading arguments, and environment resolved by `composerview.ts`.
// Leading arguments identify a package script when the launcher uses Node.
export interface Launch {
  command: string;
  leadingArgs: string[];
  env: Record<string, string>;
}

// Returns the provider-specific permission fields selected by the reader.
// Reject a mode for another provider instead of applying an unselected default.
export function claudeAskMode(mode: AskMode): PermissionMode {
  if (!mode.claude) {
    throw new Error(`${mode.label} is not a setting Claude Code can be put in`);
  }
  return mode.claude;
}

export function codexAskMode(mode: AskMode): {
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: SandboxMode;
} {
  if (!mode.codex) {
    throw new Error(`${mode.label} is not a setting Codex can be put in`);
  }
  return mode.codex;
}

// Claude Code: one child per session, speaking its stream-json protocol.
export function claudePlan(launch: Launch, options: SpawnOptions): AgentPlan {
  return {
    agent: 'claude',
    sessionId: options.resume ?? options.sessionId ?? null,
    command: launch.command,
    args: [...launch.leadingArgs, ...spawnArgs(options)],
    cwd: options.cwd,
    // The CLI reports when it goes idle only when asked. That report ends prompts that joined a running turn.
    env: { ...launch.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
    driver(send, emit) {
      // Seed Claude's session identity before the first prompt. A resumed CLI can defer reporting it until output begins.
      const wire = new ClaudeWire({ send, emit, sessionId: options.resume ?? options.sessionId });
      return {
        receive: (line) => wire.receive(line),
        contextUsage: () => wire.contextUsage(),
        contextFrame: (text) => wire.contextFrame(text),
        contextOverflow: (id) => wire.contextOverflow(id),
        open: () => wire.initialize(),
        prompt: async (prompt) => wire.prompt(prompt),
        compact: async () => wire.prompt(compactCommand('claude')),
        clear: async () => wire.prompt(clearCommand('claude')),
        answer: (id, answer) => wire.answer(id, answer),
        interrupt: () => wire.interrupt(true),
        sessionId: () => wire.sessionId(),
        close: (reason) => wire.close(reason),
        interruptClearsOpenTurns: true,
        async usage() {
          const [usage, context] = await Promise.all([wire.usage(), wire.contextUsage()]);
          return { usage, context };
        },
        async rateLimits() {
          return readUsage(await wire.usage(), Date.now());
        },
        appliedDefaults: () => wire.appliedDefaults(),
        async models() {
          return readClaudeModels(await wire.listModels(), Date.now());
        },
        setAskMode: (mode) => wire.setPermissionMode(claudeAskMode(mode)),
        setModel: (model) => wire.setModel(model),
        setEffort: (effort) => wire.effortCommand(effort),
        effortStartsTurn: true,
        mcpStatus: () => wire.mcpStatus(),
        mcpToggle: (serverName, enabled) => wire.mcpToggle(serverName, enabled),
        mcpReconnect: (serverName) => wire.mcpReconnect(serverName),
        rename: (sessionId, title) => wire.renameSession(sessionId, title),
      };
    },
  };
}

// A child started only to rename a session that has no child running. It resumes the
// session so the request reaches the right transcript, sends the rename once it has opened,
// and takes no prompt.
export function claudeRenamePlan(launch: Launch, options: SpawnOptions & { resume: string; title: string }): AgentPlan {
  const ordinary = claudePlan(launch, options);
  return {
    ...ordinary,
    driver(send, emit) {
      const wire = new ClaudeWire({ send, emit, sessionId: options.resume });
      return {
        receive: (line) => wire.receive(line),
        async open() {
          await wire.initialize();
          await wire.renameSession(options.resume, options.title);
          return [];
        },
        ...renameOnlyControls('this child was started to rename a session'),
        sessionId: () => wire.sessionId(),
        close: (reason) => wire.close(reason),
      };
    },
  };
}

// Codex thread-opening settings. Approval policy, approval reviewer, and sandbox must preserve the reader's selected permission mode.
export interface CodexPlanOptions {
  cwd: string;
  model?: string;
  effort?: string;
  resume?: string;
  fork?: string;
  clientInfo: ClientInfo;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
}

// Starts one Codex app-server child per session through the resolved launch executable and arguments.
// Per-session children keep thread ownership in the host's session map.
export function codexPlan(launch: Launch, options: CodexPlanOptions): AgentPlan {
  return {
    agent: 'codex',
    sessionId: options.resume ?? null,
    command: launch.command,
    args: [...launch.leadingArgs, ...appServerArgs()],
    cwd: options.cwd,
    env: launch.env,
    driver(send, emit) {
      const wire = new CodexWire({ send, emit, clientInfo: options.clientInfo, cwd: options.cwd });
      return {
        receive: (line) => wire.receive(line),
        async open() {
          await wire.initialize();
          const commands = await wire.commands();
          if (options.fork) {
            await wire.forkThread(options.fork, options);
          } else if (options.resume) {
            await wire.resumeThread(options.resume);
          } else await wire.startThread(options);
          // Apply the reader's settings to later turns, including settings for a resumed thread.
          if (options.approvalPolicy && options.approvalsReviewer && options.sandbox) {
            await wire.setApproval(options.approvalPolicy, options.sandbox, options.approvalsReviewer);
          }
          await wire.setModel(options.model ?? '');
          await wire.setEffort(options.effort ?? '');
          return commands;
        },
        prompt: (prompt) => wire.prompt(prompt),
        compact: () => wire.compact(),
        clear: async (name) => {
          await wire.startThread(options, name);
        },
        answer: (id, answer) => wire.answer(id, answer),
        interrupt: () => wire.interrupt(),
        sessionId: () => wire.threadId(),
        close: (reason) => wire.close(reason),
        hasOpenTurns: () => wire.hasOpenTurns(),
        outlivesTurn: (id) => wire.outlivesTurn(id),
        async rateLimits(refreshAuthentication) {
          return readRateLimits(await wire.rateLimits(refreshAuthentication), Date.now());
        },
        appliedDefaults: () => wire.appliedDefaults(options.cwd, 'model' in options ? (options.model ?? '') : ''),
        async models() {
          return readCodexModels(await wire.models(), Date.now());
        },
        mcpStatus: () => wire.mcpStatus(),
        setAskMode: async (mode) => {
          const { approvalPolicy, approvalsReviewer, sandbox } = codexAskMode(mode);
          Object.assign(options, { approvalPolicy, approvalsReviewer, sandbox });
          await wire.setApproval(approvalPolicy, sandbox, approvalsReviewer);
        },
        setModel: async (model) => {
          options.model = model || undefined;
          await wire.setModel(model);
        },
        setEffort: (effort) => wire.setEffort(effort),
        rename: (threadId, title) => wire.renameThread(threadId, title),
      };
    },
  };
}

// Starts a Claude child for control reads without persisting a session.
// The Codex idle plan initializes its server without starting a thread.
// Both plans read account usage and model catalogs without sending prompts.
export function claudeIdlePlan(launch: Launch, cwd: string, model = ''): AgentPlan {
  return claudePlan(launch, { cwd, persistSession: false, ...(model ? { model } : {}) });
}

export function codexIdlePlan(
  launch: Launch,
  options: { cwd: string; clientInfo: ClientInfo; model?: string },
): AgentPlan {
  return {
    agent: 'codex',
    sessionId: null,
    command: launch.command,
    args: [...launch.leadingArgs, ...appServerArgs()],
    cwd: options.cwd,
    env: launch.env,
    driver(send, emit) {
      const wire = new CodexWire({ send, emit, clientInfo: options.clientInfo, cwd: options.cwd });
      return {
        receive: (line) => wire.receive(line),
        async open() {
          // No thread is started: this child will never be prompted, and opening one would
          // leave a session on disk the reader never asked for.
          await wire.initialize();
          return await wire.commands();
        },
        prompt: () => Promise.reject(new Error('this child was started to be asked a question, not to run a turn')),
        compact: () =>
          Promise.reject(new Error('this child was started to be asked a question, not to compact a session')),
        clear: () => Promise.reject(new Error('this child was started to be asked a question, not to clear a session')),
        answer: () => false,
        interrupt: () => Promise.resolve(),
        sessionId: () => null,
        close: (reason) => wire.close(reason),
        async rateLimits(refreshAuthentication) {
          return readRateLimits(await wire.rateLimits(refreshAuthentication), Date.now());
        },
        appliedDefaults: () => wire.appliedDefaults(options.cwd, 'model' in options ? (options.model ?? '') : ''),
        async models() {
          return readCodexModels(await wire.models(), Date.now());
        },
        mcpStatus: () => wire.mcpStatus(),
      };
    },
  };
}

// The controls a rename-only child refuses. It exists for one command and runs no turn.
function renameOnlyControls(refusal: string): Pick<Driver, 'prompt' | 'compact' | 'clear' | 'answer' | 'interrupt'> {
  return {
    prompt: () => Promise.reject(new Error(refusal)),
    compact: () => Promise.reject(new Error(refusal)),
    clear: () => Promise.reject(new Error(refusal)),
    answer: () => false,
    interrupt: () => Promise.resolve(),
  };
}

// A child started only to name a thread that has no child running. The request needs only
// the server handshake, so no thread is resumed or started and no model turn can begin.
export function codexRenamePlan(
  launch: Launch,
  options: { cwd: string; clientInfo: ClientInfo; threadId: string; title: string },
): AgentPlan {
  return {
    agent: 'codex',
    sessionId: options.threadId,
    command: launch.command,
    args: [...launch.leadingArgs, ...appServerArgs()],
    cwd: options.cwd,
    env: launch.env,
    driver(send, emit) {
      const wire = new CodexWire({ send, emit, clientInfo: options.clientInfo, cwd: options.cwd });
      return {
        receive: (line) => wire.receive(line),
        async open() {
          await wire.initialize();
          await wire.renameThread(options.threadId, options.title);
          return [];
        },
        ...renameOnlyControls('this child was started to rename a session'),
        sessionId: () => options.threadId,
        close: (reason) => wire.close(reason),
      };
    },
  };
}

// One session rename, from the panel. The host picks the running child or a rename-only
// child. Claude Code can report success after failing to save, so a Claude rename
// counts only once the saved title file holds the name.
export interface SessionRenameRequest {
  agent: AgentName;
  sessionId: string;
  // The cleaned name. It goes to the agent as given.
  title: string;
  // The transcript, whose saved title file confirms a Claude rename.
  file: string;
  // The rename-only child, asked for only when no child runs the session.
  idlePlan: () => AgentPlan;
}

export async function renameAgentSession(
  host: AgentHost,
  request: SessionRenameRequest,
  confirm: { attempts?: number; pause?: () => Promise<void> } = {},
): Promise<void> {
  await host.renameSession(request.agent, request.sessionId, request.title, request.idlePlan);
  if (request.agent === 'claude') {
    await confirmClaudeRename(request.title, () => readCustomTitleSidecar(request.file), confirm);
  }
}

export interface HostOptions {
  spawner?: Spawner;
  idleDurationMs: number;
  timer?: AgentHostTimer;
  // How long shutdown waits before asking the operating system to terminate the child.
  // Injected so lifecycle tests do not wait on the production grace period.
  exitGraceMs?: number;
  // The opening-exchange deadline. Tests inject a shorter duration.
  openingDeadlineMs?: number;
  // The session clock. Tests control Stop-ending expiry through this value.
  now?: () => number;
  // Publishes events and state changes to the panel.
  onEvent(event: SessionEvent): void;
  onStateChange(state: SessionState): void;
}

export interface AgentHostTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(timer: unknown): void;
}

export interface AgentHousekeeping {
  readonly key: string;
  readonly session: AgentSession;
  readonly generation: number;
}

const AGENT_HOST_TIMER: AgentHostTimer = {
  set(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// Frames complete JSON lines from arbitrary stdout chunks. Chunks can contain partial lines or several complete lines.
export class LineReader {
  private buffer = '';
  private bytes = 0;
  private contextId: string | null = null;
  private discarded = false;
  private identifying = true;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly gate?: ContextFrameGate,
  ) {}

  push(chunk: string): void {
    let at = 0;
    while (at < chunk.length) {
      const cut = chunk.indexOf('\n', at);
      const end = cut < 0 ? chunk.length : cut;
      let part = chunk.slice(at, end);
      if (!this.discarded) {
        if (this.gate && this.identifying && !this.contextId) {
          const room = Math.max(0, CONTEXT_PREFIX_BYTES - this.bytes);
          let prefix = part.slice(0, room);
          while (Buffer.byteLength(prefix, 'utf8') > room) prefix = prefix.slice(0, -1);
          this.contextId = this.gate.identify(this.buffer + prefix);
          if (!this.contextId && Buffer.byteLength(this.buffer + prefix) >= CONTEXT_PREFIX_BYTES)
            this.identifying = false;
        }
        const size = Buffer.byteLength(part, 'utf8');
        if (this.contextId && this.bytes + size > CONTEXT_FRAME_BYTES) {
          this.gate?.overflow(this.contextId);
          this.buffer = '';
          this.discarded = true;
        } else {
          this.buffer += part;
          this.bytes += size;
        }
      }
      if (cut >= 0) {
        if (!this.discarded && this.buffer.trim()) this.onLine(this.buffer.replace(/\r$/, ''));
        else if (this.discarded && this.contextId)
          this.onLine(JSON.stringify({ type: 'control_response', response: { request_id: this.contextId } }));
        this.reset();
      }
      at = cut < 0 ? chunk.length : cut + 1;
    }
  }

  private reset(): void {
    this.buffer = '';
    this.bytes = 0;
    this.contextId = null;
    this.discarded = false;
    this.identifying = true;
  }

  // Whatever was left when the stream ended. Neither CLI always ends its last line.
  flush(): void {
    const rest = this.buffer.trim();
    if (this.discarded && this.contextId)
      this.onLine(JSON.stringify({ type: 'control_response', response: { request_id: this.contextId } }));
    const discarded = this.discarded;
    this.reset();
    if (rest && !discarded) {
      this.onLine(rest);
    }
  }
}

// The opening-exchange deadline. A cold CLI reads settings, plugins, and memory files before it answers.
export const OPENING_DEADLINE_MS = 60_000;

// How long a child being let go has to end on its own before termination is requested.
// This gives the CLI time to write its settings before a replacement waits for confirmed exit.
export const EXIT_GRACE_MS = 2_000;

// The expiry period for an ending owed by an accepted Stop.
// `handle` consumes the debt only for an interrupted outcome within this period.
// Expiry prevents an unrelated later interrupted turn from consuming the abandoned turn's debt.
export const STOP_ENDING_GRACE_MS = 60_000;

export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nothing came back within ${Math.round(ms / 1000)} seconds`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Unique submission sequence within this extension-host process. Cleanup state uses the same process lifetime.
let sessionTurnSequence = 0;

// One session and the child running it.
export class AgentSession {
  readonly key: string;
  readonly agent: AgentName;
  readonly cwd: string;
  readonly driver: Driver;

  private readonly child: ChildLike;
  private readonly asks = new Map<string, Ask>();
  private commands: PromptEntry[] = [];
  private commandVersion = 0;
  private busy = false;
  // Answers the driver is still sending to an ask that outlived its turn. The session counts
  // as busy until each settles, so the child is not retired while an answer is on its way.
  private readonly delivering = new Set<string>();
  // The effort level a reader picked while a turn was running, waiting for that turn to end.
  // A second pick replaces the held level, avoiding an extra command turn.
  private heldEffort: string | null = null;
  // What a prompt sent while a pick is held waits on: the held level reaching the child, or
  // the pick being dropped. It exists only while a pick is held and a prompt waits for it.
  private effortSent: { promise: Promise<void>; release: () => void } | null = null;
  // The prompts waiting on the pick above. Each is booked as preparing, so the session reads
  // as working, but none of them is work the held level has to wait for.
  private readonly promptsBehindEffort = new Set<{ id: number }>();
  private readonly preparingTurns = new Set<{ id: number }>();
  private readonly openTurns = new Set<{ id: number }>();
  private readonly nativeTurnOwners = new Map<string, number>();
  private readonly respondingTurns = new Set<number>();
  private readonly responseOwners = new Map<string, number>();
  private readonly pendingResponses: WireEvent[] = [];
  private acceptingPrompts = 0;
  // Claude reported `running` and has not reported `idle` since. It keeps the session busy
  // through a turn the CLI started by itself. It also covers a prompt that reached the CLI
  // just after its last `result` but before Arc read that `result`, which the `idle` after it settles.
  private agentRunning = false;
  // How many `result` events have ended a turn here, and how many had when each open turn
  // reached the child. A turn can join only work that a later `result` ends, so an `idle`
  // report settles only turns that were open when one arrived.
  private turnEndings = 0;
  private readonly openedAtEnding = new WeakMap<{ id: number }, number>();
  private interruptedTurnEnds = 0;
  // When the Stop that owes that ending was accepted, so an ending that never came stops
  // being owed. See STOP_ENDING_GRACE_MS.
  private interruptedTurnEndAt = 0;
  private lastError: string | null = null;
  // The error the opening exchange failed on, kept whole for a caller that throws it.
  private openingFailure: Error | null = null;
  private ready = false;
  private exited = false;
  private childTerminated = false;
  private disposePromise: Promise<void> | null = null;
  private stderrTail = '';

  constructor(
    key: string,
    plan: AgentPlan,
    spawner: Spawner,
    private readonly report: (event: WireEvent, turnId?: number) => void,
    private readonly changed: () => void,
    private readonly openingDeadlineMs: number = OPENING_DEADLINE_MS,
    private readonly exitGraceMs: number = EXIT_GRACE_MS,
    // Tests inject the clock to control Stop-ending expiry.
    private readonly now: () => number = Date.now,
  ) {
    this.key = key;
    this.agent = plan.agent;
    this.cwd = plan.cwd;
    this.driver = plan.driver(
      (line) => this.child.stdin.write(line),
      (event) => this.handle(event),
    );
    this.child = spawner(plan.command, plan.args, plan.cwd, plan.env, plan.agent);

    const out = new LineReader(
      (line) => this.driver.receive(line),
      this.driver.contextFrame
        ? {
            identify: (text) => this.driver.contextFrame?.(text) ?? null,
            overflow: (id) => this.driver.contextOverflow?.(id),
          }
        : undefined,
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => out.push(String(chunk)));

    // Keep the last 4000 stderr characters for startup and exit failures.
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-4000);
    });

    this.child.on('error', (error) => this.finish(`the agent could not start: ${error.message}`));
    this.child.on('exit', (code, signal) => {
      this.childTerminated = true;
      out.flush();
      const how = signal ? `signal ${signal}` : `code ${code}`;
      this.finish(code === 0 || signal ? null : `the agent stopped with ${how}. ${this.stderrTail.trim()}`.trim());
    });
    // A failed spawn emits `error` then `close`, without `exit`.
    // Error alone does not confirm termination. A running child retains its session until `exit` or `close`.
    this.child.on('close', () => {
      this.childTerminated = true;
    });
  }

  state(): SessionState {
    return {
      key: this.key,
      agent: this.agent,
      cwd: this.cwd,
      sessionId: this.driver.sessionId(),
      busy: this.busy || this.delivering.size > 0,
      asks: [...this.asks.values()],
      commands: this.commands,
      lastError: this.lastError,
      ready: this.ready,
      exited: this.exited,
    };
  }

  // Completes the opening exchange before prompts. Failure is retained in session state and closes the child.
  // `startOrThrow` exposes that failure as an exception.
  async start(): Promise<void> {
    try {
      // Bound an opening that starts but never answers, including a CLI waiting for terminal authentication.
      const commandVersion = this.commandVersion;
      const commands = await withDeadline(this.driver.open(), this.openingDeadlineMs);
      if (this.commandVersion === commandVersion) {
        this.commands = commands;
      }
      this.ready = true;
    } catch (error) {
      this.openingFailure = error instanceof Error ? error : new Error(String(error));
      this.lastError = `the agent could not finish opening the session: ${(error as Error).message}`;
      void this.dispose();
    }
    this.changed();
  }

  // The opening exchange for a caller whose whole job is the opening, such as a rename-only
  // child. Its failure is thrown with the agent's own message.
  async startOrThrow(): Promise<void> {
    await this.start();
    if (this.openingFailure) {
      throw this.openingFailure;
    }
  }

  // Renames the caller's resolved session without changing a running turn.
  // Passing the requested id lets the provider reject a child that has switched sessions.
  async rename(sessionId: string, title: string): Promise<void> {
    if (this.exited) {
      throw new Error(this.lastError ?? 'the agent is no longer running');
    }
    if (!this.driver.rename) {
      throw new Error('This agent cannot rename the session.');
    }
    await this.driver.rename(sessionId, title);
  }

  // Marks the session busy while the CLI accepts a prompt. The returned id identifies that submission.
  // An exited child rejects the prompt and retains the failure in session state.
  async prompt(prompt: AgentPromptInput, onSubmitted?: (turnId: number) => void): Promise<number> {
    if (this.exited) {
      // Retain the opening refusal when its failed child has already closed.
      this.lastError = this.lastError ?? 'the agent is no longer running, so the prompt was not sent';
      this.changed();
      throw new Error(this.lastError);
    }
    this.lastError = null;
    const submitted = { id: ++sessionTurnSequence };
    onSubmitted?.(submitted.id);
    if (!this.driver.hasOpenTurns) {
      this.preparingTurns.add(submitted);
    }
    this.busy = true;
    this.changed();
    // Prompts waiting on a held effort pick must follow its command, so they run at the selected level.
    const behindEffort = this.effortSent !== null;
    if (behindEffort) {
      this.promptsBehindEffort.add(submitted);
      try {
        await this.effortSent!.promise;
      } finally {
        this.promptsBehindEffort.delete(submitted);
      }
      if (this.exited) {
        this.lastError = this.lastError ?? 'the agent is no longer running, so the prompt was not sent';
        this.changed();
        throw new Error(this.lastError);
      }
    }
    try {
      // A Stop during the wait cancels this prompt the way it cancels one queued in the child.
      if (behindEffort && !this.driver.hasOpenTurns && !this.preparingTurns.has(submitted)) {
        throw new Error('the prompt was stopped before it reached the agent');
      }
      this.acceptingPrompts += 1;
      let nativeTurnId: void | string;
      try {
        nativeTurnId = await this.driver.prompt(prompt);
      } finally {
        this.acceptingPrompts -= 1;
      }
      if (nativeTurnId) this.nativeTurnOwners.set(nativeTurnId, submitted.id);
      if (this.driver.hasOpenTurns) {
        this.busy = this.driver.hasOpenTurns();
        this.changed();
      } else {
        if (!this.preparingTurns.delete(submitted)) {
          throw new Error('the prompt was stopped before it reached the agent');
        }
        this.openTurn(submitted);
        this.busy = true;
        this.changed();
      }
      this.respondingTurns.add(submitted.id);
      const pending = this.pendingResponses.splice(0);
      for (const event of pending) this.handle(event);
      return submitted.id;
    } catch (error) {
      if (this.driver.hasOpenTurns) {
        this.busy = this.driver.hasOpenTurns();
      } else {
        this.preparingTurns.delete(submitted);
        this.busy = this.countedBusy();
      }
      const refusal = `the agent would not take the prompt: ${(error as Error).message}`;
      this.lastError = refusal;
      this.changed();
      // A prompt refusal can leave the session idle. A successful held effort send retains this diagnostic.
      this.drainHeldEffort();
      throw new Error(refusal, { cause: error });
    }
  }

  // Compaction uses the same running and refusal state as a prompt but a different driver
  // operation. Claude's operation starts a command turn and ends through its normal result.
  // Codex starts through a native request and its wire keeps the reported control turn open
  // until the server reports how it ended.
  async compact(): Promise<number> {
    return this.commandTurn(() => this.driver.compact(), {
      gone: 'the agent is no longer running, so the session was not compacted',
      lost: 'the compaction was stopped before it reached the agent',
      refused: 'compact the session',
    });
  }

  // Shares prompt running-state and refusal handling with operations that start a command turn.
  // Book the command's turn so its result cannot close a prompt's turn.
  // Reader commands clear the diagnostic. A successful held effort change retains the refusal that left the session idle.
  private async commandTurn(
    run: () => Promise<void>,
    words: { gone: string; lost: string; refused: string },
    clearsDiagnostic = true,
  ): Promise<number> {
    if (this.exited) {
      this.lastError = this.lastError ?? words.gone;
      this.changed();
      throw new Error(this.lastError);
    }
    if (clearsDiagnostic) {
      this.lastError = null;
    }
    const submitted = { id: ++sessionTurnSequence };
    if (!this.driver.hasOpenTurns) {
      this.preparingTurns.add(submitted);
    }
    this.busy = true;
    this.changed();
    try {
      await run();
      if (this.driver.hasOpenTurns) {
        this.busy = this.driver.hasOpenTurns();
        this.changed();
      } else {
        if (!this.preparingTurns.delete(submitted)) {
          throw new Error(words.lost);
        }
        this.openTurn(submitted);
        this.busy = true;
        this.changed();
      }
      return submitted.id;
    } catch (error) {
      if (this.driver.hasOpenTurns) {
        this.busy = this.driver.hasOpenTurns();
      } else {
        this.preparingTurns.delete(submitted);
        this.busy = this.countedBusy();
      }
      // Session state names the failed operation. The thrown error retains the provider's cause for the panel's operation-specific message.
      const cause = (error as Error).message;
      this.lastError = cause
        ? `the agent would not ${words.refused}: ${cause}`
        : `the agent would not ${words.refused} and gave no reason`;
      this.changed();
      // Send a held effort pick after a refusal. The failed send has already cleared its own pick.
      this.drainHeldEffort();
      throw error;
    }
  }

  async clear(name: string = ''): Promise<number> {
    if (this.exited) {
      this.lastError = this.lastError ?? 'the agent is no longer running, so the session was not cleared';
      this.changed();
      throw new Error(this.lastError);
    }
    this.lastError = null;
    const submitted = { id: ++sessionTurnSequence };
    if (!this.driver.hasOpenTurns) {
      this.preparingTurns.add(submitted);
    }
    this.busy = true;
    this.changed();
    try {
      await this.driver.clear(name);
      if (this.agent === 'codex') {
        this.preparingTurns.delete(submitted);
        this.busy = false;
      } else if (this.driver.hasOpenTurns) {
        this.busy = this.driver.hasOpenTurns();
      } else {
        if (!this.preparingTurns.delete(submitted)) {
          throw new Error('the clear was stopped before it reached the agent');
        }
        this.openTurn(submitted);
        this.busy = true;
      }
      this.changed();
      return submitted.id;
    } catch (error) {
      this.preparingTurns.delete(submitted);
      this.busy = this.driver.hasOpenTurns ? this.driver.hasOpenTurns() : this.countedBusy();
      const cause = (error as Error).message;
      this.lastError = cause
        ? `the agent would not clear the session: ${cause}`
        : 'the agent would not clear the session and gave no reason';
      this.changed();
      // A clear refusal can leave the session idle. A successful held effort send retains this diagnostic.
      this.drainHeldEffort();
      throw error;
    }
  }

  answer(id: string, answer: AskAnswer): boolean {
    // Before the ask leaves, so the session never reads idle while the answer is sent.
    const outlived = answer.decision === 'answer' && (this.driver.outlivesTurn?.(id) ?? false);
    if (outlived) {
      this.delivering.add(id);
    }
    const answered = this.driver.answer(id, answer);
    if (!answered) {
      this.delivering.delete(id);
    }
    if (answered) {
      this.asks.delete(id);
      this.changed();
    }
    return answered;
  }

  async interrupt(): Promise<number[]> {
    const responses = [...this.respondingTurns];
    const interrupted = this.driver.interruptClearsOpenTurns ? new Set(this.openTurns) : null;
    const preparing = this.driver.interruptClearsOpenTurns ? new Set(this.preparingTurns) : null;
    // A turn Claude started by itself, such as one for a task notification, has no open turn.
    const wasRunning = this.agentRunning;
    const stopping = this.driver.interrupt();
    if (preparing) {
      for (const turn of preparing) {
        this.preparingTurns.delete(turn);
      }
      this.busy = this.countedBusy();
      this.changed();
    }
    await stopping;
    if (interrupted) {
      if (
        this.interruptedTurnEnds === 0 &&
        [...interrupted].every((turn) => this.openTurns.has(turn)) &&
        (interrupted.size || wasRunning)
      ) {
        // Claude reports one ending for the active turn after accepting Stop, but none for the
        // queued prompts it canceled. A turn Claude started by itself ends the same way. Keep
        // that ending away from a turn sent afterward. When no ending comes, the `idle` report
        // or STOP_ENDING_GRACE_MS drops the debt.
        this.interruptedTurnEnds += 1;
        this.interruptedTurnEndAt = this.now();
      }
      for (const turn of interrupted) {
        this.openTurns.delete(turn);
      }
      // An accepted Stop leaves the session idle before the CLI says so.
      this.agentRunning = false;
      this.busy = this.countedBusy();
      this.drainHeldEffort();
      this.changed();
    }
    for (const id of responses) this.respondingTurns.delete(id);
    return responses;
  }

  // What the agent says it has spent, or nothing when the agent has no way to be asked.
  async usage(): Promise<{ usage: unknown; context: unknown } | null> {
    return this.driver.usage ? await this.driver.usage() : null;
  }

  async contextUsage(): Promise<unknown> {
    return this.driver.contextUsage ? this.driver.contextUsage() : null;
  }

  // Reads account usage without model tokens.
  async rateLimits(refreshAuthentication = false): Promise<UsageReading | null> {
    return this.driver.rateLimits ? await this.driver.rateLimits(refreshAuthentication) : null;
  }

  // Reads applied CLI settings or returns an unavailable result when the driver exposes no settings read.
  async appliedDefaults(): Promise<AppliedDefaults> {
    return this.driver.appliedDefaults
      ? this.driver.appliedDefaults()
      : unavailableDefaults('This agent did not report its settings.');
  }

  async models(): Promise<ModelList | null> {
    return this.driver.models ? await this.driver.models() : null;
  }

  // How much this session's agent asks before it acts, from now on.
  async setAskMode(mode: AskMode): Promise<void> {
    if (this.driver.setAskMode) {
      await this.driver.setAskMode(mode);
    }
  }

  // The model this session runs on, from now on.
  async setModel(model: string): Promise<void> {
    if (this.driver.setModel) {
      await this.driver.setModel(model);
    }
  }

  // Changes effort through the driver. An effort command that starts a turn waits until existing work ends.
  // Prompts submitted during that wait follow the command, so they run at the selected level.
  // An empty level drops a held pick without sending a bare `/effort` command.
  // Non-command effort changes reach the driver immediately.
  async setEffort(effort: string): Promise<void> {
    if (!this.driver.setEffort) {
      return;
    }
    if (!this.driver.effortStartsTurn) {
      await this.driver.setEffort(effort);
      return;
    }
    if (!effort) {
      if (this.heldEffort === null) {
        return;
      }
      this.dropHeldEffort();
      this.changed();
      return;
    }
    if (this.busy) {
      this.heldEffort = effort;
      if (!this.effortSent) {
        let release!: () => void;
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        this.effortSent = { promise, release };
      }
      this.changed();
      return;
    }
    this.dropHeldEffort();
    await this.sendEffort(effort);
  }

  // Forgets the held pick and lets the prompts waiting on it go. A prompt released this way
  // runs at the level the child already has.
  private dropHeldEffort(): void {
    this.heldEffort = null;
    const sent = this.effortSent;
    this.effortSent = null;
    sent?.release();
  }

  // Sends an effort command through `commandTurn`. A drained pick is already marked busy and must bypass the waiting rule.
  private async sendEffort(effort: string, clearsDiagnostic = true): Promise<number> {
    return this.commandTurn(
      () => this.driver.setEffort!(effort),
      {
        gone: 'the agent is no longer running, so the effort level was not changed',
        lost: 'the effort change was stopped before it reached the agent',
        refused: 'change the effort level',
      },
      clearsDiagnostic,
    );
  }

  // Sends a held effort pick once no other work remains. Endings, accepted Stop requests, and refused submissions all drain it.
  // Mark the session busy before publishing state. Prompts waiting on the pick follow the effort command.
  // A successful send retains the prior diagnostic. A failed send replaces it with the effort refusal.
  private drainHeldEffort(): void {
    const held = this.heldEffort;
    if (held === null || this.exited || this.runningBesideHeldPrompts()) {
      return;
    }
    const sent = this.effortSent;
    this.heldEffort = null;
    this.effortSent = null;
    this.busy = true;
    void this.sendEffort(held, false)
      .catch(() => {
        this.changed();
      })
      .finally(() => sent?.release());
  }

  // Whether this session is working on anything other than prompts waiting on a held pick.
  private runningBesideHeldPrompts(): boolean {
    if (this.driver.hasOpenTurns) {
      return this.busy;
    }
    if (this.openTurns.size > 0 || this.agentRunning) {
      return true;
    }
    return [...this.preparingTurns].some((turn) => !this.promptsBehindEffort.has(turn));
  }

  // Busy state for a driver that leaves turn counting to the host.
  private countedBusy(): boolean {
    return this.preparingTurns.size > 0 || this.openTurns.size > 0 || this.agentRunning;
  }

  private openTurn(turn: { id: number }): void {
    this.openTurns.add(turn);
    this.openedAtEnding.set(turn, this.turnEndings);
  }

  // Claude's `idle` report ends, in one pass, every prompt or command turn that was open when
  // a `result` arrived. A joined prompt gets no `result`, so this is the only ending it gets.
  // A turn that reached the child after the latest `result` cannot have joined the work it
  // ended. It waits for its own `result`, so an `idle` written before the CLI took it settles
  // nothing. The aborted `result` of a Stop does not count, because nothing joins a stopped
  // turn. Prompts still being prepared have not reached the child and stay open. A Stop ending
  // still owed can no longer arrive, because the CLI writes it before `idle`.
  private settleIdle(): number[] {
    const settled: number[] = [];
    for (const turn of this.openTurns) {
      if ((this.openedAtEnding.get(turn) ?? this.turnEndings) >= this.turnEndings) continue;
      this.openTurns.delete(turn);
      settled.push(turn.id);
    }
    for (const id of settled) this.respondingTurns.delete(id);
    this.agentRunning = false;
    this.interruptedTurnEnds = 0;
    this.busy = this.countedBusy();
    return settled;
  }

  // Returns MCP status or null when the driver exposes no status operation.
  // Null means unavailable. An empty list means the agent reported no servers.
  async mcpStatus(): Promise<McpServer[] | null> {
    return this.driver.mcpStatus ? await this.driver.mcpStatus() : null;
  }

  // Sets one server's enabled state when the driver exposes a toggle operation.
  async mcpToggle(serverName: string, enabled: boolean): Promise<void> {
    if (this.driver.mcpToggle) {
      await this.driver.mcpToggle(serverName, enabled);
    }
  }

  // Retries one failed server and propagates its connection failure.
  async mcpReconnect(serverName: string): Promise<void> {
    if (this.driver.mcpReconnect) {
      await this.driver.mcpReconnect(serverName);
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.finish(null);
    if (this.childTerminated) {
      this.disposePromise = Promise.resolve();
      return this.disposePromise;
    }
    // Close input first so the CLI can persist settings during orderly shutdown.
    // Request termination after the grace period if the child remains alive.
    // Replacement waits for this promise, preventing two children from writing the same session.
    this.disposePromise = new Promise<void>((resolve) => {
      const stop = setTimeout(() => {
        try {
          this.child.kill();
        } catch {
          // Wait for exit or close even when the termination request fails.
        }
      }, this.exitGraceMs);
      (stop as { unref?: () => void }).unref?.();
      const terminated = () => {
        clearTimeout(stop);
        resolve();
      };
      this.child.on('exit', terminated);
      this.child.on('close', terminated);
      try {
        this.child.stdin.end();
      } catch {
        // The pipe cannot be closed. Keep the kill timer as the only remaining way to
        // guarantee that a child which is still alive does not outlive this session.
      }
    });
    return this.disposePromise;
  }

  private handle(event: WireEvent): void {
    if (event.kind === 'sessionState') {
      if (this.driver.hasOpenTurns) return;
      if (event.state === 'running') {
        if (this.agentRunning) return;
        this.agentRunning = true;
        this.busy = true;
        this.changed();
        return;
      }
      // Before the report, so that nothing reading this session sees it idle with a pick still waiting.
      const settledTurnIds = this.settleIdle();
      this.drainHeldEffort();
      this.report({ kind: 'sessionState', state: 'idle', settledTurnIds });
      this.changed();
      return;
    }
    let endedTurnId: number | undefined;
    if (event.kind === 'delta' || event.kind === 'text' || event.kind === 'turnEnd') {
      if (this.driver.hasOpenTurns) {
        endedTurnId = event.nativeTurnId ? this.nativeTurnOwners.get(event.nativeTurnId) : undefined;
        if (endedTurnId === undefined && this.acceptingPrompts && event.nativeTurnId) {
          this.pendingResponses.push(event);
          return;
        }
      } else if (event.kind !== 'turnEnd') {
        endedTurnId = event.sourceId ? this.responseOwners.get(event.sourceId) : undefined;
        endedTurnId ??= this.openTurns.values().next().value?.id;
        if (event.sourceId && endedTurnId !== undefined) this.responseOwners.set(event.sourceId, endedTurnId);
      }
    }
    // Reply deltas and activity do not change session state. Report them without triggering repeated state publication.
    if (event.kind === 'delta' || event.kind === 'activity') {
      this.report(event, endedTurnId);
      return;
    }
    // Publish command catalogs before event listeners read session state.
    // `start` also accepts the opening result when the driver emits no catalog event.
    if (event.kind === 'ready' || event.kind === 'commands') {
      this.commands = event.commands;
      this.commandVersion += 1;
    }
    if (event.kind === 'ask') {
      this.asks.set(event.ask.id, event.ask);
    }
    if (event.kind === 'askResolved') {
      this.asks.delete(event.id);
    }
    // A late answer settles through `askResolved` after sending, or through a repeated ask after failure.
    // The wire starts its new prompt and supplies the open-turn state.
    if (
      (event.kind === 'ask' && this.delivering.delete(event.ask.id)) ||
      (event.kind === 'askResolved' && this.delivering.delete(event.id))
    ) {
      if (this.driver.hasOpenTurns) {
        this.busy = this.driver.hasOpenTurns();
      }
    }
    if (event.kind === 'turnEnd') {
      if (this.driver.hasOpenTurns) {
        this.busy = this.driver.hasOpenTurns();
      } else if (
        event.outcome.status === 'interrupted' &&
        this.interruptedTurnEnds > 0 &&
        this.now() - this.interruptedTurnEndAt <= STOP_ENDING_GRACE_MS
      ) {
        // Claude marks a Stop ending `aborted_streaming`, or `aborted_tools` when a tool was running. The wire translates both to `interrupted`.
        // Consume that ending's debt without closing a later prompt's turn.
        this.interruptedTurnEnds -= 1;
        this.busy = this.countedBusy();
      } else {
        // Expire old Stop-ending debt. An unrelated outcome does not establish that the interrupted ending will never arrive.
        if (this.now() - this.interruptedTurnEndAt > STOP_ENDING_GRACE_MS) {
          this.interruptedTurnEnds = 0;
        }
        this.turnEndings += 1;
        const first = this.openTurns.values().next().value;
        if (first) {
          endedTurnId = first.id;
          this.openTurns.delete(first);
        }
        this.busy = this.countedBusy();
      }
      // Remove asks whose driver no longer waits for an answer after the turn ends.
      // Keep asks that the driver identifies as outliving their turn.
      for (const id of [...this.asks.keys()]) {
        if (!this.driver.outlivesTurn?.(id)) {
          this.asks.delete(id);
        }
      }
    }
    if (event.kind === 'error') {
      this.lastError = event.message;
    }
    // Before the ending is reported, so that nothing reading this session sees it idle with
    // a pick still waiting. A prompt the reader sent in the meantime goes after the command.
    if (event.kind === 'turnEnd') {
      if (endedTurnId !== undefined) this.respondingTurns.delete(endedTurnId);
      this.drainHeldEffort();
    }
    this.report(event, endedTurnId);
    this.changed();
  }

  private finish(error: string | null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.preparingTurns.clear();
    this.openTurns.clear();
    this.nativeTurnOwners.clear();
    this.respondingTurns.clear();
    this.responseOwners.clear();
    this.pendingResponses.length = 0;
    this.agentRunning = false;
    this.interruptedTurnEnds = 0;
    this.interruptedTurnEndAt = 0;
    this.busy = false;
    this.delivering.clear();
    if (error) {
      this.lastError = error;
    }
    // After the diagnostic, because a prompt waiting on the pick reads it when it is let go.
    this.dropHeldEffort();
    this.driver.close(error ?? 'the agent is no longer running');
    this.asks.clear();
    this.changed();
  }
}

// Reads MCP status through one idle child for an explicit reader request.
// The CLI waits for server connections before answering this status request.
// Returns null for an opening failure, a status failure, or an unavailable status operation.
export async function askIdleMcp(
  plan: AgentPlan,
  spawner: Spawner,
  openingDeadlineMs: number = OPENING_DEADLINE_MS,
): Promise<McpServer[] | null> {
  const session = new AgentSession(
    'idle-mcp',
    plan,
    spawner,
    () => {},
    () => {},
    openingDeadlineMs,
  );
  try {
    await session.start();
    if (session.state().lastError) {
      return null;
    }
    return await session.mcpStatus();
  } catch {
    return null;
  } finally {
    void session.dispose();
  }
}

// One press on the servers switch, said in the two ways the row can ask.
export interface McpChange {
  serverName: string;
  // What the switch is being set to, or null where the press was asking for another try at a
  // server that failed.
  enabled: boolean | null;
}

// The resulting MCP status, per-server failures, and whole-operation refusal from an idle change request.
// The idle child applies changes before reading status and completing orderly shutdown.
export interface McpChangeResult {
  // Current server status, or null when the read fails.
  servers: McpServer[] | null;
  // One line per server that refused, empty where all of them answered.
  failures: string[];
  // A startup or operation refusal, separate from failures naming individual servers. Empty when the exchange succeeds.
  refusal: string;
}

export async function askIdleMcpChange(
  plan: AgentPlan,
  spawner: Spawner,
  changes: readonly McpChange[],
  openingDeadlineMs: number = OPENING_DEADLINE_MS,
): Promise<McpChangeResult> {
  const session = new AgentSession(
    'idle-mcp-set',
    plan,
    spawner,
    () => {},
    () => {},
    openingDeadlineMs,
  );
  try {
    await session.start();
    const refusal = session.state().lastError;
    if (refusal) {
      return { servers: null, failures: [], refusal };
    }
    // Collect individual server failures so remaining requested changes still run.
    const failures: string[] = [];
    for (const change of changes) {
      try {
        if (change.enabled === null) {
          await session.mcpReconnect(change.serverName);
        } else {
          await session.mcpToggle(change.serverName, change.enabled);
        }
      } catch (error) {
        failures.push(`${change.serverName} (${(error as Error).message})`);
      }
    }
    const servers = await session.mcpStatus();
    return { servers, failures, refusal: '' };
  } catch (error) {
    return { servers: null, failures: [], refusal: (error as Error).message };
  } finally {
    // Wait for shutdown before returning so the next child reads the CLI's persisted changes.
    await session.dispose();
  }
}

// Everything one idle child was asked for in the exchange it was started for.
export interface IdleAnswers {
  usage: UsageReading | null;
  usageFailure: string;
  models: ModelList | null;
  // Commands returned by the opening handshake, available before the reader sends a prompt.
  // Empty when the completed handshake publishes none.
  commands: PromptEntry[];
}

// Reads account usage and model catalogs through one idle child, then closes it.
// Usage and model requests handle failures independently. Opening or spawner failure rejects the exchange.
export async function askIdle(
  plan: AgentPlan,
  spawner: Spawner,
  openingDeadlineMs: number = OPENING_DEADLINE_MS,
): Promise<IdleAnswers> {
  const session = new AgentSession(
    'idle',
    plan,
    spawner,
    () => {},
    () => {},
    openingDeadlineMs,
  );
  try {
    await session.start();
    const failed = session.state().lastError;
    if (failed) {
      throw new Error(failed);
    }
    // The completed handshake has already supplied commands.
    const commands = session.state().commands;
    // Exclude MCP status here because that read waits for server connections.
    // Account usage and model requests run independently through the same child.
    let usageFailure = '';
    const [usage, models] = await Promise.all([
      session.rateLimits().catch((error: Error) => {
        usageFailure = error.message;
        return null;
      }),
      session.models().catch(() => null),
    ]);
    return { usage, usageFailure, models, commands };
  } finally {
    void session.dispose();
  }
}

// Serializes account-usage reads per agent without losing an explicit request behind a
// background read. A forced request waits for an automatic one. Repeated requests share the
// answer only when they also target the same owner-scoped MCP discovery.
export class UsageReadQueue {
  private readonly active = new Map<
    string,
    {
      force: boolean;
      requestOwner: string;
      promise: Promise<void>;
    }
  >();
  private readonly deferred = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();

  run(agent: string, force: boolean, read: (force: boolean) => Promise<void>, requestOwner = ''): Promise<void> {
    const active = this.active.get(agent);
    if (active) {
      if (active.requestOwner === requestOwner && (!force || active.force)) {
        return active.promise;
      }
      return active.promise.then(
        () => this.run(agent, force, read, requestOwner),
        () => this.run(agent, force, read, requestOwner),
      );
    }

    const promise = Promise.resolve().then(() => read(force));
    this.active.set(agent, { force, requestOwner, promise });
    const clear = () => {
      if (this.active.get(agent)?.promise === promise) {
        this.active.delete(agent);
      }
    };
    void promise.then(clear, clear);
    return promise;
  }

  waitUntilIdle(agent: string, force: boolean): Promise<void> | null {
    if (!force) {
      return null;
    }
    const waiting = this.deferred.get(agent);
    if (waiting) {
      return waiting.promise;
    }
    let resolve = () => {};
    let reject = (_error: Error) => {};
    const promise = new Promise<void>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    this.deferred.set(agent, { promise, resolve, reject });
    return promise;
  }

  resumeDeferred(agent: string, read: () => Promise<void>): Promise<void> | null {
    const waiting = this.deferred.get(agent);
    if (!waiting) {
      return null;
    }
    this.deferred.delete(agent);
    try {
      void read().then(waiting.resolve, waiting.reject);
    } catch (error) {
      waiting.reject(error as Error);
    }
    return waiting.promise;
  }

  failDeferred(agent: string, error: Error): boolean {
    const waiting = this.deferred.get(agent);
    if (!waiting) {
      return false;
    }
    this.deferred.delete(agent);
    waiting.reject(error);
    return true;
  }
}

// The model catalog's refresh interval. CLI releases change catalogs less often than turns change account usage.
export const MODELS_FRESH_MS = 12 * 60 * 60 * 1000;

// Keeps each agent's latest model catalog and suppresses repeated failed automatic reads.
export class ModelBook {
  private readonly byAgent = new Map<string, ModelList>();
  // Agents whose catalog read failed. An explicit refresh clears this suppression.
  private readonly silent = new Set<string>();

  note(agent: string, list: ModelList): void {
    this.byAgent.set(agent, list);
    this.silent.delete(agent);
  }

  // Suppress automatic retries while retaining the existing catalog.
  noteSilent(agent: string): void {
    this.silent.add(agent);
  }

  get(agent: string): ModelList | null {
    return this.byAgent.get(agent) ?? null;
  }

  pending(agent: string): boolean {
    return !this.byAgent.has(agent) && !this.silent.has(agent);
  }

  // Every list, keyed by agent, which is the shape the panel draws its pickers from.
  lists(): Record<string, ModelChoice[]> {
    const out: Record<string, ModelChoice[]> = {};
    for (const [agent, list] of this.byAgent) out[agent] = list.models;
    return out;
  }

  // Selects agents whose catalogs need a refresh. Force clears failure suppression and bypasses the age check.
  toAsk(agents: readonly string[], now: number, force: boolean): string[] {
    if (force) {
      for (const agent of agents) this.silent.delete(agent);
      return [...agents];
    }
    return agents.filter((agent) => {
      if (this.silent.has(agent)) {
        return false;
      }
      const list = this.byAgent.get(agent);
      return !list || now - list.readAt > MODELS_FRESH_MS;
    });
  }
}

// Keeps each draft or recorded session's last MCP status without a freshness timer.
// Revisions reject outdated readings. Toggle and reconnect operations trigger another read.
// An unanswered initial read can retry. A child-start failure suppresses automatic initial retries.
export class McpBook {
  private readonly byAgent = new Map<string, McpServer[]>();
  private readonly revisions = new Map<string, number>();
  private readonly initialReads = new Set<string>();
  private readonly initialReadsInFlight = new Map<string, number>();

  revision(agent: string): number {
    return this.revisions.get(agent) ?? 0;
  }

  change(agent: string): number {
    const revision = this.revision(agent) + 1;
    this.revisions.set(agent, revision);
    return revision;
  }

  needsInitialRead(agent: string): boolean {
    return !this.initialReads.has(agent) && !this.initialReadsInFlight.has(agent);
  }

  beginInitialRead(agent: string, expectedRevision = this.revision(agent)): number | null {
    if (expectedRevision !== this.revision(agent) || !this.needsInitialRead(agent)) {
      return null;
    }
    const revision = this.change(agent);
    this.initialReadsInFlight.set(agent, revision);
    return revision;
  }

  finishInitialRead(agent: string, revision: number, answered: boolean): void {
    if (this.initialReadsInFlight.get(agent) !== revision) {
      return;
    }
    this.initialReadsInFlight.delete(agent);
    if (answered) {
      this.initialReads.add(agent);
    }
  }

  invalidateInitialReads(): void {
    this.initialReadsInFlight.clear();
  }

  noteSilent(agent: string, revision: number): void {
    this.finishInitialRead(agent, revision, true);
  }

  note(agent: string, servers: McpServer[], revision = this.revision(agent)): boolean {
    if (revision !== this.revision(agent)) {
      return false;
    }
    this.byAgent.set(agent, servers);
    this.initialReads.add(agent);
    if (this.initialReadsInFlight.get(agent) === revision) {
      this.initialReadsInFlight.delete(agent);
    }
    return true;
  }

  adopt(provisional: string, actual: string): void {
    const servers = this.byAgent.get(provisional);
    const revision = this.revision(provisional);
    this.change(provisional);
    this.byAgent.delete(provisional);
    this.initialReads.delete(provisional);
    this.initialReadsInFlight.delete(provisional);
    if (servers) {
      this.byAgent.set(actual, servers);
    }
    this.revisions.set(actual, revision);
    if (servers) {
      this.initialReads.add(actual);
    }
  }

  forget(owner: string): void {
    this.change(owner);
    this.byAgent.delete(owner);
    this.initialReads.delete(owner);
    this.initialReadsInFlight.delete(owner);
  }

  // Returns null before an accepted reading. An empty list means the agent reported no servers.
  get(agent: string): McpServer[] | null {
    return this.byAgent.get(agent) ?? null;
  }

  // Every reading, keyed by its draft or recorded session owner.
  lists(): Record<string, McpServer[]> {
    const out: Record<string, McpServer[]> = {};
    for (const [agent, servers] of this.byAgent) out[agent] = servers;
    return out;
  }
}

export class McpPendingRefreshes {
  private readonly timer: AgentHostTimer;
  private readonly now: () => number;
  private readonly delayMs: number;
  private readonly deadlineMs: number;
  private readonly active = new Map<
    string,
    {
      retryTimer: unknown | null;
      deadlineTimer: unknown;
      deadline: number;
    }
  >();

  constructor(
    options: {
      timer?: AgentHostTimer;
      now?: () => number;
      delayMs?: number;
      deadlineMs?: number;
    } = {},
  ) {
    this.timer = options.timer ?? AGENT_HOST_TIMER;
    this.now = options.now ?? Date.now;
    this.delayMs = options.delayMs ?? 250;
    this.deadlineMs = options.deadlineMs ?? 10_000;
  }

  follow(
    owner: string,
    servers: readonly McpServer[],
    read: () => Promise<McpServer[] | null>,
    publish: (servers: McpServer[]) => void,
  ): void {
    this.cancel(owner);
    if (!servers.some((server) => server.status === 'pending')) {
      return;
    }
    const deadline = this.now() + this.deadlineMs;
    let deadlineTimer: unknown;
    deadlineTimer = this.timer.set(() => {
      if (this.active.get(owner)?.deadlineTimer === deadlineTimer) {
        this.cancel(owner);
      }
    }, this.deadlineMs);
    this.active.set(owner, { retryTimer: null, deadlineTimer, deadline });
    const schedule = () => {
      if (this.now() >= deadline) {
        this.cancel(owner);
        return;
      }
      let retryTimer: unknown;
      retryTimer = this.timer.set(() => {
        const current = this.active.get(owner);
        if (!current || current.retryTimer !== retryTimer) {
          return;
        }
        this.timer.clear(retryTimer);
        current.retryTimer = null;
        void read().then(
          (next) => {
            if (!next || this.active.get(owner) !== current || this.now() >= deadline) {
              if (this.now() >= deadline && this.active.get(owner) === current) {
                this.cancel(owner);
              }
              return;
            }
            publish(next);
            if (next.some((server) => server.status === 'pending')) {
              schedule();
            } else {
              this.cancel(owner);
            }
          },
          () => {
            if (this.active.get(owner) === current) {
              this.cancel(owner);
            }
          },
        );
      }, this.delayMs);
      const current = this.active.get(owner);
      if (current) {
        current.retryTimer = retryTimer;
      }
    };
    schedule();
  }

  cancel(owner: string): void {
    const current = this.active.get(owner);
    if (!current) {
      return;
    }
    this.active.delete(owner);
    if (current.retryTimer !== null) {
      this.timer.clear(current.retryTimer);
    }
    this.timer.clear(current.deadlineTimer);
  }

  dispose(): void {
    for (const owner of [...this.active.keys()]) {
      this.cancel(owner);
    }
  }
}

// Keeps the reader's stored model unless a loaded catalog excludes it.
// A missing catalog preserves the pick until the agent's models are known.
export function pickedModel(picked: string, list: ModelList | null): string {
  if (!picked || !list) {
    return picked;
  }
  return chosenModel(list.models, picked) ? picked : '';
}

// Keeps the picked effort when the loaded catalog offers it.
// With a model, check that model's levels. Without one, check levels across the catalog.
export function pickedEffort(picked: string, list: ModelList | null, model: string): string {
  if (!picked || !list) {
    return picked;
  }
  const choices = model ? effortChoices(list.models, model) : list.models.flatMap((item) => item.efforts);
  return choices.some((e) => e.value === picked) ? picked : '';
}

// What a model change leaves behind for one session.
export interface ModelChange {
  // The level that survives the change. Empty when the new model offers no such level.
  effort: string;
  // Whether to tell the live child that its selected effort changed. Unsupported effort drops trigger that notification.
  tellChild: boolean;
  // The fields the session stores. A field left out keeps the standing it had.
  settings: Partial<SessionSettingSelection>;
}

// Resolves selected and pending settings after a model change.
// Live Claude sessions leave no pending model. Codex and sessions without a live child retain a pending model.
// An effort drop clears pending effort and requests a live-child notification.
// Surviving effort retains its existing pending state.
export function modelChange(
  agent: AgentName,
  model: string,
  held: string,
  list: ModelList | null,
  live: boolean,
): ModelChange {
  const effort = pickedEffort(held, list, model);
  const settings: Partial<SessionSettingSelection> = {
    selectedModel: model,
    selectedEffort: effort,
    effortModel: effort ? model : '',
    pendingModel: agent === 'codex' || !live ? model || null : null,
  };
  if (!effort) {
    settings.pendingEffort = null;
  }
  return { effort, tellChild: live && effort !== held, settings };
}

// Owns children started by this window. Other windows read their work from disk.
export class AgentHost {
  private readonly sessions = new Map<string, AgentSession>();
  // Opening promises shared by callers for the same host key.
  private readonly starting = new Map<string, Promise<AgentSession>>();
  private readonly startingSessions = new Map<string, Promise<AgentSession>>();
  private readonly spawner: Spawner;
  private readonly timer: AgentHostTimer;
  private readonly retirementTimers = new Map<string, unknown>();
  private readonly retiringKeys = new Map<string, Promise<void>>();
  private readonly retiringSessions = new Map<string, Promise<void>>();
  private archived = new Set<string>();
  private readonly pendingArchiveRetirement = new Set<string>();
  private housekeepingGeneration = 0;
  private readonly housekeepingGenerations = new Map<AgentSession, number>();
  private readonly settledGenerations = new Map<AgentSession, number>();
  private readonly activityLeases = new Map<AgentSession, number>();
  private readonly exclusiveActivityWaiters = new Map<AgentSession, { promise: Promise<void>; resolve: () => void }>();
  // A requested operation reserves its key before the opening exchange. An archived
  // session can otherwise retire between `session` settling and `withActivity`
  // acquiring its lease.
  private readonly openingReservations = new Map<string, number>();
  private readonly targetedRetirements = new Map<
    string,
    { promise: Promise<void>; resolve: () => void; cancelable: boolean }
  >();
  // Rename-only children, by session identity. An opening of the same session waits for its
  // child to exit, so two writers never share a transcript. Host disposal ends them.
  private readonly renamingSessions = new Map<string, Promise<void>>();
  private readonly renameChildren = new Set<AgentSession>();
  private idleDurationMs: number;
  private disposed = false;

  constructor(private readonly options: HostOptions) {
    this.spawner = options.spawner ?? spawnCli;
    this.timer = options.timer ?? AGENT_HOST_TIMER;
    this.idleDurationMs = options.idleDurationMs;
  }

  // Returns or starts the child under `key`. A resume id reconnects the session from its saved record after a window reload.
  async session(key: string, source: AgentPlanSource): Promise<AgentSession> {
    this.assertActive();
    const requestedRetirement = this.targetedRetirements.get(key);
    if (requestedRetirement) {
      await requestedRetirement.promise;
      this.assertActive();
    }
    const opening = this.starting.get(key);
    if (opening) {
      const session = await opening;
      this.assertActive();
      return session;
    }

    const running = this.sessions.get(key);
    if (running && !running.state().exited) {
      return running;
    }
    if (running) {
      this.sessions.delete(key);
    }

    const plan = typeof source === 'function' ? source() : source;
    const identity = plan.sessionId ? this.sessionIdentity(plan.agent, plan.sessionId) : null;
    const sessionOpening = identity ? this.startingSessions.get(identity) : null;
    if (sessionOpening) {
      const session = await sessionOpening;
      this.assertActive();
      return session;
    }

    const started = this.startSession(key, plan, identity, typeof source === 'function' ? source : null);
    this.starting.set(key, started);
    if (identity) {
      this.startingSessions.set(identity, started);
    }
    try {
      return await started;
    } finally {
      if (this.starting.get(key) === started) {
        this.starting.delete(key);
      }
      if (identity && this.startingSessions.get(identity) === started) {
        this.startingSessions.delete(identity);
      }
    }
  }

  private async startSession(
    key: string,
    initialPlan: AgentPlan,
    identity: string | null,
    refreshPlan: (() => AgentPlan) | null,
  ): Promise<AgentSession> {
    const shutdowns = new Set<Promise<void>>();
    const keyShutdown = this.retiringKeys.get(key);
    const sessionShutdown = identity ? this.retiringSessions.get(identity) : null;
    if (keyShutdown) {
      shutdowns.add(keyShutdown);
    }
    if (sessionShutdown) {
      shutdowns.add(sessionShutdown);
    }
    const renaming = identity ? this.renamingSessions.get(identity) : null;
    if (renaming) {
      shutdowns.add(renaming);
    }
    if (shutdowns.size) {
      await Promise.all(shutdowns);
    }
    this.assertActive();
    const plan = refreshPlan ? refreshPlan() : initialPlan;
    const refreshedIdentity = plan.sessionId ? this.sessionIdentity(plan.agent, plan.sessionId) : null;
    if (plan.agent !== initialPlan.agent || refreshedIdentity !== identity) {
      throw new Error('the agent session changed while its previous process closed');
    }

    const running = this.sessions.get(key);
    if (running && !running.state().exited) {
      return running;
    }
    if (running) {
      this.sessions.delete(key);
    }
    if (plan.sessionId) {
      const adopted = this.find(plan.agent, plan.sessionId);
      if (adopted) {
        return adopted;
      }
    }

    const session = new AgentSession(
      key,
      plan,
      this.spawner,
      (event, turnId) => this.options.onEvent(turnId === undefined ? { key, event } : { key, event, turnId }),
      () => {
        this.applyTargetedRetirementEligibility(key, session);
        this.options.onStateChange(this.sessions.get(key)?.state() ?? session.state());
      },
      this.options.openingDeadlineMs,
      this.options.exitGraceMs,
      this.options.now,
    );
    this.sessions.set(key, session);
    await session.start();
    if (this.disposed) {
      if (this.sessions.get(key) === session) {
        this.sessions.delete(key);
      }
      await session.dispose();
      this.assertActive();
    }
    if (!session.state().exited) {
      this.settleOpening(key, session);
    }
    return session;
  }

  get(key: string): AgentSession | null {
    return this.sessions.get(key) ?? null;
  }

  // A fork starts under a temporary host key because its session id is the answer to
  // opening it. Later sends know that id, so find the child by what the agent adopted rather
  // than starting another writer for the same session.
  find(agent: AgentName, sessionId: string): AgentSession | null {
    for (const session of this.sessions.values()) {
      const state = session.state();
      if (session.agent === agent && !state.exited && state.sessionId === sessionId) {
        return session;
      }
    }
    return null;
  }

  // Renames through the running child or a rename-only child.
  // Wait for opening, retirement, and earlier renames of the session before starting another writer.
  async renameSession(agent: AgentName, sessionId: string, title: string, idlePlan: () => AgentPlan): Promise<void> {
    const identity = this.sessionIdentity(agent, sessionId);
    for (;;) {
      this.assertActive();
      const pending: Promise<unknown>[] = [];
      for (const wait of [
        this.startingSessions.get(identity),
        this.renamingSessions.get(identity),
        this.retiringSessions.get(identity),
      ]) {
        if (wait) {
          pending.push(wait);
        }
      }
      if (!pending.length) {
        break;
      }
      await Promise.allSettled(pending);
    }
    const live = this.find(agent, sessionId);
    if (live) {
      await this.whileRenaming(identity, async () => {
        const renamed = await this.withActivity(live.key, async (child) => {
          await child.rename(sessionId, title);
          return true;
        });
        if (renamed === null) {
          throw new Error('The agent stopped before it renamed the session.');
        }
      });
      return;
    }
    const child = new AgentSession(
      `rename:${identity}`,
      idlePlan(),
      this.spawner,
      () => undefined,
      () => undefined,
      this.options.openingDeadlineMs,
      this.options.exitGraceMs,
      this.options.now,
    );
    this.renameChildren.add(child);
    await this.whileRenaming(identity, async () => {
      try {
        await child.startOrThrow();
      } finally {
        await child.dispose();
        this.renameChildren.delete(child);
      }
    });
  }

  // Reserves the rename slot until the operation settles. Another rename waits instead of competing for the same transcript end.
  private async whileRenaming(identity: string, work: () => Promise<void>): Promise<void> {
    const renaming = work();
    const settled = renaming.then(
      () => undefined,
      () => undefined,
    );
    this.renamingSessions.set(identity, settled);
    try {
      await renaming;
    } finally {
      if (this.renamingSessions.get(identity) === settled) {
        this.renamingSessions.delete(identity);
      }
    }
  }

  // Holds a child for one process operation. A lease cancels retirement before the caller
  // can await. Its release starts a new full idle window when the child remains eligible.
  async withActivity<T>(key: string, work: (session: AgentSession) => Promise<T>): Promise<T | null> {
    const targeted = this.targetedRetirements.get(key);
    if (targeted) {
      await targeted.promise;
      return null;
    }
    const opening = this.starting.get(key);
    const session = this.sessions.get(key) ?? null;
    if (!session || session.state().exited) {
      return null;
    }
    this.cancelRetirement(key);
    this.activityLeases.set(session, (this.activityLeases.get(session) ?? 0) + 1);
    try {
      if (opening) {
        await Promise.allSettled([opening]);
      }
      if (session.state().exited) {
        return null;
      }
      return await work(session);
    } finally {
      this.releaseActivity(key, session);
    }
  }

  // Holds every named child before one operation can wait on another. Permission changes
  // use this path so an idle target later in the sequence cannot retire during an earlier
  // child's control response.
  async withActivities<T>(
    keys: readonly string[],
    work: (sessions: ReadonlyMap<string, AgentSession>) => Promise<T>,
  ): Promise<T | null> {
    const targeted = new Set(
      keys.map((key) => this.targetedRetirements.get(key)?.promise).filter((wait) => wait !== undefined),
    );
    if (targeted.size) {
      await Promise.all(targeted);
      return null;
    }
    const openings = new Set<Promise<AgentSession>>();
    const held = new Map<string, AgentSession>();
    for (const key of keys) {
      const session = this.sessions.get(key) ?? null;
      if (!session || session.state().exited) {
        for (const [heldKey, heldSession] of held) {
          this.releaseActivity(heldKey, heldSession);
        }
        return null;
      }
      if (held.has(key)) {
        continue;
      }
      this.cancelRetirement(key);
      this.activityLeases.set(session, (this.activityLeases.get(session) ?? 0) + 1);
      held.set(key, session);
      const opening = this.starting.get(key);
      if (opening) {
        openings.add(opening);
      }
    }
    try {
      if (openings.size) {
        await Promise.allSettled(openings);
      }
      if ([...held.values()].some((session) => session.state().exited)) {
        return null;
      }
      return await work(held);
    } finally {
      for (const [heldKey, heldSession] of held) {
        this.releaseActivity(heldKey, heldSession);
      }
    }
  }

  // Reserves every current child before publishing the barriers that exclude later work.
  // Earlier leases finish before the transition work starts. The old children close only
  // after that work succeeds, so a failed transition leaves queued work on the old child.
  async withRetiringActivities<T>(
    keys: readonly string[],
    work: (sessions: ReadonlyMap<string, AgentSession>) => Promise<T>,
  ): Promise<T | null> {
    const openings = new Set<Promise<AgentSession>>();
    const held = new Map<string, AgentSession>();
    for (const key of keys) {
      if (held.has(key)) {
        continue;
      }
      if (this.targetedRetirements.has(key)) {
        for (const [heldKey, heldSession] of held) {
          this.releaseActivity(heldKey, heldSession);
        }
        return null;
      }
      const session = this.sessions.get(key) ?? null;
      if (!session || session.state().exited) {
        for (const [heldKey, heldSession] of held) {
          this.releaseActivity(heldKey, heldSession);
        }
        return null;
      }
      this.cancelRetirement(key);
      this.activityLeases.set(session, (this.activityLeases.get(session) ?? 0) + 1);
      held.set(key, session);
      const opening = this.starting.get(key);
      if (opening) {
        openings.add(opening);
      }
    }
    const retirements = [...held.keys()].map((key) => ({ key, retirement: this.requestRetirement(key, false) }));
    let accepted = false;
    try {
      const priorActivities = [...held.values()].map((session) => this.waitForExclusiveActivity(session));
      await Promise.allSettled([...openings, ...priorActivities]);
      if ([...held].some(([key, session]) => this.sessions.get(key) !== session || session.state().exited)) {
        return null;
      }
      const result = await work(held);
      accepted = true;
      return result;
    } finally {
      if (!accepted) {
        for (const { key, retirement } of retirements) {
          this.cancelTargetedRetirement(key, retirement);
        }
      }
      for (const [heldKey, heldSession] of held) {
        this.releaseActivity(heldKey, heldSession);
      }
      if (accepted) {
        await Promise.all(retirements.map(({ retirement }) => retirement.promise));
      }
    }
  }

  // Keeps every live target available until each requested change and the final status read
  // have settled. A target later in the sequence cannot retire while an earlier one answers.
  async changeMcp(
    keys: readonly string[],
    changes: readonly McpChange[],
  ): Promise<{ failures: string[]; servers: McpServer[] | null } | null> {
    if (!keys.length) {
      return { failures: [], servers: null };
    }
    return await this.withActivities(keys, async (sessions) => {
      const failures: string[] = [];
      for (const key of keys) {
        const session = sessions.get(key);
        if (!session) {
          continue;
        }
        for (const change of changes) {
          try {
            if (change.enabled === null) {
              await session.mcpReconnect(change.serverName);
            } else {
              await session.mcpToggle(change.serverName, change.enabled);
            }
          } catch (error) {
            failures.push(`${change.serverName} (${(error as Error).message})`);
          }
        }
      }
      let servers: McpServer[] | null = null;
      try {
        servers = await sessions.get(keys[0])!.mcpStatus();
      } catch {
        /* Keep the last complete reading. */
      }
      return { failures, servers };
    });
  }

  // Opens or reuses a session and holds it through the operation that asked for it. The
  // reservation exists before the handshake, so opening an archived session cannot
  // retire it in the gap before the ordinary activity lease begins.
  async withSessionActivity<T>(
    key: string,
    plan: AgentPlanSource,
    work: (session: AgentSession) => Promise<T>,
  ): Promise<T> {
    const requestedRetirement = this.targetedRetirements.get(key);
    if (requestedRetirement) {
      await requestedRetirement.promise;
      this.assertActive();
    }
    this.reserveOpening(key);
    let session: AgentSession | null = null;
    try {
      session = await this.session(key, plan);
      const retirement = this.targetedRetirements.get(key);
      if (retirement) {
        this.releaseOpening(key, session);
        session = null;
        await retirement.promise;
        this.assertActive();
        return await this.withSessionActivity(key, plan, work);
      }
      const result = await this.withActivity(session.key, work);
      if (result === null) {
        throw new Error('the agent session closed before the operation started');
      }
      return result;
    } finally {
      this.releaseOpening(key, session);
    }
  }

  // Marks the housekeeping batch for the latest turn before either control read starts.
  beginHousekeeping(key: string): AgentHousekeeping | null {
    this.cancelRetirement(key);
    const session = this.sessions.get(key);
    if (!session) {
      return null;
    }
    const generation = ++this.housekeepingGeneration;
    this.housekeepingGenerations.set(session, generation);
    this.settledGenerations.delete(session);
    return { key, session, generation };
  }

  // Turn-end usage and MCP reads call this after both have settled. Only the latest batch
  // for the same live child can start retirement.
  settled(housekeeping: AgentHousekeeping | null): void {
    if (!housekeeping) {
      return;
    }
    const { key, session, generation } = housekeeping;
    if (this.sessions.get(key) !== session || this.housekeepingGenerations.get(session) !== generation) {
      return;
    }
    this.settledGenerations.set(session, generation);
    this.applyRetirementEligibility(key, session);
  }

  // The panel sends the complete archive set. Archive closes an eligible child now and
  // records busy or waiting children for the next settled turn.
  setArchived(sessionIds: Iterable<string>): void {
    const previous = this.archived;
    this.archived = new Set(sessionIds);
    for (const [key, session] of [...this.sessions]) {
      const state = session.state();
      const sessionId = state.sessionId;
      const wasArchived = sessionId !== null && previous.has(sessionId);
      if (this.isArchived(state)) {
        this.cancelRetirement(key);
        if (this.canRetire(key, session, state)) {
          void this.retire(key, session);
        } else this.pendingArchiveRetirement.add(key);
      } else if (wasArchived || this.pendingArchiveRetirement.has(key)) {
        this.pendingArchiveRetirement.delete(key);
        this.cancelRetirement(key);
      }
    }
  }

  // A duration change starts a new full idle window for every eligible child.
  setIdleDuration(durationMs: number): void {
    this.idleDurationMs = durationMs;
    for (const key of [...this.retirementTimers.keys()]) this.cancelRetirement(key);
    for (const [key, session] of [...this.sessions]) {
      const state = session.state();
      if (!this.canRetire(key, session, state)) {
        continue;
      }
      if (this.isArchived(state)) {
        void this.retire(key, session);
      } else {
        this.scheduleRetirement(key, session);
      }
    }
  }

  states(): SessionState[] {
    return [...this.sessions.values()].map((s) => s.state());
  }

  async retireSession(key: string): Promise<void> {
    const requested = this.targetedRetirements.get(key);
    if (requested) {
      return await requested.promise;
    }
    const retirement = this.requestRetirement(key, true);
    this.cancelRetirement(key);
    const opening = this.starting.get(key);
    if (opening) {
      await Promise.allSettled([opening]);
    }
    if (this.targetedRetirements.get(key) !== retirement) {
      return await retirement.promise;
    }
    const session = this.sessions.get(key);
    if (session) {
      this.applyRetirementEligibility(key, session);
    } else {
      this.targetedRetirements.delete(key);
      retirement.resolve();
    }
    await retirement.promise;
  }

  cancelSessionRetirement(key: string): void {
    const requested = this.targetedRetirements.get(key);
    if (!requested) {
      return;
    }
    if (!requested.cancelable) {
      return;
    }
    this.targetedRetirements.delete(key);
    requested.resolve();
  }

  // Lists all asks waiting on the reader across this window's sessions.
  waiting(): { key: string; ask: Ask }[] {
    const out: { key: string; ask: Ask }[] = [];
    for (const session of this.sessions.values()) {
      for (const ask of session.state().asks) out.push({ key: session.key, ask });
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const key of [...this.retirementTimers.keys()]) this.cancelRetirement(key);
    for (const session of this.sessions.values()) void session.dispose();
    for (const child of this.renameChildren) void child.dispose();
    this.sessions.clear();
    this.renameChildren.clear();
    this.renamingSessions.clear();
    this.starting.clear();
    this.startingSessions.clear();
    this.pendingArchiveRetirement.clear();
    this.housekeepingGenerations.clear();
    this.settledGenerations.clear();
    this.activityLeases.clear();
    this.openingReservations.clear();
    for (const requested of this.targetedRetirements.values()) {
      requested.resolve();
    }
    this.targetedRetirements.clear();
  }

  private eligible(state: SessionState): boolean {
    return !state.exited && !state.busy && state.asks.length === 0;
  }

  private requestRetirement(
    key: string,
    cancelable: boolean,
  ): { promise: Promise<void>; resolve: () => void; cancelable: boolean } {
    let resolveRetirement: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveRetirement = resolve;
    });
    const retirement = { promise, resolve: resolveRetirement, cancelable };
    this.targetedRetirements.set(key, retirement);
    this.cancelRetirement(key);
    return retirement;
  }

  private cancelTargetedRetirement(
    key: string,
    retirement: { promise: Promise<void>; resolve: () => void; cancelable: boolean },
  ): void {
    if (this.targetedRetirements.get(key) !== retirement) {
      return;
    }
    this.targetedRetirements.delete(key);
    retirement.resolve();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('the agent host is no longer running');
    }
  }

  private settleOpening(key: string, session: AgentSession): void {
    if (this.sessions.get(key) !== session) {
      return;
    }
    const generation = ++this.housekeepingGeneration;
    this.housekeepingGenerations.set(session, generation);
    this.settledGenerations.set(session, generation);
    this.applyRetirementEligibility(key, session);
  }

  private canRetire(key: string, session: AgentSession, state = session.state()): boolean {
    const generation = this.housekeepingGenerations.get(session);
    return (
      generation !== undefined &&
      this.settledGenerations.get(session) === generation &&
      !this.activityLeases.has(session) &&
      !this.openingReservations.has(key) &&
      this.eligible(state)
    );
  }

  private applyRetirementEligibility(key: string, session: AgentSession): void {
    if (this.sessions.get(key) !== session) {
      return;
    }
    const state = session.state();
    if (this.applyTargetedRetirementEligibility(key, session, state)) {
      return;
    }
    if (!this.canRetire(key, session, state)) {
      if (this.isArchived(state)) {
        this.pendingArchiveRetirement.add(key);
      }
      return;
    }
    this.pendingArchiveRetirement.delete(key);
    if (this.isArchived(state)) {
      void this.retire(key, session);
    } else {
      this.scheduleRetirement(key, session);
    }
  }

  private applyTargetedRetirementEligibility(key: string, session: AgentSession, state = session.state()): boolean {
    if (this.sessions.get(key) !== session) {
      return false;
    }
    const targeted = this.targetedRetirements.get(key);
    if (
      targeted &&
      !this.activityLeases.has(session) &&
      !this.openingReservations.has(key) &&
      !state.busy &&
      state.asks.length === 0
    ) {
      this.targetedRetirements.delete(key);
      void this.retire(key, session).then(targeted.resolve);
      return true;
    }
    return false;
  }

  private isArchived(state: SessionState): boolean {
    return state.sessionId !== null && this.archived.has(state.sessionId);
  }

  private scheduleRetirement(key: string, session: AgentSession): void {
    let timer: unknown;
    timer = this.timer.set(() => {
      if (this.retirementTimers.get(key) !== timer) {
        return;
      }
      this.retirementTimers.delete(key);
      if (this.sessions.get(key) !== session) {
        return;
      }
      const state = session.state();
      if (!this.canRetire(key, session, state)) {
        if (this.isArchived(state)) {
          this.pendingArchiveRetirement.add(key);
        }
        return;
      }
      void this.retire(key, session);
    }, this.idleDurationMs);
    this.retirementTimers.set(key, timer);
  }

  private cancelRetirement(key: string): void {
    const timer = this.retirementTimers.get(key);
    if (timer === undefined) {
      return;
    }
    this.retirementTimers.delete(key);
    this.timer.clear(timer);
  }

  private releaseActivity(key: string, session: AgentSession): void {
    const leases = this.activityLeases.get(session);
    if (leases === undefined) {
      return;
    }
    if (leases > 1) {
      const remaining = leases - 1;
      this.activityLeases.set(session, remaining);
      if (remaining === 1) {
        const waiter = this.exclusiveActivityWaiters.get(session);
        this.exclusiveActivityWaiters.delete(session);
        waiter?.resolve();
      }
      return;
    }
    this.activityLeases.delete(session);
    if (this.sessions.get(key) !== session) {
      return;
    }
    this.applyRetirementEligibility(key, session);
  }

  private waitForExclusiveActivity(session: AgentSession): Promise<void> {
    if (this.activityLeases.get(session) === 1) {
      return Promise.resolve();
    }
    const existing = this.exclusiveActivityWaiters.get(session);
    if (existing) {
      return existing.promise;
    }
    let resolveWaiter: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
    this.exclusiveActivityWaiters.set(session, { promise, resolve: resolveWaiter });
    return promise;
  }

  private reserveOpening(key: string): void {
    this.assertActive();
    this.openingReservations.set(key, (this.openingReservations.get(key) ?? 0) + 1);
  }

  private releaseOpening(key: string, session: AgentSession | null): void {
    const reservations = this.openingReservations.get(key);
    if (reservations === undefined) {
      return;
    }
    if (reservations > 1) {
      this.openingReservations.set(key, reservations - 1);
      return;
    }
    this.openingReservations.delete(key);
    if (session) {
      this.applyRetirementEligibility(session.key, session);
    }
  }

  private sessionIdentity(agent: AgentName, sessionId: string): string {
    return JSON.stringify([agent, sessionId]);
  }

  private retire(key: string, session: AgentSession): Promise<void> {
    if (this.sessions.get(key) !== session) {
      return Promise.resolve();
    }
    this.cancelRetirement(key);
    this.pendingArchiveRetirement.delete(key);
    this.housekeepingGenerations.delete(session);
    this.settledGenerations.delete(session);
    this.activityLeases.delete(session);
    this.exclusiveActivityWaiters.get(session)?.resolve();
    this.exclusiveActivityWaiters.delete(session);
    this.sessions.delete(key);
    const state = session.state();
    const identity = state.sessionId ? this.sessionIdentity(session.agent, state.sessionId) : null;
    let completeShutdown: () => void = () => undefined;
    const shutdown = new Promise<void>((resolve) => {
      completeShutdown = resolve;
    });
    this.retiringKeys.set(key, shutdown);
    if (identity) {
      this.retiringSessions.set(identity, shutdown);
    }
    void session.dispose().then(completeShutdown, completeShutdown);
    void shutdown.then(() => {
      if (this.retiringKeys.get(key) === shutdown) {
        this.retiringKeys.delete(key);
      }
      if (identity && this.retiringSessions.get(identity) === shutdown) {
        this.retiringSessions.delete(identity);
      }
    });
    return shutdown;
  }
}

// Existing sessions use stable host keys so reopening finds the same child.
// Fresh-draft keys include their provisional id to keep simultaneous drafts on separate children.
export function existingHostKey(agent: AgentName, session: string): string {
  return `${agent}:${session}`;
}

export function freshHostKey(agent: AgentName, draftId: string): string {
  return `${agent}:fresh:${draftId}`;
}

export function retireDraftProfile(
  host: AgentHost,
  draft: { draftId: string; profile: { agent: AgentName } },
  mcp: McpBook,
  refreshes: McpPendingRefreshes,
  draftKeys: Map<string, string>,
  acceptedDrafts: ReadonlySet<string>,
): void {
  mcp.forget(draft.draftId);
  refreshes.cancel(draft.draftId);
  const mcpKey = draftKeys.get(draft.draftId);
  draftKeys.delete(draft.draftId);
  const keys = new Set([freshHostKey(draft.profile.agent, draft.draftId)]);
  if (mcpKey) keys.add(mcpKey);
  for (const key of keys) {
    if (!acceptedDrafts.has(key)) {
      void host.retireSession(key);
    }
  }
}

export async function openDraftMcp(
  host: AgentHost,
  key: string,
  plan: AgentPlanSource,
  refreshes: McpPendingRefreshes,
  owner: string,
  publish: (servers: McpServer[]) => boolean,
): Promise<boolean> {
  const read = () => host.withSessionActivity(key, plan, (session) => session.mcpStatus());
  const servers = await read();
  if (!servers || !publish(servers)) {
    return false;
  }
  refreshes.follow(owner, servers, read, (next) => {
    publish(next);
  });
  return true;
}

export function liveMcpTarget(
  states: readonly SessionState[],
  requestedOwner: string | undefined,
  draftKeys: ReadonlyMap<string, string>,
): { state: SessionState; owner: string } | null {
  if (requestedOwner) {
    const draftKey = draftKeys.get(requestedOwner);
    const state = states.find((candidate) => candidate.sessionId === requestedOwner || candidate.key === draftKey);
    return state ? { state, owner: requestedOwner } : null;
  }
  const provisionalKeys = new Set(draftKeys.values());
  const state = states.find((candidate) => Boolean(candidate.sessionId) && !provisionalKeys.has(candidate.key));
  return state?.sessionId ? { state, owner: state.sessionId } : null;
}

export async function askIdleDefaults(plan: AgentPlan, spawner: Spawner): Promise<AppliedDefaults> {
  const session = new AgentSession(
    'defaults',
    plan,
    spawner,
    () => {},
    () => {},
  );
  try {
    await session.start();
    if (session.state().lastError) return unavailableDefaults('The agent could not report its settings.');
    return await session.appliedDefaults();
  } catch {
    return unavailableDefaults('The agent could not report its settings.');
  } finally {
    await session.dispose();
  }
}
