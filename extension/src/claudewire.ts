import { unavailableDefaults, type AppliedDefaults } from './view/model-picks';
// Adapts Claude Code's headless protocol to panel events.
//
// The CLI uses newline-delimited JSON with `--input-format stream-json --output-format stream-json`.
// Session messages and control requests share stdin and stdout.
// The transport supplies `send` and forwards inbound lines to `receive`.

import * as fs from 'node:fs';

// Re-export the shared `agentwire.ts` types for Claude protocol callers.
export {
  PromptEntry,
  PermissionAsk,
  QuestionOption,
  Question,
  QuestionAsk,
  Ask,
  AskAnswer,
  TurnOutcome,
  RateLimit,
  SpendCap,
  UsageReading,
  UsageReadResult,
  EffortChoice,
  ModelChoice,
  ModelList,
  McpServer,
  WireActivity,
  WireEvent,
} from './agentwire';

import {
  PromptEntry,
  Question,
  QuestionOption,
  Ask,
  AskAnswer,
  TurnOutcome,
  RateLimit,
  SpendCap,
  UsageReading,
  UsageReadResult,
  EffortChoice,
  ModelChoice,
  ModelList,
  McpServer,
  WireActivity,
  WireEvent,
  Json,
  obj,
  str,
  num,
  arr,
  AgentPromptInput,
  normalizeAgentPrompt,
} from './agentwire';
import { agentTakesAsset, validatePromptAssetBytes } from './promptassets';
import { ClaudeResponseClock } from './outputrate';

type ClaudePromptBlock = Record<string, unknown>;

export async function claudePromptContent(
  input: AgentPromptInput,
  readFile: (filePath: string) => Promise<Uint8Array> = fs.promises.readFile,
): Promise<ClaudePromptBlock[]> {
  const prompt = normalizeAgentPrompt(input);
  const content: ClaudePromptBlock[] = [];
  if (prompt.text) {
    content.push({ type: 'text', text: prompt.text });
  }
  for (const asset of prompt.assets) {
    if (!agentTakesAsset('claude', asset.mime)) {
      throw new Error(`${asset.name} (${asset.mime}) is not a supported Claude attachment`);
    }
    const bytes = await readFile(asset.path);
    validatePromptAssetBytes(asset, bytes);
    if (asset.mime.startsWith('image/')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: asset.mime, data: Buffer.from(bytes).toString('base64') },
      });
      continue;
    }
    if (asset.mime === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: asset.mime, data: Buffer.from(bytes).toString('base64') },
        title: asset.name,
      });
      continue;
    }
    if (asset.mime.startsWith('text/')) {
      content.push({
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: Buffer.from(bytes).toString('utf8') },
        title: asset.name,
      });
      continue;
    }
    throw new Error(`${asset.name} (${asset.mime}) is not a supported Claude attachment`);
  }
  if (!content.length) {
    throw new Error('the prompt has no text or attachments');
  }
  return content;
}

// `mcpview.ts` owns MCP server decoding and presentation.
import { readMcpServers } from './mcpview';
import { activityDetail } from './activitydetail';
import { contextFrameId, CONTEXT_FRAME_BYTES, CONTEXT_DEADLINE_MS, CONTEXT_PENDING_LIMIT } from './contextframe';
import { sessionRenameTitle } from './sessionrename';

// The modes `--permission-mode` accepts include `default`, which the CLI help omits.
// Check the accepted values when updating the CLI. An unsupported mode prevents child startup.
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

export interface SpawnOptions {
  cwd: string;
  model?: string;
  // The initial effort level comes from the model's `list_models` entry.
  // Later changes use the CLI's `/effort` command through `effortCommand`.
  effort?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  sessionId?: string;
  persistSession?: boolean;
  settings?: string;
}

// `-p` enables print mode and streamed stdin.
// `--verbose` is required for stream-json output.
// `--permission-prompt-tool stdio` enables permission asks in headless mode, although the CLI help omits it.
// `--include-partial-messages` enables response deltas while the model works.
export function spawnArgs(o: SpawnOptions): string[] {
  const args = [
    '-p',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--permission-prompt-tool',
    'stdio',
    '--include-partial-messages',
  ];
  if (o.permissionMode) {
    args.push('--permission-mode', o.permissionMode);
  }
  if (o.model) {
    args.push('--model', o.model);
  }
  if (o.effort) {
    args.push('--effort', o.effort);
  }
  if (o.resume) {
    args.push('--resume', o.resume);
  }
  if (o.sessionId) {
    args.push('--session-id', o.sessionId);
  }
  if (o.persistSession === false) {
    args.push('--no-session-persistence');
  }
  if (o.settings) {
    args.push('--settings', o.settings);
  }
  return args;
}

function readCommands(v: unknown): PromptEntry[] {
  const out: PromptEntry[] = [];
  for (const entry of arr(v)) {
    const c = obj(entry);
    const name = c && str(c.name);
    if (!name) {
      continue;
    }
    out.push({
      kind: 'command',
      name,
      description: (c && str(c.description)) ?? '',
      argumentHint: (c && str(c.argumentHint)) ?? '',
    });
  }
  return out;
}

// Reads skill names from the `init` system message, including plugin-qualified names such as `plain-language:plain-language`.
// A missing or non-array value returns null. An empty array reports no skills.
function readSkills(v: unknown): string[] | null {
  if (!Array.isArray(v)) {
    return null;
  }
  return v.map((entry) => str(entry)).filter((name): name is string => !!name);
}

// Converts the `get_usage` response to the panel's usage values.
// Account percentages become fractions, matching live rate-limit events. Reset times become epoch seconds.
// `rate_limits_available: false` reports unavailable limits, rather than zero usage.
// A nonempty decoded `rate_limits.limits` list supplies window groups and model scopes.
// Otherwise, only the named `five_hour` and `seven_day` windows supply limits.
// Other window keys stay unread because they do not establish supported windows.
export function readUsageResult(payload: unknown, readAt: number): UsageReadResult {
  return obj(payload)?.rate_limits_available === false ? 'unavailable' : readUsage(payload, readAt);
}

export function readUsage(payload: unknown, readAt: number): UsageReading | null {
  const m = obj(payload);
  if (!m) {
    return null;
  }
  if (m.rate_limits_available === false) {
    return null;
  }
  const windows = obj(m.rate_limits);
  if (!windows) {
    return null;
  }
  const listed = readLimitList(windows?.limits);
  const limits = listed.length ? listed : readNamedWindows(windows);
  const spend = readSpendCap(windows?.spend);
  return {
    plan: str(m.subscription_type) ?? '',
    limits,
    complete: true,
    spend,
    creditResetsAtSeconds: null,
    readAt,
  };
}

// Reads each limit's `kind`, `group`, and optional `scope.model.display_name`.
// `severity` and `is_active` do not filter limits. Inactive weekly limits still carry reported usage.
function readLimitList(value: unknown): RateLimit[] {
  const out: RateLimit[] = [];
  for (const entry of arr(value)) {
    const e = obj(entry);
    const window = e && str(e.kind);
    const percent = e && num(e.percent);
    if (!e || !window || percent === null) {
      continue;
    }
    out.push({
      window,
      utilization: percent / 100,
      resetsAtSeconds: readResetTime(e.resets_at),
      status: str(e.status) ?? '',
      group: str(e.group) ?? '',
      scope: str(obj(obj(e.scope)?.model)?.display_name) ?? '',
    });
  }
  return out;
}

// Reads named windows when the decoded `limits` list is empty. Each window's name determines its group, with no model scope.
function readNamedWindows(windows: Json | null): RateLimit[] {
  const out: RateLimit[] = [];
  for (const window of ['five_hour', 'seven_day']) {
    const w = obj(windows?.[window]);
    const utilization = w && num(w.utilization);
    if (!w || utilization === null) {
      continue;
    }
    out.push({
      window,
      utilization: utilization / 100,
      resetsAtSeconds: readResetTime(w.resets_at),
      status: str(w.status) ?? '',
      group: windowGroup(window),
      scope: '',
    });
  }
  return out;
}

// Reads the account's money cap from `spend`. Disabled caps and nonpositive limits return null.
function readSpendCap(value: unknown): SpendCap | null {
  const spend = obj(value);
  if (!spend || spend.enabled === false || (spend.disabled_reason !== null && spend.disabled_reason !== undefined)) {
    return null;
  }
  const usedMinor = num(obj(spend.used)?.amount_minor);
  const limit = obj(spend.limit);
  const limitMinor = num(limit?.amount_minor);
  if (usedMinor === null || limitMinor === null || limitMinor <= 0) {
    return null;
  }
  return {
    usedMinor,
    limitMinor,
    exponent: num(limit?.exponent) ?? 2,
    currency: str(limit?.currency) ?? '',
    utilization: usedMinor / limitMinor,
  };
}

// Maps named windows to their groups. Unknown window names stay ungrouped.
const WINDOW_GROUPS: Record<string, string> = {
  five_hour: 'session',
  seven_day: 'weekly',
  // `usageview.ts` excludes this window from the account usage bar through `isModelBucketWindow`.
  seven_day_overage_included: 'weekly-overage',
};

function windowGroup(window: string): string {
  return Object.prototype.hasOwnProperty.call(WINDOW_GROUPS, window) ? WINDOW_GROUPS[window] : '';
}

// Reads the `unifiedWindows` set attached to a model response.
function readUnifiedWindows(value: unknown): RateLimit[] {
  const windows = obj(value);
  if (!windows) {
    return [];
  }
  const out: RateLimit[] = [];
  for (const window of ['five_hour', 'seven_day', 'seven_day_overage_included']) {
    const entry = obj(windows[window]);
    const utilization = entry && num(entry.utilization);
    if (!entry || utilization === null) {
      continue;
    }
    out.push({
      window,
      utilization,
      resetsAtSeconds: readResetTime(entry.resetsAt),
      status: '',
      group: windowGroup(window),
      scope: '',
    });
  }
  return out;
}

// Decodes `list_models` for the panel. A model needs a nonempty `value` for `set_model`.
export function readModels(payload: unknown, readAt: number): ModelList | null {
  const models: ModelChoice[] = [];
  for (const entry of arr(obj(payload)?.models)) {
    const model = obj(entry);
    const value = model && str(model.value);
    if (!model || !value) {
      continue;
    }
    const resolvedModel = str(model.resolvedModel)?.trim() || null;
    const efforts: EffortChoice[] = [];
    // Each advertised effort level supplies its own label. The CLI supplies no effort description.
    if (model.supportsEffort === true) {
      for (const level of arr(model.supportedEffortLevels)) {
        const name = str(level);
        if (name) {
          efforts.push({ value: name, label: name, description: '' });
        }
      }
    }
    models.push({
      value,
      ...(resolvedModel ? { resolvedModel } : {}),
      // Use the protocol value when `displayName` is not a string.
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

// Converts numeric seconds or a parseable date string to epoch seconds. Invalid values return null.
function readResetTime(value: unknown): number | null {
  const seconds = num(value);
  if (seconds !== null) {
    return seconds;
  }
  const text = str(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
}

function readQuestions(v: unknown): Question[] {
  const out: Question[] = [];
  for (const entry of arr(v)) {
    const q = obj(entry);
    const question = q && str(q.question);
    if (!question) {
      continue;
    }
    const options: QuestionOption[] = [];
    for (const o of arr(q?.options)) {
      const opt = obj(o);
      const label = opt && str(opt.label);
      if (label) {
        options.push({ label, description: (opt && str(opt.description)) ?? '' });
      }
    }
    out.push({
      // Claude's answers map is keyed by the question's own text, so that is the id.
      id: question,
      question,
      header: (q && str(q.header)) ?? '',
      options,
      multiSelect: q?.multiSelect === true,
      secret: false,
    });
  }
  return out;
}

// Claude reports interrupts as failed results. `aborted_streaming`, `aborted_tools` and `aborted` take precedence over `is_error`.
// A Stop while a tool runs ends with `aborted_tools`.
function readOutcome(m: Json): TurnOutcome {
  const terminal = str(m.terminal_reason);
  const failed = m.is_error === true;
  const status: TurnOutcome['status'] =
    terminal === 'aborted_streaming' || terminal === 'aborted_tools' || terminal === 'aborted'
      ? 'interrupted'
      : failed
        ? 'error'
        : 'ok';
  const denied: string[] = [];
  for (const entry of arr(m.permission_denials)) {
    const d = obj(entry);
    const name = d && str(d.tool_name);
    if (name) {
      denied.push(name);
    }
  }
  return {
    status,
    text: str(m.result) ?? '',
    costUsd: num(m.total_cost_usd),
    turns: num(m.num_turns),
    deniedTools: denied,
  };
}

// Holds a pending control request. Responses, deadlines, transport errors, and wire closure settle its promise.
interface Waiting {
  resolve(value: Json): void;
  reject(error: Error): void;
  // Cleared wherever the entry leaves the map, so a settled request leaves no timer behind.
  timer: ReturnType<typeof setTimeout> | null;
}

// Control requests expire after one minute so unanswered reads do not block later reads indefinitely.
// Turn events have no control-request deadline.
export const CONTROL_DEADLINE_MS = 60_000;

// The origin Claude Code writes on a prompt a person typed. See `ClaudeWire.prompt`.
const HUMAN_ORIGIN = { kind: 'human' } as const;

export interface WireOptions {
  now?(): number;
  // Receives each outbound JSON line with its terminating newline.
  send(line: string): void;
  // Every event the panel acts on.
  emit(event: WireEvent): void;
  // Supplies request ids. Tests override the generated ids.
  nextId?(): string;
  // Overrides the control-request deadline.
  deadlineMs?: number;
  // Seeds the session id from the launch options before the CLI reports it.
  sessionId?: string;
  // Supplies attachment bytes. Tests override the reader to control file preparation.
  readFile?(filePath: string): Promise<Uint8Array>;
}

function claudeToolActivity(block: Json): WireActivity | null {
  const sourceId = str(block.id);
  if (!sourceId) {
    return null;
  }
  const name = str(block.name) ?? 'Tool';
  // The question card displays this tool's text. Suppress duplicate tool activity.
  if (name === 'AskUserQuestion') {
    return null;
  }
  const input = obj(block.input) ?? {};
  const description = str(input.description) ?? '';
  const detail = activityDetail(name, input).exact;
  return {
    sourceId,
    kind: 'tool',
    name,
    headline: name === 'Bash' && description ? description : description || name,
    detail,
    status: 'running',
  };
}

export class ClaudeWire {
  private readonly responseClock = new ClaudeResponseClock();
  private responseTimingBlocked = false;
  private readonly now: () => number;
  private readonly send: (line: string) => void;
  private readonly emit: (event: WireEvent) => void;
  private readonly nextId: () => string;
  private readonly deadlineMs: number;
  private readonly readFile: (filePath: string) => Promise<Uint8Array>;
  private readonly waiting = new Map<string, Waiting>();
  private readonly asks = new Map<string, Ask>();
  private readonly textOrdinals = new Map<string, number>();
  private pendingText: { base: string; blocks: string[] } | null = null;
  private streamingMessageId: string | null = null;
  private counter = 0;
  private promptGeneration = 0;
  private nativeGeneration = 0;
  private closed = false;
  private readonly contextRequests = new Set<string>();

  contextFrame(text: string): string | null {
    if (!this.contextRequests.size) return null;
    const id = contextFrameId(text);
    return id && this.contextRequests.has(id) ? id : null;
  }

  contextOverflow(id: string): void {
    this.take(id)?.reject(new Error('context response exceeds its limit'));
  }

  // Seeds the launch session id and follows later `session_id` changes, including `/clear` successors.
  // The initialize reply names no session, so the seed identifies resumed work before the first prompt produces output.
  private session: string | null = null;

  constructor(options: WireOptions) {
    this.now = options.now ?? (() => performance.now());
    this.send = options.send;
    this.emit = options.emit;
    this.nextId = options.nextId ?? (() => `arc_${++this.counter}`);
    this.deadlineMs = options.deadlineMs ?? CONTROL_DEADLINE_MS;
    this.readFile = options.readFile ?? fs.promises.readFile;
    this.session = options.sessionId ?? null;
  }

  sessionId(): string | null {
    return this.session;
  }

  // Initializes the control channel before the first prompt and reads the command list.
  // Empty `supportedDialogKinds` leaves unsupported dialogs to the CLI.
  async initialize(): Promise<PromptEntry[]> {
    const response = await this.request({ subtype: 'initialize', supportedDialogKinds: [] });
    const commands = readCommands(response.commands);
    this.emit({ kind: 'ready', commands });
    return commands;
  }

  // Sends a prompt and rejects delivery if the wire closes or Stop cancels prompts during attachment preparation.
  // Every prompt carries a human origin. The transcript's `agentRunIn` rule uses it to identify reader-owned sessions across windows.
  prompt(input: AgentPromptInput, beforeWrite?: () => void): Promise<void> {
    this.responseClock.reset();
    if (this.closed) {
      throw new Error('the agent is no longer running');
    }
    const prompt = normalizeAgentPrompt(input);
    if (!prompt.assets.length && prompt.text) {
      beforeWrite?.();
      this.nativeSubmission(prompt.text);
      this.write({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt.text }] },
        origin: HUMAN_ORIGIN,
      });
      return Promise.resolve();
    }
    const generation = this.promptGeneration;
    return claudePromptContent(prompt, this.readFile).then((content) => {
      if (this.closed) {
        throw new Error('the agent is no longer running');
      }
      if (generation !== this.promptGeneration) {
        throw new Error('the prompt was stopped before it reached the agent');
      }
      beforeWrite?.();
      this.nativeSubmission(prompt.text);
      this.write({ type: 'user', message: { role: 'user', content }, origin: HUMAN_ORIGIN });
    });
  }

  // Renames the session through a control request, including while a turn runs.
  // The CLI writes the transcript and saved title without producing a turn result or cost.
  // `source: 'host'` marks a reader rename. `session_id` prevents renaming a different session after the child changes sessions.
  // The caller cleans the title. This method rejects invisible titles and sends valid titles unchanged.
  async renameSession(sessionId: string, title: string): Promise<void> {
    if (this.closed) {
      throw new Error('the agent is no longer running');
    }
    if (sessionRenameTitle(title) === null) {
      throw new Error('Enter a name.');
    }
    await this.request({ subtype: 'rename_session', title, source: 'host', session_id: sessionId });
  }

  // Changes effort through the CLI's `/effort` command because the control channel has no effort subtype.
  // The CLI handles the command and emits a `result`, which the host books as a separate turn.
  // The human origin identifies the command as a reader action.
  async effortCommand(effort: string): Promise<void> {
    if (this.closed) {
      throw new Error('the agent is no longer running');
    }
    // A bare `/effort` opens a CLI menu. Require a level for this setting change.
    if (!effort) {
      throw new Error('the effort command needs a level to set');
    }
    this.write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `/effort ${effort}` }] },
      origin: HUMAN_ORIGIN,
    });
  }

  // Stops the active turn. `cancelQueued` also cancels queued prompts and prevents pending attachments from reaching the child.
  async interrupt(cancelQueued = false): Promise<void> {
    this.responseClock.reset();
    this.responseTimingBlocked = true;
    if (cancelQueued) {
      this.promptGeneration += 1;
    }
    await this.request(cancelQueued ? { subtype: 'interrupt', cancel_queued: true } : { subtype: 'interrupt' });
  }

  async setModel(model: string): Promise<void> {
    await this.request({ subtype: 'set_model', model });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.request({ subtype: 'set_permission_mode', mode });
  }

  // Reads account usage through `get_usage`, the source for `/usage`.
  async usage(): Promise<Json> {
    return await this.request({ subtype: 'get_usage' });
  }

  // Reads context through `get_context_usage`, the source for `/context`.
  async contextUsage(): Promise<Json> {
    if (this.contextRequests.size >= CONTEXT_PENDING_LIMIT) throw new Error('context responses remain undrained');
    return await this.request({ subtype: 'get_context_usage', detail: 'summary' }, CONTEXT_DEADLINE_MS, true);
  }

  // Reads applied settings through `get_settings`. A failed request returns unavailable defaults.
  async appliedDefaults(): Promise<AppliedDefaults> {
    try {
      return readAppliedDefaults(await this.request({ subtype: 'get_settings' }));
    } catch {
      return unavailableDefaults('Claude did not report its settings.');
    }
  }

  // Reads the model catalog. A failed request returns null.
  async listModels(): Promise<Json | null> {
    try {
      return await this.request({ subtype: 'list_models' });
    } catch {
      return null;
    }
  }

  // Reads MCP server status on demand because the CLI sends no unsolicited server-status updates.
  // A failed request returns null.
  async mcpStatus(): Promise<McpServer[] | null> {
    try {
      return readMcpServers(await this.request({ subtype: 'mcp_status' }));
    } catch {
      return null;
    }
  }

  // Sets a server's enabled state. The CLI requires `serverName` and treats an omitted `enabled` as false.
  // Sending the same value twice preserves the state. Request failures reach the caller.
  async mcpToggle(serverName: string, enabled: boolean): Promise<void> {
    await this.request({ subtype: 'mcp_toggle', serverName, enabled });
  }

  // Reconnects a failed server. The request resolves when the CLI connects and rejects with the connection error on failure.
  async mcpReconnect(serverName: string): Promise<void> {
    await this.request({ subtype: 'mcp_reconnect', serverName });
  }

  pendingAsk(id: string): Ask | null {
    return this.asks.get(id) ?? null;
  }

  pendingAsks(): Ask[] {
    return [...this.asks.values()];
  }

  // Answers a pending ask to unblock the CLI. An unknown id returns false without sending a response.
  answer(id: string, answer: AskAnswer): boolean {
    const ask = this.asks.get(id);
    if (!ask) {
      return false;
    }
    this.asks.delete(id);
    let response: Json;
    if (answer.decision === 'deny') {
      response = { behavior: 'deny', message: answer.reason };
    } else if (answer.decision === 'answer') {
      // Allow the question tool with an `answers` map keyed by question text.
      // Join selected labels and written text into one string per question. Preserve the remaining input.
      const answers: Record<string, string> = {};
      for (const [id, picked] of Object.entries(answer.answers)) {
        answers[id] = [...picked.labels, ...(picked.written ? [picked.written] : [])].join(', ');
      }
      response = { behavior: 'allow', updatedInput: { ...ask.input, answers } };
    } else {
      response = { behavior: 'allow', updatedInput: ask.input };
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
    this.emit({ kind: 'askResolved', id });
    return true;
  }

  // Reads one stdout line. Report invalid JSON and continue receiving later lines.
  receive(line: string): void {
    const contextId = this.contextFrame(line);
    if (contextId && Buffer.byteLength(line, 'utf8') > CONTEXT_FRAME_BYTES) {
      this.contextOverflow(contextId);
      this.contextRequests.delete(contextId);
      return;
    }
    if (contextId) this.contextRequests.delete(contextId);
    const text = line.trim();
    if (!text) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.responseClock.reset();
      this.emit({ kind: 'error', message: `unreadable line from the agent: ${text.slice(0, 200)}` });
      return;
    }
    const m = obj(parsed);
    if (!m) {
      return;
    }

    const session = str(m.session_id);
    if (session && session !== this.session) {
      this.responseClock.reset();
      if (this.session !== null) this.responseTimingBlocked = true;
      // Preserve the previous session id for the session-change event.
      const previous = this.session;
      this.session = session;
      this.emit({ kind: 'session', sessionId: session, previous });
    }

    this.nativeMessage(m);
    switch (str(m.type)) {
      case 'control_response':
        this.settle(obj(m.response));
        return;
      case 'control_request':
        this.incoming(m);
        return;
      case 'assistant':
        this.assistant(obj(m.message));
        return;
      case 'stream_event':
        {
          const timing = this.closed || this.responseTimingBlocked ? {} : this.responseClock.observe(m, this.now());
          if (timing.started) this.emit({ kind: 'responseStarted', sourceId: timing.started });
          if (timing.completed)
            this.emit({ kind: 'responseRate', sourceId: timing.completed.responseId, rate: timing.completed });
        }
        this.partial(obj(m.event));
        return;
      case 'result':
        this.responseClock.reset();
        this.responseTimingBlocked = false;
        this.emit({ kind: 'turnEnd', outcome: readOutcome(m) });
        return;
      case 'rate_limit_event':
        this.rateLimit(obj(m.rate_limit_info));
        return;
      case 'system': {
        const subtype = str(m.subtype);
        if (subtype === 'thinking_tokens') {
          this.emit({ kind: 'thinking' });
        }
        // Sent only when the child runs with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`. `idle` follows
        // the last `result` once no prompt waits in the CLI, and it does not wait for background
        // tasks. `requires_action` is a running turn that waits on a permission answer.
        if (subtype === 'session_state_changed') {
          const state = str(m.state);
          if (state === 'idle') this.emit({ kind: 'sessionState', state: 'idle' });
          else if (state === 'running' || state === 'requires_action')
            this.emit({ kind: 'sessionState', state: 'running' });
        }
        // The CLI sends `init` after the first prompt and repeats it for local commands.
        // Read its skill catalog whenever present. A missing or non-array `skills` value emits no catalog event.
        const skills = subtype === 'init' ? readSkills(m.skills) : null;
        if (skills !== null) {
          this.emit({ kind: 'skills', skills });
        }
        const permissionMode = subtype === 'init' ? str(m.permissionMode) : null;
        if (permissionMode && this.session) {
          this.emit({ kind: 'permissionMode', sessionId: this.session, mode: permissionMode });
        }
        return;
      }
      default:
        return;
    }
  }

  private nativeSubmission(text: string): void {
    this.nativeGeneration++;
    if (this.session)
      this.emit({
        kind: 'native',
        event: {
          kind: 'submission',
          provider: 'claude',
          sessionId: this.session,
          generation: this.nativeGeneration,
          turnId: null,
          text,
          evidence: {},
        },
      });
  }

  private nativeMessage(message: Json): void {
    const sessionId = str(message.session_id);
    if (this.closed || !sessionId || sessionId !== this.session) return;
    const base = {
      provider: 'claude' as const,
      sessionId,
      generation: this.nativeGeneration,
      turnId: null,
      evidence: message,
    };
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      for (const block of arr(obj(message.message)?.content)) {
        const tool = obj(block);
        const input = obj(tool?.input);
        const command = str(input?.command);
        const toolId = str(tool?.id);
        if (
          tool?.type === 'tool_use' &&
          tool.name === 'Bash' &&
          obj(tool.caller)?.type === 'direct' &&
          command &&
          toolId
        )
          this.emit({
            kind: 'native',
            event: { ...base, kind: 'toolStart', toolId, command, foreground: input?.run_in_background !== true },
          });
      }
    }
    if (message.type === 'user' && message.parent_tool_use_id === null) {
      for (const block of arr(obj(message.message)?.content)) {
        const tool = obj(block);
        const toolId = str(tool?.tool_use_id);
        if (tool?.type === 'tool_result' && toolId)
          this.emit({
            kind: 'native',
            event: {
              ...base,
              kind: 'toolEnd',
              toolId,
              success: tool.is_error === false && obj(message.tool_use_result)?.interrupted === false,
            },
          });
      }
    }
    if (
      message.type === 'result' &&
      (message.parent_tool_use_id === undefined || message.parent_tool_use_id === null) &&
      str(message.uuid) &&
      Number.isSafeInteger(message.result_index)
    ) {
      if (message.local_command === 'compact')
        this.emit({ kind: 'native', event: { ...base, kind: 'compact', stage: 'turnEnd' } });
      else if (message.local_command === undefined && typeof message.num_turns === 'number' && message.num_turns > 0)
        this.emit({
          kind: 'native',
          event: {
            ...base,
            kind: 'rootEnd',
            success:
              message.subtype === 'success' && message.is_error === false && message.terminal_reason === 'completed',
          },
        });
    }
    if (message.type === 'system' && (message.subtype === 'status' || message.subtype === 'compact_boundary'))
      this.emit({
        kind: 'native',
        event: { ...base, kind: 'compact', stage: message.subtype === 'status' ? 'status' : 'boundary' },
      });
  }

  // Rejects pending control requests and clears asks when the child exits.
  close(reason: string): void {
    this.responseClock.reset();
    this.contextRequests.clear();
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [, waiting] of this.waiting) {
      if (waiting.timer) {
        clearTimeout(waiting.timer);
      }
      waiting.reject(new Error(reason));
    }
    this.waiting.clear();
    this.asks.clear();
  }

  private assistant(message: Json | null): void {
    if (!message) {
      return;
    }
    const stopReason = str(message.stop_reason);
    const commentary = stopReason === 'tool_use';
    const messageBase = str(message.id) ?? str(message.message_id);
    const textBlocks = arr(message.content)
      .map((block) => {
        const value = obj(block);
        return value && str(value.type) === 'text' ? (str(value.text) ?? '') : '';
      })
      .filter(Boolean);
    if (textBlocks.length) {
      if (commentary) {
        const toolId =
          arr(message.content)
            .map((block) => str(obj(block)?.id))
            .find((id) => id) ?? null;
        const base =
          str(message.id) ??
          str(message.message_id) ??
          (toolId ? `${toolId}:commentary` : `claude-message-${++this.counter}`);
        const firstOrdinal = this.textOrdinals.get(base) ?? 0;
        textBlocks.forEach((text, offset) => {
          const sourceId = `${base}:text:${firstOrdinal + offset}`;
          this.emit({
            kind: 'activity',
            activity: {
              sourceId,
              kind: 'commentary',
              name: 'Update',
              headline: 'Worked',
              detail: text,
              status: 'done',
            },
          });
        });
        this.textOrdinals.set(base, firstOrdinal + textBlocks.length);
      } else if (!stopReason && messageBase) {
        if (this.pendingText?.base === messageBase) {
          this.pendingText.blocks.push(...textBlocks);
        } else {
          this.pendingText = { base: messageBase, blocks: [...textBlocks] };
        }
      } else {
        const text = textBlocks.join('\n');
        this.emit({ kind: 'text', text, ...(messageBase ? { sourceId: messageBase } : {}) });
      }
    }
    const hasTool = arr(message.content).some((block) => str(obj(block)?.type) === 'tool_use');
    if (hasTool) {
      this.flushPendingText(true);
    }
    for (const block of arr(message.content)) {
      const b = obj(block);
      if (!b) {
        continue;
      }
      if (str(b.type) === 'tool_use') {
        const activity = claudeToolActivity(b);
        if (activity) {
          this.emit({ kind: 'activity', activity });
        }
      }
    }
  }

  // Reads stream events enabled by `--include-partial-messages`.
  //
  //   {"type":"stream_event","event":{"type":"content_block_delta","index":1,
  //     "delta":{"type":"text_delta","text":"one, two, three"}}}
  //
  // Message starts supply the response id. Message deltas classify buffered assistant text using the stop reason.
  // Only text deltas become response deltas. Thinking deltas do not become response text.
  private partial(event: Json | null): void {
    if (!event) {
      return;
    }
    if (str(event.type) === 'message_start') {
      this.streamingMessageId = str(obj(event.message)?.id);
      return;
    }
    if (str(event.type) === 'message_delta') {
      const stopReason = str(obj(event.delta)?.stop_reason);
      if (stopReason) {
        this.flushPendingText(stopReason === 'tool_use');
      }
      return;
    }
    if (str(event.type) !== 'content_block_delta') {
      return;
    }
    const delta = obj(event.delta);
    if (!delta || str(delta.type) !== 'text_delta') {
      return;
    }
    const text = str(delta.text);
    if (text) {
      this.emit({ kind: 'delta', text, ...(this.streamingMessageId ? { sourceId: this.streamingMessageId } : {}) });
    }
  }

  private flushPendingText(commentary: boolean): void {
    const pending = this.pendingText;
    if (!pending) {
      return;
    }
    this.pendingText = null;
    if (!commentary) {
      this.emit({ kind: 'text', text: pending.blocks.join('\n'), sourceId: pending.base });
      return;
    }
    const firstOrdinal = this.textOrdinals.get(pending.base) ?? 0;
    pending.blocks.forEach((text, offset) =>
      this.emit({
        kind: 'activity',
        activity: {
          sourceId: `${pending.base}:text:${firstOrdinal + offset}`,
          kind: 'commentary',
          name: 'Update',
          headline: 'Worked',
          detail: text,
          status: 'done',
        },
      }),
    );
    this.textOrdinals.set(pending.base, firstOrdinal + pending.blocks.length);
  }

  private rateLimit(info: Json | null): void {
    if (!info) {
      return;
    }
    const creditResetsAtSeconds = num(info.overageResetsAt);
    const unified = readUnifiedWindows(info.unifiedWindows);
    if (unified.length) {
      for (const limit of unified) {
        this.emit({ kind: 'rateLimit', limit, creditResetsAtSeconds });
      }
      return;
    }
    const utilization = num(info.utilization);
    if (utilization === null) {
      if (creditResetsAtSeconds !== null) {
        this.emit({ kind: 'rateLimit', limit: null, creditResetsAtSeconds });
      }
      return;
    }
    const window = str(info.rateLimitType) ?? 'unknown';
    this.emit({
      kind: 'rateLimit',
      creditResetsAtSeconds,
      limit: {
        window,
        utilization,
        resetsAtSeconds: num(info.resetsAt),
        status: str(info.status) ?? '',
        // The event has no group or model scope. Derive the group from the window name and leave the scope empty.
        group: windowGroup(window),
        scope: '',
      },
    });
  }

  // Answers `can_use_tool` requests and rejects unsupported control requests.
  // Leave `request_user_dialog` unanswered because this client declares no supported dialog kinds.
  private incoming(m: Json): void {
    const id = str(m.request_id);
    const request = obj(m.request);
    if (!id || !request) {
      return;
    }
    const subtype = str(request.subtype);
    if (subtype !== 'can_use_tool') {
      if (subtype === 'request_user_dialog') {
        return;
      }
      this.write({
        type: 'control_response',
        response: { subtype: 'error', request_id: id, error: `the panel cannot answer ${subtype}` },
      });
      return;
    }

    const input = obj(request.input) ?? {};
    const toolName = str(request.tool_name) ?? '';
    const toolUseId = str(request.tool_use_id) ?? '';
    const questions = toolName === 'AskUserQuestion' ? readQuestions(input.questions) : [];
    const ask: Ask = questions.length
      ? { kind: 'question', id, questions, input, toolUseId }
      : {
          kind: 'permission',
          id,
          toolName,
          displayName: str(request.display_name) ?? toolName,
          description: str(request.description) ?? '',
          input,
          toolUseId,
        };
    this.asks.set(id, ask);
    this.emit({ kind: 'ask', ask });
  }

  private settle(response: Json | null): void {
    if (!response) {
      return;
    }
    const id = str(response.request_id);
    if (!id) {
      return;
    }
    const waiting = this.take(id);
    if (!waiting) {
      return;
    }
    if (str(response.subtype) === 'success') {
      waiting.resolve(obj(response.response) ?? {});
    } else waiting.reject(new Error(str(response.error) ?? 'the agent refused the request'));
  }

  // Removes one pending control request and clears its deadline timer.
  private take(id: string): Waiting | null {
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

  private request(request: Json, deadline = this.deadlineMs, context = false): Promise<Json> {
    if (this.closed) {
      return Promise.reject(new Error('the agent is no longer running'));
    }
    const id = this.nextId();
    if (context) this.contextRequests.add(id);
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        const late = this.take(id);
        if (late) {
          late.reject(new Error('the agent did not answer'));
        }
      }, deadline);
      // The deadline timer must not keep the extension host process running.
      if (typeof timer === 'object' && typeof timer.unref === 'function') {
        timer.unref();
      }
      this.waiting.set(id, { resolve, reject, timer });
      // Reject a failed send immediately and remove its pending request and deadline timer.
      try {
        this.write({ type: 'control_request', request_id: id, request });
      } catch (error) {
        this.contextRequests.delete(id);
        const failed = this.take(id);
        if (failed) {
          failed.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  private write(message: Json): void {
    if (this.closed) {
      return;
    }
    this.send(JSON.stringify(message) + '\n');
  }
}

export function readAppliedDefaults(payload: unknown): AppliedDefaults {
  const applied = obj(obj(payload)?.applied);
  const model = str(applied?.model);
  const effort = applied?.effort;
  return model && (typeof effort === 'string' || effort === null)
    ? { status: 'ready', model, effort, reason: '' }
    : unavailableDefaults('Claude did not report its applied model and effort.');
}
