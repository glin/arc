import { toolKind } from './domain/tool-kinds';
import { revisionOf } from './filerevision';
import { turnKey } from './domain/read';
export { revisionOf } from './filerevision';
import type { SourceEnumeration } from './sessioncoverage';
import * as fs from 'node:fs';
import { ExportLimitError, type ExportRelationshipLimits } from './exportlimits';
import { meterRead, meterReadWork } from './readmeter';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  captureClaudeCostLine,
  emptyClaudeCostCapture,
  noteClaudeCostEvent,
  type ClaudeCostCapture,
} from './claudecoststate';
import {
  blankClaudeRepeated,
  claudeRecordIdentity,
  claudeRepeatedClassifier,
  createClaudeRepeatedFilter,
} from './clauderepeated';
import { createHash } from 'node:crypto';
import {
  AgentSessionTargetLookup,
  AgentSpendLookup,
  ModelSpend,
  addModelUsage,
  addUsage,
  addUsageTools,
  addUsageWaits,
  mergeUsageTools,
  emptyUsage,
  agentSpendIsOpen,
  heaviestModel,
  childSpendRevisionKey,
  modelSpends,
  requestClock,
  requestSpans,
  scanLines,
  spanHolding,
  spendFileVersion,
  usageTokens,
  type AgentSpend,
  type AgentSpendRef,
  type RequestSpan,
} from './agentspend';
import {
  ChildArtifacts,
  childToolCalls,
  childTurnSpan,
  cloneChildArtifacts,
  lastLineWhole,
  reduceChildArtifacts,
  UNNAMED_TOOL,
} from './childartifacts';
import { HEX_SHA, sameCommitSha } from './domain/commit-sha';
import { sameModelIdentity } from './domain/model-identity';
import {
  applyHiddenParserState,
  cloneParserState,
  retainedParserPayload,
  retainedParserPayloadScan,
  hiddenParserState,
  ParserLine,
  RETAINED_COMPACTION_PARENTS,
  RETAINED_COMPACTIONS,
  RETAINED_REQUESTS,
  retainedRequestEvents,
  type HiddenParserState,
  type HiddenStatePolicy,
} from './parserstate';
import { markdownCodeBlocks, renderInlineMarkdown, visibleTextOf, withoutRichContent } from './richtext';
import {
  compactionEstimate,
  cacheLapsedBy,
  contextBandForRequest,
  requestInputTokens,
  type CompactionPreviousRequest,
  type CompactionEstimateInput,
} from './pricing';
import { activityDetail, ActivityDetailFormat, ActivityDetailPolicy, describeToolInput } from './activitydetail';
import { shortenTo } from './domain/text.ts';
import { ARC_IDENTITY } from './identity';
import { arcHome } from './store';
import { claudeConfigHome, codexHome } from './agentpaths';
import { RESPONSE_RATE_LIMIT, summedTurnRate, validRate, type OutputRate, type OutputRateBasis } from './outputrate';
import {
  addSubagentResult,
  clearSubagentContext,
  commitSubagentContext,
  emptySubagentContext,
  estimateClaudeSubagentTokens,
  knownSubagentLaunch,
  noteSubagentContextLine,
  noteSubagentLaunch,
  noteUnqualifiedSubagentResult,
  skipSubagentContext,
  subagentContextFigure,
  type SubagentContextFigure,
  type SubagentContextState,
} from './subagentcontext';

export { describeToolInput } from './activitydetail';
export { shortenTo } from './domain/text.ts';

// Reads Claude JSONL transcripts without changing them and reduces records into shared turns.
// Bounded tail reads prefilter lines before JSON parsing.
// Turns whose opening prompts lie before the tail are excluded. Selected reads can recover the newest turn.

// Source agent for a session or turn, used by badges and source-specific readers.
export type AgentKind = 'claude' | 'codex';

// One hunk of a Claude Code edit result, as the `diff` package's structuredPatch writes
// it. `lines` carries each line prefixed with a space, a plus or a minus.
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// One Edit or Write result: the patch it applied, and whatever whole-file text Claude Code
// recorded beside it. `originalFile` is the file as it stood before the edit, recorded only
// for small files. `content` is the file as it stands after, which Write records and Edit
// does not.
export interface EditRecord {
  hunks: PatchHunk[];
  originalFile: string | null;
  content: string | null;
  isCreate: boolean;
  patchInvalid?: true;
}

// Cause of unknown or partial file counts, retained for the files record.
// `shell` names a path without hunks. `write` omits the previous file contents.
// `replaceAll` omits the replacement count. `notebook` omits the replaced or deleted cell contents.
// `zero` names an edit with no counted lines, such as a trailing-newline change.
export type FileCountReason = 'shell' | 'write' | 'replaceAll' | 'notebook' | 'zero';

export interface TurnFileChange {
  path: string;
  // Opaque identity retained when capture shortens paths from several working directories.
  identity?: string;
  added: number;
  removed: number;
  isNew: boolean;
  // Recorded edits in result order, used for per-turn diffs without reading the current file.
  // Ordinary and older reads have bounded byte windows.
  // Newest-turn recovery admits the selected turn beyond its ordinary window.
  edits: EditRecord[];
  // Set when a Bash result named this path in `changedFiles` without carrying its hunks.
  // The CLI caps the shell diff at five detailed files, so a wider change still names
  // every path it touched, and this flag keeps that row from claiming a zero-line change.
  countsUnknown?: true;
  // Cause of unknown counts. Absent when the source or caller supplied none.
  unknownReason?: FileCountReason;
}

export interface TurnAgent {
  // The child transcript's own id, once the parent recorded it. Null while a launch is in
  // flight or where an older format named only the task.
  id: string | null;
  // Catalog-inferred ids are reconsidered after a serialized retained-page refresh.
  codexInferredId?: boolean;
  // Parent status and timing survive child enrichment and retained-page worker cloning.
  codexStructuralBase?: { status: string; startedAt?: number | null; durationMs: number | null };
  // A completed shell command and child session together identify a Claude print-mode
  // invocation. Native child rows do not carry this field.
  invocationId?: string;
  // The parent tool call id, kept as non-enumerable metadata so activity steps can pair
  // with the agent row without changing the serialized card shape.
  toolUseId?: string;
  // Child session identity, available after provider evidence resolves a readable child.
  childSessionId?: string;
  description: string;
  agentType: string | null;
  // The model named on the launch call. It can be an alias such as `opus`.
  model: string | null;
  // The model the child's own requests used most, from `AgentSpend.ownModel`. Absent for a child
  // whose spend reader does not record it.
  ownModel?: string;
  effort: string | null;
  // Recorded child usage grouped by pricing identity. Empty when no request usage is available.
  spend: ModelSpend[];
  outputRate?: import('./outputrate').OutputRate;
  outputRateModel?: string;
  spendFound: boolean;
  // Missing, unfinished, or uncertain child data makes `spend` a lower bound.
  spendPartial: boolean;
  spendUnfinished?: boolean;
  spendIncomplete?: boolean;
  commits?: TurnCommit[];
  commitIntents?: CommitIntent[];
  // The child's distinct files and commits, read from its own transcript once it finished.
  artifacts?: ChildArtifacts;
  // The child's start clock, with the parent launch clock as a fallback. This timing fact
  // survives worker replies independently of hidden Activity pairing ids.
  startedAt?: number | null;
  durationMs: number | null;
  tokens: number | null;
  toolUses: number | null;
  // True when the tool count came from child artifacts instead of a result or notification.
  // A recorded count replaces this estimate and clears the flag.
  // The flag stays enumerable across worker structured clones and agent-row spreads.
  toolUsesFromArtifacts?: boolean;
  status: string;
  // The parent record time that closed this child. It stays enumerable because the host
  // derives session outcome after the worker sends the parsed turn across structured clone.
  closedAt?: number;
  // A row for a child that an earlier turn launched, such as one resumed with `SendMessage`.
  // Its spend holds only the child requests this turn holds. `refreshClaudeAgentFacts` rebuilds it.
  launchedEarlier?: true;
}

// Commit location relative to the open folders.
// `named` identifies another repository. `worktree` identifies a linked checkout of an open repository.
// `maintree` identifies the main checkout when the open folder is its worktree.
// `unnamed` identifies multiple external repositories without a unique directory. `null` supplies no extra location label for in-project locations or unresolved evidence.
// Printed commits start `named` for one resolved external target, `unnamed` for multiple known external targets, or null otherwise. `gitcommits.ts` resolves common Git directory identity and corrects the location.
export type CommitPlace =
  | { kind: 'named'; dir: string }
  | { kind: 'worktree'; dir: string }
  | { kind: 'maintree'; dir: string }
  | { kind: 'unnamed' }
  | null;

// Ref printed by Git, distinguishing a named branch from a detached checkout.
export type CommitHead = { kind: 'branch'; name: string } | { kind: 'detached' } | null;

export interface TurnCommit {
  intent?: string;
  source?: CommitSource;
  sha: string;
  printedSha?: string;
  // The full hash a `commit <sha>` line in the same tool output printed, when the header printed only a prefix of it.
  fullSha?: string;
  // Awaiting is set while the host waits for the evidence reply of a changed revision. The commit keeps its group until the reply arrives.
  candidates?: { dirs: string[]; complete: boolean; awaiting?: boolean };
  repositoryEvidence?: { dirs: string[]; at: number; turnId: string; complete: boolean };
  subject: string;
  head?: CommitHead; // null or omitted when the source did not print a recognizable ref
  files: number | null; // null when no stat line was found under the commit line
  added: number | null;
  removed: number | null;
  // Epoch ms. A commit taken from printed output carries the time of the tool result that
  // reported it. One read back from the repository carries git's own committer time.
  at: number;
  place: CommitPlace; // where it landed, carried only for a commit made outside the open folders
  dir: string | null; // repository directory, for opening the commit in the editor. Null while a repository check is pending or has failed.
  // The repository the commit is in, once git has named it: its common git directory, which a
  // linked worktree shares with the tree it came from, and the top of the tree the commit was
  // made in. Null or omitted until then. A commit with a repository proof, or with child evidence, keeps it while its repository is checked again and when a window read replaces the commit, so its group holds.
  repository?: CommitRepository | null;
}

export interface CommitRepository {
  key: string;
  root: string;
  // The repository is the one an open folder is in: its key is an open folder's key.
  own: boolean;
}

// The rule is browser-safe, so the panel's grouping of commit rows and this reducer compare shas
// the same way.
export { HEX_SHA, sameCommitSha };

// A commit command whose result printed no commit identity, including quiet commits.
// The command supplies its repository, expected commit count, and execution window. `gitcommits.ts` recovers matching identities.
// `from` uses the later call-record or previous-result time when records distinguish their starts.
// Calls issued by one record share its timestamp because they can run concurrently.
// Their windows overlap. Repository recovery rejects a window whose candidate count differs from `expected`.
export interface CommitIntent {
  source?: CommitSource;
  dir: string; // the one repository the command named
  from: number;
  to: number;
  expected: number; // how many times the command said `git commit`
  witnessedSha?: string; // the abbreviated sha printed by a trailing success log
}

// A fast-forward landing performed by the turn, separate from commits the turn wrote.
// `from` names the merge target. A landing carries no edit counts.
export interface TurnLanding {
  id: string; // the merge invocation and reflog event that produced this landing
  sha: string;
  subject: string; // the subject of the commit the tree landed on
  from: string; // the branch or ref the merge command named
  head?: CommitHead; // Branch that moved, when the repository resolves it.
  at: number; // git's own committer time for the commit the tree landed on
  place: CommitPlace;
  dir: string | null; // repository directory, for opening the commit in the editor
  repository?: CommitRepository | null;
  // The branch the merge brought in, read when the landing was recorded. Null when nothing
  // named one: the merge named a hash, and no other branch pointed at the commit.
  mergedBranch?: string | null;
}

// A call that ran `git merge` and printed no identity to take. Git prints `Updating a..b` and
// `Fast-forward`, which carry short shas and no subject, so the identity comes from the head
// log the same way a quiet commit's does.
//
// The fields carry what a commit intent carries, and `expected` counts `git merge` rather than
// `git commit`.
export interface LandingIntent {
  id?: string; // source call id, when the transcript provides one
  dir: string; // the one repository the command named
  from: number;
  to: number;
  expected: number; // how many times the command said `git merge`
}

export interface ToolFailure {
  tool: string;
  message: string;
}

// Request input band used by models with different short-context and long-context prices.
export type UsageContextBand = 'short' | 'long';

export interface UsageCounts {
  requests?: number; // model requests, after repeated transcript lines are deduplicated
  input: number; // uncached input, charged at the base rate
  cacheWrite1h: number; // 2x base
  cacheWrite5m: number; // 1.25x base
  cacheWrite30m?: number; // Provider prompt-cache write with an explicit rate
  cacheRead: number; // 0.1x base
  output: number; // includes thinking
  thinking: number; // the reasoning share of output, already inside `output`
}

export interface TurnUsage extends UsageCounts {
  // Request-level totals for pricing rules that change above a context threshold. Missing
  // on models with one rate and on older records that did not preserve request bands.
  byContextBand?: Partial<Record<UsageContextBand, UsageCounts>>;
}

export interface TurnUsagePart {
  model: string | null;
  provider: string | null;
  contextWindow: number | null;
  contextBand: UsageContextBand | null;
  inferenceClass: UsageInferenceClass;
  serviceTier: string | null;
  unclassifiedCacheWrite?: number;
  incomplete?: boolean;
  requestCountExact?: false;
  linkedInvocationId?: string | null;
  // An estimated compaction request, which the transcript recorded no usage for.
  compactionEstimate?: true;
  compactionUsage?: true;
  usageOrigin?: UsageOrigin;
  waits?: UsageWaits;
  tools?: UsageTools;
  usage: TurnUsage;
}

// The requests that read a Codex wait return, and their summed usage. `timedOut` counts the
// requests whose every wait return was a timeout. `tools` counts the requests that read each
// wait tool's return, once per tool.
export interface UsageWaits {
  requests: number;
  timedOut: number;
  tools?: Record<string, number>;
  usage: TurnUsage;
}

// The requests that read tool results, by the kind `arc cost --by-tool` gives each result.
// `requests` counts the requests that read any result. Each kind counts the requests that read
// one of its results, and holds its even part of their usage, so its figures can be fractional.
export interface UsageTools {
  requests: number;
  kinds: Record<string, { requests: number; usage: TurnUsage }>;
}

// Usage that is not one ordinary recorded request. `claude-cost-state` is Claude supplemental
// accounting from a process-end record. `claude-advisor` is one advisor consultation.
export type UsageOrigin = 'claude-cost-state' | 'claude-advisor';

function samePricedPart(part: TurnUsagePart, event: UsageEvent | TurnUsagePart): boolean {
  return (
    part.model === event.model &&
    part.provider === event.provider &&
    part.contextWindow === event.contextWindow &&
    part.contextBand === event.contextBand &&
    part.inferenceClass === event.inferenceClass &&
    part.serviceTier === event.serviceTier &&
    part.unclassifiedCacheWrite === event.unclassifiedCacheWrite &&
    part.incomplete === event.incomplete &&
    part.requestCountExact === event.requestCountExact &&
    part.linkedInvocationId === event.linkedInvocationId &&
    part.compactionEstimate === event.compactionEstimate &&
    part.compactionUsage === event.compactionUsage &&
    part.usageOrigin === event.usageOrigin
  );
}

// Merge a part already priced elsewhere, such as a nested subagent's, into the matching part.
// The added part keeps its own context bands, so its usage merges without a band of its own.
function addPricedUsagePart(parts: TurnUsagePart[], add: TurnUsagePart): void {
  const same = parts.find((part) => samePricedPart(part, add));
  if (same) {
    addUsage(same.usage, add.usage);
    addUsageWaits(same, add.waits);
    mergeUsageTools(same, add.tools);
    return;
  }
  const usage = { ...add.usage };
  if (add.usage.byContextBand) {
    usage.byContextBand = Object.fromEntries(
      Object.entries(add.usage.byContextBand).map(([band, held]) => [band, { ...held }]),
    );
  }
  parts.push({
    ...add,
    ...(add.waits ? { waits: structuredClone(add.waits) } : {}),
    ...(add.tools ? { tools: structuredClone(add.tools) } : {}),
    usage,
  });
}

export function addTurnUsagePart(turn: Pick<Turn, 'usageParts'>, event: UsageEvent): void {
  const parts = (turn.usageParts ??= []);
  const same = parts.find((part) => samePricedPart(part, event));
  if (same) {
    addUsage(same.usage, event.usage, event.contextBand);
    addUsageWaits(same, event.waits);
    addUsageTools(same, event, event.contextBand);
    if (Object.values(same.usage).every((value) => typeof value !== 'number' || value === 0))
      parts.splice(parts.indexOf(same), 1);
    return;
  }
  const usage = { ...event.usage };
  if (event.usage.byContextBand) {
    usage.byContextBand = structuredClone(event.usage.byContextBand);
  } else if (event.contextBand) {
    usage.byContextBand = { [event.contextBand]: { ...event.usage } };
  }
  parts.push({
    model: event.model,
    provider: event.provider,
    contextWindow: event.contextWindow,
    contextBand: event.contextBand,
    inferenceClass: event.inferenceClass,
    serviceTier: event.serviceTier,
    ...(event.unclassifiedCacheWrite === undefined ? {} : { unclassifiedCacheWrite: event.unclassifiedCacheWrite }),
    ...(event.incomplete === undefined ? {} : { incomplete: event.incomplete }),
    ...(event.requestCountExact === undefined ? {} : { requestCountExact: event.requestCountExact }),
    ...(event.linkedInvocationId === undefined ? {} : { linkedInvocationId: event.linkedInvocationId }),
    ...(event.compactionEstimate ? { compactionEstimate: true as const } : {}),
    ...(event.compactionUsage ? { compactionUsage: true as const } : {}),
    ...(event.usageOrigin ? { usageOrigin: event.usageOrigin } : {}),
    ...(event.waits ? { waits: structuredClone(event.waits) } : {}),
    usage,
  });
  addUsageTools(parts[parts.length - 1], event, event.contextBand);
}

// Recorded prompt-cache lifetime spellings. Pricing resolves their rates separately.
export const CACHE_LIFETIMES = ['5m', '30m', '1h'] as const;
export type CacheLifetime = (typeof CACHE_LIFETIMES)[number];

export function isCacheLifetime(value: unknown): value is CacheLifetime {
  return typeof value === 'string' && (CACHE_LIFETIMES as readonly string[]).includes(value);
}

// The one request that established a turn's current context level.
export interface ContextRequest {
  // Effort belongs to the priced request. Older saved contexts leave it unknown.
  effort?: string | null;
  // Bedrock message identity is independent of its regional pricing multiplier.
  bedrock?: boolean;
  // When that request was recorded. The turn's own end moves with a tool result, an
  // interruption and a background notification, so it dates the turn and not this request.
  at: number;
  // Cache-write lifetime recorded by this request or the latest prior request, or null when neither recorded one.
  // `claudeUsage` prices an unsplit write as an hour write. That fallback establishes no recorded lifetime.
  lifetime: CacheLifetime | null;
  // Recorded pricing class used for subsequent request quotes.
  inferenceClass: UsageInferenceClass;
  serviceTier: string | null;
  // True when the request reported cached input reads. A cache write alone leaves this false.
  readBack: boolean;
  // The answer this request produced. Its input figure stops before that answer, while the
  // next request and a compaction both have to read it back as part of the session.
  outputTokens: number;
}

export type UsageBillingClass = 'metered' | 'subscription' | 'unknown';
// `bedrock-regional` marks a Claude request on an Amazon Bedrock inference profile other than
// `global.`, which Bedrock bills at 1.1 times list.
export type UsageInferenceClass = 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null;

// One recorded model request before it is grouped into a turn or a child-agent row.
export interface UsageEvent {
  timestamp: number;
  agent: AgentKind;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
  contextBand: UsageContextBand | null;
  billingClass: UsageBillingClass;
  inferenceClass: UsageInferenceClass;
  serviceTier: string | null;
  effort?: string | null;
  toolListVersion?: number | null;
  reportedCost: number | null;
  // The provider can report a calculated amount that is still only a list-price
  // estimate. This keeps it distinct from an invoice-backed reported cost.
  reportedCostBasis?: string | null;
  // A Claude result recorded inside a Codex command belongs to the parent session.
  // The linked session allows project aggregation to prefer a directly indexed transcript.
  linkedSessionId?: string | null;
  linkedInvocationId?: string | null;
  unclassifiedCacheWrite?: number;
  incomplete?: boolean;
  requestCountExact?: false;
  // Adjacency facts, read in exact request order before a daily or lifetime bucket removes
  // that order. `projectspend.ts` documents what each one answers.
  visibleTurnId?: string | null;
  cacheLifetime?: CacheLifetime | null;
  compactionsBefore?: number;
  // The final executor pass's input. Billing usage sums every pass of the response.
  contextTokens?: number;
  firstPassUsage?: UsageCounts;
  firstPassContextBand?: UsageContextBand | null;
  finalPassOutputTokens?: number;
  finalPassCacheRead?: number;
  usage: TurnUsage;
  requestKey: string;
  responseId?: string;
  // An estimated compaction request. Claude Code records no usage for one, so the reducer
  // estimates it and marks it here. It is never one of the ordered primary requests.
  compactionEstimate?: true;
  compactionUsage?: true;
  // The compaction that the estimated request stands for, which the ordered pass measures the
  // next cache-expiry return from.
  compactionSignal?: CompactionSignal;
  // A Claude advisor consultation inside the response named by `requestKey`'s parent key. It
  // bills as its own request of the advisor model and can record cache reads and writes.
  // It counts in cost and request totals, outside executor context, cache-expiry adjacency, and compaction figures.
  usageOrigin?: 'claude-advisor';
  // Set when this request read a wait return. Its usage equals the request's usage.
  waits?: UsageWaits;
  // The kind of each tool result this request read, in reading order, as `arc cost --by-tool`
  // names it. A request that read no result has none.
  toolResults?: string[];
}

// One compaction in request order, for the cache-expiry scan.
export interface CompactionSignal {
  ordinal: number;
  // When the record says the compaction happened, or null where it names no usable time.
  at: number | null;
  // The cached prefix the compaction left, in tokens. Null where no record establishes it
  // before the first request after the compaction.
  prefixTokens: number | null;
}

// Compaction fact in source order, with an explicit ordinal independent of its timestamp.
// A record without a usable clock still counts, so positions cannot pair bounded timestamps with the total.
export interface ReducerCompaction {
  ordinal: number;
  // When the record says the compaction happened, or null where it names no usable time.
  at: number | null;
  trigger: string | null;
  // The compaction request's own usage, where the record carries it. Codex writes it on the
  // compacted record. Claude writes none, and leaves this null.
  requestUsage: TurnUsage | null;
  responseId?: string;
  // That request's billing identity. A compacted record does not carry it, and current Codex
  // rollouts supply it in the following settings record, so these are filled from there when
  // one arrives before the compaction's turn closes.
  requestModel: string | null;
  requestProvider: string | null;
  requestServiceTier: string | null;
  requestContextWindow: number | null;
}

// Tool-call totals grouped by category.
export interface ToolCounts {
  edits: number; // Edit, Write, MultiEdit, NotebookEdit
  reads: number; // Read, NotebookRead
  searches: number; // Grep, Glob
  commands: number; // Bash, PowerShell
  agents: number; // Agent, Task, Workflow
  coordination: number; // calls that coordinate with an agent
  web: number; // WebFetch, WebSearch
  other: number;
}

// One answer a turn closed: the text of an assistant response that stopped for anything
// but a tool call, and when it was written. A turn woken mid-life by a task notification
// or a cross-session message closes several of these. The newest one without `notResponse`
// is the summary, and `responseAnswerIndex` finds it.
export interface TurnAnswer {
  sourceOrder?: number;
  text: string;
  stepsBefore: number;
  at: number; // epoch ms of the line that carried it
  // Why this answer never became the turn's response. A subagent's handback wakes the parent,
  // and its completion notice can wake it a second time after the parent replied to the
  // handback. A reply to that second wake is a `repeat-notice`. A reply whose whole text is
  // "No response requested." is `no-response-requested`, whatever woke it. A subagent that
  // reports through a `SubagentHandback` call makes that call's message its response, and a
  // reply it writes after the call is `after-handback`.
  notResponse?: 'repeat-notice' | 'no-response-requested' | 'after-handback';
}

// The index in `answers` of the answer the summary came from, or -1 when the summary is
// newer text that no response has closed yet or the turn closed no response. An answer
// marked `notResponse` never holds it.
export function responseAnswerIndex(turn: Pick<Turn, 'answers' | 'summary'>): number {
  for (let index = turn.answers.length - 1; index >= 0; index--) {
    if (turn.answers[index].notResponse) {
      continue;
    }
    return turn.answers[index].text === turn.summary ? index : -1;
  }
  return -1;
}

// Reader submission after the opening prompt, with its call position and timestamp.
export interface TurnAsk {
  sourceOrder?: number;
  text: string;
  stepsBefore: number;
  at: number; // epoch ms of the line that carried it
}

// The task a parent agent assigned to a delegated Codex session. Reader prompts stay in
// `prompt`, because the assignment came from another agent rather than from the reader.
export interface TurnDelegation {
  text: string;
  complete: boolean;
}

// Visible prose the agent wrote while it worked. This is separate from both tool calls and
// the response: it belongs in the ordered Activity record, but it must not increase a turn's
// tool totals or replace the answer the turn closed with.
export interface TurnUpdate {
  sourceOrder?: number;
  sourceId: string;
  stepsBefore: number;
  kind: 'commentary' | 'reasoning';
  text: string;
  at: number;
  status: TurnStepStatus;
}

// Maximum later prompts retained on one turn.
export const TURN_ASK_LIMIT = 12;

// Tool call in recorded order, separate from aggregate tool totals.
export interface TurnStep {
  ordinal: number;
  // Tool name as recorded by the source. Unknown names retain their spelling.
  name: string;
  // The source call id, when the transcript provides one. Launch rows use it to pick up
  // the outcome recorded later for the same subagent.
  id?: string;
  // Stable protocol identity used to replace a live row with the copy read from disk.
  sourceId?: string;
  // Human wording supplied for the call. The literal argument remains in `detail`.
  headline?: string;
  // The one thing the call acted on, cut to a line: the command, the path, the pattern, the
  // skill. Empty where the input named none, which a tool taking no arguments does.
  detail: string;
  // Exact detail for an on-demand disclosure. Parsers define this non-enumerably so it
  // never rides in the card payload or its JSON comparison string.
  fullDetail?: string;
  at: number;
  // Call outcome. Calls start running and settle when results or later activity establish an outcome.
  status: TurnStepStatus;
}

export type TurnStepStatus = 'running' | 'done' | 'failed' | 'interrupted';

// How well a record proves that the turn used a skill.
//
// `recorded` is a native `Skill` call: the client names the skill it loaded.
// `best-effort` is a Codex catalog path found inside a command that completed. The record
// proves that Codex read the instructions. It does not prove why Codex selected them.
export type SkillEvidence = 'recorded' | 'best-effort';

// One time a turn loaded a skill.
export interface TurnSkillUse {
  // The source call or command this use came from. An incremental reread of the same
  // record replaces the earlier copy instead of adding a second use.
  sourceId: string;
  // The skill as its source named it.
  name: string;
  // The one line the catalog published, cut to the row's length. Claude records none.
  description?: string;
  // The same line before the cut, for a hover that shows the whole of it.
  fullDescription?: string;
  // The recorded `SKILL.md` path. Absent where the source recorded none.
  path?: string;
  at: number;
  evidence: SkillEvidence;
}

// Maximum skill-use records retained on one turn, independent of the total use count.
export const TURN_SKILL_USE_LIMIT = 60;

// Skill-load category retained in `stepKinds` at its call ordinal.
// Tool-category totals exclude this category.
export const SKILL_STEP_KIND = 'skill';

// Maximum retained tool steps per turn. The newest calls remain visible.
// `Turn.stepCount` retains the full total for truncated Activity runs.
export const TURN_STEP_LIMIT = 60;

// Ordinary reads retain recent call associations beyond the visible card.
// Capture retains the current turn's Activity associations.
const CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN = TURN_STEP_LIMIT * 4;

// Maximum characters in a one-line tool-detail preview. Full details remain available separately.
export const STEP_DETAIL_LIMIT = 120;

// Suffix used when a tool-detail preview is shortened.
export const STEP_CUT = '...';

// Maximum characters in a wrapped narration preview.
export const NARRATION_DETAIL_LIMIT = 600;

// Tool-input preview with collapsed whitespace and the step-detail character bound.
export function stepDetail(input: Record<string, unknown>): string {
  return shortenTo(describeToolInput(input).replace(/\s+/g, ' ').trim(), STEP_DETAIL_LIMIT, STEP_CUT);
}

export interface PresentedStepDetail {
  detail: string;
  fullDetail?: string;
  policy: ActivityDetailPolicy;
  format: ActivityDetailFormat;
}

// Detail is selected from the operation and its input before it is shortened. Commands keep
// their exact form even when they fit, and every other subject keeps it whenever collapsing
// or cutting the preview would make the original impossible to recover.
export function presentedStepDetail(name: string, input: Record<string, unknown>): PresentedStepDetail {
  const presented = activityDetail(name, input);
  const oneLine = presented.exact.replace(/\s+/g, ' ').trim();
  const detail = shortenTo(oneLine, STEP_DETAIL_LIMIT, STEP_CUT);
  const retainExact = !!presented.exact && (presented.format === 'command' || presented.exact !== detail);
  return {
    detail,
    ...(retainExact ? { fullDetail: presented.exact } : {}),
    policy: presented.policy,
    format: presented.format,
  };
}

export interface Turn {
  agent: AgentKind;
  sessionId: string;
  sessionTitle: string | null;
  // The uncapped counterpart to `sessionTitle`, carried only so a parsed title can reach
  // Details without being paired with metadata from another transcript window.
  sessionFullTitle?: string | null;
  // The record `sessionTitle` came from, when the parse found one.
  sessionTitleSource?: RecordedTitleSource;
  // The byte offset of that record, when the read knew it.
  sessionTitleAt?: number;
  promptId: string;
  startedAt: number; // epoch ms of the user's prompt
  endedAt: number; // epoch ms of the last assistant activity in the turn
  processEndedAt?: number; // epoch ms when the Claude process invocation ended
  prompt: string; // what the user typed, with IDE and command wrappers stripped
  delegation?: TurnDelegation;
  // Original prompt submissions in time order, retained separately when unanswered prompts join a successor turn.
  // Prompt recall returns one submission at a time. Timestamps order these submissions against `laterPrompts`.
  promptParts?: readonly TurnAsk[];
  summary: string; // final assistant text of the turn, as markdown
  // Completed answers in source order. The newest eligible answer supplies the summary after completion.
  // While running, the summary can contain newer text without a completed answer.
  // Marks and waiting state read the summary alone, excluding resolved requests in earlier answers.
  answers: TurnAnswer[];
  // Explicit captures retain assistant text before a stop reason closes an answer.
  recordedAnswers?: TurnAnswer[];
  model: string | null; // the model that ran the turn, from its last real reply
  // The newest `model` attachment before that reply, kept only when it names the same model.
  // It names the window, as in `claude-opus-5-5[1m]`, which `model` never does.
  modelAttachment?: string;
  provider?: string | null; // the provider that billed the turn, where the source records it
  effort: string | null; // reasoning effort, from the last reply that recorded one
  files: TurnFileChange[];
  agents: TurnAgent[];
  commits: TurnCommit[]; // commits the turn made, from its git output
  // Calls that committed and printed nothing to read. Host-side only: the panel never sees
  // one, because `gitcommits.ts` turns it into a `commits` entry before a card is built.
  commitIntents?: CommitIntent[];
  // Trees the turn fast-forwarded, read back from the repository.
  landings?: TurnLanding[];
  // Calls that merged, host-side only, the way `commitIntents` is.
  landingIntents?: LandingIntent[];
  usage: TurnUsage;
  usageParts?: TurnUsagePart[];
  contextTokens: number; // input plus cache of the turn's last real assistant message
  // Estimated text that subagents returned into the session's context, as it stood at the end
  // of the turn. Absent when no subagent result entered context in the read.
  subagentContext?: SubagentContextFigure;
  outputRate?: import('./outputrate').OutputRate;
  outputRateModel?: string;
  // The interval that measured a Claude `outputRate`. An absent Claude basis means the observed stream.
  outputRateBasis?: OutputRateBasis;
  responseIds?: string[];
  // A child read's response ids, kept for request timing alone. Child reads leave `responseIds` unset.
  timedResponseIds?: string[];
  finalResponse?: { text: string; sourceId: string | null };
  // The turn's first response id, which the cap on `responseIds` never drops.
  openingResponseId?: string;
  // Request that established `contextTokens`, separate from aggregate usage and the turn end time.
  contextRequest?: ContextRequest;
  // Recorded runtime context window, or null when absent. It can differ from the published model window.
  contextWindow: number | null;
  toolUses: number;
  toolCounts: ToolCounts;
  // Every tool name in the turn, including calls beyond the activity step window.
  toolTally: Record<string, number>;
  // What the reader typed while the turn was already running, oldest first, cut to
  // `TURN_ASK_LIMIT`. The agent answers these inside the turn, so the card that shows the
  // answer has to show the question.
  laterPrompts: TurnAsk[];
  // What the turn did, in order, newest last. Export capture retains every step.
  steps: TurnStep[];
  // Launch ids stay after the bounded activity steps leave a long turn.
  dispatchToolUseIds?: string[];
  // Visible narration and clear reasoning summaries, oldest first. These are activity, not
  // tool calls, and stay outside every tool count.
  updates: TurnUpdate[];
  // How many steps the turn really ran, which is what `steps` was cut from.
  stepCount: number;
  // Complete call categories and failures survive the bounded step list.
  stepKinds: string[];
  failedOrdinals: number[];
  // Every skill the turn loaded, oldest first, cut to `TURN_SKILL_USE_LIMIT`. Kept outside
  // the bounded step window so a long turn still reports its skills after the calls that
  // loaded them leave the Activity list.
  skillUses: TurnSkillUse[];
  // How many uses the turn really recorded, which `skillUses` was cut from.
  skillUseCount: number;
  failures: ToolFailure[]; // tool calls that came back as failures, and what they said
  interrupted: boolean; // the user stopped the turn part-way
  finished: boolean; // the model closed the turn rather than being cut off mid-work
  error: string | null; // text of an API error that ended the turn, if any
}

type TurnText = Pick<Turn, 'promptParts' | 'laterPrompts' | 'answers' | 'updates'>;

// Capture source ordering only for newly retained text, without revisiting an entire long turn.
export function captureTurnTextOrder(turns: readonly (TurnText | null | undefined)[]) {
  const lists = (turn: TurnText) => [turn.promptParts ?? [], turn.laterPrompts, turn.answers, turn.updates];
  const lengths = new Map(
    turns
      .filter((turn): turn is TurnText => Boolean(turn))
      .map((turn) => [turn, lists(turn).map((items) => items.length)]),
  );
  return (next: readonly (TurnText | null | undefined)[], start: number): void => {
    for (const turn of next) {
      if (!turn) continue;
      for (const [index, items] of lists(turn).entries()) {
        for (let at = lengths.get(turn)?.[index] ?? 0; at < items.length; at++) items[at].sourceOrder ??= start;
      }
    }
  };
}

// Records a skill load by source ID and name. Repeated reads replace its earlier copy without increasing the total.
// A different source ID records another use of the same skill.
export function addTurnSkillUse(turn: Pick<Turn, 'skillUses' | 'skillUseCount'>, use: TurnSkillUse): void {
  const held = turn.skillUses.findIndex((earlier) => earlier.sourceId === use.sourceId && earlier.name === use.name);
  if (held >= 0) {
    turn.skillUses[held] = use;
    return;
  }
  turn.skillUses.push(use);
  turn.skillUseCount++;
  // Retain the newest skill loads while the total stays uncapped.
  if (turn.skillUses.length > TURN_SKILL_USE_LIMIT) {
    turn.skillUses.shift();
  }
}

export function setTurnStepStatus(turn: Pick<Turn, 'failedOrdinals'>, step: TurnStep, status: TurnStepStatus): void {
  step.status = status;
  if (status === 'failed' && !turn.failedOrdinals.includes(step.ordinal)) {
    turn.failedOrdinals.push(step.ordinal);
  }
}

export interface SessionFile {
  agent: AgentKind;
  file: string;
  sessionId: string;
  mtimeMs: number;
  size: number;
  // Filesystem identity from the listing stat, when supported.
  dev?: number | string;
  ino?: number | string;
  // Where the session ran, when its opening record says. Continuation uses this instead
  // of moving a session into whichever worktree the current editor window opened.
  cwd?: string;
  // Headless-run classification. Claude derives it from records. Codex supplies opening metadata.
  agentRun?: boolean;
  // Claude marks every record in a native child transcript as sidechain content.
  childTranscript?: boolean;
}

export interface ClaudeChildSessionFile extends SessionFile {
  agent: 'claude';
  parentSessionId: string;
  toolUseIds: string[];
  childTranscript: true;
  agentRun: true;
  cwd: string;
}

export interface ClaudeSubagentSessionReference {
  kind?: 'subagent';
  parentSessionId: string;
  sessionId: string;
  file: string;
  toolUseIds: string[];
}

export interface ClaudeDispatchSessionReference {
  kind: 'dispatch';
  agent: AgentKind;
  parentSessionId: string;
  // A launch can record the complete session id or only its unique hexadecimal prefix.
  sessionId: string;
  file: string | null;
  toolUseIds: string[];
  name: string | null;
  // Whether the launch recorded that the reader asked for this session, which only an
  // opted-in wrapper's receipt can say. A native background line or JSON result says nothing
  // of who asked, so it is false there.
  owned: boolean;
}

export type ClaudeChildSessionReference = ClaudeSubagentSessionReference | ClaudeDispatchSessionReference;

export function isClaudeSubagentReference(
  reference: ClaudeChildSessionReference,
): reference is ClaudeSubagentSessionReference {
  return reference.kind !== 'dispatch';
}

export interface ClaudeChildReferenceScan {
  complete: boolean;
  references: ClaudeChildSessionReference[];
}

export interface ClaudeChildDiscovery {
  references: ClaudeChildSessionReference[];
  children: ClaudeChildSessionFile[];
}

export interface ClaudeChildSessionResolver {
  read(reference: ClaudeSubagentSessionReference, repositoryRoots: readonly string[]): ClaudeChildSessionFile | null;
}

// The transcript can grow without its mtime changing on filesystems with a coarse clock or
// a restored timestamp. Both answers identify the revision that title and activity came
// from, so either moving invalidates that cache.
export function sameSessionRevision(
  cached: Pick<SessionFile, 'mtimeMs' | 'size'>,
  current: Pick<SessionFile, 'mtimeMs' | 'size'>,
): boolean {
  return cached.mtimeMs === current.mtimeMs && cached.size === current.size;
}

type CatalogRevision = Pick<SessionFile, 'mtimeMs' | 'size'> & Partial<Pick<SessionFile, 'dev' | 'ino'>>;

// A file replaced at the same path has a new device or inode. Only a full walk accepts it.
function replacedAtPath(held: SessionFile, now: CatalogRevision): boolean {
  return (
    (held.dev !== undefined && now.dev !== undefined && String(held.dev) !== String(now.dev)) ||
    (held.ino !== undefined && now.ino !== undefined && String(held.ino) !== String(now.ino))
  );
}

// Check held identities before catalog publication without blocking the extension host on filesystem reads.
// Append-only changes retain the catalog. A missing or replaced source requires discovery again.
export async function replacedCatalogFiles(
  sessions: readonly SessionFile[],
  signal: AbortSignal,
  statOf: (file: string) => Promise<CatalogRevision | null> = async (file) => {
    try {
      return revisionOf(await fs.promises.stat(file, { bigint: true }));
    } catch {
      return null;
    }
  },
): Promise<string[]> {
  const changed: string[] = [];
  for (let at = 0; at < sessions.length && !signal.aborted; at += 32) {
    await Promise.all(
      sessions.slice(at, at + 32).map(async (session) => {
        const current = await statOf(session.file);
        if (!current || replacedAtPath(session, current)) changed.push(session.file);
      }),
    );
  }
  return changed;
}

// Updates one selected session revision in a held catalog without changing its order.
// The selected tail needs its current size to include new records.
// Returns null for a missing selection, catalog row, or file, or a file replaced at its path.
export function revalidatedCatalog(
  sessions: readonly SessionFile[],
  showing: string | null,
  statOf: (file: string) => CatalogRevision | null,
): SessionFile[] | null {
  if (!showing) {
    return null;
  }
  const at = sessions.findIndex((session) => session.sessionId === showing);
  if (at < 0) {
    return null;
  }
  const held = sessions[at];
  const now = statOf(held.file);
  if (!now || replacedAtPath(held, now)) {
    return null;
  }
  const out = [...sessions];
  if (!sameSessionRevision(held, now)) {
    out[at] = { ...held, mtimeMs: now.mtimeMs, size: now.size };
  }
  return out;
}

// Revalidate only the files a directory watcher reported. Every path must already belong
// to the held catalog, and every file must still exist with its held device and inode. A miss
// means the directory changed shape, so the caller falls back to the authoritative walk that
// can discover additions, removals, and replacements.
export function revalidatedCatalogPaths(
  sessions: readonly SessionFile[],
  files: readonly string[],
  statOf: (file: string) => CatalogRevision | null,
): SessionFile[] | null {
  if (files.length === 0) {
    return null;
  }
  const byFile = new Map(sessions.map((session, index) => [normalizeFsPath(session.file), index]));
  const out = [...sessions];
  for (const file of files) {
    const at = byFile.get(normalizeFsPath(file));
    if (at === undefined) {
      return null;
    }
    const now = statOf(out[at].file);
    if (!now || replacedAtPath(out[at], now)) {
      return null;
    }
    if (!sameSessionRevision(out[at], now)) {
      out[at] = { ...out[at], mtimeMs: now.mtimeMs, size: now.size };
    }
  }
  return out;
}

// Listed revisions available to Project cost without another stat.
// A complete walk supplies every row. A reused catalog supplies the selected row alone.
// Other rows need their own current revisions before unchanged-source checks.
export function trustedListedRevisions(
  sessions: readonly SessionFile[],
  walked: boolean,
  showing: string | null,
): Map<string, Pick<SessionFile, 'mtimeMs' | 'size'>> {
  const trusted = walked ? sessions : sessions.filter((session) => session.sessionId === showing);
  return new Map(trusted.map((session) => [session.file, { mtimeMs: session.mtimeMs, size: session.size }]));
}

// Context replacement boundary shown between turns. Retained summary content remains available when recorded.
export interface Compaction {
  sessionId: string;
  at: number; // epoch ms
  contextBefore: number; // tokens the session had grown to
  contextAfter: number; // tokens the summary came to, 0 if unknown
  retainedContext?: { tokens: number; window: number | null };
  droppedTokens: number; // cumulative across the session, 0 if unknown
  durationMs: number; // how long the summarising call took, 0 if unknown
  trigger: string; // 'manual' when asked for, 'auto' when the context ran out
  model: string | null; // the model that ran, for pricing the summarising call
  summary: string; // the summary that carried over, as markdown
  // Compaction request usage when recorded. Claude records none.
  usage?: TurnUsage;
  responseId?: string;
  postCompactionCacheRead?: number | null;
  provider?: string | null;
  contextWindow?: number | null;
  inferenceClass?: UsageInferenceClass;
  serviceTier?: string | null;
  // The last main request before a Claude compaction, which sizes the input of the compaction
  // request. Null where the session held no earlier request.
  previousRequest?: CompactionPreviousRequest | null;
  // The length of a Claude summary's stored text, counted as `compactSummaryChars` counts it.
  summaryChars?: number;
  // The cache read plus cache write of the first request in the Claude transcript, from `claudeFirstRequestCachedTokens`.
  // Absent where the head of the file holds no request.
  firstRequestCachedTokens?: number;
  // Estimated text that subagents returned and that stayed in context after the compaction.
  // Absent when no subagent result entered context in the read.
  subagentContext?: SubagentContextFigure;
}

// Compaction metadata from a Claude system record.
interface CompactMetadata {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  cumulativeDroppedTokens?: number;
}

export interface SessionRead {
  // Recorded Codex identity for display only. It establishes no request or context facts.
  lastReportedModel?: string | null;
  turns: Turn[];
  compactions: Compaction[];
  // The transcript bytes covered by this parse. The provider retains it for the selected
  // session so an append cannot move the beginning past visible turns.
  readBytes: number;
  // True when the parser discarded at least one older turn at maxTurns.
  turnLimitReached: boolean;
  // Byte cursor for selected-tail recovery when the newest turn starts before the tail.
  newestTurnCursor?: BackwardLineCursor;
  newestTurnState?: unknown;
}

// Persisted source facts for session-list cost and context projections, without formatted figures.
export interface SessionStatTurnFacts {
  startedAt: number;
  endedAt: number;
  // An unfinished turn can hold a tool result that no later model request measured. Forward
  // prices wait for a closed turn rather than understating the context that comes next.
  finished: boolean;
  // A failed final request can leave an earlier successful request as the last measured
  // context. That context does not include any tool result sent to the failed request.
  error: boolean;
  model: string | null;
  effort?: string | null;
  provider: string | null;
  usage: TurnUsage;
  usageParts?: TurnUsagePart[];
  contextTokens: number;
  contextWindow: number | null;
  // Request behind the context level, used for session-list cache estimates.
  contextRequest?: ContextRequest | null;
  // The metadata pass deliberately does not read child transcripts. Their presence makes
  // the parent-only cost a floor until the ordinary parser supplies the complete figure.
  childSpendPartial: boolean;
  subagentContext?: SubagentContextFigure;
}

export interface SessionStatCompactionFacts {
  at: number;
  contextAfter: number;
  retainedContext?: Compaction['retainedContext'];
  subagentContext?: SubagentContextFigure;
  trigger: string;
  model: string | null;
}

export interface SessionStatFacts {
  turns: SessionStatTurnFacts[];
  compactions: SessionStatCompactionFacts[];
}

export function sessionStatFactsOf(read: SessionRead): SessionStatFacts | null {
  if (!read.turns.length) {
    return null;
  }
  return {
    turns: read.turns.map((turn) => ({
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      finished: turn.finished,
      error: turn.error !== null,
      model: turn.model,
      ...(turn.effort !== undefined ? { effort: turn.effort } : {}),
      provider: turn.provider ?? null,
      usage: {
        ...turn.usage,
        ...(turn.usage.byContextBand
          ? {
              byContextBand: Object.fromEntries(
                Object.entries(turn.usage.byContextBand).map(([band, counts]) => [band, { ...counts }]),
              ),
            }
          : {}),
      },
      ...(turn.usageParts
        ? {
            usageParts: turn.usageParts.map((part) => ({
              ...part,
              usage: {
                ...part.usage,
                ...(part.usage.byContextBand
                  ? {
                      byContextBand: Object.fromEntries(
                        Object.entries(part.usage.byContextBand).map(([band, counts]) => [band, { ...counts }]),
                      ),
                    }
                  : {}),
              },
            })),
          }
        : {}),
      contextTokens: turn.contextTokens,
      contextWindow: turn.contextWindow,
      contextRequest: turn.contextRequest ? { ...turn.contextRequest } : null,
      childSpendPartial: turn.agents.length > 0,
      ...(turn.subagentContext
        ? {
            subagentContext: {
              ...turn.subagentContext,
              agents: turn.subagentContext.agents.map((line) => ({ ...line })),
            },
          }
        : {}),
    })),
    compactions: read.compactions.map((compaction) => ({
      at: compaction.at,
      ...(compaction.retainedContext ? { retainedContext: { ...compaction.retainedContext } } : {}),
      ...(compaction.subagentContext
        ? {
            subagentContext: {
              ...compaction.subagentContext,
              agents: compaction.subagentContext.agents.map((line) => ({ ...line })),
            },
          }
        : {}),
      contextAfter: compaction.contextAfter,
      trigger: compaction.trigger,
      model: compaction.model,
    })),
  };
}

export function sessionOutcomeOf(read: SessionRead): TurnOutcome | null {
  let newest: Turn | null = null;
  const openChildren: string[] = [];
  const closedChildren: ClosedChild[] = [];
  const closedChildIndex = new Map<string, number>();
  for (const turn of read.turns) {
    if (!newest || turn.startedAt > newest.startedAt) {
      newest = turn;
    }
  }
  // Track background children across loaded turns in launch order until their results or completion notices close them.
  // A recorded process end clears the tracked children.
  for (const turn of [...read.turns].sort((a, b) => a.startedAt - b.startedAt)) {
    for (const agent of turn.agents) {
      // A row for a child an earlier turn launched carries only that turn's share of its cost.
      if (!agent.id || agent.launchedEarlier) {
        continue;
      }
      if (agentIsRunning(agent)) {
        if (!openChildren.includes(agent.id)) {
          openChildren.push(agent.id);
        }
      } else {
        closeChild(closedChildren, closedChildIndex, agent.id, agent.closedAt ?? turn.endedAt);
      }
    }
    if (turn.processEndedAt !== undefined) {
      openChildren.length = 0;
      closedChildren.length = 0;
      closedChildIndex.clear();
    }
  }
  return newest
    ? {
        finished: newest.finished,
        error: newest.error !== null,
        interrupted: newest.interrupted,
        endedAt: newest.endedAt,
        startedAt: newest.startedAt,
        ...(newest.processEndedAt !== undefined ? { processEndedAt: newest.processEndedAt } : {}),
        ...(openChildren.length > 0 ? { openChildren } : {}),
        ...(closedChildren.length > 0 ? { closedChildren: [...closedChildren] } : {}),
      }
    : null;
}

export function projectsRoot(): string {
  return process.env[`${ARC_IDENTITY.environmentPrefix}PROJECTS_ROOT`] || path.join(claudeConfigHome(), 'projects');
}

// Claude Code names a project directory after its cwd with every non-alphanumeric
// character replaced by a dash. The drive letter's case follows whichever session
// created the directory, so callers must match case-insensitively.
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function projectDirectoryMatches(name: string, slug: string): boolean {
  return name === slug || name.startsWith(slug.endsWith('-') ? slug : `${slug}-`);
}

// Recorded working directory from the first 64 KiB of the transcript.
// Saved child reference rows keep this result, so a change to it needs a `CLAUDE_CHILD_REFERENCE_PARSER_VERSION` bump.
export function readSessionCwd(file: string): string | null {
  return scanSessionCwd(file);
}

export function scanSessionCwd(file: string, onUnreadable?: () => void): string | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    return cwdFromDescriptor(file, fd);
  } catch {
    onUnreadable?.();
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function cwdFromDescriptor(file: string, fd: number): string | null {
  const buf = Buffer.allocUnsafe(64 * 1024);
  const read = meterRead(file, fs.readSync(fd, buf, 0, buf.length, 0));
  for (const line of buf.subarray(0, read).toString('utf8').split('\n')) {
    if (line.indexOf('"cwd"') < 0) continue;
    try {
      const o = JSON.parse(line) as { cwd?: unknown };
      if (typeof o.cwd === 'string' && o.cwd) return o.cwd;
    } catch {
      /* a partial last line, or a line without one */
    }
  }
  return null;
}

export function readQualifiedSessionCwd(file: string): { value: string; revision: FileRevision } | null {
  return readQualifiedOpening(file, (fd) => cwdFromDescriptor(file, fd));
}

// Opening metadata belongs to the descriptor and pathname only while their complete revisions agree.
export function readQualifiedOpening<T>(
  file: string,
  read: (fd: number) => T | null,
): { value: T; revision: FileRevision } | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const before = fs.fstatSync(fd, { bigint: true });
    const revision = revisionOf(before);
    if (!before.isFile() || revision.size < 0 || !supportedFileIdentity(revision)) return null;
    const value = read(fd);
    if (
      value === null ||
      !sameFileRevision(fs.fstatSync(fd, { bigint: true }), revision) ||
      !sameFileRevision(fs.statSync(file, { bigint: true }), revision)
    )
      return null;
    return { value, revision };
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Typed prompts without a known peer origin admit a session while pending or confirmed.
// A paired CLI answer withdraws that evidence until model work restores it.
export function holdsHumanPrompt(text: string): boolean {
  const scan: HumanPromptScan = { bytes: 0, found: false };
  scanPromptLines(text, scan);
  return promptScanLists(scan);
}

// Returns a typed prompt record so callers can read its timestamp.
// Listing excludes known peer origins. Turn counting includes them to match the turns drawn by `readSession`.
function humanPromptIn(line: string, refusePeer: boolean): Record<string, unknown> | null {
  if (line.indexOf('"type":"user"') < 0) {
    return null;
  }
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!isTypedPrompt(o)) {
    return null;
  }
  if (refusePeer) {
    const origin = o.origin as { kind?: string } | undefined;
    if (origin && origin.kind === 'peer') {
      return null;
    }
  }
  return o;
}

// Initial tail size for turn-start discovery.
export const TURN_START_BYTES = 1024 * 1024;

// The farthest a default turn-start glance reads when its first window finds no start.
// The worst case reads 16 MB from disk and rescans 31 MB of decoded text. A custom initial
// window scales the ceiling by the same ratio so small fixtures exercise the complete rule.
export const TURN_START_MAX_BYTES = 16 * 1024 * 1024;

// Turn-start timestamps and whether the read reached byte zero. Partial counts remain lower bounds.
export interface TurnStarts {
  starts: number[];
  whole: boolean;
}

// Widens one tail read until it finds a turn start or reaches the ceiling.
// Only reaching byte zero makes the returned count complete.
export function readTurnStartsFromTail(
  file: string,
  startsIn: (lines: string[]) => number[],
  bytes = TURN_START_BYTES,
  // Set for a Claude transcript, whose repeated records the window skips.
  claude = false,
): TurnStarts {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const initialBytes = Math.max(1, Math.floor(bytes));
    const scale = TURN_START_MAX_BYTES / TURN_START_BYTES;
    const maxBytes = initialBytes * scale;
    let targetBytes = Math.min(size, initialBytes);
    let start = size;
    let body = Buffer.alloc(0);

    while (true) {
      const nextStart = Math.max(0, size - targetBytes);
      const length = start - nextStart;
      const chunk = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const next = meterRead(file, fs.readSync(fd, chunk, read, length - read, nextStart + read));
        if (next <= 0) {
          throw new Error('Turn-start glance stopped before its requested range.');
        }
        read += next;
      }
      body = Buffer.concat([chunk, body]);
      start = nextStart;

      // Include the first line so a record starting exactly at the window boundary remains eligible.
      // The scanners reject partial JSON records.
      const split = body.toString('utf8').split('\n');
      const lines = claude ? blankClaudeRepeated(file, split, start, size, size - start) : split;
      const starts = startsIn(lines);
      if (starts.length) {
        return { starts, whole: start === 0 };
      }
      if (start === 0) {
        return { starts: [], whole: true };
      }
      if (targetBytes >= maxBytes) {
        return { starts: [], whole: false };
      }

      targetBytes = Math.min(size, maxBytes, targetBytes * 2);
    }
  } catch {
    return { starts: [], whole: false };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Turn starts in oldest-first order. Read failures return an empty, incomplete result.
export function readSessionTurnStarts(file: string, bytes = TURN_START_BYTES, childTranscript = false): TurnStarts {
  return readTurnStartsFromTail(file, (lines) => sessionTurnStartsIn(lines, childTranscript), bytes, true);
}

// A command's identity and pairing state in file order.
interface ClaudePromptPair {
  id: string;
  at: number;
  compact: boolean;
  withdrawn: boolean;
  // Whether a manual compaction boundary, rather than the CLI's own answer, withdrew the command.
  compacted?: boolean;
  queuedAt: number | null;
}

function promptPair(o: Record<string, unknown>, at: number): ClaudePromptPair | null {
  const id = claudeRecordId(o);
  return id ? { id, at, compact: claudeCompactPrompt(o), withdrawn: false, queuedAt: null } : null;
}

// Pairing follows file order and record IDs. Each reader owns the evidence it withdraws or restores.
// Model work after a compaction restores the command. Model work after the CLI's own answer
// resumes the turn before the command, so the command stays withdrawn.
function advancePromptPair(
  command: ClaudePromptPair,
  o: Record<string, unknown>,
): 'queued' | 'withdraw' | 'restore' | 'resume' | 'confirm' | null {
  const queued = readerQueuedAsk(o);
  if (queued) {
    if (!command.withdrawn) {
      command.compact = false;
      command.queuedAt ??= queued.at;
    }
    return 'queued';
  }
  if (!command.withdrawn && claudeProcessEndedAt(o) !== null) return 'confirm';
  const compacted = command.compact && claudeCompactAnswer(o, command.id, command.at) !== null;
  if (compacted || claudeLocalAnswer(o)?.parent === command.id) {
    if (command.withdrawn) return null;
    command.withdrawn = true;
    command.compacted = compacted;
    return 'withdraw';
  }
  if (claudeModelWorks(o)) {
    if (!command.withdrawn) return 'confirm';
    return command.compacted ? 'restore' : 'resume';
  }
  return null;
}

// A typed prompt stays a pending command until model work or a process end. The CLI's own answer
// to it, or a manual compaction boundary for `/compact`, withdraws its start. Model work restores
// the start only after a compaction. A prompt the reader queues before or after that answer starts
// a turn of its own in the command's place.
function sessionTurnStartsIn(lines: string[], childTranscript = false): number[] {
  const starts: number[] = [];
  let command:
    | (ClaudePromptPair & {
        index: number;
        queued: boolean;
      })
    | null = null;
  for (const line of lines) {
    if (
      !line.includes('"type":"user"') &&
      (!command ||
        (!line.includes('"type":"assistant"') &&
          !line.includes('"local_command"') &&
          !line.includes('"compact_boundary"') &&
          !line.includes('"queued_command"') &&
          !line.includes('"cost-state"')))
    )
      continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (!o || typeof o !== 'object' || (o.isSidechain && !childTranscript)) continue;
      if (o.type === 'user' && isTypedPrompt(o, childTranscript)) {
        command = null;
        const at = Date.parse(String(o.timestamp));
        if (!Number.isFinite(at)) continue;
        const pair = promptPair(o, at);
        if (pair) command = { ...pair, index: starts.length, queued: false };
        starts.push(at);
      } else if (command) {
        const step = advancePromptPair(command, o);
        if (step === 'queued' && command.withdrawn && !command.queued) {
          starts.push(readerQueuedAsk(o)!.at);
          command.queued = true;
        } else if (step === 'withdraw') {
          starts.splice(command.index, 1, ...(command.queuedAt === null ? [] : [command.queuedAt]));
          command.queued = command.queuedAt !== null;
        } else if (step === 'restore' || step === 'resume' || step === 'confirm') {
          if (step === 'restore') starts.splice(command.index, command.queued ? 1 : 0, command.at);
          command = null;
        }
      }
    } catch {
      /* a partial line has no turn start */
    }
  }
  return starts;
}

// Complete-line cursor and confirmed human evidence. Pending and withdrawn pairs resume on append.
export interface HumanPromptScan {
  bytes: number;
  found: boolean;
  complete?: boolean;
  source?: FileRevision;
  pending?: { bytes: number; pos: number; carry: Buffer | null };
  command?: ClaudePromptPair;
  prompt?: string;
  queuedPrompt?: string;
  // Earlier fallback prompts withdrawn before the currently retained prompt.
  released?: boolean;
}

export function promptScanLists(scan: HumanPromptScan): boolean {
  return scan.found || !!(scan.command && !scan.command.withdrawn);
}

function scanPromptLines(
  text: string,
  scan: HumanPromptScan,
  {
    refusePeer = true,
    childTranscript = false,
    confirmQueued = true,
    capturePrompt = false,
    pairBytes = Infinity,
  }: {
    refusePeer?: boolean;
    childTranscript?: boolean;
    confirmQueued?: boolean;
    capturePrompt?: boolean;
    pairBytes?: number;
  } = {},
): boolean {
  let bytes = 0;
  for (const line of text.split('\n')) {
    if (pairBytes !== Infinity) bytes += Buffer.byteLength(line) + 1;
    const withinPairWindow = bytes <= pairBytes;
    if (!withinPairWindow && scan.command && !scan.command.withdrawn) {
      scan.found = true;
      return true;
    }
    if (!claudePromptScanLineMayMatter(line)) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object' || (o.isSidechain && !childTranscript)) continue;
    if (capturePrompt && scan.command) {
      const queued = readerQueuedAsk(o);
      if (queued) scan.queuedPrompt ??= queued.text;
    }
    if (o.type === 'user' && isTypedPrompt(o, childTranscript)) {
      if (refusePeer && (o.origin as { kind?: string } | undefined)?.kind === 'peer') {
        if (scan.command && !scan.command.withdrawn) {
          scan.found = true;
          return true;
        }
        scan.command = undefined;
        continue;
      }
      if (scan.command && !scan.command.withdrawn) {
        scan.found = true;
      } else {
        if (scan.command?.withdrawn) scan.released = true;
        if (capturePrompt) {
          scan.prompt =
            scan.command?.withdrawn && scan.queuedPrompt
              ? scan.queuedPrompt
              : textOf((o.message as { content?: unknown } | undefined)?.content);
        }
        scan.command =
          scan.command?.withdrawn && scan.queuedPrompt ? undefined : (promptPair(o, stamp(o.timestamp)) ?? undefined);
        scan.queuedPrompt = undefined;
        scan.found = !scan.command || !withinPairWindow;
      }
    } else if (scan.command && withinPairWindow) {
      const step = advancePromptPair(scan.command, o);
      if (step === 'restore' || step === 'confirm' || (step === 'queued' && confirmQueued)) scan.found = true;
    }
    if (scan.found) return true;
  }
  return false;
}

// Resumes from the complete-line cursor until human evidence is confirmed.
// Preserve UTF-8 bytes across chunks and incomplete trailing lines. Shrinkage restarts scanning.
export function scanForHumanPrompt(file: string, size: number, prev?: HumanPromptScan): HumanPromptScan {
  const steps = humanPromptScanSteps(file, size, prev);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

// Each step reads at most one chunk. Callers share scheduling allowances across sources.
export function* humanPromptScanSteps(
  file: string,
  size: number,
  prev?: HumanPromptScan,
  readLimit = () => 256 * 1024,
  progress?: (scan: HumanPromptScan) => void,
): Generator<number, HumanPromptScan> {
  if (prev?.found && prev.bytes <= size) {
    return prev;
  }
  const from = prev && prev.bytes <= size ? prev.bytes : 0;
  const scan: HumanPromptScan =
    prev && (from > 0 || (prev.pending && prev.pending.pos <= size))
      ? { ...prev, ...(prev.command ? { command: { ...prev.command } } : {}) }
      : { bytes: 0, found: false };
  const cursor =
    scan.pending && scan.pending.pos <= size ? { ...scan.pending } : { bytes: from, pos: from, carry: null };
  const steps = completeLineSteps(file, from, size, (text) => scanPromptLines(text, scan), readLimit, cursor);
  let step;
  try {
    step = steps.next();
    while (!step.done) {
      scan.bytes = cursor.bytes;
      scan.pending = { ...cursor };
      scan.complete = false;
      progress?.(scan);
      yield step.value;
      step = steps.next();
    }
  } finally {
    steps.return({ bytes: cursor.bytes, rest: null });
  }
  const { bytes, rest } = step.value;
  delete scan.pending;
  scan.bytes = bytes;
  scan.complete = scan.found || (rest !== null && bytes === size);
  return scan;
}

// Visits complete lines between `from` and `size`, returning the exclusive complete-line byte cursor.
// Split UTF-8 bytes at newlines and preserve trailing fragments across buffer reuse.
// A true visitor result stops the read.
// `rest` contains the final fragment, or an empty buffer after a newline, only when the read reaches `size`.
// Stopped or unreadable scans return null `rest`.
export function readCompleteLines(
  file: string,
  from: number,
  size: number,
  visit: (text: string) => boolean,
): { bytes: number; rest: Buffer | null } {
  const steps = completeLineSteps(file, from, size, visit);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function* completeLineSteps(
  file: string,
  from: number,
  size: number,
  visit: (text: string) => boolean,
  readLimit = () => 256 * 1024,
  cursor = { bytes: from, pos: from, carry: null as Buffer | null },
): Generator<number, { bytes: number; rest: Buffer | null }> {
  let bytes = from;
  if (size <= bytes) {
    return { bytes, rest: Buffer.alloc(0) };
  }
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    let carry = cursor.carry;
    let pos = cursor.pos;
    const chunk = Buffer.allocUnsafe(256 * 1024);
    while (pos < size) {
      const read = meterRead(file, fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos, readLimit()), pos));
      if (read <= 0) {
        break;
      }
      pos += read;
      const buf: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        // Copied, because the next read overwrites the chunk the slice points into.
        carry = Buffer.from(buf);
        Object.assign(cursor, { bytes, pos, carry });
        yield read;
        continue;
      }
      carry = lastNewline + 1 < buf.length ? Buffer.from(buf.subarray(lastNewline + 1)) : null;
      bytes = pos - (carry ? carry.length : 0);
      const stopped = visit(buf.subarray(0, lastNewline).toString('utf8'));
      Object.assign(cursor, { bytes, pos, carry });
      yield read;
      if (stopped) return { bytes, rest: null };
    }
    if (pos >= size) {
      return { bytes, rest: carry ?? Buffer.alloc(0) };
    }
  } catch {
    /* unreadable. Return collected lines. */
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return { bytes, rest: null };
}

// Source of a recorded session title. Custom names rank above generated names.
export type RecordedTitleSource = 'custom' | 'generated';

export interface RecordedTitlePair {
  short: string | null;
  full: string | null;
  source: RecordedTitleSource | null;
  // The byte offset of the record in the file, when the read knew where its window began.
  at?: number;
}

export function readSessionRecordedTitlePair(file: string, bytes = 256 * 1024): RecordedTitlePair {
  const read = tailOf(file, bytes);
  return recordedTitlePairIn(read.lines, read.offset);
}

// Normalized custom title, or null for a missing or blank value.
// Held session names follow the ranking in `sessionnames.ts` separately.
export function customTitleOf(o: { customTitle?: unknown }): string | null {
  return typeof o.customTitle === 'string' ? normalizeSessionTitle(o.customTitle) : null;
}

// The most a rename confirmation reads of Claude Code's saved title file.
export const CUSTOM_TITLE_SIDECAR_BYTES = 4 * 1024;

// The custom title Claude Code saved beside a transcript, at
// `<transcript directory>/<session id>/custom-title.json`, or null when the file is missing,
// unreadable, or larger than the bound. The title is returned exactly as saved, so a
// confirmation compares the whole value. Only a rename confirmation calls this. No listing
// or metadata path reads the file.
export function readCustomTitleSidecar(sessionFile: string, bytes = CUSTOM_TITLE_SIDECAR_BYTES): string | null {
  const sessionId = path.basename(sessionFile, '.jsonl');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId) || bytes <= 0) {
    return null;
  }
  const sidecar = path.join(path.dirname(sessionFile), sessionId, 'custom-title.json');
  let fd = -1;
  try {
    fd = fs.openSync(sidecar, 'r');
    // The size is checked on the open file, so a file that grows after a stat cannot make
    // this read more than the bound.
    const size = fs.fstatSync(fd).size;
    if (size < 1 || size > bytes) {
      return null;
    }
    const content = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = meterRead(sidecar, fs.readSync(fd, content, offset, size - offset, offset));
      if (read <= 0) {
        return null;
      }
      offset += read;
    }
    const parsed = JSON.parse(content.toString('utf8')) as { customTitle?: unknown } | null;
    return typeof parsed?.customTitle === 'string' ? parsed.customTitle : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

// The newest `custom-title` in the window, else the newest `ai-title`. Only the newest record
// of each kind counts, so a newest title with no plain text names nothing.
function recordedTitlePairIn(lines: string[], offset?: number): RecordedTitlePair {
  const at = (index: number): { at?: number } => {
    if (offset === undefined) {
      return {};
    }
    let position = offset;
    for (let i = 0; i < index; i++) {
      position += Buffer.byteLength(lines[i]) + 1;
    }
    return { at: position };
  };
  let generated: RecordedTitlePair | null = null;
  let customSeen = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const custom = !customSeen && lines[i].indexOf('"custom-title"') >= 0;
    if (!custom && (generated || lines[i].indexOf('"ai-title"') < 0)) {
      continue;
    }
    try {
      const o = JSON.parse(lines[i]) as { type?: string; aiTitle?: unknown; customTitle?: unknown };
      if (custom && o.type === 'custom-title') {
        const short = customTitleOf(o);
        if (short) {
          return { short, full: normalizeFullSessionTitle(o.customTitle as string), source: 'custom', ...at(i) };
        }
        customSeen = true;
        continue;
      }
      if (!generated && o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle) {
        const short = normalizeSessionTitle(o.aiTitle);
        generated = short
          ? { short, full: normalizeFullSessionTitle(o.aiTitle), source: 'generated', ...at(i) }
          : { short: null, full: null, source: null };
      }
    } catch {
      /* skip malformed line */
    }
  }
  return generated?.short ? generated : { short: null, full: null, source: null };
}

// Head window for fallback names from the first typed prompt. A prompt beyond it supplies no name.
export const SESSION_HEAD_BYTES = 128 * 1024;

// Head window used for the file fingerprint when a recorded title already names the session.
export const HEAD_KEY_BYTES = 4096;

// A short fingerprint of a file's first record. An append-only transcript keeps it for life,
// so a different one means the path now holds another transcript.
function headKeyOf(firstLine: string): string {
  return createHash('sha1').update(firstLine).digest('hex').slice(0, 16);
}

function firstPromptIn(
  lines: string[],
  childTranscript: boolean,
): { short: string | null; full: string | null; withdrawnPrompt?: boolean } {
  const scan: HumanPromptScan = { bytes: 0, found: false };
  // Whole reads retain naming reach. Command pairing uses evidence inside the head window alone.
  scanPromptLines(lines.join('\n'), scan, {
    refusePeer: false,
    childTranscript,
    confirmQueued: false,
    capturePrompt: true,
    pairBytes: SESSION_HEAD_BYTES,
  });
  const withdrawnPrompt = scan.released || (!scan.found && scan.command?.withdrawn);
  const source = cleanPrompt(promptScanLists(scan) ? (scan.prompt ?? '') : (scan.queuedPrompt ?? ''));
  return {
    short: normalizeSessionTitle(source) || null,
    full: normalizeFullSessionTitle(source) || null,
    ...(withdrawnPrompt ? { withdrawnPrompt: true } : {}),
  };
}

// Whole lines from the head of a file. The last one is dropped when it runs past the
// window, because it is a fragment rather than a record.
export function headLines(file: string, bytes: number): string[] {
  return headOf(file, bytes).lines;
}

// The same read, with the fingerprint of the first record when the window holds all of it.
function headOf(file: string, bytes: number): { lines: string[]; key?: string } {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(bytes);
    const read = meterRead(file, fs.readSync(fd, buf, 0, bytes, 0), 0);
    const text = buf.subarray(0, read).toString('utf8');
    const lines = text.split('\n');
    if (read === bytes) {
      lines.pop();
    }
    return { lines, ...(lines.length > 1 || (read === bytes && lines.length > 0) ? { key: headKeyOf(lines[0]) } : {}) };
  } catch {
    return { lines: [] };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

type SessionTitle = {
  short: string | null;
  full: string | null;
  source: 'custom' | 'generated' | 'prompt' | null;
  at?: number;
};

// A session's name with the source it came from, and the fingerprint of the file's first
// record. The recorded title comes from the tail window. The first prompt comes from the tail
// when the window reaches the start of the file, else from a read of the head.
function sessionTitleOf(
  file: string,
  read: TailRead,
  childTranscript: boolean,
): { title: SessionTitle; headKey?: string; withdrawnPrompt?: boolean } {
  const recorded = recordedTitlePairIn(read.lines, read.offset);
  const head = read.whole
    ? { lines: read.lines, ...(read.lines.length > 1 ? { key: headKeyOf(read.lines[0]) } : {}) }
    : headOf(file, recorded.short ? HEAD_KEY_BYTES : SESSION_HEAD_BYTES);
  if (recorded.short) {
    return { title: recorded, headKey: head.key };
  }
  const prompt = firstPromptIn(head.lines, childTranscript);
  return {
    title: prompt.short ? { ...prompt, source: 'prompt', at: 0 } : { short: null, full: null, source: null },
    headKey: head.key,
    ...(prompt.withdrawnPrompt ? { withdrawnPrompt: true } : {}),
  };
}

// Newest usable timestamp in the tail, or null when none exists.
// Bookkeeping can advance file modification time without recording activity.
// Records can arrive out of timestamp order, so the reader takes their maximum timestamp.
// Unreadable timestamps are excluded rather than replaced with epoch zero.
export function readSessionActivity(file: string, bytes = 256 * 1024): number | null {
  return activityIn(claudeTailOf(file, bytes, false, true).lines);
}

// Only user and assistant timestamps establish resumed child work.
// Disjoint backward reads recover complete records beyond bookkeeping and split records.
// It reads at most `bytes` of map extension and lookups, so it never waits for the repeated-record map.
export function readSessionWork(file: string, bytes = 256 * 1024, now = Infinity): number | null {
  const tail = claudeTailOf(file, bytes, true, true);
  if (!tail.success) return null;
  let newest = activityIn(tail.lines, true, now);
  let cursor = tail.cursor;
  const skip = cursor ? claudeRepeatedClassifier(file, cursor.revision.size, bytes) : null;
  while (cursor && cursor.end > 0) {
    const batch = readPreviousLines(file, cursor, bytes);
    if (!batch) return null;
    const at = activityIn(
      batch.lines.filter((line) => !skip?.(line.offset, line.text)).map((line) => line.text),
      true,
      now,
    );
    if (at !== null) newest = Math.max(newest ?? -Infinity, at);
    cursor = batch.cursor;
  }
  return newest;
}

export interface TurnOutcome {
  finished: boolean;
  error: boolean;
  interrupted: boolean;
  endedAt: number;
  startedAt?: number;
  processEndedAt?: number;
  // The ids of the children launched in the background and not yet named by a completion
  // notice, in launch order. A typed prompt does not close them. Omitted when there is none.
  openChildren?: string[];
  // The background children a completion notice or a finished row closed, since the last
  // recorded process end. A legacy persisted outcome can carry only an id. Without a close
  // time that child stays closed. Omitted when there is none.
  closedChildren?: ClosedChild[];
  // The `Bash` calls launched with `run_in_background` that no completion notice, stop call or
  // error result has ended, in launch order. Omitted when there is none.
  backgroundCommands?: BackgroundCommand[];
}

export type ClosedChild = string | { id: string; closedAt: number };

// A command the agent started in the background: the id of its `Bash` call and when the call
// was recorded.
export interface BackgroundCommand {
  id: string;
  startedAt: number;
}

// Retirement retains identified launches independently of display windows and expiry.
export class ClaudeBackgroundWork {
  private readonly open = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly tasks = new Map<string, string>();
  private readonly toolTasks = new Map<string, string>();
  private readonly ambiguous = new Set<string>();
  private readonly launches = new Map<string, string>();

  get pending(): boolean {
    return this.open.size > 0;
  }

  retain(commands: readonly BackgroundCommand[], children: readonly string[]): void {
    for (const key of [...commands.map((command) => `tool:${command.id}`), ...children.map((id) => `child:${id}`)])
      if (!this.completed.has(key)) this.open.add(key);
  }

  observe(record: Record<string, unknown>, owner = 'unidentified'): void {
    const content = (record.message as { content?: unknown } | undefined)?.content;
    const blocks = Array.isArray(content)
      ? content.filter(
          (block): block is Record<string, unknown> => !!block && typeof block === 'object' && !Array.isArray(block),
        )
      : [];
    if (record.type === 'assistant') {
      let identity: string | undefined;
      for (const block of blocks) {
        const input = block.input as { run_in_background?: unknown } | undefined;
        if (
          block.type !== 'tool_use' ||
          !['Bash', 'Agent', 'Task'].includes(String(block.name)) ||
          input?.run_in_background !== true ||
          typeof block.id !== 'string' ||
          !block.id
        )
          continue;
        const key = `tool:${block.id}`;
        identity ??= owner + ':' + (typeof record.uuid === 'string' ? record.uuid : JSON.stringify(record));
        if (this.completed.has(key) || (this.open.has(key) && this.launches.get(key) !== identity))
          this.ambiguous.add(key);
        this.launches.set(key, identity);
        this.open.add(key);
      }
    }
    if (record.type === 'user') {
      const result = (record.tool_use_result ?? record.toolUseResult) as
        | { status?: unknown; agentId?: unknown; backgroundTaskId?: unknown }
        | undefined;
      for (const block of blocks) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const key = `tool:${block.tool_use_id}`;
        const child = result?.status === 'async_launched' || result?.status === 'launched' ? result.agentId : undefined;
        const task = child ?? result?.backgroundTaskId;
        if (typeof task === 'string' && task) {
          const previous = this.tasks.get(task);
          const previousTask = this.toolTasks.get(key);
          if (previousTask !== undefined && previousTask !== task) {
            this.ambiguous.add(key);
            this.ambiguous.add(`child:${previousTask}`);
            this.ambiguous.add(`child:${task}`);
          }
          if (previous !== undefined && previous !== key) {
            this.ambiguous.add(previous);
            this.ambiguous.add(key);
            this.ambiguous.add(`child:${task}`);
          }
          this.tasks.set(task, key);
          this.toolTasks.set(key, task);
          if (!this.completed.has(key)) this.open.add(key);
        }
      }
    }
    const notice = claudeTaskNotification(record);
    if (!notice) return;
    const tool = `tool:${notice.toolId}`,
      child = `child:${notice.taskId}`;
    const mapped = this.tasks.get(notice.taskId);
    const mappedTask = this.toolTasks.get(tool);
    if ((mapped !== undefined && mapped !== tool) || (mappedTask !== undefined && mappedTask !== notice.taskId)) return;
    for (const key of [tool, child]) {
      if (this.open.has(key) && !this.ambiguous.has(key)) {
        this.open.delete(key);
        this.completed.add(key);
      }
    }
  }
}

function closedChildId(child: ClosedChild): string {
  return typeof child === 'string' ? child : child.id;
}

function indexClosedChildren(children: readonly ClosedChild[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let at = 0; at < children.length; at++) {
    const id = closedChildId(children[at]);
    if (!index.has(id)) {
      index.set(id, at);
    }
  }
  return index;
}

function closeChild(children: ClosedChild[], index: Map<string, number>, id: string, closedAt: number): boolean {
  const next = { id, closedAt };
  const heldAt = index.get(id);
  if (heldAt === undefined) {
    index.set(id, children.length);
    children.push(next);
    return true;
  }
  const held = children[heldAt];
  if (typeof held !== 'string' && held.closedAt === closedAt) {
    return false;
  }
  children[heldAt] = next;
  return true;
}

// The child id a background launch result opens, or null for any other record.
function claudeBackgroundLaunchOf(record: Record<string, unknown>): string | null {
  if (record.type !== 'user') {
    return null;
  }
  const result = record.toolUseResult as { status?: unknown; agentId?: unknown } | undefined;
  if (!result || typeof result !== 'object') {
    return null;
  }
  if (result.status !== 'async_launched' && result.status !== 'launched') {
    return null;
  }
  return typeof result.agentId === 'string' && result.agentId ? result.agentId : null;
}

// The child id a completion notice closes. A notice that still reports `running`, or that
// carries no status, closes nothing, as it leaves the full read's row open.
function claudeClosedChildOf(notice: string): string | null {
  const status = /<status>([^<]+)<\/status>/.exec(notice);
  if (!status || status[1] === 'running') {
    return null;
  }
  return /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1] ?? null;
}

// Add one notice to an ordered close list. A notice closes its child even when the launch lies
// before the read, so a wider read that holds the launch cannot reopen it.
function addClosedChildNotice(
  closed: ClosedChild[],
  index: Map<string, number>,
  notice: string | null,
  closedAt: number,
): boolean {
  const id = notice === null ? null : claudeClosedChildOf(notice);
  return id !== null && closeChild(closed, index, id, closedAt);
}

// The open children after one record, as a new list, or the same list when nothing changed.
function nextOpenChildren(
  open: readonly string[],
  record: Record<string, unknown>,
  notice: string | null,
): readonly string[] {
  const closed = notice === null ? null : claudeClosedChildOf(notice);
  if (closed !== null) {
    return open.includes(closed) ? open.filter((id) => id !== closed) : open;
  }
  const launched = claudeBackgroundLaunchOf(record);
  return launched !== null && !open.includes(launched) ? [...open, launched] : open;
}

// The background commands after one record, as a new list, or the same list when nothing
// changed. A notice ends the command whose call it names, whatever status it reports, because
// a stopped command can report a status nobody has seen. A stop call ends the command whose task
// it names, and it writes no notice. `tasks` maps each task id a launch result reported to its
// launch call id. A launch whose result is an error never started. A background `Agent` call is
// left out, as its child has its own open-child record.
function nextBackgroundCommands(
  open: readonly BackgroundCommand[],
  record: Record<string, unknown>,
  notice: string | null,
  tasks: Map<string, string>,
): readonly BackgroundCommand[] {
  if (notice !== null) {
    const ended = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notice)?.[1];
    return ended !== undefined ? withoutCommand(open, ended) : open;
  }
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return open;
  }
  const blocks = content as Array<{
    type?: unknown;
    name?: unknown;
    id?: unknown;
    input?: unknown;
    tool_use_id?: unknown;
    is_error?: unknown;
  }>;
  let next = open;
  if (record.type === 'user') {
    const taskId = (record.toolUseResult as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId;
    for (const block of blocks) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
        continue;
      }
      if (block.is_error === true) {
        next = withoutCommand(next, block.tool_use_id);
      } else if (typeof taskId === 'string' && taskId) {
        tasks.set(taskId, block.tool_use_id);
      }
    }
    return next;
  }
  if (record.type !== 'assistant') {
    return open;
  }
  for (const block of blocks) {
    if (block.type !== 'tool_use') {
      continue;
    }
    const input = block.input as { run_in_background?: unknown; task_id?: unknown; shell_id?: unknown } | undefined;
    if (block.name === 'TaskStop' || block.name === 'KillShell') {
      const taskId = input?.task_id ?? input?.shell_id;
      const launch = typeof taskId === 'string' ? tasks.get(taskId) : undefined;
      if (launch !== undefined) {
        next = withoutCommand(next, launch);
      }
      continue;
    }
    if (block.name !== 'Bash' || typeof block.id !== 'string' || !block.id) {
      continue;
    }
    if (input?.run_in_background !== true) {
      continue;
    }
    const id = block.id;
    if (next.some((command) => command.id === id)) {
      continue;
    }
    next = [...next, { id, startedAt: stamp(record.timestamp) }];
  }
  return next;
}

// The commands without the one launched by call `id`, or the same list when none has that id.
function withoutCommand(open: readonly BackgroundCommand[], id: string): readonly BackgroundCommand[] {
  return open.some((command) => command.id === id) ? open.filter((command) => command.id !== id) : open;
}

export interface SessionMeta {
  withdrawnPrompt?: boolean;
  coverage?: MetadataCoverage;
  title: string | null;
  fullTitle: string | null;
  titleSource: 'custom' | 'generated' | 'prompt' | null;
  // The byte offset of the record the title came from. A prompt title answers 0.
  titleAt?: number;
  // The fingerprint of the file's first record, when a read held all of it.
  headKey?: string;
  activityMs: number | null;
  agentRun: boolean | null;
  outcome: TurnOutcome | null;
  // The background commands the tail read found when it holds no typed prompt, so `outcome` is
  // null. A long turn that end records keep waking has its prompt before the tail. Omitted when
  // there is none.
  backgroundCommands?: BackgroundCommand[];
  stats?: SessionStatFacts | null;
}

// Reads metadata and optional stats through a shared tail window. A separate head read supplies title fallback and fingerprinting when needed.
export function readSessionMeta(
  file: string,
  bytes = 256 * 1024,
  sessionId = '',
  childTranscript = false,
): SessionMeta {
  const read = tailOf(file, bytes);
  read.lines = blankClaudeRepeated(file, read.lines, read.offset ?? 0, Number.MAX_SAFE_INTEGER, bytes);
  const { title, headKey, withdrawnPrompt } = sessionTitleOf(file, read, childTranscript);
  const tail = outcomeIn(read.lines, childTranscript);
  return {
    ...(read.success ? { coverage: { whole: read.whole, windowBytes: bytes } } : {}),
    title: title.short,
    fullTitle: title.full,
    titleSource: title.source,
    ...(withdrawnPrompt ? { withdrawnPrompt: true } : {}),
    ...(title.source && title.at !== undefined ? { titleAt: title.at } : {}),
    ...(headKey ? { headKey } : {}),
    activityMs: activityIn(read.lines),
    agentRun: childTranscript ? true : agentRunIn(read.lines, read.whole),
    outcome: tail.outcome,
    ...(!tail.outcome && tail.backgroundCommands.length > 0 ? { backgroundCommands: tail.backgroundCommands } : {}),
    ...(sessionId
      ? {
          stats: sessionStatFactsOf(
            readSessionLines(read.lines, sessionId, { maxTurns: 40, childTranscript }, read.readBytes),
          ),
        }
      : {}),
  };
}

// Classifies a complete transcript as an agent run, a reader session, or unknown.
// A partial window or malformed complete record leaves classification unknown. An unfinished last line is excluded.
// Non-SDK entrypoints and human-origin prompts establish a reader session unless background mode is already recorded.
// Later background metadata cannot undo those immediate reader signs.
// Editor content, reader-queued follow-ups, explicit tool rejection, and reader questions supply additional reader signs.
// SDK-only and background transcripts can contain edits, automatic denials, and unattended system records without a reader.
// SDK-only transcripts accept repeated originless prompts without requiring completion.
// Background transcripts require a completed turn and exactly one counted prompt, including their human-origin launch prompt.
// Originless SDK follow-ups in background mode do not count.
// Other transcripts require one prompt and a completed turn. Missing reader evidence alone does not establish ownership.
export function agentRunIn(lines: string[], whole: boolean): boolean | null {
  if (!whole) {
    return null;
  }
  const tally: AgentRunTally = {
    prompts: 0,
    finished: false,
    unattended: false,
    changedFile: false,
    deniedTool: false,
    command: false,
    bridgeSession: false,
    bg: false,
  };
  const last = lines.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // An unfinished final JSON record waits for the next read. A malformed complete record leaves classification unknown.
      if (i === last) {
        break;
      }
      return null;
    }
    if (personSignIn(parsed, tally)) {
      return false;
    }
  }
  return agentRunOfTally(tally);
}

// System subtypes permitted without reader evidence in SDK-only or background transcripts.
// Other subtypes establish a reader session. Under other entrypoints, these subtypes also count as reader evidence.
const UNATTENDED_SYSTEM_SUBTYPES = new Set([
  'stop_hook_summary',
  'compact_boundary',
  'turn_duration',
  'api_error',
  'informational',
  'away_summary',
]);

// Evidence accumulated across records for agent-run classification.
// `entrypoint` stays `sdk` only while every named entrypoint is SDK-based. `bg` stays true once recorded.
// Other fields retain prompt, completion, system, edit, denial, command, and bridge evidence.
interface AgentRunTally {
  prompts: number;
  finished: boolean;
  unattended: boolean;
  changedFile: boolean;
  deniedTool: boolean;
  command: boolean;
  bridgeSession: boolean;
  bg: boolean;
  entrypoint?: 'sdk' | 'other';
}

// The rule for one parsed record. True when the record is a sign of a person, and otherwise
// it adds what the record says to the tally.
function personSignIn(parsed: unknown, tally: AgentRunTally): boolean {
  // JSON null and primitive values provide no classification fields.
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }
  const o = parsed as Record<string, unknown>;
  // Exclude sidechain and synthetic replies, matching the main turn reader.
  if (o.isSidechain) {
    return false;
  }
  if ((o.message as { model?: string } | undefined)?.model === '<synthetic>') {
    return false;
  }
  if (typeof o.entrypoint === 'string') {
    tally.entrypoint = o.entrypoint.startsWith('sdk-') && tally.entrypoint !== 'other' ? 'sdk' : 'other';
  }
  // Sticky like every other tally field, and read this way because a background session's
  // own records do not all repeat `sessionKind`. The first record they share it on is enough.
  if (o.sessionKind === 'bg') {
    tally.bg = true;
  }
  // A non-SDK entrypoint establishes a reader session unless background mode is already known.
  // Sidechain and synthetic records cannot supply entrypoint evidence.
  if (tally.entrypoint === 'other' && !tally.bg) {
    return true;
  }
  const type = o.type;
  // Defer bridge evidence until the final tally so later background metadata can qualify it.
  if (type === 'bridge-session') {
    tally.bridgeSession = true;
    return false;
  }
  if (type === 'system') {
    if (!UNATTENDED_SYSTEM_SUBTYPES.has(String(o.subtype))) {
      return true;
    }
    tally.unattended = true;
    return false;
  }
  // `user-rejected` is the reader saying no, so it is a person under every entrypoint. Any
  // other kind, such as `permission-rule` under read-only dispatch, is Claude Code refusing
  // on its own, so it joins the file-change exception below instead of returning early.
  if (o.toolDenialKind) {
    if (o.toolDenialKind === 'user-rejected') {
      return true;
    }
    tally.deniedTool = true;
    return false;
  }
  if (type === 'assistant') {
    if (askedTheReader(o)) {
      return true;
    }
    if (askedToChangeAFile(o)) {
      tally.changedFile = true;
    }
    if (finishedATurn(o)) {
      tally.finished = true;
    }
    return false;
  }
  // Reader-queued follow-ups count as reader evidence. Peer messages and task notices do not.
  if (type === 'attachment') {
    const attachment = o.attachment as Record<string, unknown> | undefined;
    if (!isReaderQueued(attachment) || !cleanPrompt(textOf(attachment?.prompt))) {
      return false;
    }
    return queuedPromptIsPerson(attachment?.origin, tally);
  }
  if (type !== 'user') {
    return false;
  }
  // Editor tags supply reader evidence.
  const said = textOf((o.message as { content?: unknown } | undefined)?.content);
  if (said.includes('<ide_')) {
    return true;
  }
  if (said.includes('<command-name>')) {
    // A human-origin command establishes reader evidence outside background mode.
    // Background commands share the prompt count with typed prompts. Originless commands await the final SDK classification.
    if ((o.origin as { kind?: unknown } | undefined)?.kind === 'human') {
      if (!tally.bg) {
        return true;
      }
      tallyTypedPrompt(tally);
      return false;
    }
    tally.command = true;
    tally.prompts += 1;
    return false;
  }
  // Use the turn reader's typed-prompt classification.
  if (!isTypedPrompt(o)) {
    return false;
  }
  // A human-origin prompt establishes reader evidence unless background mode is already known.
  const origin = o.origin as { kind?: unknown } | null | undefined;
  if (!tally.bg && origin?.kind === 'human') {
    return true;
  }
  // Exclude originless SDK follow-ups in background mode from the prompt count.
  if (tally.bg && origin?.kind !== 'human' && o.promptSource === 'sdk') {
    return false;
  }
  tallyTypedPrompt(tally);
  return false;
}

// A human-origin queued prompt establishes reader evidence. Other queued prompts do so after the first counted prompt.
function queuedPromptIsPerson(origin: unknown, tally: AgentRunTally): boolean {
  if ((origin as { kind?: unknown } | null | undefined)?.kind === 'human') {
    return true;
  }
  tally.prompts += 1;
  return tally.prompts > 1;
}

// Count a typed prompt admitted by the per-record classifier.
function tallyTypedPrompt(tally: AgentRunTally): void {
  tally.prompts += 1;
}

// Background mode permits exactly one counted prompt. SDK-only mode permits one or more.
// Other transcripts permit exactly one prompt.
function promptsOk(tally: AgentRunTally): boolean {
  if (tally.bg) {
    return tally.prompts === 1;
  }
  if (tally.entrypoint === 'sdk') {
    return tally.prompts >= 1;
  }
  return tally.prompts === 1;
}

// Resolve accumulated run evidence after immediate reader signs have been excluded.
// SDK-only transcripts do not require a completed turn. Background and other transcripts do.
// SDK-only and background modes permit unattended system, edit, and automatic-denial evidence.
// Only SDK entrypoints permit originless commands. Only background mode permits bridge-session evidence.
// An SDK host that omits human origins can classify a reader session as an agent run.
function agentRunOfTally(tally: AgentRunTally): boolean {
  const lenient = tally.entrypoint === 'sdk' || tally.bg;
  const sdkOnly = tally.entrypoint === 'sdk' && !tally.bg;
  return (
    promptsOk(tally) &&
    (tally.finished || sdkOnly) &&
    (!tally.unattended || lenient) &&
    (!tally.changedFile || lenient) &&
    (!tally.deniedTool || lenient) &&
    (!tally.command || tally.entrypoint === 'sdk') &&
    (!tally.bridgeSession || tally.bg)
  );
}

// Incremental agent-run cursor and tally. A recorded reader sign stops later classification reads.
export interface AgentRunScan extends AgentRunTally {
  bytes: number;
  person: boolean;
  // The file size the scan read to the end of, when every byte past `bytes` belongs to one
  // half-written last line. Absent when the scan stopped short of the end.
  end?: number;
}

// Classifies an EOF-covered SDK or background transcript through its retained tally.
// An unfinished last line permits classification from preceding complete records. Other unread bytes prevent an agent-run result.
export function agentRunOfScan(scan: AgentRunScan, size: number): boolean {
  return (
    !scan.person &&
    (scan.bytes === size || scan.end === size) &&
    (scan.entrypoint === 'sdk' || scan.bg) &&
    agentRunOfTally(scan)
  );
}

// Complete admitted export lines use the metadata rule for short sources and the whole-file scan rule for large sources.
export function createClaudeRunClassifier(requireLaunchEvidence = false) {
  const run: AgentRunScan = {
    bytes: 0,
    prompts: 0,
    finished: false,
    unattended: false,
    changedFile: false,
    deniedTool: false,
    command: false,
    bridgeSession: false,
    bg: false,
    person: false,
  };
  const reader: PersonScan = { bytes: 0, person: false, prompts: 0, bg: false, start: 0, userBefore: false };
  return {
    pushLine(line: string) {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        run.person = true;
        return;
      }
      run.person ||= personSignIn(parsed, run);
      reader.person ||= personSpokeIn(parsed, reader);
    },
    agentRun: () => !run.person && (requireLaunchEvidence ? agentRunOfScan(run, 0) : agentRunOfTally(run)),
    person: () => reader.person,
  };
}

// Resumes classification from the complete-line cursor and stops at the first reader sign.
// Malformed complete lines establish reader evidence. Shrinkage restarts the tally.
export function scanForAgentRun(file: string, size: number, prev?: AgentRunScan): AgentRunScan {
  if (prev?.person) {
    return prev;
  }
  const resumed = prev && prev.bytes <= size ? prev : undefined;
  const scan: AgentRunScan = resumed
    ? { ...resumed }
    : {
        bytes: 0,
        prompts: 0,
        finished: false,
        unattended: false,
        changedFile: false,
        deniedTool: false,
        command: false,
        bridgeSession: false,
        bg: false,
        person: false,
      };
  const read = readCompleteLines(file, scan.bytes, size, (text) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        scan.person = true;
        return true;
      }
      if (personSignIn(parsed, scan)) {
        scan.person = true;
        return true;
      }
    }
    return false;
  });
  scan.bytes = read.bytes;
  // An unterminated last line that parses is a record the scan has not read, so the scan
  // stays short of the end until its newline arrives.
  const rest = read.rest?.toString('utf8');
  if (rest !== undefined && (!rest.trim() || !lastLineWhole(rest))) {
    scan.end = size;
  } else {
    delete scan.end;
  }
  return scan;
}

// Incremental reader-evidence scan for a session with an established dispatch edge.
// Explicit tool rejection and reader-queued follow-ups establish reader evidence.
// Human-origin commands also count, except a background launch command with no preceding user record.
// A complete scan also counts human-origin prompts and editor tags after the launch prompt.
// Partial scans cannot establish earlier prompt counts, so they exclude typed-prompt and editor-tag evidence.
// Peer messages, task notices, SDK follow-ups, and reader-question calls do not establish reader evidence here.
// Once reader evidence is found, subsequent scans retain it.
export interface PersonScan {
  bytes: number;
  person: boolean;
  prompts: number;
  bg: boolean;
  start: number;
  userBefore: boolean;
  // Identity keys of the records that counted as a prompt or decided the scan. A Claude repeated
  // record has the identity of its original, so it neither counts nor decides.
  counted?: string[];
  // Whether `counted` also holds the records before `start`.
  countedBefore?: boolean;
}

// The identity key of a counted record, or null for a record without an identity.
function personRecordKey(line: string): string | null {
  const identity = claudeRecordIdentity(line);
  return identity ? `${identity.uuid}\n${identity.timestamp}` : null;
}

// Adds the records before `scan.start` that would count to `scan.counted`.
function countPersonRecordsBefore(file: string, scan: PersonScan): void {
  const counted = [...(scan.counted ?? [])];
  const probe: PersonScan = { bytes: 0, person: false, prompts: 0, bg: false, start: 0, userBefore: true };
  readCompleteLines(file, 0, scan.start, (text) => {
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"user"') && !line.includes('"attachment"') && !line.includes('toolDenialKind')) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const prompts = probe.prompts;
      const key = personSpokeIn(parsed, probe) || probe.prompts !== prompts ? personRecordKey(line) : null;
      if (key) counted.push(key);
    }
    return false;
  });
  scan.counted = counted;
  scan.countedBefore = true;
}

export function scanForPerson(file: string, size: number, prev?: PersonScan, start = 0): PersonScan {
  if (prev?.person) {
    return prev;
  }
  const from = Math.min(start, size);
  const scan: PersonScan =
    prev && prev.bytes <= size
      ? { ...prev }
      : {
          bytes: from,
          person: false,
          prompts: 0,
          bg: false,
          start: from,
          userBefore: from > 0 && holdsUserRecord(file, from),
        };
  scan.bytes = readCompleteLines(file, scan.bytes, size, (text) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const trial = { ...scan };
      const spoke = personSpokeIn(parsed, trial);
      const key = spoke || trial.prompts !== scan.prompts ? personRecordKey(line) : null;
      if (key) {
        // A record that would decide checks the bytes before a tail scan's start once.
        if (spoke && scan.start > 0 && !scan.countedBefore) countPersonRecordsBefore(file, scan);
        if (scan.counted?.includes(key)) {
          scan.bg = trial.bg;
          continue;
        }
        trial.counted = [...(scan.counted ?? []), key];
        trial.countedBefore = scan.countedBefore;
      }
      Object.assign(scan, trial);
      if (spoke) {
        scan.person = true;
        return true;
      }
    }
    return false;
  }).bytes;
  return scan;
}

// Checks raw bytes for a user-record marker, including fragments, and stops on the first match.
function holdsUserRecord(file: string, size: number): boolean {
  const mark = Buffer.from('"type":"user"');
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.allocUnsafe(4 * 1024);
    let pos = 0;
    while (pos < size) {
      const read = meterRead(file, fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos));
      if (read <= 0) {
        break;
      }
      if (chunk.subarray(0, read).includes(mark)) {
        return true;
      }
      if (pos + read >= size) {
        break;
      }
      // The next step starts early enough to find a mark cut across the step boundary.
      pos += Math.max(1, read - mark.length + 1);
    }
  } catch {
    /* unreadable. No user marker found. */
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

// Whether one raw transcript line can hold a sign `personSpokeIn` reads, so the spend read
// parses only those lines. It notes `sessionKind: 'bg'` on the way. Claude Code writes each
// record as compact JSON, which the spend read's own `"type":"assistant"` test rests on too.
function mayHoldPersonSign(line: string, scan: PersonScan): boolean {
  if (!scan.bg && line.includes('"sessionKind":"bg"')) {
    scan.bg = true;
  }
  return (
    line.includes('"toolDenialKind"') ||
    line.includes('"queued_command"') ||
    (line.includes('"type":"user"') && !line.includes('"type":"tool_result"'))
  );
}

function personSpokeIn(parsed: unknown, scan: PersonScan): boolean {
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }
  const o = parsed as Record<string, unknown>;
  if (o.isSidechain) {
    return false;
  }
  if (o.sessionKind === 'bg') {
    scan.bg = true;
  }
  if (o.toolDenialKind === 'user-rejected') {
    return true;
  }
  if (o.type === 'attachment') {
    const attachment = o.attachment as Record<string, unknown> | undefined;
    return isReaderQueued(attachment) && cleanPrompt(textOf(attachment?.prompt)).length > 0;
  }
  if (o.type !== 'user') {
    return false;
  }
  const said = textOf((o.message as { content?: unknown } | undefined)?.content);
  const human = (o.origin as { kind?: unknown } | null | undefined)?.kind === 'human';
  // Human-origin commands count except a background launch command with no earlier user record.
  if (said.includes('<command-name>')) {
    scan.prompts += 1;
    if (!human) {
      return false;
    }
    return !(scan.prompts === 1 && scan.bg && !scan.userBefore);
  }
  if (!isTypedPrompt(o) || (!human && o.promptSource === 'sdk')) {
    return false;
  }
  scan.prompts += 1;
  if (scan.start > 0) {
    return false;
  }
  const launch = scan.prompts === 1;
  return (!launch && said.includes('<ide_')) || (human && (!scan.bg || !launch));
}

// Whether an assistant record holds a tool call the caller is looking for, by name.
function calledATool(record: Record<string, unknown>, wanted: (name: string) => boolean): boolean {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((b) => {
    const block = b as { type?: string; name?: string } | null;
    return !!block && block.type === 'tool_use' && wanted(block.name ?? '');
  });
}

// Checks edit-tool requests using the shared tool-category table.
// A failed edit request still supplies classification evidence.
function askedToChangeAFile(record: Record<string, unknown>): boolean {
  return calledATool(record, (name) => TOOL_KIND[name] === 'edits');
}

// Tool names whose calls supply reader-question evidence for run classification.
const ASKS_THE_READER = new Set(['AskUserQuestion']);

// Checks reader-question calls, regardless of their eventual results.
function askedTheReader(record: Record<string, unknown>): boolean {
  return calledATool(record, (name) => ASKS_THE_READER.has(name));
}

// True for a nonempty recorded stop reason other than `tool_use`.
export function finishedATurn(record: Record<string, unknown>): boolean {
  const stop = (record.message as { stop_reason?: unknown } | undefined)?.stop_reason;
  return typeof stop === 'string' && stop.length > 0 && stop !== 'tool_use';
}

// True for a tool result the harness marked as the end of the turn. A subagent transcript
// records no stop reason, so its `SubagentHandback` result carries this mark instead.
function toolEndedATurn(record: Record<string, unknown>): boolean {
  return record.type === 'user' && record.toolEndsTurn === true;
}

interface ClaudeWakeOrigin {
  kind: 'coordinator' | 'peer';
  from?: unknown;
  handback?: unknown;
}

// The origin of a coordinator or peer message, or null for any other origin. These messages
// wake the agent.
function claudeWakeOrigin(origin: unknown): ClaudeWakeOrigin | null {
  const wake = origin as { kind?: unknown } | null | undefined;
  return wake && typeof wake === 'object' && (wake.kind === 'coordinator' || wake.kind === 'peer')
    ? (wake as ClaudeWakeOrigin)
    : null;
}

// True for a coordinator or peer message. The turn it wakes continues.
function claudeWakeMessage(record: Record<string, unknown>): boolean {
  return record.type === 'user' && !!record.isMeta && claudeWakeOrigin(record.origin) !== null;
}

export function failedATurn(record: Record<string, unknown>): boolean {
  return record.isApiErrorMessage === true;
}

export function interruptedATurn(record: Record<string, unknown>): boolean {
  return INTERRUPTED.test(cleanPrompt(textOf((record.message as { content?: unknown } | undefined)?.content)));
}

function answeredATurn(record: Record<string, unknown>): boolean {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  return (
    Array.isArray(content) &&
    content.some((block) => {
      const text = block as { type?: unknown; text?: unknown } | null;
      return text?.type === 'text' && typeof text.text === 'string' && text.text.trim().length > 0;
    })
  );
}

// The id of the call a raw tool_result line answers, without parsing the line.
const RESULT_ID = /"tool_use_id"\s*:\s*"([^"]+)"/;

// Skip ordinary tool-result lines that contain no fields used by the timeline.
// `wrote` admits results by call ID, including quiet commits and fast-forward merges.
// Child reads also admit edit calls and Git commands whose results lack the parent transcript's structured fields.
// A result that ends the turn is admitted in every transcript, because it decides turn completion.
function skipsOrdinaryToolResult(line: string, isUser: boolean, wrote?: ReadonlySet<string>): boolean {
  if (!isUser || line.indexOf('"tool_result"') < 0) {
    return false;
  }
  if (
    line.indexOf('"structuredPatch"') >= 0 ||
    line.indexOf('"bashEditDiff"') >= 0 ||
    line.indexOf('"totalToolUseCount"') >= 0 ||
    line.indexOf('"agentId"') >= 0 ||
    line.indexOf('"is_error":true') >= 0 ||
    line.indexOf('"gitOperation"') >= 0 ||
    line.indexOf('"toolEndsTurn"') >= 0
  ) {
    return false;
  }
  if (wrote === undefined || wrote.size === 0) {
    return true;
  }
  const id = RESULT_ID.exec(line);
  return id === null || !wrote.has(id[1]);
}

export function claudeProcessEndedAt(record: unknown): number | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }
  const value = record as Record<string, unknown>;
  if (value.type !== 'cost-state') {
    return null;
  }
  const start = value.startTime;
  const duration = value.totalDuration;
  if (
    typeof start !== 'number' ||
    !Number.isFinite(start) ||
    start < 0 ||
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration < 0
  ) {
    return null;
  }
  const endedAt = start + duration;
  return Number.isFinite(endedAt) && Number.isSafeInteger(endedAt) ? endedAt : null;
}

// Only the plain CLI command is provisional until its structured manual boundary arrives.
function claudeCompactPrompt(record: Record<string, unknown>): boolean {
  return (
    !record.isSidechain && textOf((record.message as { content?: unknown } | undefined)?.content).trim() === '/compact'
  );
}

function claudeCompactAnswer(
  record: Record<string, unknown>,
  command: string | null,
  openedAt: number | null,
): { at: number; parent: string } | null {
  const metadata = record.compactMetadata as Record<string, unknown> | undefined;
  const at = Date.parse(String(record.timestamp));
  if (
    !command ||
    openedAt === null ||
    record.isSidechain ||
    record.type !== 'system' ||
    record.subtype !== 'compact_boundary' ||
    metadata?.trigger !== 'manual' ||
    !Number.isFinite(at) ||
    at < openedAt ||
    typeof metadata.preTokens !== 'number' ||
    !Number.isFinite(metadata.preTokens) ||
    metadata.preTokens <= 0 ||
    typeof metadata.postTokens !== 'number' ||
    !Number.isFinite(metadata.postTokens) ||
    metadata.postTokens <= 0
  )
    return null;
  return { at, parent: command };
}

const LOCAL_COMMAND_OUTPUT = /<local-command-(?:stdout|stderr)>/;
const LOCAL_COMMAND_OUTPUT_OPEN = /^<(local-command-(?:stdout|stderr))>/;

// Whether the text is one local stdout or stderr element and nothing else.
function localCommandOutputOnly(text: string): boolean {
  const open = LOCAL_COMMAND_OUTPUT_OPEN.exec(text);
  if (!open) {
    return false;
  }
  const close = `</${open[1]}>`;
  return text.indexOf(close) === text.length - close.length;
}

// CLI command answer with a parent record ID and local stdout or stderr tag.
// The CLI records it as a `local_command` system record, or as a user record whose whole
// content is one stdout or stderr element.
// A command turn is withdrawn only when that ID matches its unanswered opening prompt.
export function claudeLocalAnswer(record: unknown): { at: number; parent: string } | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }
  const value = record as Record<string, unknown>;
  if (value.isSidechain) {
    return null;
  }
  const parent = value.parentUuid;
  if (typeof parent !== 'string' || !parent) {
    return null;
  }
  if (value.type === 'system' && value.subtype === 'local_command') {
    return LOCAL_COMMAND_OUTPUT.test(textOf(value.content)) ? { at: stamp(value.timestamp), parent } : null;
  }
  if (value.type === 'user') {
    const content = (value.message as { content?: unknown } | undefined)?.content;
    return localCommandOutputOnly(textOf(content).trim()) ? { at: stamp(value.timestamp), parent } : null;
  }
  return null;
}

// Assistant record with an API error, visible reply or tool call, or positive output usage.
function claudeModelAnswered(record: Record<string, unknown>): boolean {
  const message = record.message as { content?: unknown; usage?: ClaudeUsage } | undefined;
  const content = message?.content;
  const visible =
    typeof content === 'string'
      ? content.trim().length > 0
      : Array.isArray(content) &&
        content.some((block) => {
          const item = block as { type?: unknown; text?: unknown };
          return item.type === 'tool_use' || (item.type === 'text' && String(item.text ?? '').trim().length > 0);
        });
  return failedATurn(record) || visible || (message?.usage?.output_tokens ?? 0) > 0;
}

// Whether a record is the model working, or the reader interrupting it. After a local command
// answer withdrew the command, such a record resumes the turn before the command and removes the
// stop the answer inferred for it. It makes the command a turn again only after a manual
// compaction. A process end, a notice or a `<synthetic>` reply does not.
function claudeModelWorks(record: Record<string, unknown>): boolean {
  if (record.type === 'user') {
    return interruptedATurn(record);
  }
  if (record.type !== 'assistant') {
    return false;
  }
  if (failedATurn(record)) {
    return true;
  }
  return (record.message as { model?: unknown } | undefined)?.model !== '<synthetic>' && claudeModelAnswered(record);
}

// Marks an unanswered prompt stopped at its own last-record time after a local command answer.
// Terminal outcomes retain their recorded state. Later model work resumes the turn and removes the
// stop. It restores the command turn only after a manual compaction.
function stoppedByLocalAnswer(outcome: TurnOutcome): TurnOutcome {
  if (outcome.finished || outcome.error || outcome.interrupted || outcome.processEndedAt !== undefined) {
    return outcome;
  }
  return { ...outcome, processEndedAt: outcome.endedAt };
}

// The id of the typed record that opened a turn, which a local command answer names as its parent.
function claudeRecordId(record: Record<string, unknown>): string | null {
  return typeof record.uuid === 'string' && record.uuid ? record.uuid : null;
}

// The newest turn's outcome in the tail, and the background commands still running at its end.
// The commands are read even where the tail holds no typed prompt and the outcome is null.
function outcomeIn(
  lines: string[],
  childTranscript = false,
): { outcome: TurnOutcome | null; backgroundCommands: BackgroundCommand[] } {
  let outcome: TurnOutcome | null = null;
  // The typed record that opened the outcome, and whether the model has answered it yet.
  let command: string | null = null;
  let modelAnswered = false;
  let compact = false;
  // The outcome that the newest typed prompt replaced. A local command answer withdraws the
  // command's outcome and puts this one back.
  let previous = null as { outcome: TurnOutcome | null; modelAnswered: boolean } | null;
  // The command's outcome that a local command answer withdrew, until the model works after it.
  let withdrawn: TurnOutcome | null = null;
  // Whether a manual compaction withdrew it. Only then does later model work restore it.
  let withdrawnCompact = false;
  // The stop time the answer gave the outcome before the command. Later model work removes it.
  let localStopAt: number | undefined;
  // The stop time an earlier answer gave the outcome the newest typed prompt replaced, when
  // that prompt follows a command the CLI answered by itself.
  let previousLocalStopAt: number | undefined;
  // Whether a prompt queued since that answer opened the outcome.
  let queuedSinceAnswer = false;
  // Prompts queued while the command waited for its answer, as start and end times.
  let queuedBeforeAnswer = null as { startedAt: number; endedAt: number } | null;
  // Whether a result that ends the turn finished the outcome. A wake or later model work resumes it.
  let toolEnded = false;
  let open: readonly string[] = [];
  let commands: readonly BackgroundCommand[] = [];
  const tasks = new Map<string, string>();
  const closed: ClosedChild[] = [];
  const closedIndex = new Map<string, number>();
  for (const line of lines) {
    if (line.length < 20) {
      continue;
    }
    // An ordinary result is read only when it reports a background task id, because a stop call
    // names the command by that id. It moves nothing else in the outcome.
    const taskIdOnly = skipsOrdinaryToolResult(line, line.indexOf('"type":"user"') >= 0);
    if (taskIdOnly && line.indexOf('"backgroundTaskId"') < 0) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') {
      continue;
    }
    const o = record as Record<string, unknown>;
    if (o.isSidechain && !childTranscript) {
      continue;
    }
    if (taskIdOnly) {
      commands = nextBackgroundCommands(commands, o, null, tasks);
      continue;
    }
    const type = o.type;
    if (type === 'user' && isTypedPrompt(o, childTranscript)) {
      const startedAt = stamp(o.timestamp);
      previous = { outcome, modelAnswered };
      previousLocalStopAt = withdrawn && !queuedSinceAnswer ? localStopAt : undefined;
      withdrawn = null;
      queuedSinceAnswer = false;
      queuedBeforeAnswer = null;
      outcome = { finished: false, error: false, interrupted: false, endedAt: startedAt, startedAt };
      toolEnded = false;
      command = claudeRecordId(o);
      compact = claudeCompactPrompt(o);
      modelAnswered = false;
      continue;
    }
    const queuedAsk = readerQueuedAsk(o);
    if (queuedAsk && !withdrawn) {
      compact = false;
      if (command !== null) {
        queuedBeforeAnswer = {
          startedAt: queuedBeforeAnswer?.startedAt ?? queuedAsk.at,
          endedAt: Math.max(queuedBeforeAnswer?.endedAt ?? 0, queuedAsk.at),
        };
      }
    }
    const compactAnswer = compact ? claudeCompactAnswer(o, command, outcome?.startedAt ?? null) : null;
    const localAnswer = compactAnswer ?? claudeLocalAnswer(o);
    if (localAnswer !== null) {
      if (
        outcome &&
        !modelAnswered &&
        outcome.processEndedAt === undefined &&
        command !== null &&
        localAnswer.parent === command
      ) {
        // The CLI answered the command itself, so the command is no turn. The turn before it
        // is the newest again, or there is none when the tail holds no earlier prompt.
        withdrawn = { ...outcome, finished: true, endedAt: Math.max(outcome.endedAt, localAnswer.at) };
        withdrawnCompact = compactAnswer !== null;
        localStopAt = previousLocalStopAt;
        outcome = previous?.outcome ?? null;
        modelAnswered = previous?.modelAnswered ?? false;
        command = null;
        previous = null;
        queuedSinceAnswer = false;
        toolEnded = false;
        if (outcome && !modelAnswered && !compactAnswer) {
          const stopped = stoppedByLocalAnswer(outcome);
          if (stopped !== outcome) localStopAt = stopped.processEndedAt;
          outcome = stopped;
        }
        if (queuedBeforeAnswer) {
          // Prompts queued before the answer wait on a card of their own, as a prompt queued after it does.
          outcome = { finished: false, error: false, interrupted: false, ...queuedBeforeAnswer };
          modelAnswered = false;
          queuedSinceAnswer = true;
          queuedBeforeAnswer = null;
        }
        continue;
      }
      // An unmatched user-form answer, such as the stdout of `/compact`, reads as an ordinary record.
      if (type !== 'user') {
        continue;
      }
    }
    const queued = withdrawn ? readerQueuedAsk(o) : null;
    if (queued) {
      // A prompt queued behind the withdrawn command waits on a card of its own in the full
      // reader, so it is the newest turn. A second one joins it there.
      if (queuedSinceAnswer && outcome) {
        outcome.endedAt = Math.max(outcome.endedAt, queued.at);
      } else {
        outcome = { finished: false, error: false, interrupted: false, endedAt: queued.at, startedAt: queued.at };
        modelAnswered = false;
        queuedSinceAnswer = true;
        toolEnded = false;
      }
      continue;
    }
    if (withdrawn && !withdrawnCompact && claudeModelWorks(o)) {
      // Model work after the CLI's own answer stays out of the command. It answers the prompts
      // queued around the command, or else resumes the turn before it, which the answer did not stop.
      if (!queuedSinceAnswer && outcome && localStopAt !== undefined && outcome.processEndedAt === localStopAt) {
        delete outcome.processEndedAt;
      }
      withdrawn = null;
      localStopAt = undefined;
      queuedSinceAnswer = false;
    }
    if (withdrawn && claudeModelWorks(o)) {
      // Model work after a compaction makes the command a turn again. A process end that stopped
      // a queued prompt stops the command, because the prompt joins the command's card.
      const queuedEnd = queuedSinceAnswer ? outcome?.processEndedAt : undefined;
      outcome = withdrawn;
      outcome.finished = false;
      if (queuedEnd !== undefined) {
        outcome.processEndedAt = Math.max(outcome.processEndedAt ?? 0, queuedEnd);
      }
      withdrawn = null;
      command = null;
      previous = null;
      queuedSinceAnswer = false;
      toolEnded = false;
    }
    const notice = taskNotificationText(o);
    const processEndedAt = claudeProcessEndedAt(o);
    // A recorded process end ends every background child the process held, so a resume
    // after it starts with none open.
    open = processEndedAt !== null ? [] : nextOpenChildren(open, o, notice);
    commands = processEndedAt !== null ? [] : nextBackgroundCommands(commands, o, notice, tasks);
    if (processEndedAt !== null) {
      closed.length = 0;
      closedIndex.clear();
    } else {
      addClosedChildNotice(closed, closedIndex, notice, claudeRecordAt(o));
    }
    // A long child turn can have its prompt before the tail. A stop reason or a result that
    // ends the turn still gives it an outcome.
    if (
      !outcome &&
      childTranscript &&
      ((type === 'assistant' && (o.message as { stop_reason?: unknown } | undefined)?.stop_reason) || toolEndedATurn(o))
    ) {
      const at = stamp(o.timestamp);
      outcome = {
        finished: finishedATurn(o),
        error: failedATurn(o),
        interrupted: false,
        endedAt: at,
        startedAt: at,
      };
    }
    if (!outcome) {
      continue;
    }
    if (processEndedAt !== null) {
      outcome.processEndedAt = Math.max(outcome.processEndedAt ?? 0, processEndedAt);
      continue;
    }
    if (notice !== null) {
      outcome.endedAt = Math.max(outcome.endedAt, claudeRecordAt(o));
      continue;
    }
    if (type === 'user') {
      const at = stamp(o.timestamp);
      if (interruptedATurn(o)) {
        outcome.interrupted = true;
        outcome.endedAt = Math.max(outcome.endedAt, at);
        modelAnswered = true;
        continue;
      }
      if (toolEnded && claudeWakeMessage(o)) {
        outcome.finished = false;
        outcome.endedAt = Math.max(outcome.endedAt, at);
        toolEnded = false;
      }
      if (toolEndedATurn(o)) {
        outcome.finished = true;
        toolEnded = true;
        outcome.endedAt = Math.max(outcome.endedAt, at);
      }
      if (o.toolUseResult && typeof o.toolUseResult === 'object') {
        outcome.endedAt = Math.max(outcome.endedAt, at);
      }
      continue;
    }
    if (type !== 'assistant') {
      continue;
    }
    outcome.endedAt = Math.max(outcome.endedAt, stamp(o.timestamp));
    if (failedATurn(o)) {
      outcome.error = true;
      modelAnswered = true;
      continue;
    }
    if ((o.message as { model?: string } | undefined)?.model === '<synthetic>') {
      continue;
    }
    if (claudeModelAnswered(o)) {
      modelAnswered = true;
    }
    if (answeredATurn(o)) {
      outcome.error = false;
    }
    // Model work after a result that ended the turn resumes it, unless its own stop reason
    // ends it again. Otherwise a record without a stop reason leaves completion unchanged.
    if (toolEnded) {
      outcome.finished = finishedATurn(o);
      toolEnded = false;
    } else if ((o.message as { stop_reason?: unknown } | undefined)?.stop_reason) {
      outcome.finished = finishedATurn(o);
    }
  }
  if (outcome && open.length > 0) {
    outcome.openChildren = [...open];
  }
  if (outcome && closed.length > 0) {
    outcome.closedChildren = [...closed];
  }
  if (outcome && commands.length > 0) {
    outcome.backgroundCommands = [...commands];
  }
  return { outcome, backgroundCommands: [...commands] };
}

export function activityIn(lines: string[], workOnly = false, now = Infinity): number | null {
  let newest: number | null = null;
  for (const line of lines) {
    if (line.indexOf('"timestamp"') < 0) {
      continue;
    }
    let o: { type?: string; timestamp?: unknown };
    try {
      o = JSON.parse(line) as { type?: string; timestamp?: unknown };
    } catch {
      continue;
    }
    if (
      (workOnly && o.type !== 'user' && o.type !== 'assistant') ||
      o.timestamp === undefined ||
      o.timestamp === null
    ) {
      continue;
    }
    const t = workOnly && typeof o.timestamp === 'number' ? o.timestamp : Date.parse(String(o.timestamp));
    if (!Number.isFinite(t) || t > now) {
      continue;
    }
    if (newest === null || t > newest) {
      newest = t;
    }
  }
  return newest;
}

// Membership test for `folders` with each folder normalized once. A caller that tests many targets
// against one folder list builds the matcher once and reuses it. `isInside` decides the same way,
// so both must change together.
export function folderMatcher(folders: string[]): (target: string) => boolean {
  const bases = folders.map((f) => normalizeFsPath(f).replace(/\/$/, ''));
  const prefixes = bases.map((base) => base + '/');
  return (target) => {
    const t = normalizeFsPath(target);
    return bases.some((base, i) => t === base || t.startsWith(prefixes[i]));
  };
}

// True when `target` is, or sits inside, one of `folders`. A single test stops at the first
// matching folder and normalizes no later one. The Codex reader tests many targets against one
// folder list, so it uses `folderMatcher`, which applies the same rule.
export function isInside(target: string, folders: string[]): boolean {
  const t = normalizeFsPath(target);
  return folders.some((f) => {
    const base = normalizeFsPath(f).replace(/\/$/, '');
    return t === base || t.startsWith(base + '/');
  });
}

// Project transcript directories whose sampled working directory belongs to an open folder.
// Slug matches admit a sample read but cannot establish membership because punctuation and prefixes collide.
export function transcriptDirsFor(root: string, folders: string[]): string[] {
  if (folders.length === 0) {
    return [];
  }
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const slugs = folders.map((f) => projectSlug(f).toLowerCase());
  const out: string[] = [];
  for (const d of dirs) {
    const name = d.toLowerCase();
    const exact = slugs.includes(name);
    if (!slugs.some((slug) => projectDirectoryMatches(name, slug))) {
      continue;
    }
    const full = path.join(root, d);
    const sample = listSessionFiles(full)[0];
    const cwd = sample ? readSessionCwd(sample.file) : null;
    // A missing sampled cwd permits only an exact slug match.
    if (cwd ? isInside(cwd, folders) : exact) {
      out.push(full);
    }
  }
  return out;
}

// Workspace-relative display path, preserving case and using forward slashes inside an open folder.
// Multiple open folders add the owning folder name. The nearest enclosing folder wins.
// A path outside every open folder is returned unchanged.
export function relativePath(target: string, folders: string[]): string {
  const t = normalizeFsPath(target);
  // Longest first, so a folder nested inside another names the file by the nearer of the two.
  const sorted = [...folders].sort((a, b) => normalizeFsPath(b).length - normalizeFsPath(a).length);
  for (const folder of sorted) {
    const base = normalizeFsPath(folder).replace(/\/$/, '');
    // An exact folder match displays that folder's name.
    if (t === base) {
      return folder.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || folder;
    }
    if (!t.startsWith(base + '/')) {
      continue;
    }
    const rest = target.replace(/\\/g, '/').slice(base.length + 1);
    if (folders.length < 2) {
      return rest;
    }
    const name = folder.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || folder;
    return `${name}/${rest}`;
  }
  return target;
}

// Local link target after removing a Markdown heading or line location.
// Schemes followed by double slashes return null. Drive-letter paths remain eligible.
export function linkTarget(href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    return null;
  }
  return linkLocation(href).target || null;
}

export function linkLocation(href: string): { target: string; from: number; to: number; fragment: string | null } {
  const hash = href.indexOf('#');
  if (hash >= 0 && linkTargetIsMarkdown(href.slice(0, hash))) {
    let fragment = href.slice(hash + 1);
    if (!/^L\d+(?:-L?\d+)?$/.test(fragment)) {
      try {
        fragment = decodeURIComponent(fragment);
      } catch {
        // A malformed escape remains part of the requested heading.
      }
      return { target: href.slice(0, hash), from: -1, to: -1, fragment };
    }
  }
  const anchor = /#L(\d+)(?:-L?(\d+))?$/.exec(href) || /:(\d+)(?::\d+)?$/.exec(href);
  const from = anchor ? Number(anchor[1]) - 1 : -1;
  return {
    target: anchor ? href.slice(0, anchor.index) : href,
    from,
    to: anchor && anchor[2] ? Number(anchor[2]) - 1 : from,
    fragment: null,
  };
}

export function linkTargetIsHtml(target: string): boolean {
  return /\.html?$/i.test(target);
}

export function linkTargetIsMarkdown(target: string): boolean {
  return /\.(?:md|markdown)$/i.test(target);
}

export function linkTargetIsVideo(target: string): boolean {
  return /\.(?:mp4|m4v|mov|webm|avi|mkv)$/i.test(target);
}

// Local paths in folder order. Parent segments can name files outside the folders.
export function linkCandidates(
  target: string,
  folders: string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!target) return [];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return paths.isAbsolute(target) ? [paths.resolve(target)] : folders.map((folder) => paths.join(folder, target));
}

// Returns an absolute target, the first existing workspace-relative target, or the first joined fallback.
export function resolveLink(target: string, folders: string[], exists: (p: string) => boolean): string | null {
  if (!target) {
    return null;
  }
  if (path.isAbsolute(target)) {
    return target;
  }
  const joined = linkCandidates(target, folders);
  return joined.find(exists) ?? joined[0] ?? null;
}

// Resolve one accepted Claude session without reading other transcripts.
export function sessionFileFor(root: string, folders: string[], sessionId: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId) || !folders.length) return null;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  const slugs = folders.map((folder) => projectSlug(folder).toLowerCase());
  let found: string | null = null;
  for (const dir of dirs) {
    const name = dir.toLowerCase();
    if (!slugs.some((slug) => projectDirectoryMatches(name, slug))) continue;
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const cwd = readSessionCwd(file);
    if (cwd ? !isInside(cwd, folders) : !slugs.includes(name)) continue;
    if (found) return null;
    found = file;
  }
  return found;
}

// Initial Claude names also persist as a complete custom-title in the accepted transcript.
export function readInitialCustomTitle(sessionFile: string, sessionId: string): string | null {
  for (const line of tailLines(sessionFile, 16 * 1024).reverse()) {
    if (!line.includes('"custom-title"')) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; sessionId?: unknown; customTitle?: unknown };
      if (record.type === 'custom-title' && record.sessionId === sessionId)
        return typeof record.customTitle === 'string' ? record.customTitle : null;
    } catch {
      /* skip incomplete lines */
    }
  }
  return null;
}

export function sessionFilesFor(
  root: string,
  folders: string[],
  cwdOf: (file: string, session: SessionFile) => string | null = (file) => readSessionCwd(file),
  missingCwdFolders: string[] = folders,
): SessionFile[] {
  return enumerateSessionFilesFor(root, folders, cwdOf, missingCwdFolders).sessions;
}

export function enumerateSessionFilesFor(
  root: string,
  folders: string[],
  cwdOf: (file: string, session: SessionFile) => string | null = (file) => readSessionCwd(file),
  missingCwdFolders: string[] = folders,
): SourceEnumeration & { sessions: SessionFile[] } {
  const evidence: SourceEnumeration & { sessions: SessionFile[] } = {
    status: 'complete',
    root,
    directories: [],
    files: [],
    uncertain: [],
    sessions: [],
  };
  if (folders.length === 0) return evidence;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...evidence, missingRoot: true };
    return { ...evidence, status: 'unavailable', uncertain: [root] };
  }
  const slugs = folders.map((f) => projectSlug(f).toLowerCase());
  const missingCwdSlugs = missingCwdFolders.map((f) => projectSlug(f).toLowerCase());
  const out: SessionFile[] = [];
  const inFolders = folderMatcher(folders);
  for (const d of dirs) {
    const name = d.toLowerCase();
    if (!slugs.some((slug) => projectDirectoryMatches(name, slug))) {
      continue;
    }
    const listing = enumerateSessionFiles(path.join(root, d));
    (evidence.files as string[]).push(...listing.files);
    (evidence.directories as string[]).push(...(listing.directories ?? []));
    (evidence.uncertain as string[]).push(...listing.uncertain);
    if (listing.status !== 'complete') evidence.status = 'incomplete';
    for (const f of listing.sessions) {
      const cwd = cwdOf(f.file, f);
      // Recorded cwd decides membership. Without it, require an exact allowed fallback slug.
      if (cwd ? inFolders(cwd) : missingCwdSlugs.includes(name)) {
        out.push(cwd ? { ...f, cwd } : f);
      }
    }
  }
  return { ...evidence, sessions: out.sort((a, b) => b.mtimeMs - a.mtimeMs) };
}

// Session transcripts in a project directory, newest first.
export function listSessionFiles(dir: string): SessionFile[] {
  return enumerateSessionFiles(dir).sessions;
}

export function enumerateSessionFiles(dir: string): SourceEnumeration & { sessions: SessionFile[] } {
  const evidence: SourceEnumeration & { sessions: SessionFile[] } = {
    status: 'complete',
    root: dir,
    directories: [],
    files: [],
    uncertain: [],
    sessions: [],
  };
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...evidence, missingRoot: true };
    return { ...evidence, status: 'unavailable', uncertain: [dir] };
  }
  (evidence.directories as string[]).push(dir);
  const out: SessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file, { bigint: true });
      if (!stat.isFile()) continue;
      (evidence.files as string[]).push(file);
      if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        evidence.status = 'incomplete';
        (evidence.uncertain as string[]).push(file);
        continue;
      }
      if (stat.size === 0n) {
        continue;
      }
      out.push({
        agent: 'claude',
        file,
        sessionId: name.slice(0, -'.jsonl'.length),
        ...revisionOf(stat),
      });
    } catch {
      evidence.status = 'incomplete';
      (evidence.uncertain as string[]).push(file);
    }
  }
  return { ...evidence, sessions: out.sort((a, b) => b.mtimeMs - a.mtimeMs) };
}

// Physical child identities reserve competition even without accepted relationship edges.
export function enumerateClaudeChildSources(
  parents: readonly SessionFile[],
): SourceEnumeration & { sessions: SessionFile[] } {
  const census: SourceEnumeration & { sessions: SessionFile[] } = {
    status: 'complete',
    files: [],
    directories: [],
    uncertain: [],
    sessions: [],
  };
  const directories = new Set(
    parents
      .filter((parent) => parent.agent === 'claude')
      .map((parent) =>
        parent.childTranscript
          ? path.dirname(parent.file)
          : path.join(path.dirname(parent.file), parent.sessionId, 'subagents'),
      ),
  );
  for (const directory of directories) {
    const listing = enumerateSessionFiles(directory);
    (census.directories as string[]).push(directory);
    (census.files as string[]).push(...listing.files);
    (census.uncertain as string[]).push(...listing.uncertain);
    if (listing.status !== 'complete') census.status = 'incomplete';
    for (const file of listing.uncertain) {
      const name = path.basename(file);
      if (path.dirname(file) !== directory || !name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
      census.sessions.push({
        agent: 'claude',
        file,
        sessionId: name.slice(6, -'.jsonl'.length),
        size: -1,
        mtimeMs: -1,
        childTranscript: true,
        agentRun: true,
      });
    }
    for (const source of listing.sessions) {
      if (!source.sessionId.startsWith('agent-')) continue;
      const opening = readQualifiedSessionCwd(source.file);
      if (
        !opening ||
        source.dev !== opening.revision.dev ||
        source.ino !== opening.revision.ino ||
        source.size !== opening.revision.size ||
        source.mtimeMs !== opening.revision.mtimeMs
      ) {
        census.status = 'incomplete';
        (census.uncertain as string[]).push(source.file);
        census.sessions.push({
          ...source,
          sessionId: source.sessionId.slice(6),
          childTranscript: true,
          agentRun: true,
        });
        continue;
      }
      census.sessions.push({
        ...source,
        sessionId: source.sessionId.slice(6),
        cwd: opening.value,
        childTranscript: true,
        agentRun: true,
      });
    }
  }
  return census;
}

// Reads the parent-owned identity edge without retaining the parent's turns. The result is
// independent of the bounded selected-session cache, so old launches remain available after
// that cache is evicted or after the extension host restarts.
export function readClaudeChildSessionReferences(
  parent: Pick<SessionFile, 'file' | 'sessionId' | 'childTranscript'>,
): ClaudeChildSessionReference[] {
  return scanClaudeChildSessionReferences(parent).references;
}

// Text-only child Agent results identify nested launches without `toolUseResult`.
// Async results begin with "Async agent launched" and carry an `agentId:` line.
// Foreground IDs require the trailing `<usage>` block to avoid matching report text.
const ASYNC_AGENT_RESULT = /^\s*Async agent launched/;
const ASYNC_AGENT_ID = /\nagentId: ([A-Za-z0-9-]+)/;
const FOREGROUND_AGENT_TAIL = /(?:^|\n)agentId: ([A-Za-z0-9-]+)[^\n]*\n?<usage>([\s\S]*?)<\/usage>\s*$/;

interface ClaudeAgentResultText {
  background: boolean;
  agentId: string | null;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
}

function claudeAgentResultText(content: unknown): ClaudeAgentResultText {
  const text = textOf(content);
  if (ASYNC_AGENT_RESULT.test(text)) {
    return {
      background: true,
      agentId: ASYNC_AGENT_ID.exec(text)?.[1] ?? null,
      tokens: null,
      toolUses: null,
      durationMs: null,
    };
  }
  const tail = FOREGROUND_AGENT_TAIL.exec(text);
  const usage = tail?.[2] ?? '';
  const figure = (name: string): number | null => {
    const value = new RegExp(`(?:^|\\n)${name}: (\\d+)`).exec(usage)?.[1];
    return value === undefined ? null : Number(value);
  };
  return {
    background: false,
    agentId: tail?.[1] ?? null,
    tokens: figure('subagent_tokens'),
    toolUses: figure('tool_uses'),
    durationMs: figure('duration_ms'),
  };
}

export interface ClaudeRelationshipState {
  launches: string[];
  children: Array<[string, string[]]>;
  shellLaunches: Array<[string, ClaudeShellLaunch]>;
  dispatches: Array<[string, ClaudeDispatchSessionReference[]]>;
}

// The transcript path Claude Code gives a subagent of this parent. A subagent's own children sit
// beside it in the same folder.
export function claudeChildFile(
  parent: Pick<SessionFile, 'file' | 'sessionId' | 'childTranscript'>,
  id: string,
): string {
  return parent.childTranscript
    ? path.join(path.dirname(parent.file), `agent-${id}.jsonl`)
    : path.join(path.dirname(parent.file), parent.sessionId, 'subagents', `agent-${id}.jsonl`);
}

export function createClaudeRelationshipReducer(
  parent: Pick<SessionFile, 'file' | 'sessionId' | 'childTranscript'>,
  state?: ClaudeRelationshipState,
  exportPolicy?: ExportRelationshipLimits,
): { apply(line: string): void; state(): ClaudeRelationshipState; references(): ClaudeChildSessionReference[] } {
  const launches = new Set<string>(state?.launches);
  const children = new Map((state?.children ?? []).map(([id, ids]) => [id, new Set(ids)]));
  const shellLaunches = new Map<string, ClaudeShellLaunch>(state?.shellLaunches);
  const dispatches = new Map<string, ClaudeDispatchSessionReference[]>(state?.dispatches);
  let linked = children.size + [...dispatches.values()].reduce((sum, rows) => sum + rows.length, 0);
  return {
    apply(line) {
      if (
        line.indexOf('Agent') < 0 &&
        line.indexOf('agentId') < 0 &&
        line.indexOf('task-id') < 0 &&
        line.indexOf('Bash') < 0 &&
        line.indexOf('tool_result') < 0
      ) {
        return;
      }
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (record.type === 'assistant') {
        const content = (record.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) {
          return;
        }
        for (const block of content as Array<{
          type?: unknown;
          name?: unknown;
          id?: unknown;
          input?: { command?: unknown };
        }>) {
          if (block.type === 'tool_use' && block.name === 'Agent' && typeof block.id === 'string' && block.id) {
            launches.add(block.id);
          }
          if (
            block.type === 'tool_use' &&
            block.name === 'Bash' &&
            typeof block.id === 'string' &&
            block.id &&
            typeof block.input?.command === 'string'
          ) {
            const kind = claudeLaunchKind(block.input.command, 'bash');
            if (kind) {
              shellLaunches.set(block.id, kind);
            }
          }
        }
        return;
      }
      const result = record.toolUseResult as { agentId?: unknown } | undefined;
      const resultToolUseId = toolUseIdOf(record.message);
      const pairs: Array<[string, string]> = [];
      if (result && typeof result.agentId === 'string') {
        pairs.push([resultToolUseId, result.agentId]);
      } else if (record.type === 'user') {
        const blocks = (record.message as { content?: unknown } | undefined)?.content;
        for (const block of Array.isArray(blocks)
          ? (blocks as { type?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown }[])
          : []) {
          if (
            block.type !== 'tool_result' ||
            block.is_error ||
            typeof block.tool_use_id !== 'string' ||
            !launches.has(block.tool_use_id)
          ) {
            continue;
          }
          const agentId = claudeAgentResultText(block.content).agentId;
          if (agentId) {
            pairs.push([block.tool_use_id, agentId]);
          }
        }
      }
      const notice = taskNotificationText(record);
      if (notice !== null) {
        pairs.push([
          /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notice)?.[1] ?? '',
          /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1] ?? '',
        ]);
      }
      for (const [toolUseId, sessionId] of pairs) {
        if (!launches.has(toolUseId) || !/^[A-Za-z0-9-]+$/.test(sessionId)) {
          continue;
        }
        const held = children.get(sessionId);
        if (held) {
          held.add(toolUseId);
        } else if (linked < (exportPolicy?.relationships ?? MAX_CLAUDE_CHILD_REFERENCES_PER_FILE)) {
          linked++;
          children.set(sessionId, new Set([toolUseId]));
        } else if (exportPolicy) {
          throw new ExportLimitError('relationships', exportPolicy.relationships);
        }
      }
      const shellLaunch = shellLaunches.get(resultToolUseId);
      if (!shellLaunch || dispatches.has(resultToolUseId)) {
        return;
      }
      const launchKind = shellLaunch.kind;
      const stdout = (record.toolUseResult as { stdout?: unknown } | undefined)?.stdout;
      const output =
        launchKind !== 'native'
          ? typeof stdout === 'string' && stdout.length > 0
            ? stdout
            : null
          : shellResultText(record);
      const launched = output === null ? [] : shellDispatchFromOutput(output, shellLaunch);
      if (exportPolicy && launched.length + linked > exportPolicy.relationships)
        throw new ExportLimitError('relationships', exportPolicy.relationships);
      const kept = launched.slice(0, (exportPolicy?.relationships ?? MAX_CLAUDE_CHILD_REFERENCES_PER_FILE) - linked);
      if (kept.length) {
        linked += kept.length;
        dispatches.set(
          resultToolUseId,
          kept.map((dispatch) => ({
            kind: 'dispatch',
            agent: dispatch.agent,
            parentSessionId: parent.sessionId,
            sessionId: dispatch.sessionId,
            file: null,
            toolUseIds: [resultToolUseId],
            name: dispatch.name,
            owned: dispatch.owned,
          })),
        );
      }
    },
    state() {
      return {
        launches: [...launches],
        children: [...children].map(([id, ids]) => [id, [...ids]]),
        shellLaunches: [...shellLaunches],
        dispatches: [...dispatches],
      };
    },
    references() {
      const references: ClaudeChildSessionReference[] = [...children].map(([sessionId, toolUseIds]) => ({
        kind: 'subagent' as const,
        parentSessionId: parent.sessionId,
        sessionId,
        file: claudeChildFile(parent, sessionId),
        toolUseIds: [...toolUseIds],
      }));
      references.push(...[...dispatches.values()].flat());
      return references;
    },
  };
}

export function scanClaudeChildSessionReferences(
  parent: Pick<SessionFile, 'file' | 'sessionId' | 'childTranscript'>,
): ClaudeChildReferenceScan {
  const reducer = createClaudeRelationshipReducer(parent);
  const complete = scanLines(parent.file, reducer.apply);
  return { complete, references: reducer.references() };
}

export const RELATIONSHIP_QUANTUM_BYTES = 1024 * 1024;
export const RELATIONSHIP_READ_BYTES = 256 * 1024;
export const RELATIONSHIP_RESERVE_BYTES = 16 * 1024;
export const RELATIONSHIP_SLICE_MS = 15;
export const RELATIONSHIP_EVIDENCE_BYTES = 16 * 1024;
const RELATIONSHIP_BLOCK_BYTES = 4096;

export interface RelationshipStamp extends FileRevision {
  mtimeNs: string;
  ctimeNs: string;
}

export interface CommitSource {
  file: string;
  stamp: RelationshipStamp;
}

export function commitSourceStamp(file: string): RelationshipStamp | null {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return stat.isFile() && supportedFileIdentity(revisionOf(stat)) ? relationshipStamp(stat) : null;
  } catch {
    return null;
  }
}

// Bind only the source's own occurrences after an unchanged read. Child rows retain their own source.
export function bindCommitSources(turns: readonly Turn[], file: string, before: RelationshipStamp | null): void {
  const after = commitSourceStamp(file);
  if (!after || !sameRelationshipStamp(before, after)) return;
  const source = { file, stamp: after };
  for (const turn of turns) {
    for (const commit of turn.commits) commit.source = source;
    for (const intent of turn.commitIntents ?? []) intent.source = source;
  }
}

export interface RelationshipDigest {
  offset: number;
  chain: string;
  tail: string;
  // The chain before the final full block. That block and the tail then check a grown prefix without rereading it.
  anchor?: string;
}

export interface RelationshipEvidence extends RelationshipDigest {
  version: 1;
  accepted: RelationshipStamp | null;
  provisional: RelationshipStamp;
  validation?: { stamp: RelationshipStamp; required: number; digest: RelationshipDigest };
}

export function relationshipStamp(stat: fs.BigIntStats): RelationshipStamp {
  return { ...revisionOf(stat), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString() };
}

export function sameRelationshipStamp(left: RelationshipStamp | null, right: RelationshipStamp): boolean {
  return (
    left !== null &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function validRelationshipEvidence(value: unknown, offset: number): value is RelationshipEvidence {
  const object = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null;
  const stamp = (item: unknown): item is RelationshipStamp =>
    object(item) &&
    Number.isSafeInteger(item.size) &&
    (item.size as number) >= 0 &&
    typeof item.mtimeMs === 'number' &&
    Number.isFinite(item.mtimeMs) &&
    item.mtimeMs >= 0 &&
    fileIdentityValue(item.dev) &&
    fileIdentityValue(item.ino) &&
    typeof item.mtimeNs === 'string' &&
    /^\d+$/.test(item.mtimeNs) &&
    typeof item.ctimeNs === 'string' &&
    /^\d+$/.test(item.ctimeNs) &&
    Number(BigInt(item.mtimeNs) / 1_000_000n) + Number(BigInt(item.mtimeNs) % 1_000_000n) / 1_000_000 === item.mtimeMs;
  const digest = (item: unknown): item is RelationshipDigest =>
    object(item) &&
    Number.isSafeInteger(item.offset) &&
    (item.offset as number) >= 0 &&
    typeof item.chain === 'string' &&
    /^[0-9a-f]{64}$/.test(item.chain) &&
    (item.anchor === undefined || (typeof item.anchor === 'string' && /^[0-9a-f]{64}$/.test(item.anchor))) &&
    typeof item.tail === 'string' &&
    Buffer.from(item.tail, 'base64').toString('base64') === item.tail &&
    Buffer.byteLength(item.tail, 'base64') === (item.offset as number) % RELATIONSHIP_BLOCK_BYTES;
  if (
    !object(value) ||
    Buffer.byteLength(JSON.stringify(value)) > RELATIONSHIP_EVIDENCE_BYTES ||
    value.version !== 1 ||
    !digest(value) ||
    value.offset !== offset ||
    !stamp(value.provisional) ||
    value.provisional.size < offset ||
    !(value.accepted === null || (stamp(value.accepted) && sameRelationshipStamp(value.accepted, value.provisional)))
  )
    return false;
  const validation = value.validation;
  return (
    validation === undefined ||
    (object(validation) &&
      stamp(validation.stamp) &&
      validation.stamp.dev === value.provisional.dev &&
      validation.stamp.ino === value.provisional.ino &&
      validation.stamp.size >= value.provisional.size &&
      validation.required === offset &&
      digest(validation.digest) &&
      validation.digest.offset <= offset)
  );
}

function emptyRelationshipDigest(): RelationshipDigest {
  return { offset: 0, chain: createHash('sha256').update('arc-relationship-prefix-v1').digest('hex'), tail: '' };
}

export function relationshipEvidence(stamp: RelationshipStamp): RelationshipEvidence {
  return { version: 1, ...emptyRelationshipDigest(), accepted: stamp, provisional: stamp };
}

export function extendRelationshipEvidence(evidence: RelationshipDigest, bytes: Buffer): void {
  const joined = Buffer.concat([Buffer.from(evidence.tail, 'base64'), bytes]);
  let index = (evidence.offset - Buffer.byteLength(evidence.tail, 'base64')) / RELATIONSHIP_BLOCK_BYTES;
  let at = 0;
  for (; at + RELATIONSHIP_BLOCK_BYTES <= joined.length; at += RELATIONSHIP_BLOCK_BYTES) {
    evidence.anchor = evidence.chain;
    evidence.chain = createHash('sha256')
      .update(`arc-relationship-block-v1:${index++}:`)
      .update(evidence.chain)
      .update(joined.subarray(at, at + RELATIONSHIP_BLOCK_BYTES))
      .digest('hex');
  }
  evidence.tail = joined.subarray(at).toString('base64');
  evidence.offset += bytes.length;
}

// Every returned filesystem byte enters the request meter before any later operation can fail.
// `revalidationBytes` is the part of `readBytes` that re-hashes a prefix an earlier scan read.
export interface RelationshipReadMeter {
  readBytes: number;
  revalidationBytes?: number;
  size?: number;
  onRead?: (bytes: Buffer, offset: number) => void;
}

export class RelationshipReader {
  readonly stamp: RelationshipStamp;
  readonly deadline: number;
  private readonly buffer = Buffer.allocUnsafe(RELATIONSHIP_READ_BYTES);
  readBytes = 0;
  stable = true;
  private advanced = false;
  constructor(
    readonly fd: number,
    readonly file: string,
    readonly budget: number,
    readonly cancelled: () => boolean,
    readonly meter?: RelationshipReadMeter,
    readonly capturedSizeOnly = false,
  ) {
    this.stamp = relationshipStamp(fs.fstatSync(fd, { bigint: true }));
    this.deadline = Number.isFinite(budget) ? performance.now() + RELATIONSHIP_SLICE_MS : Infinity;
    this.check();
  }
  check(): boolean {
    if (this.capturedSizeOnly) return true;
    try {
      this.stable &&=
        sameRelationshipStamp(this.stamp, relationshipStamp(fs.fstatSync(this.fd, { bigint: true }))) &&
        sameRelationshipStamp(this.stamp, relationshipStamp(fs.statSync(this.file, { bigint: true })));
    } catch {
      this.stable = false;
    }
    return this.stable;
  }
  // Reads ignore the deadline until a read that moves the scan returns bytes, so every slice makes progress.
  available(reserve = RELATIONSHIP_RESERVE_BYTES): number {
    return this.stable && !this.cancelled() && (!this.advanced || performance.now() < this.deadline)
      ? Math.max(0, this.budget - this.readBytes - reserve)
      : 0;
  }
  // The one-byte check after a terminal record passes advances false, so the parsing read that follows it still ignores the deadline.
  read(at: number, length: number, reserve = RELATIONSHIP_RESERVE_BYTES, advances = true): Buffer {
    const size = Math.min(
      length,
      RELATIONSHIP_READ_BYTES,
      this.available(reserve),
      (this.meter?.size ?? Infinity) - at,
    );
    if (size <= 0) return Buffer.alloc(0);
    const count = meterRead(this.file, fs.readSync(this.fd, this.buffer, 0, size, at), at);
    this.readBytes += count;
    if (advances && count > 0) this.advanced = true;
    if (this.meter) this.meter.readBytes += count;
    this.meter?.onRead?.(this.buffer.subarray(0, count), at);
    this.check();
    return this.buffer.subarray(0, count);
  }
  *qualifySteps(evidence: RelationshipEvidence): Generator<void, 'match' | 'pending' | 'reset'> {
    if (sameRelationshipStamp(evidence.accepted, this.stamp) && this.check()) return 'match';
    const prior = evidence.provisional;
    if (
      prior.dev !== this.stamp.dev ||
      prior.ino !== this.stamp.ino ||
      this.stamp.size < prior.size ||
      this.stamp.size < evidence.offset
    )
      return 'reset';
    if (!evidence.validation || !sameRelationshipStamp(evidence.validation.stamp, this.stamp)) {
      // Only growth with no comparison in progress checks the anchor. A same-size change compares the whole prefix.
      // Growth during that comparison restarts it over the whole prefix, so a same-size interior rewrite still resets.
      // A grown file rewritten before its final block keeps its accepted facts until a same-size change, a shrink, or a replacement.
      if (!evidence.validation && this.stamp.size > prior.size) {
        const anchored = this.anchored(evidence);
        if (anchored === 'match') return this.accept(evidence);
        if (anchored === 'pending') return 'pending';
      }
      evidence.validation = { stamp: this.stamp, required: evidence.offset, digest: emptyRelationshipDigest() };
    }
    const comparison = evidence.validation;
    while (comparison.digest.offset < comparison.required && this.available() > 0) {
      const remaining = comparison.required - comparison.digest.offset;
      const available = this.available();
      const allowance =
        remaining < RELATIONSHIP_BLOCK_BYTES && remaining <= available
          ? remaining
          : Math.floor(available / RELATIONSHIP_BLOCK_BYTES) * RELATIONSHIP_BLOCK_BYTES;
      const bytes = this.read(comparison.digest.offset, Math.min(RELATIONSHIP_READ_BYTES, remaining, allowance));
      if (this.meter) this.meter.revalidationBytes = (this.meter.revalidationBytes ?? 0) + bytes.length;
      if (!bytes.length) break;
      for (let at = 0; at < bytes.length; at += RELATIONSHIP_BLOCK_BYTES) {
        if (at > 0 && (this.cancelled() || performance.now() >= this.deadline)) break;
        extendRelationshipEvidence(comparison.digest, bytes.subarray(at, at + RELATIONSHIP_BLOCK_BYTES));
      }
      yield;
    }
    if (comparison.digest.offset !== comparison.required || !this.check() || this.cancelled()) return 'pending';
    if (comparison.digest.chain !== evidence.chain || comparison.digest.tail !== evidence.tail) return 'reset';
    evidence.anchor = comparison.digest.anchor;
    return this.accept(evidence);
  }
  // Reads the final full block and the tail, at most two blocks. A cancelled, short, or unstable read leaves the anchor for the next quantum. A missing or mismatched anchor needs the whole prefix.
  private anchored(evidence: RelationshipEvidence): 'match' | 'pending' | 'compare' {
    if (evidence.anchor === undefined || evidence.offset < RELATIONSHIP_BLOCK_BYTES) return 'compare';
    const start = evidence.offset - Buffer.byteLength(evidence.tail, 'base64') - RELATIONSHIP_BLOCK_BYTES;
    const bytes = this.read(start, evidence.offset - start);
    if (this.meter) this.meter.revalidationBytes = (this.meter.revalidationBytes ?? 0) + bytes.length;
    if (bytes.length !== evidence.offset - start || !this.check() || this.cancelled()) return 'pending';
    const check: RelationshipDigest = { offset: start, chain: evidence.anchor, tail: '' };
    extendRelationshipEvidence(check, bytes);
    return check.chain === evidence.chain && check.tail === evidence.tail ? 'match' : 'compare';
  }
  private accept(evidence: RelationshipEvidence): 'match' {
    evidence.accepted = this.stamp;
    evidence.provisional = this.stamp;
    delete evidence.validation;
    return 'match';
  }
}

export interface ClaudeRelationshipCursor {
  exportPolicy?: ExportRelationshipLimits;
  evidence?: RelationshipEvidence;
  revision: FileRevision;
  target: number;
  offset: number;
  applied: number;
  head: string;
  headBytes: number;
  anchor: string;
  fragments: string[];
  fragmentBytes: number;
  terminalApplied: boolean;
  sessionId: string;
  childTranscript: boolean;
  sequence: number;
  state: ClaudeRelationshipState;
}

// The fixed target and byte fragments survive a worker restart. A terminal record is
// applied once, and only a newline can extend that record without starting a new generation.
export async function scanClaudeRelationshipQuantum(
  parent: Pick<SessionFile, 'file' | 'sessionId' | 'childTranscript'>,
  previous: ClaudeRelationshipCursor | undefined,
  budget = RELATIONSHIP_QUANTUM_BYTES,
  signal?: AbortSignal,
  meter?: RelationshipReadMeter,
  exportPolicy?: ExportRelationshipLimits,
): Promise<{
  cursor: ClaudeRelationshipCursor;
  references: ClaudeChildSessionReference[];
  complete: boolean;
  qualified: boolean;
  readBytes: number;
  reset: boolean;
}> {
  const fd = fs.openSync(parent.file, 'r');
  try {
    let cursor =
      previous && JSON.stringify(previous.exportPolicy) === JSON.stringify(exportPolicy)
        ? exportPolicy
          ? previous
          : (meterReadWork('cursorCopies'), structuredClone(previous))
        : undefined;
    const reader = new RelationshipReader(fd, parent.file, budget, () => signal?.aborted === true, meter);
    const revision = reader.stamp;
    let qualification: 'match' | 'pending' | 'reset' = 'reset';
    if (
      cursor?.evidence &&
      cursor.sessionId === parent.sessionId &&
      cursor.childTranscript === (parent.childTranscript === true)
    ) {
      const steps = reader.qualifySteps(cursor.evidence);
      let step = steps.next();
      while (!step.done) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        step = steps.next();
      }
      qualification = step.value;
    }
    if (qualification === 'match') cursor!.revision = cursor!.evidence!.provisional;
    if (qualification === 'match' && cursor!.terminalApplied && cursor!.offset < revision.size) {
      const continuation = reader.read(cursor!.offset, 1, 0, false);
      if (!continuation.length) qualification = 'pending';
      else if (continuation[0] !== 10 && continuation[0] !== 13) qualification = 'reset';
    }
    const reset = !!previous && qualification === 'reset';
    if (!cursor || qualification === 'reset') {
      const state = createClaudeRelationshipReducer(parent).state();
      cursor = {
        revision,
        evidence: relationshipEvidence(revision),
        target: revision.size,
        offset: 0,
        applied: 0,
        head: emptyRelationshipDigest().chain,
        headBytes: 0,
        anchor: emptyRelationshipDigest().chain,
        fragments: [],
        fragmentBytes: 0,
        terminalApplied: false,
        sessionId: parent.sessionId,
        childTranscript: parent.childTranscript === true,
        ...(exportPolicy ? { exportPolicy: { ...exportPolicy } } : {}),
        sequence: previous?.sequence ?? 0,
        state,
      };
      qualification = 'match';
    }
    const reducer = createClaudeRelationshipReducer(parent, cursor.state, exportPolicy);
    if (qualification === 'match') {
      cursor.revision = revision;
      if (cursor.offset === cursor.target) cursor.target = revision.size;
    }
    if (!reset && qualification === 'match')
      while (cursor.offset < cursor.target && reader.available() > 0) {
        const bytes = reader.read(cursor.offset, cursor.target - cursor.offset);
        if (!bytes.length) break;
        extendRelationshipEvidence(cursor.evidence!, bytes);
        const base = cursor.offset;
        cursor.offset += bytes.length;
        let start = 0;
        for (let index = 0; index < bytes.length; index++) {
          if (bytes[index] !== 10) continue;
          if (exportPolicy && cursor.fragmentBytes + index - start > exportPolicy.recordBytes)
            throw new ExportLimitError('record', exportPolicy.recordBytes);
          const record = Buffer.concat([
            ...cursor.fragments.map((fragment) => Buffer.from(fragment, 'base64')),
            bytes.subarray(start, index),
          ]);
          if (!cursor.terminalApplied) reducer.apply(record.toString('utf8'));
          cursor.terminalApplied = false;
          cursor.fragments = [];
          cursor.fragmentBytes = 0;
          cursor.applied = base + index + 1;
          start = index + 1;
        }
        if (start < bytes.length) {
          const fragment = bytes.subarray(start);
          if (exportPolicy && cursor.fragmentBytes + fragment.length > exportPolicy.recordBytes)
            throw new ExportLimitError('record', exportPolicy.recordBytes);
          cursor.fragments.push(fragment.toString('base64'));
          cursor.fragmentBytes += fragment.length;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        reader.check();
      }
    if (
      !reset &&
      qualification === 'match' &&
      reader.stable &&
      !signal?.aborted &&
      cursor.offset === cursor.target &&
      cursor.fragmentBytes &&
      !cursor.terminalApplied
    ) {
      const terminal = Buffer.concat(cursor.fragments.map((fragment) => Buffer.from(fragment, 'base64'))).toString(
        'utf8',
      );
      try {
        JSON.parse(terminal);
        reducer.apply(terminal);
        cursor.terminalApplied = true;
        cursor.applied = cursor.offset;
      } catch {
        /* An incomplete terminal record waits for its remaining bytes. */
      }
    }
    const qualified = qualification === 'match' && reader.check();
    if (!qualified && qualification === 'match') cursor.evidence!.accepted = null;
    cursor.state = reducer.state();
    cursor.sequence++;
    if (!validRelationshipEvidence(cursor.evidence, cursor.offset))
      throw new Error('Relationship evidence exceeds its limits');
    return {
      cursor,
      references: reducer.references(),
      qualified,
      complete:
        !reset &&
        qualified &&
        cursor.offset === cursor.target &&
        cursor.target === revision.size &&
        (cursor.fragmentBytes === 0 || cursor.terminalApplied) &&
        !signal?.aborted,
      readBytes: reader.readBytes,
      reset,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function launchesClaudeSession(command: string): boolean {
  return claudeLaunchKind(command, 'bash') !== null;
}

// The Claude launches in one shell command, all of one kind, and how many there are.
interface ClaudeShellLaunch {
  kind: 'native' | 'codex-native' | 'receipt';
  count: number;
}

export type ClaudeShellDialect = 'bash' | 'powershell';

// Reject resumed or mixed launch kinds. Homogeneous opted-in wrappers count each launch for receipt validation.
// Without a known shell, launch kinds and source positions must agree under Bash and PowerShell.
export function claudeLaunchKind(command: string, shell?: ClaudeShellDialect): ClaudeShellLaunch | null {
  const classified = shellLaunchKind(command, shell ?? 'bash');
  if (!classified) return null;
  if (!shell) {
    const other = shellLaunchKind(command, 'powershell');
    if (
      !other ||
      other.kind !== classified.kind ||
      other.offsets.length !== classified.offsets.length ||
      other.offsets.some((offset, index) => offset !== classified.offsets[index])
    ) {
      return null;
    }
  }
  return { kind: classified.kind, count: classified.offsets.length };
}

// Classifies launches and source positions under one shell grammar.
function shellLaunchKind(
  command: string,
  shell: ClaudeShellDialect,
): { kind: ClaudeShellLaunch['kind']; offsets: number[] } | null {
  let launch: ClaudeShellLaunch['kind'] | null = null;
  const offsets: number[] = [];
  let mixed = false;
  const ambiguousQuotes = command.includes('`"');
  for (const segment of commandSegments(command, shell)) {
    const expressionEnds = parenthesizedEnds(segment.masked);
    for (const offset of commandStartOffsets(segment.masked)) {
      const words = commandWords(segment.text, offset, segment.masked, expressionEnds, ambiguousQuotes);
      if (words === null) return null;
      const kind = claudeCommandKind(words);
      if (kind === 'resume') {
        return null;
      }
      if (!kind) {
        continue;
      }
      mixed ||= launch !== null && launch !== kind;
      launch = kind;
      offsets.push(segment.offset + offset);
    }
  }
  return mixed || !launch ? null : { kind: launch, offsets };
}

function commandStartOffsets(masked: string): number[] {
  const offsets = [0];
  for (const match of masked.matchAll(/[({|&]/g)) {
    offsets.push((match.index ?? 0) + 1);
  }
  return offsets;
}

// Each command boundary shares the same balanced parentheses. Quoted interiors are masked.
function parenthesizedEnds(masked: string): ReadonlyMap<number, number> {
  const ends = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '(') {
      open.push(i);
    } else if (masked[i] === ')') {
      const start = open.pop();
      if (start !== undefined) ends.set(start, i);
    }
  }
  return ends;
}

// Read shell words from one command boundary. Quoted executable paths keep their contents,
// while quoted output elsewhere remains behind a non-launching command word such as `grep`.
// Words end where `masked` hides text outside a quoted word.
// These regions contain heredoc input, PowerShell here-strings, comments, or escaped parentheses.
// None supplies command arguments.
// Words after a heredoc opener on its own line are still arguments, so the opener itself does
// not end them. A backslash escapes a double quote inside double quotes.
// A quote that `masked` hides sits inside another
// quoted string, as in a quoted command substitution, and closes nothing.
function commandWords(
  command: string,
  offset: number,
  masked: string,
  expressionEnds: ReadonlyMap<number, number>,
  ambiguousQuotes: boolean,
): string[] | null {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = offset; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      started = true;
      if (quote === '"' && c === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        word += command[++i];
      } else if (c === quote && masked[i] !== FILL) {
        quote = '';
      } else {
        word += c;
      }
      continue;
    }
    if (masked[i] === FILL) {
      break;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === '\\' && i + 1 < command.length && ESCAPABLE.test(command[i + 1])) {
      word += command[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    // A bare parenthesized argument is opaque. Prefixed forms still end the command words.
    if (c === '(' && !started && words.length > 0) {
      // Backtick quotes have different Bash and PowerShell boundaries. Do not continue them.
      if (ambiguousQuotes) return null;
      const end = expressionEnds.get(i);
      if (end === undefined) break;
      word = FILL;
      started = true;
      i = end;
      continue;
    }
    if (/[(){}|&]/.test(c) || (c === '`' && /[()]/.test(masked[i]))) {
      break;
    }
    word += c;
    started = true;
  }
  if (started) {
    words.push(word);
  }
  return words;
}

function executableName(word: string): string {
  return word.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
}

function claudeCommandKind(words: readonly string[]): ClaudeShellLaunch['kind'] | 'resume' | null {
  let at = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '')) {
    at++;
  }
  while (/^(?:nohup|command|exec)$/i.test(words[at] ?? '')) {
    at++;
  }
  const executable = executableName(words[at] ?? '');
  if (/^claude(?:\.exe|\.cmd)?$/.test(executable)) {
    return resumesClaudeSession(words.slice(at + 1)) ? 'resume' : 'native';
  }
  if (/^codex(?:\.exe|\.cmd)?$/.test(executable)) {
    const args = words.slice(at + 1);
    if (args.includes('resume') || args.includes('--resume')) return 'resume';
    if (args.includes('exec') && args.includes('--json')) return 'codex-native';
  }
  if (
    !/^(?:cat|echo|findstr|grep|printf|rg|sed|type)$/.test(executable) &&
    words.slice(at + 1).includes('--arc-dispatch')
  ) {
    return 'receipt';
  }
  return null;
}

// `claude --resume`, `-r`, `--continue` and `-c` run in an existing session, and a JSON result
// names that session, not a new one. `--fork-session` gives the run a new session id, so a
// fork still launches one. `-r` and `-c` also count inside a cluster of short flags such as
// `-pr`, up to the first letter that takes a value, `-d`, `-n` or `-w`.
function resumesClaudeSession(args: readonly string[]): boolean {
  let resumes = false;
  for (const word of args) {
    if (word === '--') {
      break;
    }
    if (word === '--fork-session') {
      return false;
    }
    if (/^--(?:resume|continue)(?:=|$)/.test(word)) {
      resumes = true;
      continue;
    }
    const cluster = /^-([A-Za-z]\S*)$/.exec(word)?.[1];
    if (!cluster) {
      continue;
    }
    for (const letter of cluster) {
      if (letter === 'r' || letter === 'c') {
        resumes = true;
        break;
      }
      if (!/[A-Za-z]/.test(letter) || letter === 'd' || letter === 'n' || letter === 'w') {
        break;
      }
    }
  }
  return resumes;
}

interface ClaudeDispatchLaunch {
  agent: AgentKind;
  sessionId: string;
  name: string | null;
  owned: boolean;
}

// Maximum accepted dispatch receipts in one tool result, also bounded by the command's opted-in launch count.
export const MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT = 16;

// The most references one parent file keeps. The derived session cache drops a larger entry,
// and startup then reads that parent again, so the scan links children only up to this count.
export const MAX_CLAUDE_CHILD_REFERENCES_PER_FILE = 4_096;

export function claudeDispatchReceipts(output: string, launches: number): ClaudeDispatchLaunch[] {
  const prefix = `${ARC_IDENTITY.environmentPrefix}DISPATCH_SESSION=`;
  const receipts: ClaudeDispatchLaunch[] = [];
  const named = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) {
      continue;
    }
    if (line.length > 4096 || receipts.length >= Math.min(launches, MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT)) {
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(line.slice(prefix.length));
    } catch {
      return [];
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [];
    }
    const fields = value as Record<string, unknown>;
    if (
      Object.keys(fields).some((key) => !['agent', 'session_id', 'name', 'owned'].includes(key)) ||
      (fields.agent !== 'claude' && fields.agent !== 'codex') ||
      typeof fields.session_id !== 'string' ||
      !(
        fields.agent === 'codex'
          ? /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
          : /^(?:[0-9a-f]{8}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
      ).test(fields.session_id) ||
      (fields.name !== undefined && typeof fields.name !== 'string') ||
      (fields.owned !== undefined && fields.owned !== true)
    ) {
      return [];
    }
    const session = `${fields.agent}:${(fields.agent === 'codex' ? fields.session_id : fields.session_id.slice(0, 8)).toLowerCase()}`;
    if (named.has(session)) {
      return [];
    }
    named.add(session);
    receipts.push({
      agent: fields.agent,
      sessionId: fields.session_id,
      name: typeof fields.name === 'string' ? fields.name.trim() || null : null,
      owned: fields.owned === true,
    });
  }
  return receipts;
}

export function shellDispatchFromOutput(output: string, launch: ClaudeShellLaunch): ClaudeDispatchLaunch[] {
  if (launch.kind === 'receipt') return claudeDispatchReceipts(output, launch.count);
  if (launch.kind === 'native') {
    const child = claudeDispatchFromOutput(output);
    return child ? [child] : [];
  }
  if (launch.count !== 1) return [];
  const starts: ClaudeDispatchLaunch[] = [];
  for (const line of output.split(/\r?\n/)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type !== 'thread.started') continue;
    if (typeof event.thread_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(event.thread_id))
      return [];
    starts.push({ agent: 'codex', sessionId: event.thread_id, name: null, owned: false });
  }
  return starts.length === 1 ? starts : [];
}

function shellResultText(record: Record<string, unknown>): string | null {
  const result = record.toolUseResult as { stdout?: unknown } | undefined;
  if (typeof result?.stdout === 'string') {
    return result.stdout;
  }
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const block = content.find((candidate) => {
    const value = candidate as { type?: unknown };
    return value?.type === 'tool_result';
  }) as { content?: unknown } | undefined;
  return typeof block?.content === 'string' ? block.content : null;
}

function claudeDispatchFromOutput(output: string): ClaudeDispatchLaunch | null {
  const background = /backgrounded\s+(?:Â?·)\s+([0-9a-f]{8})\s+(?:Â?·)\s+([^\r\n]+)/i.exec(output);
  if (background) {
    return { agent: 'claude', sessionId: background[1], name: background[2].trim() || null, owned: false };
  }
  for (const line of output.split(/\r?\n/)) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object') {
      continue;
    }
    const result = value as { type?: unknown; session_id?: unknown };
    if (result.type === 'result' && typeof result.session_id === 'string' && /^[0-9a-f-]+$/i.test(result.session_id)) {
      return { agent: 'claude', sessionId: result.session_id, name: null, owned: false };
    }
  }
  return null;
}

export function resolveClaudeDispatchReferences(
  references: readonly ClaudeChildSessionReference[],
  catalog: readonly SessionFile[],
): ClaudeChildSessionReference[] {
  const codex = new Map<string, Pick<SessionFile, 'sessionId' | 'file'> | null>();
  for (const session of catalog) {
    if (session.agent !== 'codex') continue;
    const key = session.sessionId.toLowerCase();
    codex.set(key, codex.has(key) ? null : session);
  }
  const byPrefix = new Map<string, Pick<SessionFile, 'sessionId' | 'file'> | null>();
  for (const session of catalog) {
    if (session.agent !== 'claude' || session.childTranscript === true) {
      continue;
    }
    const sessionId = session.sessionId;
    const entry = { sessionId, file: session.file };
    for (let length = 1; length <= sessionId.length; length++) {
      const prefix = sessionId.slice(0, length).toLowerCase();
      if (!byPrefix.has(prefix)) {
        byPrefix.set(prefix, entry);
      } else {
        byPrefix.set(prefix, null);
      }
    }
  }
  const resolved: ClaudeChildSessionReference[] = [];
  for (const reference of references) {
    if (reference.kind !== 'dispatch') {
      resolved.push(reference);
      continue;
    }
    const match = (reference.agent === 'codex' ? codex : reference.agent === 'claude' ? byPrefix : new Map()).get(
      reference.sessionId.toLowerCase(),
    );
    if (!match) {
      continue;
    }
    resolved.push({ ...reference, sessionId: match.sessionId, file: match.file });
  }
  return resolved;
}

export function claudeChildSessionFiles(
  references: readonly ClaudeChildSessionReference[],
  repositoryRoots: readonly string[],
  cache: ClaudeChildSessionResolver = new ClaudeChildSessionCache(),
): ClaudeChildSessionFile[] {
  const byId = new Map<string, ClaudeChildSessionFile | null>();
  for (const reference of references) {
    if (reference.kind === 'dispatch') {
      continue;
    }
    const candidate = cache.read(reference, repositoryRoots);
    if (!candidate) {
      continue;
    }
    const previous = byId.get(reference.sessionId);
    if (previous === undefined) {
      byId.set(reference.sessionId, candidate);
    } else if (previous === null || normalizeFsPath(previous.file) !== normalizeFsPath(candidate.file)) {
      byId.set(reference.sessionId, null);
    } else {
      previous.toolUseIds = [...new Set([...previous.toolUseIds, ...candidate.toolUseIds])];
    }
  }
  return [...byId.values()].filter((child): child is ClaudeChildSessionFile => child !== null);
}

// The working directory a child transcript's head named at one file revision.
export interface ClaudeChildHead {
  revision: FileRevision;
  cwd: string | null;
}

export class ClaudeChildSessionCache implements ClaudeChildSessionResolver {
  private entries = new Map<string, ClaudeChildHead>();

  constructor(private readonly cwdOf: (file: string) => string | null = readSessionCwd) {}

  // Keys are `normalizeFsPath` results. A seeded head answers only while the file keeps its revision.
  heads(): ReadonlyMap<string, ClaudeChildHead> {
    return this.entries;
  }

  seed(key: string, head: ClaudeChildHead): void {
    if (!this.entries.has(key)) this.entries.set(key, head);
  }

  read(reference: ClaudeSubagentSessionReference, repositoryRoots: readonly string[]): ClaudeChildSessionFile | null {
    const key = normalizeFsPath(reference.file);
    let stat: fs.BigIntStats;
    try {
      stat = fs.statSync(reference.file, { bigint: true });
      if (!stat.isFile() || stat.size === 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.entries.delete(key);
        return null;
      }
    } catch {
      this.entries.delete(key);
      return null;
    }
    // Physical identity uses the same decimal strings as root catalog rows, so a paged listing can prove the source unchanged.
    const revision = revisionOf(stat);
    const held = this.entries.get(key);
    let unreadable = false;
    const current =
      held &&
      held.revision.size === revision.size &&
      held.revision.mtimeMs === revision.mtimeMs &&
      held.revision.dev === revision.dev &&
      held.revision.ino === revision.ino;
    const cwd = current
      ? held.cwd
      : this.cwdOf === readSessionCwd
        ? scanSessionCwd(reference.file, () => {
            unreadable = true;
          })
        : this.cwdOf(reference.file);
    if (unreadable) throw new Error(`Cannot read session: ${reference.file}`);
    if (!current) this.entries.set(key, { revision, cwd });
    if (!cwd || !isInside(cwd, [...repositoryRoots])) {
      return null;
    }
    return {
      agent: 'claude',
      file: reference.file,
      sessionId: reference.sessionId,
      parentSessionId: reference.parentSessionId,
      toolUseIds: [...reference.toolUseIds],
      ...revision,
      cwd,
      agentRun: true,
      childTranscript: true,
    };
  }
}

export function claudeChildReferenceFor(
  references: readonly ClaudeChildSessionReference[],
  parentSessionId: string,
  agent: Pick<import('./agentspend').AgentSpendRef, 'id' | 'toolUseId'>,
): ClaudeChildSessionReference | null {
  if (!agent.id || !agent.toolUseId) {
    return null;
  }
  const matches = references.filter(
    (reference): reference is ClaudeSubagentSessionReference =>
      reference.kind !== 'dispatch' &&
      reference.parentSessionId === parentSessionId &&
      reference.sessionId === agent.id &&
      reference.toolUseIds.includes(agent.toolUseId as string),
  );
  return matches.length === 1 ? matches[0] : null;
}

// The transcript of the Claude child that one row launched. A discovery reference answers first.
// A child that discovery has not listed yet resolves from its `agent-<id>.meta.json` beside the
// session, and only when that meta file names the row's launch call. The worker and the host both
// call this, so a window and its dependency key agree on the child's file.
export function claudeChildFileFor(
  references: readonly ClaudeChildSessionReference[],
  session: Pick<SessionFile, 'file' | 'sessionId' | 'childTranscript'>,
  agent: Pick<import('./agentspend').AgentSpendRef, 'id' | 'toolUseId'>,
  metas: ClaudeSubagentMetaReader = readClaudeSubagentMetas,
): string | null {
  const reference = claudeChildReferenceFor(references, session.sessionId, agent);
  if (reference) {
    return reference.file;
  }
  if (!agent.id || !agent.toolUseId) {
    return null;
  }
  const matches = claudeDirectSubagents(session.file, session.childTranscript === true, metas).filter(
    (meta) => meta.id === agent.id && meta.toolUseId === agent.toolUseId,
  );
  return matches.length === 1 ? matches[0].file : null;
}

export function discoverClaudeChildSessions(
  parents: readonly SessionFile[],
  repositoryRoots: readonly string[],
  referencesOf: (parent: SessionFile) => ClaudeChildSessionReference[] = readClaudeChildSessionReferences,
  cache: ClaudeChildSessionResolver = new ClaudeChildSessionCache(),
): ClaudeChildDiscovery {
  const queue = [...parents];
  const queued = new Set(queue.map((session) => normalizeFsPath(session.file)));
  const visited = new Set<string>();
  const references: ClaudeChildSessionReference[] = [];
  const byId = new Map<string, ClaudeChildSessionFile | null>();
  while (queue.length) {
    const parent = queue.shift() as SessionFile;
    const key = normalizeFsPath(parent.file);
    queued.delete(key);
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    for (const reference of referencesOf(parent)) {
      references.push(reference);
      if (reference.kind === 'dispatch') {
        continue;
      }
      const child = cache.read(reference, repositoryRoots);
      if (!child) {
        continue;
      }
      const previous = byId.get(child.sessionId);
      if (previous === undefined) {
        byId.set(child.sessionId, child);
      } else if (previous === null || normalizeFsPath(previous.file) !== normalizeFsPath(child.file)) {
        byId.set(child.sessionId, null);
        continue;
      } else {
        previous.toolUseIds = [...new Set([...previous.toolUseIds, ...child.toolUseIds])];
      }
      const childKey = normalizeFsPath(child.file);
      if (!visited.has(childKey) && !queued.has(childKey)) {
        queue.push(child);
        queued.add(childKey);
      }
    }
  }
  const byParent = new Map<string, ClaudeChildSessionFile[]>();
  for (const child of byId.values()) {
    if (!child) {
      continue;
    }
    const held = byParent.get(child.parentSessionId) ?? [];
    held.push(child);
    byParent.set(child.parentSessionId, held);
  }
  const reachable = [...new Set(parents.map((parent) => parent.sessionId))];
  const seenIds = new Set(reachable);
  const children: ClaudeChildSessionFile[] = [];
  for (let index = 0; index < reachable.length; index++) {
    for (const child of byParent.get(reachable[index]) ?? []) {
      if (seenIds.has(child.sessionId)) {
        continue;
      }
      seenIds.add(child.sessionId);
      reachable.push(child.sessionId);
      children.push(child);
    }
  }
  return { references, children };
}

export function discoverClaudeChildSessionFiles(
  parents: readonly SessionFile[],
  repositoryRoots: readonly string[],
  referencesOf: (parent: SessionFile) => ClaudeChildSessionReference[] = readClaudeChildSessionReferences,
): ClaudeChildSessionFile[] {
  return discoverClaudeChildSessions(parents, repositoryRoots, referencesOf).children;
}

// Scratch and agent-state roots excluded from timeline file changes.
// Snapshot hooks apply the corresponding ignore-root rule. Explicit environment roots replace these defaults.
function ephemeralRoots(): string[] {
  const env = process.env[`${ARC_IDENTITY.environmentPrefix}IGNORE_ROOTS`];
  if (env !== undefined) {
    return env.split(path.delimiter).filter(Boolean);
  }
  return [os.tmpdir(), claudeConfigHome(), codexHome(), path.resolve(arcHome())];
}

export function isEphemeralPath(target: string): boolean {
  const t = normalizeFsPath(target);
  return ephemeralRoots().some((root) => {
    const r = normalizeFsPath(root).replace(/\/$/, '');
    return t === r || t.startsWith(r + '/');
  });
}

// Filesystem comparison spelling with forward slashes. Windows drive paths use lowercase on every platform.
// Other paths use lowercase only on Windows.
export function normalizeFsPath(target: string): string {
  const unified = target.replace(/\\/g, '/');
  const drive = /^([a-zA-Z]):\//.exec(unified);
  const cased = drive ? drive[1].toLowerCase() + unified.slice(1) : unified;
  return drive || process.platform === 'win32' ? cased.toLowerCase() : cased;
}

// Windows drive-absolute path with uppercase drive letter and backslashes. Other path shapes remain unchanged.
export function nativePath(target: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(target)) {
    return target;
  }
  return target[0].toUpperCase() + target.slice(1).replace(/\//g, '\\');
}

// Last `bytes` of a file, split into whole lines. The first line is dropped when the
// window starts mid-file, because it is a fragment.
export function tailLines(file: string, bytes: number): string[] {
  return tailOf(file, bytes).lines;
}

// A tail read of a Claude transcript whose repeated records are blanked. The window cannot hold the
// originals before it, so each line is classified through the map of the whole file. A rail read
// sets `bounded`: it extends the map by at most its own window and never waits for the rest. It skips
// each record the map does not reach yet, and the map completes in the background.
export function claudeTailOf(file: string, bytes: number, keepCursor = false, bounded = false): TailRead {
  const tail = tailOf(file, bytes, keepCursor);
  if (!tail.lines.length) return tail;
  const allowance = bounded ? bytes : Infinity;
  return {
    ...tail,
    lines: blankClaudeRepeated(file, tail.lines, tail.offset ?? 0, Number.MAX_SAFE_INTEGER, allowance),
  };
}

// Read options whose session reducer skips the repeated records of `file`.
export function withClaudeRepeated(file: string, opts: ReadOptions): ReadOptions {
  return opts.repeatedRecord
    ? opts
    : { ...opts, repeatedRecord: claudeRepeatedClassifier(file, Number.MAX_SAFE_INTEGER) };
}

// Opened source revision used to reject replaced or changed files during backward reads.
export interface FileRevision {
  size: number;
  mtimeMs: number;
  dev: number | string;
  ino: number | string;
}

export interface BackwardLineCursor {
  discardedFragment?: boolean;
  revision: FileRevision;
  // The exclusive older edge of the bytes already inspected.
  end: number;
  // The beginning fragment dropped by the tail read. It becomes a complete JSONL record
  // when an older chunk supplies the rest of its line.
  fragment: Buffer;
}

export interface BackwardLine {
  oversized?: boolean;
  offset: number;
  text: string;
}

export interface BackwardLineBatch {
  cursor: BackwardLineCursor;
  // Newest first, matching the direction in which the discovery walks.
  lines: BackwardLine[];
}

export type BackwardRangeReader = (
  file: string,
  start: number,
  length: number,
  revision: FileRevision,
) => Buffer | null;

export type BoundaryDiscovery = { kind: 'found'; readBytes: number } | { kind: 'beginning' | 'stale' | 'cancelled' };

export interface BoundaryDiscoveryOptions {
  chunkBytes?: number;
  signal?: AbortSignal;
  pause?: () => Promise<void>;
  readRange?: BackwardRangeReader;
}

export interface TailRead {
  success?: boolean;
  lines: string[];
  whole: boolean;
  readBytes: number;
  // The byte offset in the file where the first of `lines` begins.
  offset?: number;
  cursor?: BackwardLineCursor;
}

export interface MetadataCoverage {
  whole: boolean;
  windowBytes: number;
}

export function fileIdentityValue(value: unknown, positive = false): boolean {
  return typeof value === 'string'
    ? (positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/).test(value)
    : typeof value === 'number' && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

export function supportedFileIdentity(value: { dev?: unknown; ino?: unknown }): boolean {
  return fileIdentityValue(value.dev) && fileIdentityValue(value.ino, true);
}

function sameFileRevision(snapshot: fs.Stats | fs.BigIntStats, revision: FileRevision): boolean {
  const stat = revisionOf(snapshot);
  return (
    stat.size === revision.size &&
    stat.mtimeMs === revision.mtimeMs &&
    stat.dev === revision.dev &&
    stat.ino === revision.ino
  );
}

export function tailOf(file: string, bytes: number, keepCursor = false): TailRead {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const stat = revisionOf(fs.fstatSync(fd, { bigint: true }));
    const size = stat.size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    const read = meterRead(file, fs.readSync(fd, buf, 0, len, start), start);
    const body = buf.subarray(0, read);
    const lines = body.toString('utf8').split('\n');
    if (start > 0) {
      lines.shift();
    }
    const firstNewline = body.indexOf(0x0a);
    const fragment = firstNewline < 0 ? body : body.subarray(0, firstNewline);
    return {
      lines,
      whole: start === 0 && read === len,
      success: read === len && sameFileRevision(fs.fstatSync(fd, { bigint: true }), stat),
      readBytes: body.length,
      offset: start === 0 ? 0 : start + (firstNewline < 0 ? body.length : firstNewline + 1),
      ...(keepCursor && start > 0
        ? {
            cursor: {
              revision: stat,
              end: start,
              fragment: Buffer.from(fragment),
            },
          }
        : {}),
    };
  } catch {
    return { lines: [], whole: false, readBytes: 0 };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function readBackwardRange(file: string, start: number, length: number, revision: FileRevision): Buffer | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    if (!sameFileRevision(fs.fstatSync(fd, { bigint: true }), revision)) {
      return null;
    }
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const next = meterRead(file, fs.readSync(fd, buffer, read, length - read, start + read), start + read);
      if (next <= 0) {
        return null;
      }
      read += next;
    }
    if (!sameFileRevision(fs.fstatSync(fd, { bigint: true }), revision)) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Reads the next disjoint range before a tail window and reconstructs every JSONL record
// completed by that range. The cursor owns the only fragment carried across ranges, so a
// record and a UTF-8 character split at either edge are decoded only after they are whole.
export function readPreviousLines(
  file: string,
  cursor: BackwardLineCursor,
  bytes: number,
  readRange: BackwardRangeReader = readBackwardRange,
  maxRecordBytes?: number,
): BackwardLineBatch | null {
  const length = Math.min(Math.max(1, bytes), cursor.end);
  const start = cursor.end - length;
  const chunk = readRange(file, start, length, cursor.revision);
  if (!chunk || chunk.length !== length) {
    return null;
  }

  if (maxRecordBytes !== undefined) {
    const cap = Math.max(1, maxRecordBytes);
    const lines: BackwardLine[] = [];
    let fragment = cursor.fragment.subarray(0, cap);
    let discarded = cursor.discardedFragment === true || cursor.fragment.length > cap;
    let end = chunk.length;
    while (end > 0) {
      const newline = chunk.lastIndexOf(0x0a, end - 1);
      const piece = chunk.subarray(newline + 1, end);
      const oversized = discarded || piece.length + fragment.length > cap;
      const prefix =
        piece.length >= cap
          ? Buffer.from(piece.subarray(0, cap))
          : Buffer.concat([piece, fragment.subarray(0, cap - piece.length)]);
      if (newline < 0 && start > 0) {
        fragment = prefix;
        discarded = oversized;
        break;
      }
      lines.push({
        offset: start + newline + 1,
        text: prefix.toString('utf8'),
        ...(oversized ? { oversized: true } : {}),
      });
      fragment = Buffer.alloc(0);
      discarded = false;
      if (newline < 0) break;
      end = newline;
    }
    return {
      lines,
      cursor: {
        revision: cursor.revision,
        end: start,
        fragment: start > 0 ? fragment : Buffer.alloc(0),
        discardedFragment: start > 0 && discarded,
      },
    };
  }

  // The synthetic newline closes the fragment whose real newline was consumed by the
  // newer tail. It never becomes part of a returned line.
  const joined = Buffer.concat([chunk, cursor.fragment, Buffer.from('\n')]);
  const firstNewline = joined.indexOf(0x0a);
  const inspectFrom = start === 0 ? 0 : firstNewline + 1;
  const lines: BackwardLine[] = [];
  let lineStart = inspectFrom;
  while (lineStart < joined.length) {
    const newline = joined.indexOf(0x0a, lineStart);
    if (newline < 0) {
      break;
    }
    lines.push({ offset: start + lineStart, text: joined.subarray(lineStart, newline).toString('utf8') });
    lineStart = newline + 1;
  }
  lines.reverse();
  return {
    lines,
    cursor: {
      revision: cursor.revision,
      end: start,
      fragment: start > 0 ? Buffer.from(joined.subarray(0, firstNewline)) : Buffer.alloc(0),
    },
  };
}

// Finds one source-defined turn boundary without making a single read grow with the file.
// The final parse still starts at the boundary and runs through the current file end, but
// discovery itself yields between disjoint chunks so input and cancellation can run.
export async function discoverBackwardBoundary(
  file: string,
  initial: BackwardLineCursor,
  boundary: (line: BackwardLine) => boolean,
  options: BoundaryDiscoveryOptions = {},
): Promise<BoundaryDiscovery> {
  const chunkBytes = Math.max(1, options.chunkBytes ?? TURN_START_BYTES);
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let cursor = initial;
  while (cursor.end > 0) {
    if (options.signal?.aborted) {
      return { kind: 'cancelled' };
    }
    const batch = readPreviousLines(file, cursor, chunkBytes, options.readRange);
    if (!batch) {
      return { kind: 'stale' };
    }
    for (const line of batch.lines) {
      if (boundary(line)) {
        const start = line.offset > 0 ? line.offset - 1 : 0;
        return { kind: 'found', readBytes: initial.revision.size - start };
      }
    }
    cursor = batch.cursor;
    if (cursor.end === 0) {
      return { kind: 'beginning' };
    }
    await pause();
  }
  return { kind: 'beginning' };
}

// Prompt wrappers removed from displayed text.
// Command name and argument tags remain outside this list so their contents survive prompt cleaning.
const WRAPPED =
  /<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder|local-command-stdout|local-command-caveat|command-message|command-contents|task-notification)>[\s\S]*?<\/\1>/g;

// Session-setting commands excluded from typed work prompts.
// Unknown command names remain eligible as work, including reader-invoked skills.
const HARNESS_COMMANDS = new Set(['/clear', '/compact', '/config', '/context', '/effort', '/model', '/plugin']);

const COMMAND_NAMED = /<command-name>\s*(\/[^\s<]*)/;
const COMMAND_SCAFFOLD = /<(command-name|command-args)>[\s\S]*?<\/\1>/g;

// Command name and arguments joined with one space to match submitted prompt text.
// Newlines inside arguments remain unchanged.
const COMMAND_INVOCATION = /<command-name>\s*([^<]*?)\s*<\/command-name>\s*<command-args>([\s\S]*?)<\/command-args>/g;

const COMMAND_NAME = /<command-name>\s*(\/[^\s<]*)\s*<\/command-name>/g;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/g;
const COMMAND_STDERR = /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g;

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((b) => b && (b as { type?: string }).type === 'text')
    .map((b) => (b as { text?: string }).text || '')
    .join('\n');
}

// Removes provider scaffolding. Literal capture retains the remaining user text and its whitespace.
function extractPrompt(raw: string, literal = false): string {
  const remove = (text: string, pattern: RegExp): string => {
    if (!literal) {
      return text.replace(pattern, ' ');
    }
    let body = '';
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      const at = match.index;
      body += text.slice(start, at);
      start = at + match[0].length;
      // A standalone wrapper's next line starts the submitted body or another wrapper.
      if (at === 0 || text[at - 1] === '\n') {
        if (text.startsWith('\r\n', start)) start += 2;
        else if (text[start] === '\n') start++;
      }
    }
    return body + text.slice(start);
  };
  const named = COMMAND_NAMED.exec(raw);
  const body = named && HARNESS_COMMANDS.has(named[1]) ? remove(raw, COMMAND_SCAFFOLD) : raw;
  const extracted = remove(body, WRAPPED).replace(COMMAND_INVOCATION, (_all, name: string, args: string) =>
    literal && !args ? name : `${name} ${args}`,
  );
  return literal
    ? remove(extracted, COMMAND_STDERR).replace(COMMAND_NAME, '$1').replace(COMMAND_ARGS, '$1')
    : extracted;
}

// Removes prompt wrappers and tag syntax while preserving line structure. Multiple blank lines collapse to one blank line.
export function cleanPrompt(raw: string): string {
  return extractPrompt(raw)
    .replace(/<\/?[a-z][a-z0-9-]{0,38}>/gi, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Reader-queued prompt with prompt mode and no peer origin. Missing origin remains eligible.
export function isReaderQueued(attachment: Record<string, unknown> | null | undefined): boolean {
  if (!attachment || attachment.type !== 'queued_command') {
    return false;
  }
  if (attachment.commandMode !== 'prompt') {
    return false;
  }
  const origin = attachment.origin;
  // Missing origin remains eligible. Present origins require an object with a string kind other than `peer`.
  if (origin === undefined || origin === null) {
    return true;
  }
  if (typeof origin !== 'object' || Array.isArray(origin)) {
    return false;
  }
  const kind = (origin as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind !== 'peer';
}

// The words and time of a prompt the reader queued, or null for any other record. The full
// reader, the rail and the usage index all take a queued prompt by this one rule.
function readerQueuedAsk(
  record: Record<string, unknown>,
  captureSessionText = false,
): { text: string; at: number } | null {
  if (record.type !== 'attachment') {
    return null;
  }
  const attachment = record.attachment as Record<string, unknown> | undefined;
  if (!isReaderQueued(attachment)) {
    return null;
  }
  const raw = textOf(attachment?.prompt);
  const text = cleanPrompt(raw);
  return text
    ? {
        text: captureSessionText ? extractPrompt(raw, true) : text,
        at: stamp(attachment?.timestamp ?? record.timestamp),
      }
    : null;
}

// Reads terminal task identities from Claude user notices and queued task notifications.
export function claudeTaskNotification(
  record: Record<string, unknown>,
): { toolId: string; taskId: string; status: string } | null {
  const notice = taskNotificationText(record);
  if (notice === null) return null;
  const tags = (name: string) => {
    const occurrences = [...notice.matchAll(new RegExp(`</?${name}(?=[^a-zA-Z0-9_-]|$)[^>]*(?:>|$)`, 'g'))];
    if (occurrences.length !== 2 || occurrences[0][0] !== `<${name}>` || occurrences[1][0] !== `</${name}>`) return [];
    const value = new RegExp(`<${name}>([^<>]+)</${name}>`).exec(notice)?.[1];
    return value?.trim() ? [value] : [];
  };
  const statuses = tags('status'),
    tools = tags('tool-use-id'),
    tasks = tags('task-id');
  if (
    statuses.length !== 1 ||
    !['completed', 'failed', 'killed'].includes(statuses[0]) ||
    tools.length !== 1 ||
    tasks.length !== 1 ||
    !/^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(notice) ||
    (notice.match(/<task-notification>/g)?.length ?? 0) !== 1 ||
    (notice.match(/<\/task-notification>/g)?.length ?? 0) !== 1
  )
    return null;
  return { toolId: tools[0], taskId: tasks[0], status: statuses[0] };
}

// Raw task-notification text from a user record's content or a queued attachment's prompt.
// The origin or command mode must identify a task notification.
export function taskNotificationText(record: Record<string, unknown> | null | undefined): string | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }
  if (record.type === 'user') {
    const origin = record.origin as { kind?: unknown } | undefined;
    if (!origin || origin.kind !== 'task-notification') {
      return null;
    }
    return noticeTags((record.message as { content?: unknown } | undefined)?.content);
  }
  if (record.type === 'attachment') {
    const attachment = record.attachment as Record<string, unknown> | undefined;
    if (!attachment || attachment.type !== 'queued_command') {
      return null;
    }
    if (attachment.commandMode !== 'task-notification') {
      return null;
    }
    return noticeTags(attachment.prompt);
  }
  return null;
}

// Retains text blocks or serializes other notice content so tag readers can inspect it.
function noticeTags(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  const text = textOf(content);
  if (text) {
    return text;
  }
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content) ?? '';
    } catch {
      return '';
    }
  }
  return String(content);
}

// When a record happened. An attachment carries a clock of its own, and the line that holds
// it carries another.
function claudeRecordAt(record: Record<string, unknown>): number {
  const attachment = record.attachment as { timestamp?: unknown } | undefined;
  if (record.type === 'attachment' && attachment && attachment.timestamp) {
    return stamp(attachment.timestamp);
  }
  return stamp(record.timestamp);
}

//

// An emphasis run: not opened mid-word, not empty, not holding its own marker, and not
// closed against a space. The tripled marker is matched before the doubled one and the
// doubled one before the single one, so `***x***` is strong-in-em rather than a stray `*`
// next to a failed `**x**`.
const TRIPLE_STAR = /(?<![\w*])\*\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*\*(?![\w*])/g;
const STRONG_STAR = /(?<![\w*])\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*(?![\w*])/g;
const EM_STAR = /(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g;
const TRIPLE_LOW = /(?<![\w_])___(?!\s)([^_\n]+?)(?<!\s)___(?![\w_])/g;
const STRONG_LOW = /(?<![\w_])__(?!\s)([^_\n]+?)(?<!\s)__(?![\w_])/g;
const EM_LOW = /(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g;
// A link or an image, the target's parentheses written plain or escaped: `[text](x)` and
// `[text]\(x)` both show `text`. The image first, or its `!` is left behind.
const IMAGE = /!\[([^\]\n]*)\]\\?\(([^()\n]*)\\?\)/g;
const LINK = /\[([^\]\n]*)\]\\?\(([^()\n]*)\\?\)/g;

// One pass of the GFM rule above: a snake_case word keeps its underscores, `**bold**`,
// `*em*` and `_em_` lose their markers, and a lone `*` such as the one in "2 * 3" is left
// where it stands. A run's content excludes its own marker character, so one pass cannot
// see an emphasis nested inside another one that shares a marker, such as the `*em*` inside
// `**bold *em* inside**`: the inner run has to come off first before the outer content reads
// as marker-free.
function stripEmphasisMarkersOnce(text: string): string {
  return text
    .replace(TRIPLE_STAR, '$1')
    .replace(TRIPLE_LOW, '$1')
    .replace(STRONG_STAR, '$1')
    .replace(EM_STAR, '$1')
    .replace(STRONG_LOW, '$1')
    .replace(EM_LOW, '$1');
}

// Repeats emphasis removal until the text stops changing, including nested runs that share a marker.
function stripEmphasisMarkers(text: string): string {
  let current = text;
  for (;;) {
    const next = stripEmphasisMarkersOnce(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
}

function plainTitlePiece(text: string): string {
  return stripEmphasisMarkers(text.replace(IMAGE, '$1').replace(LINK, '$1'));
}

// Transforms text outside balanced code spans. Code-span contents stay literal while their delimiting backticks are removed.
// Title and headline readers supply different transforms.
function withCodeSpansPreserved(line: string, transform: (piece: string) => string): string {
  return line
    .split(/(`[^`\n]+`)/g)
    .map((piece, i) => (i % 2 ? piece.slice(1, -1) : transform(piece)))
    .join('');
}

export function plainTitle(line: string): string {
  return withCodeSpansPreserved(line, plainTitlePiece);
}

// Short plain-text session title after removing rich content, normalizing Markdown, and flattening whitespace.
export function normalizeSessionTitle(text: string | null | undefined): string | null {
  const full = normalizeFullSessionTitle(text);
  return full ? shortenTo(full, 60, '...') : null;
}

// Unshortened plain-text title used by rename and Details. Session-list display applies its own separate bound.
export function normalizeFullSessionTitle(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const flat = plainTitle(withoutRichContent(text)).replace(/\s+/g, ' ').trim();
  return flat || null;
}

// Headings the user's summary format opens with. They name a section rather than state
// an outcome, so the headline is the line after them.
const SECTION_ONLY = /^(tl;?dr|summary|result|results|outcome|status|overview)[:.]?$/i;

const BULLET = /^[\s>]*[-*+]\s+/;
const ORDERED = /^\s*\d+\.\s+/;
// A line set in under the item above it: one item's line wrapped, or an item nested under
// it. It belongs to that item, so it is not the end of the list it sits in.
const CONTINUATION = /^\s+\S/;

// Fence markers are omitted while reading opening-list content.
const FENCE = /^\s*(```|~~~)/;

// Removes structural Markdown at the raw line start, before splitting code spans.
function stripStructuralMarkdown(line: string): string {
  return line
    .replace(BULLET, '') // bullet
    .replace(/^#{1,6}\s*/, '') // heading
    .replace(/^\s*\d+\.\s+/, ''); // ordered item
}

// Removes inline markup after structural markers. Escaped lines use the Markdown renderer.
// Other lines remove emphasis and unmatched backticks while keeping balanced code spans literal.
function stripInlineMarkdown(line: string): string {
  // Markdown escapes retain their meaning inside emphasis and link labels. Code spans remain literal.
  if (line.includes('\\')) return visibleTextOf(renderInlineMarkdown(line)).trim();
  const withLinkText = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // link text
  return withCodeSpansPreserved(withLinkText, (piece) => stripEmphasisMarkers(piece).replace(/`/g, '')).trim();
}

function stripMarkdown(line: string): string {
  return stripInlineMarkdown(stripStructuralMarkdown(line));
}

// Selects the first content-bearing summary line and retains its fenced-code context.
export type HeadlineSource = { text: string; fenced: boolean };

export function headlineSourceOf(summary: string): HeadlineSource | null {
  const blocks = markdownCodeBlocks(summary);
  let blockIndex = 0;
  let offset = 0;
  for (const raw of summary.split('\n')) {
    const start = offset;
    offset += raw.length + 1;
    while (blocks[blockIndex]?.end <= start) blockIndex += 1;
    const block = blocks[blockIndex];
    if (block && block.start < offset && block.end > start) {
      const text = block.text
        .split('\n')
        .find((line) => line.trim())
        ?.trim();
      if (text) return { text, fenced: true };
      continue;
    }
    const structural = stripStructuralMarkdown(raw);
    const plain = stripInlineMarkdown(structural);
    if (!plain || SECTION_ONLY.test(plain)) {
      continue;
    }
    return { text: structural, fenced: false };
  }
  return null;
}

// The one line that says what the turn did: the first line of the summary that carries
// content rather than naming a section. A caller that already selected the source from the
// same summary passes it in, and a selected null is a valid result that skips selecting again.
export function headlineOf(summary: string, source: HeadlineSource | null = headlineSourceOf(summary)): string {
  return source === null ? '' : source.fenced ? source.text : stripInlineMarkdown(source.text);
}

// Same headline line with inline Markdown retained for folded-card rendering.
export function headlineMarkdownOf(summary: string): string {
  return headlineSourceOf(summary)?.text.trim() ?? '';
}

// Plain-text items in the summary's opening list, ending before its later sections.
export function openingLines(summary: string): string[] {
  const lines: string[] = [];
  for (const raw of summary.split('\n')) {
    if (FENCE.test(raw)) {
      continue;
    }
    const stripped = stripMarkdown(raw);
    if (!stripped || SECTION_ONLY.test(stripped)) {
      // Blank lines and the heading above the list are what the list opens after. Once it
      // has started, either one is the end of it.
      if (lines.length) {
        break;
      }
      continue;
    }
    if (BULLET.test(raw) || ORDERED.test(raw)) {
      lines.push(stripped);
      continue;
    }
    // Ignore continuation lines without ending the opening list.
    if (lines.length && CONTINUATION.test(raw)) {
      continue;
    }
    break;
  }
  return lines;
}

// Closing action and question text, or null when absent.
// Named rows support inline text and following lists. A Waiting on you section supplies `actions` and clears `questions`.
// The card separately identifies placeholder text with no waiting state.
export interface ClosingRows {
  actions: string | null;
  questions: string | null;
}

// Named closing rows begin at the line start after nonletter decoration.
// Inline text requires a colon or a spaced dash, avoiding the hyphen within "follow-ups".
const CLOSING_ROW_NAME = {
  actions: /^[^\p{L}]*your actions\b/iu,
  questions: /^[^\p{L}]*open questions\b/iu,
};

// The text of a row written as one line, taken from whatever follows its name.
const ROW_TEXT = /^[^:\n]{0,30}?(?::|\s[–—-])\s+(.+)$/u;

// Maximum qualifier length after a named heading without inline text. Longer prose does not introduce a following list.
const ROW_QUALIFIER = 20;

// Bold Waiting on you label for a following list, with an optional colon inside or outside the bold markers.
// Match raw Markdown so ordinary prose with the same words remains distinct.
const WAITING_LABEL = /^\*\*waiting on you:?\*\*:?$/i;

export function closingRows(summary: string): ClosingRows {
  const found: ClosingRows = { actions: null, questions: null };
  const lines = summary.split('\n');
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    if (WAITING_LABEL.test(lines[i].trim())) {
      const section = waitingSection(lines, i);
      // Accept only a nonempty waiting list. It replaces earlier action text and clears earlier question text.
      if (section) {
        found.actions = section.text;
        found.questions = null;
        i = section.end;
      }
      continue;
    }
    const line = stripMarkdown(lines[i]);
    for (const name of Object.keys(CLOSING_ROW_NAME) as (keyof ClosingRows)[]) {
      const text = rowTextAt(name, line, lines, i);
      // The last nonempty matching row wins. Empty matches preserve earlier text.
      if (text) {
        found[name] = text;
      }
    }
  }
  return found;
}

// What the named row on this line holds, from the line itself or from the list under it.
function rowTextAt(name: keyof ClosingRows, line: string, lines: string[], i: number): string | null {
  const hit = CLOSING_ROW_NAME[name].exec(line);
  if (!hit) {
    return null;
  }
  const rest = line.slice(hit[0].length);
  const inline = ROW_TEXT.exec(rest);
  if (inline) {
    return joinWrapped(inline[1], lines, i);
  }
  return rest.trim().length <= ROW_QUALIFIER ? listUnder(lines, i) : null;
}

// Recognizes inline and heading rows using the same shapes as `rowTextAt`, to end the preceding list.
function startsARow(line: string): boolean {
  const text = stripMarkdown(line);
  return Object.values(CLOSING_ROW_NAME).some((name) => {
    const hit = name.exec(text);
    if (!hit) {
      return false;
    }
    const rest = text.slice(hit[0].length);
    return ROW_TEXT.test(rest) || rest.trim().length <= ROW_QUALIFIER;
  });
}

// Reads list text under a named heading. Inline rows are read separately.
function listUnder(lines: string[], from: number): string | null {
  const parts: string[] = [];
  for (let i = from + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    // Skip blank lines before the first item. A blank line after an item ends the list.
    if (!raw.trim()) {
      if (parts.length) {
        break;
      } else {
        continue;
      }
    }
    if (!BULLET.test(raw) && !ORDERED.test(raw) && !CONTINUATION.test(raw)) {
      break;
    }
    // A following named row ends this list even when it has a bullet marker.
    if (startsARow(raw)) {
      break;
    }
    const text = stripMarkdown(raw);
    if (text) {
      parts.push(text);
    }
  }
  return parts.length ? parts.join(' ') : null;
}

// Reads a Waiting on you list and returns its text and last consumed line.
// Blank lines remain allowed. A named row or nonitem ends the section.
function waitingSection(lines: string[], from: number): { text: string; end: number } | null {
  const parts: string[] = [];
  let end = from;
  for (let i = from + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) {
      continue;
    }
    if (startsARow(raw)) {
      break;
    }
    // Accept bullet and numbered items. Append indented continuation text to the preceding item.
    if (BULLET.test(raw) || ORDERED.test(raw)) {
      const text = stripMarkdown(raw);
      if (text) {
        parts.push(text);
        end = i;
      }
      continue;
    }
    if (CONTINUATION.test(raw) && parts.length) {
      const text = stripMarkdown(raw);
      if (text) {
        parts[parts.length - 1] += ` ${text}`;
        end = i;
      }
      continue;
    }
    break;
  }
  return parts.length ? { text: parts.join('\n'), end } : null;
}

// Joins a row's indented continuation lines with spaces.
function joinWrapped(first: string, lines: string[], from: number): string {
  const parts = [first.trim()];
  for (let i = from + 1; i < lines.length; i += 1) {
    if (!CONTINUATION.test(lines[i])) {
      break;
    }
    const more = stripMarkdown(lines[i]);
    if (more) {
      parts.push(more);
    }
  }
  return parts.join(' ');
}

// Claude continuation preamble removed before displaying retained compaction text.
const COMPACT_PREAMBLE = /^[\s\S]{0,400}?covers the earlier portion of the conversation\.\s*(?:Summary:)?\s*/;

export function stripCompactPreamble(text: string): string {
  return text.replace(COMPACT_PREAMBLE, '').trim();
}

// The harness records a stop as a user message. It ends the turn's work but does not
// begin a new one, so it must not be read as a prompt.
const INTERRUPTED = /^\[Request interrupted by user/;

function isTypedPrompt(o: Record<string, unknown>, childTranscript = false): boolean {
  if ((o.isSidechain && !childTranscript) || o.isMeta || o.isCompactSummary) {
    return false;
  }
  const origin = o.origin as { kind?: string } | undefined;
  if (origin && origin.kind === 'task-notification') {
    return false;
  }
  const content = (o.message as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content) && content.some((b) => b && (b as { type?: string }).type === 'tool_result')) {
    return false;
  }
  const raw = textOf(content);
  // The CLI's own answer to a command, such as a stderr element alone, is no prompt.
  if (localCommandOutputOnly(raw.trim())) {
    return false;
  }
  const text = cleanPrompt(raw);
  return text.length > 0 && !INTERRUPTED.test(text);
}

// Which kind of work a tool call is, for the turn's tool mix.
export const TOOL_KIND: Readonly<Record<string, keyof ToolCounts>> = {
  Edit: 'edits',
  Write: 'edits',
  MultiEdit: 'edits',
  NotebookEdit: 'edits',
  Read: 'reads',
  NotebookRead: 'reads',
  Grep: 'searches',
  Glob: 'searches',
  Bash: 'commands',
  PowerShell: 'commands',
  Agent: 'agents',
  Task: 'agents',
  Workflow: 'agents',
  SendMessage: 'coordination',
  SubagentHandback: 'coordination',
  ListAgents: 'coordination',
  TaskOutput: 'coordination',
  TaskStop: 'coordination',
  WebFetch: 'web',
  WebSearch: 'web',
};

function emptyToolCounts(): ToolCounts {
  return { edits: 0, reads: 0, searches: 0, commands: 0, agents: 0, coordination: 0, web: 0, other: 0 };
}

export function tallyToolName(tally: Record<string, number>, name: string): void {
  if (Object.prototype.hasOwnProperty.call(tally, name)) {
    tally[name]++;
    return;
  }
  // Tool names are supplied by the agent and can be names inherited from Object.prototype.
  // Defining the property directly keeps `constructor`, `toString` and `__proto__` as
  // ordinary enumerable rows without changing every Turn tally to a null-prototype object.
  Object.defineProperty(tally, name, {
    value: 1,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// Shell command and its starting working directory, taken from the tool-call record rather than its result.
export interface CommandCall {
  id?: string; // source tool call id, when the reader records one
  command: string;
  shell?: ClaudeShellDialect;
  cwd: string | null;
  at: number; // epoch ms of the record that issued the call, which opens its window
}

// Command evidence for reading printed commits.
// A readable call constrains eligibility. `null` rejects output with no paired command.
// `unreadable` permits output inspection when command pairing is unavailable.
export type CommitCall = CommandCall | null | 'unreadable';

// Nonoperator filler for masked quoted text and heredoc bodies.
const FILL = '\u0001';

// Same-length command copy with quoted text and heredoc bodies masked. Original indexes still identify path text.
// Quoted command substitutions retain their nested script boundaries.
// Heredoc bodies follow the next script newline in opener order and end at their delimiters or command end.
// `<<-` allows leading delimiter tabs. Arithmetic shifts and `<<<` do not open heredocs.
// Launch discovery also tracks comments, parameter expansions, and conditional operands.
function maskQuoted(command: string, shell?: ClaudeShellDialect): string {
  const launchSyntax = shell !== undefined;
  const out = command.split('');
  const open: { kind: string; word: boolean }[] = [];
  let word = false;
  let headWord: string | null = '';
  let timeOptions: 'portable' | 'end' | null = null;
  let quotes = 0;
  let pending: { delim: string; tabs: boolean }[] = [];
  let backtick: { end: number; depth: number; quotes: number; pending: typeof pending } | undefined;
  // The end of the line a here-string opener sits on, and the last character on that line
  // that is not whitespace. Each is found once per line, so many openers on one line cost
  // one read of that line.
  let eol = -1;
  let ink = -1;
  const mask = (from: number, to: number): void => {
    for (let p = from; p < to; p++) {
      out[p] = FILL;
    }
  };
  // Masks `[at, to)` when a quote encloses it, and returns `to`.
  const pass = (at: number, to: number): number => {
    to = Math.min(to, backtick?.end ?? command.length);
    if (quotes > 0) {
      mask(at, to);
    }
    return to;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    // Bash finds the substitution's closing backtick before parsing its inner script.
    if (backtick?.end === i) {
      open.length = backtick.depth;
      quotes = backtick.quotes;
      pending = backtick.pending;
      out[i] = quotes > 0 ? FILL : ')';
      word = true;
      headWord = null;
      timeOptions = null;
      backtick = undefined;
      i++;
      continue;
    }
    const top = open[open.length - 1]?.kind;
    const arithmetic = top === '$((' || top === 'arith(';
    if (shell === 'bash' && c === '`' && top !== "'" && !arithmetic) {
      let end = i + 1;
      while (end < command.length && command[end] !== '`') {
        end += command[end] === '\\' ? 2 : 1;
      }
      if (end >= command.length) return FILL.repeat(command.length);
      backtick = { end, depth: open.length, quotes, pending };
      pending = [];
      open.push({ kind: '`', word: true });
      out[i] = quotes > 0 ? FILL : '(';
      word = false;
      headWord = '';
      timeOptions = null;
      i++;
      continue;
    }
    if (launchSyntax && quotes === 0) {
      // Parameter text and conditional patterns need no extglob option. Nested scripts do.
      if (
        shell === 'bash' &&
        !arithmetic &&
        top !== '${' &&
        top !== '[[' &&
        /[@?!+*]/.test(c) &&
        command[i + 1] === '('
      ) {
        return FILL.repeat(command.length);
      }
      // Comments contribute neither flags nor command boundaries to launch discovery.
      // A hash inside a parameter expansion or an existing word remains literal.
      const block = shell === 'powershell' && top !== '${' && !arithmetic && command.startsWith('<#', i);
      if (block || (c === '#' && !word && top !== '${' && !arithmetic)) {
        let close: number;
        if (block) close = command.indexOf('#>', i + 2);
        else if (backtick) {
          close = i + 1;
          while (close < backtick.end && command[close] !== '\n') close++;
        } else close = command.indexOf('\n', i + 1);
        const end = close < 0 ? command.length : close + (block ? 2 : 0);
        mask(i, end);
        i = end;
        continue;
      }
      // PowerShell escaped parentheses cannot open or close an argument expression.
      if (shell === 'powershell' && c === '`' && /[()]/.test(command[i + 1] ?? '')) {
        mask(i, i + 2);
        word = true;
        i += 2;
        continue;
      }
    }
    if (top === "'" || top === '"') {
      if (c === top) {
        word = open.pop()!.word;
        quotes--;
        i = pass(i, i + 1);
      } else if (top === '"' && c === '\\' && shell !== 'powershell') {
        mask(i, Math.min(i + 2, command.length));
        i += 2;
      } else if (top === '"' && command.startsWith('$(', i)) {
        const arithmetic = command[i + 2] === '(';
        open.push({ kind: arithmetic ? '$((' : '$(', word: true });
        word = false;
        headWord = '';
        timeOptions = null;
        i = pass(i, i + (arithmetic ? 3 : 2));
      } else {
        out[i] = FILL;
        i++;
      }
      continue;
    }
    if (c === '\\' && shell !== 'powershell') {
      if (command[i + 1] !== '\n') {
        word = true;
        headWord = null;
        timeOptions = null;
      }
      i = pass(i, Math.min(i + 2, command.length));
      continue;
    }
    if (c === '"' || c === "'") {
      i = pass(i, i + 1);
      open.push({ kind: c, word: true });
      word = true;
      headWord = null;
      timeOptions = null;
      quotes++;
      continue;
    }
    if (command.startsWith('$(', i)) {
      const arithmetic = command[i + 2] === '(';
      open.push({ kind: arithmetic ? '$((' : '$(', word: true });
      word = false;
      headWord = '';
      timeOptions = null;
      i = pass(i, i + (arithmetic ? 3 : 2));
      continue;
    }
    if (shell === 'bash' && !arithmetic && command.startsWith('((', i) && top !== '${' && top !== '[[') {
      open.push({ kind: '$((', word: false });
      word = false;
      headWord = null;
      timeOptions = null;
      i += 2;
      continue;
    }
    if (launchSyntax && command.startsWith('${', i)) {
      open.push({ kind: '${', word: true });
      word = true;
      headWord = null;
      timeOptions = null;
      if (shell === 'bash') mask(i, i + 2);
      i += 2;
      continue;
    }
    if (launchSyntax && c === '}' && top === '${') {
      word = open.pop()!.word;
      if (shell === 'bash') out[i] = FILL;
      i++;
      continue;
    }
    if (
      shell === 'bash' &&
      !arithmetic &&
      top !== '${' &&
      top !== '[[' &&
      headWord === '' &&
      command.startsWith('[[', i) &&
      /\s|^$/.test(command[i + 2] ?? '')
    ) {
      open.push({ kind: '[[', word: false });
      mask(i, i + 2);
      headWord = null;
      timeOptions = null;
      i += 2;
      continue;
    }
    if (
      shell === 'bash' &&
      top === '[[' &&
      !word &&
      command.startsWith(']]', i) &&
      /[\s;|&)]|^$/.test(command[i + 2] ?? '')
    ) {
      word = open.pop()!.word;
      mask(i, i + 2);
      i += 2;
      continue;
    }
    // Literal expansion text and conditional operands contain no shell commands.
    // Substitutions opened above read their own script before returning to this frame.
    if (shell === 'bash' && (top === '${' || top === '[[')) {
      out[i] = FILL;
      if (top === '[[') word = !/\s/.test(c);
      i++;
      continue;
    }
    if (shell === 'powershell' && c === '{' && !word && top !== '${') {
      open.push({ kind: '{', word: false });
      i++;
      continue;
    }
    if (shell === 'powershell' && c === '}' && top === '{') {
      word = open.pop()!.word;
      i++;
      continue;
    }
    // A parenthesis inside arithmetic groups a sum, so everything inside it is arithmetic too.
    if (c === '(' && top !== '${' && (open.length > 0 || launchSyntax)) {
      const process = launchSyntax && /[<>]/.test(command[i - 1] ?? '');
      open.push({ kind: arithmetic ? 'arith(' : '(', word: process });
      word = false;
      headWord = '';
      timeOptions = null;
      i = pass(i, i + 1);
      continue;
    }
    if (c === ')' && top !== '${' && open.length > 0) {
      const closes = top === '$((' && command[i + 1] === ')' ? 2 : 1;
      word = open.pop()!.word;
      headWord = null;
      timeOptions = null;
      i = pass(i, i + closes);
      continue;
    }
    if (arithmetic) {
      i = pass(i, i + 1);
      continue;
    }
    // PowerShell here-string openers require only whitespace before the newline. Terminators begin a line with the quote and `@`.
    // Mask the body and terminator so their contents cannot supply later command boundaries.
    if (
      c === '@' &&
      (open.length === 0 || (launchSyntax && top !== '${')) &&
      (command[i + 1] === "'" || command[i + 1] === '"')
    ) {
      if (eol < i) {
        const nl = command.indexOf('\n', i);
        eol = Math.min(nl < 0 ? command.length : nl, backtick?.end ?? command.length);
        ink = eol - 1;
        while (ink > i && /\s/.test(command[ink])) {
          ink--;
        }
      }
      const boundary = backtick?.end ?? command.length;
      if (eol < boundary && ink === i + 1) {
        // With no terminator anywhere the body runs to the end of the command, which is the
        // answer a heredoc gives for the same shape.
        const term = command[i + 1] + '@';
        let end = boundary;
        let k = eol;
        while (k >= 0 && k < boundary) {
          if (k + 3 <= boundary && command.startsWith(term, k + 1)) {
            end = k + 3;
            break;
          }
          k = command.indexOf('\n', k + 1);
        }
        mask(i, end);
        i = end;
        continue;
      }
    }
    if (c === '<' && command[i + 1] === '<') {
      if (command[i + 2] === '<') {
        i = pass(i, i + 3);
        continue;
      }
      const heredoc = heredocOpener(command, i, backtick?.end);
      if (heredoc.delim !== null) {
        pending.push({ delim: heredoc.delim, tabs: heredoc.tabs });
      }
      i = pass(i, heredoc.after);
      continue;
    }
    if (c === '\n' && pending.length) {
      // The body is masked with its newlines, so it cannot be split into segments of its own.
      // `k` is the newline before the next body line.
      let k = i;
      const boundary = backtick?.end ?? command.length;
      for (const { delim, tabs } of pending) {
        while (k < boundary) {
          const stop = command.indexOf('\n', k + 1);
          const end = Math.min(stop < 0 ? command.length : stop, boundary);
          const line = command.slice(k + 1, end);
          k = end;
          if ((tabs ? line.replace(/^\t+/, '') : line) === delim) {
            break;
          }
        }
      }
      pending = [];
      mask(i, k);
      i = k;
      continue;
    }
    if (launchSyntax && top !== '${') {
      if (/[\n;|&]/.test(c)) {
        headWord = '';
        timeOptions = null;
      } else if (/\s/.test(c) && headWord) {
        // Timing options belong only to a complete time token at a command head.
        if (shell === 'bash' && headWord === 'time') {
          headWord = '';
          timeOptions = 'portable';
        } else if (timeOptions && (headWord === '--' || (headWord === '-p' && timeOptions === 'portable'))) {
          timeOptions = headWord === '-p' ? 'end' : null;
          headWord = '';
        } else {
          headWord =
            /^(?:if|elif|then|while|until|do|else|!)$/.test(headWord) || (shell === 'bash' && headWord === '{')
              ? ''
              : null;
          timeOptions = null;
        }
      } else if (headWord !== null && !/\s/.test(c)) headWord += c;
      if (/[\s()|&;<>]/.test(c)) word = false;
      else if (shell === 'bash' || (c !== '{' && c !== '}')) word = true;
    }
    i = pass(i, i + 1);
  }
  return out.join('');
}

// The heredoc opener whose `<<` sits at `at`. `delim` is its delimiter word after quote
// removal, or null when no word follows. `after` is the index just past that word.
function heredocOpener(
  command: string,
  at: number,
  boundary = command.length,
): { delim: string | null; tabs: boolean; after: number } {
  let j = at + 2;
  const tabs = command[j] === '-';
  if (tabs) {
    j++;
  }
  while (j < boundary && (command[j] === ' ' || command[j] === '\t')) {
    j++;
  }
  const start = j;
  let delim = '';
  while (j < boundary && !/[\s;&|()<>]/.test(command[j])) {
    const c = command[j];
    if (c === '"' || c === "'") {
      const close = command.indexOf(c, j + 1);
      const stop = Math.min(close < 0 ? command.length : close, boundary);
      delim += command.slice(j + 1, stop);
      j = Math.min(stop + 1, boundary);
    } else if (c === '\\' && j + 1 < boundary) {
      delim += command[j + 1];
      j += 2;
    } else {
      delim += c;
      j++;
    }
  }
  return { delim: j > start ? delim : null, tabs, after: j };
}

// Segments split on unquoted logical operators, semicolons, and newlines.
// Each segment retains original text, masked text, and source offset.
function commandSegments(
  command: string,
  shell?: ClaudeShellDialect,
): { text: string; masked: string; offset: number }[] {
  const m = maskQuoted(command, shell);
  const parts: { text: string; masked: string; offset: number }[] = [];
  let start = 0;
  for (let i = 0; i < m.length; i++) {
    const two = m.slice(i, i + 2);
    let width = 0;
    if (two === '&&' || two === '||') {
      width = 2;
    } else if (m[i] === ';' || m[i] === '\n') {
      width = 1;
    }
    if (!width) {
      continue;
    }
    parts.push({ text: command.slice(start, i), masked: m.slice(start, i), offset: start });
    i += width - 1;
    start = i + 1;
  }
  parts.push({ text: command.slice(start), masked: m.slice(start), offset: start });
  return parts;
}

// Converts Git Bash, WSL, and Cygwin drive prefixes to Windows drive-absolute paths.
// Bare drive prefixes retain a slash so they do not become drive-relative paths.
function driveForm(p: string): string {
  let m = /^\/mnt\/([a-zA-Z])(\/|$)/.exec(p) || /^\/cygdrive\/([a-zA-Z])(\/|$)/.exec(p);
  if (m) {
    return m[1].toUpperCase() + ':' + (p.slice(m[0].length - (m[2] ? 1 : 0)) || '/');
  }
  m = /^\/([a-zA-Z])(\/|$)/.exec(p);
  if (m) {
    return m[1].toUpperCase() + ':' + (p.slice(2) || '/');
  }
  return p;
}

// `.` and `..` collapsed and a trailing slash dropped, keeping the case the command wrote.
function normalizeDir(p: string): string {
  const drive = /^([a-zA-Z]:)(\/.*)?$/.exec(p);
  const unc = p.startsWith('//');
  const root = drive ? drive[1] : p.startsWith('/') ? '' : null;
  const rest = drive ? drive[2] || '/' : p;
  const parts: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (!unc || parts.length > 2) {
        parts.pop();
      }
      continue;
    }
    parts.push(seg);
  }
  if (root === null) {
    return parts.join('/');
  }
  if (unc) {
    return `//${parts.join('/')}`;
  }
  return (root + '/' + parts.join('/')).replace(/\/$/, '') || root + '/';
}

// Unquoted argument escapes recognized by this path reader. Other backslashes remain path characters.
const ESCAPABLE = /[\s'"]/;

// One argument with its quotes taken off, read from the start of `rest`. The original text
// is what is read, not the masked copy, because the path itself is usually what was quoted.
function firstArg(rest: string, shell?: ClaudeShellDialect): string | null {
  const s = rest.trim();
  if (!s) {
    return null;
  }
  let out = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) {
        if (shell === 'powershell' && s[i + 1] === quote) {
          out += c;
          i++;
        } else quote = '';
      } else if (shell === 'powershell' && quote === '"' && /[$`]/.test(c)) {
        return null;
      } else {
        out += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      break;
    }
    if (shell === 'powershell' && /[$`]/.test(c)) return null;
    if (shell !== 'powershell' && c === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      out += s[++i];
      continue;
    }
    out += c;
  }
  return shell && quote ? null : out;
}

// Resolves a literal directory against the current directory and home. Unexpanded variables leave the directory unknown.
function resolveDir(arg: string, cur: string | null, homeDir: string): string | null {
  let t = arg
    .replace(/\\/g, '/')
    .replace(/^\$\{?HOME\}?(?=\/|$)/, () => homeDir)
    .replace(/^~(?=\/|$)/, () => homeDir);
  t = driveForm(t);
  if (/\$|%/.test(t)) {
    return null;
  }
  if (/^[a-zA-Z]:\//.test(t) || t.startsWith('/')) {
    return normalizeDir(t);
  }
  return cur ? normalizeDir(cur + '/' + t) : null;
}

// Directory-changing command names. Directory stacks are not tracked.
const CHANGE_DIR = /^(cd|chdir|set-location|pushd|push-location)(\s|$)/i;
// Directory-stack commands that leave the tracked directory unknown.
const UNTRACKED_DIR = /^(popd|pop-location)(\s|$)/i;

// PowerShell destination parameter names, optionally followed by a colon or equals sign.
const DIR_PARAM = /^-(?:Path|LiteralPath)(?=[\s:=]|$)/i;

// A switch in front of the destination that this reader cannot read past, which is not the
// same answer as a command naming no destination at all.
const UNREADABLE = Symbol('unreadable switch');

// Reads a directory target after recognized parameters. Unknown switches return `UNREADABLE`, distinct from an absent destination.
function moveTarget(rest: string, shell?: ClaudeShellDialect): string | null | typeof UNREADABLE {
  let s = rest.trim();
  // `-` on its own is the previous directory, which is a destination and not a switch.
  while (s.startsWith('-') && s !== '-' && !/^-\s/.test(s)) {
    const m = DIR_PARAM.exec(s);
    if (!m) {
      return UNREADABLE;
    }
    s = s.slice(m[0].length).replace(/^[:=]/, '').trim();
  }
  return firstArg(s, shell) ?? (s ? UNREADABLE : null);
}

// Git commit command with optional repeated `-C` directory arguments, matched against masked text.
const COMMIT_CALL = /(^|[\s(])git((?:\s+-C\s+\S+)*)\s+commit(?=\s|$)/g;

// A `git merge`, read the same way. A merge makes no commit of its own when it fast-forwards,
// so `commitDirs` never sees it and the call records nothing without this.
const MERGE_CALL = /(^|[\s(])git((?:\s+-C\s+\S+)*)\s+merge(?=\s|$)/g;

/**
 * Directories for recognized commit commands in call order, with null for unresolved targets.
 * `cwd` supplies the starting directory. Incomplete inspection retains an unresolved target.
 */
export function commitDirs(command: string, cwd: string | null, home: string = os.homedir()): (string | null)[] {
  const inspection = inspectCommitCommand(command, cwd, undefined, home);
  return inspection.complete || inspection.dirs.includes(null) ? inspection.dirs : [...inspection.dirs, null];
}

const NESTED_SHELL = /(?:^|[\s/'"\\])(?:bash|sh|powershell|pwsh)(?:\.exe)?['"]?\s+-/i;

export interface WorktreeRelationship {
  dir: string;
  repository: string;
}

// This accepts a constant table and a loop whose only native mutation creates each worktree.
export function worktreeRelationships(command: string, shell?: ClaudeShellDialect): WorktreeRelationship[] | null {
  if (shell !== 'powershell' || command.length > 64 * 1024) return null;
  const table = /\$(\w+)\s*=\s*@\(((@\{[^{}]*\}\s*,?\s*)+)\)/i.exec(command);
  if (!table) return null;
  const rows: Record<string, string>[] = [];
  for (const match of table[2].matchAll(/@\{([^{}]*)\}/g)) {
    const row: Record<string, string> = {};
    for (const field of match[1].split(';')) {
      const pair = /^\s*(\w+)\s*=\s*'((?:[^']|'')*)'\s*$/.exec(field);
      if (!pair || pair[1] in row) return null;
      row[pair[1]] = pair[2].replace(/''/g, "'");
    }
    if (!row.repository || rows.length >= 33) return null;
    rows.push(row);
  }
  const rest = command.slice(table.index + table[0].length);
  const loop = /^\s*foreach\s*\(\$(\w+)\s+in\s+\$(\w+)\)\s*\{/i.exec(rest);
  if (!loop || loop[2] !== table[1]) return null;
  const name = loop[1];
  let body = rest.slice(loop[0].length);
  const pathAssignment = new RegExp(
    '^\\s*\\$' + name + '\\.worktree\\s*=\\s*\\$' + name + "\\.repository\\s*\\+\\s*'((?:[^']|'')*)'\\s*(?:\\r?\\n|;)",
    'i',
  ).exec(body);
  if (!pathAssignment || !pathAssignment[1].startsWith('/')) return null;
  body = body.slice(pathAssignment[0].length);
  const branchAssignment = new RegExp(
    '^\\s*\\$' + name + "\\.branch\\s*=\\s*'((?:[^']|'')*)'\\s*(?:\\r?\\n|;)",
    'i',
  ).exec(body);
  if (branchAssignment) body = body.slice(branchAssignment[0].length);
  else if (rows.some((row) => !row.branch)) return null;
  const guard = new RegExp(
    '^\\s*if\\s*\\(\\s*\\(git\\s+-C\\s+\\$' +
      name +
      '\\.repository\\s+rev-parse\\s+HEAD\\)\\.Trim\\(\\)\\s+-ne\\s+\\$' +
      name +
      "\\.base\\s*\\)\\s*\\{\\s*throw\\s+'(?:[^']|'')*'\\s*\\}\\s*",
    'i',
  ).exec(body);
  if (guard) body = body.slice(guard[0].length);
  const creation = new RegExp(
    '^\\s*git\\s+-C\\s+\\$' +
      name +
      '\\.repository\\s+worktree\\s+add\\s+-b\\s+\\$' +
      name +
      '\\.branch\\s+\\$' +
      name +
      '\\.worktree\\s+\\$' +
      name +
      '\\.base\\s*(?:\\r?\\n|;)\\s*if\\s*\\(\\s*\\$LASTEXITCODE\\s+-ne\\s+0\\s*\\)\\s*\\{\\s*throw\\s+' +
      "'(?:[^']|'')*'" +
      '\\s*\\}\\s*\\}',
    'i',
  ).exec(body);
  if (!creation || rows.some((row) => !row.base)) return null;
  const outside = command.slice(0, table.index) + body.slice(creation[0].length);
  const dependencies = new RegExp(
    '\\$(?:' +
      table[1] +
      '|' +
      name +
      ')(?:\\.\\w+)?\\s*(?:[+*/-]?=|\\+\\+|--)|(?:Set-Variable|New-Variable|Remove-Variable|Set-Alias|Invoke-Expression|ForEach-Object|Where-Object|\\.\\s+\\$)',
    'i',
  );
  if (dependencies.test(outside) || /\b(?:while|foreach|function|trap|try|catch)\b/i.test(outside)) return null;
  const constants = new Map<string, string>();
  for (const line of outside
    .split(/\r?\n/)
    .map((one) => one.trim())
    .filter(Boolean)) {
    const constant = /^\$(\w+)\s*=\s*'((?:[^']|'')*)'$/.exec(line);
    if (constant && !constants.has(constant[1])) {
      constants.set(constant[1], constant[2].replace(/''/g, "'"));
      continue;
    }
    if (/^if\s*\(\s*\$LASTEXITCODE\s+-ne\s+0\s*\)\s*\{\s*throw\s+'(?:[^']|'')*'\s*\}$/i.test(line)) continue;
    const output =
      /^\[IO\.File\]::WriteAllText\(\$(\w+)\+'((?:[^']|'')*)',\(\$(\w+)\|ConvertTo-Json -Depth \d+\)\+"`n",\(New-Object Text\.UTF8Encoding \$false\)\)$/i.exec(
        line,
      );
    const native =
      /^(node\s+[^|]+)\|\s*Out-File\s+-LiteralPath\s+\(\$(\w+)\+'((?:[^']|'')*)'\)\s+-Encoding\s+utf8$/i.exec(line);
    let target: string | null = null;
    if (output && output[3] === table[1] && constants.has(output[1]))
      target = resolveDir(constants.get(output[1])! + output[2], null, '');
    else if (
      native &&
      literalShellWords(native[1].trim(), 'powershell') &&
      constants.has(native[2]) &&
      !ownershipMutationPaths(native[1], null, 'powershell').length
    )
      target = resolveDir(constants.get(native[2])! + native[3], null, '');
    if (
      !target ||
      rows.some((row) => {
        const root = normalizeFsPath(row.repository);
        const worktree = normalizeFsPath(row.repository + pathAssignment[1]);
        const written = normalizeFsPath(target);
        return (
          written === worktree ||
          worktree.startsWith(written + '/') ||
          written === worktree + '/.git' ||
          written.startsWith(root + '/.git')
        );
      })
    )
      return null;
  }
  const relationships = rows.map((row) => ({
    repository: resolveDir(row.repository, null, ''),
    dir: resolveDir(row.repository + pathAssignment[1].replace(/''/g, "'"), null, ''),
  }));
  return relationships.every((one) => one.repository !== null && one.dir !== null)
    ? (relationships as WorktreeRelationship[])
    : null;
}

export function ownershipMutationPaths(
  command: string,
  cwd: string | null,
  shell?: ClaudeShellDialect,
): (string | null)[] {
  const paths: (string | null)[] = [];
  const unclassified: string[] = [];
  let current = cwd;
  const creation = worktreeRelationships(command, shell);
  if (creation) return creation.map((one) => one.dir);
  const constants = new Map<string, string>();
  const segments = commandSegments(command, shell);
  const bindingsControlled =
    /\b(?:Set-Variable|New-Variable|Remove-Variable|Invoke-Expression|Set-Alias|if|foreach|while|function|try|catch)\b/i.test(
      segments.map((segment) => segment.masked).join('\n'),
    );
  if (
    shell === 'powershell' &&
    !/\b(?:Set-Variable|New-Variable|Remove-Variable|Clear-Variable|Invoke-Expression|Set-Alias)\b/i.test(command)
  ) {
    const lines = command.split(/\r?\n/);
    const firstOperation = lines.findIndex((line) => line.trim() && !/^\s*\$\w+\s*=\s*'(?:[^']|'')*'\s*$/.test(line));
    const assignments = bindingsControlled
      ? lines.slice(0, firstOperation < 0 ? lines.length : firstOperation).join('\n')
      : command;
    for (const assignment of assignments.matchAll(/^\s*\$(\w+)\s*=\s*'((?:[^']|'')*)'\s*$/gm)) {
      const name = assignment[1];
      const writes = command.match(new RegExp('\\$\\{?' + name + '\\}?\\s*(?:[+*/-]?=|\\+\\+|--)', 'gi')) ?? [];
      if (writes.length === 1) constants.set(name.toLowerCase(), assignment[2].replace(/''/g, "'"));
    }
  }
  for (const segment of segments) {
    if (CHANGE_DIR.test(segment.masked.trim()) || UNTRACKED_DIR.test(segment.masked.trim())) {
      const words = shell ? literalShellWords(segment.text.trim(), shell) : null;
      current = words && CHANGE_DIR.test(words[0]) && words.length === 2 ? resolveDir(words[1], current, '') : null;
      continue;
    }
    let literal = segment.text
      .trim()
      .replace(/\(\s*\$(\w+)\s*\+\s*'((?:[^']|'')*)'\s*\)/g, (expression, name: string, suffix: string) => {
        const root = constants.get(name.toLowerCase());
        return root === undefined ? expression : "'" + (root + suffix.replace(/''/g, "'")).replace(/'/g, "''") + "'";
      });
    let masked = segment.masked;
    const redirected = /\d*>>?\s*(.+)$/.exec(literal);
    if (redirected) {
      const words = shell ? literalShellWords(redirected[1].trim(), shell) : null;
      paths.push(words?.length === 1 ? resolveDir(words[0], current, '') : null);
      literal = literal.slice(0, redirected.index).trim();
      masked = masked.replace(/\d*>>?[\s\S]*$/, '');
    }
    if (/\bOut-File\b/i.test(segment.masked)) {
      const output = /(?:^|\|)\s*Out-File\s+(.+)$/i.exec(literal);
      const words = output && shell ? literalShellWords(output[1], shell) : null;
      const pathAt = words?.findIndex((word) => /^-(?:LiteralPath|FilePath|Path)$/i.test(word));
      const target = words && pathAt !== undefined ? words[pathAt >= 0 ? pathAt + 1 : 0] : null;
      paths.push(target && !target.startsWith('-') ? resolveDir(target, current, '') : null);
      literal = output ? literal.slice(0, output.index).trim() : literal;
      masked = masked.replace(/(?:^|\|)\s*Out-File[\s\S]*$/i, '');
    }
    if (
      !/\b(?:worktree\s+(?:add|remove|move)|Remove-Item|Move-Item|Rename-Item|Set-Content|Add-Content|Out-File|Copy-Item|New-Item|rmdir|rm|mv|cp)\b/i.test(
        masked,
      )
    ) {
      unclassified.push(literal);
      continue;
    }
    const words = shell ? literalShellWords(literal, shell) : null;
    if (!words) {
      paths.push(null);
      continue;
    }
    const worktree = words.indexOf('worktree');
    if (worktree >= 0) {
      const operation = words[worktree + 1];
      const rootAt = words.indexOf('-C');
      const root =
        rootAt >= 0 && words.lastIndexOf('-C') === rootAt
          ? resolveDir(words[rootAt + 1], current, '')
          : rootAt < 0
            ? current
            : null;
      const targets = words.slice(worktree + 2).filter((word) => !word.startsWith('-'));
      if (operation === 'add') {
        const args = words.slice(worktree + 2);
        let index = 0;
        while (args[index]?.startsWith('-')) index += /^-[bB]$/.test(args[index]) ? 2 : 1;
        paths.push(args[index] ? resolveDir(args[index], root, '') : null);
      } else if (operation === 'remove' && targets.length === 1) paths.push(resolveDir(targets[0], root, ''));
      else if (operation === 'move' && targets.length === 2)
        paths.push(...targets.map((target) => resolveDir(target, root, '')));
      else paths.push(null);
    } else {
      const targets = words.slice(1).filter((word) => !word.startsWith('-'));
      paths.push(...(targets.length ? targets.map((target) => resolveDir(target, current, '')) : [null]));
    }
  }
  // Opaque programs establish no target for an ownership operation visible in their input.
  if (
    unclassified.some((text) =>
      /\b(?:worktree[\s'",]+(?:add|remove|move)|Remove-Item|Move-Item|Copy-Item|rmtree|rmdir|rm|mv|cp|rmSync|renameSync|unlinkSync)\b/i.test(
        text,
      ),
    )
  )
    paths.push(null);
  if (
    unclassified.some(
      (text) =>
        /\.git(?:\b|[/'"\\])/.test(text) &&
        /\b(?:write_text|writeFileSync|writeFile|copyFileSync|renameSync|unlinkSync|rmSync|WriteAllText|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|cp|rename|replace|unlink|remove|rm)\b/i.test(
          text,
        ),
    )
  )
    paths.push(null);
  return paths;
}

interface CommitInspection {
  dirs: (string | null)[];
  complete: boolean;
  ran: boolean;
}

// Only literal shell arguments are decoded. The inner script uses the invoked shell's grammar.
function literalShellWords(text: string, shell: ClaudeShellDialect): string[] | null {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (shell === 'powershell' && text[i + 1] === quote) {
          word += c;
          i++;
        } else quote = '';
      } else if (quote === '"' && (c === '$' || c === '`')) return null;
      else if (shell === 'bash' && quote === '"' && c === '\\') {
        const next = text[++i];
        if (!next || !/["\\]/.test(next)) return null;
        word += next;
      } else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else if (/[$`\\(){}<>]/.test(c)) return null;
    else {
      word += c;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

export function inspectCommitCommand(
  command: string,
  cwd: string | null,
  shell?: ClaudeShellDialect,
  home: string = os.homedir(),
  depth = 0,
): CommitInspection {
  if (!NESTED_SHELL.test(command)) {
    const dirs = gitCallDirs(command, cwd, home, COMMIT_CALL, shell);
    return {
      dirs: dirs.slice(0, 32),
      complete: dirs.length <= 32 && !dirs.includes(null),
      ran: commandSegments(command, shell).some((seg) => GIT_CALL.test(seg.masked)),
    };
  }
  if (!shell) {
    const bash = inspectCommitCommand(command, cwd, 'bash', home, depth);
    const powershell = inspectCommitCommand(command, cwd, 'powershell', home, depth);
    return JSON.stringify(bash) === JSON.stringify(powershell)
      ? bash
      : { dirs: [], ran: bash.ran || powershell.ran, complete: false };
  }
  const homeDir = normalizeDir(driveForm(home.replace(/\\/g, '/')));
  let cur = cwd ? normalizeDir(driveForm(cwd.replace(/\\/g, '/'))) : null;
  const out: CommitInspection = { dirs: [], complete: true, ran: false };
  for (const seg of commandSegments(command, shell)) {
    const beforeDir = cur;
    const move = CHANGE_DIR.exec(seg.text.trim());
    if (move) {
      const arg = moveTarget(seg.text.trim().slice(move[1].length), shell);
      cur =
        arg === UNREADABLE || arg === '-'
          ? null
          : arg === null
            ? move[1].toLowerCase() === 'cd'
              ? homeDir || null
              : null
            : resolveDir(arg, cur, homeDir);
    } else if (UNTRACKED_DIR.test(seg.text.trim())) cur = null;
    out.ran ||= GIT_CALL.test(seg.masked);
    // The established directory reader retains repeated -C and guarded direct Git calls.
    out.dirs.push(...gitCallDirs(seg.text, beforeDir, home, COMMIT_CALL, shell));
    for (const offset of commandStartOffsets(seg.masked)) {
      const raw = seg.text.slice(offset).trim();
      const masked = seg.masked.slice(offset).trim();
      const head = firstArg(raw);
      if (!head || !/^(?:bash|sh|powershell|pwsh)(?:\.exe)?$/.test(executableName(head))) continue;
      // Quoted output, comments and expression bodies cannot supply a launch boundary.
      if (!masked || (masked[0] === FILL && raw[0] !== '"' && raw[0] !== "'")) continue;
      const words = literalShellWords(raw, shell);
      const innerShell = /^(?:bash|sh)(?:\.exe)?$/.test(executableName(head)) ? 'bash' : 'powershell';
      const flag = words?.findIndex(
        (word, index) => index > 0 && (innerShell === 'bash' ? /^-[a-z]*c$/ : /^-(?:command|c)$/i).test(word),
      );
      if (!words || flag === undefined || flag < 1 || words.length !== flag + 2 || depth >= 4) {
        out.complete = false;
        continue;
      }
      if (
        words
          .slice(1, flag)
          .some(
            (word) =>
              !(
                innerShell === 'bash' ? /^(?:-l|--login|--noprofile|--norc)$/ : /^-(?:noprofile|noninteractive)$/i
              ).test(word),
          )
      ) {
        out.complete = false;
        continue;
      }
      const nested = inspectCommitCommand(words[flag + 1], cur, innerShell, home, depth + 1);
      out.ran ||= nested.ran;
      out.complete &&= nested.complete;
      out.dirs.push(...nested.dirs);
    }
    if (out.dirs.length > 32) {
      out.dirs.length = 32;
      out.complete = false;
    }
  }
  out.complete &&= !out.dirs.includes(null);
  return out;
}

/** Directories for merge commands in call order, with null for unresolved targets. */
export function mergeDirs(command: string, cwd: string | null, home: string = os.homedir()): (string | null)[] {
  return gitCallDirs(command, cwd, home, MERGE_CALL);
}

function gitCallDirs(
  command: string,
  cwd: string | null,
  home: string,
  call: RegExp,
  shell?: ClaudeShellDialect,
): (string | null)[] {
  const homeDir = normalizeDir(driveForm((home || '').replace(/\\/g, '/')));
  let cur = cwd ? normalizeDir(driveForm(cwd.replace(/\\/g, '/'))) : null;
  const out: (string | null)[] = [];
  for (const seg of commandSegments(command, shell)) {
    const trimmed = seg.text.trim();
    const move = CHANGE_DIR.exec(trimmed);
    if (move) {
      const arg = moveTarget(trimmed.slice(move[1].length), shell);
      // A bare `cd` goes home. Every other name for it, and `cd -`, go somewhere this
      // reader cannot name.
      if (arg === UNREADABLE) {
        cur = null;
      } else if (arg === null) {
        cur = move[1].toLowerCase() === 'cd' ? homeDir || null : null;
      } else if (arg === '-') {
        cur = null;
      } else {
        cur = resolveDir(arg, cur, homeDir);
      }
    } else if (UNTRACKED_DIR.test(trimmed)) {
      cur = null;
    }
    call.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = call.exec(seg.masked))) {
      if (!m[2]) {
        out.push(cur);
        continue;
      }
      // The options matched on the masked copy, read back out of the original at the same
      // index, so a quoted path arrives whole and with its own characters.
      const from = m.index + m[1].length + 'git'.length;
      const opts = seg.text.slice(from, from + m[2].length);
      const optsMasked = m[2];
      let dir = cur;
      const arg = /-C\s+(\S+)/g;
      let a: RegExpExecArray | null;
      while (dir !== null && (a = arg.exec(optsMasked))) {
        const at = a.index + a[0].length - a[1].length;
        // Each `-C` is resolved against the one before it, which is what git itself does.
        const target = firstArg(opts.slice(at, at + a[1].length), shell);
        dir = target === null ? null : resolveDir(target, dir, homeDir);
      }
      out.push(dir);
    }
  }
  return out;
}

// Git command boundary with optional environment assignments, matched against masked text.
const GIT_CALL = /(?:^|[({|&])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git(?:\s|$)/;

/**
 * Checks whether the script contains a recognized Git command.
 * Literal nested shell scripts are inspected within bounded depth. Opaque scripts do not establish a Git call.
 */
export function ranGit(command: string, shell?: ClaudeShellDialect): boolean {
  if (!NESTED_SHELL.test(command)) return commandSegments(command, shell).some((seg) => GIT_CALL.test(seg.masked));
  return inspectCommitCommand(command, null, shell).ran;
}

// A shell or PowerShell keyword that can skip a commit and still leave the call successful. A
// guarded commit keeps its whole block in one segment, so this reads the command rather than
// what follows the commit.
const CONDITIONAL =
  /(^|[\s({;])(if|elif|elseif|else|fi|then|switch|foreach|while|until|for|do|done|try|catch|finally|function)([\s({;]|$)/i;

// A block, which is what every one of those keywords opens and what a PowerShell script block
// is on its own. Only the opening brace is read, because `${VAR}` closes with the other one.
const BLOCK = /(^|[^$])\{/;

// A command that leaves before the commit runs. The call then reports the status of the
// leaving rather than of git.
const LEAVES_EARLY = /(^|[\s({;])(exit|return|break|continue)([\s;]|$)/i;

// `git commit --dry-run` reports what a commit would hold and makes none. One anywhere in the
// command disqualifies the whole of it, because the number of commits a command makes is read
// from its text and a dry run is counted like any other.
const DRY_RUN = /(^|[\s"'])--dry-run([\s"'=]|$)/;

// A committer date the command chose for itself puts the commit outside the window it was
// made in, and leaves that window holding only what somebody else landed.
const OWN_DATE = /GIT_COMMITTER_DATE\s*=/i;

// A commit run in the background reports the shell's status rather than git's, and can still
// be running when the call's own output is written. Neither `&&` nor a redirect such as
// `2>&1` is this.
const BACKGROUND = /(^|[^&>])&([^&]|$)/;

// A negated commit reports the opposite of what git said.
const NEGATED = /(^|[\s({;])!\s/;

/**
 * Checks whether successful call status permits repository recovery for a quiet commit.
 * Conditional blocks, or-else branches, early exits, and ambiguous separators prevent recovery.
 * Trailing pipes remain eligible under repository count and head-log checks.
 */
export function commitStatusIsReadable(command: string): boolean {
  return gitStatusIsReadable(command, COMMIT_CALL);
}

/** Checks whether successful call status permits head-log recovery for a merge. */
export function mergeStatusIsReadable(command: string): boolean {
  return gitStatusIsReadable(command, MERGE_CALL);
}

function gitStatusIsReadable(command: string, call: RegExp): boolean {
  const masked = maskQuoted(command);
  if (CONDITIONAL.test(masked) || masked.includes('||')) {
    return false;
  }
  // Dry-run and committer-date checks inspect raw and masked commands. Negation checks inspect masked commands alone.
  // Quoted matching text can therefore reject a command without establishing another commit.
  if (DRY_RUN.test(masked) || OWN_DATE.test(masked) || NEGATED.test(masked)) {
    return false;
  }
  if (DRY_RUN.test(command) || OWN_DATE.test(command)) {
    return false;
  }
  if (BLOCK.test(masked) || LEAVES_EARLY.test(masked)) {
    return false;
  }
  if (!everyCallIsACommand(command, call)) {
    return false;
  }
  call.lastIndex = 0;
  const m = call.exec(masked);
  if (m === null) {
    return false;
  }
  // Reject ambiguous separators after the first matched command, including separators between multiple commits.
  const after = masked.slice(m.index + m[0].length);
  if (after.includes(';') || after.includes('\n') || BACKGROUND.test(after)) {
    return false;
  }
  return true;
}

const ONE_LINE_LOG = /^([0-9a-f]{7,40})\s+(.+)$/;
const BASH_ECHO_OPTION = /^(?:-[neE]+|(['"])-[neE]+\1)(?:\s|$)/;

// The text a final `echo` prints when it is fixed in the command. A variable, substitution
// or shell operator makes the fallback dynamic, so it cannot be distinguished from a log
// line the fallback produced at runtime.
function literalEchoOutput(command: string): string | null {
  const match = /^\s*echo\s+([\s\S]*?)\s*$/.exec(command);
  if (!match) {
    return null;
  }
  const arg = match[1].trim();
  if (BASH_ECHO_OPTION.test(arg)) {
    return null;
  }
  const single = /^'([^']*)'$/.exec(arg);
  if (single) {
    return single[1];
  }
  const double = /^"([^"]*)"$/.exec(arg);
  if (double) {
    return /[$`\\]/.test(double[1]) ? null : double[1];
  }
  if (!arg || /[$%`'"\\;&|<>()[\]{}*?]/.test(arg)) {
    return null;
  }
  return arg.replace(/\s+/g, ' ');
}

// A guarded quiet commit can hide its failure behind a final fallback. The trailing log is
// a success witness only when it directly follows the one commit in the success arm and the
// fallback is fixed text that cannot itself look like that log.
function witnessedCommitSha(command: string, stdout: string): string | null {
  const masked = maskQuoted(command);
  if (CONDITIONAL.test(masked) || DRY_RUN.test(masked) || OWN_DATE.test(masked) || NEGATED.test(masked)) {
    return null;
  }
  if (DRY_RUN.test(command) || OWN_DATE.test(command) || BLOCK.test(masked) || LEAVES_EARLY.test(masked)) {
    return null;
  }
  if (!everyCallIsACommand(command, COMMIT_CALL) || commitDirs(command, null).length !== 1) {
    return null;
  }

  const orElse = [...masked.matchAll(/\|\|/g)];
  if (orElse.length !== 1) {
    return null;
  }
  const orAt = orElse[0].index;
  const fallbackEnd = command.indexOf('\n', orAt + 2);
  const fallback = literalEchoOutput(command.slice(orAt + 2, fallbackEnd < 0 ? command.length : fallbackEnd));
  if (fallbackEnd >= 0 && masked.slice(fallbackEnd).replaceAll(FILL, '').trim() !== '') {
    return null;
  }
  if (fallback === null || fallback.trim() === '' || ONE_LINE_LOG.test(fallback.trim())) {
    return null;
  }

  const success = masked.slice(0, orAt);
  const logAt = success.lastIndexOf('&&');
  if (logAt < 0 || !/^\s*git\s+log\s+--oneline\s+-1\s*$/.test(success.slice(logAt + 2))) {
    return null;
  }
  const beforeLog = success.slice(0, logAt);
  if (/(?:^|[({|&])\s*git\s+log\s+--oneline\s+-1(?:\s|$)/.test(beforeLog)) {
    return null;
  }

  COMMIT_CALL.lastIndex = 0;
  const commit = COMMIT_CALL.exec(beforeLog);
  if (!commit) {
    return null;
  }
  const afterCommit = beforeLog.slice(commit.index + commit[0].length);
  if (
    afterCommit.includes('&&') ||
    afterCommit.includes('|') ||
    afterCommit.includes(';') ||
    afterCommit.includes('\n') ||
    BACKGROUND.test(afterCommit)
  ) {
    return null;
  }

  const last =
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? '';
  return ONE_LINE_LOG.exec(last)?.[1] ?? null;
}

// Whether every `git commit`, or every `git merge`, the command holds is one the command runs.
//
// `commitDirs` counts an occurrence wherever the words sit behind a space, which is what lets
// it read a commit out of a guarded block. `echo git commit` is counted the same way, so a
// command holding one would be read as making two commits and would take the second from
// whoever really made it. A command whose occurrences do not all sit where a command word
// sits is refused rather than counted twice.
function everyCallIsACommand(command: string, call: RegExp): boolean {
  for (const seg of commandSegments(command)) {
    call.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = call.exec(seg.masked))) {
      const before = seg.masked.slice(0, m.index + m[1].length).replace(/\s+$/, '');
      if (before !== '' && !/[({|&]$/.test(before)) {
        return false;
      }
      // A command substitution ends in `(` like a subshell does, and the call then reports the
      // status of whatever read the substitution rather than git's. A backtick substitution
      // needs no test of its own: it ends in no character the line above allows.
      if (/\$\($/.test(before)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Commit location outside the open folders, or null when no external location is established.
 * A shared target supplies its directory. Multiple known external targets supply an unnamed location.
 * Unresolved targets or a mixture of internal and external targets leave location unknown.
 */
export function commitPlaceOf(call: CommandCall | null, folders: string[], home: string = os.homedir()): CommitPlace {
  if (!call || folders.length === 0) {
    return null;
  }
  const agreed = commitDirOf(call, folders, home);
  if (agreed !== null) {
    return isInside(agreed, folders) ? null : { kind: 'named', dir: agreed };
  }
  // Multiple known targets supply an unnamed location only when every target lies outside the open folders.
  const dirs = commitDirs(call.command, call.cwd, home);
  if (!dirs.length || dirs.some((d) => d === null)) {
    return null;
  }
  const known = dirs as string[];
  return known.every((d) => !isInside(d, folders)) ? { kind: 'unnamed' } : null;
}

// The one repository a call can name, or null when its commits cannot be safely tied to
// one directory. This is separate from `commitPlaceOf`: a local commit still needs its
// directory for the editor even though the row does not call it foreign.
export function commitDirOf(
  call: CommandCall | null,
  folders: string[] = [],
  home: string = os.homedir(),
): string | null {
  if (!call) {
    return null;
  }
  return theOneDir(commitDirs(call.command, call.cwd, home));
}

// The one repository a call's merges can name, on the same rule.
export function mergeDirOf(
  call: CommandCall | null,
  folders: string[] = [],
  home: string = os.homedir(),
): string | null {
  if (!call) {
    return null;
  }
  return theOneDir(mergeDirs(call.command, call.cwd, home));
}

function theOneDir(dirs: (string | null)[]): string | null {
  if (!dirs.length || dirs.some((d) => d === null)) {
    return null;
  }
  const first = dirs[0] as string;
  return dirs.every((d) => normalizeFsPath(d as string) === normalizeFsPath(first)) ? first : null;
}
// Printed Git commit identity, with optional branch, detached HEAD, and root-commit fields.
// Named optional tokens avoid accepting arbitrary bracketed log headers as commits.
const COMMIT_LINE = /^\[(?:(detached HEAD|\S+)\s+)?(?:\(root-commit\)\s+)?([0-9a-f]{7,40})\]\s*(.*)$/;

// git's stat line, printed directly under the commit line. "file"/"files",
// "insertion"/"insertions" and "deletion"/"deletions" each pluralise independently of one
// another and of their own count, and the insertions clause, the deletions clause, or
// neither can be missing depending on what the commit actually touched. A missing clause
// means git counted zero of that kind, not that the figure is unknown.
const STAT_LINE = /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;

// How far under the commit line to look for it. Git writes at most an `Author:` and a
// `Date:` line in between, so three leaves room without reaching the next commit.
const STAT_LOOKAHEAD = 3;

// The header `git show` and `git log` print for each commit, with any ref decoration after the hash.
const FULL_COMMIT_LINE = /^commit ([0-9a-fA-F]{40})(?:\s|$)/;

// The figures under a commit line, and the same figures under `git log --shortstat`. One
// reader for both, because they are the same line written by the same program.
export function parseStatLine(line: string): { files: number; added: number; removed: number } | null {
  const m = STAT_LINE.exec(line);
  if (!m) {
    return null;
  }
  return {
    files: Number(m[1]),
    added: m[2] !== undefined ? Number(m[2]) : 0,
    removed: m[3] !== undefined ? Number(m[3]) : 0,
  };
}

// Reads printed commit identities only from eligible Git commands or explicitly unpaired command output.
// Repository candidates retain the command's directory evidence.
// A successful readable execution window also permits quiet-commit and landing recovery intents.
export function recordCommits(
  turn: { commits: TurnCommit[]; commitIntents?: CommitIntent[]; landingIntents?: LandingIntent[] },
  stdout: string,
  at: number,
  call: CommitCall = null,
  folders: string[] = [],
  defaultDir: string | null = null,
  window: { from: number; failed: boolean } | null = null,
): void {
  if (call === null || (call !== 'unreadable' && !ranGit(call.command, call.shell))) {
    return;
  }
  // Unpaired commands supply no location label. Their caller can still provide a default navigation directory.
  const ran = call === 'unreadable' ? null : call;
  const lines = stdout.split('\n');
  let place: CommitPlace | undefined;
  let printed = false;
  const inspection = ran ? inspectCommitCommand(ran.command, ran.cwd, ran.shell) : null;
  const dir = inspection ? (inspection.complete ? theOneDir(inspection.dirs) : null) : defaultDir;
  const candidates =
    inspection && dir === null && (ran?.cwd || inspection.dirs.some((one) => one !== null))
      ? {
          dirs: [...new Set([ran?.cwd, ...inspection.dirs].filter((one): one is string => typeof one === 'string'))],
          complete: inspection.complete,
        }
      : undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = COMMIT_LINE.exec(lines[i].trim());
    if (!m) {
      continue;
    }
    printed = true;
    if (place === undefined) {
      place = commitPlaceOf(ran, folders);
    }
    const sha = m[2].slice(0, 8);
    const full = fullShaOf(lines, m[2]);
    const duplicate = turn.commits.find((c) => sameCommitSha(c.printedSha ?? c.sha, m[2]));
    if (duplicate) {
      if (m[2].length > (duplicate.printedSha ?? duplicate.sha).length) duplicate.printedSha = m[2];
      if (full && !duplicate.fullSha) duplicate.fullSha = full;
      if (candidates) {
        const dirs = [...new Set([...(duplicate.candidates?.dirs ?? []), ...candidates.dirs])];
        duplicate.candidates = {
          dirs: dirs.slice(0, 33),
          complete: dirs.length <= 33 && candidates.complete && (duplicate.candidates?.complete ?? true),
        };
        duplicate.dir = null;
      } else if (ran && dir !== null && !duplicate.candidates) duplicate.dir = dir;
      continue;
    }
    // Inspect nearby stat lines through Git headers, stopping at another commit identity. Missing stats leave counts unknown.
    let stat: { files: number; added: number; removed: number } | null = null;
    for (let j = i + 1; j < lines.length && j <= i + STAT_LOOKAHEAD; j++) {
      const next = lines[j].trim();
      if (COMMIT_LINE.test(next)) {
        break;
      }
      stat = parseStatLine(next);
      if (stat) {
        break;
      }
    }
    turn.commits.push({
      sha,
      ...(m[2].length > 8 ? { printedSha: m[2] } : {}),
      ...(full ? { fullSha: full } : {}),
      ...(candidates ? { candidates } : {}),
      subject: m[3].trim(),
      head: m[1] === 'detached HEAD' ? { kind: 'detached' } : m[1] ? { kind: 'branch', name: m[1] } : null,
      files: stat ? stat.files : null,
      added: stat ? stat.added : null,
      removed: stat ? stat.removed : null,
      at,
      place,
      dir,
    });
  }
  recordCommitIntent(turn, ran, dir, printed, window, at, stdout);
  recordLandingIntent(turn, ran, mergeDirOf(ran, folders), window, at);
}

// The one full hash that `commit <sha>` lines in the same output print for a shorter header hash. Null for a full header hash, no match, or several matches.
function fullShaOf(lines: readonly string[], printed: string): string | null {
  if (printed.length >= 40) return null;
  const prefix = printed.toLowerCase();
  const found = new Set<string>();
  for (const line of lines) {
    const m = FULL_COMMIT_LINE.exec(line.trim());
    if (m && m[1].toLowerCase().startsWith(prefix)) found.add(m[1].toLowerCase());
  }
  return found.size === 1 ? [...found][0] : null;
}

// Records quiet-commit recovery only with a successful window and one resolved repository.
// Require readable status or a witnessed commit hash. Printed identities take precedence.
function recordCommitIntent(
  turn: { commitIntents?: CommitIntent[] },
  ran: CommandCall | null,
  dir: string | null,
  printed: boolean,
  window: { from: number; failed: boolean } | null,
  at: number,
  stdout: string,
): void {
  if (printed || window === null || window.failed || ran === null || dir === null) {
    return;
  }
  const readable = commitStatusIsReadable(ran.command);
  const witnessedSha = readable ? null : witnessedCommitSha(ran.command, stdout);
  if (!readable && witnessedSha === null) {
    return;
  }
  const expected = commitDirs(ran.command, ran.cwd).length;
  if (expected === 0) {
    return;
  }
  (turn.commitIntents ??= []).push({
    dir,
    from: Math.min(window.from, at),
    to: at,
    expected,
    ...(witnessedSha === null ? {} : { witnessedSha }),
  });
}

// Records merge recovery only with a successful readable window and one resolved repository.
function recordLandingIntent(
  turn: { landingIntents?: LandingIntent[] },
  ran: CommandCall | null,
  dir: string | null,
  window: { from: number; failed: boolean } | null,
  at: number,
): void {
  if (window === null || window.failed || ran === null || dir === null) {
    return;
  }
  if (!mergeStatusIsReadable(ran.command)) {
    return;
  }
  const expected = mergeDirs(ran.command, ran.cwd).length;
  if (expected === 0) {
    return;
  }
  (turn.landingIntents ??= []).push({
    ...(ran.id ? { id: ran.id } : {}),
    dir,
    from: Math.min(window.from, at),
    to: at,
    expected,
  });
}

// The first line of a tool's error, which is the part that says what went wrong.
export function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) || 'no detail given';
  return shortenTo(line, 160, '...');
}

function stamp(value: unknown): number {
  const t = Date.parse(String(value || ''));
  return Number.isNaN(t) ? 0 : t;
}

// The id of the tool call a tool_result answers, which is how a subagent's result is
// tied back to the launch that started it.
function toolUseIdOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  for (const block of content as { type?: string; tool_use_id?: string }[]) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      return block.tool_use_id;
    }
  }
  return '';
}

// The file map is keyed by `normalizeFsPath`, because one session writes the same file with
// either drive letter case: an edit tool and each shell command take the case of their own
// working directory. A row keeps the spelling it was first seen with.
type Building = Omit<Turn, 'files'> & { files: Map<string, TurnFileChange> };

const SOURCE_START = Symbol('sourceStart');
const SOURCE_END = Symbol('sourceEnd');
const MEMBERSHIP_START = Symbol('membershipStart');
type SourcedBuilding = Building & {
  [SOURCE_START]?: number;
  [SOURCE_END]?: number;
  [MEMBERSHIP_START]?: number;
};

function setSourceRange(value: object, start: number, end: number): void {
  Object.defineProperty(value, SOURCE_START, {
    value: start,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(value, SOURCE_END, {
    value: end,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function extendSourceRange(value: SourcedBuilding, start: number, end: number): void {
  const currentStart = value[SOURCE_START];
  const currentEnd = value[SOURCE_END];
  if (currentStart === undefined || start < currentStart) {
    Object.defineProperty(value, SOURCE_START, {
      value: start,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (currentEnd === undefined || end > currentEnd) {
    Object.defineProperty(value, SOURCE_END, {
      value: end,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}

function setMembershipStart(value: SourcedBuilding, start: number): void {
  Object.defineProperty(value, MEMBERSHIP_START, {
    value: start,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

// Claude writes a step's exact detail once, so the field stays sealed.
const CLAUDE_HIDDEN_POLICY: HiddenStatePolicy = {
  start: SOURCE_START,
  end: SOURCE_END,
  membershipStart: MEMBERSHIP_START,
  redefinesDetail: false,
};

export interface ReadOptions {
  // Explicit captures retain recorded submissions and Activity steps. Ordinary panel reads stay bounded.
  captureSessionText?: boolean;
  dispatchResponse?: boolean;
  captureRepeated?: Pick<import('./clauderepeated').ClaudeRepeatedState, 'runs'>;
  exportTurnBytes?: number;
  recoveredModelAttachment?: string | null;
  tailBytes?: number;
  maxTurns?: number;
  // Prepare newest-turn backward recovery for selected reads. Other reads retain their ordinary tail.
  prepareNewestTurnDiscovery?: boolean;
  sessionTitle?: string | null;
  // Open workspace folders used for external commit location labels. An empty list leaves locations unmarked.
  folders?: string[];
  // Optional child-spend lookup for the identity recorded by a parent launch.
  agentSpendOf?: AgentSpendLookup;
  // Resolves a paired launch and result to a child session after the provider adapter
  // verifies the child's transcript and recorded working directory.
  agentSessionTargetOf?: AgentSessionTargetLookup;
  childTranscript?: boolean;
  // Set by a caller that keeps only the turns. Its compactions then carry no first request cache
  // read, because finding it can read the head of a large transcript.
  turnsOnly?: boolean;
  // Classifies a line by its start byte for a reader that does not read from byte 0. True means
  // the session reducer skips the line as a repeated record.
  repeatedRecord?: (start: number, text: string) => boolean;
  // Set by a read with a byte limit. It extends the repeated-record map by at most its own window
  // and never waits for the rest of the file.
  boundedRepeated?: boolean;
}

export type ClaudeUsage = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  cache_creation?: unknown;
  output_tokens_details?: unknown;
  service_tier?: unknown;
  speed?: unknown;
  inference_geo?: unknown;
  cost_usd?: unknown;
  cost?: unknown;
  // Per-pass usage of one response. Advisor passes appear only here, never in the top-level fields.
  iterations?: unknown;
};

// Kept as JSON data so an incremental scanner can save it beside its byte offset and resume
// after the extension host restarts.
export interface ClaudeUsageReducerState {
  costState?: ClaudeCostCapture;
  // First-seen request keys, oldest first. Parent reads retain every key.
  // Child reads retain the newest keys unless retainAllRequests is set. Snapshots keep an array.
  seenRequestKeys: string[];
  // Runtime request-key set, rebuilt from the saved queue and omitted from snapshots.
  seenRequests?: Set<string>;
  closedTurns: number;
  openTurn: boolean;
  openTurnAnswered: boolean;
  // How many compactions this transcript has held. The usage line reducer revokes an abandoned one.
  // A reader skips repeated records before they reach the reducer, so a repeated compaction never counts.
  compactionCount: number;
  // The newest of those summaries, oldest first. `RETAINED_COMPACTIONS` bounds it, so
  // compactionCount stays the exact total and this list only describes them.
  recentCompactions: ReducerCompaction[];
  pendingCompactionTrigger?: string | null;
  // The sizes the newest compaction boundary recorded, until a summary pairs with them. `at` is
  // the boundary's clock and `durationMs` how long the request ran, each 0 where unrecorded.
  pendingCompactionSize?: ClaudeCompactionSize | null;
  // The newest compaction summary that no boundary has sized yet, with the main request before
  // it. Claude Code can write the summary before the boundary.
  unsizedCompaction?: ClaudeUnsizedCompaction | null;
  // Ids of the newest main-chain answers and typed prompts, oldest first.
  // `RETAINED_COMPACTION_PARENTS` bounds the list.
  compactionParents?: string[];
  // The newest compaction until a typed prompt or billed request shows whether the session
  // continued from it.
  pendingCompaction?: ClaudePendingCompaction | null;
  // The newest main request, which sizes the next compaction's input.
  lastRequest?: ClaudeLastRequest | null;
  // The cache read plus cache write of the first request this transcript billed, set once. A cold compaction
  // writes that shared prefix, and null means no request has been read yet.
  firstRequestCachedTokens?: number | null;
  pendingCompactionEstimate?: { event: UsageEvent; input: CompactionEstimateInput } | null;
  toolListNames?: string[];
  toolListVersion?: number;
  // How many visible user prompts this transcript has opened. A request emitted while this
  // stands at zero belongs to no visible turn the reader typed.
  visibleTurns: number;
  // The very first turn's startedAt, epoch milliseconds. Set once and never moved.
  firstTurnAt: number | null;
  // The most recently opened turn's startedAt and the latest activity seen for it. lastTurnAt()
  // reads the second only once the turn has answered, and the first until then.
  currentTurnStartedAt: number | null;
  currentTurnEndedAt: number | null;
  currentTurnOutcome: TurnOutcome | null;
  // Opening record ID used to pair a local command answer.
  currentTurnCommand?: string | null;
  currentTurnCompact?: boolean;
  // The turn the current typed prompt followed, as it stood when that prompt arrived. A local
  // command answer withdraws the command's turn and puts this one back as the newest turn.
  // Null once anything answers the current turn, because no answer can withdraw it then.
  currentTurnPrevious?: ClaudePreviousTurn | null;
  // The command turn a local command answer withdrew, held until the next typed prompt or model
  // work. Model work after a compaction puts it back as the newest turn, as the full reader keeps
  // the command open for that work. Model work after the CLI's own answer stays in the current turn.
  currentTurnWithdrawn?: ClaudePreviousTurn | null;
  // Whether a prompt queued behind the withdrawn command opened the current turn. Every prompt
  // queued after it, before model work or a typed prompt, joins that turn, as the full reader
  // puts them on one card. Absent or false otherwise.
  currentTurnQueued?: boolean;
  // Prompts the reader queued while the current command waited for its answer, as start and end
  // times. A local command answer opens their turn in the command's place. Absent or null otherwise.
  currentTurnQueuedBefore?: { startedAt: number; endedAt: number } | null;
  // Whether a result that ends the turn finished currentTurnOutcome. A wake or later model work
  // in the same turn resumes it. Absent or false otherwise.
  currentTurnToolEnded?: boolean;
  // The index behind currentTurnOutcome.closedChildren. It is rebuilt once after a restore
  // and omitted from snapshots, like seenRequests above.
  closedChildIndex?: Map<string, number>;
  // Latest usage event for each retained child request key.
  // A revised request removes its previous event before adding its replacement.
  // RETAINED_REQUESTS bounds events and keys unless retainAllRequests is set.
  // Parent reads deduplicate requests without retaining their events.
  requestEvents?: Record<string, UsageEvent>;
  // Model id from the newest model attachment. Bedrock request pricing reads its inference profile prefix.
  modelProfile?: string | null;
  // Open tool calls, newest last, each with the kind `arc cost --by-tool` gives its result.
  // `CLAUDE_TOOL_CALL_LIMIT` bounds the list.
  toolCalls?: { id: string; kind: string }[];
  // The kinds of the tool results recorded since the last request. The next request read them.
  pendingToolResults?: string[];
  // The call ids of recorded tool results, newest last. A repeated result line adds nothing, as
  // `arc cost --by-tool` counts each result once. `CLAUDE_TOOL_CALL_LIMIT` bounds the list.
  seenToolResults?: string[];
}

// The most open tool calls, and the most results one request keeps.
export const CLAUDE_TOOL_CALL_LIMIT = 256;

// A tool result's call id. A key inside a quoted string has an escaped quote before it, so text
// that quotes a transcript never matches.
const CLAUDE_TOOL_RESULT_ID = /(?<!\\)"tool_use_id"\s*:\s*"([^"\\]+)"/g;

// Records the tool calls of one assistant response, with the kind of each result.
function noteClaudeToolCalls(state: ClaudeUsageReducerState, message: { content?: unknown } | undefined): void {
  if (!Array.isArray(message?.content)) return;
  for (const block of message.content as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }[]) {
    if (block?.type !== 'tool_use' || typeof block.id !== 'string' || !block.id) continue;
    const held = (state.toolCalls ??= []);
    if (held.some((call) => call.id === block.id)) continue;
    held.push({ id: block.id, kind: toolKind(typeof block.name === 'string' ? block.name : '', block.input).kind });
    held.splice(0, Math.max(0, held.length - CLAUDE_TOOL_CALL_LIMIT));
  }
}

// Records the tool results of one user line without parsing it. A result whose call this
// reader never saw is `other`, as `arc cost --by-tool` counts it.
export function noteClaudeToolResultLine(state: ClaudeUsageReducerState, line: string): void {
  if (line.indexOf('"tool_result"') < 0 || !/"type"\s*:\s*"user"/.test(line)) return;
  for (const match of line.matchAll(CLAUDE_TOOL_RESULT_ID)) {
    const seen = (state.seenToolResults ??= []);
    if (seen.includes(match[1])) continue;
    seen.push(match[1]);
    seen.splice(0, Math.max(0, seen.length - CLAUDE_TOOL_CALL_LIMIT));
    const index = state.toolCalls?.findIndex((call) => call.id === match[1]) ?? -1;
    const kind = index >= 0 ? state.toolCalls!.splice(index, 1)[0].kind : 'other';
    const held = (state.pendingToolResults ??= []);
    if (held.length < CLAUDE_TOOL_CALL_LIMIT) held.push(kind);
  }
}

export type ClaudeLastRequest = CompactionPreviousRequest & { model: string | null };

// The turn fields of `ClaudeUsageReducerState` as a typed prompt found them.
export interface ClaudePreviousTurn {
  open: boolean;
  answered: boolean;
  startedAt: number | null;
  endedAt: number | null;
  firstTurnAt: number | null;
  outcome: TurnOutcome | null;
  // Set on a withdrawn command turn only. Whether a manual compaction withdrew it.
  compact?: boolean;
  // On a withdrawn command turn, the stop time the CLI's own answer gave the turn before it. On a
  // previous turn, the stop time an earlier such answer gave that turn.
  localStopAt?: number;
}

function copyPreviousTurn(value: ClaudePreviousTurn | null | undefined): ClaudePreviousTurn | null {
  return value ? { ...value, outcome: copyTurnOutcome(value.outcome) } : null;
}

// The current turn fields of an index state, as they stand now.
function currentClaudeTurn(state: ClaudeUsageReducerState): ClaudePreviousTurn {
  return {
    open: state.openTurn,
    answered: state.openTurnAnswered,
    startedAt: state.currentTurnStartedAt,
    endedAt: state.currentTurnEndedAt,
    firstTurnAt: state.firstTurnAt,
    outcome: state.currentTurnOutcome,
  };
}

// Makes `turn` the current turn of an index state. Background children stay with the current
// turn, whichever turn that is.
function restoreClaudeTurn(state: ClaudeUsageReducerState, turn: ClaudePreviousTurn | null): void {
  const moved = state.currentTurnOutcome;
  state.openTurn = turn?.open ?? false;
  state.openTurnAnswered = turn?.answered ?? false;
  state.currentTurnStartedAt = turn?.startedAt ?? null;
  state.currentTurnEndedAt = turn?.endedAt ?? null;
  state.firstTurnAt = turn ? turn.firstTurnAt : state.firstTurnAt;
  const outcome = copyTurnOutcome(turn?.outcome ?? null);
  if (outcome) {
    delete outcome.openChildren;
    delete outcome.closedChildren;
    if (moved?.openChildren?.length) {
      outcome.openChildren = moved.openChildren;
    }
    if (moved?.closedChildren?.length) {
      outcome.closedChildren = moved.closedChildren;
    }
  }
  state.currentTurnOutcome = outcome;
  state.currentTurnCommand = null;
  state.currentTurnPrevious = null;
  state.currentTurnQueued = false;
  state.currentTurnQueuedBefore = null;
  state.currentTurnToolEnded = false;
}

// Anything that answers the current turn also means no local command answer can withdraw it.
function answerClaudeTurn(state: ClaudeUsageReducerState): void {
  state.openTurnAnswered = true;
  state.currentTurnPrevious = null;
}

export interface ClaudeCompactionSize {
  before: number;
  after: number;
  at: number;
  durationMs: number;
}

export interface ClaudeUnsizedCompaction {
  ordinal: number;
  // The summary's clock, 0 where it has none.
  at: number;
  previous: ClaudeLastRequest | null;
  // The length of the summary's stored text, counted as `compactSummaryChars` counts it.
  summaryChars?: number;
}

export interface ClaudePendingCompaction {
  // `compactionParents` as the compaction's first boundary or summary record found it, without the
  // ids its boundary names as the head and tail of its preserved segment.
  parents: string[];
  // The compaction's ordinal once its summary counted it. Null while only its boundary is read.
  ordinal: number | null;
  boundary: boolean;
  // The retained compaction that the summary pushed out of `recentCompactions`.
  evicted: ReducerCompaction | null;
}

function copyPendingCompaction(value: ClaudePendingCompaction | null | undefined): ClaudePendingCompaction | null {
  return value ? { ...value, parents: [...value.parents], evicted: value.evicted ? { ...value.evicted } : null } : null;
}

function copyUnsizedCompaction(value: ClaudeUnsizedCompaction | null | undefined): ClaudeUnsizedCompaction | null {
  return value ? { ...value, previous: value.previous ? { ...value.previous } : null } : null;
}

// Stored compaction summary character count, including the continuation preamble.
export function compactSummaryChars(record: Record<string, unknown>): number {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  return (typeof content === 'string' ? content : textOf(content)).length;
}

function positiveCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

// Whether a compaction boundary and a summary written at these clocks describe one compaction.
function withinCompactWindow(left: number, right: number): boolean {
  return Math.abs(left - right) <= COMPACT_META_WINDOW_MS;
}

export function emptyClaudeUsageReducerState(): ClaudeUsageReducerState {
  return {
    seenRequestKeys: [],
    closedTurns: 0,
    openTurn: false,
    openTurnAnswered: false,
    compactionCount: 0,
    recentCompactions: [],
    pendingCompactionTrigger: null,
    toolListNames: [],
    toolListVersion: 0,
    visibleTurns: 0,
    firstTurnAt: null,
    currentTurnStartedAt: null,
    currentTurnEndedAt: null,
    currentTurnCommand: null,
    currentTurnPrevious: null,
    currentTurnWithdrawn: null,
    currentTurnOutcome: null,
  };
}

// Returns the oldest entry the push removed, or null.
export function retainNewestCompaction(
  state: { recentCompactions: ReducerCompaction[] },
  compaction: ReducerCompaction,
): ReducerCompaction | null {
  state.recentCompactions.push(compaction);
  let evicted: ReducerCompaction | null = null;
  while (state.recentCompactions.length > RETAINED_COMPACTIONS) {
    evicted = state.recentCompactions.shift() ?? null;
  }
  return evicted;
}

// The boundary pairs with a summary read before it, or opens the next pending compaction. A
// summary that a record already decided still claims a boundary written inside its window. The
// boundary's preserved segment ends and starts at records the next prompt descends from on older
// builds, so those ids never prove that the session left the compaction.
function noteClaudeCompactionBoundary(state: ClaudeUsageReducerState, at: number, preserved: string[]): void {
  const pending = state.pendingCompaction;
  if (pending && pending.ordinal !== null && !pending.boundary) {
    pending.boundary = true;
    pending.parents = pending.parents.filter((id) => !preserved.includes(id));
    return;
  }
  const unsized = state.unsizedCompaction;
  if (!pending && unsized && withinCompactWindow(unsized.at, at)) {
    return;
  }
  state.pendingCompaction = {
    parents: (state.compactionParents ?? []).filter((id) => !preserved.includes(id)),
    ordinal: null,
    boundary: true,
    evicted: null,
  };
}

// The ids of the records a compaction boundary keeps from before the summary: the first and the last.
function preservedSegmentIds(metadata: Record<string, unknown> | undefined): string[] {
  const segment = metadata?.preservedSegment as Record<string, unknown> | undefined;
  return [segment?.headUuid, segment?.tailUuid].filter((id): id is string => typeof id === 'string' && id !== '');
}

// The summary completes the pending compaction its boundary opened. Otherwise it replaces any
// pending compaction with its own, and the replaced compaction stays counted.
function noteClaudeCompactionSummary(
  state: ClaudeUsageReducerState,
  ordinal: number,
  evicted: ReducerCompaction | null,
): void {
  const pending = state.pendingCompaction;
  if (pending && pending.ordinal === null) {
    pending.ordinal = ordinal;
    pending.evicted = evicted;
    return;
  }
  state.pendingCompaction = { parents: [...(state.compactionParents ?? [])], ordinal, boundary: false, evicted };
}

// The first main-chain typed prompt or new billed request after a compaction decides it. A
// parent read before the compaction proves the session left it, so the compaction is revoked.
// Any other parent, or none, keeps it. Each answer and typed prompt then joins
// `compactionParents`. A record read before neither decides nor joins: its uuid is already held,
// or it is a billed answer for an earlier request than the newest one. A later content block of
// the newest request shares that request's key and joins, because the next record names it.
function followClaudeCompactionLineage(
  state: ClaudeUsageReducerState,
  record: Record<string, unknown>,
  childTranscript: boolean,
): void {
  if (record.isSidechain && !childTranscript) {
    return;
  }
  const answer = record.type === 'assistant';
  if (!answer && !(record.type === 'user' && isTypedPrompt(record, childTranscript))) {
    return;
  }
  const pending = state.pendingCompaction;
  const uuid = typeof record.uuid === 'string' && record.uuid ? record.uuid : null;
  if (uuid && (state.compactionParents?.includes(uuid) || pending?.parents.includes(uuid))) {
    return;
  }
  const message = record.message as ClaudeRequestMessage | undefined;
  let decides = !answer;
  if (answer && message?.usage && message.model !== '<synthetic>') {
    const key = claudeRequestKey(record, message);
    if (!seenRequestIndex(state).has(key)) {
      decides = true;
    } else if (state.seenRequestKeys[state.seenRequestKeys.length - 1] !== key) {
      return;
    }
  }
  if (pending && decides) {
    state.pendingCompaction = null;
    const parent = typeof record.parentUuid === 'string' && record.parentUuid ? record.parentUuid : null;
    if (parent && pending.ordinal !== null && pending.parents.includes(parent)) {
      revokeClaudeCompaction(state, pending.ordinal, pending.evicted);
    }
  }
  if (uuid) {
    const parents = (state.compactionParents ??= []);
    parents.push(uuid);
    while (parents.length > RETAINED_COMPACTION_PARENTS) {
      parents.shift();
    }
  }
}

// Removes the newest compaction from the count and the retained list, and puts back the entry it
// pushed out. Its summary request stays billed: an estimate already emitted stays, and a summary
// still waiting for its boundary keeps `unsizedCompaction`, so the boundary emits the estimate.
function revokeClaudeCompaction(
  state: ClaudeUsageReducerState,
  ordinal: number,
  evicted: ReducerCompaction | null,
): void {
  if (ordinal !== state.compactionCount) {
    return;
  }
  state.compactionCount--;
  if (state.recentCompactions[state.recentCompactions.length - 1]?.ordinal === ordinal) {
    state.recentCompactions.pop();
  }
  if (evicted) {
    state.recentCompactions.unshift(evicted);
  }
}

// Opens the unanswered turn of prompts queued around a withdrawn command, starting at `at`.
function openClaudeQueuedTurn(state: ClaudeUsageReducerState, at: number): void {
  if (state.openTurn) {
    state.closedTurns++;
  }
  const openChildren = state.currentTurnOutcome?.openChildren;
  const closedChildren = state.currentTurnOutcome?.closedChildren;
  state.openTurn = true;
  state.openTurnAnswered = false;
  state.currentTurnStartedAt = at;
  state.currentTurnEndedAt = at;
  state.currentTurnCommand = null;
  state.currentTurnPrevious = null;
  state.currentTurnQueued = true;
  state.currentTurnQueuedBefore = null;
  state.currentTurnToolEnded = false;
  state.currentTurnOutcome = {
    finished: false,
    error: false,
    interrupted: false,
    endedAt: at,
    startedAt: at,
    ...(openChildren && openChildren.length > 0 ? { openChildren } : {}),
    ...(closedChildren && closedChildren.length > 0 ? { closedChildren } : {}),
  };
  state.firstTurnAt ??= at;
}

// Returns whether the answer withdrew the open command turn.
function withdrawClaudeUsageTurn(
  state: ClaudeUsageReducerState,
  localAnswer: { at: number; parent: string },
  compact = false,
): boolean {
  if (
    !state.openTurnAnswered &&
    state.currentTurnOutcome &&
    state.currentTurnCommand &&
    localAnswer.parent === state.currentTurnCommand
  ) {
    // Withdraw the unanswered command turn. Preserve its visible-turn sequence number for request identity.
    const previous = state.currentTurnPrevious ?? null;
    const queuedBefore = state.currentTurnQueuedBefore ?? null;
    const outcome: TurnOutcome = {
      ...state.currentTurnOutcome,
      finished: true,
      endedAt: Math.max(state.currentTurnOutcome.endedAt, localAnswer.at),
    };
    delete outcome.openChildren;
    delete outcome.closedChildren;
    const withdrawn: ClaudePreviousTurn = {
      ...currentClaudeTurn(state),
      endedAt: Math.max(state.currentTurnEndedAt ?? 0, localAnswer.at),
      outcome,
      ...(compact ? { compact: true } : {}),
      ...(previous?.localStopAt !== undefined ? { localStopAt: previous.localStopAt } : {}),
    };
    if (previous?.open && previous.answered) {
      state.closedTurns--;
    }
    restoreClaudeTurn(state, previous);
    if (!compact && previous?.open && !previous.answered && state.currentTurnOutcome) {
      const stopped = stoppedByLocalAnswer(state.currentTurnOutcome);
      if (stopped !== state.currentTurnOutcome && stopped.processEndedAt !== undefined) {
        withdrawn.localStopAt = stopped.processEndedAt;
      }
      state.currentTurnOutcome = stopped;
    }
    // An unanswered prompt restored by the local answer keeps its own turn for the next prompt count.
    state.openTurnAnswered = state.openTurn;
    state.currentTurnWithdrawn = withdrawn;
    if (queuedBefore) {
      // Prompts queued before the answer wait on a card of their own, as a prompt queued after it does.
      openClaudeQueuedTurn(state, queuedBefore.startedAt);
      state.currentTurnEndedAt = queuedBefore.endedAt;
      if (state.currentTurnOutcome) state.currentTurnOutcome.endedAt = queuedBefore.endedAt;
    }
    return true;
  }
  return false;
}

function reduceClaudeTurnRecord(
  state: ClaudeUsageReducerState,
  record: Record<string, unknown>,
  childTranscript = false,
): void {
  if (record.isSidechain && !childTranscript) {
    return;
  }
  const queuedAsk = readerQueuedAsk(record);
  if (queuedAsk && !state.currentTurnWithdrawn) {
    state.currentTurnCompact = false;
    if (state.openTurn && state.currentTurnCommand) {
      const held = state.currentTurnQueuedBefore;
      state.currentTurnQueuedBefore = {
        startedAt: held?.startedAt ?? queuedAsk.at,
        endedAt: Math.max(held?.endedAt ?? 0, queuedAsk.at),
      };
    }
  }
  const compactAnswer = state.currentTurnCompact
    ? claudeCompactAnswer(record, state.currentTurnCommand ?? null, state.currentTurnStartedAt)
    : null;
  if (compactAnswer && state.openTurn && !state.openTurnAnswered) {
    withdrawClaudeUsageTurn(state, compactAnswer, true);
  }
  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    const at = stamp(record.timestamp);
    const metadata = record.compactMetadata as Record<string, unknown> | undefined;
    noteClaudeCompactionBoundary(state, at, preservedSegmentIds(metadata));
    state.pendingCompactionTrigger =
      typeof metadata?.trigger === 'string' && metadata.trigger ? metadata.trigger : null;
    const after = positiveCount(metadata?.postTokens);
    // A boundary that names no summary size prices nothing, and a newer boundary replaces the
    // sizes of one no summary claimed.
    state.pendingCompactionSize = after
      ? { before: positiveCount(metadata?.preTokens), after, at, durationMs: positiveCount(metadata?.durationMs) }
      : null;
    // The timeline pairs a boundary with a summary written within `COMPACT_META_WINDOW_MS`
    // on either side. A summary outside that window never gets these sizes.
    if (state.unsizedCompaction && (!after || !withinCompactWindow(state.unsizedCompaction.at, at))) {
      state.unsizedCompaction = null;
    }
    return;
  }
  if (noteClaudeModelProfile(state, record)) {
    return;
  }
  const attachment = record.attachment as Record<string, unknown> | undefined;
  if (record.type === 'attachment' && attachment?.type === 'deferred_tools_delta') {
    const names = new Set(state.toolListNames ?? []);
    for (const value of Array.isArray(attachment.removedNames) ? attachment.removedNames : []) {
      if (typeof value === 'string') {
        names.delete(value);
      }
    }
    for (const value of Array.isArray(attachment.addedNames) ? attachment.addedNames : []) {
      if (typeof value === 'string' && value) {
        names.add(value);
      }
    }
    const next = [...names].sort();
    const current = state.toolListNames ?? [];
    if (next.length !== current.length || next.some((value, index) => value !== current[index])) {
      state.toolListNames = next;
      state.toolListVersion = (state.toolListVersion ?? 0) + 1;
    }
    return;
  }
  if (record.type === 'user' && record.isCompactSummary) {
    state.compactionCount++;
    const at = stamp(record.timestamp);
    const evicted = retainNewestCompaction(state, {
      ordinal: state.compactionCount,
      at: Number.isFinite(at) && at > 0 ? at : null,
      trigger: state.pendingCompactionTrigger ?? null,
      // A Claude compaction summary is a user record and carries no request usage. The usage
      // reducer emits an estimated request for it instead.
      requestUsage: null,
      requestModel: null,
      requestProvider: null,
      requestServiceTier: null,
      requestContextWindow: null,
    });
    noteClaudeCompactionSummary(state, state.compactionCount, evicted);
    state.pendingCompactionTrigger = null;
    const size = state.pendingCompactionSize ?? null;
    if (size && !withinCompactWindow(size.at, at)) {
      state.pendingCompactionSize = null;
    }
    state.unsizedCompaction = {
      ordinal: state.compactionCount,
      at,
      previous: state.lastRequest ? { ...state.lastRequest } : null,
      summaryChars: compactSummaryChars(record),
    };
    return;
  }
  if (record.type === 'user' && isTypedPrompt(record, childTranscript)) {
    const handedStop = state.currentTurnQueued ? undefined : state.currentTurnWithdrawn?.localStopAt;
    state.currentTurnPrevious = copyPreviousTurn(currentClaudeTurn(state));
    if (state.currentTurnPrevious && handedStop !== undefined) {
      // The prompt follows a command the CLI answered by itself, and that answer stopped this turn.
      state.currentTurnPrevious.localStopAt = handedStop;
    }
    state.currentTurnWithdrawn = null;
    state.currentTurnQueued = false;
    state.currentTurnQueuedBefore = null;
    state.currentTurnToolEnded = false;
    if (state.openTurn && state.openTurnAnswered) {
      state.closedTurns++;
    }
    state.visibleTurns++;
    state.openTurn = true;
    state.openTurnAnswered = false;
    const at = stamp(record.timestamp);
    state.currentTurnStartedAt = at;
    state.currentTurnEndedAt = at;
    state.currentTurnCommand = claudeRecordId(record);
    state.currentTurnCompact = claudeCompactPrompt(record);
    // A typed prompt does not close a background child, so its id moves to the new turn.
    const openChildren = state.currentTurnOutcome?.openChildren;
    const closedChildren = state.currentTurnOutcome?.closedChildren;
    state.currentTurnOutcome = {
      finished: false,
      error: false,
      interrupted: false,
      endedAt: at,
      startedAt: at,
      ...(openChildren && openChildren.length > 0 ? { openChildren } : {}),
      ...(closedChildren && closedChildren.length > 0 ? { closedChildren } : {}),
    };
    if (state.firstTurnAt === null) {
      state.firstTurnAt = at;
    }
    return;
  }
  const withdrawn = state.currentTurnWithdrawn;
  const queued = withdrawn ? readerQueuedAsk(record) : null;
  if (queued) {
    // Queued prompts after a withdrawn command share an unanswered turn until model work answers them.
    // Later queued prompts join the same turn, including after a process end.
    if (state.openTurn && state.currentTurnQueued) {
      state.currentTurnEndedAt = Math.max(state.currentTurnEndedAt ?? 0, queued.at);
      if (state.currentTurnOutcome) {
        state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, queued.at);
      }
      return;
    }
    openClaudeQueuedTurn(state, queued.at);
    return;
  }
  if (withdrawn && !withdrawn.compact && claudeModelWorks(record)) {
    // Model work after the CLI's own answer stays out of the command. It answers the prompts
    // queued around the command, or else resumes the turn before it, which the answer did not stop.
    state.currentTurnWithdrawn = null;
    const outcome = state.currentTurnOutcome;
    if (
      !state.currentTurnQueued &&
      outcome &&
      withdrawn.localStopAt !== undefined &&
      outcome.processEndedAt === withdrawn.localStopAt
    ) {
      delete outcome.processEndedAt;
    }
  } else if (withdrawn && claudeModelWorks(record)) {
    // Model work after a compaction restores the command turn and carries any queued turn's process end.
    state.currentTurnWithdrawn = null;
    if (state.openTurn && state.openTurnAnswered && !state.currentTurnQueued) {
      state.closedTurns++;
    }
    const queuedEnd = state.currentTurnQueued ? state.currentTurnOutcome?.processEndedAt : undefined;
    restoreClaudeTurn(state, withdrawn);
    if (state.currentTurnOutcome) state.currentTurnOutcome.finished = false;
    if (queuedEnd !== undefined && state.currentTurnOutcome) {
      state.currentTurnOutcome.processEndedAt = Math.max(state.currentTurnOutcome.processEndedAt ?? 0, queuedEnd);
    }
  }
  if (!state.openTurn) {
    return;
  }
  const localAnswer = claudeLocalAnswer(record);
  // An unmatched user-form answer, such as the stdout of `/compact`, reads as an ordinary record.
  if (localAnswer !== null && (withdrawClaudeUsageTurn(state, localAnswer) || record.type !== 'user')) {
    return;
  }
  const notice = taskNotificationText(record);
  if (state.currentTurnOutcome) {
    const held = state.currentTurnOutcome.openChildren ?? [];
    const open = nextOpenChildren(held, record, notice);
    if (open !== held) {
      if (open.length > 0) {
        state.currentTurnOutcome.openChildren = [...open];
      } else {
        delete state.currentTurnOutcome.openChildren;
      }
    }
    const heldClosed = state.currentTurnOutcome.closedChildren ?? [];
    if (notice !== null) {
      state.closedChildIndex ??= indexClosedChildren(heldClosed);
      if (addClosedChildNotice(heldClosed, state.closedChildIndex, notice, claudeRecordAt(record))) {
        state.currentTurnOutcome.closedChildren = heldClosed;
      }
    }
  }
  const processEndedAt = claudeProcessEndedAt(record);
  if (processEndedAt !== null && state.currentTurnOutcome) {
    answerClaudeTurn(state);
    // The process end ends every background child the process held.
    delete state.currentTurnOutcome.openChildren;
    delete state.currentTurnOutcome.closedChildren;
    state.closedChildIndex = undefined;
    state.currentTurnOutcome.processEndedAt = Math.max(state.currentTurnOutcome.processEndedAt ?? 0, processEndedAt);
    return;
  }
  if (notice !== null) {
    if (state.currentTurnOutcome) {
      state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, claudeRecordAt(record));
    }
    return;
  }
  if (record.type === 'user') {
    const at = stamp(record.timestamp);
    if (interruptedATurn(record)) {
      answerClaudeTurn(state);
      state.currentTurnEndedAt = Math.max(state.currentTurnEndedAt ?? 0, at);
      if (state.currentTurnOutcome) {
        state.currentTurnOutcome.interrupted = true;
        state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at);
      }
      return;
    }
    if (state.currentTurnToolEnded && claudeWakeMessage(record) && state.currentTurnOutcome) {
      state.currentTurnOutcome.finished = false;
      state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at);
      state.currentTurnEndedAt = Math.max(state.currentTurnEndedAt ?? 0, at);
      state.currentTurnToolEnded = false;
    }
    if (toolEndedATurn(record) && state.currentTurnOutcome) {
      state.currentTurnOutcome.finished = true;
      state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at);
      state.currentTurnToolEnded = true;
    }
    if (record.toolUseResult && typeof record.toolUseResult === 'object' && state.currentTurnOutcome) {
      state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at);
    }
    return;
  }
  if (record.type !== 'assistant') {
    return;
  }
  const message = record.message as
    | { content?: unknown; usage?: ClaudeUsage; model?: unknown; stop_reason?: unknown }
    | undefined;
  if (failedATurn(record)) {
    const at = stamp(record.timestamp);
    answerClaudeTurn(state);
    state.currentTurnEndedAt = Math.max(state.currentTurnEndedAt ?? 0, at);
    if (state.currentTurnOutcome) {
      state.currentTurnOutcome.error = true;
      state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at);
    }
    return;
  }
  if (message?.model === '<synthetic>') {
    return;
  }
  const at = stamp(record.timestamp);
  state.currentTurnEndedAt = Math.max(state.currentTurnEndedAt ?? 0, at);
  if (state.currentTurnOutcome) {
    state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at);
  }
  if (claudeModelAnswered(record)) {
    answerClaudeTurn(state);
  }
  if (answeredATurn(record) && state.currentTurnOutcome) {
    state.currentTurnOutcome.error = false;
  }
  // Model work after a result that ended the turn resumes it, unless its own stop reason ends
  // it again. Otherwise a record without a stop reason leaves completion unchanged.
  if (state.currentTurnToolEnded && state.currentTurnOutcome) {
    state.currentTurnOutcome.finished = finishedATurn(record);
    state.currentTurnToolEnded = false;
  } else if (message?.stop_reason && state.currentTurnOutcome) {
    state.currentTurnOutcome.finished = finishedATurn(record);
  }
}

// Recorded Claude response usage in shared token categories.
export function claudeUsage(usage: ClaudeUsage): TurnUsage {
  const created = usage.cache_creation as
    | { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
    | undefined;
  const total1h = created?.ephemeral_1h_input_tokens ?? 0;
  const total5m = created?.ephemeral_5m_input_tokens ?? 0;
  return {
    requests: 1,
    input: usage.input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    // An unsplit cache-creation total uses the one-hour pricing category without establishing a recorded cache lifetime.
    cacheWrite1h: total1h || (total5m ? 0 : usage.cache_creation_input_tokens || 0),
    cacheWrite5m: total5m,
    cacheWrite30m: 0,
    output: usage.output_tokens || 0,
    thinking: (usage.output_tokens_details as { thinking_tokens?: number } | undefined)?.thinking_tokens ?? 0,
  };
}

// Recorded single cache-write lifetime, or null for no write, unsplit writes, or mixed tiers.
export function claudeCacheLifetime(usage: ClaudeUsage): CacheLifetime | null {
  const created = usage.cache_creation as
    | { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
    | undefined;
  const hour = created?.ephemeral_1h_input_tokens;
  const short = created?.ephemeral_5m_input_tokens;
  // Mixed cache-write tiers establish no single lifetime.
  if (hour && short) {
    return null;
  }
  if (hour) {
    return '1h';
  }
  if (short) {
    return '5m';
  }
  return null;
}

// One recorded Claude response split by `usage.iterations`. The top-level fields count the
// executor's passes only, and their cache-write split can omit the writes of a later pass.
interface ClaudeResponseUsage {
  executor: TurnUsage;
  passes: TurnUsage[];
  lifetime: CacheLifetime | null;
  // The first and last executor passes. The last one read the context the response ended on.
  first: TurnUsage;
  last: TurnUsage;
  advisors: { index: number; model: string | null; usage: TurnUsage }[];
  // An iteration of a type this reader does not price.
  unknownIterations: boolean;
}

function claudeResponseUsage(usage: ClaudeUsage): ClaudeResponseUsage {
  const iterations = Array.isArray(usage.iterations) ? (usage.iterations as unknown[]) : [];
  const passes: ClaudeUsage[] = [];
  const advisors: ClaudeResponseUsage['advisors'] = [];
  let unknownIterations = false;
  iterations.forEach((iteration, index) => {
    const item =
      iteration && typeof iteration === 'object' ? (iteration as ClaudeUsage & Record<string, unknown>) : null;
    if (item?.type === 'message') {
      passes.push(item);
    } else if (item?.type === 'advisor_message') {
      advisors.push({
        index,
        model: typeof item.model === 'string' && item.model ? item.model : null,
        usage: claudeUsage(item),
      });
    } else {
      unknownIterations = true;
    }
  });
  if (!passes.length) {
    const counted = claudeUsage(usage);
    const lifetime = claudeCacheLifetime(usage);
    return {
      executor: counted,
      passes: [counted],
      lifetime,
      first: counted,
      last: counted,
      advisors,
      unknownIterations,
    };
  }
  const counted = passes.map(claudeUsage);
  const executor: TurnUsage = {
    requests: 1,
    input: 0,
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    output: 0,
    // The top-level output detail is the executor's own, and passes need not repeat it.
    thinking: claudeUsage(usage).thinking,
  };
  for (const pass of counted) {
    executor.input += pass.input;
    executor.cacheRead += pass.cacheRead;
    executor.cacheWrite1h += pass.cacheWrite1h;
    executor.cacheWrite5m += pass.cacheWrite5m;
    executor.output += pass.output;
  }
  // Mixed tiers require a first writer with recorded zero reads and a named tier on every write.
  // Later executor passes must read the first writer's full prefix.
  const written = passes.filter((_, index) => counted[index].cacheWrite1h + counted[index].cacheWrite5m > 0);
  const lifetimes = new Set(written.map(claudeCacheLifetime));
  let lifetime = lifetimes.size === 1 ? [...lifetimes][0] : null;
  if (lifetimes.size > 1 && !lifetimes.has(null)) {
    const firstWriter = passes.indexOf(written[0]);
    const prefix = counted[firstWriter];
    if (
      written[0].cache_read_input_tokens === 0 &&
      counted.slice(firstWriter + 1).every((pass) => pass.cacheRead >= prefix.cacheWrite1h + prefix.cacheWrite5m)
    ) {
      lifetime = claudeCacheLifetime(written[0]);
    }
  }
  return {
    executor,
    passes: counted,
    lifetime,
    first: counted[0],
    last: counted[counted.length - 1],
    advisors,
    unknownIterations,
  };
}

function numericUsageField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Nonstandard recorded speed takes precedence over `service_tier`. Standard or absent speed leaves the service tier unchanged.
function claudeServiceTier(usage: ClaudeUsage): string | null {
  const speed = typeof usage.speed === 'string' && usage.speed ? usage.speed : null;
  if (speed && speed !== 'standard') {
    return speed;
  }
  return typeof usage.service_tier === 'string' && usage.service_tier ? usage.service_tier : null;
}

function claudeInferenceClass(value: unknown): UsageInferenceClass {
  if (typeof value !== 'string') {
    return null;
  }
  const geo = value.toLowerCase();
  if (geo === 'global') {
    return 'global';
  }
  if (geo === 'us' || geo === 'us-only' || geo === 'in-region') {
    return 'in-region';
  }
  if (geo === 'not_available' || geo === 'not-available') {
    return null;
  }
  return geo ? 'geo' : null;
}

// Message-ID prefix identifying a Claude request billed through Amazon Bedrock.
const BEDROCK_MESSAGE_PREFIX = 'msg_bdrk_';

function claudeRequestInferenceClass(
  messageId: string | null,
  profile: string | null | undefined,
  geo: unknown,
): UsageInferenceClass {
  if (messageId?.startsWith(BEDROCK_MESSAGE_PREFIX)) {
    return profile?.startsWith('global.') ? null : 'bedrock-regional';
  }
  return claudeInferenceClass(geo);
}

// Every `model` attachment line holds this text. A reader tests for it before it parses a line.
const MODEL_ATTACHMENT_MARK = '"modelId"';

// Keeps the model id a `model` attachment names. True when the record is one.
function noteClaudeModelProfile(state: ClaudeUsageReducerState, record: Record<string, unknown>): boolean {
  const attachment = record.attachment as { type?: unknown; identity?: { modelId?: unknown } } | undefined;
  if (record.type !== 'attachment' || attachment?.type !== 'model') {
    return false;
  }
  const id = attachment.identity?.modelId;
  if (typeof id === 'string' && id) {
    state.modelProfile = id;
  }
  return true;
}

// Composer evidence is independent of the profile retained for request pricing.
export function claudeModelEvidence(
  record: Record<string, unknown>,
  childTranscript = false,
): { kind: 'attachment' | 'assistant'; identity: string | null } | null {
  if (record.isSidechain && !childTranscript) return null;
  const attachment = record.attachment as { type?: unknown; identity?: { modelId?: unknown } } | undefined;
  if (record.type === 'attachment' && attachment?.type === 'model') {
    const id = attachment.identity?.modelId;
    return { kind: 'attachment', identity: typeof id === 'string' && id.trim() ? id : null };
  }
  const message = record.message as { model?: unknown } | undefined;
  if (
    record.type === 'assistant' &&
    !failedATurn(record) &&
    typeof message?.model === 'string' &&
    message.model &&
    message.model !== '<synthetic>'
  )
    return { kind: 'assistant', identity: message.model };
  return null;
}

export interface ClaudeUsageReadOptions {
  // A sidechain record in a parent transcript is a child agent's own line, and the child's
  // own transcript holds the same request. A parent read skips it so that one request is not
  // billed twice. Every record in a child transcript carries the mark, so a read of one
  // prices nothing unless it counts them.
  countSidechain?: boolean;
  // A repeated record for one message id is the same response written again. A parent
  // transcript repeats the finished counts, so the first record is the whole request and
  // every repeat is dropped. A child transcript writes the response while it runs and
  // repeats it as its output grows. The child reader takes every record and keeps the last
  // one for each request.
  emitRepeats?: boolean;
}

interface ClaudeRequestMessage {
  id?: unknown;
  model?: unknown;
  usage?: ClaudeUsage;
}

// The key of the request a billed answer belongs to. Every content block of one response shares it.
function claudeRequestKey(record: Record<string, unknown>, message: ClaudeRequestMessage): string {
  const messageId = typeof message.id === 'string' && message.id ? message.id : null;
  const uuid = typeof record.uuid === 'string' && record.uuid ? record.uuid : null;
  const timestamp = Date.parse(String(record.timestamp ?? ''));
  return `claude:${messageId ?? uuid ?? `${Number.isNaN(timestamp) ? '' : timestamp}:${String(message.model ?? '')}`}`;
}

// Builds the membership set from saved request keys on first use and reuses it afterward.
function seenRequestIndex(state: ClaudeUsageReducerState): Set<string> {
  if (state.seenRequests instanceof Set) {
    return state.seenRequests;
  }
  const index = new Set(state.seenRequestKeys);
  Object.defineProperty(state, 'seenRequests', { value: index, writable: true, configurable: true });
  return index;
}

// The executor request of one parsed Claude transcript record, without its advisor consultations.
// Readers of context, cache and compaction facts take this one.
export function reduceClaudeUsageRecord(
  state: ClaudeUsageReducerState,
  record: Record<string, unknown>,
  opts: ClaudeUsageReadOptions = {},
): UsageEvent | null {
  return reduceClaudeUsageRecordEvents(state, record, opts)[0] ?? null;
}

// Reduces one parsed Claude transcript record into its billed requests: the executor request
// first, then one request per advisor consultation. The caller owns the state, which makes a
// full scan and an appended-chunk scan take exactly the same path.
export function reduceClaudeUsageRecordEvents(
  state: ClaudeUsageReducerState,
  record: Record<string, unknown>,
  opts: ClaudeUsageReadOptions = {},
): UsageEvent[] {
  if (record.type !== 'assistant') {
    return [];
  }
  if (record.isSidechain && opts.countSidechain !== true) {
    return [];
  }
  const message = record.message as ClaudeRequestMessage | undefined;
  const usage = message?.usage;
  if (!usage || message?.model === '<synthetic>') {
    return [];
  }
  const messageId = typeof message.id === 'string' && message.id ? message.id : null;
  const timestamp = Date.parse(String(record.timestamp ?? ''));
  const requestKey = claudeRequestKey(record, message);
  noteClaudeToolCalls(state, record.message as { content?: unknown } | undefined);
  // The first record of a response takes the results read since the last one. A repeat keeps
  // what its first record took.
  let toolResults: string[] | undefined;
  if (!seenRequestIndex(state).has(requestKey)) {
    toolResults = state.pendingToolResults?.length ? state.pendingToolResults : undefined;
    state.pendingToolResults = [];
  } else toolResults = state.requestEvents?.[requestKey]?.toolResults;
  if (opts.emitRepeats !== true) {
    // Parent reads retain every billed request key because content-block repeats can follow many unrelated requests.
    const seen = seenRequestIndex(state);
    if (seen.has(requestKey)) {
      return [];
    }
    seen.add(requestKey);
    state.seenRequestKeys.push(requestKey);
  }
  const response = claudeResponseUsage(usage);
  const counted = response.executor;
  const inferenceClass = claudeRequestInferenceClass(messageId, state.modelProfile, usage.inference_geo);
  const serviceTier = claudeServiceTier(usage);
  const model = typeof message.model === 'string' && message.model ? message.model : null;
  const bands = response.passes.map((pass) => contextBandForRequest(model, null, requestInputTokens(pass)));
  const contextBand = bands.every((band) => band === bands[0]) ? bands[0] : null;
  if (response.passes.length > 1 && bands.every((band) => band !== null)) {
    counted.byContextBand = {};
    response.passes.forEach((pass, index) => {
      const band = bands[index];
      const contribution = { ...pass, requests: 0, thinking: 0 };
      addUsage((counted.byContextBand![band] ??= emptyUsage()), contribution);
    });
    const finalBand = counted.byContextBand[bands.at(-1)!]!;
    finalBand.requests = 1;
    finalBand.thinking = counted.thinking;
  }
  // Read-only requests retain the preceding lifetime. An unknown writing lifetime clears it.
  // A response with several executor passes starts from its first pass's prefix and ends on its last pass's context.
  const { first, last } = response;
  state.firstRequestCachedTokens ??= first.cacheRead + first.cacheWrite1h + first.cacheWrite5m;
  state.lastRequest = {
    tokens: last.input + last.cacheRead + last.cacheWrite1h + last.cacheWrite5m,
    cacheRead: last.cacheRead,
    cacheWrite: last.cacheWrite1h + last.cacheWrite5m,
    at: Number.isNaN(timestamp) ? null : timestamp,
    lifetime:
      counted.cacheWrite1h + counted.cacheWrite5m > 0 ? response.lifetime : (state.lastRequest?.lifetime ?? null),
    inferenceClass,
    serviceTier,
    model,
  };
  const executor: UsageEvent = {
    timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
    agent: 'claude',
    // Claude records no provider identity on this response. A model family is not proof of
    // the service that billed it.
    provider: null,
    model,
    contextWindow: null,
    // Each executor pass selects its price from its own input length.
    contextBand,
    billingClass: 'unknown',
    inferenceClass,
    serviceTier,
    effort: typeof record.effort === 'string' && record.effort ? record.effort : null,
    toolListVersion: state.toolListVersion ?? 0,
    reportedCost: numericUsageField(usage.cost_usd) ?? numericUsageField(usage.cost),
    // A sidechain response runs under the child agent's own prompt, and this reader counts
    // no visible turn for it. It reports none rather than the parent turn that was open.
    visibleTurnId: record.isSidechain || state.visibleTurns === 0 ? null : `claude-turn:${state.visibleTurns}`,
    cacheLifetime: state.lastRequest.lifetime,
    compactionsBefore: state.compactionCount,
    contextTokens: state.lastRequest.tokens,
    ...(response.passes.length > 1
      ? {
          firstPassUsage: { ...first },
          firstPassContextBand: bands[0],
          finalPassOutputTokens: last.output,
          finalPassCacheRead: last.cacheRead,
        }
      : {}),
    usage: counted,
    requestKey,
    ...(toolResults ? { toolResults: [...toolResults] } : {}),
  };
  // Each consultation bills at its own model's rates. Its key extends the response's key with the
  // iteration's position, so a child read's growing record replaces each one under the same key.
  const advisors = response.advisors.map((advisor): UsageEvent => ({
    ...executor,
    model: advisor.model,
    contextBand: contextBandForRequest(advisor.model, null, requestInputTokens(advisor.usage)),
    reportedCost: null,
    cacheLifetime: null,
    contextTokens: undefined,
    firstPassUsage: undefined,
    firstPassContextBand: undefined,
    finalPassOutputTokens: undefined,
    finalPassCacheRead: undefined,
    usage: advisor.usage,
    requestKey: `${requestKey}:advisor:${advisor.index}`,
    usageOrigin: 'claude-advisor',
    toolResults: undefined,
  }));
  // An iteration type this reader does not price leaves the executor's cost partial.
  if (response.unknownIterations) executor.incomplete = true;
  return [executor, ...advisors];
}

function claudeCompactionPrefixRead(at: number, lifetime: CacheLifetime | null, request: UsageEvent): number | null {
  const first = request.firstPassUsage ?? request.usage;
  if (first.cacheRead > 0) return first.cacheRead;
  // Compaction has its own cache lifetime. A zero read proves an empty prefix only before five minutes expire.
  return lifetime !== null && !cacheLapsedBy(at, '5m', request.timestamp) ? 0 : null;
}

function refineClaudeCompactionEstimate(state: ClaudeUsageReducerState, request: UsageEvent): UsageEvent[] {
  const held = state.pendingCompactionEstimate;
  if (!held || request.compactionEstimate || request.timestamp < held.event.timestamp) return [];
  state.pendingCompactionEstimate = null;
  if (
    request.compactionsBefore !== held.event.compactionsBefore ||
    !state.recentCompactions.some(
      (item) => item.ordinal === held.event.compactionsBefore && item.at === held.event.timestamp,
    )
  )
    return [];
  const prefix = claudeCompactionPrefixRead(
    held.event.timestamp,
    held.input.previousRequest?.lifetime ?? null,
    request,
  );
  if (held.event.compactionSignal) request.compactionSignal = { ...held.event.compactionSignal, prefixTokens: prefix };
  if (prefix === null) return [];
  const usage = compactionEstimate({ ...held.input, postCompactionCacheRead: prefix })?.usage;
  if (!usage) return [];
  if (Object.entries(usage).every(([key, value]) => value === held.event.usage[key as keyof TurnUsage])) return [];
  const negative = removalFor(held.event);
  const positive = {
    ...held.event,
    usage,
    compactionSignal: held.event.compactionSignal
      ? { ...held.event.compactionSignal, prefixTokens: prefix }
      : undefined,
    contextBand: contextBandForRequest(held.event.model, null, requestInputTokens(usage)),
  };
  return [negative, positive];
}

// The estimated request behind a compaction once its summary and its boundary sizes are both
// read, in either order. Null until then, and null when no earlier request names the model that
// ran it. Pairing clears both halves, so neither carries into a later compaction.
function claudeCompactionEstimateEvent(state: ClaudeUsageReducerState): UsageEvent | null {
  const size = state.pendingCompactionSize ?? null;
  const compaction = state.unsizedCompaction ?? null;
  if (!size || !compaction) {
    return null;
  }
  state.pendingCompactionSize = null;
  state.unsizedCompaction = null;
  const previous = compaction.previous;
  if (!previous?.model) {
    return null;
  }
  const at = compaction.at;
  // The timeline sizes a compaction from the request before it when the boundary names no
  // context, so the total does the same.
  const input: CompactionEstimateInput = {
    model: previous.model,
    at,
    durationMs: size.durationMs,
    contextBefore: size.before || previous.tokens,
    contextAfter: size.after,
    previousRequest: previous,
    firstRequestCachedTokens: state.firstRequestCachedTokens ?? null,
    summaryChars: compaction.summaryChars ?? null,
  };
  const usage = compactionEstimate(input)?.usage;
  if (!usage) {
    return null;
  }
  const event: UsageEvent = {
    timestamp: at > 0 ? at : (previous.at ?? 0),
    agent: 'claude',
    provider: null,
    model: previous.model,
    contextWindow: null,
    contextBand: contextBandForRequest(previous.model, null, requestInputTokens(usage)),
    billingClass: 'unknown',
    inferenceClass: previous.inferenceClass ?? null,
    serviceTier: previous.serviceTier ?? null,
    reportedCost: null,
    visibleTurnId: null,
    compactionsBefore: compaction.ordinal,
    compactionEstimate: true,
    compactionSignal: {
      ordinal: compaction.ordinal,
      at: at > 0 ? at : null,
      prefixTokens: Math.min(previous.tokens, state.firstRequestCachedTokens ?? 0),
    },
    usage,
    requestKey: `claude-compaction:${compaction.ordinal}`,
  };
  state.pendingCompactionEstimate = { event, input };
  return event;
}

function acceptsClaudeUsageLine(line: string): boolean {
  // Prompts and turn metadata share the usage pass. Ordinary tool results stay outside JSON parsing.
  const isUser = /"type"\s*:\s*"user"/.test(line);
  const isAssistant = /"type"\s*:\s*"assistant"/.test(line);
  const isProcessEnd = /"type"\s*:\s*"cost-state"/.test(line);
  const isLocalCommand = /"subtype"\s*:\s*"local_command"/.test(line);
  const isCompactionBoundary = /"subtype"\s*:\s*"compact_boundary"/.test(line);
  const isToolDelta = /"type"\s*:\s*"deferred_tools_delta"/.test(line);
  const isModelAttachment = line.indexOf(MODEL_ATTACHMENT_MARK) >= 0;
  // Queued prompts and task notifications also reach the turn reducer through attachment records.
  if (
    !isUser &&
    !isAssistant &&
    !isProcessEnd &&
    !isLocalCommand &&
    !isCompactionBoundary &&
    !isToolDelta &&
    !isModelAttachment &&
    line.indexOf('"queued_command"') < 0 &&
    line.indexOf('task-notification') < 0
  ) {
    return false;
  }
  return !skipsOrdinaryToolResult(line, isUser);
}

export function reduceClaudeUsageLine(
  state: ClaudeUsageReducerState,
  line: string,
  opts: ClaudeUsageReadOptions = {},
): UsageEvent | null {
  return reduceClaudeUsageLineEvents(state, line, opts)[0] ?? null;
}

// The executor request of one line first, then its advisor consultations.
function reduceClaudeUsageLineEvents(
  state: ClaudeUsageReducerState,
  line: string,
  opts: ClaudeUsageReadOptions = {},
): UsageEvent[] {
  noteClaudeToolResultLine(state, line);
  if (!acceptsClaudeUsageLine(line)) {
    return [];
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  // Own-spend reads skip this step. They count cost, and an abandoned compaction still billed.
  followClaudeCompactionLineage(state, record, opts.countSidechain === true);
  reduceClaudeTurnRecord(state, record, opts.countSidechain === true);
  return record.type === 'assistant' ? reduceClaudeUsageRecordEvents(state, record, opts) : [];
}

export interface ClaudeUsageLineReducer {
  nativeChildRequests(): boolean;
  parserKind: 'claude';
  acceptsLine(line: string): boolean;
  pushLine(line: string, end?: number): readonly UsageEvent[];
  snapshot(): ClaudeUsageReducerState;
  turnCount(): number;
  compactionCount(): number;
  recentCompactions(): readonly ReducerCompaction[];
  firstTurnAt(): number | null;
  lastTurnAt(): number | null;
  newestTurnStartedAt(): number | null;
  newestTurnOutcome(): TurnOutcome | null;
}

export interface ClaudeUsageLineReducerOptions {
  childTranscript?: boolean;
  nativeChildRequests?: boolean;
  // Reconciliation owns this state exclusively. Full retention adopts and checkpoints it without copying its history.
  retainAllRequests?: boolean;
}

function copyTurnOutcome(outcome: TurnOutcome | null): TurnOutcome | null {
  return outcome
    ? {
        ...outcome,
        ...(outcome.openChildren ? { openChildren: [...outcome.openChildren] } : {}),
        ...(outcome.closedChildren ? { closedChildren: [...outcome.closedChildren] } : {}),
      }
    : null;
}

// Negates each usage category to remove a prior request event during child-response replacement.
function negativeUsage(usage: TurnUsage): TurnUsage {
  return {
    requests: -(usage.requests ?? 0),
    input: -usage.input,
    cacheWrite1h: -usage.cacheWrite1h,
    cacheWrite5m: -usage.cacheWrite5m,
    cacheWrite30m: -(usage.cacheWrite30m ?? 0),
    cacheRead: -usage.cacheRead,
    output: -usage.output,
    thinking: -usage.thinking,
    ...(usage.byContextBand
      ? {
          byContextBand: Object.fromEntries(
            Object.entries(usage.byContextBand).map(([band, counts]) => [band, negativeUsage(counts)]),
          ),
        }
      : {}),
  };
}

function removalFor(event: UsageEvent): UsageEvent {
  return {
    ...event,
    reportedCost: event.reportedCost === null ? null : -event.reportedCost,
    contextTokens: undefined,
    firstPassUsage: undefined,
    firstPassContextBand: undefined,
    finalPassOutputTokens: undefined,
    finalPassCacheRead: undefined,
    usage: negativeUsage(event.usage),
  };
}

function replaceClaudeUsageEvent(
  state: ClaudeUsageReducerState,
  event: UsageEvent,
  retain = RETAINED_REQUESTS,
): UsageEvent[] {
  if (!event.requestKey) {
    return [event];
  }
  const key = event.requestKey;
  const previous = state.requestEvents?.[key];
  const seen = seenRequestIndex(state);
  const counted = seen.has(key);
  if (counted && !previous) {
    return [];
  }
  state.requestEvents ??= {};
  state.requestEvents[key] = { ...event, usage: { ...event.usage } };
  if (!counted) {
    seen.add(key);
    state.seenRequestKeys.push(key);
  }
  while (state.seenRequestKeys.length > retain) {
    const removed = state.seenRequestKeys.shift();
    if (removed) {
      seen.delete(removed);
      delete state.requestEvents[removed];
    }
  }
  return previous ? [removalFor(previous), event] : [event];
}

export function createClaudeUsageLineReducer(
  restored?: ClaudeUsageReducerState,
  opts: ClaudeUsageLineReducerOptions = {},
): ClaudeUsageLineReducer {
  const restoredKeys = opts.retainAllRequests
    ? (restored?.seenRequestKeys ?? [])
    : [...(restored?.seenRequestKeys ?? [])];
  const state: ClaudeUsageReducerState =
    restored && opts.retainAllRequests
      ? restored
      : restored
        ? {
            ...(restored.costState ? { costState: structuredClone(restored.costState) } : {}),
            seenRequestKeys: restoredKeys,
            closedTurns: restored.closedTurns ?? 0,
            openTurn: restored.openTurn,
            openTurnAnswered: restored.openTurnAnswered,
            compactionCount: restored.compactionCount ?? 0,
            recentCompactions: (restored.recentCompactions ?? []).map((item) => ({ ...item })),
            pendingCompactionTrigger: restored.pendingCompactionTrigger ?? null,
            pendingCompactionSize: restored.pendingCompactionSize ? { ...restored.pendingCompactionSize } : null,
            unsizedCompaction: copyUnsizedCompaction(restored.unsizedCompaction),
            ...(restored.compactionParents ? { compactionParents: [...restored.compactionParents] } : {}),
            ...(restored.pendingCompaction
              ? { pendingCompaction: copyPendingCompaction(restored.pendingCompaction) }
              : {}),
            lastRequest: restored.lastRequest ? { ...restored.lastRequest } : null,
            firstRequestCachedTokens: restored.firstRequestCachedTokens ?? null,
            pendingCompactionEstimate: restored.pendingCompactionEstimate
              ? cloneParserState(restored.pendingCompactionEstimate)
              : null,
            ...(restored.modelProfile ? { modelProfile: restored.modelProfile } : {}),
            ...(restored.toolCalls?.length ? { toolCalls: restored.toolCalls.map((call) => ({ ...call })) } : {}),
            ...(restored.pendingToolResults?.length ? { pendingToolResults: [...restored.pendingToolResults] } : {}),
            ...(restored.seenToolResults?.length ? { seenToolResults: [...restored.seenToolResults] } : {}),
            visibleTurns: restored.visibleTurns ?? 0,
            firstTurnAt: restored.firstTurnAt ?? null,
            currentTurnStartedAt: restored.currentTurnStartedAt ?? null,
            currentTurnEndedAt: restored.currentTurnEndedAt ?? null,
            currentTurnCommand: restored.currentTurnCommand ?? null,
            currentTurnCompact: restored.currentTurnCompact ?? false,
            currentTurnPrevious: copyPreviousTurn(restored.currentTurnPrevious),
            currentTurnWithdrawn: copyPreviousTurn(restored.currentTurnWithdrawn),
            ...(restored.currentTurnQueued ? { currentTurnQueued: true } : {}),
            ...(restored.currentTurnQueuedBefore
              ? { currentTurnQueuedBefore: { ...restored.currentTurnQueuedBefore } }
              : {}),
            ...(restored.currentTurnToolEnded ? { currentTurnToolEnded: true } : {}),
            currentTurnOutcome: copyTurnOutcome(restored.currentTurnOutcome),
            // Only child reads retain request events for replacement. Parent reads discard repeated request keys.
            ...(opts.childTranscript && restored.requestEvents
              ? {
                  requestEvents: {
                    ...retainedRequestEvents(
                      restoredKeys,
                      restored.requestEvents,
                      opts.retainAllRequests ? Number.POSITIVE_INFINITY : RETAINED_REQUESTS,
                    ),
                  },
                }
              : {}),
          }
        : emptyClaudeUsageReducerState();
  return {
    parserKind: 'claude',
    nativeChildRequests: () => opts.childTranscript === true || opts.nativeChildRequests === true,
    acceptsLine: acceptsClaudeUsageLine,
    pushLine: (line, end) => {
      state.costState ??= emptyClaudeCostCapture();
      captureClaudeCostLine(state.costState, line, end);
      const [event, ...advisors] = reduceClaudeUsageLineEvents(
        state,
        line,
        opts.childTranscript ? { countSidechain: true, emitRepeats: true } : {},
      );
      // Only a summary or a boundary completes a pair, and neither line carries a request.
      const estimate = claudeCompactionEstimateEvent(state);
      if (estimate) {
        noteClaudeCostEvent(state.costState, estimate);
        return [estimate];
      }
      // Only the executor request measures the cached prefix that a compaction left.
      if (!event || !opts.childTranscript || !event.requestKey) {
        if (event) noteClaudeCostEvent(state.costState, event);
        const refinements = event ? refineClaudeCompactionEstimate(state, event) : [];
        for (const refinement of refinements) noteClaudeCostEvent(state.costState, refinement);
        for (const advisor of advisors) noteClaudeCostEvent(state.costState, advisor);
        return event ? [...refinements, event, ...advisors] : [];
      }
      const retain = opts.retainAllRequests ? Number.POSITIVE_INFINITY : RETAINED_REQUESTS;
      const events = replaceClaudeUsageEvent(state, event, retain);
      const refinements = events.includes(event) ? refineClaudeCompactionEstimate(state, event) : [];
      events.unshift(...refinements);
      for (const advisor of advisors) events.push(...replaceClaudeUsageEvent(state, advisor, retain));
      for (const accepted of events) noteClaudeCostEvent(state.costState, accepted);
      return events;
    },
    snapshot: () =>
      opts.retainAllRequests
        ? Object.defineProperty(state, 'closedChildIndex', {
            value: state.closedChildIndex,
            writable: true,
            configurable: true,
            enumerable: false,
          })
        : {
            ...(state.costState ? { costState: structuredClone(state.costState) } : {}),
            seenRequestKeys: [...state.seenRequestKeys],
            closedTurns: state.closedTurns,
            openTurn: state.openTurn,
            openTurnAnswered: state.openTurnAnswered,
            compactionCount: state.compactionCount,
            recentCompactions: state.recentCompactions.map((item) => ({ ...item })),
            pendingCompactionTrigger: state.pendingCompactionTrigger ?? null,
            pendingCompactionSize: state.pendingCompactionSize ? { ...state.pendingCompactionSize } : null,
            unsizedCompaction: copyUnsizedCompaction(state.unsizedCompaction),
            ...(state.compactionParents?.length ? { compactionParents: [...state.compactionParents] } : {}),
            ...(state.pendingCompaction ? { pendingCompaction: copyPendingCompaction(state.pendingCompaction) } : {}),
            lastRequest: state.lastRequest ? { ...state.lastRequest } : null,
            firstRequestCachedTokens: state.firstRequestCachedTokens ?? null,
            pendingCompactionEstimate: state.pendingCompactionEstimate
              ? cloneParserState(state.pendingCompactionEstimate)
              : null,
            ...(state.modelProfile ? { modelProfile: state.modelProfile } : {}),
            ...(state.toolCalls?.length ? { toolCalls: state.toolCalls.map((call) => ({ ...call })) } : {}),
            ...(state.pendingToolResults?.length ? { pendingToolResults: [...state.pendingToolResults] } : {}),
            ...(state.seenToolResults?.length ? { seenToolResults: [...state.seenToolResults] } : {}),
            visibleTurns: state.visibleTurns,
            firstTurnAt: state.firstTurnAt,
            currentTurnStartedAt: state.currentTurnStartedAt,
            currentTurnEndedAt: state.currentTurnEndedAt,
            currentTurnCommand: state.currentTurnCommand ?? null,
            currentTurnCompact: state.currentTurnCompact ?? false,
            currentTurnPrevious: copyPreviousTurn(state.currentTurnPrevious),
            currentTurnWithdrawn: copyPreviousTurn(state.currentTurnWithdrawn),
            ...(state.currentTurnQueued ? { currentTurnQueued: true } : {}),
            ...(state.currentTurnQueuedBefore ? { currentTurnQueuedBefore: { ...state.currentTurnQueuedBefore } } : {}),
            ...(state.currentTurnToolEnded ? { currentTurnToolEnded: true } : {}),
            currentTurnOutcome: copyTurnOutcome(state.currentTurnOutcome),
            ...(state.requestEvents ? { requestEvents: { ...state.requestEvents } } : {}),
          },
    turnCount: () => state.closedTurns + (state.openTurn ? 1 : 0),
    compactionCount: () => state.compactionCount,
    recentCompactions: () => state.recentCompactions.map((item) => ({ ...item })),
    firstTurnAt: () => state.firstTurnAt,
    lastTurnAt: () =>
      state.openTurn ? (state.openTurnAnswered ? state.currentTurnEndedAt : state.currentTurnStartedAt) : null,
    newestTurnStartedAt: () => (state.openTurn ? state.currentTurnStartedAt : null),
    newestTurnOutcome: () => copyTurnOutcome(state.currentTurnOutcome),
  };
}

// Reads a Claude source's usage and verified descendants, keeping the latest record for each request.
// Estimated compactions join usage parts. Recorded model totals exclude those estimates.
// Dispatched-source compactions use a separate main-request reducer to match lifetime pricing.
// Descendants contribute spend alone. Artifacts and commits remain the source's own.
// Missing launch metadata, unreadable descendants, and unfinished descendant turns keep spend partial.
export function readClaudeAgentSpend(
  file: string,
  folders: string[] = [],
  childTranscript = true,
  metas: ClaudeSubagentMetaReader = readClaudeSubagentMetas,
): import('./agentspend').AgentSpend {
  return readClaudeSpendTree(file, folders, childTranscript, metas, new Set([normalizeFsPath(file)])).spend;
}

// One subagent as Claude Code records it in `agent-<id>.meta.json`. Every subagent of a session
// sits flat in `<session>/subagents/`, whatever its depth. Only `parentAgentId` names the
// subagent that launched it, and a subagent the session launched itself has none.
export interface ClaudeSubagentMeta {
  id: string;
  file: string;
  toolUseId: string | null;
  parentAgentId: string | null;
}

export type ClaudeSubagentMetaReader = (directory: string) => readonly ClaudeSubagentMeta[];

export function claudeSubagentMetaOf(text: string, id: string, file: string): ClaudeSubagentMeta | null {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const { toolUseId, parentAgentId } = record as { toolUseId?: unknown; parentAgentId?: unknown };
  return {
    id,
    file,
    toolUseId: typeof toolUseId === 'string' && toolUseId ? toolUseId : null,
    parentAgentId: typeof parentAgentId === 'string' && parentAgentId ? parentAgentId : null,
  };
}

// Parsed meta files by path. Claude Code writes a meta file once, when the subagent starts, so a
// parsed file stays true while the folder lists it. A file that does not parse yet is read again.
const subagentMetaFiles = new Map<string, ClaudeSubagentMeta>();
const SUBAGENT_META_LIMIT = 5000;

export function readClaudeSubagentMetas(directory: string): ClaudeSubagentMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const metas: ClaudeSubagentMeta[] = [];
  for (const name of names) {
    const match = /^agent-(.+)\.meta\.json$/.exec(name);
    if (!match) {
      continue;
    }
    const metaFile = path.join(directory, name);
    let meta = subagentMetaFiles.get(metaFile);
    if (!meta) {
      let text: string;
      try {
        const bytes = fs.readFileSync(metaFile);
        meterRead(metaFile, bytes.length);
        text = bytes.toString('utf8');
      } catch {
        continue;
      }
      meta = claudeSubagentMetaOf(text, match[1], path.join(directory, `agent-${match[1]}.jsonl`)) ?? undefined;
      if (!meta) continue;
      if (subagentMetaFiles.size >= SUBAGENT_META_LIMIT) {
        subagentMetaFiles.clear();
      }
      subagentMetaFiles.set(metaFile, meta);
    }
    metas.push(meta);
  }
  return metas;
}

// Lists each subagent folder once for the life of the reader. One parse of a parent prices many
// rows, and their descendants share one folder.
export function claudeSubagentMetaReader(): ClaudeSubagentMetaReader {
  const held = new Map<string, readonly ClaudeSubagentMeta[]>();
  return (directory) => {
    let metas = held.get(directory);
    if (!metas) {
      metas = readClaudeSubagentMetas(directory);
      held.set(directory, metas);
    }
    return metas;
  };
}

// The subagents one transcript launched. A child transcript's launches name its id as
// `parentAgentId` in the folder it shares with them. A session's own launches sit in
// `<session>/subagents/` and name no launcher.
function claudeDirectSubagents(
  file: string,
  childTranscript: boolean,
  metas: ClaudeSubagentMetaReader,
): ClaudeSubagentMeta[] {
  const base = path.basename(file, path.extname(file));
  const directory = childTranscript ? path.dirname(file) : path.join(path.dirname(file), base, 'subagents');
  const launcher = childTranscript ? base.replace(/^agent-/, '') : null;
  return metas(directory).filter((meta) => meta.parentAgentId === launcher);
}

// The revision of a Claude transcript and of every descendant whose spend its figure includes.
// A nested transcript that appears or grows changes it, even after this transcript stopped.
export function claudeAgentSpendVersion(
  file: string,
  childTranscript = true,
  metas: ClaudeSubagentMetaReader = readClaudeSubagentMetas,
): string {
  const versions = [spendFileVersion(file)];
  const visited = new Set([normalizeFsPath(file)]);
  const visit = (launcher: string, child: boolean): void => {
    for (const meta of claudeDirectSubagents(launcher, child, metas)) {
      const key = normalizeFsPath(meta.file);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      versions.push(`${meta.id}:${spendFileVersion(meta.file)}`);
      visit(meta.file, true);
    }
  };
  visit(file, childTranscript);
  return versions.join('\n');
}

// The version of one child's spend figure. A Claude child's figure includes its nested
// subagents, so its version covers their files too.
export function childSpendVersion(
  agent: AgentKind,
  file: string,
  metas: ClaudeSubagentMetaReader = readClaudeSubagentMetas,
): string {
  return agent === 'claude' ? claudeAgentSpendVersion(file, true, metas) : spendFileVersion(file);
}

// Dependency key for child spend shown by the supplied turns, including structural Codex descendants.
// `versionOf` supplies source revisions. `now` supplies the clock used for running-child refresh bands.
export function agentSpendDependencyKey(
  turns: readonly Pick<Turn, 'agents'>[],
  agentFile: (ref: AgentSpendRef) => string | null,
  versionOf: (file: string) => string,
  structuralKey: string,
  codexChildFiles: readonly string[],
  now: number,
): string {
  const recorded = turns.flatMap((turn) =>
    turn.agents.map((agent) => {
      const ref = {
        id: agent.id,
        name: agent.description,
        path: agent.agentType,
        status: agent.status,
        toolUseId: agent.toolUseId,
      };
      const file = agentFile(ref);
      // Running children use refresh bands. After a band of silence, their exact source versions apply.
      return file
        ? `${file}:${childSpendRevisionKey(ref.status, versionOf(file), now)}`
        : `${ref.id || ref.path || ref.name}:${agentSpendIsOpen(ref.status) ? 'open:none' : 'missing'}`;
    }),
  );
  return (
    [...recorded, ...(structuralKey ? [structuralKey] : [])].join('\n') +
    codexChildFiles
      .map((file) => `\n${file}:${childSpendRevisionKey('completed', versionOf(file), now)}`)
      .sort()
      .join('')
  );
}

type ClaudeSpendRecord = Pick<
  import('./agentspend').AgentSpend,
  'artifacts' | 'startedAt' | 'endedAt' | 'toolUses' | 'commits' | 'commitIntents' | 'person'
>;

// One transcript's own spend, before the spend of the subagents it launched is added. The fold
// copies from it and never changes it.
interface ClaudeOwnSpend {
  revision: string;
  found: boolean;
  byModel: [string | null, TurnUsage][];
  // The heaviest model of this transcript's own requests, without advisor consultations.
  executorModel: string | null;
  usageParts: TurnUsagePart[];
  // Retained subagent launch IDs. Failed launch results remove their IDs before metadata matching.
  launches: string[];
  partial: boolean;
  effort: string | null;
  finished: boolean;
  record: ClaudeSpendRecord | null;
  // The summed request timing of this transcript's own turns. A subagent read and a dispatched read carry it. A nested read does not.
  outputRate?: OutputRate;
  outputRateModel?: string;
  // Every request behind `byModel` and `usageParts`, kept only for a child transcript.
  requests?: UsageEvent[];
}

// Own spend by file and parse inputs, checked against the file's own revision. A write to one
// nested subagent then reads that subagent's file again, and no other file in its tree.
const claudeOwnSpends = new Map<string, ClaudeOwnSpend>();
const CLAUDE_OWN_SPEND_LIMIT = 500;

function readClaudeOwnSpend(
  file: string,
  folders: string[],
  childTranscript: boolean,
  withRecord: boolean,
): ClaudeOwnSpend {
  const key = [normalizeFsPath(file), childTranscript, withRecord, ...folders].join('\n');
  const revision = spendFileVersion(file);
  const held = claudeOwnSpends.get(key);
  if (held?.revision === revision) {
    claudeOwnSpends.delete(key);
    claudeOwnSpends.set(key, held);
    return held;
  }
  // Emit repeated usage records so replacement retains the latest cumulative counts per request.
  const usageState = emptyClaudeUsageReducerState();
  const launches = new Set<string>();
  const failedToolUses = new Set<string>();
  let partial = false;
  let effort: string | null = null;
  let lastLine = '';
  const estimates: UsageEvent[] = [];
  const compactionState = emptyClaudeUsageReducerState();
  const compactionOptions: ClaudeUsageReadOptions = childTranscript ? { countSidechain: true, emitRepeats: true } : {};
  // Collect dispatched-session reader evidence during the same complete source scan.
  const person: PersonScan | null =
    withRecord && !childTranscript
      ? { bytes: 0, person: false, prompts: 0, bg: false, start: 0, userBefore: false }
      : null;
  const child = createClaudeSessionReducer(path.basename(file, path.extname(file)), {
    childTranscript,
    folders,
    maxTurns: Number.MAX_SAFE_INTEGER,
  });
  const sourceStamp = commitSourceStamp(file);
  const repeated = createClaudeRepeatedFilter();
  const found = scanLines(file, (line) => {
    if (repeated(line)) {
      return;
    }
    child.pushLine(line);
    if (line.trim()) {
      lastLine = line;
    }
    // A user line holds tool results, which the next request reads, as the spend ledger counts them.
    noteClaudeToolResultLine(usageState, line);
    if (person && !person.person && mayHoldPersonSign(line, person)) {
      try {
        person.person = personSpokeIn(JSON.parse(line), person);
      } catch {
        /* a cut line is no sign */
      }
    }
    if (line.indexOf('"type":"assistant"') < 0) {
      // Both states price requests, so both read the profile each `model` attachment names.
      if (line.indexOf(MODEL_ATTACHMENT_MARK) >= 0 || (line.includes('"attachment"') && line.includes('"model"'))) {
        let record: Record<string, unknown> | null = null;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          /* a cut line names no profile */
        }
        if (record && (!record.isSidechain || childTranscript) && noteClaudeModelProfile(usageState, record)) {
          compactionState.modelProfile = usageState.modelProfile;
          return;
        }
      }
      const failure = /"is_error"\s*:\s*true/.test(line);
      const compaction = /"subtype"\s*:\s*"compact_boundary"|"isCompactSummary"\s*:\s*true/.test(line);
      if (!failure && !compaction) {
        return;
      }
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (failure) {
        const content = (record.message as { content?: unknown } | undefined)?.content;
        for (const block of Array.isArray(content) ? content : []) {
          const item = block as { type?: string; tool_use_id?: unknown; is_error?: unknown };
          if (item.type === 'tool_result' && item.is_error === true && typeof item.tool_use_id === 'string') {
            failedToolUses.add(item.tool_use_id);
          }
        }
      }
      if (!compaction) {
        return;
      }
      // The spend reducer pairs a summary with its boundary, and the second half emits the estimate.
      reduceClaudeTurnRecord(compactionState, record, childTranscript);
      const estimate = claudeCompactionEstimateEvent(compactionState);
      if (estimate) {
        estimates.push(estimate);
      }
      return;
    }
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const message = o.message as { id?: string; model?: string; usage?: ClaudeUsage; content?: unknown } | undefined;
    const request = reduceClaudeUsageRecord(compactionState, o, compactionOptions);
    if (request) estimates.push(...refineClaudeCompactionEstimate(compactionState, request));
    if (failedATurn(o) || message?.model === '<synthetic>') {
      return;
    }
    effort = typeof o.effort === 'string' && o.effort ? o.effort : effort;
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      const item = block as { type?: string; name?: string; id?: unknown };
      if (item.type !== 'tool_use' || item.name !== 'Agent') {
        continue;
      }
      // A launch with no id cannot be matched to a meta file, so its spend stays unknown.
      if (typeof item.id === 'string' && item.id) {
        launches.add(item.id);
      } else {
        partial = true;
      }
    }
    for (const event of reduceClaudeUsageRecordEvents(usageState, o, { countSidechain: true, emitRepeats: true })) {
      replaceClaudeUsageEvent(usageState, event, Number.POSITIVE_INFINITY);
    }
  });
  const byRequest = Object.values(usageState.requestEvents ?? {});
  const byModel = new Map<string | null, TurnUsage>();
  // The row names the model this transcript ran, so an advisor consultation never answers.
  const byExecutorModel = new Map<string | null, TurnUsage>();
  for (const request of byRequest) {
    addModelUsage(byModel, request.model, request.usage, request.contextBand);
    if (!request.usageOrigin) addModelUsage(byExecutorModel, request.model, request.usage, request.contextBand);
  }
  const exact = { usageParts: [] as TurnUsagePart[] };
  for (const request of [...byRequest, ...estimates]) {
    addTurnUsagePart(exact, request);
  }
  const childTurns = child.finish().turns;
  if (found && lastLineWhole(lastLine)) bindCommitSources(childTurns, file, sourceStamp);
  // Only the root read of a row sums its turns, so a nested subagent adds spend and no time.
  // The root is a subagent or a dispatched session, because only those reads ask for a record.
  const measured = withRecord ? summedTurnRate(childTurns) : undefined;
  let record: ClaudeSpendRecord | null = null;
  if (withRecord) {
    const span = childTurnSpan(childTurns);
    const startedAt = span.startedAt ?? null;
    // Keep the first turn's last activity within the displayed span, even when its process ended earlier.
    const firstEndedAt = childTurns[0]?.endedAt;
    const endedAt = firstEndedAt ? Math.max(span.endedAt ?? firstEndedAt, firstEndedAt) : (span.endedAt ?? null);
    const toolUses = childTurns.reduce((total, turn) => total + turn.stepCount, 0);
    const commits: TurnCommit[] = [];
    for (const commit of childTurns.flatMap((turn) => turn.commits)) {
      if (!commits.some((kept) => sameCommitSha(kept.sha, commit.sha))) {
        commits.push(commit);
      }
    }
    const commitIntents = childTurns.flatMap((turn) => turn.commitIntents ?? []);
    const artifacts = reduceChildArtifacts(
      { turns: childTurns },
      {
        revision,
        complete: lastLineWhole(lastLine),
        pathKey: normalizeFsPath,
        sameCommit: sameCommitSha,
      },
    );
    record = {
      artifacts,
      ...(childTranscript ? {} : { startedAt, endedAt, toolUses }),
      ...(commits.length ? { commits } : {}),
      ...(commitIntents.length ? { commitIntents } : {}),
      ...(person?.person ? { person: true } : {}),
    };
  }
  const own: ClaudeOwnSpend = {
    revision,
    found,
    byModel: [...byModel],
    executorModel: heaviestModel(modelSpends(byExecutorModel)),
    usageParts: exact.usageParts,
    launches: [...launches].filter((id) => !failedToolUses.has(id)),
    partial,
    effort,
    finished: childTurns.at(-1)?.finished === true,
    record,
    ...measured,
    ...(childTranscript ? { requests: [...byRequest, ...estimates] } : {}),
  };
  claudeOwnSpends.delete(key);
  claudeOwnSpends.set(key, own);
  while (claudeOwnSpends.size > CLAUDE_OWN_SPEND_LIMIT) {
    const oldest = claudeOwnSpends.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    claudeOwnSpends.delete(oldest);
  }
  return own;
}

// A nested subagent adds only its spend, so its read skips the artifacts and commits a row keeps.
function readClaudeSpendTree(
  file: string,
  folders: string[],
  childTranscript: boolean,
  metas: ClaudeSubagentMetaReader,
  visited: Set<string>,
  withRecord = true,
): { spend: import('./agentspend').AgentSpend; finished: boolean } {
  const own = readClaudeOwnSpend(file, folders, childTranscript, withRecord);
  if (!own.found) {
    return { spend: { models: [], found: false, partial: false, effort: null }, finished: own.finished };
  }
  let partial = own.partial;
  const byModel = new Map(structuredClone(own.byModel));
  const usageParts = structuredClone(own.usageParts);
  const requests = [...(own.requests ?? [])];
  if (own.launches.length) {
    const children = claudeDirectSubagents(file, childTranscript, metas);
    if (own.launches.some((id) => !children.some((meta) => meta.toolUseId === id))) {
      partial = true;
    }
    for (const meta of children) {
      const key = normalizeFsPath(meta.file);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      const nested = readClaudeSpendTree(meta.file, folders, true, metas, visited, false);
      if (!nested.spend.found || nested.spend.partial || !nested.finished) {
        partial = true;
      }
      for (const spend of nested.spend.models) {
        addModelUsage(byModel, spend.model, spend.usage);
        for (const part of spend.usageParts ?? []) {
          addPricedUsagePart(usageParts, part);
        }
      }
      for (const request of nested.spend.requests ?? []) requests.push(request);
    }
  }
  // Model totals leave out estimated compactions, so a model that only an estimate used keeps a
  // zero total and its usage parts still price.
  for (const part of usageParts) {
    if (part.compactionEstimate && !byModel.has(part.model)) byModel.set(part.model, emptyUsage());
  }
  const models = [...byModel].flatMap(([model, usage]) => {
    const held = usageParts.filter((part) => part.model === model);
    return usageTokens(usage) > 0 || held.some((part) => part.compactionEstimate)
      ? [{ model, usage, usageParts: held }]
      : [];
  });
  const record = own.record ? structuredClone(own.record) : {};
  // Descendant spend remains partial until its own record supplies a closed last turn.
  // The row names the model this transcript ran, so a nested subagent's heavier model never answers.
  const ownModel = own.executorModel;
  // Only this transcript's own turns are timed. A nested subagent adds spend and never time.
  const rate =
    own.outputRate && own.outputRateModel
      ? { outputRate: { ...own.outputRate }, outputRateModel: own.outputRateModel }
      : {};
  return {
    spend: {
      models,
      ownModel,
      found: true,
      partial,
      effort: own.effort,
      ...rate,
      ...record,
      ...(childTranscript ? { requests } : {}),
    },
    finished: own.finished,
  };
}

// Turns in the tail of one session transcript, oldest first.
export function readTurns(file: string, sessionId: string, opts: ReadOptions = {}): Turn[] {
  return readSession(file, sessionId, { ...opts, turnsOnly: true }).turns;
}

// One head read of a Claude transcript. `size` is the file size when the read began.
interface FirstRequestRead {
  dev: number;
  ino: number;
  size: number;
  cacheRead: number | null;
}

// Head reads by transcript path and read kind, oldest first.
const firstRequestReads = new Map<string, FirstRequestRead>();
const FIRST_REQUEST_READS_KEPT = 512;

// First request's cache read plus cache write, scanned with the shared usage reducer.
// Reuse an answer while device and inode match and the file has not shrunk.
// A missing-request answer is read again after growth. Other same-identity rewrites are not detected by these checks.
export function claudeFirstRequestCachedTokens(file: string, childTranscript = false): number | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${childTranscript ? 'child' : 'main'}:${file}`;
  const held = firstRequestReads.get(key);
  if (
    held &&
    held.dev === stat.dev &&
    held.ino === stat.ino &&
    stat.size >= held.size &&
    (held.cacheRead !== null || stat.size === held.size)
  ) {
    return held.cacheRead;
  }
  const cacheRead = scanClaudeFirstRequestCacheRead(file, childTranscript);
  firstRequestReads.delete(key);
  if (firstRequestReads.size >= FIRST_REQUEST_READS_KEPT) {
    firstRequestReads.delete(firstRequestReads.keys().next().value as string);
  }
  firstRequestReads.set(key, { dev: stat.dev, ino: stat.ino, size: stat.size, cacheRead });
  return cacheRead;
}

function scanClaudeFirstRequestCacheRead(file: string, childTranscript: boolean): number | null {
  const state = emptyClaudeUsageReducerState();
  const opts: ClaudeUsageReadOptions = childTranscript ? { countSidechain: true, emitRepeats: true } : {};
  scanLines(file, (line) => {
    if (!/"type"\s*:\s*"assistant"/.test(line)) {
      return false;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    reduceClaudeUsageRecord(state, record, opts);
    return state.firstRequestCachedTokens != null;
  });
  return state.firstRequestCachedTokens ?? null;
}

// Gives each Claude compaction the cache read plus cache write of its transcript's first request. A tail read
// never sees that request on a large transcript, so the head of the file answers it, as the spend
// index answers it for the session total. Only a compaction with a request before it asks, and
// only when it does not carry the answer already.
export function withClaudeFirstRequest(file: string, compactions: Compaction[], childTranscript = false): void {
  const asking = compactions.filter(
    (compaction) => compaction.previousRequest && compaction.firstRequestCachedTokens === undefined,
  );
  if (!asking.length) {
    return;
  }
  const read = claudeFirstRequestCachedTokens(file, childTranscript);
  if (read === null) {
    return;
  }
  for (const compaction of asking) {
    compaction.firstRequestCachedTokens = read;
  }
}

// Turns and compactions in the tail of one session transcript, each oldest first.
export function readSession(file: string, sessionId: string, opts: ReadOptions = {}): SessionRead {
  const tailBytes = opts.tailBytes ?? 4 * 1024 * 1024;
  const tail = claudeTailOf(file, tailBytes, opts.prepareNewestTurnDiscovery === true, opts.boundedRepeated === true);
  const read = readSessionLines(tail.lines, sessionId, opts, tail.readBytes, tail.offset);
  if (!opts.turnsOnly) {
    withClaudeFirstRequest(file, read.compactions, opts.childTranscript === true);
  }
  if (opts.prepareNewestTurnDiscovery && !tail.whole && tail.cursor && sessionTurnStartsIn(tail.lines).length === 0) {
    read.newestTurnCursor = tail.cursor;
  }
  return read;
}

// Finds the newest typed prompt before the cursor that draws a card. A command the CLI answered
// by itself draws none, so discovery passes over it. `newer` holds the lines after the cursor,
// oldest first, and they can hold the answer to a command before the cursor.
export function discoverClaudeNewestTurn(
  file: string,
  cursor: BackwardLineCursor,
  options: BoundaryDiscoveryOptions = {},
  newer: readonly string[] = [],
): Promise<BoundaryDiscovery> {
  const segment: ClaudeBackwardSegment = { answers: new Set(), answered: false, kept: false };
  for (let index = newer.length - 1; index >= 0; index -= 1) {
    claudeBackwardBoundary(segment, newer[index]);
  }
  const skip = claudeRepeatedClassifier(file, cursor.revision.size);
  return discoverBackwardBoundary(
    file,
    cursor,
    (line) => !skip(line.offset, line.text) && claudeBackwardBoundary(segment, line.text),
    options,
  );
}

// What a backward walk has seen since the newest typed prompt it passed, which is everything
// recorded after the next older prompt.
interface ClaudeBackwardSegment {
  // Parent record IDs of the CLI's own command answers.
  answers: Set<string>;
  answered: boolean;
  // Whether model work or a process end before an answer, or a queued prompt, keeps the prompt a turn.
  kept: boolean;
}

// Whether a line, read newest first, is a typed prompt that draws a card. A prompt the CLI
// answered by itself draws none, unless model work or a process end came before the answer or a
// prompt was queued after it.
function claudeBackwardBoundary(segment: ClaudeBackwardSegment, text: string): boolean {
  const prompt = humanPromptIn(text, false);
  if (prompt) {
    const id = claudeRecordId(prompt);
    const withdrawn = !segment.kept && id !== null && segment.answers.has(id);
    segment.answers.clear();
    segment.answered = false;
    segment.kept = false;
    return !withdrawn;
  }
  if (
    segment.kept ||
    (text.indexOf('"type":"assistant"') < 0 &&
      text.indexOf('<local-command-std') < 0 &&
      text.indexOf('[Request interrupted by user') < 0 &&
      text.indexOf('"queued_command"') < 0 &&
      text.indexOf('"cost-state"') < 0 &&
      text.indexOf('"local_command"') < 0)
  ) {
    return false;
  }
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!o || typeof o !== 'object' || o.isSidechain) {
    return false;
  }
  const answer = claudeLocalAnswer(o);
  if (answer) {
    segment.answers.add(answer.parent);
    segment.answered = true;
  } else if (
    (o.type === 'attachment' && readerQueuedAsk(o)) ||
    (segment.answered && (claudeModelWorks(o) || claudeProcessEndedAt(o) !== null))
  ) {
    segment.kept = true;
  }
  return false;
}

interface RecordedTitleState {
  title: string;
  fullTitle: string | null;
  start: number;
  end: number;
  at: number | null;
}

export interface ClaudeSessionParserState {
  version: 11;
  // Text that subagents returned into this session's context since the newest compaction.
  subagents: SubagentContextState;
  turns: Turn[];
  turnRanges: Array<{ start: number; end: number }>;
  turnMembershipStarts: number[];
  compactions: Compaction[];
  compactionRanges: Array<{ start: number; end: number }>;
  compactionMetadataRanges: Array<{ start: number; end: number } | null>;
  compactionValueSources: Array<{
    context: { start: number; end: number } | null;
    model: { start: number; end: number } | null;
    // Source range of the previous request, when retained in the checkpoint.
    previous?: { start: number; end: number } | null;
  }>;
  turnLimitReached: boolean;
  // The newest discarded prompt proves whether advancing the tail removed every overflow.
  turnLimitStart: number | null;
  lastContext: number;
  // Latest recorded cache-write lifetime, retained across subsequent requests without a new lifetime.
  lastLifetime: CacheLifetime | null;
  lastContextSource: { start: number; end: number } | null;
  // The request that set lastContext, for the compaction that follows it.
  lastContextRequest?: ContextRequest | null;
  // Cached-read and cache-write counts for the context request, when retained in the checkpoint.
  lastContextCache?: { read: number; write: number } | null;
  lastModel: string | null;
  lastModelSource: { start: number; end: number } | null;
  currentModelSource: { start: number; end: number } | null;
  // Latest applied model attachment, cleared by a different reply model or skipped source bytes.
  modelAttachment: string | null;
  attachmentBoundary: { open: boolean; model: string | null; turns: number[] };
  compactMeta: Array<{ at: number; data: CompactMetadata; start: number; end: number }>;
  launched: Map<string, TurnAgent>;
  toolNames: Map<string, string>;
  stepById: Map<string, TurnStep>;
  // Every skill load a later record can still revise, keyed by the call id that loaded it.
  // Two records revise one: a result that came back as an error withdraws the load, and the
  // record carrying the skill's own instructions supplies the file it read them from.
  skillUseById: Map<string, { use: TurnSkillUse; owner: Turn | SourcedBuilding }>;
  // Typed skill command awaiting the next admitted record.
  // A meta user record with the skill base directory establishes the load. Any other admitted record clears it.
  pendingTypedSkill: { name: string; sourceId: string; at: number } | null;
  // Handback sender IDs retained across turns, with whether a completed reply answered each one.
  // A later completion notice repeats only after such a reply and without intervening tool work.
  // `repeatNotice` tracks that wake. `repeatReplyId` joins blocks of its completed message until another message arrives.
  // Prompts, peer messages, notices, and tool work clear the active repeat state as applicable.
  handbacks: Map<string, boolean>;
  // Whether this agent, as a subagent, delivered its report through a `SubagentHandback`
  // call since the newest prompt, peer message or coordinator message. A reply it writes after
  // that call is a receipt for the report and never the response.
  handedBack: boolean;
  // The index in the current turn's `answers` of the newest closing reply that is a response,
  // written since the newest prompt, peer message, coordinator message or `SubagentHandback`
  // call. A hand-back compares its report with this reply only, or null when there is none.
  closingReply: number | null;
  repeatNotice: boolean;
  repeatReplyId: string | null;
  workedSinceReply: boolean;
  toolOwnerById: Map<string, Turn | SourcedBuilding>;
  narrationOrdinals: Map<string, number>;
  awaited: TurnStep[];
  calls: Map<string, CommandCall>;
  // Child edit-call figures retained until the result arrives. Input text is not retained.
  editCalls: Map<string, PendingFileEdit>;
  // The newest tool result seen so far, and the record that issued the call it answered. A
  // result closes the window of a call issued before its own call, and of no other.
  lastResultAt: number;
  lastResultCallAt: number;
  // The calls whose result is read whatever it printed: a command that wrote to the
  // repository, by saying `git commit` or `git merge`, and, on a child read, any command that
  // ran git and any edit whose change is only in its own input.
  wrote: Set<string>;
  usageState: ClaudeUsageReducerState;
  // Send times of recent `api-request` records, keyed by request id.
  requestTimes: Map<string, number>;
  // Recent responses of this transcript's own thread, keyed by message id, for request-timed output rates.
  responseTimings: Map<string, ClaudeResponseTiming>;
  cur: SourcedBuilding | null;
  // The id of the typed record that opened `cur`, and whether a local command answer that
  // names it has finished `cur`. Such a turn is no turn. It closes with no card, and a process
  // end goes to the newest card instead. Later model work makes it a turn only when
  // `curCompacted` says a manual compaction withdrew it. Otherwise that work answers the prompts
  // queued around the command, or reopens the newest card when its source start equals
  // `curPrevious`, the start of the turn before the command.
  curCommand: string | null;
  curLocalAnswer: boolean;
  curCompacted: boolean;
  // A compaction after a response of the open turn, which that turn holds once it responds again.
  curHeldCompaction?: { at: number; turnStart: number } | null;
  curPrevious: number | null;
  // Reader prompts arriving after this command opened prevent manual compaction withdrawal.
  curQueuedSinceOpening: boolean;
  // The unanswered turn that `cur` took in when its prompt was typed, with that turn's source
  // range as plain numbers, because a symbol does not cross the worker boundary. A local
  // command answer hands it back as a card of its own.
  curCarried: { turn: Building; start: number; end: number; membership: number } | null;
  // The stop time a local command answer gave the unanswered card it handed back, while `cur`
  // is that command. Model work in the command clears it from the newest card again.
  curInferredStop?: number | null;
  // Whether a result that ends the turn finished `cur`. A wake or later model work in the same
  // turn resumes it.
  curToolEnded: boolean;
  queued: TurnAsk[];
  pending: { held: SourcedBuilding | null };
  suppliedTitle: string | null;
  suppliedFullTitle: string | null;
  title: string | null;
  fullTitle: string | null;
  // Which record `title` came from. Null while the title is the supplied one or absent.
  titleSource?: RecordedTitleSource | null;
  // The byte offset of that record, or null when the lines came without offsets.
  titleAt?: number | null;
  // The newest `ai-title`, kept while a custom name outranks it. A blank `custom-title`
  // clears the custom name, and this title names the session again.
  generatedTitle?: RecordedTitleState | null;
  titleRecord: {
    title: string | null;
    fullTitle: string | null;
    start: number;
    end: number;
    source?: RecordedTitleSource;
  } | null;
  // What the retained turns hold on symbol keys and non-enumerable fields, lifted into plain
  // state. `snapshot` writes it, and a reducer built from a restored state puts it back.
  hidden?: HiddenParserState;
}

export interface ClaudeSessionReducer {
  retainedBytes(): number;
  retainedPayloadScan(): Generator<void, number>;
  pushLine(line: string | ParserLine): void;
  trimBefore(offset: number): boolean | void;
  skipped(): void;
  recoverAttachment(identity: string | null): void;
  snapshot(): ClaudeSessionParserState;
  read(readBytes?: number): SessionRead;
  // Finalizes and returns the reducer's owned state without cloning.
  finish(readBytes?: number): SessionRead;
  completedTurns(): Array<{ turn: Turn; start: number; end: number }>;
  completedCompactions(): Array<{ compaction: Compaction; start: number; end: number }>;
  openRange(): { start: number; end: number } | null;
}

function emptyClaudeSessionParserState(opts: ReadOptions): ClaudeSessionParserState {
  const suppliedTitle = normalizeSessionTitle(opts.sessionTitle);
  const suppliedFullTitle = normalizeFullSessionTitle(opts.sessionTitle);
  return {
    version: 11,
    subagents: emptySubagentContext(),
    turns: [],
    turnRanges: [],
    turnMembershipStarts: [],
    compactions: [],
    compactionRanges: [],
    compactionMetadataRanges: [],
    compactionValueSources: [],
    turnLimitReached: false,
    turnLimitStart: null,
    lastContext: 0,
    lastLifetime: null,
    lastContextSource: null,
    lastModel: null,
    lastModelSource: null,
    currentModelSource: null,
    modelAttachment: opts.recoveredModelAttachment ?? null,
    attachmentBoundary: { open: true, model: null, turns: [] },
    compactMeta: [],
    launched: new Map(),
    toolNames: new Map(),
    stepById: new Map(),
    skillUseById: new Map(),
    pendingTypedSkill: null,
    handbacks: new Map(),
    handedBack: false,
    closingReply: null,
    repeatNotice: false,
    repeatReplyId: null,
    workedSinceReply: false,
    toolOwnerById: new Map(),
    narrationOrdinals: new Map(),
    awaited: [],
    calls: new Map(),
    editCalls: new Map(),
    lastResultAt: 0,
    lastResultCallAt: 0,
    wrote: new Set(),
    usageState: emptyClaudeUsageReducerState(),
    requestTimes: new Map(),
    responseTimings: new Map(),
    cur: null,
    curCommand: null,
    curLocalAnswer: false,
    curCompacted: false,
    curHeldCompaction: null,
    curPrevious: null,
    curQueuedSinceOpening: false,
    curCarried: null,
    curInferredStop: null,
    curToolEnded: false,
    queued: [],
    pending: { held: null },
    suppliedTitle,
    suppliedFullTitle,
    title: suppliedTitle,
    fullTitle: suppliedFullTitle,
    titleSource: null,
    titleAt: null,
    titleRecord: null,
  };
}

function emitClaudeTurn(state: ClaudeSessionParserState, turn: SourcedBuilding, maxTurns: number): void {
  const emitted: Turn = { ...turn, files: [...turn.files.values()] };
  // A turn with a request keeps the figure its last request read. A compaction before the next
  // prompt clears the live figure, and it does not change the amount at the end of this turn.
  const subagentContext = turn.contextRequest ? turn.subagentContext : subagentContextFigure(state.subagents);
  if (subagentContext) {
    emitted.subagentContext = subagentContext;
  } else {
    delete emitted.subagentContext;
  }
  const rate = claudeRequestRate(state, emitted);
  if (rate && emitted.model) {
    emitted.outputRate = rate;
    emitted.outputRateModel = emitted.model;
    emitted.outputRateBasis = 'request';
  } else {
    delete emitted.outputRate;
    delete emitted.outputRateModel;
    delete emitted.outputRateBasis;
  }
  consumeClaudeResponseTimings(state, emitted);
  state.turns.push(emitted);
  for (const [id, owner] of state.toolOwnerById) {
    if (owner === turn) {
      state.toolOwnerById.set(id, emitted);
    }
  }
  // Move skill associations to the emitted turn so late failed results also update its copied use count.
  for (const held of state.skillUseById.values()) {
    if (held.owner === turn) {
      held.owner = emitted;
    }
  }
  const range = { start: turn[SOURCE_START] ?? 0, end: turn[SOURCE_END] ?? 0 };
  state.turnRanges.push(range);
  state.turnMembershipStarts.push(turn[MEMBERSHIP_START] ?? range.start);
  if (state.turns.length > maxTurns) {
    state.turns.shift();
    state.turnRanges.shift();
    const removedMembership = state.turnMembershipStarts.shift();
    state.turnLimitReached = true;
    state.turnLimitStart = removedMembership ?? state.turnLimitStart;
  }
}

function retainedClaudeTurns(state: ClaudeSessionParserState): Array<Turn | SourcedBuilding> {
  return [...state.turns, ...(state.cur ? [state.cur] : []), ...(state.pending.held ? [state.pending.held] : [])];
}

function discardClaudeToolAssociation(state: ClaudeSessionParserState, id: string): void {
  state.stepById.delete(id);
  state.toolOwnerById.delete(id);
  state.toolNames.delete(id);
  state.calls.delete(id);
  state.editCalls.delete(id);
}

function boundClaudeToolAssociations(state: ClaudeSessionParserState, capture = false): void {
  if (capture) return;
  if (state.awaited.length > CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN) {
    state.awaited.splice(0, state.awaited.length - CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN);
  }
  const ownerCounts = new Map<Turn | SourcedBuilding, number>();
  for (const owner of state.toolOwnerById.values()) {
    ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
  }
  for (const [id, owner] of state.toolOwnerById) {
    const count = ownerCounts.get(owner) ?? 0;
    if (count <= CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN) {
      continue;
    }
    discardClaudeToolAssociation(state, id);
    ownerCounts.set(owner, count - 1);
  }
  let ownerlessCalls = 0;
  for (const id of state.calls.keys()) {
    if (!state.toolOwnerById.has(id)) {
      ownerlessCalls++;
    }
  }
  let discardOwnerless = ownerlessCalls - CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN;
  if (discardOwnerless <= 0) {
    return;
  }
  for (const id of state.calls.keys()) {
    if (discardOwnerless <= 0) {
      break;
    }
    if (!state.toolOwnerById.has(id)) {
      state.calls.delete(id);
      discardOwnerless--;
    }
  }
}

function pruneClaudeTurnAssociations(state: ClaudeSessionParserState, capture = false): void {
  const retainedTurns = retainedClaudeTurns(state);
  const retainedOwners = new Set<Turn | SourcedBuilding>(retainedTurns);
  const retainedSteps = new Set<TurnStep>(state.awaited);
  const retainedNarration = new Set<string>();
  for (const turn of retainedTurns) {
    for (const step of turn.steps) {
      retainedSteps.add(step);
    }
    for (const update of turn.updates) {
      const match = /^(.*):text:\d+$/.exec(update.sourceId);
      if (match) {
        retainedNarration.add(match[1]);
      }
    }
  }
  for (const [id, owner] of state.toolOwnerById) {
    if (!retainedOwners.has(owner)) {
      state.toolOwnerById.delete(id);
    }
  }
  for (const [id, step] of state.stepById) {
    if (!retainedSteps.has(step) && !state.toolOwnerById.has(id)) {
      state.stepById.delete(id);
    }
  }
  for (const id of state.toolNames.keys()) {
    if (!state.stepById.has(id) && !state.launched.has(id)) {
      state.toolNames.delete(id);
    }
  }
  for (const id of state.calls.keys()) {
    if (!state.stepById.has(id)) {
      state.calls.delete(id);
    }
  }
  for (const id of state.editCalls.keys()) {
    if (!state.stepById.has(id)) {
      state.editCalls.delete(id);
    }
  }
  for (const id of state.narrationOrdinals.keys()) {
    if (!retainedNarration.has(id)) {
      state.narrationOrdinals.delete(id);
    }
  }
  // A load whose turn is gone, and one the turn's own bound dropped, can no longer be
  // revised by anything, so the association goes with it.
  for (const [id, held] of state.skillUseById) {
    if (!retainedOwners.has(held.owner) || !held.owner.skillUses.includes(held.use)) {
      state.skillUseById.delete(id);
    }
  }
  boundClaudeToolAssociations(state, capture);
}

function pruneClaudeAgentAssociations(state: ClaudeSessionParserState): void {
  const retained = new Set<TurnAgent>();
  for (const turn of retainedClaudeTurns(state)) {
    for (const agent of turn.agents) {
      retained.add(agent);
    }
  }
  for (const [id, agent] of state.launched) {
    if (!retained.has(agent)) {
      state.launched.delete(id);
    }
  }
}

function trimClaudeBefore(state: ClaudeSessionParserState, offset: number, maxTurns: number): boolean {
  if (state.turnLimitStart !== null && state.turnLimitStart < offset) {
    state.turnLimitReached = false;
    state.turnLimitStart = null;
  }
  const completedCurrent =
    state.cur && (state.cur.finished || state.cur.interrupted || state.cur.error !== null) ? state.cur : null;
  const currentMembershipStart = state.cur ? (state.cur[MEMBERSHIP_START] ?? state.cur[SOURCE_START] ?? 0) : 0;
  const straddlesCurrentDependency =
    state.cur !== null && (state.cur[SOURCE_START] ?? 0) < offset && currentMembershipStart >= offset;
  if (completedCurrent && (completedCurrent[MEMBERSHIP_START] ?? completedCurrent[SOURCE_START] ?? 0) < offset) {
    state.cur = null;
    state.curCommand = null;
    state.curLocalAnswer = false;
    state.curCompacted = false;
    state.curPrevious = null;
    state.curQueuedSinceOpening = false;
    state.curCarried = null;
    state.curInferredStop = null;
    state.curToolEnded = false;
    state.currentModelSource = null;
    state.awaited = [];
  }
  if (state.lastContextSource && state.lastContextSource.start < offset) {
    state.lastContext = 0;
    state.lastContextSource = null;
    state.lastContextRequest = null;
    state.lastContextCache = null;
  }
  if (state.lastModelSource && state.lastModelSource.start < offset) {
    state.lastModel = null;
    state.lastModelSource = null;
  }
  const retained = state.turns
    .map((turn, index) => ({
      turn,
      range: state.turnRanges[index],
      membershipStart: state.turnMembershipStarts[index] ?? state.turnRanges[index].start,
    }))
    .filter(({ membershipStart }) => membershipStart >= offset);
  const straddlesTurnDependency = retained.some(
    ({ range, membershipStart }) => range.start < offset && membershipStart >= offset,
  );
  state.turns = retained.map(({ turn }) => turn);
  state.turnRanges = retained.map(({ range }) => range);
  state.turnMembershipStarts = retained.map(({ membershipStart }) => membershipStart);
  const compactions = state.compactions
    .map((compaction, index) => ({
      compaction,
      range: state.compactionRanges[index],
      metadataRange: state.compactionMetadataRanges[index] ?? null,
      valueSources: state.compactionValueSources[index] ?? { context: null, model: null },
    }))
    .filter(({ range }) => range.start >= offset);
  for (const { compaction, valueSources } of compactions) {
    if (valueSources.context && valueSources.context.start < offset) {
      compaction.contextBefore = 0;
      valueSources.context = null;
    }
    if (valueSources.model && valueSources.model.start < offset) {
      compaction.model = null;
      valueSources.model = null;
    }
    if (compaction.previousRequest && (!valueSources.previous || valueSources.previous.start < offset)) {
      delete compaction.previousRequest;
      valueSources.previous = null;
    }
  }
  state.compactions = compactions.map(({ compaction }) => compaction);
  state.compactionRanges = compactions.map(({ range }) => range);
  state.compactionMetadataRanges = compactions.map(({ metadataRange }) => metadataRange);
  state.compactionValueSources = compactions.map(({ valueSources }) => valueSources);
  state.compactMeta = state.compactMeta.filter((meta) => meta.start >= offset);
  boundClaudeCompactions(state, maxTurns);
  pruneClaudeAgentAssociations(state);
  pruneClaudeTurnAssociations(state);
  return (
    straddlesCurrentDependency ||
    straddlesTurnDependency ||
    compactions.some(({ metadataRange }) => metadataRange !== null && metadataRange.start < offset)
  );
}

// The first line of the record Claude Code writes after a skill loads, ahead of the skill's
// own instructions. It names the directory the client read them from, and that directory is
// the only place a load's file is recorded: the call names the skill and its result names
// nothing at all.
const CLAUDE_SKILL_BASE_DIRECTORY = 'Base directory for this skill:';

function claudeSkillBaseDirectory(text: string): string {
  if (!text.startsWith(CLAUDE_SKILL_BASE_DIRECTORY)) {
    return '';
  }
  return firstLine(text.slice(CLAUDE_SKILL_BASE_DIRECTORY.length)).trim();
}

// The file the client read, from the directory it recorded. Joined with a forward slash and
// otherwise left exactly as recorded, drive letter and separators included, because what
// opens the row hands this string to the editor as a path.
function claudeSkillFile(directory: string): string {
  return `${directory.replace(/[\\/]+$/, '')}/SKILL.md`;
}

// Marks a `TurnSkillUse` that the typed-command path recorded, so a later `Skill` tool call
// for the same name can tell that use apart from one an earlier `Skill` call recorded. The
// mark stays off the enumerable surface: nothing outside this pairing check reads it.
const TYPED_SKILL_ORIGIN = Symbol('typedSkillOrigin');
type MarkedTurnSkillUse = TurnSkillUse & { [TYPED_SKILL_ORIGIN]?: true };

function recordClaudeSkillUse(
  state: ClaudeSessionParserState,
  turn: SourcedBuilding,
  id: string,
  name: string,
  at: number,
): void {
  // A typed-path load suppresses a same-name Skill call. Other repeated Skill calls retain their own use records.
  if (
    turn.skillUses.some((existing) => existing.name === name && (existing as MarkedTurnSkillUse)[TYPED_SKILL_ORIGIN])
  ) {
    return;
  }
  const use: TurnSkillUse = { sourceId: id, name, at, evidence: 'recorded' };
  addTurnSkillUse(turn, use);
  // Re-keyed rather than overwritten, so the association holds the copy the turn now holds.
  // A reread replaces the use, and a path written onto the replaced object would be written
  // onto a value nothing reads.
  state.skillUseById.delete(id);
  state.skillUseById.set(id, { use, owner: turn });
}

// Records a typed skill command after its admitted successor supplies the base-directory path.
function recordTypedClaudeSkillUse(
  state: ClaudeSessionParserState,
  turn: SourcedBuilding,
  id: string,
  name: string,
  at: number,
  path: string,
): void {
  const use: TurnSkillUse = { sourceId: id, name, path, at, evidence: 'recorded' };
  Object.defineProperty(use, TYPED_SKILL_ORIGIN, { value: true, enumerable: false, configurable: true });
  addTurnSkillUse(turn, use);
  state.skillUseById.delete(id);
  state.skillUseById.set(id, { use, owner: turn });
}

// A load whose call came back as an error loaded nothing, so the turn stops reporting it.
// The call is still a call and keeps its Activity row and its raw tool total.
function withdrawClaudeSkillUse(state: ClaudeSessionParserState, id: string): void {
  const held = state.skillUseById.get(id);
  if (!held) {
    return;
  }
  state.skillUseById.delete(id);
  const index = held.owner.skillUses.indexOf(held.use);
  if (index < 0) {
    return;
  }
  held.owner.skillUses.splice(index, 1);
  held.owner.skillUseCount = Math.max(0, held.owner.skillUseCount - 1);
}

// Applies completion status, child ID, and usage figures to the row identified by its launch call. Unknown launch IDs create no row.
function applyClaudeTaskNotification(
  state: ClaudeSessionParserState,
  raw: string,
  at: number,
  delivery: ClaudeDelivery,
): void {
  const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(raw);
  const task = /<task-id>([^<]+)<\/task-id>/.exec(raw);
  setClaudeRepeatNotice(state, task !== null && state.handbacks.get(task[1]) === true && !state.workedSinceReply);
  // The notice reports this agent's own background work, not a new request, so a reply to it
  // after a `SubagentHandback` call stays a receipt. A later report arrives as a second call.
  const status = /<status>([^<]+)<\/status>/.exec(raw);
  const agent = id ? state.launched.get(id[1]) : undefined;
  // A finished subagent's notice enters context whole, its frame included. A notice whose call
  // launched no subagent, such as a background command, is not subagent text.
  if (status && status[1] !== 'running') {
    if (id && knownSubagentLaunch(state.subagents, id[1])) {
      const key = task?.[1] ?? id[1];
      const frame = raw.includes('<system-reminder>') ? 0 : CLAUDE_NOTICE_FRAME_BYTES;
      const name = agent?.description ?? claudeAgentName(state, key);
      addSubagentResult(
        state.subagents,
        key,
        name,
        estimateClaudeSubagentTokens(raw, frame),
        delivery.form,
        delivery.id,
        raw,
      );
    } else if (raw.includes('<result>')) {
      noteUnqualifiedSubagentResult(state.subagents);
    }
  }
  if (agent && status) {
    agent.status = status[1];
    if (status[1] !== 'running') {
      agent.closedAt = at;
    }
  }
  // Read reported tokens, tools, and duration from the completion notice when present.
  if (agent) {
    agent.id = task ? task[1] : agent.id;
    const tokens = /<subagent_tokens>(\d+)<\/subagent_tokens>/.exec(raw);
    const tools = /<tool_uses>(\d+)<\/tool_uses>/.exec(raw);
    const took = /<duration_ms>(\d+)<\/duration_ms>/.exec(raw);
    if (tokens) {
      agent.tokens = Number(tokens[1]);
    }
    if (tools) {
      agent.toolUses = Number(tools[1]);
      delete agent.toolUsesFromArtifacts;
    }
    if (took) {
      agent.durationMs = Number(took[1]);
    }
  }
  // Finish tool pairing only for a recognized launched row with a nonrunning status.
  if (agent && id && status && status[1] !== 'running') {
    finishClaudeTool(state, id[1], true);
  }
}

// A nested launch's text-only result, applied to the row its launch drew. A background launch
// only names its child here and stays open for its completion notice.
function applyClaudeAgentResultText(
  state: ClaudeSessionParserState,
  id: string,
  content: unknown,
  delivery: ClaudeDelivery,
): void {
  const agent = state.launched.get(id);
  if (!agent) {
    return;
  }
  const result = claudeAgentResultText(content);
  if (result.agentId) {
    agent.id = result.agentId;
  }
  if (result.background) {
    return;
  }
  const text = textOf(content);
  const tokens = estimateClaudeSubagentTokens(text);
  addSubagentResult(state.subagents, agent.id ?? id, agent.description, tokens, 'result', `${delivery.id}:${id}`, text);
  agent.status = 'completed';
  if (result.tokens !== null) {
    agent.tokens = result.tokens;
  }
  if (result.durationMs !== null) {
    agent.durationMs = result.durationMs;
  }
  if (result.toolUses !== null) {
    agent.toolUses = result.toolUses;
    delete agent.toolUsesFromArtifacts;
  }
  finishClaudeTool(state, id, true);
}

function finishClaudeTool(state: ClaudeSessionParserState, id: string, terminalAgent: boolean): void {
  if (terminalAgent) {
    state.launched.delete(id);
  }
  if (terminalAgent || !state.launched.has(id)) {
    state.toolNames.delete(id);
    state.stepById.delete(id);
    state.toolOwnerById.delete(id);
    state.calls.delete(id);
    state.editCalls.delete(id);
  }
}

function boundClaudeCompactions(state: ClaudeSessionParserState, maxTurns: number): void {
  const limit = Math.max(0, Math.floor(maxTurns));
  if (state.compactions.length > limit) {
    const remove = state.compactions.length - limit;
    state.compactions.splice(0, remove);
    state.compactionRanges.splice(0, remove);
    state.compactionMetadataRanges.splice(0, remove);
    state.compactionValueSources.splice(0, remove);
  }
  if (state.compactMeta.length > limit) {
    state.compactMeta.splice(0, state.compactMeta.length - limit);
  }
}

function extendClaudeCompactionMetadataRange(
  state: ClaudeSessionParserState,
  index: number,
  start: number,
  end: number,
): void {
  const range = state.compactionMetadataRanges[index];
  state.compactionMetadataRanges[index] = range
    ? { start: Math.min(range.start, start), end: Math.max(range.end, end) }
    : { start, end };
}

function expireClaudeCompactMetadata(state: ClaudeSessionParserState, at: number): void {
  if (!at) {
    return;
  }
  state.compactMeta = state.compactMeta.filter((meta) => !meta.at || at - meta.at <= COMPACT_META_WINDOW_MS);
}

// A compaction between two responses under one prompt belongs to that turn. The turn's cost then
// holds the compaction's estimated request, as the session total does. The estimate is a usage part
// only, so the turn's token figures keep recorded usage. A compaction before the turn's first
// response or after its last one stays outside every turn.
function chargeHeldClaudeCompaction(state: ClaudeSessionParserState, turn: SourcedBuilding): void {
  const held = state.curHeldCompaction;
  state.curHeldCompaction = null;
  const compaction =
    held && held.turnStart === (turn[SOURCE_START] ?? 0)
      ? state.compactions.find((item) => item.at === held.at)
      : undefined;
  if (!compaction?.model) {
    return;
  }
  const previous = compaction.previousRequest ?? null;
  const usage = compactionEstimate({
    model: compaction.model,
    at: compaction.at,
    durationMs: compaction.durationMs,
    contextBefore: compaction.contextBefore,
    contextAfter: compaction.contextAfter,
    previousRequest: previous,
    firstRequestCachedTokens: compaction.firstRequestCachedTokens ?? state.usageState.firstRequestCachedTokens ?? null,
    postCompactionCacheRead: compaction.postCompactionCacheRead ?? null,
    summaryChars: compaction.summaryChars ?? null,
  })?.usage;
  if (!usage) {
    return;
  }
  const event: UsageEvent = {
    timestamp: compaction.at,
    agent: 'claude',
    provider: null,
    model: compaction.model,
    contextWindow: null,
    contextBand: contextBandForRequest(compaction.model, null, requestInputTokens(usage)),
    billingClass: 'unknown',
    inferenceClass: previous?.inferenceClass ?? null,
    serviceTier: previous?.serviceTier ?? null,
    reportedCost: null,
    visibleTurnId: null,
    compactionEstimate: true,
    usage,
    requestKey: `claude-compaction:${compaction.at}`,
  };
  addTurnUsagePart(turn, event);
}

// Whether the model worked in a turn, or the reader interrupted it.
function claudeModelWorked(turn: SourcedBuilding): boolean {
  return turn.toolUses > 0 || turn.usage.output > 0 || turn.summary !== '' || turn.error !== null || turn.interrupted;
}

// Whether anything answered a turn: the model, an interruption, or the end of the process.
function claudeTurnAnswered(turn: SourcedBuilding): boolean {
  return claudeModelWorked(turn) || turn.processEndedAt !== undefined;
}

// The unanswered card for prompts queued around a command the CLI answered by itself. It takes
// the command's place in the file and holds the queued words alone.
function claudeQueuedCard(command: SourcedBuilding, asks: TurnAsk[]): SourcedBuilding {
  const card: SourcedBuilding = {
    ...command,
    promptId: '',
    startedAt: asks[0].at,
    endedAt: Math.max(...asks.map((ask) => ask.at)),
    prompt: asks.map((ask) => ask.text).join('\n\n'),
    promptParts: asks,
    laterPrompts: [],
    finished: false,
  };
  const start = command[SOURCE_START] ?? 0;
  setSourceRange(card, start, command[SOURCE_END] ?? start);
  setMembershipStart(card, command[MEMBERSHIP_START] ?? start);
  return card;
}

// Returns whether the closed turn became the newest card.
function closeClaudeTurn(state: ClaudeSessionParserState, maxTurns: number): boolean {
  const turn = state.cur;
  if (!turn) {
    return false;
  }
  const localOnly = state.curLocalAnswer && !claudeModelWorked(turn);
  const answered = claudeTurnAnswered(turn);
  let emitted = false;
  state.curCommand = null;
  state.curLocalAnswer = false;
  state.curCompacted = false;
  state.curHeldCompaction = null;
  state.curPrevious = null;
  state.curQueuedSinceOpening = false;
  state.curCarried = null;
  state.curInferredStop = null;
  state.curToolEnded = false;
  if (localOnly) {
    // The CLI answered the command itself, so it leaves no card. Words queued ahead of the
    // command, or behind it, go on a card of their own. The command's own text is the last
    // part. A process end after them stops that card, as it stops an unanswered typed prompt.
    // Otherwise the card waits, unanswered, and the next prompt takes it in as any held card.
    const asks = [
      ...(turn.promptParts ?? []).slice(0, -1),
      ...turn.laterPrompts.map((ask) => ({ ...ask, stepsBefore: 0 })),
    ];
    const card = asks.length > 0 ? claudeQueuedCard(turn, asks) : null;
    if (card && claudeTurnAnswered(card)) {
      emitClaudeTurn(state, card, maxTurns);
      state.pending.held = null;
      emitted = true;
    } else {
      state.pending.held = card;
    }
  } else if (answered) {
    emitClaudeTurn(state, turn, maxTurns);
    state.pending.held = null;
    emitted = true;
  } else {
    state.pending.held = turn;
  }
  state.cur = null;
  state.currentModelSource = null;
  state.awaited = [];
  pruneClaudeAgentAssociations(state);
  pruneClaudeTurnAssociations(state);
  return emitted;
}

// Takes the newest card back as `cur`, so later records extend it as if it never closed.
function reopenClaudeTurn(state: ClaudeSessionParserState): void {
  const emitted = state.turns.pop();
  const range = state.turnRanges.pop();
  const membership = state.turnMembershipStarts.pop();
  if (!emitted || !range) {
    state.cur = null;
    return;
  }
  const turn: SourcedBuilding = {
    ...emitted,
    files: new Map(emitted.files.map((file) => [normalizeFsPath(file.path), file])),
  };
  setSourceRange(turn, range.start, range.end);
  setMembershipStart(turn, membership ?? range.start);
  for (const [id, owner] of state.toolOwnerById) {
    if (owner === emitted) {
      state.toolOwnerById.set(id, turn);
    }
  }
  for (const held of state.skillUseById.values()) {
    if (held.owner === emitted) {
      held.owner = turn;
    }
  }
  state.cur = turn;
}

// Model work after the CLI answered the command by itself. The command draws no card. The work
// answers the prompts queued around the command on a card of their own, or else resumes the turn
// before the command, or belongs to no turn when this read holds none.
function resumeAfterClaudeLocalAnswer(state: ClaudeSessionParserState): void {
  const command = state.cur;
  if (!command) {
    return;
  }
  const asks = [
    ...(command.promptParts ?? []).slice(0, -1),
    ...command.laterPrompts.map((ask) => ({ ...ask, stepsBefore: 0 })),
  ];
  if (asks.length > 0) {
    state.cur = claudeQueuedCard(command, asks);
  } else if (state.curPrevious !== null && state.turnRanges.at(-1)?.start === state.curPrevious) {
    reopenClaudeTurn(state);
  } else {
    state.cur = null;
  }
  state.curCommand = null;
  state.curLocalAnswer = false;
  state.curCompacted = false;
  state.curHeldCompaction = null;
  state.curPrevious = null;
  state.curQueuedSinceOpening = false;
  state.curCarried = null;
  state.curInferredStop = null;
  state.curToolEnded = false;
  state.pendingTypedSkill = null;
}

function settleClaudeSteps(state: ClaudeSessionParserState): void {
  for (const step of state.awaited) {
    if (step.status === 'running') {
      step.status = 'done';
    }
  }
  state.awaited = [];
}

// Returns whether the answer withdrew the open command turn.
function applyClaudeLocalAnswer(
  state: ClaudeSessionParserState,
  answer: { at: number; parent: string },
  sourceStart: number,
  sourceEnd: number,
  maxTurns: number,
  compact = false,
): boolean {
  const cur = state.cur;
  if (
    cur &&
    state.curCommand !== null &&
    answer.parent === state.curCommand &&
    !state.curLocalAnswer &&
    !claudeTurnAnswered(cur)
  ) {
    // A prompt that was still waiting when the command was typed got no reply from it. It
    // becomes its own unanswered card.
    const carried = state.curCarried;
    if (carried) {
      state.curCarried = null;
      const held = carried.turn as SourcedBuilding;
      setSourceRange(held, carried.start, carried.end);
      setMembershipStart(held, carried.membership);
      // Infer an unanswered carried prompt stopped at its own end time. Later command model work can revoke this stop.
      if (
        !compact &&
        !claudeTurnAnswered(held) &&
        !held.finished &&
        held.error === null &&
        !held.interrupted &&
        held.processEndedAt === undefined
      ) {
        held.processEndedAt = held.endedAt;
        state.curInferredStop = held.processEndedAt;
      }
      emitClaudeTurn(state, held, maxTurns);
      state.curPrevious = state.turnRanges.at(-1)?.start ?? null;
      const heldParts = held.promptParts ?? [];
      const own = (ask: TurnAsk) => !heldParts.some((part) => part.text === ask.text && part.at === ask.at);
      const parts = (cur.promptParts ?? []).filter(own);
      cur.promptParts = parts;
      cur.prompt = parts.map((one) => one.text).join('\n\n');
      cur.laterPrompts = cur.laterPrompts.filter(
        (ask) => !held.laterPrompts.some((later) => later.text === ask.text && later.at === ask.at),
      );
      const start = cur[MEMBERSHIP_START] ?? sourceStart;
      setSourceRange(cur, start, Math.max(cur[SOURCE_END] ?? start, start));
    }
    // Keep the answered command for later model work. Without that work, closure omits its card.
    cur.finished = true;
    cur.endedAt = Math.max(cur.endedAt, answer.at);
    state.curLocalAnswer = true;
    state.curCompacted = compact;
    // The local answer clears pending typed-skill evidence.
    state.pendingTypedSkill = null;
    extendSourceRange(cur, sourceStart, sourceEnd);
    return true;
  }
  return false;
}

function reduceClaudeSessionLine(
  state: ClaudeSessionParserState,
  input: string | ParserLine,
  sessionId: string,
  opts: ReadOptions,
): void {
  const line = typeof input === 'string' ? input : input.text;
  const sourceStart = typeof input === 'string' ? 0 : (input.start ?? 0);
  const sourceEnd = typeof input === 'string' ? sourceStart : (input.end ?? sourceStart);
  const maxTurns = opts.maxTurns ?? 40;
  noteSubagentContextLine(state.subagents, sourceStart, typeof input !== 'string' && input.reduced === true);
  if (line.length < 20) {
    return;
  }
  // A request record holds the whole request body, which can contain any marker the branches below test.
  const request = claudeRequestRecord(line);
  if (request) {
    noteClaudeRequest(state, request);
    return;
  }
  noteClaudeToolResultLine(state.usageState, line);
  if (line.indexOf(MODEL_ATTACHMENT_MARK) >= 0 || (line.includes('"attachment"') && line.includes('"model"'))) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if ((!o.isSidechain || opts.childTranscript) && noteClaudeModelProfile(state.usageState, o)) {
        const evidence = claudeModelEvidence(o, opts.childTranscript === true);
        state.modelAttachment = evidence?.identity ?? null;
        state.attachmentBoundary.open = false;
        if (
          state.cur &&
          !state.cur.finished &&
          !state.cur.interrupted &&
          state.cur.error === null &&
          state.cur.processEndedAt === undefined
        )
          state.attachmentBoundary.turns = state.attachmentBoundary.turns.filter(
            (start) => start !== (state.cur![SOURCE_START] ?? 0),
          );
        return;
      }
    } catch {
      /* skip malformed line */
    }
  }
  if (line.indexOf('"compactMetadata"') >= 0) {
    try {
      const o = JSON.parse(line) as Record<string, unknown> & { compactMetadata?: CompactMetadata };
      const opening = state.cur?.promptParts?.at(-1);
      const answer =
        opening?.text === '/compact' && !state.curQueuedSinceOpening
          ? claudeCompactAnswer(o, state.curCommand, opening.at)
          : null;
      if (answer) applyClaudeLocalAnswer(state, answer, sourceStart, sourceEnd, maxTurns, true);
      if (o.compactMetadata) {
        const at = stamp(o.timestamp);
        expireClaudeCompactMetadata(state, at);
        let closestIndex = -1;
        let closestGap = COMPACT_META_WINDOW_MS;
        for (let index = 0; index < state.compactions.length; index += 1) {
          const compaction = state.compactions[index];
          const gap = Math.abs(compaction.at - at);
          if (gap <= closestGap) {
            closestIndex = index;
            closestGap = gap;
          }
        }
        if (closestIndex >= 0) {
          applyCompactMetadata(state.compactions[closestIndex], o.compactMetadata);
          extendClaudeCompactionMetadataRange(state, closestIndex, sourceStart, sourceEnd);
          if (o.compactMetadata.preTokens) {
            state.compactionValueSources[closestIndex].context = { start: sourceStart, end: sourceEnd };
          }
        } else {
          state.compactMeta.push({ at, data: o.compactMetadata, start: sourceStart, end: sourceEnd });
        }
        boundClaudeCompactions(state, maxTurns);
      }
    } catch {
      /* skip malformed line */
    }
    return;
  }
  if (line.indexOf('"ai-title"') >= 0 || line.indexOf('"custom-title"') >= 0) {
    try {
      const o = JSON.parse(line) as { type?: string; aiTitle?: unknown; customTitle?: unknown };
      const at = typeof input === 'string' ? null : sourceStart;
      if (o.type === 'custom-title' && typeof o.customTitle === 'string') {
        const title = customTitleOf(o);
        if (title) {
          setRecordedTitle(state, 'custom', {
            title,
            fullTitle: normalizeFullSessionTitle(o.customTitle),
            start: sourceStart,
            end: sourceEnd,
            at,
          });
        } else if (state.titleSource === 'custom') {
          if (state.generatedTitle) {
            setRecordedTitle(state, 'generated', state.generatedTitle);
          } else {
            state.title = state.suppliedTitle;
            state.fullTitle = state.suppliedFullTitle;
            state.titleSource = null;
            state.titleAt = null;
            state.titleRecord = null;
          }
        }
      } else if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle) {
        const title = normalizeSessionTitle(o.aiTitle);
        const record = title
          ? {
              title,
              fullTitle: normalizeFullSessionTitle(o.aiTitle),
              start: sourceStart,
              end: sourceEnd,
              at,
            }
          : null;
        state.generatedTitle = record;
        // A name the owner gave outranks a generated one, however much newer the generated one is.
        if (state.titleSource === 'custom') {
          return;
        }
        if (record) {
          setRecordedTitle(state, 'generated', record);
        } else {
          state.title = state.suppliedTitle;
          state.fullTitle = state.suppliedFullTitle;
          state.titleSource = null;
          state.titleAt = null;
          state.titleRecord = { title: state.title, fullTitle: state.fullTitle, start: sourceStart, end: sourceEnd };
        }
      }
    } catch {
      /* skip malformed line */
    }
    return;
  }
  // Prefilter queued attachments before reading later prompts, peer messages, and task notifications.
  if (line.indexOf('"queued_command"') >= 0) {
    let attachmentLine = false;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      attachmentLine = o.type === 'attachment';
      const attachment = o.attachment as Record<string, unknown> | undefined;
      const ask = attachmentLine && !o.isSidechain && state.cur ? readerQueuedAsk(o, opts.captureSessionText) : null;
      if (ask && state.cur) {
        state.curQueuedSinceOpening = true;
        setClaudeRepeatNotice(state, false);
        state.cur.laterPrompts.push({ text: ask.text, at: ask.at, stepsBefore: state.cur.stepCount });
        if (!opts.captureSessionText && state.cur.laterPrompts.length > TURN_ASK_LIMIT) {
          state.cur.laterPrompts.shift();
        }
        extendSourceRange(state.cur, sourceStart, sourceEnd);
      }
      // A subagent's handback that arrives while the agent works is queued here with a peer
      // origin, rather than written as a meta user record.
      if (attachmentLine && !o.isSidechain && attachment?.commandMode === 'prompt') {
        const deliveryId = typeof attachment.delivery_id === 'string' && attachment.delivery_id;
        noteClaudeHandback(state, attachment.origin, claudeRenderedText(o) ?? textOf(attachment.prompt), {
          form: 'attachment',
          id: deliveryId || claudeDeliveryId(o, sourceStart),
        });
        if (state.cur) {
          applyClaudePeerMessage(state, attachment.origin);
        }
      }
      // Queued task notifications update the background child and turn timing without adding a prompt.
      const notice = attachmentLine && !o.isSidechain ? taskNotificationText(o) : null;
      if (notice !== null && state.cur) {
        const at = claudeRecordAt(o);
        applyClaudeTaskNotification(state, notice, at, {
          form: 'notice-attachment',
          id: claudeDeliveryId(o, sourceStart),
        });
        state.cur.endedAt = Math.max(state.cur.endedAt, at);
        extendSourceRange(state.cur, sourceStart, sourceEnd);
      }
    } catch {
      /* skip malformed line */
    }
    // Consume parsed attachment records only. Other records containing the same text continue through the reducer.
    if (attachmentLine) {
      return;
    }
  }
  if (line.indexOf('"type":"cost-state"') >= 0) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const processEndedAt = claudeProcessEndedAt(o);
      if (processEndedAt !== null && state.cur && !o.isSidechain) {
        if (state.curLocalAnswer && !claudeModelWorked(state.cur) && state.cur.laterPrompts.length === 0) {
          // The command is no turn, so the process end belongs to the turn before it, which is
          // the newest card. With no card before the command, it belongs to no turn.
          const newest = state.turns[state.turns.length - 1];
          if (newest) {
            newest.processEndedAt = Math.max(newest.processEndedAt ?? 0, processEndedAt);
          }
          state.curInferredStop = null;
        } else {
          // A prompt queued behind a withdrawn command is the newest turn, and its card takes
          // the command's process end when `closeClaudeTurn` builds it.
          state.cur.processEndedAt = Math.max(state.cur.processEndedAt ?? 0, processEndedAt);
          extendSourceRange(state.cur, sourceStart, sourceEnd);
        }
      }
    } catch {
      /* skip malformed line */
    }
    return;
  }
  // Local command answers can withdraw unanswered command turns. The CLI records an answer as a
  // `local_command` system record or as a user record that holds only the output element.
  // Other records naming the subtype or the element, and an unmatched user-form answer, continue below.
  if (line.indexOf('"local_command"') >= 0 || line.indexOf('<local-command-std') >= 0) {
    let done = false;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const answer = claudeLocalAnswer(o);
      const withdrew = answer !== null && applyClaudeLocalAnswer(state, answer, sourceStart, sourceEnd, maxTurns);
      done = o.type === 'system' || withdrew;
    } catch {
      /* skip malformed line */
    }
    if (done) {
      return;
    }
  }
  const isAssistant = line.indexOf('"type":"assistant"') >= 0;
  const isUser = !isAssistant && line.indexOf('"type":"user"') >= 0;
  if (!isAssistant && !isUser) {
    return;
  }
  // Tool results are the bulk of a transcript and nearly all of its bytes, so a line is
  // only handed to JSON.parse when a cheap substring says it carries something the
  // timeline reports: an edit, a subagent's result, a failure, repository output, or the end of a turn.
  if (skipsOrdinaryToolResult(line, isUser, state.wrote)) {
    return;
  }

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  // Main reads exclude sidechain records. Child reads include them.
  if (o.isSidechain && !opts.childTranscript) {
    return;
  }
  if (state.curInferredStop != null && state.curLocalAnswer && claudeModelWorks(o)) {
    // Model work after the answer shows that the CLI was not idle, so the card the answer handed
    // back was not stopped by it.
    const newest = state.turns[state.turns.length - 1];
    if (newest?.processEndedAt === state.curInferredStop) {
      delete newest.processEndedAt;
    }
    state.curInferredStop = null;
  }
  if (state.curLocalAnswer && state.cur && !claudeModelWorked(state.cur) && claudeModelWorks(o)) {
    if (state.curCompacted) {
      state.cur.finished = false;
    } else {
      resumeAfterClaudeLocalAnswer(state);
    }
  }
  // Resolve pending typed-skill evidence on the next admitted meta user record with a base-directory line, or clear it.
  if (state.pendingTypedSkill) {
    const pendingSkill = state.pendingTypedSkill;
    state.pendingTypedSkill = null;
    if (isUser && o.isMeta && state.cur) {
      const directory = claudeSkillBaseDirectory(textOf((o.message as { content?: unknown } | undefined)?.content));
      if (directory) {
        recordTypedClaudeSkillUse(
          state,
          state.cur,
          pendingSkill.sourceId,
          pendingSkill.name,
          pendingSkill.at,
          claudeSkillFile(directory),
        );
      }
    }
  }
  expireClaudeCompactMetadata(state, stamp(o.timestamp));

  // Handled before the no-open-turn guard below, because a compaction can be the first
  // thing in the tail window and is worth reporting even with no turn to attach it to.
  if (isUser && o.isCompactSummary) {
    clearSubagentContext(state.subagents);
    const content = (o.message as { content?: unknown } | undefined)?.content;
    const compaction: Compaction = {
      sessionId,
      at: stamp(o.timestamp),
      contextBefore: state.lastContext,
      contextAfter: 0,
      droppedTokens: 0,
      durationMs: 0,
      trigger: '',
      model: state.lastModel,
      ...(state.lastContext > 0 && state.lastContextRequest
        ? {
            previousRequest: {
              tokens: state.lastContext,
              at: state.lastContextRequest.at,
              lifetime: state.lastContextRequest.lifetime,
              inferenceClass: state.lastContextRequest.inferenceClass,
              serviceTier: state.lastContextRequest.serviceTier,
              ...(state.lastContextCache
                ? { cacheRead: state.lastContextCache.read, cacheWrite: state.lastContextCache.write }
                : {}),
            },
          }
        : {}),
      summaryChars: compactSummaryChars(o),
      summary: stripCompactPreamble(typeof content === 'string' ? content : textOf(content)),
    };
    const subagentContext = subagentContextFigure(state.subagents);
    if (subagentContext) {
      compaction.subagentContext = subagentContext;
    }
    state.compactions.push(compaction);
    state.compactionRanges.push({ start: sourceStart, end: sourceEnd });
    state.compactionMetadataRanges.push(null);
    state.compactionValueSources.push({
      context: state.lastContextSource ? { ...state.lastContextSource } : null,
      model: state.lastModelSource ? { ...state.lastModelSource } : null,
      previous: compaction.previousRequest && state.lastContextSource ? { ...state.lastContextSource } : null,
    });
    const compactionIndex = state.compactions.length - 1;
    state.compactMeta = state.compactMeta.filter((meta) => {
      if (!withinCompactWindow(compaction.at, meta.at)) {
        return true;
      }
      applyCompactMetadata(compaction, meta.data);
      extendClaudeCompactionMetadataRange(state, compactionIndex, meta.start, meta.end);
      if (meta.data.preTokens) {
        state.compactionValueSources[compactionIndex].context = { start: meta.start, end: meta.end };
      }
      return false;
    });
    if (state.cur && !state.curLocalAnswer && claudeModelWorked(state.cur)) {
      state.curHeldCompaction = { at: compaction.at, turnStart: state.cur[SOURCE_START] ?? 0 };
    }
    boundClaudeCompactions(state, maxTurns);
    return;
  }

  if (isUser && isTypedPrompt(o, opts.childTranscript)) {
    // A command the CLI answered by itself leaves no card. The next prompt takes over the turn
    // before that command, and the stop the answer inferred for it.
    const handing = state.curLocalAnswer && state.cur !== null && !claudeModelWorked(state.cur);
    const handedPrevious = handing ? state.curPrevious : null;
    const handedStop = handing ? state.curInferredStop : null;
    const emitted = closeClaudeTurn(state, maxTurns);
    const handed = !emitted && state.pending.held === null;
    const previous = emitted ? (state.turnRanges.at(-1)?.start ?? null) : handed ? handedPrevious : null;
    const at = stamp(o.timestamp);
    // A held prompt got no reply of its own, so it belongs to this turn.
    const carried = state.pending.held;
    // Carry later prompts from the unanswered turn into its successor.
    const carriedAsks: TurnAsk[] = carried ? carried.laterPrompts : [];
    // Its parts rather than its prompt. A turn carried forward can itself be carrying
    // one, and its joined prompt handed on whole puts two of them in one part again.
    if (carried) {
      state.queued.push(...(carried.promptParts ?? []));
      state.pending.held = null;
    }
    const rawText = textOf((o.message as { content?: unknown }).content);
    const asked = [
      ...state.queued,
      { text: opts.captureSessionText ? extractPrompt(rawText, true) : cleanPrompt(rawText), at, stepsBefore: 0 },
    ];
    // `handbacks` stays for the whole session: a subagent's second completion notice can
    // arrive after the reader typed the next prompt, and it is still a repeat.
    setClaudeRepeatNotice(state, false);
    state.handedBack = false;
    state.closingReply = null;
    state.queued = [];
    const next: SourcedBuilding = {
      agent: 'claude',
      sessionId,
      sessionTitle: opts.sessionTitle ?? null,
      promptId: String(o.promptId || ''),
      startedAt: at,
      endedAt: at,
      prompt: asked.map((one) => one.text).join('\n\n'),
      promptParts: asked,
      summary: '',
      answers: [],
      model: null,
      effort: null,
      files: new Map(),
      agents: [],
      commits: [],
      usage: { requests: 0, input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
      usageParts: [],
      contextTokens: 0,
      // Claude Code records no window per turn, so the price table answers for it.
      contextWindow: null,
      toolUses: 0,
      toolCounts: emptyToolCounts(),
      toolTally: {},
      laterPrompts: opts.captureSessionText ? carriedAsks : carriedAsks.slice(-TURN_ASK_LIMIT),
      steps: [],
      updates: [],
      stepCount: 0,
      stepKinds: [],
      failedOrdinals: [],
      skillUses: [],
      skillUseCount: 0,
      failures: [],
      interrupted: false,
      finished: false,
      error: null,
    };
    setSourceRange(next, carried?.[SOURCE_START] ?? sourceStart, sourceEnd);
    setMembershipStart(next, sourceStart);
    state.cur = next;
    state.curCommand = o.isSidechain && rawText.trim() === '/compact' ? null : claudeRecordId(o);
    state.curLocalAnswer = false;
    state.curCompacted = false;
    state.curPrevious = previous;
    state.curQueuedSinceOpening = false;
    state.curInferredStop = handed ? handedStop : null;
    state.curToolEnded = false;
    state.curCarried = carried
      ? {
          turn: carried,
          start: carried[SOURCE_START] ?? sourceStart,
          end: carried[SOURCE_END] ?? carried[SOURCE_START] ?? sourceStart,
          membership: carried[MEMBERSHIP_START] ?? carried[SOURCE_START] ?? sourceStart,
        }
      : null;
    state.currentModelSource = null;
    // Nonsetting commands await a base-directory record before reporting a skill load.
    const commandNamed = COMMAND_NAMED.exec(rawText);
    const commandName = commandNamed ? commandNamed[1] : null;
    state.pendingTypedSkill =
      commandName && !HARNESS_COMMANDS.has(commandName)
        ? {
            name: commandName.slice(1),
            sourceId:
              (o.message as { id?: string } | undefined)?.id ||
              (typeof o.uuid === 'string' && o.uuid ? o.uuid : `at-${stamp(o.timestamp)}`),
            at,
          }
        : null;
    return;
  }
  const modelEvidence = isAssistant ? claudeModelEvidence(o, opts.childTranscript === true) : null;
  if (modelEvidence?.identity) {
    const model = modelEvidence.identity;
    if (state.modelAttachment && !sameModelIdentity(state.modelAttachment, model)) state.modelAttachment = null;
    const boundary = state.attachmentBoundary;
    if (state.cur && boundary.model && !sameModelIdentity(boundary.model, model)) {
      boundary.turns = boundary.turns.filter((start) => start !== (state.cur![SOURCE_START] ?? 0));
    }
    if (boundary.open) {
      if (boundary.model && !sameModelIdentity(boundary.model, model)) boundary.open = false;
      else {
        boundary.model = model;
        if (state.cur) {
          const start = state.cur[SOURCE_START] ?? 0;
          if (!boundary.turns.includes(start)) boundary.turns.push(start);
        }
      }
    }
  }
  if (!state.cur) {
    return;
  } // no opening prompt in this read
  const cur = state.cur;
  extendSourceRange(cur, sourceStart, sourceEnd);

  if (isUser) {
    const notice = taskNotificationText(o);
    if (notice !== null) {
      const at = stamp(o.timestamp);
      applyClaudeTaskNotification(state, notice, at, { form: 'notice-user', id: claudeDeliveryId(o, sourceStart) });
      cur.endedAt = Math.max(cur.endedAt, at);
      return;
    }
    if (o.isMeta) {
      noteClaudeHandback(state, o.origin, textOf((o.message as { content?: unknown } | undefined)?.content), {
        form: 'meta',
        id: claudeDeliveryId(o, sourceStart),
      });
      applyClaudePeerMessage(state, o.origin);
    }
    if (state.curToolEnded && claudeWakeMessage(o)) {
      cur.finished = false;
      cur.endedAt = Math.max(cur.endedAt, stamp(o.timestamp));
      state.curToolEnded = false;
    }
    if (interruptedATurn(o)) {
      cur.interrupted = true;
      cur.endedAt = Math.max(cur.endedAt, stamp(o.timestamp));
      return;
    }
    // Pair skill instructions through `sourceToolUseID` and retain their base-directory path.
    // Intervening filtered results and re-invocation notices prevent pairing by adjacency.
    const loaded = typeof o.sourceToolUseID === 'string' ? state.skillUseById.get(o.sourceToolUseID) : undefined;
    if (loaded) {
      const directory = claudeSkillBaseDirectory(textOf((o.message as { content?: unknown }).content));
      if (directory) {
        loaded.use.path = claudeSkillFile(directory);
        return;
      }
    }
    const blocks = (o.message as { content?: unknown }).content;
    const completedToolIds: string[] = [];
    let failed = false;
    const result = o.toolUseResult as Record<string, unknown> | undefined;
    // Structured stdout or patch fields supply result evidence when present.
    // Child results without those fields use their paired call input and result text instead.
    const structuredEvidence =
      !!result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      (typeof result.stdout === 'string' ||
        Object.prototype.hasOwnProperty.call(result, 'bashEditDiff') ||
        Object.prototype.hasOwnProperty.call(result, 'structuredPatch'));
    const fromCallAndText = opts.childTranscript === true && !structuredEvidence;

    if (Array.isArray(blocks)) {
      for (const b of blocks as { type?: string; is_error?: boolean; tool_use_id?: string; content?: unknown }[]) {
        if (b.type !== 'tool_result') {
          continue;
        }
        const toolId = b.tool_use_id || '';
        if (toolId) {
          completedToolIds.push(toolId);
        }
        const step = state.stepById.get(toolId);
        if (step) {
          setTurnStepStatus(state.toolOwnerById.get(toolId) ?? cur, step, b.is_error ? 'failed' : 'done');
        }
        if (!b.is_error) {
          if (fromCallAndText && toolId) {
            recordCallAndTextEvidence(state, cur, toolId, b.content, stamp(o.timestamp), opts.folders ?? []);
          }
          if (opts.childTranscript === true && toolId && result?.totalToolUseCount == null) {
            applyClaudeAgentResultText(state, toolId, b.content, {
              form: 'result',
              id: claudeDeliveryId(o, sourceStart),
            });
          }
          continue;
        }
        withdrawClaudeSkillUse(state, toolId);
        failed = true;
        cur.failures.push({
          tool: state.toolNames.get(toolId) || UNNAMED_TOOL,
          message: firstLine(textOf(b.content) || String(b.content ?? '')),
        });
      }
    }
    // A subagent records no stop reason. The harness marks the result that ends its turn.
    if (toolEndedATurn(o)) {
      cur.finished = true;
      cur.endedAt = Math.max(cur.endedAt, stamp(o.timestamp));
      state.curToolEnded = true;
    }
    if (!result || typeof result !== 'object') {
      for (const id of completedToolIds) {
        finishClaudeTool(state, id, false);
      }
      return;
    }
    const resultAt = stamp(o.timestamp);
    const previousResultAt = state.lastResultAt;
    const previousCallAt = state.lastResultCallAt;
    const call = state.calls.get(toolUseIdOf(o.message)) ?? null;
    state.lastResultAt = Math.max(state.lastResultAt, resultAt);
    state.lastResultCallAt = call === null ? resultAt : call.at;
    cur.endedAt = Math.max(cur.endedAt, resultAt);
    if (typeof result.stdout === 'string') {
      const from = call === null ? 0 : previousCallAt < call.at ? Math.max(call.at, previousResultAt) : call.at;
      recordCommits(
        cur,
        result.stdout,
        resultAt,
        call,
        opts.folders ?? [],
        null,
        call === null ? null : { from, failed },
      );
    }
    if (Object.prototype.hasOwnProperty.call(result, 'bashEditDiff')) {
      recordBashEdit(cur, result);
    }
    if (Object.prototype.hasOwnProperty.call(result, 'structuredPatch')) {
      recordEdit(cur, result);
    } else if (result.totalToolUseCount != null) {
      const row: TurnAgent = {
        id: result.agentId ? String(result.agentId) : null,
        description: String(result.description || result.agentType || 'agent'),
        agentType: result.agentType ? String(result.agentType) : null,
        model: result.resolvedModel ? String(result.resolvedModel) : null,
        effort: null,
        spend: [],
        spendFound: false,
        spendPartial: false,
        durationMs: typeof result.totalDurationMs === 'number' ? result.totalDurationMs : null,
        tokens: typeof result.totalTokens === 'number' ? result.totalTokens : null,
        toolUses: typeof result.totalToolUseCount === 'number' ? result.totalToolUseCount : null,
        status: String(result.status || 'completed'),
      };
      // Update the existing launched child row rather than adding another row.
      const launchId = toolUseIdOf(o.message);
      const existing = state.launched.get(launchId);
      if (existing) {
        Object.assign(existing, row);
        delete existing.toolUsesFromArtifacts;
      } else {
        cur.agents.push(row);
      }
      // A finished foreground subagent's result text enters context. A background launch
      // returns only a receipt, and its result arrives later as a completion notice.
      if (row.status !== 'running' && result.isAsync !== true && Array.isArray(blocks)) {
        const block = (blocks as { type?: string; tool_use_id?: string; content?: unknown }[]).find(
          (b) => b.type === 'tool_result' && b.tool_use_id === launchId,
        );
        if (block) {
          const text = textOf(block.content);
          const tokens = estimateClaudeSubagentTokens(text);
          const identity = `${claudeDeliveryId(o, sourceStart)}:${launchId}`;
          addSubagentResult(state.subagents, row.id ?? launchId, row.description, tokens, 'result', identity, text);
        }
      }
    } else {
      const existing = state.launched.get(toolUseIdOf(o.message));
      if (existing && typeof result.agentId === 'string' && result.agentId) {
        existing.id = result.agentId;
      }
    }
    const terminalAgent = result.totalToolUseCount != null && String(result.status || 'completed') !== 'running';
    for (const id of completedToolIds) {
      finishClaudeTool(state, id, terminalAgent);
    }
    return;
  }

  // assistant
  cur.endedAt = Math.max(cur.endedAt, stamp(o.timestamp));
  const message = (o.message || {}) as {
    id?: string;
    model?: string;
    content?: unknown;
    stop_reason?: string;
    usage?: ClaudeUsage;
  };
  if (failedATurn(o)) {
    cur.error = textOf(message.content).trim() || 'The request failed.';
    return;
  }
  if (message.model === '<synthetic>') {
    return;
  } // written by the harness, not the model
  if (answeredATurn(o)) {
    cur.error = null;
  }
  noteClaudeResponseTiming(state, o, message);
  if (message.model) {
    cur.model = message.model;
    state.currentModelSource = { start: sourceStart, end: sourceEnd };
    if (state.modelAttachment) {
      cur.modelAttachment = state.modelAttachment;
    } else {
      delete cur.modelAttachment;
    }
  }
  // Retain the latest nonempty top-level `effort` field. A reply without one leaves the held value unchanged.
  if (typeof o.effort === 'string' && o.effort) {
    cur.effort = o.effort;
  }
  // A recorded stop reason updates completion. Missing stop reasons leave the held state
  // unchanged, except after a result that ended the turn: model work then resumes it.
  if (state.curToolEnded) {
    cur.finished = finishedATurn(o);
    state.curToolEnded = false;
  } else if (message.stop_reason) {
    cur.finished = finishedATurn(o);
  }
  const [usageEvent, ...advisorEvents] = reduceClaudeUsageRecordEvents(
    state.usageState,
    o,
    opts.childTranscript ? { countSidechain: true, emitRepeats: true } : {},
  );
  if (usageEvent) {
    // Cache-expiry matching reads `responseIds`, so a child read keeps its timed responses apart.
    if (typeof message.id === 'string' && message.id && message.id.length <= 512) {
      const ids = opts.childTranscript ? (cur.timedResponseIds ??= []) : (cur.responseIds ??= []);
      if (!opts.childTranscript) cur.openingResponseId ??= message.id;
      if (!ids.includes(message.id)) ids.push(message.id);
      if (ids.length > 512) ids.shift();
    }
    const usage = usageEvent.usage;
    const latestCompaction = state.compactions.at(-1);
    if (
      latestCompaction &&
      latestCompaction.postCompactionCacheRead === undefined &&
      usageEvent.timestamp >= latestCompaction.at
    ) {
      latestCompaction.postCompactionCacheRead = claudeCompactionPrefixRead(
        latestCompaction.at,
        latestCompaction.previousRequest?.lifetime ?? null,
        usageEvent,
      );
    }
    // The reducer measured the context from the response's last executor pass.
    const context = state.usageState.lastRequest;
    cur.contextTokens = context?.tokens ?? usage.input + usage.cacheRead + usage.cacheWrite1h + usage.cacheWrite5m;
    // This request read every subagent result recorded before it. A result recorded after it
    // waits for the next request.
    commitSubagentContext(state.subagents);
    const subagentContext = subagentContextFigure(state.subagents);
    if (subagentContext) {
      cur.subagentContext = subagentContext;
    } else {
      delete cur.subagentContext;
    }
    const wrote = usageEvent.cacheLifetime ?? null;
    if (usage.cacheWrite1h + usage.cacheWrite5m > 0) {
      state.lastLifetime = wrote;
    }
    cur.contextRequest = {
      effort: usageEvent.effort,
      bedrock: typeof message.id === 'string' && message.id.startsWith(BEDROCK_MESSAGE_PREFIX),
      at: stamp(o.timestamp),
      lifetime: wrote ?? state.lastLifetime,
      inferenceClass: usageEvent.inferenceClass,
      serviceTier: usageEvent.serviceTier,
      readBack: (usageEvent.finalPassCacheRead ?? usage.cacheRead) > 0,
      outputTokens: usageEvent.finalPassOutputTokens ?? usage.output,
    };
    const turnStart = cur[SOURCE_START] ?? sourceStart;
    state.lastContext = cur.contextTokens;
    state.lastContextRequest = cur.contextRequest;
    state.lastContextCache = {
      read: context?.cacheRead ?? usage.cacheRead,
      write: context?.cacheWrite ?? usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0),
    };
    state.lastContextSource = { start: Math.min(turnStart, sourceStart), end: sourceEnd };
    state.lastModel = cur.model;
    state.lastModelSource =
      cur.model && state.currentModelSource
        ? {
            start: Math.min(turnStart, state.currentModelSource.start),
            end: Math.max(sourceEnd, state.currentModelSource.end),
          }
        : null;
    if (!opts.childTranscript) {
      chargeHeldClaudeCompaction(state, cur);
    }
    // Advisor consultations count in the turn's cost and stay out of its context figures above.
    const events = opts.childTranscript
      ? [usageEvent, ...advisorEvents].flatMap((event) => replaceClaudeUsageEvent(state.usageState, event))
      : [usageEvent, ...advisorEvents];
    for (const event of events) {
      addUsage(cur.usage, event.usage, event.contextBand);
      addTurnUsagePart(cur, event);
    }
  }
  // A line of another message ends the reply that closed under a repeat notice.
  const replyId = typeof message.id === 'string' && message.id ? message.id : null;
  if (state.repeatReplyId !== null && replyId !== state.repeatReplyId) {
    setClaudeRepeatNotice(state, false);
  }
  let closedReply = false;
  const content = message.content;
  if (Array.isArray(content)) {
    // Settle awaited steps when subsequent assistant content implies the agent resumed.
    settleClaudeSteps(state);
    let answeredLine = false;
    const responseBlocks: string[] = [];
    const narrationBase =
      message.stop_reason === 'tool_use'
        ? message.id || (typeof o.uuid === 'string' && o.uuid ? o.uuid : `at-${stamp(o.timestamp)}`)
        : '';
    let textOrdinal = narrationBase ? (state.narrationOrdinals.get(narrationBase) ?? 0) : 0;
    for (const block of content as {
      type?: string;
      text?: unknown;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }[]) {
      if (block.type === 'tool_use') {
        // Record only a Skill call with a nonempty skill name.
        const loadedSkill =
          block.name === 'Skill' && typeof block.input?.skill === 'string' ? block.input.skill.trim() : '';
        cur.toolUses++;
        // Skill calls retain raw tool totals and tally rows but remain outside tool-category totals.
        if (block.name !== 'Skill') {
          cur.toolCounts[TOOL_KIND[block.name || ''] ?? 'other']++;
        }
        if (block.name) {
          tallyToolName(cur.toolTally, block.name);
        }
        if (block.id && block.name) {
          state.toolNames.delete(block.id);
          state.toolNames.set(block.id, block.name);
        }
        if (
          block.id &&
          block.name === 'Bash' &&
          typeof block.input?.command === 'string' &&
          launchesClaudeSession(block.input.command)
        ) {
          (cur.dispatchToolUseIds ??= []).push(block.id);
        }
        if (block.name) {
          const input = block.input ?? {};
          const description =
            block.name === 'Bash' && typeof input.description === 'string' && input.description.trim()
              ? input.description.trim()
              : '';
          const presented = presentedStepDetail(block.name, input);
          const step: TurnStep = {
            ordinal: ++cur.stepCount,
            name: block.name,
            ...(block.id ? { sourceId: block.id } : {}),
            ...(description ? { headline: description } : {}),
            detail: presented.detail,
            at: stamp(o.timestamp),
            // The call starts running until a result or later activity settles it.
            status: 'running',
          };
          if (presented.fullDetail !== undefined) {
            Object.defineProperty(step, 'fullDetail', { value: presented.fullDetail });
          }
          // Pairing metadata is needed while building the card, but is not part of the
          // serialized activity row, so keep it off the payload's enumerable surface.
          if (block.id) {
            Object.defineProperty(step, 'id', { value: block.id });
          }
          if (block.id) {
            state.stepById.delete(block.id);
            state.stepById.set(block.id, step);
            state.toolOwnerById.delete(block.id);
            state.toolOwnerById.set(block.id, cur);
          }
          state.awaited.push(step);
          cur.stepKinds.push(block.name === 'Skill' ? SKILL_STEP_KIND : (TOOL_KIND[block.name] ?? 'other'));
          cur.steps.push(step);
          if (!opts.captureSessionText && cur.steps.length > TURN_STEP_LIMIT) {
            cur.steps.shift();
          }
          // Record skill uses outside the step window. Call IDs pair rereads, paths, and failed results.
          if (loadedSkill && block.id) {
            recordClaudeSkillUse(state, cur, block.id, loadedSkill, stamp(o.timestamp));
          }
        }
        // The cwd of this record, not of the result's: this one is the directory the
        // command started in, which is what a relative `cd` inside it resolves against.
        if (block.id && typeof block.input?.command === 'string') {
          const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : null;
          state.calls.delete(block.id);
          state.calls.set(block.id, {
            id: block.id,
            command: block.input.command,
            shell: 'bash',
            cwd,
            at: stamp(o.timestamp),
          });
          if (commitDirs(block.input.command, cwd).length > 0 || mergeDirs(block.input.command, cwd).length > 0) {
            state.wrote.add(block.id);
          }
          // Child reads admit results from any recognized Git command, matching printed-commit eligibility.
          else if (opts.childTranscript === true && ranGit(block.input.command)) {
            state.wrote.add(block.id);
          }
        }
        // Child edit figures wait for successful results before applying retained input counts.
        if (block.id && block.name && opts.childTranscript === true) {
          const pending = pendingFileEdit(block.name, block.input ?? {});
          if (pending) {
            state.editCalls.delete(block.id);
            state.editCalls.set(block.id, pending);
            // Admit the child edit result through the call-ID prefilter.
            state.wrote.add(block.id);
          }
        }
        if (block.name === 'Agent' && block.id) {
          const row: TurnAgent = {
            id: null,
            description: String(block.input?.description || 'agent'),
            agentType: block.input?.subagent_type ? String(block.input.subagent_type) : null,
            model: block.input?.model ? String(block.input.model) : null,
            effort: null,
            spend: [],
            spendFound: false,
            spendPartial: false,
            durationMs: null,
            tokens: null,
            toolUses: null,
            status: 'running',
          };
          if (block.id) {
            Object.defineProperty(row, 'toolUseId', { value: block.id });
          }
          state.launched.set(block.id, row);
          noteSubagentLaunch(state.subagents, block.id);
          cur.agents.push(row);
        }
        // A nonempty SubagentHandback message supplies the response and marks subsequent replies as nonresponses until another prompt or message.
        // Compare only the latest eligible closing reply. Containing texts keep the longer answer, with the report winning ties.
        // Different texts remain separate answers.
        if (
          block.name === 'SubagentHandback' &&
          typeof block.input?.message === 'string' &&
          block.input.message.trim()
        ) {
          const report = block.input.message;
          const said = report.trim();
          const index = state.closingReply;
          const prior = index === null ? undefined : cur.answers[index];
          const reply = prior && !prior.notResponse ? prior.text.trim() : '';
          if (prior && reply && reply.length > said.length && reply.includes(said)) {
            cur.summary = prior.text;
          } else {
            // A marked reply can sit between the closing reply and the call. The report takes
            // the place after it, so the answers keep the order they were written in.
            if (index !== null && reply && said.includes(reply)) {
              cur.answers.splice(index, 1);
            }
            cur.answers.push({ text: report, at: stamp(o.timestamp), stepsBefore: cur.stepCount });
            cur.summary = report;
          }
          if (opts.captureSessionText && !(prior && reply && reply.length > said.length && reply.includes(said))) {
            const recorded = (cur.recordedAnswers ??= []);
            if (prior && reply && said.includes(reply)) {
              let recordedIndex = recorded.length - 1;
              while (
                recordedIndex >= 0 &&
                (recorded[recordedIndex].notResponse ||
                  recorded[recordedIndex].text !== prior.text ||
                  recorded[recordedIndex].at !== prior.at)
              )
                recordedIndex--;
              if (recordedIndex >= 0) recorded.splice(recordedIndex, 1);
            }
            recorded.push({
              text: report,
              at: stamp(o.timestamp),
              stepsBefore: cur.stepCount,
              sourceOrder: sourceStart,
            });
          }
          state.handedBack = true;
          state.closingReply = null;
        }
      } else if (block.type === 'text') {
        const text = String(block.text ?? '');
        if (!text.trim()) {
          if (opts.dispatchResponse && text) responseBlocks.push(text);
          continue;
        }
        const ordinal = textOrdinal++;
        if (message.stop_reason === 'tool_use') {
          const sourceId = `${narrationBase}:text:${ordinal}`;
          if (!cur.updates.some((update) => update.sourceId === sourceId)) {
            cur.updates.push({
              sourceId,
              kind: 'commentary',
              text,
              at: stamp(o.timestamp),
              status: 'done',
              stepsBefore: cur.stepCount,
            });
          }
          continue;
        }
        const closes = Boolean(message.stop_reason);
        const notResponse = closes ? claudeNotResponse(state, cur, text) : null;
        if (opts.captureSessionText) {
          (cur.recordedAnswers ??= []).push({
            text,
            at: stamp(o.timestamp),
            stepsBefore: cur.stepCount,
            sourceOrder: sourceStart,
            ...(notResponse ? { notResponse } : {}),
          });
        }
        if (!notResponse) {
          cur.summary = text;
          responseBlocks.push(text);
        }
        // A text block with a stop reason closes an answer. Ordinary later blocks replace an answer already closed by this line.
        // A newly marked nonresponse preserves the preceding eligible response as a separate answer.
        if (closes) {
          const answer: TurnAnswer = { text, at: stamp(o.timestamp), stepsBefore: cur.stepCount };
          if (notResponse) {
            answer.notResponse = notResponse;
          }
          const keepsLast =
            opts.captureSessionText || (notResponse && !cur.answers[cur.answers.length - 1]?.notResponse);
          if (answeredLine && !keepsLast) {
            cur.answers[cur.answers.length - 1] = answer;
          } else {
            cur.answers.push(answer);
          }
          answeredLine = true;
          closedReply = true;
          if (notResponse) {
            cur.summary = claudeResponseText(cur);
          } else {
            state.closingReply = cur.answers.length - 1;
          }
        }
      }
    }
    if (narrationBase) {
      state.narrationOrdinals.set(narrationBase, textOrdinal);
    }
    if (opts.dispatchResponse && responseBlocks.length && message.stop_reason && message.stop_reason !== 'tool_use')
      cur.finalResponse = { text: responseBlocks.join('\n'), sourceId: replyId };
  } else if (typeof content === 'string' && content.trim()) {
    if (message.stop_reason === 'tool_use') {
      const base = message.id || (typeof o.uuid === 'string' && o.uuid ? o.uuid : `at-${stamp(o.timestamp)}`);
      const ordinal = state.narrationOrdinals.get(base) ?? 0;
      const sourceId = `${base}:text:${ordinal}`;
      if (!cur.updates.some((update) => update.sourceId === sourceId)) {
        cur.updates.push({
          sourceId,
          kind: 'commentary',
          text: content,
          at: stamp(o.timestamp),
          status: 'done',
          stepsBefore: cur.stepCount,
        });
      }
      state.narrationOrdinals.set(base, ordinal + 1);
    } else {
      const notResponse = message.stop_reason ? claudeNotResponse(state, cur, content) : null;
      if (opts.captureSessionText) {
        (cur.recordedAnswers ??= []).push({
          text: content,
          at: stamp(o.timestamp),
          stepsBefore: cur.stepCount,
          sourceOrder: sourceStart,
          ...(notResponse ? { notResponse } : {}),
        });
      }
      if (!notResponse) {
        cur.summary = content;
        if (opts.dispatchResponse && message.stop_reason) cur.finalResponse = { text: content, sourceId: replyId };
      }
      if (message.stop_reason && message.stop_reason !== 'tool_use') {
        const answer: TurnAnswer = { text: content, at: stamp(o.timestamp), stepsBefore: cur.stepCount };
        if (notResponse) {
          answer.notResponse = notResponse;
        }
        cur.answers.push(answer);
        closedReply = true;
        if (notResponse) {
          cur.summary = claudeResponseText(cur);
        } else {
          state.closingReply = cur.answers.length - 1;
        }
      }
    }
  }
  // A tool call is the agent's own work, so a reply after it answers that work and not the
  // wake before it. `workedSinceReply` outlives this one wake, so a notice for an older
  // handback that arrives later, once this work is done, still finds it and repeats nothing.
  if (
    message.stop_reason === 'tool_use' ||
    (Array.isArray(message.content) &&
      message.content.some((block) => (block as { type?: unknown } | null)?.type === 'tool_use'))
  ) {
    setClaudeRepeatNotice(state, false);
    state.workedSinceReply = true;
  }
  boundClaudeToolAssociations(state, opts.captureSessionText);
  // A closed reply answers every handback before it, and the wake the flag describes is over
  // once its message is, so the next reply answers whatever wakes the agent next. A closing
  // line that holds no reply text, such as a thinking block, closes nothing.
  if (closedReply) {
    for (const from of state.handbacks.keys()) {
      state.handbacks.set(from, true);
    }
    state.workedSinceReply = false;
    if (state.repeatNotice && replyId !== null) {
      state.repeatReplyId = replyId;
    } else {
      setClaudeRepeatNotice(state, false);
    }
  }
  if (message.stop_reason && message.stop_reason !== 'tool_use') {
    settleClaudeSteps(state);
    pruneClaudeTurnAssociations(state, opts.captureSessionText);
  }
}

// Records whether the newest wake repeats a handback's completion notice. Any change ends the
// reply that closed under the previous repeat.
function setClaudeRepeatNotice(state: ClaudeSessionParserState, repeat: boolean): void {
  state.repeatNotice = repeat;
  state.repeatReplyId = null;
}

// The name a subagent's row shows, found by the child id the parent recorded.
function claudeAgentName(state: ClaudeSessionParserState, id: string): string | null {
  for (const agent of state.launched.values()) {
    if (agent.id === id) {
      return agent.description;
    }
  }
  const turns: Array<{ agents: TurnAgent[] }> = state.cur ? [...state.turns, state.cur] : state.turns;
  for (let index = turns.length - 1; index >= 0; index--) {
    const agent = turns[index].agents.find((row) => row.id === id);
    if (agent) {
      return agent.description;
    }
  }
  return null;
}

// The record form of one subagent delivery and its identity: the record uuid, or the record's
// offset in the file when it has none.
interface ClaudeDelivery {
  form: string;
  id: string;
}

function claudeDeliveryId(record: Record<string, unknown>, start: number): string {
  return typeof record.uuid === 'string' && record.uuid ? record.uuid : `at:${start}`;
}

// The UTF-8 size of the system-reminder frame around a background completion notice in the
// request. The stored notice lacks it. Request captures of Claude Code 2.1.301 to 2.1.304 show it.
const CLAUDE_NOTICE_FRAME_BYTES = 535;

// A subagent's hand-back report enters context as a queued attachment or a meta user record.
function noteClaudeHandback(
  state: ClaudeSessionParserState,
  origin: unknown,
  text: string,
  delivery: ClaudeDelivery,
): void {
  if (!origin || typeof origin !== 'object') {
    return;
  }
  const o = origin as Record<string, unknown>;
  if (o.kind !== 'peer' || o.handback !== true || !text) {
    return;
  }
  const sender = typeof o.senderTaskId === 'string' && o.senderTaskId ? o.senderTaskId : o.from;
  const key = typeof sender === 'string' && sender ? sender : null;
  const named = typeof o.name === 'string' && o.name ? o.name : null;
  const name = (key && claudeAgentName(state, key)) ?? named;
  // Both forms carry the report body in their origin.
  const body = typeof o.body === 'string' && o.body ? o.body : text;
  addSubagentResult(state.subagents, key, name, estimateClaudeSubagentTokens(text), delivery.form, delivery.id, body);
}

// The text a queued attachment rendered into the request, frame included.
function claudeRenderedText(record: Record<string, unknown>): string | null {
  const rendered = record.rendered;
  if (!Array.isArray(rendered) || rendered.length === 0) {
    return null;
  }
  return rendered
    .map((part) => {
      const content = part && typeof part === 'object' ? (part as { content?: unknown }).content : undefined;
      return typeof content === 'string' ? content : '';
    })
    .join('\n');
}

// A message from another session wakes the agent. A subagent's handback is one, and its sender
// id is what the subagent's later completion notice names. A coordinator message, a parent's
// follow-up to its running subagent, wakes that subagent after its `SubagentHandback` call, so
// the reply to it can be the response. Any other origin changes nothing.
function applyClaudePeerMessage(state: ClaudeSessionParserState, origin: unknown): void {
  const wake = claudeWakeOrigin(origin);
  if (!wake) {
    return;
  }
  if (wake.kind === 'peer') {
    if (wake.handback === true && typeof wake.from === 'string' && wake.from) {
      state.handbacks.set(wake.from, false);
    }
    setClaudeRepeatNotice(state, false);
  }
  state.handedBack = false;
  state.closingReply = null;
}

// Why a closing reply must not become the turn's response, or null when it becomes it. A
// repeat notice marks a reply only when the turn already closed an earlier response reply, so
// a turn whose only reply answers the notice keeps that reply as its response instead of
// reporting none. A reply of "No response requested." is never the response, even when it is
// the turn's only one. Neither is a reply written after a `SubagentHandback` call, whose
// message already became the response.
function claudeNotResponse(
  state: ClaudeSessionParserState,
  cur: SourcedBuilding,
  text: string,
): TurnAnswer['notResponse'] | null {
  if (state.handedBack) {
    return 'after-handback';
  }
  if (state.repeatNotice && cur.answers.some((answer) => !answer.notResponse)) {
    return 'repeat-notice';
  }
  if (text.trim() === 'No response requested.') {
    return 'no-response-requested';
  }
  return null;
}

// The text of the newest answer that is a response, or empty when the turn closed none.
function claudeResponseText(cur: SourcedBuilding): string {
  for (let index = cur.answers.length - 1; index >= 0; index--) {
    if (!cur.answers[index].notResponse) {
      return cur.answers[index].text;
    }
  }
  return '';
}

function setRecordedTitle(
  state: ClaudeSessionParserState,
  source: RecordedTitleSource,
  record: RecordedTitleState,
): void {
  state.title = record.title;
  state.fullTitle = record.fullTitle;
  state.titleSource = source;
  state.titleAt = record.at;
  state.titleRecord = {
    title: record.title,
    fullTitle: record.fullTitle,
    start: record.start,
    end: record.end,
    source,
  };
}

function stampSessionTitle(turn: Turn, state: ClaudeSessionParserState): void {
  turn.sessionTitle = state.title;
  turn.sessionFullTitle = state.fullTitle;
  if (state.titleSource) {
    turn.sessionTitleSource = state.titleSource;
  } else {
    delete turn.sessionTitleSource;
  }
  if (state.titleSource && typeof state.titleAt === 'number') {
    turn.sessionTitleAt = state.titleAt;
  } else {
    delete turn.sessionTitleAt;
  }
}

export function claudeSessionLineMayAffectRead(line: string): boolean {
  if (line.length < 20) {
    return false;
  }
  if (
    line.indexOf('"compactMetadata"') >= 0 ||
    line.indexOf('"ai-title"') >= 0 ||
    line.indexOf('"custom-title"') >= 0 ||
    line.indexOf('"queued_command"') >= 0 ||
    line.indexOf(MODEL_ATTACHMENT_MARK) >= 0 ||
    (line.includes('"attachment"') && line.includes('"model"')) ||
    line.indexOf('"type":"cost-state"') >= 0 ||
    line.indexOf('"local_command"') >= 0 ||
    claudeRequestMarked(line)
  ) {
    return true;
  }
  const isAssistant = line.indexOf('"type":"assistant"') >= 0;
  const isUser = !isAssistant && line.indexOf('"type":"user"') >= 0;
  return (isAssistant || isUser) && !skipsOrdinaryToolResult(line, isUser);
}

// The prompt scan reads prompts and commands, so it never parses a request record.
function claudePromptScanLineMayMatter(line: string): boolean {
  return claudeSessionLineMayAffectRead(line) && !claudeRequestMarked(line);
}

const CLAUDE_REQUEST_MARK = '"type":"api-request",';
// The CLI writes `type` first, then `sessionId`, `id`, and `timestamp`, ahead of the request body.
const CLAUDE_REQUEST_LEAD = '{' + CLAUDE_REQUEST_MARK;
const CLAUDE_REQUEST_HEAD = 512;

// Whether the head of the line holds the request marker. A nested object, such as a tool input,
// can hold it too, so a marked line is a request record only when its top-level type says so.
function claudeRequestMarked(line: string): boolean {
  return line.lastIndexOf(CLAUDE_REQUEST_MARK, CLAUDE_REQUEST_HEAD - CLAUDE_REQUEST_MARK.length) >= 0;
}

interface ClaudeRequestRecord {
  id: string;
  timestamp: string;
}

// The id and send time of an `api-request` record, or null for any other line. A line that opens
// with the request type supplies both from its head when it holds them. Any other marked line
// is parsed, and only a top-level request type qualifies.
function claudeRequestRecord(line: string): ClaudeRequestRecord | null {
  if (!claudeRequestMarked(line)) return null;
  if (line.startsWith(CLAUDE_REQUEST_LEAD)) {
    const head = line.slice(0, CLAUDE_REQUEST_HEAD);
    const id = /"id":"([^"\\]{1,512})"/.exec(head)?.[1];
    const timestamp = /"timestamp":"([^"\\]{1,64})"/.exec(head)?.[1];
    // A regular expression capture shares the memory of the whole line. The parser state keeps
    // request ids, so the id is copied to keep the line collectable.
    if (id && timestamp && stamp(timestamp) > 0) return { id: Buffer.from(id).toString(), timestamp };
  }
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (
      o?.type === 'api-request' &&
      typeof o.id === 'string' &&
      o.id.length > 0 &&
      o.id.length <= 512 &&
      typeof o.timestamp === 'string' &&
      stamp(o.timestamp) > 0
    ) {
      return { id: o.id, timestamp: o.timestamp };
    }
  } catch {
    /* skip malformed line */
  }
  return null;
}

// The text that a filtered read keeps for a line. A request record shrinks to its type, id, and send time.
export function claudeRetainedLine(line: string): string {
  const request = claudeRequestRecord(line);
  return request ? JSON.stringify({ type: 'api-request', id: request.id, timestamp: request.timestamp }) : line;
}

interface ClaudeResponseTiming {
  requestRef: string | null;
  // The newest content block time of the response.
  at: number;
  output: number | null;
  stopped: boolean;
  model: string | null;
}

function noteClaudeRequest(state: ClaudeSessionParserState, request: ClaudeRequestRecord): void {
  state.requestTimes.delete(request.id);
  state.requestTimes.set(request.id, stamp(request.timestamp));
  for (const id of state.requestTimes.keys()) {
    if (state.requestTimes.size <= RESPONSE_RATE_LIMIT) break;
    state.requestTimes.delete(id);
  }
}

// Each content block of a response is its own record, and each repeats the final output and stop reason.
function noteClaudeResponseTiming(
  state: ClaudeSessionParserState,
  o: Record<string, unknown>,
  message: { id?: string; model?: string; stop_reason?: string; usage?: ClaudeUsage },
): void {
  const id = message.id;
  if (typeof id !== 'string' || !id || id.length > 512) return;
  const held = state.responseTimings.get(id);
  const output = (message.usage as { output_tokens?: unknown } | undefined)?.output_tokens;
  const timing: ClaudeResponseTiming = {
    requestRef: typeof o.requestRef === 'string' && o.requestRef ? o.requestRef : (held?.requestRef ?? null),
    at: Math.max(held?.at ?? 0, stamp(o.timestamp)),
    output: typeof output === 'number' ? output : (held?.output ?? null),
    stopped: !!message.stop_reason || held?.stopped === true,
    model: message.model || held?.model || null,
  };
  state.responseTimings.delete(id);
  state.responseTimings.set(id, timing);
  for (const key of state.responseTimings.keys()) {
    if (state.responseTimings.size <= RESPONSE_RATE_LIMIT) break;
    state.responseTimings.delete(key);
  }
}

// Sums the turn's qualified responses. Each has a stop reason, a recorded request, the turn's model,
// and a positive interval from the request's send time to the response's last content block.
// A reopened turn starts from the request rate of its last emission, because that emission
// consumed the timings it summed.
function claudeRequestRate(state: ClaudeSessionParserState, turn: Turn): OutputRate | undefined {
  if (turn.interrupted || !turn.model) return undefined;
  const carried = turn.outputRateBasis === 'request' && turn.outputRateModel === turn.model ? turn.outputRate : null;
  const total = { output: carried?.output ?? 0, milliseconds: carried?.milliseconds ?? 0 };
  for (const id of turn.timedResponseIds ?? turn.responseIds ?? []) {
    const timing = state.responseTimings.get(id);
    const sent = timing?.requestRef ? state.requestTimes.get(timing.requestRef) : undefined;
    if (!timing || !sent || !timing.stopped || timing.model !== turn.model || timing.output === null) continue;
    const measured = { output: timing.output, milliseconds: timing.at - sent };
    if (!validRate(measured)) continue;
    total.output += measured.output;
    total.milliseconds += measured.milliseconds;
  }
  return total.output > 0 && validRate(total) ? total : undefined;
}

// Drops the timings of an emitted turn's stopped responses and the requests they name, so the
// parser state holds only open responses. A response without a stop reason can continue in a
// later record, so its timing stays.
function consumeClaudeResponseTimings(state: ClaudeSessionParserState, turn: Turn): void {
  for (const id of turn.timedResponseIds ?? turn.responseIds ?? []) {
    const timing = state.responseTimings.get(id);
    if (!timing?.stopped) continue;
    if (timing.requestRef) state.requestTimes.delete(timing.requestRef);
    state.responseTimings.delete(id);
  }
}

function finishClaudeSession(state: ClaudeSessionParserState, opts: ReadOptions, readBytes: number): SessionRead {
  const maxTurns = opts.maxTurns ?? 40;
  closeClaudeTurn(state, maxTurns);
  if (state.pending.held) {
    emitClaudeTurn(state, state.pending.held, maxTurns);
    state.pending.held = null;
  }
  for (const turn of state.turns) {
    stampSessionTitle(turn, state);
  }
  refreshClaudeAgentFacts(state.turns, opts.agentSpendOf, opts.agentSessionTargetOf);
  attachCompactMetadata(state.compactions, state.compactMeta);
  return {
    turns: state.turns,
    compactions: state.compactions,
    readBytes,
    turnLimitReached: state.turnLimitReached,
  };
}

function materializeClaudeSession(source: ClaudeSessionParserState, opts: ReadOptions, readBytes: number): SessionRead {
  return finishClaudeSession(cloneParserState(source), opts, readBytes);
}

function claudeHiddenSlots(state: ClaudeSessionParserState) {
  return { turns: state.turns, open: state.cur, pending: state.pending.held };
}

// Worker-transfer snapshot with symbol keys and non-enumerable turn metadata lifted into plain state.
function claudeSnapshot(state: ClaudeSessionParserState): ClaudeSessionParserState {
  const copy = cloneParserState(state);
  const retained = new Set(copy.turnRanges.map((range) => range.start));
  if (copy.cur) retained.add(copy.cur[SOURCE_START] ?? 0);
  if (copy.pending.held) retained.add(copy.pending.held[SOURCE_START] ?? 0);
  copy.attachmentBoundary.turns = copy.attachmentBoundary.turns.filter((start) => retained.has(start));
  copy.hidden = hiddenParserState(claudeHiddenSlots(copy), CLAUDE_HIDDEN_POLICY);
  return copy;
}

export function createClaudeSessionReducer(
  sessionId: string,
  opts: ReadOptions = {},
  restored?: ClaudeSessionParserState,
): ClaudeSessionReducer {
  const state = restored ? cloneParserState(restored) : emptyClaudeSessionParserState(opts);
  if (state.version !== 11) {
    throw new Error('Incompatible Claude parser state');
  }
  applyHiddenParserState(claudeHiddenSlots(state), state.hidden, CLAUDE_HIDDEN_POLICY);
  delete state.hidden;
  state.compactionMetadataRanges ??= state.compactions.map(() => null);
  state.compactionValueSources ??= state.compactions.map(() => ({ context: null, model: null }));
  state.lastContextSource ??= null;
  state.lastModelSource ??= null;
  state.currentModelSource ??= null;
  state.modelAttachment ??= null;
  state.attachmentBoundary ??= { open: true, model: null, turns: [] };
  state.pendingTypedSkill ??= null;
  state.handbacks ??= new Map();
  state.requestTimes ??= new Map();
  state.responseTimings ??= new Map();
  state.handedBack ??= false;
  state.closingReply ??= null;
  state.repeatNotice ??= false;
  state.repeatReplyId ??= null;
  state.workedSinceReply ??= false;
  state.curCommand ??= null;
  state.curLocalAnswer ??= false;
  state.curCompacted ??= false;
  state.curHeldCompaction ??= null;
  state.curPrevious ??= null;
  state.curQueuedSinceOpening ??= false;
  state.curCarried ??= null;
  state.curInferredStop ??= null;
  state.curToolEnded ??= false;
  // A reader that classifies its lines through the file's repeated-record map passes the
  // classifier. Otherwise the reducer skips a line whose identity matches a line it already read,
  // which is a repeated record wherever the window starts.
  // A line without a byte offset falls back to the check against the lines this reducer read.
  const classify = opts.repeatedRecord;
  const local = createClaudeRepeatedFilter();
  const skipRepeated = (line: string | ParserLine): boolean => {
    const text = typeof line === 'string' ? line : line.text;
    if (classify && typeof line !== 'string' && line.start !== undefined) return classify(line.start, text);
    return local(text);
  };
  return {
    pushLine: (line) => {
      if (skipRepeated(line)) return;
      const order = opts.captureSessionText
        ? captureTurnTextOrder([state.cur, state.pending.held, state.turns.at(-1)])
        : null;
      if (
        opts.exportTurnBytes &&
        typeof line !== 'string' &&
        state.cur &&
        !state.cur.finished &&
        line.end !== undefined
      ) {
        const start = state.cur[SOURCE_START] ?? line.start ?? 0;
        if (line.end - start > opts.exportTurnBytes) throw new ExportLimitError('turn', opts.exportTurnBytes);
      }
      reduceClaudeSessionLine(state, line, sessionId, opts);
      if (opts.captureSessionText && typeof line !== 'string') {
        order?.([state.cur, state.pending.held, state.turns.at(-1)], line.start ?? 0);
      }
    },
    retainedBytes: () => retainedParserPayload(state),
    retainedPayloadScan: () => retainedParserPayloadScan(state),
    trimBefore: (offset) => trimClaudeBefore(state, offset, opts.maxTurns ?? 40),
    skipped: () => {
      skipSubagentContext(state.subagents);
      state.modelAttachment = null;
      state.attachmentBoundary = { open: true, model: null, turns: [] };
    },
    recoverAttachment: (identity) => {
      const boundary = state.attachmentBoundary;
      const starts = new Set(boundary.turns);
      const apply = (turn: Turn | SourcedBuilding, start: number) => {
        if (identity && !turn.modelAttachment && starts.has(start) && sameModelIdentity(identity, turn.model)) {
          turn.modelAttachment = identity;
        }
      };
      state.turns.forEach((turn, index) => apply(turn, state.turnRanges[index]?.start ?? 0));
      if (state.cur) apply(state.cur, state.cur[SOURCE_START] ?? 0);
      if (state.pending.held) apply(state.pending.held, state.pending.held[SOURCE_START] ?? 0);
      if (boundary.open && (!boundary.model || sameModelIdentity(identity, boundary.model))) {
        state.modelAttachment = identity;
      }
      boundary.turns = [];
    },
    snapshot: () => claudeSnapshot(state),
    read: (readBytes = 0) => materializeClaudeSession(state, opts, readBytes),
    finish: (readBytes = 0) => finishClaudeSession(state, opts, readBytes),
    completedTurns: () => {
      const completed = cloneParserState(state);
      if (
        completed.cur &&
        (completed.cur.finished ||
          completed.cur.interrupted ||
          completed.cur.error !== null ||
          completed.cur.processEndedAt !== undefined)
      ) {
        closeClaudeTurn(completed, opts.maxTurns ?? 40);
      }
      for (const turn of completed.turns) {
        stampSessionTitle(turn, completed);
      }
      // A history page's last completed turn has a later turn after it, outside this read.
      refreshClaudeAgentFacts(completed.turns, opts.agentSpendOf, opts.agentSessionTargetOf, false);
      return completed.turns.map((turn, index) => ({
        turn,
        start: completed.turnRanges[index]?.start ?? 0,
        end: completed.turnRanges[index]?.end ?? 0,
      }));
    },
    completedCompactions: () => {
      const completed = cloneParserState(state);
      attachCompactMetadata(completed.compactions, completed.compactMeta);
      return completed.compactions.map((compaction, index) => ({
        compaction,
        start: completed.compactionRanges[index]?.start ?? 0,
        end: completed.compactionRanges[index]?.end ?? 0,
      }));
    },
    openRange: () => {
      const open = state.cur;
      if (!open || open.finished || open.interrupted || open.error !== null || open.processEndedAt !== undefined) {
        return null;
      }
      return { start: open[SOURCE_START] ?? 0, end: open[SOURCE_END] ?? 0 };
    },
  };
}

// Refreshes the Claude subagent facts of retained pages in one split, so a child request on one page
// can price onto a turn on another page. When `endsAtNewest` is true, the last page is the newest
// window, and its last turn stays open the way the child cache-expiry warning keeps it open. A
// turn that both a page and the window hold is split from its window copy, the copy the cards
// show. The other copy keeps a split of its own.
export function refreshRetainedClaudeAgentFacts(
  pages: readonly { turns: Turn[] }[],
  lookup: AgentSpendLookup | undefined,
  targetOf: AgentSessionTargetLookup | undefined,
  endsAtNewest: boolean,
): void {
  const shown = new Map<string, Turn>();
  for (const page of pages) for (const turn of page.turns) shown.set(turnKey(turn), turn);
  const copies = pages.flatMap((page) => page.turns.filter((turn) => shown.get(turnKey(turn)) !== turn));
  refreshClaudeAgentFacts([...shown.values()], lookup, targetOf, endsAtNewest);
  if (copies.length) refreshClaudeAgentFacts(copies, lookup, targetOf, false);
}

// `endsAtNewest` says that no later turn of the session follows the last of `turns`.
export function refreshClaudeAgentFacts(
  turns: Turn[],
  lookup: AgentSpendLookup | undefined,
  targetOf: AgentSessionTargetLookup | undefined,
  endsAtNewest = true,
): void {
  if (lookup) {
    for (const turn of turns) {
      for (let at = turn.agents.length - 1; at >= 0; at--) {
        if (turn.agents[at].launchedEarlier) turn.agents.splice(at, 1);
      }
    }
  }
  const timed: ChildRequests[] = [];
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (!agent.id) {
        continue;
      }
      const ref = {
        id: agent.id,
        name: agent.description,
        path: null,
        status: agent.status,
        toolUseId: agent.toolUseId,
      };
      const target = agent.toolUseId ? (targetOf?.(ref) ?? null) : null;
      if (target) {
        agent.childSessionId = target;
      } else {
        delete agent.childSessionId;
      }
      if (!lookup) {
        continue;
      }
      const spend = lookup(ref);
      agent.spend = spend.models;
      if (spend.ownModel) {
        agent.ownModel = spend.ownModel;
      } else {
        delete agent.ownModel;
      }
      if (!agent.effort) {
        agent.effort = spend.effort;
      }
      if (spend.outputRate && spend.outputRateModel) {
        agent.outputRate = { ...spend.outputRate };
        agent.outputRateModel = spend.outputRateModel;
      } else {
        delete agent.outputRate;
        delete agent.outputRateModel;
      }
      agent.spendFound = spend.found;
      agent.spendPartial = spend.partial;
      if (spend.commits?.length) {
        agent.commits = spend.commits.map((commit) => ({ ...commit }));
      } else {
        delete agent.commits;
      }
      if (spend.commitIntents?.length) {
        agent.commitIntents = spend.commitIntents.map((intent) => ({ ...intent }));
      } else {
        delete agent.commitIntents;
      }
      if (spend.artifacts) {
        agent.artifacts = cloneChildArtifacts(spend.artifacts);
      } else {
        delete agent.artifacts;
      }
      // A background child's own result never carries a tool count, and a finished child's task
      // notification often carries no <tool_uses> tag either. Its own calls give the row a count
      // the way a Codex child's already do, and a retained history page that reads more of a
      // finished child's transcript later refills the same way. `toolUsesFromArtifacts` says the
      // current figure came from this fallback rather than from a result or a notification, so a
      // later read with a bigger artifacts total is free to replace it, including an old zero. A
      // genuine count is never touched here: it clears the flag where it is written, so an
      // artifacts total that happens to equal it by chance is never mistaken for its source.
      if ((agent.toolUses === null || agent.toolUsesFromArtifacts) && !agentIsRunning(agent)) {
        agent.toolUses = childToolCalls(agent.artifacts);
        agent.toolUsesFromArtifacts = true;
      }
      if (spend.usageIncomplete) {
        agent.spendIncomplete = true;
      } else {
        delete agent.spendIncomplete;
      }
      if (spend.requests?.length) {
        timed.push({ turn, agent, spend });
      }
    }
  }
  shareChildSpendByTurn(turns, timed, endsAtNewest);
}

interface ChildRequests {
  turn: Turn;
  agent: TurnAgent;
  spend: AgentSpend;
}

// Splits each child's spend across the turns that hold its requests, so a turn card prices a
// child only by the requests in that turn. `requestSpans` and `spanHolding` place each request by
// the rule that places child cache-expiry returns. When a later turn can follow the last of
// `turns`, that last turn holds requests only until it ends. A request from outside this read then
// never lands on a card that does not hold it. A child can have more than one parsed row, one for
// each Agent call that resumes it. Its earliest row is the launching row, and that row keeps every
// request that no turn from its own onward holds. Each turn's share goes to the first parsed row in
// that turn, and the turn's other rows for the child get an empty share. A turn that holds
// requests and has no parsed row for the child gets a new row.
function shareChildSpendByTurn(turns: readonly Turn[], timed: readonly ChildRequests[], endsAtNewest: boolean): void {
  if (!timed.length) return;
  const spansBySession = new Map<string, RequestSpan<Turn>[]>();
  const spansOf = (sessionId: string) => {
    let spans = spansBySession.get(sessionId);
    if (!spans) {
      // The worker read has no session outcome, so each turn's cap is its own recorded process end.
      spans = requestSpans(turns.filter((turn) => turn.sessionId === sessionId));
      const last = spans.at(-1);
      if (last && !endsAtNewest) {
        last.cap = Math.min(last.cap, Math.max(last.start, last.turn.endedAt ?? last.start));
      }
      spansBySession.set(sessionId, spans);
    }
    return spans;
  };
  const byChild = new Map<string, ChildRequests[]>();
  for (const entry of timed) {
    const key = `${entry.turn.sessionId}:${entry.agent.id}`;
    const rows = byChild.get(key);
    if (rows) rows.push(entry);
    else byChild.set(key, [entry]);
  }
  for (const rows of byChild.values()) {
    rows.sort((a, b) => a.turn.startedAt - b.turn.startedAt);
    const home = rows[0].turn;
    const whole = rows[0].spend;
    const spans = spansOf(home.sessionId);
    const byTurn = new Map<Turn, UsageEvent[]>();
    for (const request of whole.requests ?? []) {
      const held = requestClock(request.timestamp) ? spanHolding(spans, request.timestamp)?.turn : undefined;
      const holder = held && held.startedAt >= home.startedAt ? held : home;
      const list = byTurn.get(holder);
      if (list) list.push(request);
      else byTurn.set(holder, [request]);
    }
    if (rows.length === 1 && byTurn.size === 1 && byTurn.has(home)) continue;
    const priced = new Set<Turn>();
    for (const { turn, agent } of rows) {
      priceChildShare(agent, priced.has(turn) ? [] : (byTurn.get(turn) ?? []), whole);
      priced.add(turn);
    }
    for (const [turn, held] of byTurn) {
      if (priced.has(turn)) continue;
      let source = rows[0].agent;
      for (const row of rows) if (row.turn.startedAt < turn.startedAt) source = row.agent;
      let startedAt = Infinity;
      for (const request of held) startedAt = Math.min(startedAt, request.timestamp);
      const row: TurnAgent = {
        id: source.id,
        ...(source.childSessionId ? { childSessionId: source.childSessionId } : {}),
        description: source.description,
        agentType: source.agentType,
        model: source.model,
        ...(source.ownModel ? { ownModel: source.ownModel } : {}),
        effort: source.effort,
        spend: [],
        spendFound: true,
        spendPartial: source.spendPartial,
        startedAt,
        durationMs: null,
        tokens: null,
        toolUses: null,
        status: source.status,
        launchedEarlier: true,
      };
      priceChildShare(row, held, whole);
      turn.agents.push(row);
    }
  }
}

// Prices one row by its share of a child's requests. Every share takes its incomplete mark the
// same way, from the whole read and from its own requests. An empty share also drops the token
// count from the child's result. The row then reads as no billed usage in this turn, and the card
// never counts the child's whole token total.
function priceChildShare(agent: TurnAgent, requests: readonly UsageEvent[], whole: AgentSpend): void {
  agent.spend = requestSpend(requests);
  if (!requests.length) agent.tokens = null;
  if (whole.usageIncomplete || requests.some((request) => request.incomplete)) agent.spendIncomplete = true;
  else delete agent.spendIncomplete;
}

// Model spend for some of a child's requests. Model totals leave out estimated compactions, and
// usage parts include them. A model with a zero total stays when it has any usage part, so an
// estimate's usage parts still price. `readClaudeSpendTree` prices the whole child the same way,
// except that it keeps a zero-total model only when an estimated compaction used it.
function requestSpend(requests: readonly UsageEvent[]): ModelSpend[] {
  const byModel = new Map<string | null, TurnUsage>();
  const exact = { usageParts: [] as TurnUsagePart[] };
  for (const request of requests) {
    if (!request.compactionEstimate) addModelUsage(byModel, request.model, request.usage, request.contextBand);
    else if (!byModel.has(request.model)) byModel.set(request.model, emptyUsage());
    addTurnUsagePart(exact, request);
  }
  return [...byModel].flatMap(([model, usage]) => {
    const usageParts = exact.usageParts.filter((part) => part.model === model);
    return usageTokens(usage) > 0 || usageParts.length ? [{ model, usage, usageParts }] : [];
  });
}

// Lines read from a known offset go in with their byte range, so a title record keeps its
// place in the file.
function readSessionLines(
  lines: string[],
  sessionId: string,
  opts: ReadOptions,
  readBytes: number,
  offset?: number,
): SessionRead {
  const reducer = createClaudeSessionReducer(sessionId, opts);
  let start = offset ?? 0;
  for (const line of lines) {
    if (offset === undefined) {
      reducer.pushLine(line);
      continue;
    }
    const end = start + Buffer.byteLength(line);
    reducer.pushLine({ text: line, start, end });
    start = end + 1;
  }
  return reducer.finish(readBytes);
}

// Maximum timestamp gap when pairing compaction summaries with their nearest metadata record.
export const COMPACT_META_WINDOW_MS = 10_000;

function attachCompactMetadata(compactions: Compaction[], meta: { at: number; data: CompactMetadata }[]): void {
  for (const m of meta) {
    let best: Compaction | null = null;
    let bestGap = COMPACT_META_WINDOW_MS;
    for (const c of compactions) {
      const gap = Math.abs(c.at - m.at);
      if (gap <= bestGap) {
        best = c;
        bestGap = gap;
      }
    }
    if (!best) {
      continue;
    }
    applyCompactMetadata(best, m.data);
  }
}

function applyCompactMetadata(compaction: Compaction, data: CompactMetadata): void {
  compaction.trigger = data.trigger || compaction.trigger;
  compaction.contextBefore = data.preTokens || compaction.contextBefore;
  compaction.contextAfter = data.postTokens || compaction.contextAfter;
  compaction.durationMs = data.durationMs || compaction.durationMs;
  compaction.droppedTokens = data.cumulativeDroppedTokens || compaction.droppedTokens;
}

// Lines in a file's content: what an editor's gutter would number. A trailing newline
// terminates the last line rather than starting another, and empty content has none.
export function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.replace(/\r?\n$/, '').split('\n').length;
}

export function patchMarkersAreValid(hunks: readonly PatchHunk[]): boolean {
  let oldEnded = false;
  let newEnded = false;
  for (const hunk of hunks) {
    for (let index = 0; index < hunk.lines.length; index++) {
      const line = hunk.lines[index];
      if (line === '\\ No newline at end of file') {
        const prefix = hunk.lines[index - 1]?.[0];
        const marksOld = prefix === ' ' || prefix === '-';
        const marksNew = prefix === ' ' || prefix === '+';
        if ((!marksOld && !marksNew) || (marksOld && oldEnded) || (marksNew && newEnded)) {
          return false;
        }
        oldEnded ||= marksOld;
        newEnded ||= marksNew;
        continue;
      }
      if ((line.startsWith(' ') || line.startsWith('-')) && oldEnded) {
        return false;
      }
      if ((line.startsWith(' ') || line.startsWith('+')) && newEnded) {
        return false;
      }
    }
  }
  return true;
}

function patchHunks(value: unknown): PatchHunk[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const hunks: PatchHunk[] = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }
    const hunk = candidate as Record<string, unknown>;
    const coordinates = [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines];
    if (
      !coordinates.every(
        (coordinate) => typeof coordinate === 'number' && Number.isSafeInteger(coordinate) && coordinate >= 0,
      )
    ) {
      return null;
    }
    if (
      !Array.isArray(hunk.lines) ||
      !hunk.lines.every(
        (line) =>
          typeof line === 'string' &&
          (line.startsWith(' ') ||
            line.startsWith('+') ||
            line.startsWith('-') ||
            line === '\\ No newline at end of file'),
      )
    ) {
      return null;
    }
    const oldStart = hunk.oldStart as number;
    const oldLines = hunk.oldLines as number;
    const newStart = hunk.newStart as number;
    const newLines = hunk.newLines as number;
    if (oldLines === 0 && newLines === 0) {
      return null;
    }
    if ((oldLines > 0 && oldStart === 0) || (newLines > 0 && newStart === 0)) {
      return null;
    }
    let seenOld = 0;
    let seenNew = 0;
    for (const line of hunk.lines) {
      if (line.startsWith(' ') || line.startsWith('-')) {
        seenOld++;
      }
      if (line.startsWith(' ') || line.startsWith('+')) {
        seenNew++;
      }
    }
    if (seenOld !== oldLines || seenNew !== newLines) {
      return null;
    }
    hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: [...hunk.lines] as string[],
    });
  }
  return patchMarkersAreValid(hunks) ? hunks : null;
}

// What an Edit, Write or NotebookEdit call asked for, reduced to the figures one file row
// draws. `countsUnknown` marks an input that names the file without saying how many lines
// moved, the same mark a shell record's uncounted path carries.
export interface PendingFileEdit {
  path: string;
  added: number;
  removed: number;
  countsUnknown: boolean;
  unknownReason?: FileCountReason;
}

// The lines of a recorded text, counting the way `countLines` counts: the newline most files
// end with opens no line.
function editLines(text: string): string[] {
  return text ? text.replace(/\r?\n$/, '').split('\n') : [];
}

// How many lines an edit moved, from its two sides. Leading and trailing lines the sides
// share did not move, so they go first. What is left is what a patch would mark, and
// `recordEdit` counts a patch's `+` and `-` lines and ignores its context lines.
function editedLineCounts(oldText: string, newText: string): { added: number; removed: number } {
  const before = editLines(oldText);
  const after = editLines(newText);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { added: after.length - head - tail, removed: before.length - head - tail };
}

// Nonempty string path outside excluded roots, or null for unsupported input.
function editInputPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || isEphemeralPath(value)) {
    return null;
  }
  return value;
}

// Input text, treating absent values as empty. Other nonstring values return null.
function editInputText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : null;
}

// A file whose lines this reader cannot count. The row says the file changed, the same mark a
// shell record's uncounted path carries, and it names why.
function uncountedFileEdit(path: string, unknownReason: FileCountReason): PendingFileEdit {
  return { path, added: 0, removed: 0, countsUnknown: true, unknownReason };
}

// A file whose lines this reader counted. Counts that came to nothing mean the input moved
// something no line count can see, such as a trailing newline, so the row carries the mark
// rather than reading `+0 -0` as an exact answer.
function countedFileEdit(path: string, added: number, removed: number): PendingFileEdit {
  return added === 0 && removed === 0
    ? uncountedFileEdit(path, 'zero')
    : { path, added, removed, countsUnknown: false };
}

// File figures from supported child edit inputs. Write, replace-all Edit, and notebook replacements or deletions leave counts unknown.
function pendingFileEdit(name: string, input: Record<string, unknown>): PendingFileEdit | null {
  if (name === 'Edit') {
    const target = editInputPath(input.file_path);
    if (target === null) {
      return null;
    }
    const before = editInputText(input.old_string);
    const after = editInputText(input.new_string);
    if (before === null || after === null) {
      return null;
    }
    // A replace-all input omits its match count, so its file row keeps no line counts.
    if (input.replace_all === true) {
      return uncountedFileEdit(target, 'replaceAll');
    }
    const counts = editedLineCounts(before, after);
    return countedFileEdit(target, counts.added, counts.removed);
  }
  if (name === 'Write') {
    const target = editInputPath(input.file_path);
    if (target === null || editInputText(input.content) === null) {
      return null;
    }
    // Write input supplies no previous content or existence fact, so line counts and new-file status remain unknown.
    return uncountedFileEdit(target, 'write');
  }
  if (name === 'NotebookEdit') {
    const target = editInputPath(input.notebook_path);
    if (target === null) {
      return null;
    }
    const source = editInputText(input.new_source);
    if (source === null) {
      return null;
    }
    // Notebook inserts count their supplied cell text. Replacements and deletions lack prior content and leave counts unknown.
    return String(input.edit_mode || 'replace') === 'insert'
      ? countedFileEdit(target, countLines(source), 0)
      : uncountedFileEdit(target, 'notebook');
  }
  return null;
}

// Adds child input figures to the normalized file map without a patch record. Diff views use their fallback for these rows.
function recordEditFromCall(turn: Building, edit: PendingFileEdit): void {
  const key = normalizeFsPath(edit.path);
  const entry = turn.files.get(key) || { path: edit.path, added: 0, removed: 0, isNew: false, edits: [] };
  // Preserve counted lines alongside unknown-count evidence. The latest uncounted edit supplies its recorded cause.
  if (edit.countsUnknown) {
    entry.countsUnknown = true;
    if (edit.unknownReason) {
      entry.unknownReason = edit.unknownReason;
    }
  }
  entry.added += edit.added;
  entry.removed += edit.removed;
  turn.files.set(key, entry);
}

// Reads child result evidence from its paired edit input or shell output when structured evidence is absent.
function recordCallAndTextEvidence(
  state: ClaudeSessionParserState,
  turn: Building,
  toolId: string,
  content: unknown,
  at: number,
  folders: string[],
): void {
  const edit = state.editCalls.get(toolId);
  if (edit) {
    // One call changed the file once. A record that answers the same call id twice, which a
    // reread of the same tail can hold, must not count those lines a second time.
    state.editCalls.delete(toolId);
    recordEditFromCall(turn, edit);
    return;
  }
  const call = state.calls.get(toolId) ?? null;
  if (call === null) {
    return;
  }
  // Without a call window, printed commits are recorded but quiet-commit recovery intents are excluded.
  recordCommits(turn, textOf(content), at, call, folders, null, null);
}

// One Edit, Write or NotebookEdit result: which file, how many lines moved, and the patch
// itself. A malformed patch loses its hunk detail as a unit, while the file-level edit and
// any recorded whole-file text remain available.
function recordEdit(turn: Building, result: Record<string, unknown>): void {
  const filePath = String(result.filePath || '');
  if (!filePath || isEphemeralPath(filePath)) {
    return;
  }
  let added = 0;
  let removed = 0;
  const parsedHunks = patchHunks(result.structuredPatch);
  const hunks = parsedHunks ?? [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        added++;
      } else if (line.startsWith('-')) {
        removed++;
      }
    }
  }
  const created = result.type === 'create';
  // A create carries no patch, so its whole content is the addition. The trailing newline
  // most files end with does not open a line, and an empty file has none at all.
  if (created) {
    added = countLines(String(result.content || ''));
  }
  const key = normalizeFsPath(filePath);
  const entry = turn.files.get(key) || { path: filePath, added: 0, removed: 0, isNew: false, edits: [] };
  // A structured edit result clears earlier unknown-count evidence, including when its parsed hunk list is empty.
  delete entry.countsUnknown;
  delete entry.unknownReason;
  entry.added += added;
  entry.removed += removed;
  if (created) {
    entry.isNew = true;
  }
  // Keep `originalFile` only for the first recorded edit. Later whole-file content remains available as each edit's after side.
  const first = entry.edits.length === 0;
  entry.edits.push({
    hunks,
    originalFile: first && typeof result.originalFile === 'string' ? result.originalFile : null,
    content: typeof result.content === 'string' ? result.content : null,
    isCreate: created,
    ...(parsedHunks === null ? { patchInvalid: true as const } : {}),
  });
  turn.files.set(key, entry);
}

// Shell file changes reduce into the shared normalized file map through `patchHunks`.
// Detailed entries supply line counts. Other named paths get uncounted rows unless an existing edit record already covers them.
function recordBashEdit(turn: Building, result: Record<string, unknown>): void {
  const diff = result.bashEditDiff;
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) {
    return;
  }
  const record = diff as Record<string, unknown>;
  const named = new Set<string>();
  const files = Array.isArray(record.files) ? record.files : [];
  for (const candidate of files) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    const file = candidate as Record<string, unknown>;
    const filePath = String(file.filePath || '');
    if (!filePath || isEphemeralPath(filePath)) {
      continue;
    }
    named.add(normalizeFsPath(filePath));
    let added = 0;
    let removed = 0;
    const parsedHunks = patchHunks(file.hunks);
    const hunks = parsedHunks ?? [];
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          added++;
        } else if (line.startsWith('-')) {
          removed++;
        }
      }
    }
    // A shell diff carries no create flag of its own. A single hunk that starts at 0,0 on
    // the old side is what the CLI writes for a file that did not exist before the command.
    const created = hunks.length === 1 && hunks[0].oldStart === 0 && hunks[0].oldLines === 0;
    const key = normalizeFsPath(filePath);
    const entry = turn.files.get(key) || { path: filePath, added: 0, removed: 0, isNew: false, edits: [] };
    // A detailed shell entry clears earlier unknown-count evidence, including when its parsed hunk list is empty.
    delete entry.countsUnknown;
    delete entry.unknownReason;
    entry.added += added;
    entry.removed += removed;
    if (created) {
      entry.isNew = true;
    }
    entry.edits.push({
      hunks,
      originalFile: null,
      content: null,
      isCreate: created,
      ...(parsedHunks === null ? { patchInvalid: true as const } : {}),
    });
    turn.files.set(key, entry);
  }
  const changedFiles = Array.isArray(record.changedFiles) ? record.changedFiles : [];
  for (const candidate of changedFiles) {
    if (typeof candidate !== 'string' || !candidate) {
      continue;
    }
    const key = normalizeFsPath(candidate);
    if (named.has(key) || isEphemeralPath(candidate)) {
      continue;
    }
    // Keep existing rows with edit records when an unlisted shell path supplies no detail.
    const existing = turn.files.get(key);
    if (existing && existing.edits.length > 0) {
      continue;
    }
    turn.files.set(
      key,
      existing ?? {
        path: candidate,
        added: 0,
        removed: 0,
        isNew: false,
        edits: [],
        countsUnknown: true,
        unknownReason: 'shell',
      },
    );
  }
}

// True for recorded `running` or `async_launched` child status.
export function agentIsRunning(agent: TurnAgent): boolean {
  return agent.status === 'running' || agent.status === 'async_launched';
}

// Quiet interval for gathering transcript append events before refreshing the panel.
export const TRANSCRIPT_WAKE_MS = 200;

export const TRANSCRIPT_WATCH_LIMIT = 256;

// Allocate unique parent directories to warm sources first, with stable ordering within each tier.
export function watchDirs(files: readonly { file: string }[], warmFiles: ReadonlySet<string> = new Set()): string[] {
  const dirs = new Map<string, boolean>();
  for (const one of files) {
    const dir = path.dirname(one.file);
    if (dir && dir !== '.') {
      dirs.set(dir, dirs.get(dir) === true || warmFiles.has(normalizeFsPath(one.file)));
    }
  }
  return [...dirs.keys()]
    .sort((a, b) => Number(dirs.get(b)) - Number(dirs.get(a)) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, TRANSCRIPT_WATCH_LIMIT);
}
