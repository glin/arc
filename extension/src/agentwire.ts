import type { ModelChoice } from './domain/model-catalog';
export type { ModelChoice, EffortChoice } from './domain/model-catalog';
// Shared prompt, request, event, and outcome types for both agents.
// Claude uses tagged JSON and a control channel. Codex uses JSON-RPC requests and notifications.
// Wire adapters translate these protocols so the prompt box reads shared types.

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

// A tool call awaiting reader permission. Claude permission asks and Codex approval requests both block the turn.
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
  // The answer key supplied by the wire adapter. Claude uses the question text. Codex uses its question id.
  id: string;
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  // Whether the answer is a secret. Codex supplies this per question.
  // Secret answers use a password field and stay off the tab reporting the selection. Claude always supplies false.
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

// The reader's selected options and free-form text for one question.
// `labels` holds offered choices, including multiple selections. `written` holds text outside those choices.
// Separate fields let the panel reject stale option labels without rejecting free-form answers.
// Both wire adapters pass the written text to their agent.
export interface AskQuestionAnswer {
  labels: string[];
  written: string;
}

// How the reader answered. A denial carries its reason because the model is shown that
// text, and a bare refusal tells it nothing about what to try instead.
export type AskAnswer =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  // Keyed by `Question.id`. Claude receives one answer string. Codex receives an answer list.
  | { decision: 'answer'; answers: Record<string, AskQuestionAnswer> };

// How a turn ended. Both providers report Stop through failure-shaped results.
// The interrupted outcome distinguishes a reader's Stop from a failed turn.
export interface TurnOutcome {
  status: 'ok' | 'interrupted' | 'error';
  text: string;
  costUsd: number | null;
  turns: number | null;
  deniedTools: string[];
}

// One account rate limit, with utilization expressed as a fraction from 0 to 1.
// `group` identifies the reset window, such as session or weekly. Empty means the agent supplied no group.
// `scope` identifies a model-specific limit. Empty means the limit covers all models.
// Limits with the same group remain distinct by scope.
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

// The model catalog returned by an agent, with its read time.
export interface ModelList {
  models: ModelChoice[];
  readAt: number;
}

// One MCP server reported by an agent.
// `status` retains the agent's value, including values without known display wording.
// Claude statuses include connected, failed, needs-auth, pending, and disabled. Only disabled identifies a switched-off server.
export interface McpServer {
  name: string;
  status: string;
  // Why it will not connect, in the agent's words. Empty for a server that is not failing.
  error: string;
  // Tool names reported for a connected server. Empty when the agent supplies no tool names.
  tools: string[];
  // The configuration scope reported by the agent, without translation. Claude reports project, user, local, claudeai, managed, or dynamic.
  // Empty when no scope is supplied.
  scope: string;
  // What the server called itself once connected, and empty until it has. This is the
  // server's own name for itself rather than the key it is configured under, and the two are
  // often different.
  title: string;
  // Whether the client supports switching this server. Claude exposes a toggle call. Codex exposes status without a per-server toggle.
  // An omitted value permits switching for compatibility.
  mutable?: boolean;
}

// Explicit unavailable limits carry no reading. Null means no usable answer.
export type UsageReadResult = UsageReading | 'unavailable' | null;

// An agent's normalized account usage from one exchange.
// `plan` retains the reported subscription name. Unrequested mid-turn events leave it empty.
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

// One visible activity from a running turn. The source id identifies the provider's item or tool call.
// Completion replaces its start. The recorded activity replaces the live copy.
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
  | { kind: 'responseStarted'; sourceId: string }
  | { kind: 'responseRate'; sourceId: string; rate: import('./outputrate').ResponseRate }
  | { kind: 'ready'; commands: PromptEntry[] }
  | { kind: 'commands'; commands: PromptEntry[] }
  // `previous` identifies the session the child left. It is null when the child first reports its identity.
  // A reset can change the session while retaining the process.
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
  // Incremental reply text, separate from completed `text` blocks.
  // The panel replaces streamed deltas with their completed block instead of displaying both.
  | { kind: 'delta'; text: string; sourceId?: string; nativeTurnId?: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown> }
  | { kind: 'activity'; activity: WireActivity }
  | { kind: 'ask'; ask: Ask }
  | { kind: 'askResolved'; id: string }
  | { kind: 'turnEnd'; outcome: TurnOutcome; nativeTurnId?: string }
  // Claude's own report that it started work or has nothing left to do. A prompt that joins a
  // running turn gets no `result` of its own, so only `idle` shows that its work is over.
  // The wire emits it without `settledTurnIds`. The host adds the prompt and command turns the report closed.
  | { kind: 'sessionState'; state: 'idle' | 'running'; settledTurnIds?: readonly number[] }
  | { kind: 'rateLimit'; limit: RateLimit | null; creditResetsAtSeconds: number | null }
  | { kind: 'error'; message: string };

// Unknown JSON objects read one field at a time by both wire adapters.
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
