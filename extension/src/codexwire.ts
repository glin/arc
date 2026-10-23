import { unavailableDefaults, type AppliedDefaults } from './view/model-picks';
import { promptToken } from './domain/composer-editing';
import { compareVersion, parseVersion } from './domain/version';
// Adapts Codex app-server messages to the shared agent wire events.
// JSON-RPC messages travel over stdio as one object per line without the jsonrpc field.
// Responses have id only, notifications have method only, and server requests have both.
// Approval requests need an answer, so routing them as notifications stalls the turn.

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
  GuardedAttempt,
  normalizeAgentPrompt,
} from './agentwire';
import {
  QuestionReply,
  asyncQuestionId,
  asyncQuestionItem,
  buildQuestionReply,
  parseQuestionReply,
} from './codexreply';

// Controls when Codex requests approval.
// untrusted requests approval for most actions. on-request lets the model request it. never disables requests.
// The panel offers these named policies and supplies their labels.
// The granular object policy has no panel control.
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

// Selects the recipient of approval requests.
// auto_review assesses eligible requests and forwards requests requiring reader approval.
// The user default requires an explicit auto_review override for automatic review.
export type ApprovalsReviewer = 'user' | 'auto_review';

// Limits server access independently of its approval policy.
// The panel sends both fields together to apply the reader's selected permissions.
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

// thread/start takes the sandbox mode name. turn/start takes a sandboxPolicy object with a camelCase type.
// The map requires a policy type for every SandboxMode.
// Network-access flags and writable roots are omitted, so the server applies their defaults.
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
  // Reasoning effort advertised by model/list. turn/start applies it because thread/start has no effort field.
  effort?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
}

// Arguments for the app-server subcommand.
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
  // Request response deadline.
  deadlineMs?: number;
}

const CODEX_COMMANDS: readonly PromptEntry[] = [
  { kind: 'command', name: 'compact', description: 'Compact the session', argumentHint: '' },
  { kind: 'command', name: 'clear', description: 'Start a new session', argumentHint: '' },
  { kind: 'command', name: 'new', description: 'Start and name a new session', argumentHint: '[name]' },
  { kind: 'command', name: 'rename', description: 'Rename the session', argumentHint: '<name>' },
];

// A server error alone does not establish whether the request took effect.
class RequestRefused extends Error {}

// The server did not answer a request before the deadline. The request can still have
// taken effect.
class NoAnswer extends Error {}

// Routes async answers to the thread that asked and to its running turn.
// turnId becomes null when the turn ends. ask retains unanswered questions.
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

// Bounds the unanswered compactions whose late turns a wire still reports. At a full bound, a reader's
// compaction drops an unbound reader receipt and is still written. Lost identity withholds attribution
// until the thread changes. Deferred and already-bound receipts stay retained.
const UNANSWERED_COMPACTIONS = 8;

interface PendingCompaction {
  requestId: number | null;
  // Numbers each compaction request. Native compaction evidence carries it as its generation.
  generation: number;
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

// Bounds request waits so an unanswered read cannot block later reads or retain an idle child indefinitely.
// Turn event streams continue independently of request deadlines.
export const CODEX_DEADLINE_MS = 60_000;

// Approval verdicts accepted by Codex.
// The panel sends accept or decline. acceptForSession grants approval for the session. cancel requests a turn stop.
export type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

// Answerable server requests use distinct reply shapes.
// Command and file approvals take a decision. User-input requests take an answer map.
// Other requests receive a method-not-found error.
// item/permissions/requestApproval requires a permission profile and scope.
// mcpServer/elicitation/request requires an input surface the panel does not provide.
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

// Builds one envelope entry per answered async question.
// Picked labels and written input form the answer. No answers produce an empty string.
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
  private readonly askIds = new Map<string, { requestId: number; method: string; ask: Ask }>();
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
  // Preparation ends at the native write, so later input can still join a running turn.
  private preparing: Promise<void> | null = null;
  private readonly pendingPrompts = new Set<() => void>();
  // The compaction request only acknowledges startup. Notifications identify and end its native turn.
  // Caller errors transfer any running turn to a receipt without ending native ownership.
  private compaction: PendingCompaction | null = null;
  // Compactions with unanswered requests or caller errors during a native turn can still run.
  // Each retained turn reports native evidence under its own generation after caller settlement.
  // A receipt ends with its turn, with its thread or with the wire.
  private unanswered: {
    requestId: number;
    generation: number;
    threadId: string;
    turnId: string | null;
    deferred: boolean;
  }[] = [];
  private compactions = 0;
  private lostCompactionIdentity = false;
  private ambiguousCompaction = false;
  // Root turn ids this child has seen in any notification or response, each with the order of its
  // first sighting. A guarded start that returns one seen before its write joined existing work.
  private readonly seenTurns = new Map<string, number>();
  // Root turns the server reported as started and has not yet ended, including turns no
  // request of this client started.
  private readonly runningRootTurns = new Set<string>();
  // Native compaction ownership does not require an attributable request generation.
  private readonly runningCompactionTurns = new Set<string>();
  private endedRootTurns = 0;
  // Permission overrides selected by the reader travel together on the next turn/start.
  // The server applies them to that turn and subsequent turns.
  // Without an override, the thread retains its startup permissions.
  private approval: {
    policy: ApprovalPolicy;
    reviewer: ApprovalsReviewer;
    sandbox: SandboxMode;
  } | null = null;
  // Reader-selected model and effort overrides apply on the next turn/start and subsequent turns.
  // thread/start accepts a model but no effort field.
  // Null overrides leave the thread's current settings unchanged.
  private model: string | null = null;
  private effort: string | null = null;
  // The list response carries inventory and auth, while startup state arrives beside it as
  // notifications. Kept by server name so one reading can join the two halves.
  private readonly mcpStartup = new Map<string, McpStartup>();
  private commandsOpening = false;
  private commandsPending: Promise<PromptEntry[]> | null = null;
  private commandsOpened = false;
  private skillRefresh: Promise<void> | null = null;
  private skillRefreshAgain = false;
  private skills = new Map<string, { name: string; path: string } | null>();

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
    return (
      this.pendingPrompts.size > 0 ||
      this.turns.length > 0 ||
      this.compaction !== null ||
      this.runningCompactionTurns.size > 0
    );
  }

  // True while a settled caller's compaction can still start or finish its native turn.
  compactionUnresolved(): boolean {
    return this.unanswered.length > 0 || this.lostCompactionIdentity || this.ambiguousCompaction;
  }

  // Positive idle evidence: a root turn has ended in this child, and no root turn or request is open.
  // A compaction that got no answer can still start its late turn, so it also withholds the evidence.
  idleEvidence(): boolean {
    return (
      !this.closed &&
      !this.hasOpenTurns() &&
      !this.compactionUnresolved() &&
      this.runningRootTurns.size === 0 &&
      this.endedRootTurns > 0
    );
  }

  private seeTurn(turnId: string): void {
    if (!this.seenTurns.has(turnId)) this.seenTurns.set(turnId, this.seenTurns.size + 1);
  }

  private rootTurn(params: Json): string | null {
    const threadId = str(params.threadId);
    if (!this.thread || (threadId && threadId !== this.thread)) return null;
    return str(obj(params.turn)?.id) ?? str(params.turnId);
  }

  // Limits applied-default reads to server versions that pass `codexDefaultsQualified`.
  private defaultsQualified = false;

  async initialize(): Promise<Json> {
    const result = await this.request('initialize', {
      clientInfo: this.clientInfo,
      // The recovery fork uses `excludeTurns` so the server returns only the new id, and
      // app-server rejects that field unless the client opted into experimental fields.
      capabilities: { experimentalApi: true },
    });
    this.defaultsQualified = codexDefaultsQualified(str(result.userAgent));
    this.notify('initialized', {});
    return result;
  }

  // Lists panel commands and skills available in this working directory.
  commands(): Promise<PromptEntry[]> {
    if (this.commandsPending) return this.commandsPending;
    const pending = this.openCommands().finally(() => {
      if (this.commandsPending === pending) this.commandsPending = null;
    });
    this.commandsPending = pending;
    return pending;
  }

  private async openCommands(): Promise<PromptEntry[]> {
    this.commandsOpening = true;
    this.skills.clear();
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
    const skills = new Map<string, { name: string; path: string } | null>();
    for (const group of arr(result.data)) {
      for (const entry of arr(obj(group)?.skills)) {
        const skill = obj(entry);
        const name = skill && str(skill.name);
        const path = skill && str(skill.path);
        if (name && obj(group)?.cwd === this.cwd) {
          const key = name.toLowerCase();
          skills.set(
            key,
            skills.has(key) || skill?.enabled !== true || !path || !/^[a-z0-9][a-z0-9_.:-]*$/i.test(name)
              ? null
              : { name, path },
          );
        }
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
    if (!this.closed && !this.skillRefreshAgain) this.skills = skills;
    return commands;
  }

  private refreshCommandCatalog(): void {
    this.skills.clear();
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
          // Autocomplete retains its last complete catalog. Attachments require a successful current read.
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

  async startThread(
    options: CodexSpawnOptions,
    name: string = '',
    beforeWrite?: () => void,
    writeAttempted?: () => void,
  ): Promise<string> {
    const result = await this.request(
      'thread/start',
      {
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
        ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      },
      beforeWrite,
      writeAttempted,
    );
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
  async forkThread(
    threadId: string,
    options: CodexSpawnOptions,
    beforeWrite?: () => void,
    writeAttempted?: () => void,
  ): Promise<string> {
    return this.adoptThread(
      await this.request(
        'thread/fork',
        {
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
        },
        beforeWrite,
        writeAttempted,
      ),
    );
  }

  // Starts compaction through thread/compact/start.
  // Its response acknowledges startup. Turn notifications settle completion and report failures.
  // The pending operation keeps the session busy until completion.
  // Only deferred delivery passes beforeWrite, so its presence marks the request's receipt as deferred.
  async compact(beforeWrite?: () => void): Promise<void> {
    if (!this.thread) {
      throw new Error('no Codex session has been started yet');
    }
    if (this.hasOpenTurns()) {
      throw new Error('the session already has a turn running');
    }
    const deferred = beforeWrite !== undefined;
    if (this.unanswered.length >= UNANSWERED_COMPACTIONS) {
      if (deferred) throw new Error('the agent has not answered earlier compaction requests');
      // Deferred delivery waits while any receipt is open, so a full bound holds at most one deferred receipt.
      const dropped = this.unanswered.findIndex((receipt) => !receipt.deferred && receipt.turnId === null);
      if (dropped >= 0) this.unanswered.splice(dropped, 1);
      this.lostCompactionIdentity = true;
    }
    const pending = this.pendingCompaction(this.thread);
    this.compaction = pending;
    try {
      beforeWrite?.();
      this.emit({
        kind: 'native',
        event: {
          kind: 'submission',
          provider: 'codex',
          sessionId: pending.threadId,
          turnId: null,
          generation: pending.generation,
          evidence: {},
          text: '/compact',
        },
      });
      await this.request('thread/compact/start', { threadId: this.thread }, (id) => {
        pending.requestId = id;
      }).catch((error: unknown) => {
        if (error instanceof RequestRefused)
          this.emit({
            kind: 'native',
            event: {
              kind: 'compact',
              provider: 'codex',
              sessionId: pending.threadId,
              turnId: null,
              generation: pending.generation,
              evidence: { error: error.message },
              stage: 'refused',
            },
          });
        throw error;
      });
      this.emit({
        kind: 'native',
        event: {
          kind: 'compact',
          provider: 'codex',
          sessionId: pending.threadId,
          turnId: pending.turnId,
          generation: pending.generation,
          evidence: {},
          stage: 'accepted',
        },
      });
      const timer = setTimeout(() => {
        if (pending.turnId === null) pending.rejectFinished(new NoAnswer('the agent did not finish compaction'));
      }, this.deadlineMs);
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
      try {
        await pending.finished;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      // Caller settlement cannot end a native turn. Its receipt keeps ownership until termination.
      if (this.compaction === pending && (error instanceof NoAnswer || pending.turnId !== null)) {
        if (this.unanswered.length < UNANSWERED_COMPACTIONS)
          this.unanswered.push({
            requestId: pending.requestId!,
            generation: pending.generation,
            threadId: pending.threadId,
            turnId: pending.turnId,
            deferred,
          });
        else this.lostCompactionIdentity = true;
      }
      if (this.compaction === pending) {
        this.failCompaction(pending, error as Error);
      }
      throw error;
    }
  }

  // Returns the turn id after the server accepts the prompt.
  // Notifications report the turn's subsequent progress and completion.
  async prompt(input: AgentPromptInput, guard?: GuardedAttempt): Promise<string> {
    if (!this.thread) {
      throw new Error('no Codex session has been started yet');
    }
    if (guard && (this.closed || this.hasOpenTurns() || this.compactionUnresolved() || this.runningRootTurns.size))
      throw new Error('the session is not idle');
    const threadId = this.thread;
    const prompt = normalizeAgentPrompt(input);
    const first = prompt.text.search(/\S/);
    const token = first < 0 ? null : promptToken('codex', prompt.text, first);
    const previous = this.preparing;
    let release!: () => void;
    const prepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.preparing = prepared;
    let stopped = false;
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancel = () => {
        stopped = true;
        resolve();
      };
    });
    this.pendingPrompts.add(cancel);
    try {
      if (previous) await Promise.race([previous, cancelled]);
      if (token) {
        while (this.commandsPending || this.skillRefresh) {
          if (stopped) break;
          await Promise.race([this.commandsPending ?? this.skillRefresh, cancelled]);
        }
      }
      if (stopped) throw new Error('the prompt was stopped before it reached the agent');
      if (this.closed || threadId !== this.thread) throw new Error('the Codex session changed before delivery');
      return this.startPrompt(prompt, token, threadId, guard);
    } finally {
      this.pendingPrompts.delete(cancel);
      if (this.preparing === prepared) this.preparing = null;
      release();
    }
  }

  private async startPrompt(
    prompt: ReturnType<typeof normalizeAgentPrompt>,
    token: ReturnType<typeof promptToken>,
    threadId: string,
    guard?: GuardedAttempt,
  ): Promise<string> {
    const content: Record<string, unknown>[] = [];
    if (prompt.text) {
      content.push({ type: 'text', text: prompt.text });
    }
    const skill = token && this.skills.get(token.typed.toLowerCase());
    if (token && skill && !CODEX_COMMANDS.some((command) => command.name.toLowerCase() === token.typed.toLowerCase())) {
      content.push({ type: 'skill', name: skill.name, path: skill.path });
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
    // A guarded start records how many turns were known when it wrote its input. A response naming one of them is a shared turn.
    const known = guard ? this.seenTurns.size : 0;
    guard?.prepareWrite();
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
    guard?.markWritten();
    let active: ActiveTurn;
    const start = response.then((result) => {
      const turn = obj(result.turn);
      const turnId = turn && str(turn.id);
      if (!turnId) {
        throw new Error('the agent accepted a turn without naming it');
      }
      const shared =
        !!guard &&
        ((this.seenTurns.get(turnId) ?? Infinity) <= known ||
          this.turns.some((turn) => turn !== active && turn.id === turnId && turn.threadId === threadId));
      if (threadId === this.thread) this.seeTurn(turnId);
      guard?.settle(
        shared
          ? {
              outcome: 'unknown',
              nativeTurnId: turnId,
              reason: 'The prompt joined a turn that was already running.',
              sharedTurn: true,
            }
          : { outcome: 'accepted', nativeTurnId: turnId, reason: '' },
      );
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
      // The guarded rejection allowlist is empty. No error response proves this input had no effect.
      guard?.settle({ outcome: 'unknown', nativeTurnId: null, reason: (error as Error).message });
      throw error;
    }
  }

  // Stores permission overrides for the next prompt and subsequent turns.
  async setApproval(policy: ApprovalPolicy, sandbox: SandboxMode, reviewer: ApprovalsReviewer): Promise<void> {
    this.approval = { policy, reviewer, sandbox };
  }

  // Stores a model override for the next prompt and subsequent turns.
  // An empty selection clears the override and leaves the server's current model unchanged.
  async setModel(model: string): Promise<void> {
    this.model = model || null;
  }

  async setEffort(effort: string): Promise<void> {
    this.effort = effort || null;
  }

  async interrupt(): Promise<void> {
    for (const cancel of this.pendingPrompts) cancel();
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
    const nativeTurnId = this.runningCompactionTurns.values().next().value;
    if (nativeTurnId) {
      await this.request('turn/interrupt', { threadId: this.thread, turnId: nativeTurnId });
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

  private usageEligibility: Promise<boolean> | null = null;

  async usageSupported(rediscover = false): Promise<boolean> {
    if (rediscover || !this.usageEligibility) {
      const discovery = this.request('account/read', { refreshToken: false }).then(
        (answer) => obj(answer.account)?.type !== 'amazonBedrock',
      );
      this.usageEligibility = discovery;
      void discovery.catch(() => {
        if (this.usageEligibility === discovery) this.usageEligibility = null;
      });
    }
    return this.usageEligibility;
  }

  // What the reader's account has left. The server answers this on a bare handshake, with
  // no thread started and no prompt sent, so asking it costs no model tokens.
  async rateLimits(refreshAuthentication = false): Promise<Json> {
    if (!(await this.usageSupported())) return {};
    if (refreshAuthentication) {
      await this.request('account/read', { refreshToken: true });
    }
    return await this.request('account/rateLimits/read', {});
  }

  // Reads applied model and effort defaults for a supported server version.
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

  // Reads paginated MCP tool and authentication status without resources.
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

  // Server archiving moves the rollout file and applies across Codex clients.
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

  // Answers approvals and questions in their corresponding protocol shapes.
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
        this.emit({ kind: 'askResolved', id, outcome: answer.decision === 'deny' ? 'declined' : 'unknown' });
      }
      return true;
    }
    const pending = this.askIds.get(id);
    if (!pending) {
      return false;
    }
    this.askIds.delete(id);
    this.approvalRequests.delete(id);
    try {
      if (pending.method === USER_INPUT) {
        // User-input requests take an answer map. Denial returns an empty map.
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
    } catch {
      this.askIds.set(id, pending);
      this.emit({ kind: 'askResolved', id, outcome: 'failed' });
      this.emit({ kind: 'ask', ask: pending.ask });
      return false;
    }
    this.emit({ kind: 'askResolved', id, outcome: answer.decision === 'deny' ? 'declined' : 'unknown' });
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
    for (const cancel of this.pendingPrompts) cancel();
    this.turns.splice(0);
    if (this.compaction) {
      this.failCompaction(this.compaction, new Error(reason));
    }
    this.unanswered = [];
    this.runningCompactionTurns.clear();
    this.lostCompactionIdentity = false;
    this.ambiguousCompaction = false;
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
    // The wire ignores another thread's turns, so that thread's receipts can never end.
    this.unanswered = this.unanswered.filter((receipt) => receipt.threadId === id);
    if (previous !== id) {
      this.lostCompactionIdentity = false;
      this.ambiguousCompaction = false;
      this.runningRootTurns.clear();
      this.runningCompactionTurns.clear();
    }
    // An answer to a question asked on another thread must never reach this one. A cleared
    // session starts a new thread, so its open questions close with it.
    for (const [askId, asked] of [...this.asyncAsks]) {
      if (asked.threadId !== id) {
        this.asyncAsks.delete(askId);
        this.emit({ kind: 'askResolved', id: askId, outcome: 'cancelled' });
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
      // Refuse unsupported requests so they cannot stall the turn or receive an invalid answer.
      this.write({ id: requestId, error: { code: -32601, message: `the panel cannot answer ${method}` } });
      return;
    }
    const itemId = str(params.itemId) ?? `codex-${requestId}`;
    const ask = method === USER_INPUT ? this.userInputAsk(itemId, params) : this.approvalAsk(itemId, method, params);
    this.askIds.set(itemId, { requestId, method, ask });
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

  // Converts synchronous questions to the shared question ask with answers keyed by question id.
  // The card always offers written input, so isOther does not change its choices.
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
    return { kind: 'question', id: itemId, questions, input: params, toolUseId: str(params.itemId) ?? '' };
  }

  // Async questions have titles and plain option labels, without individual ids or descriptions.
  // Their reply-envelope ids come from asyncQuestionId.
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

  // Steers an answer into its running turn.
  // After the turn ends or the server refuses steering, send the same text as a prompt to the originating thread.
  // An unanswered request is never retried because its answer can already have arrived.
  private async sendAsyncReply(id: string, asked: AsyncAsk, text: string): Promise<void> {
    if (asked.turnId && asked.threadId) {
      try {
        await this.request('turn/steer', {
          threadId: asked.threadId,
          input: [{ type: 'text', text }],
          expectedTurnId: asked.turnId,
        });
        this.emit({ kind: 'askResolved', id, outcome: 'answered' });
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
      this.emit({ kind: 'askResolved', id, outcome: 'cancelled' });
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
        this.emit({ kind: 'askResolved', id, outcome: 'failed' });
        this.emit({ kind: 'ask', ask: asked.ask });
      } else {
        this.emit({ kind: 'askResolved', id, outcome: 'cancelled' });
      }
      return;
    }
    // After the prompt is accepted, so a session that reads this event sees the new turn open.
    this.emit({ kind: 'askResolved', id, outcome: 'answered' });
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
    this.emit({ kind: 'askResolved', id, outcome: 'unknown' });
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
        this.emit({ kind: 'askResolved', id: itemId, outcome: 'answered' });
      } else if (open.length < asked.ask.questions.length) {
        asked.ask = { ...asked.ask, questions: open };
        this.emit({ kind: 'ask', ask: asked.ask });
      }
    }
  }

  private notification(method: string, params: Json): void {
    switch (method) {
      case 'turn/started': {
        const turnId = this.rootTurn(params);
        if (turnId) {
          this.seeTurn(turnId);
          this.runningRootTurns.add(turnId);
        }
        this.startCompactionTurn(params);
        return;
      }
      case 'item/started':
        this.nativeItem(params, false);
        this.itemStarted(obj(params.item));
        return;
      case 'item/completed':
        this.nativeItem(params, true);
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
      // Streams agent-message text from delta. item/completed supplies the complete message.
      case 'item/agentMessage/delta': {
        const text = str(params.delta);
        if (!text) {
          return;
        }
        const itemId = str(params.itemId);
        const active = itemId ? this.activeItems.get(itemId) : null;
        // Known async and commentary items accumulate activity text outside the reply stream.
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
          this.nativeEnding(params);
          this.endRootTurn(params);
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
          this.nativeEnding(params, true);
          this.endRootTurn(params);
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
      requestId: null,
      generation: ++this.compactions,
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

  private nativeItem(params: Json, completed: boolean): void {
    const sessionId = str(params.threadId);
    const turnId = str(params.turnId);
    const item = obj(params.item);
    const toolId = str(item?.id);
    if (!sessionId || sessionId !== this.thread || !turnId || !item || !toolId) return;
    const base = { provider: 'codex' as const, sessionId, turnId, generation: null, evidence: params };
    if (item.type === 'commandExecution' && str(item.command)) {
      if (completed)
        this.emit({
          kind: 'native',
          event: { ...base, kind: 'toolEnd', toolId, success: item.status === 'completed' && item.exitCode === 0 },
        });
      else
        this.emit({
          kind: 'native',
          event: {
            ...base,
            kind: 'toolStart',
            toolId,
            command: str(item.command)!,
            initiating:
              item.status === 'inProgress' &&
              ((item.source === 'agent' && item.processId === null) ||
                (item.source === 'unifiedExecStartup' && typeof item.processId === 'string')),
          },
        });
    }
    if (item.type === 'contextCompaction') {
      if (this.runningRootTurns.has(turnId)) this.runningCompactionTurns.add(turnId);
      const generation = this.compactionTurn(turnId);
      this.emit({
        kind: 'native',
        event: { ...base, generation, kind: 'compact', stage: completed ? 'itemEnd' : 'itemStart' },
      });
    }
  }

  // Names the generation of the compaction that owns a turn, or null for any other turn.
  private compactionTurn(turnId: string): number | null {
    if (this.compaction?.turnId === turnId) return this.compaction.generation;
    return this.unanswered.find((receipt) => receipt.turnId === turnId)?.generation ?? null;
  }

  private nativeEnding(params: Json, failed = false): void {
    const sessionId = str(params.threadId);
    const turnId = str(obj(params.turn)?.id) ?? str(params.turnId);
    if (!sessionId || sessionId !== this.thread || !turnId) return;
    const base = { provider: 'codex' as const, sessionId, turnId, generation: null, evidence: params };
    const generation = this.compactionTurn(turnId);
    if (generation !== null || this.runningCompactionTurns.has(turnId)) {
      this.emit({ kind: 'native', event: { ...base, generation, kind: 'compact', stage: 'turnEnd' } });
    }
    if (generation === null)
      this.emit({
        kind: 'native',
        event: { ...base, kind: 'rootEnd', success: !failed && obj(params.turn)?.status === 'completed' },
      });
  }

  private endRootTurn(params: Json): void {
    const turnId = this.rootTurn(params);
    if (!turnId) return;
    this.seeTurn(turnId);
    this.runningRootTurns.delete(turnId);
    this.runningCompactionTurns.delete(turnId);

    this.endedRootTurns += 1;
    if (!this.compaction && !this.unanswered.length && !this.runningRootTurns.size) this.ambiguousCompaction = false;
  }

  private startCompactionTurn(params: Json): void {
    const pending = this.compaction;
    const turnId = str(obj(params.turn)?.id) ?? str(params.turnId);
    if (!turnId || str(params.threadId) !== this.thread || this.compactionTurn(turnId) !== null) return;
    const unbound = this.unanswered.filter((receipt) => receipt.turnId === null);
    const candidates = unbound.length + (pending && pending.turnId === null ? 1 : 0);
    if (candidates > 1 || (candidates > 0 && this.runningRootTurns.size > 1)) this.ambiguousCompaction = true;
    if (this.lostCompactionIdentity || this.ambiguousCompaction || this.turns.length > 0) return;
    const late = unbound[0];
    if (late && candidates === 1) {
      const turnId = str(obj(params.turn)?.id) ?? str(params.turnId);
      if (str(params.threadId) !== late.threadId || !turnId) return;
      late.turnId = turnId;
      this.runningCompactionTurns.add(turnId);
      this.emit({
        kind: 'native',
        event: {
          kind: 'compact',
          provider: 'codex',
          sessionId: late.threadId,
          turnId,
          generation: late.generation,
          evidence: params,
          stage: 'turnStart',
        },
      });
      return;
    }
    if (!pending || pending.turnId) {
      return;
    }
    const threadId = str(params.threadId);
    if (threadId && threadId !== pending.threadId) {
      return;
    }
    pending.turnId = turnId;
    this.runningCompactionTurns.add(turnId);
    if (threadId === pending.threadId)
      this.emit({
        kind: 'native',
        event: {
          kind: 'compact',
          provider: 'codex',
          sessionId: threadId,
          turnId,
          generation: pending.generation,
          evidence: params,
          stage: 'turnStart',
        },
      });
    pending.resolveStarted(turnId);
  }

  private finishCompaction(params: Json, outcome: TurnOutcome): boolean {
    if (str(params.threadId) !== this.thread) return false;
    // The late turn of an unanswered compaction ends its receipt and never settles a later compaction.
    const ended = str(obj(params.turn)?.id) ?? str(params.turnId);
    if (ended && this.unanswered.some((receipt) => receipt.turnId === ended)) {
      this.unanswered = this.unanswered.filter((receipt) => receipt.turnId !== ended);
      if (!this.unanswered.length && !this.compaction && !this.runningRootTurns.size) this.ambiguousCompaction = false;
      return false;
    }
    const pending = this.compaction;
    if (!pending) {
      return false;
    }
    const threadId = str(params.threadId);
    if (threadId && threadId !== pending.threadId) {
      return false;
    }
    const turnId = str(obj(params.turn)?.id) ?? str(params.turnId);
    if (!turnId || pending.turnId !== turnId) {
      return false;
    }
    this.compaction = null;
    if (outcome.status === 'ok') {
      pending.resolveFinished();
    } else {
      // Use the server's reason when present. An interrupted compaction has a fallback message.
      // Other failures keep an empty reason so the panel can report that none was supplied.
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
    if (!this.unanswered.length && !this.compaction && !this.runningRootTurns.size) this.ambiguousCompaction = false;
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
      // null means no question array. Arrays retain raw entries for itemCompleted to validate.
      // Entries without titles do not produce questions.
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
      // Async tools can set final_answer without ending the turn.
      // delivery identifies those items and keeps them out of the reply stream.
      if (delivery === 'async') {
        // Only entries with titles produce questions. An empty ask remains an activity message.
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

  // Reports available primary and secondary windows in that order.
  // Named updates retain their model scope. The usage strip chooses the binding window.
  private reportRateLimits(limits: Json | null): void {
    const scope = (limits && str(limits.limitName)) ?? '';
    const limitId = limits && str(limits.limitId);
    // Account updates without limitId remain unscoped.
    // Other identified buckets need a readable name to keep their figures separate from the account aggregate.
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
      const receipt = this.unanswered.find((entry) => entry.requestId === id);
      const failure = obj(message.error);
      if (receipt && failure) {
        // A refusal cannot remove a turn the server already reported as running.
        if (receipt.turnId === null) this.unanswered = this.unanswered.filter((entry) => entry !== receipt);
        if (!this.unanswered.length && !this.compaction && !this.runningRootTurns.size)
          this.ambiguousCompaction = false;
        this.emit({
          kind: 'native',
          event: {
            kind: 'compact',
            provider: 'codex',
            sessionId: receipt.threadId,
            turnId: receipt.turnId,
            generation: receipt.generation,
            evidence: { error: str(failure.message) ?? 'the agent refused the request' },
            stage: 'refused',
          },
        });
      }
      return;
    }
    const failure = obj(message.error);
    if (failure) {
      waiting.reject(new RequestRefused(str(failure.message) ?? 'the agent refused the request'));
    } else waiting.resolve(obj(message.result) ?? {});
  }

  private request(
    method: string,
    params: Json,
    beforeWrite?: (id: number) => void,
    writeAttempted?: () => void,
  ): Promise<Json> {
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
      // A pending request timer must not keep the extension host process alive.
      if (typeof timer === 'object' && typeof timer.unref === 'function') {
        timer.unref();
      }
      this.waiting.set(id, { resolve, reject, timer });
      try {
        beforeWrite?.(id);
        if (this.closed) throw new Error('the agent is no longer running');
        writeAttempted?.();
        if (this.closed) throw new Error('the agent is no longer running');
        this.write({ id, method, params });
      } catch (error) {
        this.take(id)?.reject(error as Error);
      }
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

// Names five-hour and seven-day windows. Other durations retain their minute count.
const WINDOW_NAMES: Record<number, string> = { 300: 'five_hour', 10080: 'seven_day' };

function windowName(minutes: number): string {
  return Object.prototype.hasOwnProperty.call(WINDOW_NAMES, minutes) ? WINDOW_NAMES[minutes] : `${minutes}_minute`;
}

// Groups five-hour windows as session and seven-day windows as weekly.
// Other durations remain ungrouped.
const WINDOW_GROUPS: Record<number, string> = { 300: 'session', 10080: 'weekly' };

function windowGroup(minutes: number): string {
  return Object.prototype.hasOwnProperty.call(WINDOW_GROUPS, minutes) ? WINDOW_GROUPS[minutes] : '';
}

// Converts primary and secondary limits to panel fractions in that order.
// Both request responses and notifications use this decoder.
// rateLimitsByLimitId inventory is excluded. Live named updates supply their own scope.
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

// Reads account usage from rateLimits, or returns null when no window has a used percentage.
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

// Reads model choices, including each model's hidden flag.
// Entries without an id are skipped because selections use that id.
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
      // Use the model id when displayName is absent.
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

// Reads an error string or an object's message field.
function errorText(error: unknown): string {
  return str(error) ?? str(obj(error)?.message) ?? '';
}

// Converts finished turns to shared outcomes, distinguishing interruptions from failures.
export function turnOutcome(turn: Json | null): TurnOutcome {
  const status = str(turn?.status) ?? '';
  const items = arr(turn?.items);
  let text = '';
  for (const entry of items) {
    const item = obj(entry);
    // Async final_answer items do not supply the turn outcome text.
    if (
      item &&
      str(item.type) === 'agentMessage' &&
      str(item.phase) === 'final_answer' &&
      str(item.delivery) !== 'async'
    ) {
      text = str(item.text) ?? text;
    }
  }
  // A noncompleted turn without reply text uses its error message.
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

// The first Codex version whose `config/read`, `model/list`, and `configRequirements/read`
// replies were confirmed to describe the model and effort a new thread applies.
const CODEX_DEFAULTS_FLOOR = parseVersion('0.159.2')!;

// Codex versions at or above the floor whose replies misdescribe the applied defaults.
// `last` is the last refused version. A range without `last` refuses every later release,
// because a change of reply meaning carries forward until native evidence shows a fix.
export interface CodexVersionRange {
  first: string;
  last?: string;
}

// Each entry names the evidence that refuses its range.
export const CODEX_DEFAULTS_REFUSED: readonly CodexVersionRange[] = [];

// Reads the version from the first `product/version` token of the server user agent.
// Codex names the product after the client, so the product name is not checked. A version
// below the floor, inside a refused range, or not parseable leaves defaults unavailable.
export function codexDefaultsQualified(
  userAgent: string | null | undefined,
  refused: readonly CodexVersionRange[] = CODEX_DEFAULTS_REFUSED,
): boolean {
  const token = /^[^\s/]+\/(\S+)/.exec(userAgent?.trim() ?? '');
  const version = token ? parseVersion(token[1]) : null;
  if (!version || compareVersion(version, CODEX_DEFAULTS_FLOOR) < 0) return false;
  return !refused.some((range) => {
    const first = parseVersion(range.first);
    const last = range.last === undefined ? null : parseVersion(range.last);
    // A range is unreadable when a bound does not parse or its last version ranks below its
    // first. An unreadable range refuses, so a mistyped entry cannot admit a refused version.
    if (!first || (range.last !== undefined && !last)) return true;
    if (last && compareVersion(last, first) < 0) return true;
    return compareVersion(version, first) >= 0 && (!last || compareVersion(version, last) <= 0);
  });
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
