import type { ModelChoice } from './domain/model-catalog';
export type { ModelChoice, EffortChoice } from './domain/model-catalog';
// The vocabulary both agents are described in.
//
// Claude Code and the Codex CLI speak nothing like each other: one is a stream of tagged
// JSON messages with a control channel bolted alongside, the other is JSON-RPC with
// server-initiated requests. The composer should not know which it is talking to, so each
// wire reduces its own protocol to the types here and the panel reads only these.
//
// This file holds no logic. It exists so that adding a third agent means writing one more
// reducer, not teaching the panel a third dialect.

// One extension-staged file carried with a prompt. The path always points into extension
// storage, never to the file the reader selected. Vendor adapters decide how to represent
// it on their own wire.
export interface PromptAsset {
  id: string;
  name: string;
  mime: string;
  size: number;
  digest: string;
  path: string;
}

export interface AgentPrompt {
  text: string;
  assets: readonly PromptAsset[];
}

export type AgentPromptInput = string | AgentPrompt;

export function normalizeAgentPrompt(input: AgentPromptInput): AgentPrompt {
  return typeof input === 'string' ? { text: input, assets: [] } : { text: input.text, assets: [...input.assets] };
}

// What the panel needs to know about an entry the reader can invoke from the prompt.
// Commands and skills are distinct because Codex assigns them different prefixes.
export interface PromptEntry {
  kind: 'command' | 'skill';
  name: string;
  description: string;
  argumentHint: string;
  path?: string;
}

// A tool call the agent wants to make and the reader has to allow. On the Claude side this
// is a permission ask; on the Codex side it is an approval request. Both block the turn.
export interface PermissionAsk {
  kind: 'permission';
  id: string;
  toolName: string;
  displayName: string;
  description: string;
  input: Record<string, unknown>;
  toolUseId: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  // What the answer is keyed by when it goes back. The two agents key differently: Claude
  // keys its answers map by the question's own text, Codex by an opaque question id. The
  // wire that read the question puts the right one here, so the panel carries one shape.
  id: string;
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  // Whether the answer is a secret. Codex says so per question, and the card then takes the
  // answer in a password box and keeps it off the tab that reports what was chosen. Claude
  // asks for no secret, so it is always false there.
  secret: boolean;
}

// A question the model asked the reader outright.
export interface QuestionAsk {
  kind: 'question';
  id: string;
  questions: Question[];
  input: Record<string, unknown>;
  toolUseId: string;
}

export type Ask = PermissionAsk | QuestionAsk;

// What one question was answered with.
//
// `labels` holds the choices the agent offered and the reader took, and a multi-select
// question can hold several. `written` holds an answer the agent never offered, and it is
// empty on every question the reader answered from the list.
//
// The two are kept apart so the panel can still refuse a label nobody offered. A written
// answer folded into `labels` would be indistinguishable from a stale form posting a choice
// that the agent has since replaced.
//
// Both agents take the written text as an ordinary answer. A live Codex run answered a
// question with a string that was neither offered option, and the model read it back
// unchanged; Codex's own tool schema asks the client to add the free-form choice. Claude
// hands the whole tool input back to the tool, so the string reaches it the same way.
export interface AskQuestionAnswer {
  labels: string[];
  written: string;
}

// How the reader answered. A denial carries its reason because the model is shown that
// text, and a bare refusal tells it nothing about what to try instead.
export type AskAnswer =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  // Keyed by `Question.id`. Joining an answer into a string here would throw away what one
  // agent needs: Claude wants one string, Codex wants the list.
  | { decision: 'answer'; answers: Record<string, AskQuestionAnswer> };

// How a turn ended. `interrupted` is its own outcome because both CLIs report a reader's
// own stop as a failure, and a panel that reads the error flag alone would call it one.
export interface TurnOutcome {
  status: 'ok' | 'interrupted' | 'error';
  text: string;
  costUsd: number | null;
  turns: number | null;
  deniedTools: string[];
}

// The share of the reader's rate limit this session has used, as a fraction from 0 to 1.
//
// Both agents report more than one limit at a time and both say how their limits relate to
// each other, so the panel keeps that relation rather than flattening it. `group` is the
// clock the limit runs on, `session` for the few-hour window and `weekly` for the seven-day
// one, and it is empty when the agent named no group. `scope` is the model the limit is
// tied to, drawn under the model's own display name, and it is empty for a limit that
// covers every model. A weekly limit and a weekly limit scoped to one model share a group
// and differ by scope, which is the only thing that tells them apart on screen.
export interface RateLimit {
  window: string;
  utilization: number;
  resetsAtSeconds: number | null;
  status: string;
  group: string;
  scope: string;
}

// A money cap on an account, rather than a share of a clock. Money stays in the minor
// units and exponent the agent reports, so it is not rounded before the panel words it.
export interface SpendCap {
  usedMinor: number;
  limitMinor: number;
  exponent: number;
  // The ISO code the agent named. Carried rather than assumed, and worded at the reader.
  currency: string;
  // The share spent, on the same 0-to-1 scale every `RateLimit` uses.
  utilization: number;
}

// One reasoning effort a model offers, with whatever the CLI says about it. Neither agent
// is asked to translate: `label` and `description` are the agent's own words, and an agent
// that gives no description leaves it empty rather than having one written for it.
// Everything one agent answered about the models it will run. Read once and cached, since
// the list changes on a release rather than on a turn.
export interface ModelList {
  models: ModelChoice[];
  readAt: number;
}

// One MCP server, as the agent reports it. The tool calls an agent can make are only as good
// as the servers behind them, and a server that has fallen over takes its tools with it
// silently: the agent simply stops being able to do a thing it could do yesterday.
//
// `status` is the agent's own word and is never narrowed to a set here. The shipped Claude
// binary declares five, `connected`, `failed`, `needs-auth`, `pending` and `disabled`, and
// only `disabled` means the server is switched off: one that is starting, or that wants a
// login, is on. It stays a string all the same. The CLI is free to add a sixth, and a word
// this version has no phrasing for is carried to the screen as it arrived, because a server
// quietly dropped from the list, or called broken on a guess, is the panel claiming
// something it was not told.
export interface McpServer {
  name: string;
  status: string;
  // Why it will not connect, in the agent's words. Empty for a server that is not failing.
  error: string;
  // What it offers, and empty for a server that is not connected: the agent reports the
  // tools only once the connection is up, so an empty list on a healthy server would be a
  // claim that it has none.
  tools: string[];
  // Where the server is configured, in the agent's word for it. The binary's own schema
  // names `project`, `user`, `local`, `claudeai` and `managed`, and answers `dynamic` for one
  // added over the wire. Empty where the agent named none. Carried rather than translated,
  // for the reason `status` is: the list is the agent's to grow.
  scope: string;
  // What the server called itself once connected, and empty until it has. This is the
  // server's own name for itself rather than the key it is configured under, and the two are
  // often different.
  title: string;
  // Whether this client has a protocol call that can switch this server. Claude publishes
  // one; Codex publishes a status list but no per-server toggle call. Left off means yes so
  // older readings and test fixtures keep the interactive behavior they already had.
  mutable?: boolean;
}

// Everything one agent answered about the reader's rate limits in one exchange, in the
// panel's own vocabulary. Each wire reduces its own payload to this, so the strip that
// draws it never learns which agent the figures came from. `plan` is the subscription the
// agent named for itself, drawn as it arrived; a reading that names no plan, which is what
// the free mid-turn events are, leaves it empty rather than guessing.
export interface UsageReading {
  plan: string;
  limits: RateLimit[];
  // A requested answer covers the account and can clear a cap. A free mid-turn event is
  // partial and says nothing about whether the account still has one.
  complete: boolean;
  // The account's money cap, where the agent reports one. Free mid-turn events carry no
  // cap, because they report one rate window and nothing else.
  spend: SpendCap | null;
  // The money cap's own reset clock. The account answer omits it, while Claude's live
  // rate-limit event can report it beside another window.
  creditResetsAtSeconds?: number | null;
  // When the answer arrived. A figure is only as fresh as the moment it was read, and the
  // strip says so once it has aged.
  readAt: number;
}

// One visible piece of work from a running turn. The source id is the agent protocol's own
// item or tool-call id, so a completion can replace its start and the transcript can replace
// the live copy without drawing the same work twice.
export interface WireActivity {
  sourceId: string;
  kind: 'tool' | 'commentary' | 'reasoning' | 'plan' | 'collaboration';
  name: string;
  headline: string;
  detail: string;
  status: 'running' | 'done' | 'failed' | 'interrupted';
}

// The effective Codex permission fields returned when a thread opens. They remain in the
// server's vocabulary so a later presentation layer can match only the presets it knows.
export interface CodexEffectiveMode {
  approvalPolicy: string | Json;
  approvalsReviewer: string;
  sandbox: string;
}

export type WireEvent =
  | { kind: 'ready'; commands: PromptEntry[] }
  | { kind: 'commands'; commands: PromptEntry[] }
  // `previous` is the session the child has just left, and it is empty the first
  // time a child names itself. A child that moves between two real sessions has not
  // been told to start again: it kept its process and cleared what it was holding, and the
  // panel has to follow it to the new one.
  | {
      kind: 'session';
      sessionId: string;
      previous: string | null;
      effectiveMode?: CodexEffectiveMode;
    }
  // Claude's own skill list, published on the `init` system message that follows a
  // session's first prompt. Codex never emits this: its skills arrive through its own
  // catalog instead.
  | { kind: 'skills'; skills: string[] }
  // Claude reports the effective mode after settings and launch flags resolve. It remains
  // separate from Arc's stored override because an empty override still has live behavior.
  | { kind: 'permissionMode'; sessionId: string; mode: string }
  | { kind: 'thinking' }
  | { kind: 'text'; text: string; sourceId?: string; nativeTurnId?: string }
  // A piece of the reply, as it is written. `text` above is a finished block and arrives
  // once; this arrives many times a second and each one carries only what is new. They are
  // separate kinds because a reader that joined the deltas and then took the block would
  // draw the whole reply twice.
  | { kind: 'delta'; text: string; sourceId?: string; nativeTurnId?: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown> }
  | { kind: 'activity'; activity: WireActivity }
  | { kind: 'ask'; ask: Ask }
  | { kind: 'askResolved'; id: string }
  | { kind: 'turnEnd'; outcome: TurnOutcome; nativeTurnId?: string }
  | { kind: 'rateLimit'; limit: RateLimit | null; creditResetsAtSeconds: number | null }
  | { kind: 'error'; message: string };

// The narrow reading helpers both wires need. Everything off a pipe is unknown until it
// has been looked at, and a shape either CLI is free to change between versions is read
// one field at a time rather than cast.
export type Json = Record<string, unknown>;

export function obj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
