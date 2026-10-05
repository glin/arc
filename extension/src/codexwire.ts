import { unavailableDefaults, type AppliedDefaults } from './view/model-picks';
// The client half of the Codex app-server protocol.
//
// `codex app-server` speaks JSON-RPC 2.0 over stdio, one object per line, with the
// `jsonrpc` field left off the wire. It is what the official Codex editor extension runs
// on, and it is marked experimental, so everything below was read off a running server
// rather than from a document.
//
// Three kinds of object arrive, and telling them apart is the one thing a client must get
// right: a **response** carries `id` and no `method`, a **notification** carries `method`
// and no `id`, and a **server request** carries both. Approvals are server requests. A
// client that routes on `method` alone treats an approval as a notification and never
// answers it, and the turn then waits for ever on a reader who was never asked.
//
// The events this file produces are the same ones `claudewire.ts` produces, so the panel
// reads one vocabulary and never learns which agent is behind a session.

import {
  Ask,
  AskAnswer,
  AskQuestionAnswer,
  Question,
  QuestionAsk,
  QuestionOption,
  RateLimit,
  TurnOutcome,
  UsageReading,
  WireActivity,
  WireEvent,
  PromptEntry,
  EffortChoice,
  McpServer,
  ModelChoice,
  ModelList,
  Json,
  obj,
  str,
  num,
  arr,
  AgentPromptInput,
  CodexEffectiveMode,
  normalizeAgentPrompt,
} from './agentwire';
import {
  QuestionReply,
  asyncQuestionId,
  asyncQuestionItem,
  buildQuestionReply,
  parseQuestionReply,
} from './codexreply';

// What the server asks about before doing it. `untrusted` asks about nearly everything,
// `on-request` lets the model decide when to ask, `never` asks about nothing.
//
// The values are the ones `codex app-server generate-json-schema` publishes, and neither
// CLI publishes words for any of them, so the labels the panel draws are a copy written
// alongside and re-read on a version bump. The schema's fourth approval value is a
// `granular` object rather than a name, and the panel draws no surface for it, so it is not
// here: a value in this union is one the reader can actually be offered.
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

// Who receives an approval request after the policy decides that it may surface. Automatic
// review lets Codex assess eligible requests and sends only potentially unsafe actions to
// the reader. The server defaults to `user`, which would make "Approve for me" ask anyway.
export type ApprovalsReviewer = 'user' | 'auto_review';

// How much the server may do without asking. It is the other half of one choice: an
// approval policy on its own says when the reader is asked, and says nothing about what
// happens when nobody is. A reader who picked full access and got a workspace-write sandbox
// was told one thing and given another, which is why the two always travel together.
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

// The same sandbox choice under the two spellings the server takes. `thread/start` reads a
// `sandbox` field holding the mode's own name; `turn/start` reads a `sandboxPolicy` field
// holding an object tagged by a camelCase `type`. A turn handed the thread spelling is
// accepted and its sandbox left exactly as it was, with nothing said, so the object form
// below is the one `turn/start` reads and the string above is the one `thread/start` reads.
//
// The table is keyed by the mode union, so a mode added without a policy beside it is a
// compile error rather than a turn that silently keeps the old sandbox. The policies also
// take a network-access flag and a list of writable roots; the panel offers no surface for
// either, so both are left off and the server applies its own defaults.
const SANDBOX_POLICY_TYPES: Record<SandboxMode, string> = {
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess',
};

export function sandboxPolicy(mode: SandboxMode): Json {
  return { type: SANDBOX_POLICY_TYPES[mode] };
}

export interface CodexSpawnOptions {
  cwd: string;
  model?: string;
  // How hard the model is asked to think, in whichever word the model advertised through
  // `model/list`. It reaches the server on a turn rather than here: `thread/start` has no
  // effort field at all.
  effort?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
}

// The subcommand the server runs under. The `.cmd` shim in the npm folder is not needed:
// the package's own entry point runs under the Node already on this machine, which avoids
// a shell and the quoting a shell would bring with it on Windows.
export function appServerArgs(): string[] {
  return ['app-server'];
}

// What a client tells the server about itself. The name is echoed back inside the user
// agent the server reports, so it is what identifies this panel in OpenAI's logs.
export interface ClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface CodexWireOptions {
  send(line: string): void;
  emit(event: WireEvent): void;
  clientInfo: ClientInfo;
  cwd: string;
  // How long a request is waited on. Overridden in tests, which cannot wait a minute to
  // prove that the wait ends.
  deadlineMs?: number;
}

const CODEX_COMMANDS: readonly PromptEntry[] = [
  { kind: 'command', name: 'compact', description: 'Compact the session', argumentHint: '' },
  { kind: 'command', name: 'clear', description: 'Start a new session', argumentHint: '' },
  { kind: 'command', name: 'new', description: 'Start and name a new session', argumentHint: '[name]' },
  { kind: 'command', name: 'rename', description: 'Rename the session', argumentHint: '<name>' },
];

// The server answered a request with an error, so the request had no effect.
class RequestRefused extends Error {}

// The server did not answer a request before the deadline. The request can still have
// taken effect.
class NoAnswer extends Error {}

// Where the answer to an async question goes: the thread it was asked on, and the turn
// that asked it while that turn still runs. `turnId` is null once the turn has ended. `ask`
// holds only the questions no client has answered yet.
interface AsyncAsk {
  threadId: string | null;
  turnId: string | null;
  ask: QuestionAsk;
}

interface Waiting {
  resolve(value: Json): void;
  reject(error: Error): void;
  // Cleared wherever the entry leaves the map, so a settled request leaves no timer behind.
  timer: ReturnType<typeof setTimeout> | null;
}

interface ActiveTurn {
  threadId: string;
  id: string | null;
  start: Promise<string>;
  // A very short turn can finish while the response that accepted it is queued for its
  // promise continuation. Keep the outcomes until the response identifies which turn began.
  endingsBeforeStart: Map<string, { outcome: TurnOutcome; emitted: boolean }>;
}

interface PendingCompaction {
  threadId: string;
  turnId: string | null;
  started: Promise<string>;
  resolveStarted(turnId: string): void;
  rejectStarted(error: Error): void;
  finished: Promise<void>;
  resolveFinished(): void;
  rejectFinished(error: Error): void;
}

interface McpStartup {
  status: string;
  error: string;
}

// How long one request is waited on before it is given up as unanswered. The same clock the
// Claude wire keeps, for the same reason: the panel holds one read per agent and joins every
// later read to it, so a request that goes quiet stops that agent being asked again for the
// life of the window, and leaks the child that was started to answer it.
//
// A turn is unaffected. A turn is a stream of events rather than a request.
export const CODEX_DEADLINE_MS = 60_000;

// The verdicts the server takes on an approval. The panel sends two of them today, because
// it offers the reader two choices. `acceptForSession` is the one to reach for when a
// "always in this session" choice is added: it is the server's own idea of a standing
// grant, so a reader who picks it is not relying on the panel to hold state a reload would
// lose. `cancel` means the reader wants the turn stopped rather than this call refused.
export type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

// The server requests this client answers, and the shape each answer takes. They do not
// share one: a command or a file change takes a verdict, and a user-input request takes a
// map of answers. Sending a verdict to the wrong one is not a protocol error the server
// reports, so the routing is on the method rather than on one shape for all of them.
//
// The full server-request set has ten methods, generated by `codex app-server generate-ts`
// into `ServerRequest.ts`. The rest are refused rather than answered, and two of those are
// worth naming. `item/permissions/requestApproval` answers with a whole granted-permission
// profile and a scope, not a decision, so a verdict sent to it would grant something nobody
// asked for; it needs its own card before it can be answered at all.
// `mcpServer/elicitation/request` is an MCP server asking the reader for input, which this
// panel has no surface for yet.
const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
const FILE_APPROVAL = 'item/fileChange/requestApproval';
const USER_INPUT = 'item/tool/requestUserInput';
const ANSWERABLE = new Set([COMMAND_APPROVAL, FILE_APPROVAL, USER_INPUT]);

function itemText(item: Json): string {
  const direct = str(item.text);
  if (direct) {
    return direct;
  }
  return arr(item.content)
    .map((entry) => str(obj(entry)?.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

function reasoningSummary(item: Json): string {
  const direct = str(item.summaryText) ?? str(item.summary_text) ?? str(item.summary);
  if (direct) {
    return direct;
  }
  const value = item.summary ?? item.summary_text;
  return arr(value)
    .map((entry) => (typeof entry === 'string' ? entry : (str(obj(entry)?.text) ?? '')))
    .filter(Boolean)
    .join('\n');
}

function completedStatus(item: Json): WireActivity['status'] {
  const status = (str(item.status) ?? '').toLowerCase();
  if (status === 'failed' || status === 'error') {
    return 'failed';
  }
  if (status === 'interrupted' || status === 'aborted' || status === 'cancelled' || status === 'canceled') {
    return 'interrupted';
  }
  const exit = num(item.exitCode) ?? num(item.exit_code);
  return exit !== null && exit !== 0 ? 'failed' : 'done';
}

function collaborationHeadline(tool: string, running: boolean): string {
  switch (tool) {
    case 'wait':
      return running ? 'Waiting for subagents' : 'Waited for subagents';
    case 'spawn_agent':
      return running ? 'Starting a subagent' : 'Started a subagent';
    case 'send_message':
      return running ? 'Messaging a subagent' : 'Messaged a subagent';
    default:
      return running ? 'Coordinating subagents' : 'Coordinated subagents';
  }
}

function fileChangePaths(item: Json | null): string[] {
  if (!item) {
    return [];
  }
  const paths: string[] = [];
  const direct = str(item.path) ?? str(item.filePath);
  if (direct) {
    paths.push(direct);
  }
  if (Array.isArray(item.changes)) {
    for (const change of item.changes) {
      const path = str(obj(change)?.path);
      if (path) {
        paths.push(path);
      }
    }
  } else {
    const changes = obj(item.changes);
    if (changes) {
      paths.push(...Object.keys(changes));
    }
  }
  return [...new Set(paths)];
}

function codexItemActivity(item: Json, status: WireActivity['status']): WireActivity | null {
  const sourceId = str(item.id);
  const type = str(item.type);
  if (!sourceId || !type) {
    return null;
  }
  const running = status === 'running';
  if (type === 'commandExecution') {
    return {
      sourceId,
      kind: 'tool',
      name: 'Shell',
      headline: running ? 'Running' : 'Ran',
      detail: str(item.command) ?? '',
      status,
    };
  }
  if (type === 'fileChange') {
    return {
      sourceId,
      kind: 'tool',
      name: 'Edit',
      headline: running ? 'Editing' : 'Edited',
      detail: fileChangePaths(item).join('\n'),
      status,
    };
  }
  if (type === 'plan' || type === 'planUpdate') {
    return {
      sourceId,
      kind: 'plan',
      name: 'Plan',
      headline: running ? 'Updating plan' : 'Updated plan',
      detail: str(item.text) ?? str(item.plan) ?? str(item.explanation) ?? '',
      status,
    };
  }
  if (type === 'collabAgentToolCall') {
    const tool = str(item.tool) ?? '';
    const receivers = arr(item.receiverThreadIds ?? item.receiver_thread_ids)
      .map((entry) => str(entry) ?? '')
      .filter(Boolean)
      .join(', ');
    return {
      sourceId,
      kind: 'collaboration',
      name: tool || 'Collaboration',
      headline: collaborationHeadline(tool, running),
      detail: receivers,
      status,
    };
  }
  return null;
}

// The reply envelope for the async questions the reader answered, one entry per question,
// with the picked labels and any written answer joined into one answer. Empty when the
// reader answered none of them.
function asyncReply(questions: { id: string; question: string }[], answers: Record<string, AskQuestionAnswer>): string {
  const replies: QuestionReply[] = [];
  for (const { id: questionItemId, question } of questions) {
    const given = answers[questionItemId];
    const answer = given ? [...given.labels, given.written].filter(Boolean).join(', ') : '';
    if (answer) {
      replies.push({ questionItemId, question, answer });
    }
  }
  return replies.length ? buildQuestionReply(replies) : '';
}

export class CodexWire {
  private readonly send: (line: string) => void;
  private readonly emit: (event: WireEvent) => void;
  private readonly clientInfo: ClientInfo;
  private readonly cwd: string;
  private readonly deadlineMs: number;
  private readonly waiting = new Map<number, Waiting>();
  // Which server request each pending ask came in on. The answer goes back on that id, in
  // the server's own id space, which is separate from the ids this client hands out.
  private readonly askIds = new Map<string, { requestId: number; method: string }>();
  // An async question ask is built from a notification, not a server request, so it never
  // gets an `askIds` entry. No request waits for its answer, so the answer goes into the
  // thread as new input.
  private readonly asyncAsks = new Map<string, AsyncAsk>();
  private readonly activeItems = new Map<
    string,
    { type: string; phase: string; delivery: string; questions: Json[] | null; item: Json }
  >();
  private readonly approvalRequests = new Map<string, { method: string; params: Json }>();
  private readonly activityText = new Map<string, string>();
  private nextId = 0;
  private closed = false;
  private thread: string | null = null;
  // The mode Codex resolved from command-line flags, project configuration, user
  // configuration, and folder trust. This is separate from `approval`, which exists only
  // after the reader picks an override that must ride a later turn.
  private effectiveMode: CodexEffectiveMode | null = null;
  // Starts stay in send order. Codex can accept another prompt into the turn already in
  // progress, so starts that return the same id are folded into one server turn.
  private readonly turns: ActiveTurn[] = [];
  // The compaction request only acknowledges that work started. Its turn id and terminal
  // result arrive later as notifications, so the operation stays here until that result.
  private compaction: PendingCompaction | null = null;
  // How much the server asks before it acts, who reviews the asks, and how much it may do
  // unasked, when the reader has changed them since the thread started. `turn/start` takes
  // these "for this turn and subsequent turns", so they ride the send rather than needing
  // a call of their own. Nothing is sent until the reader has actually chosen, so a thread
  // keeps whatever it was started with. They are held as one because the reader picks them
  // as one.
  private approval: {
    policy: ApprovalPolicy;
    reviewer: ApprovalsReviewer;
    sandbox: SandboxMode;
  } | null = null;
  // Which model the turns on this thread run, and how hard it is asked to think. Both ride
  // `turn/start`, which overrides them "for this turn and subsequent turns", and for effort
  // that is the only door: `thread/start` settles a model and takes no effort at all.
  // Nothing goes out until the reader has picked, so a thread keeps what it opened with.
  private model: string | null = null;
  private effort: string | null = null;
  // The list response carries inventory and auth, while startup state arrives beside it as
  // notifications. Kept by server name so one reading can join the two halves.
  private readonly mcpStartup = new Map<string, McpStartup>();
  private commandsOpening = false;
  private commandsOpened = false;
  private skillRefresh: Promise<void> | null = null;
  private skillRefreshAgain = false;

  constructor(options: CodexWireOptions) {
    this.send = options.send;
    this.emit = options.emit;
    this.clientInfo = options.clientInfo;
    this.cwd = options.cwd;
    this.deadlineMs = options.deadlineMs ?? CODEX_DEADLINE_MS;
  }

  threadId(): string | null {
    return this.thread;
  }

  hasOpenTurns(): boolean {
    return this.turns.length > 0 || this.compaction !== null;
  }

  // The handshake. The server rejects everything sent before it, and the `initialized`
  // notification after it is what opens the rest of the surface.
  private defaultsQualified = false;

  async initialize(): Promise<Json> {
    const result = await this.request('initialize', {
      clientInfo: this.clientInfo,
      // The recovery fork uses `excludeTurns` so the server returns only the new id, and
      // app-server rejects that field unless the client opted into experimental fields.
      capabilities: { experimentalApi: true },
    });
    this.defaultsQualified = /\/0\.(?:159\.2|160\.0)(?:\s|$)/.test(str(result.userAgent) ?? '');
    this.notify('initialized', {});
    return result;
  }

  // Codex does not publish its native slash commands. Keep the ones the panel runs itself, then
  // add the skills Codex can enumerate for this working directory.
  async commands(): Promise<PromptEntry[]> {
    this.commandsOpening = true;
    try {
      const commands = await this.commandCatalog(false);
      this.emit({ kind: 'ready', commands });
      return commands;
    } catch {
      const commands = CODEX_COMMANDS.map((command) => ({ ...command }));
      this.emit({ kind: 'ready', commands });
      return commands;
    } finally {
      this.commandsOpening = false;
      this.commandsOpened = true;
      if (this.skillRefreshAgain && !this.closed) {
        this.skillRefreshAgain = false;
        this.refreshCommandCatalog();
      }
    }
  }

  private async commandCatalog(forceReload: boolean): Promise<PromptEntry[]> {
    const commands = CODEX_COMMANDS.map((command) => ({ ...command }));
    const result = await this.request('skills/list', {
      cwds: [this.cwd],
      ...(forceReload ? { forceReload: true } : {}),
    });
    const names = new Set(commands.map((command) => command.name.toLowerCase()));
    for (const group of arr(result.data)) {
      for (const entry of arr(obj(group)?.skills)) {
        const skill = obj(entry);
        const name = skill && str(skill.name);
        if (name && !names.has(name.toLowerCase())) {
          commands.push({
            kind: 'skill',
            name,
            description: (skill && str(skill.description)) ?? '',
            argumentHint: '',
            path: str(skill.path) ?? undefined,
          });
          names.add(name.toLowerCase());
        }
      }
    }
    return commands;
  }

  private refreshCommandCatalog(): void {
    if (this.closed) {
      return;
    }
    if (!this.commandsOpened || this.commandsOpening || this.skillRefresh) {
      this.skillRefreshAgain = true;
      return;
    }
    const refresh = async () => {
      do {
        this.skillRefreshAgain = false;
        try {
          const commands = await this.commandCatalog(true);
          if (!this.closed) {
            this.emit({ kind: 'commands', commands });
          }
        } catch {
          // The last complete catalog stays active until a later notification can replace it.
        }
      } while (this.skillRefreshAgain && !this.closed);
    };
    const pending = refresh().finally(() => {
      if (this.skillRefresh === pending) {
        this.skillRefresh = null;
      }
    });
    this.skillRefresh = pending;
  }

  async startThread(options: CodexSpawnOptions, name: string = ''): Promise<string> {
    const result = await this.request('thread/start', {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    });
    const threadId = this.adoptThread(result);
    if (name) {
      try {
        await this.renameThread(threadId, name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.emit({
          kind: 'error',
          message: `the new session opened, but its name was not saved${reason ? `: ${reason}` : ''}`,
        });
      }
    }
    return threadId;
  }

  async resumeThread(
    threadId: string,
    options?: Pick<CodexSpawnOptions, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'>,
  ): Promise<string> {
    return this.adoptThread(
      await this.request('thread/resume', {
        threadId,
        ...(options?.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options?.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
        ...(options?.sandbox ? { sandbox: options.sandbox } : {}),
      }),
    );
  }

  // A session another client still owns cannot be resumed by this app-server process.
  // Forking continues from what that client has saved without taking its writer lock.
  async forkThread(threadId: string, options: CodexSpawnOptions): Promise<string> {
    return this.adoptThread(
      await this.request('thread/fork', {
        threadId,
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
        ...(options.sandbox ? { sandbox: options.sandbox } : {}),
        // An inherited goal belongs to the source client until the reader sends this fork its
        // first prompt. Without this, opening the recovery session can start work by itself.
        deferGoalContinuation: true,
        // The caller needs the new id, not a second copy of the inherited turns in the response.
        excludeTurns: true,
      }),
    );
  }

  // Compaction starts through a thread control, not a text prompt. The empty response only
  // acknowledges the request; the server then reports a regular turn lifecycle for the
  // work. Keep the promise open for that lifecycle so the session remains busy and a later
  // failure reaches the reader.
  async compact(): Promise<void> {
    if (!this.thread) {
      throw new Error('no Codex session has been started yet');
    }
    if (this.hasOpenTurns()) {
      throw new Error('the session already has a turn running');
    }
    const pending = this.pendingCompaction(this.thread);
    this.compaction = pending;
    try {
      await this.request('thread/compact/start', { threadId: this.thread });
      await pending.finished;
    } catch (error) {
      if (this.compaction === pending) {
        this.failCompaction(pending, error as Error);
      }
      throw error;
    }
  }

  // Sends a prompt. The call returns as soon as the server has accepted the turn; the turn
  // itself plays out as notifications, which is why nothing here waits for it.
  async prompt(input: AgentPromptInput): Promise<string> {
    if (!this.thread) {
      throw new Error('no Codex session has been started yet');
    }
    const threadId = this.thread;
    const prompt = normalizeAgentPrompt(input);
    const content: Record<string, unknown>[] = [];
    if (prompt.text) {
      content.push({ type: 'text', text: prompt.text });
    }
    for (const asset of prompt.assets) {
      content.push(
        asset.mime.startsWith('image/')
          ? { type: 'localImage', path: asset.path }
          : { type: 'mention', name: asset.name, path: asset.path },
      );
    }
    if (!content.length) {
      throw new Error('the prompt has no text or attachments');
    }
    const response = this.request('turn/start', {
      threadId,
      input: content,
      ...(this.approval
        ? {
            approvalPolicy: this.approval.policy,
            approvalsReviewer: this.approval.reviewer,
            sandboxPolicy: sandboxPolicy(this.approval.sandbox),
          }
        : {}),
      ...(this.model !== null ? { model: this.model } : {}),
      ...(this.effort !== null ? { effort: this.effort } : {}),
    });
    let active: ActiveTurn;
    const start = response.then((result) => {
      const turn = obj(result.turn);
      const turnId = turn && str(turn.id);
      if (!turnId) {
        throw new Error('the agent accepted a turn without naming it');
      }
      active.id = turnId;
      const ending = active.endingsBeforeStart.get(turnId);
      active.endingsBeforeStart.clear();
      if (ending) {
        this.forgetTurn(active);
        if (!ending.emitted) {
          this.markEndingEmitted(threadId, turnId);
          this.emit({ kind: 'turnEnd', outcome: ending.outcome, nativeTurnId: turnId });
        }
      } else {
        const sameTurn = this.turns.find((turn) => turn !== active && turn.id === turnId && turn.threadId === threadId);
        if (sameTurn) {
          const keep = this.turns.indexOf(sameTurn) < this.turns.indexOf(active) ? sameTurn : active;
          this.forgetTurn(keep === active ? sameTurn : active);
        }
      }
      return turnId;
    });
    active = { threadId, id: null, start, endingsBeforeStart: new Map() };
    this.turns.push(active);
    try {
      return await start;
    } catch (error) {
      this.forgetTurn(active);
      throw error;
    }
  }

  // How much the server asks before it acts, who reviews an ask, and how much its sandbox
  // allows, from here on. They go out with the next prompt rather than at once, which is the
  // whole mechanism on this agent: the server has no call that changes them on a live thread.
  async setApproval(policy: ApprovalPolicy, sandbox: SandboxMode, reviewer: ApprovalsReviewer): Promise<void> {
    this.approval = { policy, reviewer, sandbox };
  }

  // Which model this session runs, and how hard it is asked to think, from here on.
  // Both go out with the next prompt for the same reason the approval does: `turn/start` is
  // where the server takes them, and it has no call of its own on a live thread. An empty
  // pick is no pick, so the turn carries nothing and the thread keeps what it has.
  async setModel(model: string): Promise<void> {
    this.model = model || null;
  }

  async setEffort(effort: string): Promise<void> {
    this.effort = effort || null;
  }

  async interrupt(): Promise<void> {
    while (this.turns.length) {
      const active = this.turns[0];
      let turnId: string;
      try {
        turnId = active.id ?? (await active.start);
      } catch {
        // A later prompt can already have been accepted when the oldest start is refused.
        // Remove the refused entry and continue to the next server turn.
        this.forgetTurn(active);
        continue;
      }
      if (this.turns[0] !== active || active.id !== turnId) {
        continue;
      }
      await this.request('turn/interrupt', { threadId: active.threadId, turnId });
      return;
    }
    const pending = this.compaction;
    if (!pending) {
      return;
    }
    let turnId: string;
    try {
      turnId = pending.turnId ?? (await pending.started);
    } catch {
      return;
    }
    if (this.compaction !== pending || pending.turnId !== turnId) {
      return;
    }
    await this.request('turn/interrupt', { threadId: pending.threadId, turnId });
  }

  // What the reader's account has left. The server answers this on a bare handshake, with
  // no thread started and no prompt sent, so asking it costs no model tokens.
  async rateLimits(refreshAuthentication = false): Promise<Json> {
    if (refreshAuthentication) {
      await this.request('account/read', { refreshToken: true });
    }
    return await this.request('account/rateLimits/read', {});
  }

  // The models this server will run, with the words it uses for them. Asked once per
  // server: the list turns over on a release rather than on a turn. The response is
  // paginated, so the picker gets one catalog only after every page has arrived.
  //
  // A server that does not know the method answers with an error, and one that has gone
  // answers nothing, so a refusal comes back as no list rather than as a failure. The
  // picker then offers nothing, which is what it does before the answer arrives anyway, and
  // the reader is not shown an error about a control they never pressed.
  async appliedDefaults(cwd: string, model: string): Promise<AppliedDefaults> {
    if (!this.defaultsQualified)
      return unavailableDefaults('This Codex version has no confirmed default-settings behavior.');
    const snapshot = await this.appliedDefaultsSnapshot(cwd);
    return snapshot
      ? readAppliedDefaults(snapshot.configuration, snapshot.catalog, snapshot.policy, model)
      : unavailableDefaults('Codex did not report its configuration or policy.');
  }

  async appliedDefaultsSnapshot(cwd: string): Promise<CodexDefaultsSnapshot | null> {
    if (!this.defaultsQualified) return null;
    try {
      const [configuration, catalog, policy] = await Promise.all([
        this.request('config/read', { includeLayers: false, cwd }),
        this.models(),
        this.request('configRequirements/read', {}),
      ]);
      const safe = readDefaultConfiguration(configuration);
      const requirements = obj(policy);
      if (
        !safe ||
        !requirements ||
        !('requirements' in requirements) ||
        (requirements.requirements !== null && !obj(requirements.requirements))
      )
        return null;
      return {
        configuration: safe,
        catalog,
        policy: { requirements: requirements.requirements === null ? null : {} },
      };
    } catch {
      return null;
    }
  }

  async models(): Promise<Json | null> {
    const data: unknown[] = [];
    let cursor: string | null = null;
    try {
      do {
        const result = await this.request('model/list', {
          limit: 100,
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        });
        data.push(...arr(result.data));
        cursor = str(result.nextCursor);
      } while (cursor);
      return { data };
    } catch {
      return null;
    }
  }

  // Codex's `/mcp` is a status view. The app-server exposes that same inventory with
  // pagination; tools and auth are enough for the panel, so resources are left out.
  async mcpStatus(): Promise<McpServer[]> {
    const data: Json[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request('mcpServerStatus/list', {
        detail: 'toolsAndAuthOnly',
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of arr(result.data)) {
        const server = obj(entry);
        if (server) {
          data.push(server);
        }
      }
      cursor = str(result.nextCursor);
    } while (cursor);
    return readCodexMcpServers(data, this.mcpStartup);
  }

  // Archiving is the server's own, and it moves the rollout file on disk, so a thread
  // archived here is archived for the CLI and the editor extension too.
  async archive(threadId: string): Promise<void> {
    await this.request('thread/archive', { threadId });
  }

  async unarchive(threadId: string): Promise<void> {
    await this.request('thread/unarchive', { threadId });
  }

  // Names a thread through the server, which writes the name where every Codex client reads
  // it. A refusal rejects with the server's own message.
  async renameThread(threadId: string, name: string): Promise<void> {
    await this.request('thread/name/set', { threadId, name });
  }

  async listThreads(limit = 20): Promise<Json[]> {
    const result = await this.request('thread/list', { limit });
    return arr(result.data)
      .map((t) => obj(t))
      .filter((t): t is Json => t !== null);
  }

  // Answers an approval. The reader's verdict is translated here rather than at the call
  // site, so the panel's two buttons mean the same thing on both agents.
  answer(id: string, answer: AskAnswer): boolean {
    const asked = this.asyncAsks.get(id);
    if (asked) {
      this.asyncAsks.delete(id);
      const text = answer.decision === 'answer' ? asyncReply(asked.ask.questions, answer.answers) : '';
      if (text) {
        void this.sendAsyncReply(id, asked, text);
      } else {
        // A dismissal sends nothing. No request is waiting on it, so the agent is not left
        // stalled, and the question stays readable in its Activity row.
        this.emit({ kind: 'askResolved', id });
      }
      return true;
    }
    const pending = this.askIds.get(id);
    if (!pending) {
      return false;
    }
    this.askIds.delete(id);
    this.approvalRequests.delete(id);
    if (pending.method === USER_INPUT) {
      // A user-input request is answered with a map from question id to the labels picked,
      // which is a different shape from an approval's verdict. A refusal has no way to be
      // said in that shape, so it goes back as the request being cancelled.
      if (answer.decision === 'deny') {
        this.write({ id: pending.requestId, result: { answers: {} } });
      } else {
        const answers: Record<string, { answers: string[] }> = {};
        const picked = answer.decision === 'answer' ? answer.answers : {};
        // An answer the reader wrote themselves rides in the same list as the labels. The
        // server takes a string it never offered and the model reads it back unchanged.
        for (const [question, given] of Object.entries(picked)) {
          answers[question] = { answers: [...given.labels, ...(given.written ? [given.written] : [])] };
        }
        this.write({ id: pending.requestId, result: { answers } });
      }
    } else {
      const decision: Decision = answer.decision === 'deny' ? 'decline' : 'accept';
      this.write({ id: pending.requestId, result: { decision } });
    }
    this.emit({ kind: 'askResolved', id });
    return true;
  }

  receive(line: string): void {
    const text = line.trim();
    if (!text) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.emit({ kind: 'error', message: `unreadable line from the agent: ${text.slice(0, 200)}` });
      return;
    }
    const message = obj(parsed);
    if (!message) {
      return;
    }

    const id = num(message.id);
    const method = str(message.method);

    // Both an id and a method: a request the server is waiting on us to answer.
    if (id !== null && method) {
      this.serverRequest(id, method, obj(message.params) ?? {});
      return;
    }
    if (id !== null) {
      this.settle(id, message);
      return;
    }
    if (method) {
      this.notification(method, obj(message.params) ?? {});
    }
  }

  close(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.turns.splice(0);
    if (this.compaction) {
      this.failCompaction(this.compaction, new Error(reason));
    }
    for (const [, waiting] of this.waiting) {
      if (waiting.timer) {
        clearTimeout(waiting.timer);
      }
      waiting.reject(new Error(reason));
    }
    this.waiting.clear();
    this.askIds.clear();
    this.asyncAsks.clear();
    this.approvalRequests.clear();
  }

  private adoptThread(result: Json): string {
    const thread = obj(result.thread);
    const id = (thread && str(thread.id)) ?? str(result.threadId);
    if (!id) {
      throw new Error('the agent started a session without naming it');
    }
    const sandbox = obj(result.sandbox);
    const approvalPolicy = str(result.approvalPolicy) ?? obj(result.approvalPolicy);
    const approvalsReviewer = str(result.approvalsReviewer);
    const sandboxType = sandbox && str(sandbox.type);
    this.effectiveMode =
      approvalPolicy && approvalsReviewer && sandboxType
        ? { approvalPolicy, approvalsReviewer, sandbox: sandboxType }
        : null;
    const previous = this.thread;
    this.thread = id;
    // An answer to a question asked on another thread must never reach this one. A cleared
    // session starts a new thread, so its open questions close with it.
    for (const [askId, asked] of [...this.asyncAsks]) {
      if (asked.threadId !== id) {
        this.asyncAsks.delete(askId);
        this.emit({ kind: 'askResolved', id: askId });
      }
    }
    this.emit({
      kind: 'session',
      sessionId: id,
      previous,
      ...(this.effectiveMode ? { effectiveMode: this.effectiveMode } : {}),
    });
    return id;
  }

  private serverRequest(requestId: number, method: string, params: Json): void {
    if (!ANSWERABLE.has(method)) {
      // Anything else is refused rather than left hanging, so the server can fall back to
      // whatever it does without a client that understands the request. Refusing is the
      // safe half of the choice: an unanswered request stalls the turn, and a wrongly
      // shaped answer tells the server something the reader never said.
      this.write({ id: requestId, error: { code: -32601, message: `the panel cannot answer ${method}` } });
      return;
    }
    const itemId = str(params.itemId) ?? `codex-${requestId}`;
    const ask = method === USER_INPUT ? this.userInputAsk(itemId, params) : this.approvalAsk(itemId, method, params);
    this.askIds.set(itemId, { requestId, method });
    if (method === FILE_APPROVAL) {
      this.approvalRequests.set(itemId, { method, params });
    }
    this.emit({ kind: 'ask', ask });
  }

  private approvalAsk(itemId: string, method: string, params: Json): Ask {
    const command = str(params.command);
    const isFile = method === FILE_APPROVAL;
    const active = this.activeItems.get(itemId)?.item ?? null;
    const paths = isFile ? fileChangePaths(active) : [];
    const path = str(params.path) ?? str(params.filePath);
    const grantRoot = str(params.grantRoot) ?? str(params.grant_root);
    return {
      kind: 'permission',
      id: itemId,
      toolName: isFile ? 'Edit' : 'Bash',
      displayName: isFile ? 'File change' : 'Shell',
      description: str(params.reason) ?? '',
      input: command
        ? { command }
        : paths.length
          ? { paths }
          : path
            ? { file_path: path }
            : grantRoot
              ? { path: grantRoot }
              : params,
      toolUseId: itemId,
    };
  }

  // Codex's own version of a model asking the reader something. It is the same kind of ask
  // Claude sends as AskUserQuestion, so it reaches the panel as the same card; the answer
  // is keyed by each question's id, which is why `Question` carries one.
  //
  // Each question also carries `isOther`, which says whether the server wants a free-form
  // choice offered beside the options. It is not read: the card offers one on every question.
  private userInputAsk(itemId: string, params: Json): Ask {
    const questions: Question[] = [];
    for (const entry of arr(params.questions)) {
      const q = obj(entry);
      const text = q && str(q.question);
      const id = q && str(q.id);
      if (!text || !id) {
        continue;
      }
      const options: QuestionOption[] = [];
      for (const o of arr(q?.options)) {
        const option = obj(o);
        const label = option && (str(option.label) ?? str(option.value));
        if (label) {
          options.push({ label, description: (option && str(option.description)) ?? '' });
        }
      }
      questions.push({
        id,
        question: text,
        header: (q && str(q.header)) ?? '',
        options,
        // Codex says nothing about several answers per question, so one is assumed. A
        // question with no options at all is answered in the reader's own words, which the
        // card offers on every question.
        multiSelect: false,
        secret: q?.isSecret === true,
      });
    }
    return { kind: 'question', id: itemId, questions, input: params, toolUseId: itemId };
  }

  // `request_user_input_async` reports the same shape as the synchronous ask, but the
  // question carries no id of its own and its options are plain labels, not
  // `{ label, description }` pairs. The id is the one Codex's own clients put in the reply
  // envelope, so an answer names its question the way every other client reads it.
  private asyncQuestionAsk(itemId: string, questions: Json[]): Ask {
    const built: Question[] = [];
    questions.forEach((entry, index) => {
      const q = obj(entry);
      const title = q && str(q.title);
      if (!title) {
        return;
      }
      const options: QuestionOption[] = arr(q?.options)
        .map((label) => (typeof label === 'string' ? label : ''))
        .filter(Boolean)
        .map((label) => ({ label, description: '' }));
      built.push({
        id: asyncQuestionId(itemId, index),
        question: title,
        header: '',
        options,
        multiSelect: false,
        secret: false,
      });
    });
    return { kind: 'question', id: itemId, questions: built, input: {}, toolUseId: itemId };
  }

  // Whether an ask stays open after its turn ends. An async question does: nothing on the
  // server waits for its answer, and the reader can still answer it into a new turn.
  outlivesTurn(id: string): boolean {
    return this.asyncAsks.has(id);
  }

  // The answer goes into the running turn with `turn/steer`, which the server refuses once
  // `expectedTurnId` is no longer the active turn. A question can be the last thing its turn
  // does and the reader can answer minutes later, so after the turn ends, or when the server
  // refuses the steer, the same text goes out as a new prompt instead. The prompt goes only
  // to the thread that asked. A request the server never answered is not sent again, because
  // it can have arrived, and a second copy would answer the question twice.
  private async sendAsyncReply(id: string, asked: AsyncAsk, text: string): Promise<void> {
    if (asked.turnId && asked.threadId) {
      try {
        await this.request('turn/steer', {
          threadId: asked.threadId,
          input: [{ type: 'text', text }],
          expectedTurnId: asked.turnId,
        });
        this.emit({ kind: 'askResolved', id });
        return;
      } catch (error) {
        if (!(error instanceof RequestRefused)) {
          this.abandonAsyncReply(id);
          return;
        }
      }
    }
    if (asked.threadId !== null && asked.threadId !== this.thread) {
      this.emit({
        kind: 'error',
        message: 'the session changed before the answer was sent, so it was not sent',
      });
      this.emit({ kind: 'askResolved', id });
      return;
    }
    try {
      await this.prompt(text);
    } catch (error) {
      if (error instanceof NoAnswer || this.closed) {
        this.abandonAsyncReply(id);
        return;
      }
      // Nothing reached the agent, so the question is offered again while its thread is open.
      this.emit({ kind: 'error', message: `the answer did not reach the agent: ${(error as Error).message}` });
      if (asked.threadId === null || asked.threadId === this.thread) {
        this.asyncAsks.set(id, { ...asked, turnId: null });
        this.emit({ kind: 'ask', ask: asked.ask });
      } else {
        this.emit({ kind: 'askResolved', id });
      }
      return;
    }
    // After the prompt is accepted, so a session that reads this event sees the new turn open.
    this.emit({ kind: 'askResolved', id });
  }

  // A closed wire says nothing more, so the reason it closed stays the session's last error.
  // A request with no answer can still have delivered the reply, so it is not offered again.
  private abandonAsyncReply(id: string): void {
    if (this.closed) {
      return;
    }
    this.emit({
      kind: 'error',
      message: 'the agent did not confirm the answer to its question, so it was not sent again',
    });
    this.emit({ kind: 'askResolved', id });
  }

  // An async question outlives its turn, but a steer naming that turn would be refused.
  private endAsyncAskTurn(params: Json): void {
    const turnId = str(obj(params.turn)?.id) ?? str(params.turnId);
    if (!turnId) {
      return;
    }
    for (const asked of this.asyncAsks.values()) {
      if (asked.turnId === turnId) {
        asked.turnId = null;
      }
    }
  }

  // A user message that is only a reply envelope answers async questions rather than asking
  // anything. It can come from another client on the same thread, and each question it
  // answers then leaves this panel too. The panel's own reply comes back the same way, after
  // its ask has already gone, and changes nothing.
  private resolveRepliedAsks(item: Json): void {
    const content = arr(item.content).map((entry) => obj(entry));
    if (!content.length || content.some((entry) => !entry || str(entry.type) !== 'text')) {
      return;
    }
    const replies = parseQuestionReply(content.map((entry) => str(entry?.text) ?? '').join(''));
    const answered = new Map<string, Set<string>>();
    for (const reply of replies ?? []) {
      const itemId = asyncQuestionItem(reply.questionItemId);
      if (itemId && this.asyncAsks.has(itemId)) {
        answered.set(itemId, (answered.get(itemId) ?? new Set()).add(reply.questionItemId));
      }
    }
    // One item can ask several questions, and a reply can answer some of them. The ask stays
    // open with the rest, and resolves when the last one is answered.
    for (const [itemId, questionIds] of answered) {
      const asked = this.asyncAsks.get(itemId)!;
      const open = asked.ask.questions.filter((question) => !questionIds.has(question.id));
      if (!open.length) {
        this.asyncAsks.delete(itemId);
        this.emit({ kind: 'askResolved', id: itemId });
      } else if (open.length < asked.ask.questions.length) {
        asked.ask = { ...asked.ask, questions: open };
        this.emit({ kind: 'ask', ask: asked.ask });
      }
    }
  }

  private notification(method: string, params: Json): void {
    switch (method) {
      case 'turn/started':
        this.startCompactionTurn(params);
        return;
      case 'item/started':
        this.itemStarted(obj(params.item));
        return;
      case 'item/completed':
        this.itemCompleted(obj(params.item), params);
        return;
      case 'item/fileChange/patchUpdated': {
        const id = str(params.itemId);
        if (!id) {
          return;
        }
        const held = this.activeItems.get(id);
        const item: Json = {
          ...(held?.item ?? {}),
          type: 'fileChange',
          id,
          status: 'inProgress',
          changes: arr(params.changes),
        };
        this.activeItems.set(id, {
          type: 'fileChange',
          phase: held?.phase ?? '',
          delivery: held?.delivery ?? '',
          questions: held?.questions ?? null,
          item,
        });
        const activity = codexItemActivity(item, 'running');
        if (activity) {
          this.emit({ kind: 'activity', activity });
        }
        const approval = this.approvalRequests.get(id);
        if (approval) {
          this.emit({ kind: 'ask', ask: this.approvalAsk(id, approval.method, approval.params) });
        }
        return;
      }
      // A chunk of the reply as it is written. The server has always sent these and the
      // panel dropped them, which is why a Codex turn was as silent as a Claude one. The
      // shape is from the capture recorded off a real server: the whole payload is the
      // piece of text, under `delta`, beside the ids of the thread and the item it belongs
      // to. The item is finished separately by `item/completed`, which carries the whole
      // message and is what the finished reply is read from.
      case 'item/agentMessage/delta': {
        const text = str(params.delta);
        if (!text) {
          return;
        }
        const itemId = str(params.itemId);
        const active = itemId ? this.activeItems.get(itemId) : null;
        // An async item is never the reply, streamed or not, so its delta goes to the same
        // activity accumulator commentary uses rather than the reply stream.
        if (!itemId || !active || (active.phase !== 'commentary' && active.delivery !== 'async')) {
          this.emit({ kind: 'delta', text, ...(str(params.turnId) ? { nativeTurnId: str(params.turnId)! } : {}) });
          return;
        }
        const detail = (this.activityText.get(itemId) ?? '') + text;
        this.activityText.set(itemId, detail);
        this.emit({
          kind: 'activity',
          activity: {
            sourceId: itemId,
            kind: 'commentary',
            name: 'Update',
            headline: 'Working',
            detail,
            status: 'running',
          },
        });
        return;
      }
      case 'turn/completed':
        {
          this.endAsyncAskTurn(params);
          const outcome = turnOutcome(obj(params.turn));
          if (this.finishCompaction(params, outcome)) {
            this.emit({
              kind: 'turnEnd',
              outcome,
              nativeTurnId: str(obj(params.turn)?.id) ?? str(params.turnId) ?? undefined,
            });
            return;
          }
          if (this.finishTurn(params, outcome)) {
            this.emit({
              kind: 'turnEnd',
              outcome,
              nativeTurnId: str(obj(params.turn)?.id) ?? str(params.turnId) ?? undefined,
            });
          }
        }
        return;
      case 'turn/failed':
        {
          this.endAsyncAskTurn(params);
          const outcome: TurnOutcome = {
            status: 'error',
            text: errorText(params.error),
            costUsd: null,
            turns: null,
            deniedTools: [],
          };
          if (this.finishCompaction(params, outcome)) {
            this.emit({
              kind: 'turnEnd',
              outcome,
              nativeTurnId: str(obj(params.turn)?.id) ?? str(params.turnId) ?? undefined,
            });
            return;
          }
          if (this.finishTurn(params, outcome)) {
            this.emit({
              kind: 'turnEnd',
              outcome,
              nativeTurnId: str(obj(params.turn)?.id) ?? str(params.turnId) ?? undefined,
            });
          }
        }
        return;
      case 'account/rateLimits/updated':
        this.reportRateLimits(obj(params.rateLimits));
        return;
      case 'skills/changed':
        this.refreshCommandCatalog();
        return;
      case 'mcpServer/startupStatus/updated': {
        const name = str(params.name);
        if (name) {
          this.mcpStartup.set(name, {
            status: str(params.status) ?? '',
            error: str(params.error) ?? '',
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private pendingCompaction(threadId: string): PendingCompaction {
    let resolveStarted!: (turnId: string) => void;
    let rejectStarted!: (error: Error) => void;
    let resolveFinished!: () => void;
    let rejectFinished!: (error: Error) => void;
    const started = new Promise<string>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    // Either promise can settle before its caller reaches the corresponding await.
    void started.catch(() => undefined);
    void finished.catch(() => undefined);
    return {
      threadId,
      turnId: null,
      started,
      resolveStarted,
      rejectStarted,
      finished,
      resolveFinished,
      rejectFinished,
    };
  }

  private startCompactionTurn(params: Json): void {
    const pending = this.compaction;
    if (!pending || pending.turnId) {
      return;
    }
    const threadId = str(params.threadId);
    if (threadId && threadId !== pending.threadId) {
      return;
    }
    const turnId = str(obj(params.turn)?.id) ?? str(params.turnId);
    if (!turnId) {
      return;
    }
    pending.turnId = turnId;
    pending.resolveStarted(turnId);
  }

  private finishCompaction(params: Json, outcome: TurnOutcome): boolean {
    const pending = this.compaction;
    if (!pending) {
      return false;
    }
    const threadId = str(params.threadId);
    if (threadId && threadId !== pending.threadId) {
      return false;
    }
    const turnId = str(obj(params.turn)?.id) ?? str(params.turnId);
    if (!turnId || (pending.turnId && pending.turnId !== turnId)) {
      return false;
    }
    if (!pending.turnId) {
      pending.turnId = turnId;
      pending.resolveStarted(turnId);
    }
    this.compaction = null;
    if (outcome.status === 'ok') {
      pending.resolveFinished();
    } else {
      // An interrupted compaction gets a sentence of its own, because a reader's own stop is
      // a different outcome from a failure and nothing else on the wire says so.
      //
      // A failure gets none. The caller already knows the compaction did not happen, and the
      // only thing worth saying here is why. When the server named no reason the message is
      // empty, which is what the panel reads to say that instead of inventing a cause.
      if (outcome.status === 'interrupted') {
        pending.rejectFinished(new Error(outcome.text || 'the compaction was interrupted'));
      } else {
        pending.rejectFinished(new Error(outcome.text));
      }
    }
    return true;
  }

  private failCompaction(pending: PendingCompaction, error: Error): void {
    if (this.compaction === pending) {
      this.compaction = null;
    }
    pending.rejectStarted(error);
    pending.rejectFinished(error);
  }

  private finishTurn(params: Json, outcome: TurnOutcome): boolean {
    const turnId = str(obj(params.turn)?.id) ?? str(params.turnId);
    if (!turnId) {
      return false;
    }
    const threadId = str(params.threadId);
    const ended = this.turns.filter((active) => active.id === turnId && (!threadId || threadId === active.threadId));
    const pending = this.turns.filter((active) => active.id === null && (!threadId || threadId === active.threadId));
    if (ended.length) {
      for (const active of ended) {
        this.forgetTurn(active);
      }
      for (const active of pending) {
        active.endingsBeforeStart.set(turnId, { outcome, emitted: true });
      }
      return true;
    }
    for (const active of pending) {
      const recorded = active.endingsBeforeStart.get(turnId);
      active.endingsBeforeStart.set(turnId, { outcome, emitted: recorded?.emitted ?? false });
    }
    return this.turns.length === 0;
  }

  private markEndingEmitted(threadId: string, turnId: string): void {
    for (const active of this.turns) {
      if (active.threadId !== threadId) {
        continue;
      }
      const ending = active.endingsBeforeStart.get(turnId);
      if (ending) {
        ending.emitted = true;
      }
    }
  }

  private forgetTurn(active: ActiveTurn): boolean {
    const index = this.turns.indexOf(active);
    if (index < 0) {
      return false;
    }
    this.turns.splice(index, 1);
    return true;
  }

  private itemStarted(item: Json | null): void {
    if (!item) {
      return;
    }
    const type = str(item.type);
    const id = str(item.id);
    if (!type || !id) {
      return;
    }
    this.activeItems.set(id, {
      type,
      phase: str(item.phase) ?? '',
      delivery: str(item.delivery) ?? '',
      // `null` and an array are different states to carry forward: `null` means the item
      // names no questions field at all, and an array is the raw entries itemCompleted
      // builds the ask from, which can still turn out empty once titleless entries drop.
      questions: Array.isArray(item.questions) ? (item.questions as Json[]) : null,
      item,
    });
    const approval = this.approvalRequests.get(id);
    if (approval) {
      this.emit({ kind: 'ask', ask: this.approvalAsk(id, approval.method, approval.params) });
    }
    if (type === 'reasoning') {
      this.emit({
        kind: 'activity',
        activity: {
          sourceId: id,
          kind: 'reasoning',
          name: 'Reasoning',
          headline: 'Thinking',
          detail: '',
          status: 'running',
        },
      });
      return;
    }
    const activity = codexItemActivity(item, 'running');
    if (activity) {
      this.emit({ kind: 'activity', activity });
    }
  }

  private itemCompleted(item: Json | null, params: Json): void {
    if (!item) {
      return;
    }
    const id = str(item.id);
    const active = id ? this.activeItems.get(id) : null;
    const type = str(item.type) ?? active?.type ?? '';
    const phase = str(item.phase) ?? active?.phase ?? '';
    const delivery = str(item.delivery) ?? active?.delivery ?? '';
    const questions = Array.isArray(item.questions)
      ? (item.questions as Json[])
      : item.questions === null
        ? null
        : (active?.questions ?? null);
    const completedItem = active ? { ...active.item, ...item, type, phase } : item;
    if (type === 'agentMessage') {
      const text = itemText(completedItem);
      // `request_user_input_async` and `send_message_to_user_async` both set `final_answer`,
      // so phase cannot separate a question from a real reply. `delivery` can: it marks an
      // item returned to the model without ending the turn, set for example by these two
      // tools, and an async item never reaches the reply stream.
      if (delivery === 'async') {
        // Built, not raw: a `questions` array whose entries all lack a title builds down
        // to nothing, and that is a message with nothing to pick, not a question.
        const ask = id && questions ? this.asyncQuestionAsk(id, questions) : null;
        if (id && ask && ask.kind === 'question' && ask.questions.length > 0) {
          this.asyncAsks.set(id, {
            threadId: str(params.threadId) ?? this.thread,
            turnId: str(params.turnId),
            ask,
          });
          this.emit({ kind: 'ask', ask });
          // The ask leaves the live panel once the reader answers or dismisses it. Recording
          // it as a done Activity row too keeps the question and its options visible after
          // that happens.
          this.emit({
            kind: 'activity',
            activity: {
              sourceId: id,
              kind: 'commentary',
              name: 'Update',
              headline: 'Asked',
              detail: ask.questions
                .map((q) => [q.question, ...q.options.map((option) => `- ${option.label}`)].join('\n'))
                .join('\n\n'),
              status: 'done',
            },
          });
        } else if (id) {
          this.emit({
            kind: 'activity',
            activity: {
              sourceId: id,
              kind: 'commentary',
              name: 'Update',
              headline: 'Said',
              detail: text,
              status: 'done',
            },
          });
        }
      } else if (phase === 'commentary' && id && text) {
        this.emit({
          kind: 'activity',
          activity: {
            sourceId: id,
            kind: 'commentary',
            name: 'Update',
            headline: 'Worked',
            detail: text,
            status: 'done',
          },
        });
      } else if (phase !== 'commentary' && text) {
        this.emit({
          kind: 'text',
          text,
          ...(id ? { sourceId: id } : {}),
          ...(str(params.turnId) ? { nativeTurnId: str(params.turnId)! } : {}),
        });
      }
    } else if (type === 'userMessage') {
      this.resolveRepliedAsks(completedItem);
    } else if (type === 'reasoning' && id) {
      const detail = reasoningSummary(completedItem);
      this.emit({
        kind: 'activity',
        activity: {
          sourceId: id,
          kind: 'reasoning',
          name: 'Reasoning',
          headline: detail ? 'Reasoned' : 'Thinking',
          detail,
          status: completedStatus(item),
        },
      });
    } else {
      const activity = codexItemActivity(completedItem, completedStatus(completedItem));
      if (activity) {
        this.emit({ kind: 'activity', activity });
      }
    }
    if (id) {
      this.activeItems.delete(id);
      this.activityText.delete(id);
    }
  }

  // Every window the server volunteers is reported, shorter first, because which one binds
  // is the strip's decision and a wire that dropped one would be making it here. A named
  // update belongs to that model, not to the account-wide line.
  private reportRateLimits(limits: Json | null): void {
    const scope = (limits && str(limits.limitName)) ?? '';
    const limitId = limits && str(limits.limitId);
    // Older account updates may omit `limitId`. A bucket that explicitly identifies itself
    // as something else needs a readable name, or treating it as unscoped corrupts the
    // account figure.
    if (limitId && limitId !== 'codex' && !scope.trim()) {
      return;
    }
    for (const limit of readLimits(limits, scope)) {
      this.emit({ kind: 'rateLimit', limit, creditResetsAtSeconds: null });
    }
  }

  // Takes one request out of the map and stops its clock. Every path that settles a request
  // goes through here, so no timer outlives the request it belongs to.
  private take(id: number): Waiting | null {
    const waiting = this.waiting.get(id);
    if (!waiting) {
      return null;
    }
    this.waiting.delete(id);
    if (waiting.timer) {
      clearTimeout(waiting.timer);
    }
    return waiting;
  }

  private settle(id: number, message: Json): void {
    const waiting = this.take(id);
    if (!waiting) {
      return;
    }
    const failure = obj(message.error);
    if (failure) {
      waiting.reject(new RequestRefused(str(failure.message) ?? 'the agent refused the request'));
    } else waiting.resolve(obj(message.result) ?? {});
  }

  private request(method: string, params: Json): Promise<Json> {
    if (this.closed) {
      return Promise.reject(new Error('the agent is no longer running'));
    }
    const id = ++this.nextId;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        const late = this.take(id);
        if (late) {
          late.reject(new NoAnswer('the agent did not answer'));
        }
      }, this.deadlineMs);
      // The extension host outlives any one request, and a pending timer that keeps the host
      // awake is a cost the reader pays for a question they did not ask.
      if (typeof timer === 'object' && typeof timer.unref === 'function') {
        timer.unref();
      }
      this.waiting.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  private write(message: Json): void {
    if (this.closed) {
      return;
    }
    this.send(JSON.stringify(message) + '\n');
  }
}

// Codex splits one server reading across the list response and startup notifications. The
// list names tools as an object keyed by tool name, unlike Claude's array, and publishes no
// config scope. Rows are read-only because app-server has no per-server toggle request.
export function readCodexMcpServers(
  entries: readonly Json[],
  startup: ReadonlyMap<string, McpStartup> = new Map(),
): McpServer[] {
  const servers: McpServer[] = [];
  for (const entry of entries) {
    const name = str(entry.name);
    if (!name) {
      continue;
    }
    const state = startup.get(name);
    const serverInfo = obj(entry.serverInfo);
    const tools = obj(entry.tools);
    servers.push({
      name,
      status: state?.status ?? (serverInfo ? 'ready' : (str(entry.authStatus) ?? '')),
      error: state?.error ?? '',
      tools: tools ? Object.keys(tools) : [],
      scope: '',
      title: (serverInfo && (str(serverInfo.title) ?? str(serverInfo.name))) ?? '',
      mutable: false,
    });
  }
  return servers;
}

// How long each window covers, and what the panel calls it. Only the two durations both
// agents report are named; anything else keeps its own length, because a window of 600
// minutes called "five_hour" would put a wrong word on a real figure.
const WINDOW_NAMES: Record<number, string> = { 300: 'five_hour', 10080: 'seven_day' };

function windowName(minutes: number): string {
  return Object.prototype.hasOwnProperty.call(WINDOW_NAMES, minutes) ? WINDOW_NAMES[minutes] : `${minutes}_minute`;
}

// Which clock a window runs on, from the same length its name is read off. `session` is the
// few-hour window and `weekly` the seven-day one, which is how a Codex figure lands in the
// same group as the Claude figure it is drawn beside. A window of any other length is left
// ungrouped rather than filed under a period it does not cover.
const WINDOW_GROUPS: Record<number, string> = { 300: 'session', 10080: 'weekly' };

function windowGroup(minutes: number): string {
  return Object.prototype.hasOwnProperty.call(WINDOW_GROUPS, minutes) ? WINDOW_GROUPS[minutes] : '';
}

// Every window in a `rateLimits` object, in the panel's vocabulary. The share is a
// whole-number percentage on this wire and a fraction in the panel's, so it is converted
// here rather than at the reader; the notification and the request answer with the same
// object, so both come through this.
//
// Codex reports two limits, `primary` and `secondary`, and those are the two the panel
// draws. The `rateLimitsByLimitId` map beside a complete answer is not read: it is inventory,
// including entries the server has not actively published. A live update can itself be for
// a named model bucket, and its caller supplies that name as the scope.
//
// `secondary` is often absent, so whichever of the two exist are read, shorter first.
function readLimits(limits: Json | null, scope: string): RateLimit[] {
  if (!limits) {
    return [];
  }
  const status = str(limits.rateLimitReachedType) ?? '';
  const out: RateLimit[] = [];
  for (const key of ['primary', 'secondary']) {
    const window = obj(limits[key]);
    const used = window === null ? null : num(window.usedPercent);
    if (window === null || used === null) {
      continue;
    }
    const minutes = num(window.windowDurationMins) ?? 0;
    out.push({
      window: windowName(minutes),
      utilization: used / 100,
      resetsAtSeconds: num(window.resetsAt),
      status,
      group: windowGroup(minutes),
      scope,
    });
  }
  return out;
}

// The `account/rateLimits/read` answer, in the panel's vocabulary. A server that reports no
// window at all returns nothing rather than an empty plan row: the reader is on a plan
// either way, and a row with no figure on it says less than no row.
export function readRateLimits(payload: unknown, readAt: number): UsageReading | null {
  const answer = obj(payload);
  const limits = obj(answer?.rateLimits);
  // The top-level object is the account aggregate. Named model buckets beside it remain
  // inventory until the server actively publishes one as a live update.
  const read = readLimits(limits, '');
  if (!read.length) {
    return null;
  }
  return {
    plan: (limits && str(limits.planType)) ?? '',
    limits: read,
    complete: true,
    spend: null,
    creditResetsAtSeconds: null,
    readAt,
  };
}

// The `model/list` answer, in the panel's vocabulary. A model the server marks hidden is
// one it will run but does not offer, so the panel does not offer it either; a model with
// no id is skipped, because the id is what goes back when the reader picks it.
export function readModels(payload: unknown, readAt: number): ModelList | null {
  const models: ModelChoice[] = [];
  for (const entry of arr(obj(payload)?.data)) {
    const model = obj(entry);
    const value = model && str(model.id);
    if (!model || !value) {
      continue;
    }
    const efforts: EffortChoice[] = [];
    for (const level of arr(model.supportedReasoningEfforts)) {
      const effort = obj(level);
      const name = effort && str(effort.reasoningEffort);
      // Codex writes a sentence about each effort level, so the panel draws its words
      // rather than any of its own.
      if (effort && name) {
        efforts.push({ value: name, label: name, description: str(effort.description) ?? '' });
      }
    }
    models.push({
      value,
      resolvedModel: str(model.model) ?? value,
      hidden: model.hidden === true,
      isDefault: model.isDefault === true,
      ...(str(model.defaultReasoningEffort) ? { defaultReasoningEffort: str(model.defaultReasoningEffort)! } : {}),
      // A model that named itself nothing is drawn under the id that goes back on the wire,
      // which is at least something the reader can recognise again.
      label: str(model.displayName) ?? value,
      description: str(model.description) ?? '',
      efforts,
    });
  }
  if (!models.length) {
    return null;
  }
  return { models, readAt };
}

// What the server said went wrong, from either shape it uses. The failure that made this
// necessary was an expired provider sign-in: the reader was told only that the work did not
// happen, because the sentence naming the sign-in arrived in a field nothing read.
function errorText(error: unknown): string {
  return str(error) ?? str(obj(error)?.message) ?? '';
}

// A finished turn, in the panel's vocabulary. Codex reports the reader's own stop as a
// turn that did not complete, so it is read apart from a real failure for the same reason
// the Claude side does.
export function turnOutcome(turn: Json | null): TurnOutcome {
  const status = str(turn?.status) ?? '';
  const items = arr(turn?.items);
  let text = '';
  for (const entry of items) {
    const item = obj(entry);
    // An async item can carry `final_answer` on a question that never ended the turn, so it
    // must never become the sentence the panel shows for how the turn ended.
    if (
      item &&
      str(item.type) === 'agentMessage' &&
      str(item.phase) === 'final_answer' &&
      str(item.delivery) !== 'async'
    ) {
      text = str(item.text) ?? text;
    }
  }
  // A turn that failed wrote no final answer, so the loop above leaves the text empty and
  // the one sentence saying why the turn stopped sits on the turn itself. Read it here, or
  // the panel has nothing to tell the reader beyond the fact that something did not work.
  if (!text && status !== 'completed') {
    text = errorText(turn?.error);
  }
  return {
    status: status === 'completed' ? 'ok' : status === 'aborted' || status === 'interrupted' ? 'interrupted' : 'error',
    text,
    costUsd: null,
    turns: null,
    deniedTools: [],
  };
}

export interface CodexDefaultsSnapshot {
  configuration: { config: Json };
  catalog: Json | null;
  policy: { requirements: Json | null };
}

export function readDefaultConfiguration(configuration: unknown): { config: Json } | null {
  const config = obj(obj(configuration)?.config);
  if (!config) return null;
  const safe: Json = {};
  for (const key of ['model', 'model_reasoning_effort']) {
    if (!(key in config)) continue;
    const value = config[key];
    if (value !== undefined && value !== null && typeof value !== 'string') return null;
    safe[key] = value;
  }
  return { config: safe };
}

export function readAppliedDefaults(
  configuration: unknown,
  catalog: unknown,
  policy: unknown,
  selected = '',
): AppliedDefaults {
  const config = obj(obj(configuration)?.config);
  const requirements = obj(policy);
  if (
    !config ||
    !requirements ||
    !('requirements' in requirements) ||
    (requirements.requirements !== null && !obj(requirements.requirements))
  ) {
    return unavailableDefaults('Codex did not report its configuration or policy.');
  }
  const models = readModels(catalog, 0)?.models ?? [];
  const configured = config.model;
  const configuredEffort = config.model_reasoning_effort;
  if (
    (configured !== undefined && configured !== null && typeof configured !== 'string') ||
    (configuredEffort !== undefined && configuredEffort !== null && typeof configuredEffort !== 'string')
  ) {
    return unavailableDefaults('Codex reported incomplete settings.');
  }
  const model = selected || str(configured) || models.find((item) => item.isDefault)?.value || models[0]?.value;
  const choice = models.find((item) => item.value === model || item.resolvedModel === model);
  const effort = str(configuredEffort) || choice?.defaultReasoningEffort;
  if (!model) {
    return unavailableDefaults('Codex did not report supported model and effort defaults.');
  }
  const effortKnown = choice
    ? effort
      ? choice.efforts.some((item) => item.value === effort)
      : choice.efforts.length === 0
    : Boolean(effort);
  return {
    status: 'ready',
    model: choice?.resolvedModel || choice?.value || model,
    effort: effortKnown ? (effort ?? null) : null,
    ...(effortKnown ? {} : { effortStatus: 'unavailable' as const }),
    reason: effortKnown ? '' : 'Codex did not report an effort for this model.',
  };
}
