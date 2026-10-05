import { unavailableDefaults, type AppliedDefaults } from './view/model-picks';
// The client half of Claude Code's headless protocol.
//
// The CLI speaks newline-delimited JSON on stdin and stdout when it is started with
// `--input-format stream-json --output-format stream-json`. Two streams share that one
// pipe: the session itself (user messages in, assistant and result messages out)
// and a control channel that carries permission asks, interrupts and the usage figures.
//
// Nothing here spawns a process or imports `vscode`. The transport arrives as a `send`
// callback and every inbound line is handed in through `receive`, so the tests drive the
// whole state machine from the captures recorded off a real CLI.

import * as fs from 'node:fs';

// The vocabulary is shared with the Codex wire, in `agentwire.ts`, so the composer never
// learns which agent it is talking to. It is re-exported here because this file is what a
// reader looking for the Claude protocol opens.
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

// The one reduction this file does not do for itself. `readCommands` above and the usage
// reader below both live here because nothing else wants them, and the server reading is the
// exception: `mcpview.ts` owns the whole `McpServer` vocabulary, decides every word drawn
// from it, and is where the reading is tested. A second copy here read the same fields the
// same way, which is the arrangement that stays correct until the day one of them is taught
// about a field and the other is not.
import { readMcpServers } from './mcpview';
import { activityDetail } from './activitydetail';
import { sessionRenameTitle } from './sessionrename';

// The modes `--permission-mode` accepts. Six of them are the choices the CLI's own help
// lists; `default` is not among them and is accepted anyway, which is why it is spelled out
// here rather than left as an empty string. Re-read `claude --help` on a version bump: an
// unrecognised mode is rejected at start-up, so a stale entry here is a child that will not
// run.
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

export interface SpawnOptions {
  cwd: string;
  model?: string;
  // How hard the model is asked to think, one of the levels the model advertised through
  // `list_models`. This is the level the child starts on. The control channel carries no
  // request that changes it, so a later change goes out as the CLI's own `/effort` command
  // through `effortCommand`.
  effort?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  sessionId?: string;
  persistSession?: boolean;
  settings?: string;
}

// The arguments a working child needs, in one place so the wiring and the tests agree on
// them. Three of them are not optional and one is not documented:
//
// `--verbose` is required: without it the CLI refuses `--output-format stream-json` and
// exits. `--permission-prompt-tool stdio` is the flag that turns asks on at all, and it
// does not appear in `claude --help`; without it the CLI silently allows every tool in
// headless mode and the reader is never asked. `-p` puts the CLI in print mode, which is
// what makes it read stdin as a stream rather than draw a terminal UI.
//
// `--include-partial-messages` is what turns the reply into something the panel can show
// while it is still being written. Without it the CLI says nothing between the press and
// the end of the turn, which is minutes of silence on any real piece of work.
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

// The `skills` array on the `init` system message. Each entry is a plain name, or a plugin
// name with its skill joined by a colon, such as `plain-language:plain-language`. It carries
// no other field, so a name is all this reads. Null means the message carried no `skills`
// key at all, which is not an answer. An explicit empty array is a real answer: no skills.
function readSkills(v: unknown): string[] | null {
  if (!Array.isArray(v)) {
    return null;
  }
  return v.map((entry) => str(entry)).filter((name): name is string => !!name);
}

// The `/usage` answer, in the panel's vocabulary.
//
// Two conversions happen here rather than at the reader. The CLI reports utilisation as a
// whole number on this call and as a fraction on the `rate_limit_event` it volunteers
// mid-turn, so the fraction wins and the whole number is divided; and the reset time is an
// ISO string here and epoch seconds there, so the string is parsed. One unit and one clock
// reach the strip, which is why it can fold a figure from either source into the same row.
//
// `rate_limits_available` false is an account the CLI has no limits for, which is not the
// same as an account at zero, so nothing is returned rather than a row of noughts.
//
// The limits arrive two ways in the one object. `rate_limits.limits` is an array with one
// entry per limit, and it is the only shape that says which clock a limit runs on and which
// model it covers, so it is what the panel reads. Beside it sit windows named for
// themselves, and those are all the fallback reads when an answer carries no array.
//
// Nothing here iterates the keys of `rate_limits`. Several of them are codenames for limits
// that are not offered, `seven_day_opus`, `nimbus_quill`, `tangelo` and `iguana_necktie`
// among them; they hold null, they come and go between releases, and a loop over every key
// would draw a row the moment one of them held an object, under whatever name it was
// carrying that week. Two windows are read, and they are read by name.
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

// The `limits` array, one `RateLimit` per entry. `kind` is the limit's own name, `group` is
// the clock it runs on, and a limit tied to one model carries that model under
// `scope.model.display_name`; a limit covering every model has no scope at all.
//
// `severity` and `is_active` ride along on every entry and neither is read. Only "normal"
// severity has ever been seen, so what any other value means is unknown, and nothing says
// what makes a limit inactive: the weekly limits report themselves inactive while still
// carrying the share the reader has spent. Drawing on either would be a guess about a field
// nobody has explained.
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

// The standard windows the CLI names in its own right, for a payload that carries no
// `limits` array. Each group comes from the window name and covers every model.
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

// The account's money cap, from the `spend` object the CLI reports beside the rate windows.
// A disabled cap, or one with no positive limit, is not a budget the reader can spend from.
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

// Which clock a window named for itself runs on. The `limits` array says so outright; a
// window that arrives under its own name does not. Anything else stays ungrouped rather
// than being filed under a clock nobody named.
const WINDOW_GROUPS: Record<string, string> = {
  five_hour: 'session',
  seven_day: 'weekly',
  // Grouped and passed on, and drawn nowhere. `isModelBucketWindow` in `usageview.ts` says why.
  seven_day_overage_included: 'weekly-overage',
};

function windowGroup(window: string): string {
  return Object.prototype.hasOwnProperty.call(WINDOW_GROUPS, window) ? WINDOW_GROUPS[window] : '';
}

// Every active window Claude attached to one model response. Newer CLIs send this set
// beside the older single-window fields.
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

// The `list_models` answer, in the panel's vocabulary. A model with no `value` is skipped:
// the value is what goes back on `set_model`, and a row the panel could not act on is worse
// than one it never drew.
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
    // Claude names its effort levels and says nothing else about them, so each level is its
    // own label and the description stays empty. A sentence written here would read on
    // screen as the CLI's own words about a level nobody described.
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
      // A model that named itself nothing is drawn under the value that goes back on the
      // wire, which is at least something the reader can recognise again.
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

// The reset time as epoch seconds, from whichever of the two shapes the CLI used. An
// unparsable one is no reset time at all: a window drawn with a reset the panel invented
// would say the limit rolls over at a moment nobody reported.
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

// The CLI reports an interrupt as a failed result, so the outcome is read from
// `terminal_reason` first and only falls back to the error flag. `aborted_streaming` is
// what a control-channel interrupt produces; anything else that failed really did fail.
function readOutcome(m: Json): TurnOutcome {
  const terminal = str(m.terminal_reason);
  const failed = m.is_error === true;
  const status: TurnOutcome['status'] =
    terminal === 'aborted_streaming' || terminal === 'aborted' ? 'interrupted' : failed ? 'error' : 'ok';
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

// A control request this client sent and is still waiting on. The CLI answers on the same
// id, and an answer that arrives after the child died would otherwise leave the caller
// hanging for ever, so every one of these is settled when the wire closes.
interface Waiting {
  resolve(value: Json): void;
  reject(error: Error): void;
  // Cleared wherever the entry leaves the map, so a settled request leaves no timer behind.
  timer: ReturnType<typeof setTimeout> | null;
}

// How long one control request is waited on before it is given up as unanswered.
//
// The CLI answers every subtype it knows and refuses every subtype it does not, so a
// request that goes quiet means the child is wedged rather than slow. Without a clock the
// caller waits for ever: the panel's model read holds its agent in the map of reads already
// running, and every later read for that agent joins the same promise, so one silent
// request stops the agent being asked again for the life of the window.
//
// A minute, which is the same budget a child gets to open. A turn can run far longer than
// this and is not affected: a turn is a stream of events, not a control request.
export const CONTROL_DEADLINE_MS = 60_000;

// The origin Claude Code writes on a prompt a person typed. See `ClaudeWire.prompt`.
const HUMAN_ORIGIN = { kind: 'human' } as const;

export interface WireOptions {
  // Where outbound lines go. The caller appends nothing: a newline is added here, because
  // the framing belongs to the protocol rather than to whoever owns the pipe.
  send(line: string): void;
  // Every event the panel acts on.
  emit(event: WireEvent): void;
  // Overridden in tests so the recorded request ids can be replayed exactly.
  nextId?(): string;
  // How long a control request is waited on. Overridden in tests, which cannot wait a
  // minute to prove that the wait ends.
  deadlineMs?: number;
  // The session this child was started against, when there is one. A resumed child is
  // told which session to open, so the panel knows the answer before the child does.
  sessionId?: string;
  // Overridden by the attachment tests so a Stop can land while file preparation is open.
  readFile?(filePath: string): Promise<Uint8Array>;
}

function claudeToolActivity(block: Json): WireActivity | null {
  const sourceId = str(block.id);
  if (!sourceId) {
    return null;
  }
  const name = str(block.name) ?? 'Tool';
  // The live question card owns this text. Emitting the tool as well would draw the same
  // question twice while the reader is deciding how to answer it.
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
  private readonly send: (line: string) => void;
  private readonly emit: (event: WireEvent) => void;
  private readonly nextId: () => string;
  private readonly deadlineMs: number;
  private readonly readFile: (filePath: string) => Promise<Uint8Array>;
  private readonly waiting = new Map<string, Waiting>();
  private readonly asks = new Map<string, Ask>();
  private readonly textOrdinals = new Map<string, number>();
  private pendingText: { base: string; blocks: string[] } | null = null;
  private counter = 0;
  private promptGeneration = 0;
  private closed = false;

  // The session the CLI settled on. It starts as the session the child was asked to
  // resume, and the first message that names a different one replaces it. The id stays the
  // same for the life of the child, and it is what a later window resumes by.
  //
  // Seeded rather than waited for. The CLI names no session in its answer to the handshake,
  // and a resumed child writes nothing else until the first prompt produces output, so a
  // panel that waits knows nothing about which session the child is in for the whole of
  // the first press. Everything keyed on that answer is then wrong at once: no session
  // counts as running, the rail draws nothing, and the card the press opened is taken down
  // the moment the handoff comes back. A compaction shows it plainly, because it writes no
  // turn for the transcript to draw in the card's place.
  private session: string | null = null;

  constructor(options: WireOptions) {
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

  // The handshake. It has to go before the first prompt: the CLI answers it with the
  // slash-command list, and a client that never sends it is one the CLI does not consider
  // able to answer anything.
  //
  // `supportedDialogKinds` is left empty on purpose. The CLI only sends a dialog kind a
  // client has declared, and answering a kind this panel cannot draw is worse than
  // letting the CLI fall back to its own behaviour.
  async initialize(): Promise<PromptEntry[]> {
    const response = await this.request({ subtype: 'initialize', supportedDialogKinds: [] });
    const commands = readCommands(response.commands);
    this.emit({ kind: 'ready', commands });
    return commands;
  }

  // Sends a prompt. It throws on a wire whose child has gone, rather than writing into a
  // dead pipe and returning: the reader typed something and pressed send, and a prompt that
  // quietly went nowhere leaves the panel saying a turn is running that never started.
  //
  // Every prompt carries a human origin. The CLI copies it onto the prompt record, and the
  // transcript rule in `agentRunIn` reads it as a person, so a session driven from the panel
  // does not file under Run by agents in a window that did not start it.
  prompt(input: AgentPromptInput): Promise<void> {
    if (this.closed) {
      throw new Error('the agent is no longer running');
    }
    const prompt = normalizeAgentPrompt(input);
    if (!prompt.assets.length && prompt.text) {
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
      this.write({ type: 'user', message: { role: 'user', content }, origin: HUMAN_ORIGIN });
    });
  }

  // Renames the session with Claude Code's `rename_session` control request. The CLI answers
  // it on the control channel rather than as a turn, so the rename applies while a turn is
  // running, writes the transcript record and the saved title file, and reports no result
  // and no cost. `source` says that a person renamed the session in the application hosting
  // the CLI, which the CLI counts as a rename the reader made. `sessionId` is the session
  // the caller resolved, and the CLI refuses the request once its process has moved to
  // another session, which is the case this argument exists to catch. The caller cleans the
  // name, and this sends it as given. A name with nothing visible is refused here, as the
  // CLI refuses it too.
  async renameSession(sessionId: string, title: string): Promise<void> {
    if (this.closed) {
      throw new Error('the agent is no longer running');
    }
    if (sessionRenameTitle(title) === null) {
      throw new Error('Enter a name.');
    }
    await this.request({ subtype: 'rename_session', title, source: 'host', session_id: sessionId });
  }

  // Changes how hard the model works, under the child that is already running.
  //
  // The control channel has no subtype for an effort level, so this goes out as the CLI's
  // own `/effort` command on the same user-message line a prompt uses. The CLI handles the
  // command itself rather than passing it to the model, and answers with a `result` event,
  // which the host books as its own turn.
  //
  // The origin is the human one for the same reason a prompt's is: a reader pressed the
  // control, and the transcript rule in `agentRunIn` reads the record it writes.
  async effortCommand(effort: string): Promise<void> {
    if (this.closed) {
      throw new Error('the agent is no longer running');
    }
    // The command names a level or it asks nothing. A bare `/effort` still costs the round
    // trip, and the CLI answers it with a menu no reader opened.
    if (!effort) {
      throw new Error('the effort command needs a level to set');
    }
    this.write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `/effort ${effort}` }] },
      origin: HUMAN_ORIGIN,
    });
  }

  // Stops the turn in flight. `cancelQueued` also drops prompts the reader queued behind
  // it, which is what a stop button means when several are waiting.
  async interrupt(cancelQueued = false): Promise<void> {
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

  // The two figures the panel already treats as first class, straight from the CLI rather
  // than added up from turn results. `get_usage` is what `/usage` draws, rate limits and
  // all, and `get_context_usage` is what `/context` draws.
  async usage(): Promise<Json> {
    return await this.request({ subtype: 'get_usage' });
  }

  async contextUsage(): Promise<Json> {
    return await this.request({ subtype: 'get_context_usage' });
  }

  // The models this child will run, with the words the CLI uses for them. Asked once per
  // child: the list turns over on a release rather than on a turn.
  //
  // A CLI that does not know the subtype refuses it, and a child that has gone refuses
  // everything, so a refusal comes back as no list rather than as a failure. The picker
  // then offers nothing, which is what it does before the answer arrives anyway, and the
  // reader is not shown an error about a control they never pressed.
  async appliedDefaults(): Promise<AppliedDefaults> {
    try {
      return readAppliedDefaults(await this.request({ subtype: 'get_settings' }));
    } catch {
      return unavailableDefaults('Claude did not report its settings.');
    }
  }

  async listModels(): Promise<Json | null> {
    try {
      return await this.request({ subtype: 'list_models' });
    } catch {
      return null;
    }
  }

  // What the MCP servers behind this child are doing, read on demand.
  //
  // On demand is the only way it can be read. The CLI volunteers nothing about its servers:
  // a child holding one healthy server and one that would not start said nothing about
  // either over fifteen seconds, so there is no message to listen for and the panel has to
  // ask every time it wants to know. That matters more than it sounds, because a server
  // that falls over takes its tools with it quietly, and the agent simply stops being able
  // to do something it could do an hour ago.
  //
  // A refusal comes back as no reading rather than as a failure, the way the model list
  // does. An older CLI that has never heard of the subtype refuses it, and a child that has
  // gone refuses everything; in both cases the reader pressed nothing and asked nothing, so
  // the panel is left with no servers to draw rather than an error to explain.
  async mcpStatus(): Promise<McpServer[] | null> {
    try {
      return readMcpServers(await this.request({ subtype: 'mcp_status' }));
    } catch {
      return null;
    }
  }

  // Switches one server off, or back on.
  //
  // Both fields have to go out and neither is guessable from the CLI's help, which is why
  // they are spelled out here rather than left to a caller. The server is named under
  // `serverName`, not `server` and not `name`: a request under the wrong key is not
  // refused, it is answered with a complaint that no such server exists, and on screen the
  // button the reader pressed looks like it did nothing at all. `enabled` decides the state
  // outright rather than flipping whatever the server was in, and leaving it off is not the
  // same as leaving the server alone: the CLI reads a missing `enabled` as false, so a
  // request without it can only ever switch a server off, and a reader who switched one off
  // could never switch it on again. Sending the same value twice is harmless.
  //
  // The failure is passed on rather than swallowed, which is the difference between this
  // and the reading above. The reader pressed this, and a press that quietly did nothing is
  // worse than one that says why it could not.
  async mcpToggle(serverName: string, enabled: boolean): Promise<void> {
    await this.request({ subtype: 'mcp_toggle', serverName, enabled });
  }

  // Tries a failed server again. It answers once the CLI has the connection up, and fails
  // with whatever the connection failed on, "Connection closed" among them, which is the
  // sentence worth putting in front of somebody who just asked for another go. Passed on
  // for the same reason the toggle passes its own on.
  async mcpReconnect(serverName: string): Promise<void> {
    await this.request({ subtype: 'mcp_reconnect', serverName });
  }

  pendingAsk(id: string): Ask | null {
    return this.asks.get(id) ?? null;
  }

  pendingAsks(): Ask[] {
    return [...this.asks.values()];
  }

  // Answers an ask. The CLI is blocked until this goes out, so an unknown id is reported
  // rather than dropped: a silently ignored answer looks to the reader like the agent
  // hung, which is the one failure this whole channel exists to prevent.
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
      // An answered question is an allowed tool call whose input has grown an `answers`
      // map, keyed by the question text. Several picks on one question go back as one
      // string, which is what the tool reads, and an answer the reader wrote themselves
      // joins that string beside them. The rest of the input is passed back untouched,
      // because the CLI hands the whole thing to the tool.
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

  // One line off the child's stdout. Anything unparsable is reported and skipped: the CLI
  // writes the odd non-JSON line when something goes wrong underneath it, and one bad line
  // must not take the session down with it.
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
    const m = obj(parsed);
    if (!m) {
      return;
    }

    const session = str(m.session_id);
    if (session && session !== this.session) {
      // Read before the field moves. What the panel needs is the session being left,
      // and after the assignment both names are the same one.
      const previous = this.session;
      this.session = session;
      this.emit({ kind: 'session', sessionId: session, previous });
    }

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
        this.partial(obj(m.event));
        return;
      case 'result':
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
        // The `init` message arrives only once its session has taken a first prompt, well
        // after the `initialize` control reply this wire already read the command list from.
        // It is the only place the CLI names its skills, so a later `init` on a resumed or
        // cleared session still updates what this wire knows. A message with no `skills` key
        // emits nothing, rather than reporting an empty list the CLI never sent.
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

  // Settles every caller waiting on a reply and stops the wire answering anything else.
  // Called when the child exits, however it exited.
  close(reason: string): void {
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
        this.emit({ kind: 'text', text });
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

  // A chunk of the reply as it is written, from the stream `--include-partial-messages`
  // turns on. Recorded off a real child on 2026-08-29, so a reader here does not have to
  // guess at the shape:
  //
  //   {"type":"stream_event","event":{"type":"content_block_delta","index":1,
  //     "delta":{"type":"text_delta","text":"one, two, three"}}}
  //
  // Three facts from that capture decide what this does. `stream_event` is the only new
  // top-level type the flag adds, so nothing already in the switch above can mistake a
  // partial for a finished message. The `assistant` message still arrives once per content
  // block, exactly as it did before the flag, so `text` events are unchanged and joining
  // these deltas is not a second copy of them. And the same event carries `thinking_delta`
  // for the model's reasoning, which is not the reply and is not drawn as one: the panel
  // already learns that a model is thinking from its own event.
  private partial(event: Json | null): void {
    if (!event) {
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
      this.emit({ kind: 'delta', text });
    }
  }

  private flushPendingText(commentary: boolean): void {
    const pending = this.pendingText;
    if (!pending) {
      return;
    }
    this.pendingText = null;
    if (!commentary) {
      this.emit({ kind: 'text', text: pending.blocks.join('\n') });
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
        // The event names one window and says nothing about a clock or a model, so the
        // group comes from the name and the limit covers every model, which is what an
        // empty scope means.
        group: windowGroup(window),
        scope: '',
      },
    });
  }

  // A control request the CLI sent us. Only the permission channel is answered here.
  // Anything else is refused with an error rather than left hanging, so the CLI can fall
  // back to whatever it does without a capable client, except for the dialog channel,
  // where the protocol says an undeclared kind must go unanswered.
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

  // Takes one request out of the map and stops its clock. Every path that settles a request
  // goes through here, so no timer outlives the request it belongs to.
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

  private request(request: Json): Promise<Json> {
    if (this.closed) {
      return Promise.reject(new Error('the agent is no longer running'));
    }
    const id = this.nextId();
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        const late = this.take(id);
        if (late) {
          late.reject(new Error('the agent did not answer'));
        }
      }, this.deadlineMs);
      // The extension host outlives any one request, and a pending timer that keeps the
      // host awake is a cost the reader pays for a question they did not ask.
      if (typeof timer === 'object' && typeof timer.unref === 'function') {
        timer.unref();
      }
      this.waiting.set(id, { resolve, reject, timer });
      // A send that throws leaves nothing to answer this request, so it fails here rather
      // than holding an entry and a timer until the deadline.
      try {
        this.write({ type: 'control_request', request_id: id, request });
      } catch (error) {
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
