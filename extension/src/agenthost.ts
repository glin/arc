import { MEASUREMENT_ENVIRONMENT } from './identity';
import { unavailableDefaults, type AppliedDefaults } from './view/model-picks';
import { CONTEXT_FRAME_BYTES, CONTEXT_PREFIX_BYTES, type ContextFrameGate } from './contextframe';
// The agents this window is driving, and the child processes behind them.
//
// `claudewire.ts` and `codexwire.ts` know their protocols and nothing else; this file
// knows about processes: which session owns which child, how a line off stdout gets
// framed, and what happens when a child dies. It imports `node:child_process` and not
// `vscode`, so the tests drive it with a fake spawner and never start a real CLI.
//
// One child serves one session, for the life of that session. The alternative,
// one child per turn, would pay the CLI's start-up and prompt-cache warming on every
// prompt the reader sends, which the capture showed to be most of the cost of a short
// turn.

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

// The part of a child process this file uses. Narrowed to these members so a test can
// supply a plain object, and so nothing here can reach for a process feature that a fake
// would have to grow to match.
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
) => ChildLike;

// Starting a child is the one place this file can throw rather than report, and on Windows
// it throws in two ways worth naming. A `.cmd` or `.bat` given arguments with no shell
// throws `EINVAL` synchronously, out of a constructor, where no caller is expecting it; and
// a bare name resolves only against `.com` and `.exe`, so an agent installed by npm, whose
// entry is a `.cmd` shim, is not found at all. Both are turned into a message naming the
// setting that fixes them, because "nothing happened" is the worst answer the panel can
// give somebody who pressed send.
// Why a command cannot be started, or nothing when it can. `composerview.ts` avoids this
// case where it can, by running the package script the shim points at; this is what catches
// the one it cannot. Split out from the spawn so the rule is testable on any machine rather
// than only on the one it applies to.
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

// The environment a child is started in: this window's own, then the one variable the panel
// always sets, then whatever the launch rule asked for.
//
// The Codex server is a script, and the thing that runs it is whatever was handed in. In
// the extension host that is VS Code's own binary, which behaves as Node only while
// `ELECTRON_RUN_AS_NODE` is set. It is set explicitly rather than inherited, so the
// dependency is visible and does not leak into every command the agent then runs.
//
// A launch's own variables follow identity removal, because they are what the launcher this panel is
// standing in for would have told the child. A package started through its own script never
// sees the shim that would have said where it was installed, and an agent told nothing
// about that answers questions about itself wrongly.
//
// `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_AGENT_SDK_CLIENT_APP`,
// `CLAUDE_CODE_REMOTE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, and `CLAUDE_CODE_CONTAINER_ID`
// are never inherited. An editor started from a Claude session, or one running another Claude
// client in the same window, carries these names, and the CLI reads them to label a request as
// coming from that other client, to tie it to a session running elsewhere, or to treat the
// child itself as a subagent spawned by that session: a generated title in place of one taken
// from the first typed prompt, an extra token on the outgoing request's identification, a link
// to a session this panel did not start, or a run that skips the checks and warnings a
// top-level session gets. Identity removal leaves the CLI's own defaults in effect unless
// launch variables or an explicit Claude billing label select another entrypoint.
// Windows environment names are case-insensitive, so inherited case variants are removed too.
const HOST_IDENTITY_ENV_NAMES = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CONTAINER_ID',
];

export function childEnv(
  inherited: Record<string, string | undefined>,
  wanted: Record<string, string>,
  agent?: AgentName,
  cwd?: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...inherited, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(env)) {
    if (HOST_IDENTITY_ENV_NAMES.includes(key.toUpperCase())) {
      delete env[key];
    }
  }
  Object.assign(env, wanted);
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

export const spawnCli: Spawner = (command, args, cwd, env, agent) => {
  if (process.env[MEASUREMENT_ENVIRONMENT.blockAgents] === '1')
    throw new Error('Agent connections are disabled in this measurement window.');
  const refusal = unstartable(command, process.platform);
  if (refusal) {
    throw new Error(refusal);
  }
  return nodeSpawn(command, args, {
    cwd,
    env: childEnv(process.env, env, agent, cwd),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
};

export type AgentName = 'claude' | 'codex';

// What the panel shows about a running agent. `busy` is what the interrupt affordance and
// the "still working" wording read; `asks` is what the reader has to answer before the
// turn can go on.
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

// What a session needs of whichever protocol is behind it. Both wires are wrapped to this
// shape rather than being made to share a base class: their protocols have nothing in
// common, and the session names only the operations both expose.
export interface Driver {
  contextUsage?(): Promise<unknown>;
  contextFrame?(text: string): string | null;
  contextOverflow?(id: string): void;
  receive(line: string): void;
  // Everything that has to happen before a prompt can go out, ending in the command list.
  // On the Claude side that is one handshake; on the Codex side it is a handshake, a skill
  // listing and a thread.
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
  // What the CLI itself reports about spend and context. Optional because only Claude
  // Code answers one: the Codex server volunteers the same figures as notifications
  // instead, and a method every agent had to pretend to have would hide that difference
  // rather than state it.
  usage?(): Promise<{ usage: unknown; context: unknown }>;
  // What the reader's account has left, already in the panel's vocabulary. Both agents
  // answer this one, and both answer it with no session open and no prompt ever
  // sent, so the bar that draws it costs no model tokens on either.
  rateLimits?(refreshAuthentication?: boolean): Promise<UsageReading | null>;
  // The models this agent will run, in the agent's own words. Costs no model tokens either,
  // and is asked of the same idle child the figures are asked of, because the list turns
  // over on a release rather than on a turn.
  models?(): Promise<ModelList | null>;
  appliedDefaults?(): Promise<AppliedDefaults>;
  // How much the agent asks before it acts, changed while the child is running. The two
  // mechanisms are nothing alike and the difference stays here: Claude takes a control
  // request that applies at once, and Codex takes a field on the next prompt, so this
  // returns once the change has been made or accepted rather than once it has been seen.
  setAskMode?(mode: AskMode): Promise<void>;
  // The model this session runs on, changed under a live child. Both agents take one
  // and take it differently: Claude Code as a control request that lands at once, Codex as a
  // field on the next turn, which the server reads for that turn and the ones after it.
  setModel?(model: string): Promise<void>;
  // How hard the model is asked to think, changed under a live child. Both agents take one
  // and take it differently: Codex as a field on the next turn, beside the model, and Claude
  // Code as its own `/effort` command on the stream-json input, because the control channel
  // has no subtype for a level.
  setEffort?(effort: string): Promise<void>;
  // Whether the change above costs a turn. Claude's command makes the CLI answer with a
  // `result` event, which the wire reads as an ending, so the session books an open turn for
  // it the way it does for compaction. Codex's field ends nothing of its own.
  effortStartsTurn?: boolean;
  // What this agent's MCP servers are doing, in the panel's vocabulary. Optional because an
  // agent integration may have no status request. Claude and Codex both answer, though only
  // Claude exposes the calls below that change a server.
  //
  // Asked for every time it is wanted. Claude pushes no status changes; Codex startup
  // notifications are joined to the next list reading rather than sent through this driver.
  mcpStatus?(): Promise<McpServer[] | null>;
  // Switches one server off, or back on. `enabled` says which outright rather than flipping
  // whatever state the server was found in, so a press cannot land on the opposite of what
  // the reader saw when they pressed it.
  mcpToggle?(serverName: string, enabled: boolean): Promise<void>;
  // Tries a failed server again, and fails with whatever it failed on. That sentence is the
  // only useful thing to say to somebody who just asked for another go, so it travels up
  // rather than being swallowed here.
  mcpReconnect?(serverName: string): Promise<void>;
  // Names the session through the agent's own request, which runs no model turn and is
  // answered beside a turn rather than inside it. Claude Code takes the `rename_session`
  // control request, and Codex takes `thread/name/set`.
  rename?(sessionId: string, title: string): Promise<void>;
}

// What to start, and how to talk to it once it is running.
export interface AgentPlan {
  agent: AgentName;
  // The provider session this child will resume. A fresh child has no identity until
  // its opening exchange assigns one.
  sessionId: string | null;
  command: string;
  args: string[];
  cwd: string;
  // What this agent has to be told through the environment. Added to what the child would
  // have inherited rather than replacing it.
  env: Record<string, string>;
  driver(send: (line: string) => void, emit: (event: WireEvent) => void): Driver;
}

export type AgentPlanSource = AgentPlan | (() => AgentPlan);

// What starts an agent: the program, whatever comes before the CLI's own flags, and
// whatever its own launcher would have put in the environment. The second part is empty for
// an executable and holds a script for a package that runs under Node.
// `composerview.ts` works out all three, because those rules are testable and this is not.
export interface Launch {
  command: string;
  leadingArgs: string[];
  env: Record<string, string>;
}

// The agent's own half of a mode the reader picked.
//
// A mode carries an entry for the agent whose menu it came from and none for the other, so
// a mode reaching the wrong agent is a wiring fault rather than something a reader did. It
// is refused here rather than turned into a default: a default sent in its place would put
// the child in a state nobody chose, and the panel would draw the state that was picked.
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
    env: launch.env,
    driver(send, emit) {
      // The session goes in with the child rather than being read back off it. The CLI
      // names no session until the first prompt produces output, and a panel that does not
      // know which session a child is in cannot draw it as running.
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

// How a Codex session opens. The approval policy and the sandbox travel together, here
// and everywhere else: a policy on its own says when the reader is asked and says nothing
// about what happens when nobody is, so a reader who picked full access and got a
// workspace-write sandbox was promised the machine and given a folder.
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

// Codex: one app-server child per session. The protocol allows one server to hold
// every thread, and the official extension uses it that way; a child apiece is taken here
// because a single server would need every event tagged back to its thread, and the panel
// would carry that bookkeeping for a reader who has one session open.
//
// The server is started as the package's own script under the Node already on this
// machine, rather than through the `.cmd` shim, which keeps a shell and its quoting out of
// the way on Windows.
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
          // The reader's picks then ride the turns. Effort has no other way in, and a
          // resumed thread was opened by whoever opened it, so the picks would not reach one
          // that was only asked for by id.
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

// A child started to be asked, and then closed.
//
// Both CLIs answer for the reader's rate limits and for the models they will run after
// nothing but a handshake, so neither of these opens a session: the Claude one is told
// not to persist a session, and the Codex one never starts a thread. That is the whole
// difference from the plans above, and it is why the panel can read either figure with no
// turn running and leave nothing behind on disk.
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
// child. Claude Code reports success for a rename it could not save, so a Claude rename
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
  // How long a session's opening exchange may take. Injected so a test can prove the
  // deadline is applied without waiting a real minute for it.
  openingDeadlineMs?: number;
  // The clock every session reads. Injected for the same reason as the deadline above: a
  // test can age an owed ending without waiting a real minute for it.
  now?: () => number;
  // Told about everything, so the panel can repaint. One listener, because the panel is
  // the only thing that listens and a list of them would only invite a second owner.
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

// Splits a stream into whole lines. Both CLIs write one JSON object per line, but a chunk
// off the pipe is whatever the operating system handed over: half a line, three lines, or
// a line split across two chunks. A reader that treats a chunk as a line drops messages
// the moment one gets big, and the messages that get big are exactly the interesting ones.
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

// How long the opening exchange may take before the panel gives up on it. Generous, because
// a cold CLI on a large repository reads settings, plugins and memory files before it
// answers, and a deadline that fires on a slow machine is worse than none.
export const OPENING_DEADLINE_MS = 60_000;

// How long a child being let go has to end on its own before termination is requested.
// This gives the CLI time to write its settings before a replacement waits for confirmed exit.
export const EXIT_GRACE_MS = 2_000;

// How long the ending owed by an accepted Stop stays owed. Claude answers a Stop in about a
// second, so a debt older than this is one it never paid: the reply was unreadable, or the
// child dropped it.
//
// This is the outer bound and not the rule. Which ending pays the debt is decided by the
// ending's own outcome, in `handle`. The bound exists so that a debt no ending ever claims
// cannot be claimed years later by an unrelated interrupted turn, which would leave that
// turn open and the session busy for the rest of the child's life.
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

// Unique for this extension-host process. Cleanup state is also process-local, so a
// monotonically increasing value cannot collide across live or restarted sessions.
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
  // One value, not a queue: a reader who picks twice wants the second level, and sending both
  // would cost two turns to reach it.
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
    // Injected so a test can age an owed ending without waiting a real minute for it.
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

    // The CLI's stderr is where a start-up failure explains itself: a bad executable path,
    // a session id that does not exist. Only the tail is kept, because a chatty run would
    // otherwise grow without limit for text nobody reads unless something went wrong.
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
    // A failed spawn emits `error` and then `close`, with no `exit`. Closure is terminal in
    // that sequence, while the error alone is not: a running child can report an error and
    // still own its session until either `exit` or `close` confirms termination.
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

  // The opening exchange, which has to finish before a prompt can go out. Its failure is
  // kept rather than thrown: a window that cannot reach the CLI should say so in the panel,
  // not tear down the command the reader ran. A child that failed here is closed at once.
  // It adopted no session, so keeping it would hand the next prompt to a wire that can
  // only replace the useful opening refusal with "no session has been started yet".
  async start(): Promise<void> {
    try {
      // The opening exchange gets a deadline. A child that dies is reported by its own exit
      // handler, but one that starts and then says nothing, which is what an unauthenticated
      // CLI waiting on a terminal does, would otherwise leave the reader's send button
      // waiting for ever with nothing on screen to say why.
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

  // Renames this session through its running child. Each agent answers the rename beside
  // its turns rather than inside one, so a session with a turn running renames like any
  // other, and the turn is left alone whether the rename succeeds or fails.
  //
  // The caller passes the session id it resolved. An agent refuses a rename whose session
  // id is not the one its process holds, and that refusal reaches the reader only when the
  // id comes from the host: a child that has moved to another session reads its own id back
  // as the one being asked for, and renames the session it moved to.
  async rename(sessionId: string, title: string): Promise<void> {
    if (this.exited) {
      throw new Error(this.lastError ?? 'the agent is no longer running');
    }
    if (!this.driver.rename) {
      throw new Error('This agent cannot rename the session.');
    }
    await this.driver.rename(sessionId, title);
  }

  // Sends a prompt. The turn is marked as running straight away, while the returned promise
  // waits for the CLI to accept it. The composer can move immediately and still learn when
  // a request never reached the session.
  // A child that has already gone is reported instead: the reader can have a prompt box
  // open across the moment its agent dies, and a turn shown as running on a dead child
  // never clears and cannot be interrupted.
  async prompt(prompt: AgentPromptInput, onSubmitted?: (turnId: number) => void): Promise<number> {
    if (this.exited) {
      // An opening refusal is more useful than the generic fact that its child has now been
      // closed. Preserve it so a caller that held this session cannot erase the one answer
      // the agent gave about why the prompt could not go.
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
    // A prompt sent while a pick is held waits for that pick, so the turn it starts runs at
    // the level the reader chose. Written straight away, the prompt would queue in the child
    // ahead of the command and run at the old level.
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
        this.openTurns.add(submitted);
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
        this.busy = this.preparingTurns.size > 0 || this.openTurns.size > 0;
      }
      const refusal = `the agent would not take the prompt: ${(error as Error).message}`;
      this.lastError = refusal;
      this.changed();
      // A refused prompt can leave the session with nothing running, so a pick waiting on
      // the work goes out from here too, after the publication above. The send keeps this
      // diagnostic in place.
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

  // The running and refusal state that a driver operation costing a turn shares with a
  // prompt. Compaction and a Claude effort change both end through a result the wire reads
  // as a turn ending, so each books an open turn before the send. Without that booking the
  // ending closes a turn the reader is waiting on, and the panel draws the session idle
  // while it is still working.
  //
  // A command the reader sent clears the last diagnostic, the way a prompt does. A held pick
  // going out keeps it: the pick drains right after a refusal or an `error` event, and
  // clearing there would erase the diagnostic before anything could read it.
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
        this.openTurns.add(submitted);
        this.busy = true;
        this.changed();
      }
      return submitted.id;
    } catch (error) {
      if (this.driver.hasOpenTurns) {
        this.busy = this.driver.hasOpenTurns();
      } else {
        this.preparingTurns.delete(submitted);
        this.busy = this.preparingTurns.size > 0 || this.openTurns.size > 0;
      }
      // Two readers, two sentences. `lastError` is this session's own diagnostic and names
      // the operation, because whatever reads it later has no other way to know which one
      // failed. The thrown error goes to the panel, which already says the operation did
      // not happen and needs only the cause, so it is passed on exactly as it arrived. A
      // wrapper here put four restatements of the same fact on one card and no cause at all.
      const cause = (error as Error).message;
      this.lastError = cause
        ? `the agent would not ${words.refused}: ${cause}`
        : `the agent would not ${words.refused} and gave no reason`;
      this.changed();
      // On the rule the prompt refusal follows. A held pick is never the command that
      // failed here, because a pick on its way out is cleared before the send.
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
        this.openTurns.add(submitted);
        this.busy = true;
      }
      this.changed();
      return submitted.id;
    } catch (error) {
      this.preparingTurns.delete(submitted);
      this.busy = this.driver.hasOpenTurns
        ? this.driver.hasOpenTurns()
        : this.preparingTurns.size > 0 || this.openTurns.size > 0;
      const cause = (error as Error).message;
      this.lastError = cause
        ? `the agent would not clear the session: ${cause}`
        : 'the agent would not clear the session and gave no reason';
      this.changed();
      // A refused clear can leave the session with nothing running. A pick waiting on the
      // work goes out from here too, the same rule the prompt and command refusals follow.
      // The send keeps this diagnostic in place.
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
    const stopping = this.driver.interrupt();
    if (preparing) {
      for (const turn of preparing) {
        this.preparingTurns.delete(turn);
      }
      this.busy = this.preparingTurns.size > 0 || this.openTurns.size > 0;
      this.changed();
    }
    await stopping;
    if (interrupted) {
      if (
        this.interruptedTurnEnds === 0 &&
        [...interrupted].every((turn) => this.openTurns.has(turn)) &&
        interrupted.size
      ) {
        // Claude reports one ending for the active prompt after accepting Stop, but none for
        // the queued prompts it canceled. Keep that ending away from a prompt sent afterward.
        this.interruptedTurnEnds += 1;
        this.interruptedTurnEndAt = this.now();
      }
      for (const turn of interrupted) {
        this.openTurns.delete(turn);
      }
      this.busy = this.preparingTurns.size > 0 || this.openTurns.size > 0;
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

  // What the reader's account has left. Costs no model tokens on either agent, so the
  // status bar may ask at the end of every turn.
  async rateLimits(refreshAuthentication = false): Promise<UsageReading | null> {
    return this.driver.rateLimits ? await this.driver.rateLimits(refreshAuthentication) : null;
  }

  // The models this agent will run, or nothing when the agent has no way to be asked.
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

  // How hard this session's model is asked to think, from now on.
  //
  // An agent whose change costs a turn waits for this session to go idle. Nothing has
  // sampled what a mid-turn change does, and the two plausible answers, an immediate change
  // and a message that becomes the next prompt, are both wrong for a reader watching a turn
  // run. The pick stays selected on the control until a turn records the new level. A
  // prompt sent while the pick waits goes to the child after the command, so its turn runs
  // at the picked level.
  //
  // An empty level is one the chosen model does not offer. It reaches no child, because the
  // command needs a level to name and a bare `/effort` costs a turn to ask the CLI nothing.
  // A held pick goes with it, so a model change that drops a level drops the pick waiting to
  // be sent under it.
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

  // The send behind the pick above, which books its own turn. It stands apart because the
  // drain sends a held level while the session is already marked busy on that level's
  // behalf, so it cannot go back through the waiting rule.
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

  // The pick a reader made while the session was working, sent once the session has nothing
  // left to work on. Every path that leaves a session idle calls this: a turn ending, an
  // accepted Stop, and a refused prompt or command. A Stop ends the work without ending a
  // turn, and a refusal ends it without ever starting one. The pick would otherwise read as
  // pending on the control for the life of the child.
  //
  // The session is marked busy here rather than left to the send. The callers publish their
  // own state change next, and that publication would draw the session idle for the moment
  // between the work ending and the command booking its turn.
  //
  // A prompt sent while the pick was held counts as nothing running. It waits for this send,
  // and goes to the child once the command is written, so the turn it starts runs at the
  // picked level. The command books its turn before the prompt books its own, so the
  // command's result closes the command's turn.
  //
  // The send is not awaited: the callers are the child's own line reader and its Stop, and
  // the send books its own turn and records its own failure. It keeps the last diagnostic,
  // because a refusal or an `error` event is often what left the session idle.
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
    if (this.openTurns.size > 0) {
      return true;
    }
    return [...this.preparingTurns].some((turn) => !this.promptsBehindEffort.has(turn));
  }

  // What this agent's MCP servers are doing, or nothing when the agent has no way to be
  // asked. Nothing is not the same as an empty list, and the panel draws the two
  // differently: one is an agent that cannot be asked, the other is an agent with no
  // servers configured.
  async mcpStatus(): Promise<McpServer[] | null> {
    return this.driver.mcpStatus ? await this.driver.mcpStatus() : null;
  }

  // Switches one of this agent's servers off, or back on. An agent that has no servers to
  // switch does nothing here, on the same rule as the effort level above: the panel offers
  // no such button for that agent, so a call that arrives anyway is nothing to complain to
  // the reader about.
  async mcpToggle(serverName: string, enabled: boolean): Promise<void> {
    if (this.driver.mcpToggle) {
      await this.driver.mcpToggle(serverName, enabled);
    }
  }

  // Tries one of this agent's failed servers again. Whatever the connection failed on comes
  // back up as a failure, because the reader pressed this and is owed the reason.
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
    // Killed only if closing its input did not end it.
    //
    // The CLI writes settings out as it shuts down, and a kill in the same tick takes that
    // away. A real two-child check found that a server switched off in one child was back on
    // in the next when the first was killed outright, and stayed off when it was allowed to
    // exit. So whether a reader's press on the servers switch lasted came down to how the
    // panel ended a process they never saw.
    //
    // A replacement waits on this promise so two children cannot write the same session.
    // Other callers can ignore it because the session state finished above.
    this.disposePromise = new Promise<void>((resolve) => {
      const stop = setTimeout(() => {
        try {
          this.child.kill();
        } catch {
          /* it ended on its own, which is the point */
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
    // A chunk of the reply is reported and nothing else. It says nothing about the child
    // that is not already known: it is no busier, it has asked nothing and it has not
    // failed. Everything below wakes the status bar, the stored session id and a repaint,
    // and this arrives many times a second, so a turn's worth of them would run that work
    // hundreds of times to say what the first one said.
    if (event.kind === 'delta' || event.kind === 'activity') {
      this.report(event, endedTurnId);
      return;
    }
    // The command list, taken off the event rather than waited for.
    //
    // `ready` is emitted from inside the opening handshake, so the assignment in `start`,
    // which records what that handshake returned, runs after every listener has already had
    // the event. Recorded only there, the session answers with an empty list for the whole of
    // the moment anything is listening to the one message that says a list exists. The
    // composer was handed nothing on every start, and its command menu never opened.
    //
    // `start` keeps its own assignment. A driver is free to answer `open` with a list and
    // emit nothing, and that one is still the session's.
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
    // An answer that outlived its turn settles with `askResolved` once it is sent, or with
    // the ask offered again when it could not be. A late answer goes out as a new prompt the
    // wire starts on its own, so the session reads the open turns from the wire here.
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
        // The ending the Stop owes is an abandoned turn's, and the CLI says so: a
        // control-channel interrupt ends the turn with `aborted_streaming`, which the wire
        // reads as `interrupted`. A prompt sent after the Stop ends with `ok` instead. So the
        // debt is paid by the ending that carries the Stop's own word, whatever order the two
        // arrive in, and a turn the reader is waiting on is never charged for it.
        this.interruptedTurnEnds -= 1;
        this.busy = this.preparingTurns.size > 0 || this.openTurns.size > 0;
      } else {
        // A debt older than the grace is one the Stop never produced. Drop it. It is dropped
        // only on age, because an ending that is not the Stop's proves nothing about whether
        // the Stop's is still coming, and a debt cleared early charges a later turn's ending
        // to nothing and leaves that turn open for the life of the child.
        if (this.now() - this.interruptedTurnEndAt > STOP_ENDING_GRACE_MS) {
          this.interruptedTurnEnds = 0;
        }
        const first = this.openTurns.values().next().value;
        if (first) {
          endedTurnId = first.id;
          this.openTurns.delete(first);
        }
        this.busy = this.preparingTurns.size > 0 || this.openTurns.size > 0;
      }
      // A turn cannot end with a request still open: the CLI has stopped waiting for the
      // answer. Left behind, the request card would remain in the panel, and answering it
      // would write a reply for a request the agent has already abandoned. An ask the driver
      // says outlives its turn has no such request behind it, and it stays.
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

// The MCP servers one idle child reports, for a reader who asked for them outright.
//
// Kept apart from `askIdle` because the wait is different in kind. That one runs when the
// panel comes into view and nobody asked for anything, so it must be quick; this one runs
// because the reader typed the agent's own `/mcp`, and a reader who asked a question will
// wait for its answer. The CLI answers only once it has tried every server, and a server that
// is down is one it waits out.
//
// Null for an agent that could not be started, and for one whose CLI answers no such request.
// Neither is the same as an agent with no servers, which answers with an empty list.
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

// One short-lived child, told to change some servers and then asked what the servers are now.
//
// This exists because the reader can press the switch with no session running. The panel
// counts the servers as it comes into view, so the control is on the row long before the first
// prompt, and a press that answered "start a session first" would be a control that draws
// itself and then refuses.
//
// The change outlives this child because the CLI writes it out as it shuts down, which is why
// `dispose` lets a child go rather than killing it. A real two-child check confirmed that the
// second child reads the setting written by the first.
//
// The reading and the trouble come back together rather than one of them being thrown,
// because both are owed to the reader. A server that would not answer is the reason their
// press did nothing, and the reading beside it is what every other server did instead.
export interface McpChangeResult {
  // What the servers are now, or null where the reading could not be taken.
  servers: McpServer[] | null;
  // One line per server that refused, empty where all of them answered.
  failures: string[];
  // Why nothing could be changed at all, or empty where a child came up.
  //
  // Held apart from `failures`, which name servers. This one names the agent, and the two
  // read differently to somebody who pressed a switch: one says which server would not
  // answer, and the other says that nothing was asked. Reported either way, because the
  // silent version of this is the one outcome a press must never have.
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
    // Gathered rather than thrown at the first one, the same way the live path gathers them.
    // One press stands for several servers, and a server that will not come back must not
    // take with it the ones that would.
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
    // Awaited, unlike everywhere else this is called. The change is only written as the child
    // shuts down, so returning while it is still going lets the reader's next prompt start a
    // session that reads the state they just changed away from.
    await session.dispose();
  }
}

// Everything one idle child was asked for in the exchange it was started for.
export interface IdleAnswers {
  usage: UsageReading | null;
  usageFailure: string;
  models: ModelList | null;
  // The agent's slash commands, which the opening handshake answers with whether or not
  // anybody asked. They come back with the rest because this child is the only one a panel
  // that has sent no prompt ever starts: a session child is started by the first prompt,
  // so a list gathered only from those is a list the composer cannot have until after the
  // reader has typed a prompt without the menu they wanted it for.
  //
  // Empty for an agent that publishes none, and for one that could not be reached.
  commands: PromptEntry[];
  // The MCP servers the agent can call tools on, for the same reason the commands ride here.
  // The control that draws them is on the composer, and the reader reaches it by typing the
  // agent's own `/mcp`; read only from session children, that control could not exist
  // until after a prompt had been sent.
  //
  // Null for an agent whose CLI answers no such request, which is not the same as an agent
  // with no servers: one cannot be asked and the other answered with none.
}

// Asks an agent what the reader's account has left and what models it will run, with no
// session opened and no prompt sent, and closes the child again.
//
// This is the read for a panel nobody is running a turn for. It is deliberately not a
// session on the host: a child adopted as a session would be resumed by the next
// prompt, and the reader would find themselves talking to the child that was started to
// read a percentage.
//
// Both questions ride one child because neither costs model tokens but the child itself
// costs a process start, and a second child for the second question would double the only
// price there is. Neither question can sink the other: a CLI old enough to refuse one of
// them still answers the other, and an answer thrown away because its neighbour failed is
// a process start paid for nothing.
//
// A child that will not start leaves the panel showing what it already had rather than
// emptying it. The figures it holds are old, which they say; no figures at all would say
// the reader has no limits.
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
    // Read before the two requests rather than after, because it costs nothing and it is
    // already true: the handshake that `start` just finished is what answered with it.
    const commands = session.state().commands;
    // The MCP servers are deliberately not asked for here.
    //
    // The other three cost a round trip each and answer at once. `mcp_status` does not: the
    // CLI answers it only once it has tried every server, and a server that is down is a
    // server the CLI waits out. One measured in this repository timed out after 30 seconds.
    // Asked here, that wait would sit in front of the figures the status bar is opening to
    // draw, so a panel with one broken server would come up empty for half a minute.
    //
    // They are read from a child that is already running instead, which is where a wait costs
    // the reader nothing they were waiting on anyway.
    // All three ride the one child, because the process start is the only price any of them
    // has. None can sink the others: a CLI old enough to refuse one still answers the rest,
    // and an answer thrown away because its neighbour failed is a process start paid for
    // nothing.
    // The MCP servers are deliberately not asked for here. The CLI answers `mcp_status` only
    // once it has tried every server, and a server that is down is one it waits out: one
    // measured in this repository timed out after 30 seconds. Asked on this child, that wait
    // would sit in front of the figures the status bar opened to draw. A reader who types the
    // agent's own `/mcp` pays it instead, because they asked.
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

// How long a model list is kept before it is worth asking again.
//
// Far longer than a usage figure, because the two answer different questions. A rate limit
// moves with every turn the reader runs; a model list turns over when the CLI is updated.
// Half a day means a reader who works through one pays a single read, and an update
// installed over lunch is on offer by the evening.
export const MODELS_FRESH_MS = 12 * 60 * 60 * 1000;

// The model list each agent last answered with. Shaped like `UsageBook`, and for the same
// reasons: reading costs no model tokens but does cost a process start, and an agent that
// cannot answer must not be asked again every time the panel comes back into view.
export class ModelBook {
  private readonly byAgent = new Map<string, ModelList>();
  // The agents that could not answer. A machine with only one of the two CLIs installed
  // would otherwise pay a failed process start for the other every time a picker opened.
  // Cleared when the reader asks outright, because that is somebody saying to try again.
  private readonly silent = new Set<string>();

  note(agent: string, list: ModelList): void {
    this.byAgent.set(agent, list);
    this.silent.delete(agent);
  }

  // An agent that was asked and did not answer. Whatever list it has already given stays:
  // an old list still names models the CLI will run, and an empty picker names none.
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

  // Which of the agents to actually ask. A list still inside its window is left alone, an
  // agent that has already failed to answer is not asked again, and the reader asking
  // outright overrides both, exactly as the usage figures work.
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

// The MCP servers each draft or recorded session last reported, in the shape the panel draws from.
//
// Modelled on `ModelBook` above and deliberately without its clock. A model list is kept
// for half a day because it turns over when the CLI is updated, and a list read this
// morning still names the models the CLI will run this afternoon. A server list is nothing
// like that: it turns over the moment a server falls down, and a reading held back as
// still fresh is exactly the reading that is now wrong. There is no freshness window or
// freshness-based `toAsk`. The book keeps whatever the agent last said. It reads again after
// every toggle and reconnect, which are the moments the answer can have changed.
//
// Initial idle reads have a separate gate. A missing answer reopens that gate, so the next
// view can retry a server that held the first request open. A child that cannot start closes
// the gate because retrying it on every view would pay for the same launch failure each time.
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

  // Nothing for an agent nobody has read, which is not the same answer as an empty list. An
  // empty list is an agent that was asked and has no servers; nothing is a question that has
  // not been put yet, and the panel says so rather than claiming the agent has none.
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

// The model to actually start a child with: the reader's own pick, unless the agent's list
// says it has gone. A pick outlives an update, and a child started on a model the CLI no
// longer has does not run at all.
//
// An agent whose list has not been read yet is trusted with whatever was stored. The pick
// was true when it was made, and dropping it because nothing has answered yet would quietly
// move the reader onto a default they never chose.
export function pickedModel(picked: string, list: ModelList | null): string {
  if (!picked || !list) {
    return picked;
  }
  return chosenModel(list.models, picked) ? picked : '';
}

// The effort to run that model at, on the same rule. Effort belongs to a model rather than
// to an agent, so a level the picked model does not offer is dropped rather than carried
// onto it.
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
  // Whether the live child hears the surviving level. It is told only when the level
  // changed, which is only ever a drop, because a level the new model offers is the level
  // the child is already running at.
  tellChild: boolean;
  // The fields the session stores. A field left out keeps the standing it had.
  settings: Partial<SessionSettingSelection>;
}

// The whole of what a model change decides, for one session on one agent.
//
// The level belongs to the model, so `pickedEffort` names the level that survives. A level
// the new model does not offer is dropped, and the drop still reaches a live child, which
// throws away a pick waiting to go out under the old level. The child keeps running at the
// last level it heard, because the CLI's command needs a level to name and the new model
// has no name for the old one.
//
// A Claude model reaches a live child on the control channel and is confirmed there, so it
// is stored outright. Codex applies the model to the next turn, and so does a session with
// no child yet, so both leave the model pending until a turn records it. A surviving level
// moved nothing and keeps whatever standing it had, and a dropped level has nothing left
// for a turn to record.
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

// Every session this window drives. A window owns the children it spawned and no
// others: a second window looking at the same folder reads those turns through the
// transcript on disk, the way it already reads turns from a terminal session.
export class AgentHost {
  private readonly sessions = new Map<string, AgentSession>();
  // The opening exchange of each session that is still in it. A second caller for the same
  // key waits on the same promise rather than being handed a session whose handshake has
  // not finished, which on the Codex side would be one with no session to prompt.
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

  // The session under `key`, started if this window has not started it yet. A plan
  // carrying a resume id is what takes a session across a window reload: the child is
  // gone, but the transcript on disk is not, and both CLIs pick one up by id.
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

  // Renames a session through its running child, or through a rename-only child when none
  // runs. An opening, a retiring writer, or another rename of the same session settles
  // first, so a rename-only child is never a second writer on the transcript.
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

  // Holds the session's rename slot for one rename, live child or rename-only child alike.
  // The wait above reads that slot, so a second rename of the same session starts only once
  // this one settles. Two renames that ran together would both read the same transcript end
  // and the session would keep whichever record the agent wrote last.
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

  // Every ask waiting on the reader, across sessions, so one command can offer all of
  // them without the reader first having to work out which agent is blocked.
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

// Existing sessions have a stable key because reopening them must find the same child.
// Fresh drafts instead carry their provisional id in the key, so two New actions can never
// share a process before either one has an actual session id.
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
