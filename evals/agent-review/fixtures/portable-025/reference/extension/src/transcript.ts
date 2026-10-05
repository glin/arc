import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import {
  AgentSessionTargetLookup,
  AgentSpendLookup,
  ModelSpend,
  addModelUsage,
  addUsage,
  agentSpendIsOpen,
  modelSpends,
  openSpendBand,
  scanLines,
  spendFileVersion,
  type AgentSpendRef,
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
import {
  applyHiddenParserState,
  cloneParserState,
  hiddenParserState,
  ParserLine,
  RETAINED_COMPACTIONS,
  RETAINED_REQUESTS,
  retainedRequestEvents,
  type HiddenParserState,
  type HiddenStatePolicy,
} from './parserstate';
import { withoutRichContent } from './richtext';
import { compactionEstimate, type CompactionPreviousRequest } from './pricing';
import { activityDetail, ActivityDetailFormat, ActivityDetailPolicy, describeToolInput } from './activitydetail';
import { shortenTo } from './domain/text.ts';
import { ARC_IDENTITY } from './identity';
import { arcHome } from './store';
import { claudeConfigHome, codexHome } from './agentpaths';

export { describeToolInput } from './activitydetail';
export { shortenTo } from './domain/text.ts';

// Reads Claude Code session transcripts (JSONL under ~/.claude/projects/<slug>/) and
// groups them into turns. Read-only: nothing here writes to a transcript.
//
// Transcripts reach hundreds of megabytes, and this runs on the shared extension-host
// event loop, so a whole-file read is never an option. Only a tail window is read, and
// lines are prefiltered by substring before being handed to JSON.parse. A turn that
// starts before the window is dropped, because its opening prompt is not in view.

// Which coding agent recorded a session. The panel draws one timeline out of two readers,
// so every session and every turn says which one it came from: the card's badge reads it,
// and so does anything that has to know what a source could not record. It sits here rather
// than in a module of its own because `Turn` and `SessionFile` are what it annotates.
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

// Why a row carries `countsUnknown`, kept beside the flag so the files figure can name the
// real cause instead of a single guess. The card keeps it on a row that later settles to a
// partial count, where it says why that count is a floor. `shell` is a Bash result that named the path in
// `changedFiles` without its hunks. `write` is a Write over a path whose earlier lines the
// call never sent. `replaceAll` is an Edit whose replacement ran on every match without
// saying how many. `notebook` is a NotebookEdit that replaced or deleted a cell without its
// old content. `zero` is an edit whose two sides left nothing a line count can see, such as a
// change to a trailing newline alone.
export type FileCountReason = 'shell' | 'write' | 'replaceAll' | 'notebook' | 'zero';

export interface TurnFileChange {
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
  // The recorded patch text for each edit of this file, in the order the results arrived,
  // so a turn's own diff can be shown without reading the file as it stands now. The
  // memory this costs is bounded by the tail window that produced it, not by the
  // transcript, which is the constraint that governs everything here. Ordinary and
  // explicitly older reads remain bounded. The selected session can reach farther
  // only when its newest turn starts before that window, and only that turn is admitted.
  edits: EditRecord[];
  // Set when a Bash result named this path in `changedFiles` without carrying its hunks.
  // The CLI caps the shell diff at five detailed files, so a wider change still names
  // every path it touched, and this flag keeps that row from claiming a zero-line change.
  countsUnknown?: true;
  // Why `countsUnknown` is set. Absent where a caller built the row without recording a cause,
  // which the files figure reads as a plain fact with no cause to name.
  unknownReason?: FileCountReason;
}

export interface TurnAgent {
  // The child transcript's own id, once the parent recorded it. Null while a launch is in
  // flight or where an older format named only the task.
  id: string | null;
  // A completed shell command and child session together identify a Claude print-mode
  // invocation. Native child rows do not carry this field.
  invocationId?: string;
  // The parent tool call id, kept as non-enumerable metadata so activity steps can pair
  // with the agent row without changing the serialized card shape.
  toolUseId?: string;
  // The stable child session identity used by the existing session navigation protocol.
  // It exists only after provider evidence resolves this launch to a readable child.
  childSessionId?: string;
  description: string;
  agentType: string | null;
  model: string | null;
  effort: string | null;
  // Every billed request in the child transcript, kept by model for pricing. Empty when the
  // child is still running, its transcript is gone, or the parent did not identify it.
  spend: ModelSpend[];
  spendFound: boolean;
  // A nested subagent under this child is missing or still running, so `spend` is a lower bound.
  spendPartial: boolean;
  spendUnfinished?: boolean;
  spendIncomplete?: boolean;
  commits?: TurnCommit[];
  commitIntents?: CommitIntent[];
  // The child's distinct files and commits, read from its own transcript once it finished.
  artifacts?: ChildArtifacts;
  durationMs: number | null;
  tokens: number | null;
  toolUses: number | null;
  // Set whenever `toolUses` came from the child's own tool calls rather than from a result or
  // a task notification. It marks a figure that a later, better read is free to replace, and
  // it is cleared the moment a genuine count arrives so that count is never replaced again. It
  // stays enumerable for the same reason `closedAt` does: the retained turns cross structured
  // clone to the worker and back between reads, and the worker copies each agent row by spread.
  toolUsesFromArtifacts?: boolean;
  status: string;
  // The parent record time that closed this child. It stays enumerable because the host
  // derives session outcome after the worker sends the parsed turn across structured clone.
  closedAt?: number;
}

// Where one call's commits landed, as far as the command that made them can say.
//
// Five answers, and one field rather than two, because a directory beside a foreign flag
// carries a combination that cannot exist. `named` is another repository, which the row draws
// by name. `worktree` is a linked worktree of this one, which shares its object store and its
// branch refs, so a commit made there is this project's own work on a branch the reader will
// merge. `maintree` is that same relation from the other side, for a reader whose open folder
// is itself a worktree. `unnamed` is a call that committed outside
// the open folders in more than one repository, so no directory can be given for any of its
// commits. `null` claims nothing at all.
//
// A path test cannot tell these apart, because all of them sit outside every open folder.
// Only the repository can, and only `gitcommits.ts` asks it. A commit read out of git output
// therefore starts as `named` and is corrected once that answer arrives.
export type CommitPlace =
  | { kind: 'named'; dir: string }
  | { kind: 'worktree'; dir: string }
  | { kind: 'maintree'; dir: string }
  | { kind: 'unnamed' }
  | null;

// The ref Git printed when it made the commit. A detached checkout is distinct from a
// named branch because an isolated replay often creates a short-lived commit before its
// final branch commit is made.
export type CommitHead = { kind: 'branch'; name: string } | { kind: 'detached' } | null;

export interface TurnCommit {
  sha: string;
  subject: string;
  head?: CommitHead; // null or omitted when the source did not print a recognizable ref
  files: number | null; // null when no stat line was found under the commit line
  added: number | null;
  removed: number | null;
  // Epoch ms. A commit taken from printed output carries the time of the tool result that
  // reported it. One read back from the repository carries git's own committer time.
  at: number;
  place: CommitPlace; // where it landed, carried only for a commit made outside the open folders
  dir: string | null; // repository directory, for opening the commit in the editor
  // The repository the commit is in, once git has named it: its common git directory, which a
  // linked worktree shares with the tree it came from, and the top of the tree the commit was
  // made in. Null or omitted until then.
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

// A call that ran `git commit` and printed no commit line to take. `-q` and `--quiet` do
// that, and they are the common reason a commit never reaches a card.
//
// The transcript keeps what it knows: the one repository the command named, how many times
// the command said `git commit`, and the window the call ran in. `gitcommits.ts` asks the
// repository for the rest.
//
// The window is the attribution, so it is kept as tight as the records allow. `from` is the
// later of the record that issued the call and the previous result, so two calls issued by
// different records cannot share a window.
//
// Two calls issued by one record keep that record's own time instead. They are stamped alike
// and can run at the same time, so an earlier result does not prove the later call had not
// started. Narrowing them would put a call's own commit outside its own window and leave the
// room for somebody else's. Their windows overlap instead, and the count rule refuses what
// the overlap holds.
export interface CommitIntent {
  dir: string; // the one repository the command named
  from: number;
  to: number;
  expected: number; // how many times the command said `git commit`
  witnessedSha?: string; // the abbreviated sha printed by a trailing success log
}

// A branch the turn moved a tree onto, without making a commit of its own.
//
// `git merge --ff-only` is the shape that produces one. The turn did not write the commit, so
// it is not a commit of the turn's, but it is what the turn did to the repository and the card
// showed nothing for it before. `from` is the name the merge command named.
//
// A landing changes no files, so it carries no counts.
export interface TurnLanding {
  id: string; // the merge invocation and reflog event that produced this landing
  sha: string;
  subject: string; // the subject of the commit the tree landed on
  from: string; // the branch or ref the merge command named
  head?: CommitHead; // the branch that moved, where the directory could be asked
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

// Everything the turn was billed for. Kept as raw counts so the price table stays in one
// place, and split by cache tier because the four tiers are priced very differently.
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
  usage: TurnUsage;
}

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
    part.compactionEstimate === event.compactionEstimate
  );
}

// Merge a part already priced elsewhere, such as a nested subagent's, into the matching part.
// The added part keeps its own context bands, so its usage merges without a band of its own.
function addPricedUsagePart(parts: TurnUsagePart[], add: TurnUsagePart): void {
  const same = parts.find((part) => samePricedPart(part, add));
  if (same) {
    addUsage(same.usage, add.usage);
    return;
  }
  const usage = { ...add.usage };
  if (add.usage.byContextBand) {
    usage.byContextBand = Object.fromEntries(
      Object.entries(add.usage.byContextBand).map(([band, held]) => [band, { ...held }]),
    );
  }
  parts.push({ ...add, usage });
}

export function addTurnUsagePart(turn: Pick<Turn, 'usageParts'>, event: UsageEvent): void {
  const parts = (turn.usageParts ??= []);
  const same = parts.find((part) => samePricedPart(part, event));
  if (same) {
    addUsage(same.usage, event.usage, event.contextBand);
    return;
  }
  const usage = { ...event.usage };
  if (event.contextBand) {
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
    usage,
  });
}

// The cache lifetimes a provider sells, spelled the way the records spell them. Named here
// rather than in the price table, because a record either states one or does not, and what it
// costs is a later question.
export const CACHE_LIFETIMES = ['5m', '30m', '1h'] as const;
export type CacheLifetime = (typeof CACHE_LIFETIMES)[number];

export function isCacheLifetime(value: unknown): value is CacheLifetime {
  return typeof value === 'string' && (CACHE_LIFETIMES as readonly string[]).includes(value);
}

// The one request that established a turn's current context level.
export interface ContextRequest {
  // When that request was recorded. The turn's own end moves with a tool result, an
  // interruption and a background notification, so it dates the turn and not this request.
  at: number;
  // The lifetime that request bought, or null where it recorded none. A price fallback is not
  // a recorded lifetime: `claudeUsage` charges an unsplit write at the hour because that is
  // what this harness asks for, and nothing may report that choice back as evidence.
  lifetime: CacheLifetime | null;
  // What that request was billed under, so a later quote is taken at the rate it actually ran
  // at rather than at the standard public one.
  inferenceClass: UsageInferenceClass;
  serviceTier: string | null;
  // Whether that request read anything back. A cache written and not yet read is warm and
  // reports nothing read, which is what the first request of a session looks like.
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
  usage: TurnUsage;
  requestKey: string;
  // An estimated compaction request. Claude Code records no usage for one, so the reducer
  // estimates it and marks it here. It is never one of the ordered primary requests.
  compactionEstimate?: true;
}

// One compaction a usage reducer recorded, in the order its source holds them.
//
// The ordinal is carried rather than implied by position. A compaction whose record has no
// usable clock still counts, so pairing a bounded list of times against a total by position
// would date the wrong compaction.
export interface ReducerCompaction {
  ordinal: number;
  // When the record says the compaction happened, or null where it names no usable time.
  at: number | null;
  trigger: string | null;
  // The compaction request's own usage, where the record carries it. Codex writes it on the
  // compacted record. Claude writes none, and leaves this null.
  requestUsage: TurnUsage | null;
  // That request's billing identity. A compacted record does not carry it, and current Codex
  // rollouts supply it in the following settings record, so these are filled from there when
  // one arrives before the compaction's turn closes.
  requestModel: string | null;
  requestProvider: string | null;
  requestServiceTier: string | null;
  requestContextWindow: number | null;
}

// What the turn spent its tool calls on. Reading the mix is the quickest way to tell a
// research turn from an editing one without opening the session.
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

// One thing the reader typed after the prompt that started the turn, and when. The same two
// fields as `TurnAnswer` and a name of its own on purpose: a card that mixed the two would
// draw the agent's words under the reader's heading.
export interface TurnAsk {
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
  sourceId: string;
  stepsBefore: number;
  kind: 'commentary' | 'reasoning';
  text: string;
  at: number;
  status: TurnStepStatus;
}

// How many of them one turn carries. A reader can type as often as they like while an agent
// works, and the card draws every one of these at full length, so the list is bounded the way
// the step list is. Over this workspace's own transcripts the most any turn took was four.
export const TURN_ASK_LIMIT = 12;

// One thing a turn did, in the order it did it.
//
// A turn already reports how many tools it ran and in what mix. That is a tally, and a
// reader watching a turn run wants the order: what it is doing now, and what it did to get
// there. A skill needs no separate reading, because a skill load is an ordinary tool call
// carrying the skill's name in its input.
export interface TurnStep {
  ordinal: number;
  // The tool as the agent named it, drawn as the agent named it. The panel writes no
  // vocabulary of its own here: a tool the panel has never heard of still reads correctly.
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
  // Whether the call came back, and how. A step still running is the one the agent is on,
  // which is what a reader watching a live turn is looking for.
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

// How many skill uses one turn carries. Distinct skills per turn are few, so this bound is
// never reached in practice. It exists so one long turn cannot grow the payload without end.
export const TURN_SKILL_USE_LIMIT = 60;

// What a skill load counts as in `Turn.stepKinds`. `stepKinds` is read by ordinal against
// the step list, so a skill load has to occupy its slot, and every count built from those
// kinds has to leave this one out: a skill is not a tool the agent ran, and bucketing it
// with the unrecognized tools names a skill load an unknown call.
export const SKILL_STEP_KIND = 'skill';

// How many steps of one turn are carried.
//
// Measured over this workspace's own transcripts, 98 turns: the median turn runs 11 tools,
// the ninetieth centile runs 108 and the longest ran 211. So the common turn is carried
// whole and the long one is not, and carrying every step of every turn would put a fifth of
// a megabyte of tool calls into a payload that is 64 KB today.
//
// The newest are kept, because the end of the list is where a running turn is and where a
// finished one was left. `Turn.stepCount` is the true total, so the panel can say what it
// is not showing rather than quietly showing less.
export const TURN_STEP_LIMIT = 60;

// Pairing state is wider than the visible card so late results for long turns still update
// hidden recent calls without allowing one unresolved turn to grow a checkpoint indefinitely.
const CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN = TURN_STEP_LIMIT * 4;

// How much of a step's detail is carried.
//
// The card draws one line and clips it, and a wide panel fits about this many characters,
// so the rest is bytes nobody reads. Measured against this workspace's own transcripts:
// uncut, the shell commands alone took the payload for four turns from 64 KB to 211 KB,
// because a heredoc written into a command is the whole of a script.
export const STEP_DETAIL_LIMIT = 120;

// The step detail's own cut, spelled here because a step is not a note and the panel's
// other cuts belong to modules this one sits under.
export const STEP_CUT = '...';

// How much of a narration block is drawn.
//
// Prose is not a command. A narration row wraps, so this bounds the payload rather than a
// line. The 120 characters a one-line step row holds cut almost every Codex block and a
// quarter of Claude's. Measured on this workspace: at 600 the cut reaches 0.5% of Claude
// blocks and 0.4% of Codex ones, and no recorded Codex block passes 954.
export const NARRATION_DETAIL_LIMIT = 600;

// The same thing, cut to what a step row can hold. Whitespace goes first: a command written
// as a heredoc arrives with a whole script inside it, and a line of that is mostly the gaps
// between its lines.
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
  // The prompts that text was built from, oldest first, each with the time it was typed. A
  // prompt that got no response of its own is carried into the next turn and joined to its
  // prompt, so `prompt` is one string holding two of them. Anything offering the reader
  // their prompts back has to hand them one at a time, or a press of Up puts two in the box
  // and Enter sends both. The times are what put them in order against `laterPrompts`, which
  // a carried turn contributes to and which are older than the prompt that carried it.
  promptParts?: readonly TurnAsk[];
  summary: string; // final assistant text of the turn, as markdown
  // Every answer the turn closed, oldest first. On a finished turn the newest entry without
  // `notResponse` is the summary; on one still running, the summary can be a newer text no
  // response has closed yet. The marks, the closing rows and the waiting signal keep reading the
  // summary alone: the format's rule is that the last answer stands alone and repeats
  // what is still open, so a union would mark resolved asks as open.
  answers: TurnAnswer[];
  model: string | null; // the model that ran the turn, from its last real reply
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
  // The request that established the figure above. A turn sums every request it made and ends
  // on whichever record came last, so neither its usage nor its clock answers for that one
  // request, and anything forward-looking needs exactly that one.
  contextRequest?: ContextRequest;
  // The window the turn actually ran against, where the source recorded one, and null
  // where it did not. It is the better of two answers: a published figure is what a model
  // is advertised with, while this is what the session was given, and the two differ.
  contextWindow: number | null;
  toolUses: number;
  toolCounts: ToolCounts;
  // Every tool name in the turn, including calls beyond the activity step window.
  toolTally: Record<string, number>;
  // What the reader typed while the turn was already running, oldest first, cut to
  // `TURN_ASK_LIMIT`. The agent answers these inside the turn, so the card that shows the
  // answer has to show the question.
  laterPrompts: TurnAsk[];
  // What the turn did, in order, newest last, cut to `TURN_STEP_LIMIT`.
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

// Records one skill load on the turn that loaded it, for either reader.
//
// The source id and the name are the identity. A reader that reads one record twice, which
// the byte window makes ordinary, must not report the same load as two: the later copy
// replaces the earlier one and the count stands still. A second load of the same skill under
// a different call id is a second use, because the turn really did load it twice.
export function addTurnSkillUse(turn: Pick<Turn, 'skillUses' | 'skillUseCount'>, use: TurnSkillUse): void {
  const held = turn.skillUses.findIndex((earlier) => earlier.sourceId === use.sourceId && earlier.name === use.name);
  if (held >= 0) {
    turn.skillUses[held] = use;
    return;
  }
  turn.skillUses.push(use);
  turn.skillUseCount++;
  // The newest are kept, the way the step window keeps them: a turn past this bound is one
  // whose recent loads are what a reader is still reading about.
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
  // The file system's own number for the file, from the stat that listed it. An append keeps
  // it and a new file at the same path takes another, so a name held for one transcript is
  // never kept for the next one. A host that answers no number leaves it out.
  ino?: number;
  // Where the session ran, when its opening record says. Continuation uses this instead
  // of moving a session into whichever worktree the current editor window opened.
  cwd?: string;
  // Whether this file is a headless run that belongs outside the reader's day buckets.
  // Claude decides this from its transcript; Codex records it in the opening metadata.
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

// The catalog the last walk produced, brought up to date for one session alone.
//
// Selecting a session cannot add a transcript, remove one, or grow one, so a refresh a
// selection drove has no reason to read the filesystem for the whole workspace again. That
// walk is measured at 20.8 ms median and 32.4 ms p95 over a workspace of about 1,300
// sessions, which is more than a click can be asked to pay for an answer it holds.
//
// What a selection does need is the current revision of the one session it is about to
// read. The tail read is bounded by the recorded size, so a stale size hides the newest turn
// of the very session the reader just asked for. One stat answers that.
//
// Answers null when there is nothing shown, when the shown session is not in the held
// list, or when its file has gone. The caller walks in each of those cases: a selection
// landing on something the held catalog cannot account for is the case a held catalog must
// not be trusted for.
//
// The order is the caller's. Growing a session moves the activity it is ranked by, and
// only the caller can read that.
export function revalidatedCatalog(
  sessions: readonly SessionFile[],
  showing: string | null,
  statOf: (file: string) => Pick<SessionFile, 'mtimeMs' | 'size'> | null,
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
  if (!now) {
    return null;
  }
  const out = [...sessions];
  if (!sameSessionRevision(held, now)) {
    out[at] = { ...held, mtimeMs: now.mtimeMs, size: now.size };
  }
  return out;
}

// Revalidate only the files a directory watcher reported. Every path must already belong
// to the held catalog, and every file must still exist. A miss means the directory changed
// shape, so the caller falls back to the authoritative walk that can discover additions and
// removals.
export function revalidatedCatalogPaths(
  sessions: readonly SessionFile[],
  files: readonly string[],
  statOf: (file: string) => Pick<SessionFile, 'mtimeMs' | 'size'> | null,
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
    if (!now) {
      return null;
    }
    if (!sameSessionRevision(out[at], now)) {
      out[at] = { ...out[at], mtimeMs: now.mtimeMs, size: now.size };
    }
  }
  return out;
}

// Which listed revisions the Project cost offer may trust in place of stating each file itself.
//
// A walk read every one of them a moment ago, so a walk's list stands whole. A reused catalog
// read one file. Handing the offer the rest would let it compare a transcript that has grown
// against the size the last walk saw, answer that nothing changed, and leave that source out
// of the index until a later walking pass offered it again.
export function trustedListedRevisions(
  sessions: readonly SessionFile[],
  walked: boolean,
  showing: string | null,
): Map<string, Pick<SessionFile, 'mtimeMs' | 'size'>> {
  const trusted = walked ? sessions : sessions.filter((session) => session.sessionId === showing);
  return new Map(trusted.map((session) => [session.file, { mtimeMs: session.mtimeMs, size: session.size }]));
}

// A point where the session was replaced by a summary of itself, either because it
// ran out of context or because the user asked for it. Everything before it left the
// agent's memory, so it is the one boundary in a session that changes what the agent
// knows, and it belongs on the timeline beside the turns.
export interface Compaction {
  sessionId: string;
  at: number; // epoch ms
  contextBefore: number; // tokens the session had grown to
  contextAfter: number; // tokens the summary came to, 0 if unknown
  droppedTokens: number; // cumulative across the session, 0 if unknown
  durationMs: number; // how long the summarising call took, 0 if unknown
  trigger: string; // 'manual' when asked for, 'auto' when the context ran out
  model: string | null; // the model that ran, for pricing the summarising call
  summary: string; // the summary that carried over, as markdown
  // Recent Codex records preserve the request-level usage for the compaction itself. This is
  // optional because Claude metadata and older Codex records do not contain an equivalent.
  usage?: TurnUsage;
  provider?: string | null;
  contextWindow?: number | null;
  inferenceClass?: UsageInferenceClass;
  serviceTier?: string | null;
  // The last main request before a Claude compaction, which sizes the input of the compaction
  // request. Null where the session held no earlier request.
  previousRequest?: CompactionPreviousRequest | null;
  // The length of a Claude summary's stored text, counted as `compactSummaryChars` counts it.
  summaryChars?: number;
  // The cache read of the first request in the Claude transcript, from `claudeFirstRequestCacheRead`.
  // Absent where the head of the file holds no request.
  firstRequestCacheRead?: number;
}

// What Claude Code records about a compaction it has just run, on a `system` line beside
// the summary itself.
interface CompactMetadata {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  cumulativeDroppedTokens?: number;
}

export interface SessionRead {
  turns: Turn[];
  compactions: Compaction[];
  // The transcript bytes covered by this parse. The provider retains it for the selected
  // session so an append cannot move the beginning past visible turns.
  readBytes: number;
  // True when the parser discarded at least one older turn at maxTurns.
  turnLimitReached: boolean;
  // Present only when a selected tail ended inside its newest turn. The provider hands
  // this opaque byte cursor back to the source adapter; it does not inspect transcript
  // records itself.
  newestTurnCursor?: BackwardLineCursor;
  newestTurnState?: unknown;
}

// The transcript facts needed by the rail's cost and context figures. Kept smaller than a
// Turn because this value is persisted for every listed session. New rail metrics add
// their source facts here rather than caching a formatted chip or forcing the session
// through the full parse budget.
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
  provider: string | null;
  usage: TurnUsage;
  usageParts?: TurnUsagePart[];
  contextTokens: number;
  contextWindow: number | null;
  // The request behind that level lets a rail row state whether its prompt cache is still
  // warm without reading the session outside the parse cut.
  contextRequest?: ContextRequest | null;
  // The metadata pass deliberately does not read child transcripts. Their presence makes
  // the parent-only cost a floor until the ordinary parser supplies the complete figure.
  childSpendPartial: boolean;
}

export interface SessionStatCompactionFacts {
  at: number;
  contextAfter: number;
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
    })),
    compactions: read.compactions.map((compaction) => ({
      at: compaction.at,
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
  // A background row stays open across typed prompts until its notice lands, so every turn in
  // the read counts, in launch order. A background row takes its id from its launch result,
  // and a foreground row from its final result, so an open row with an id is a background
  // child.
  // A recorded process end ends every child launched before it, so the list starts again.
  for (const turn of [...read.turns].sort((a, b) => a.startedAt - b.startedAt)) {
    for (const agent of turn.agents) {
      if (!agent.id) {
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

// The cwd a session ran in, read from the head of its transcript. Every line carries it,
// so only the first few need looking at.
export function readSessionCwd(file: string): string | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, read).toString('utf8').split('\n')) {
      if (line.indexOf('"cwd"') < 0) {
        continue;
      }
      try {
        const o = JSON.parse(line) as { cwd?: string };
        if (o.cwd) {
          return o.cwd;
        }
      } catch {
        /* a partial last line, or a line without one */
      }
    }
  } catch {
    /* unreadable */
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

// Whether a run of complete transcript lines holds a prompt a human typed.
//
// A cross-session coordination message wakes a session whose activity becomes a session
// file with no human prompt in it, and such a file drew as a "Session <hash>" card with
// no title and no drawable turn. A human prompt is a typed prompt whose origin, where
// one is recorded, is not a machine's: the peer message itself arrives as a meta user
// line, which `isTypedPrompt` already refuses, and the origin check is the belt on top
// for a peer prompt written without the flag. Only the known machine kind is refused,
// and a prompt with no origin at all counts as human, because transcripts from before
// the field existed have none: the rule fails open the way the Codex internal-thread
// rule does, so a kind added later cannot silently hide a user's sessions.
export function holdsHumanPrompt(text: string): boolean {
  for (const line of text.split('\n')) {
    if (humanPromptIn(line, true)) {
      return true;
    }
  }
  return false;
}

// The rule above, for one line, answering with the record so a caller can read its time.
//
// Two callers ask nearly the same question of a line and one clause separates them, so it is
// a parameter rather than a second spelling. Listing refuses a peer prompt, because a session
// woken by another session and never prompted by a human is not a session. Counting what
// is new must not, because `readSession` opens a turn on a peer prompt and draws a card for
// it: a glance that refused one would count fewer turns than the panel then shows, and would
// word an exact answer as a floor because the turn the reader had read was invisible to it.
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

// How much of a transcript's end is read to find out what has happened in it lately.
//
// A turn begins at a typed human prompt, so counting what is new in a session needs
// only those, which is far cheaper than parsing it. Measured over the sessions a rail
// actually lists, a 1 MB window finds a turn in 93.9% of this workspace's 49 and 99.2% of
// the largest project's 130, against 85.7% and 96.2% at 256 KB, and costs 0.44 ms per file
// against 0.37 ms. The wider window is worth its cost: a session the window misses
// says nothing at all, which is the answer the reader complained about.
//
// Do not read this figure as coverage over every transcript on a machine. Over a sample of
// all 1,670 here, most of them old and abandoned, a 1 MB window finds a turn in 28.7%. Those
// files are not on a rail, and the population that matters is the one the rail lists.
export const TURN_START_BYTES = 1024 * 1024;

// The farthest a default turn-start glance reads when its first window finds no start.
// The worst case reads 16 MB from disk and rescans 31 MB of decoded text. A custom initial
// window scales the ceiling by the same ratio so small fixtures exercise the complete rule.
export const TURN_START_MAX_BYTES = 16 * 1024 * 1024;

// When each turn in the window began, and whether the window reached the start of the file.
//
// The second half is not decoration. A count taken from a window and presented as a total is
// wrong in the direction that looks right, so the caller is told what it is holding and words
// it as a floor where it has to.
export interface TurnStarts {
  starts: number[];
  whole: boolean;
}

// Reads a widening tail through one file handle until the source finds a turn start.
//
// Growing does not by itself make the answer partial. Where the window stopped decides that. A
// read that reached byte zero holds every start the file has, however many times it grew to get
// there. A read that stopped short leaves older starts unseen. The rail words a partial count
// as a floor, so calling a complete count partial would say `at least 1 new` about a
// session whose every turn was counted.
export function readTurnStartsFromTail(
  file: string,
  startsIn: (lines: string[]) => number[],
  bytes = TURN_START_BYTES,
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
        const next = fs.readSync(fd, chunk, read, length - read, nextStart + read);
        if (next <= 0) {
          throw new Error('Turn-start glance stopped before its requested range.');
        }
        read += next;
      }
      body = Buffer.concat([chunk, body]);
      start = nextStart;

      // The first line is offered to the scanner rather than dropped. A read that began part
      // way through a line hands over a fragment, and both scanners parse a line as JSON before
      // they believe it, so a fragment finds nothing. Dropping it instead would throw away a
      // complete record that begins on the byte the read began on, and at the ceiling that is
      // the last chance the session has to report a turn at all.
      const lines = body.toString('utf8').split('\n');
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

// The turn starts in the tail of one session transcript, oldest first.
//
// A file that cannot be read answers with nothing found and a window that did not reach the
// start, which is the silence an unread session gets rather than a claim of zero.
export function readSessionTurnStarts(file: string, bytes = TURN_START_BYTES, childTranscript = false): TurnStarts {
  return readTurnStartsFromTail(file, (lines) => sessionTurnStartsIn(lines, childTranscript), bytes);
}

function sessionTurnStartsIn(lines: string[], childTranscript = false): number[] {
  const starts: number[] = [];
  for (const line of lines) {
    // Not refusing a peer prompt, because `readSession` does not: this counts the turns the
    // panel would draw, and the peer-wake cut is the listing's question, not this one.
    if (line.indexOf('"type":"user"') < 0) {
      continue;
    }
    let o: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        if (record.type === 'user' && isTypedPrompt(record, childTranscript)) {
          o = record;
        }
      }
    } catch {
      /* a partial line has no turn start */
    }
    if (!o) {
      continue;
    }
    // Not through `stamp`, which answers 0 for a time it cannot read: a 0 is a real epoch
    // time and would sort as the oldest turn the session ever had.
    const at = Date.parse(String(o.timestamp));
    if (Number.isNaN(at)) {
      continue;
    }
    starts.push(at);
  }
  return starts;
}

// The scan's cursor over one session file: how many bytes hold only complete lines
// already looked at, and whether a human prompt has been seen. Found is sticky, because
// a prompt does not unhappen, and the cursor is what makes the scan incremental: each
// byte of a file that holds no human prompt is read once ever, and a wake file joins the
// list the moment a human prompts it, because the prompt lands in the unread bytes.
export interface HumanPromptScan {
  bytes: number;
  found: boolean;
}

// Reads only what the previous scan has not, stopping at the first human prompt. Lines
// are split at the byte level and decoded one at a time, because a chunk boundary can
// fall inside a multi-byte character; an unterminated final line is left for the next
// scan, when it will be complete. A file that shrank was rewritten, so it is read from
// the start again.
export function scanForHumanPrompt(file: string, size: number, prev?: HumanPromptScan): HumanPromptScan {
  if (prev?.found) {
    return prev;
  }
  let found = false;
  const from = prev && prev.bytes <= size ? prev.bytes : 0;
  const { bytes } = readCompleteLines(file, from, size, (text) => (found = holdsHumanPrompt(text)));
  return { bytes, found };
}

// Hands the complete lines between `from` and `size` to `visit`, one chunk of lines at a
// time, and answers with the byte after the last complete line handed over. A visitor that
// answers true stops the read. The bytes after the last newline in a chunk are copied,
// because the next read overwrites the buffer they sit in. Lines split at byte 0x0A, which
// never appears inside a UTF-8 sequence, so a multi-byte character split across two chunks
// always reaches `visit` whole. An unterminated final line waits for the next read, when it
// will be complete. `rest` holds that line when the read reached `size`, and is empty when
// the file ends at a newline. It is null when the read stopped short: a visitor stopped it,
// or the file could not be read to the end.
function readCompleteLines(
  file: string,
  from: number,
  size: number,
  visit: (text: string) => boolean,
): { bytes: number; rest: Buffer | null } {
  let bytes = from;
  if (size <= bytes) {
    return { bytes, rest: Buffer.alloc(0) };
  }
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    let carry: Buffer | null = null;
    let pos = bytes;
    const chunk = Buffer.allocUnsafe(256 * 1024);
    while (pos < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (read <= 0) {
        break;
      }
      pos += read;
      const buf: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        // Copied, because the next read overwrites the chunk the slice points into.
        carry = Buffer.from(buf);
        continue;
      }
      carry = lastNewline + 1 < buf.length ? Buffer.from(buf.subarray(lastNewline + 1)) : null;
      bytes = pos - (carry ? carry.length : 0);
      if (visit(buf.subarray(0, lastNewline).toString('utf8'))) {
        return { bytes, rest: null };
      }
    }
    if (pos >= size) {
      return { bytes, rest: carry ?? Buffer.alloc(0) };
    }
  } catch {
    /* unreadable; answered from what was read */
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

// What to call a session in a list of them, without parsing it.
//
// A name the owner gave the session, in Arc or with `/rename` or `--name`, comes first,
// then the title Claude Code generates, then the first thing the user typed. The CLI writes
// the `custom-title` and `ai-title` records again every few turns with the same value, so the
// newest of each sits near the end and a small tail finds it. The first prompt comes from
// the head of the file, which never changes, so a session without a recorded title keeps
// one name however far the file grows.
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

// The name a `custom-title` record gives, or null when it clears the custom name. An empty or
// blank value clears it for this read, which then falls back to the generated title or the
// first prompt. A panel that already holds a custom name for the session goes on drawing it,
// because a held name never moves down the ranking in `sessionnames.ts`.
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
  let fd = -1;
  try {
    fd = fs.openSync(path.join(path.dirname(sessionFile), sessionId, 'custom-title.json'), 'r');
    // The size is checked on the open file, so a file that grows after a stat cannot make
    // this read more than the bound.
    const size = fs.fstatSync(fd).size;
    if (size < 1 || size > bytes) {
      return null;
    }
    const content = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, content, offset, size - offset, offset);
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

// How much of a transcript's head the first typed prompt is looked for in. Over 1,129 local
// transcripts, the first typed prompt ends inside 128 KB in 99 percent of them. A session
// whose first prompt ends past the window has no prompt name.
export const SESSION_HEAD_BYTES = 128 * 1024;

// How much of a transcript's head names the file when a title already names the session.
// The first record of a Claude transcript fits inside it.
export const HEAD_KEY_BYTES = 4096;

// A short fingerprint of a file's first record. An append-only transcript keeps it for life,
// so a different one means the path now holds another transcript.
function headKeyOf(firstLine: string): string {
  return createHash('sha1').update(firstLine).digest('hex').slice(0, 16);
}

function firstPromptIn(lines: string[], childTranscript: boolean): { short: string | null; full: string | null } {
  for (const line of lines) {
    if (line.indexOf('"type":"user"') < 0) {
      continue;
    }
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!isTypedPrompt(o, childTranscript)) {
      continue;
    }
    const source = cleanPrompt(textOf((o.message as { content?: unknown }).content));
    const short = normalizeSessionTitle(source);
    if (short) {
      return { short, full: normalizeFullSessionTitle(source) };
    }
  }
  return { short: null, full: null };
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
    const read = fs.readSync(fd, buf, 0, bytes, 0);
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
): { title: SessionTitle; headKey?: string } {
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
  };
}

// When a session was last active, as the session itself recorded it, or null when nothing
// in the tail window carries a time.
//
// Not the file's mtime. An agent appends bookkeeping to a transcript that is not the
// session moving: a title, a mode, a snapshot of file history, the records written as
// a session is closed. Taking the mtime therefore sent a session nobody had touched
// back to the top of the list reading `just now`. Across the transcripts on
// this machine, 392 files' mtimes stood more than a minute past their newest recorded
// time, 147 more than a day, and the worst by 56 days.
//
// The rule is deliberately not a list of record types. New types arrive with each release,
// so the answer is the newest time any record in the window actually carries: a type added
// later either carries one and counts, or does not and is ignored, and there is no table to
// keep in step. The maximum rather than the last one found, because records are not
// strictly ordered and a sidechain's line can land after a newer one.
//
// A time that will not parse is skipped rather than counted, which is why this does not go
// through `stamp`: that answers 0 for an unreadable time, and a 0 is a real epoch time that
// would win against nothing and lose against everything.
//
// The window is the 256 KB tail `readSessionMeta` already takes. Over the 1,602
// transcripts here that hold a timestamped record, the newest one sits a median 4.6 KB from
// the end of the file and 25 KB at the 99th percentile, and 256 KB reaches it in all of
// them. Codex rollouts answer to the same reader: every line of one carries a top-level
// `timestamp` written the same way.
export function readSessionActivity(file: string, bytes = 256 * 1024): number | null {
  return activityIn(tailLines(file, bytes));
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

// A session's name, its last activity and whether anyone was in it, off one read of the
// tail. All three are wanted for every session the panel lists, and they come out of the
// same window, so reading it again would be the whole cost of the later answers.
export function readSessionMeta(
  file: string,
  bytes = 256 * 1024,
  sessionId = '',
  childTranscript = false,
): SessionMeta {
  const read = tailOf(file, bytes);
  const { title, headKey } = sessionTitleOf(file, read, childTranscript);
  const tail = outcomeIn(read.lines, childTranscript);
  return {
    title: title.short,
    fullTitle: title.full,
    titleSource: title.source,
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

// Whether a session was run by an agent rather than had by a person, or null where
// this window cannot say.
//
// A session another agent started by shelling out to the CLI records nothing naming
// the agent that started it. The session id it inherits is overwritten before anything can
// read it, the entrypoint field carries whatever shell it was spawned from, and the
// session registry files record the same kind for both. There is no positive link to read,
// so this reads the absence of a person instead.
//
// These things only a person leaves behind, under every entrypoint. A follow-up the reader
// typed while the agent worked, which arrives as a queued attachment. An editor selection or
// an opened file, which arrive as attachments on a prompt and only from an editor. A slash
// command whose record carries a human origin, which is what Arc's own panel writes. A `<ide_`
// tag on a prompt. A remote-control bridge record, when no record anywhere in the file names
// `sessionKind: 'bg'`. A system record outside `UNATTENDED_SYSTEM_SUBTYPES`. A tool call the reader refused
// themselves, marked `toolDenialKind: 'user-rejected'`. And a question the agent stopped to
// put to the reader, which it asks only where somebody is expected to choose.
//
// A non-SDK entrypoint and a human-origin typed prompt are each read the moment they arrive,
// and a `sessionKind: 'bg'` record excuses one only when it carried `bg` itself or an earlier
// record already did. A `bg` record arriving later never undoes a sign already read that way.
//
// Three more signs step back once every record that names an entrypoint names an SDK one, or
// once `sessionKind: 'bg'` has arrived anywhere in the file by the time the whole tally is
// read: a changed file, a tool call Claude Code refused on its own (`toolDenialKind:
// 'permission-rule'`, what read-only dispatch gets under `--permission-mode dontAsk` when the
// model tries a command that is not read-only), and the unattended system subtypes. Both can
// happen with nobody watching, and `claude --bg` runs unattended by design. A slash command
// with no origin steps back only in an SDK-only transcript, read there as the run's own prompt
// rather than a second one. Under any other entrypoint and with no `sessionKind: 'bg'`
// anywhere in the file, each of these still marks the session a person's, so it stays in the
// list rather than folding away.
//
// A single typed prompt with no human origin, and a turn that finished, is the base case
// every other sign narrows. An SDK-only transcript with no `sessionKind: 'bg'` does not wait
// for the finish, as `agentRunOfTally` sets out. A second typed prompt is ordinarily a person
// too, because a run of the CLI in print mode takes one prompt and stops. That bends twice. A
// background session allows its one prompt a human origin, typed or a slash command, because
// `claude --bg` sends one on the request that starts it. A second prompt of either form there
// is still a person when it carries a human origin. A follow-up the dispatching agent sends
// carries `promptSource: 'sdk'` and no human origin. That prompt is not counted at all. A
// background session whose only prompt is shaped that way reads as the owner's, not a run. An SDK-only transcript
// never counts a typed prompt with no origin toward the second prompt either. That is what
// lets a resumed `claude -p --resume` review carry more than one prompt without reading as
// somebody's session. A typed prompt with a human origin is still a person there.
//
// `lines` is the window split at each newline, so its last entry is whatever follows the last
// newline. A transcript an agent is still appending to often ends in half a record there. That
// entry is skipped when it will not parse, and the next read takes it once it is whole.
// `scanForAgentRun` skips the same half-written last line, so the two readers agree.
//
// Null when the window did not reach the start of the file, because the signs may sit
// outside it. Null too when a complete line will not parse, because it could hold any of the
// signs. The caller reads null as a person, and `scanForAgentRun` answers for a file
// larger than the window. Erring towards a person is the only direction this may be wrong
// in: the cost of missing a run is a row in a list, and the cost of hiding a session
// somebody had is their own work filed under somebody else's name.
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
      // The rule of `lastLineWhole` in childartifacts.ts, inline so each line parses once.
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

// The system records Claude Code writes with nobody present. They are no sign of a person
// only in a transcript whose records carry an SDK entrypoint, or one that carries
// `sessionKind: 'bg'` anywhere in it. Under every other entrypoint, and in a transcript that
// names none, each of them is a person, because an older editor or terminal build writes no
// human origin and a long single-prompt session there often shows nothing else. Every other
// subtype, a `local_command` among them and any subtype this list does not know, reads as a
// person under every entrypoint. `away_summary` is the recap Claude Code writes when it
// stops with nobody watching, and it carries a summary of the work rather than a status word.
const UNATTENDED_SYSTEM_SUBTYPES = new Set([
  'stop_hook_summary',
  'compact_boundary',
  'turn_duration',
  'api_error',
  'informational',
  'away_summary',
]);

// What the rule carries from one record to the next. `unattended` is whether a record of
// `UNATTENDED_SYSTEM_SUBTYPES` was seen. `changedFile` is whether an assistant record asked to
// change a file, and `deniedTool` is whether a tool call was refused for a reason short of the
// reader saying no. `command` is whether a slash command with no human origin was seen, read
// as the run's own prompt in an SDK-only transcript. `bridgeSession` is whether Claude Code's
// own remote-control `bridge-session` record was seen. `bg` is whether any record so far
// carried `sessionKind: 'bg'`, which is sticky once seen even if an earlier record in the same
// file did not carry it. `entrypoint` is `sdk` while every record that names an entrypoint
// names an SDK one, such as `sdk-cli`, and `other` once any record names another.
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
  // `null` parses. Reading a field off it would throw out of `readSessionMeta` and take
  // down the whole refresh, since every listed session goes through it.
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }
  const o = parsed as Record<string, unknown>;
  // A subagent writes its own file and the harness writes its own assistant records,
  // so neither shape reaches a main transcript today and both of these are the belt
  // rather than the fix. They are here because the rule below claims to take the same
  // reading `readSession` takes, and `readSession` skips both: without them a
  // subagent's answer or a harness line would close the first turn on a session
  // a person is still sitting in, which is the worst answer this rule has.
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
  // A non-SDK entrypoint is a final person sign at once, unless `sessionKind: 'bg'` already
  // arrived on this record or an earlier one. Checking on every record, inside the rule both
  // readers call, keeps the whole-file tally and the incremental scan agreeing for any order
  // a real transcript can put these two fields in. Checked after the sidechain and harness
  // skips above, so a subagent's own entrypoint never speaks for the session it runs inside.
  if (tally.entrypoint === 'other' && !tally.bg) {
    return true;
  }
  const type = o.type;
  // Claude Code's own remote-control record sits beside a session's `sessionKind: 'bg'`
  // records, so it is no sign of a person there. Tallied rather than decided here because the
  // record naming the session background may not have arrived yet, and unlike the entrypoint
  // and human-origin signs above, this one is never read before the whole tally is in.
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
  // A follow-up typed while the agent works arrives as a queued attachment, not a prompt
  // record. `isReaderQueued` is the rule the turn reader tells the reader's own apart with, so
  // another session's message and a background task's notice do not count. Somebody attached
  // and typed while the agent was already going, which a resumed SDK call or a background
  // dispatch never does on its own, so this is decided here rather than left to the tally.
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
  // Anything the editor added to a prompt, not only a selection or an opened file: every
  // one of them arrives from an editor a person is sitting in.
  const said = textOf((o.message as { content?: unknown } | undefined)?.content);
  if (said.includes('<ide_')) {
    return true;
  }
  if (said.includes('<command-name>')) {
    // Arc's own panel marks a slash command with a human origin (`HUMAN_ORIGIN` in
    // claudewire.ts), so that one is still a person under every entrypoint. The one exception
    // is a background session, which reads it as it reads a typed prompt with a human origin:
    // `claude --bg` sends its launch prompt with that origin, so the prompt joins the shared
    // count, and a second prompt of either form fails it. A command with no origin is tallied
    // instead of decided here, because whether every entrypoint in this file names an SDK one
    // is not known until `agentRunOfTally` reads the whole tally.
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
  // Through the same rule the turn reader counts prompts with, rather than a fourth
  // answer to the same question. It already drops tool results, meta records, compaction
  // summaries and sidechains, and it does not need a prompt id to be present.
  if (!isTypedPrompt(o)) {
    return false;
  }
  // A human origin is a final person sign at once, the same order rule the entrypoint check
  // above applies: `sessionKind: 'bg'` excuses it only when it already arrived on this record
  // or an earlier one, the shape of a background session's own first prompt. Deferred past
  // that point, a typed prompt with no origin only ever adds to the shared count.
  const origin = o.origin as { kind?: unknown } | null | undefined;
  if (!tally.bg && origin?.kind === 'human') {
    return true;
  }
  // A background session's own dispatching agent sends a worker its follow-ups with
  // `promptSource: 'sdk'` and no human origin, the shape `bridge-session` and `stop_hook_summary`
  // arrive beside. That one never reaches the shared count, so it cannot fail the background
  // branch's exactly-one-prompt check below. A follow-up with a human origin, what `claude
  // attach` plus typing writes, still falls through to `tallyTypedPrompt` and still counts.
  if (tally.bg && origin?.kind !== 'human' && o.promptSource === 'sdk') {
    return false;
  }
  tallyTypedPrompt(tally);
  return false;
}

// A queued follow-up with a human origin is a person, decided the moment it is read. Any
// other one adds to the shared prompt count, and a second typed prompt of any kind, whatever
// its own origin or the one before it, is a person too: the exceptions below excuse a
// resumed SDK call or a background dispatch's own prompt, never somebody attaching mid-turn.
function queuedPromptIsPerson(origin: unknown, tally: AgentRunTally): boolean {
  if ((origin as { kind?: unknown } | null | undefined)?.kind === 'human') {
    return true;
  }
  tally.prompts += 1;
  return tally.prompts > 1;
}

// Tallies a typed prompt that reached here with no human origin, or with one already excused
// by a `sessionKind: 'bg'` seen at or before it: one more toward the count.
function tallyTypedPrompt(tally: AgentRunTally): void {
  tally.prompts += 1;
}

// Whether the tally's typed prompts read as one worth counting. A background session allows
// exactly one counted prompt, whatever its origin, because `claude --bg` sends a human origin
// on the request that starts it. Once `bg` has arrived, a later human-origin prompt is excused
// from the immediate per-record check above and falls through to `tallyTypedPrompt` instead,
// so the count itself, not that check, is what rejects a background session's second
// human-origin prompt. A dispatched follow-up with no human origin never reaches the count at
// all. Checked before the SDK case, because a background session's entrypoint is often
// `sdk-cli` too, and unlike the SDK branch it allows exactly one counted prompt, never more. An
// SDK-only transcript with no `bg` allows any number of prompts with no origin at all, because
// a resumed `claude -p --resume` review adds one per call, and `agentRunOfTally` accepts them
// there before any turn finishes. Every other transcript allows exactly one, because a run of
// the CLI in print mode takes one prompt and stops, and every prompt that reaches this count
// already had no human origin.
function promptsOk(tally: AgentRunTally): boolean {
  if (tally.bg) {
    return tally.prompts === 1;
  }
  if (tally.entrypoint === 'sdk') {
    return tally.prompts >= 1;
  }
  return tally.prompts === 1;
}

// A set of typed prompts `promptsOk` accepts, and a turn that finished. A file holding no
// prompt at all is not a session anybody had. A terminal or editor entrypoint reaches a
// person sign in `personSignIn` on its first record, so the finish requirement never decides
// that case. It matters only for a file that names no entrypoint and for a background
// session, where a session still inside its first turn is the shape this rule cannot tell
// from a run at all, because every sign of a person arrives later than the first prompt: the
// reader asks a question, the agent reads and greps its way through an answer, and until it
// edits something or the reader types again the transcript is indistinguishable from a
// print-mode run. Marking that one is the worst thing this can do, because it takes the
// session the reader is sitting in out of the panel.
//
// An SDK-only transcript with no `sessionKind: 'bg'` needs no finished turn. That rests on one
// assumption: the panel is the SDK host with a person at the keyboard, it sends every Claude
// prompt with a human origin, and `personSignIn` reads that as a person at once. So an
// SDK-only prompt with no human origin came from another program. Once its turn finished,
// that transcript reads as a run anyway, and waiting for the finish only files a running
// reviewer or worker under Today. A person in another Agent SDK host that sends no human
// origin files under Run by agents during the first turn, as it already did once the turn
// finished. Every later sign of a person still ends the answer. A background session keeps
// the finish requirement, because its first prompt carries a human origin by design.
//
// `lenient` names the two conditions that step three more signs back: an SDK-only transcript,
// and one that carries `sessionKind: 'bg'` anywhere in it. Under either, the unattended system
// subtypes, a changed file, and a tool denial short of the reader saying no are not a person.
// A slash command with no origin is excused only in the SDK-only case, read there as the run's
// own prompt. The remote-control `bridge-session` record is excused only in the background
// case. Both of these read the tally's final state, unlike the entrypoint and human-origin
// signs `personSignIn` already read and settled per record.
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

// The whole-file form of `agentRunIn`: its cursor, the tally so far, and whether a sign of a
// person has been seen. A person is sticky, because a sign does not unhappen, so a file once
// answered that way is never read for this again.
export interface AgentRunScan extends AgentRunTally {
  bytes: number;
  person: boolean;
  // The file size the scan read to the end of, when every byte past `bytes` belongs to one
  // half-written last line. Absent when the scan stopped short of the end.
  end?: number;
}

// Whether a scan that covered `size` bytes reads as an agent run. Only a transcript from an
// SDK caller, or one that carries `sessionKind: 'bg'` anywhere in it by the time the scan
// reaches the end, gets a run answer here. `personSignIn` already turned a non-SDK entrypoint
// arriving with no `bg` seen yet into a sticky person, so a `bg` record later in the same file
// never reaches this check. A file larger than the metadata tail under any other entrypoint
// reads as a person, the answer it gets with no further reasoning. A scan that stopped short
// of the end left bytes unread, and they could hold a sign of a person. A half-written last
// line is the exception, as it is for `agentRunIn`: the scan answers from the lines before
// it, and the next scan reads it once it is whole.
export function agentRunOfScan(scan: AgentRunScan, size: number): boolean {
  return (
    !scan.person &&
    (scan.bytes === size || scan.end === size) &&
    (scan.entrypoint === 'sdk' || scan.bg) &&
    agentRunOfTally(scan)
  );
}

// Reads only what the previous scan has not, through the rule `agentRunIn` applies, and stops
// at the first sign of a person. A complete line that will not parse is a person, which is
// the reading `agentRunIn` gives it. `personSignIn` itself ends the scan with a person on
// a non-SDK entrypoint, unless that record or an earlier one already carried `sessionKind:
// 'bg'`, the same order rule the whole-file tail reader applies, so the two readers agree for
// every order a real transcript can put these two fields in. A file that shrank was rewritten,
// so it is read from the start again.
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

// Whether a person spoke in a dispatched session. A dispatch edge files a session under Run by
// agents on a positive fact, so only a positive sign of a person moves it back. This reads a
// narrower set of signs than `agentRunIn`, whose guess of false also covers a first turn that
// has not finished.
//
// These count. A slash command or a typed prompt with a human origin, except the first prompt
// of a background session, which `claude --bg` sends with a human origin itself whatever its
// content. A follow-up queued while the agent worked, by the rule of `isReaderQueued`, because
// a queued follow-up always comes after the prompt the agent was working on. A tool call the
// reader refused. A `<ide_` tag on a typed prompt after the first, because the first is the
// launch prompt the dispatching agent wrote. A prompt the dispatching agent sends with
// `promptSource: 'sdk'`, a message from another session, a background task's notice, and a
// question the agent puts to the reader are no sign. `prompts` counts the prompts read so far,
// so the launch prompt is told apart from a later one. A person is sticky, so a file once
// answered that way is never read for this again.
//
// A `start` above 0 reads only the bytes from there on, for a session still running. That scan
// cannot see the prompts or the `sessionKind: 'bg'` record written before `start`, so it counts
// no typed prompt and reads no editor tag. It takes a queued follow-up, a refused tool call,
// and a slash command with a human origin. `userBefore` notes whether the bytes before `start`
// hold a user record. When they hold none, the first prompt the scan reads is the launch
// prompt and no sign, when that prompt is a slash command in a background session. A slash
// command that follows an earlier prompt in the same scan counts as a person's. A line cut
// at `start` does not parse and is skipped. The whole-file read takes every sign, and `readClaudeAgentSpend` makes it
// once the session is quiet.
export interface PersonScan {
  bytes: number;
  person: boolean;
  prompts: number;
  bg: boolean;
  start: number;
  userBefore: boolean;
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
      if (personSpokeIn(parsed, scan)) {
        scan.person = true;
        return true;
      }
    }
    return false;
  }).bytes;
  return scan;
}

// Whether the first `size` bytes of a transcript hold a user record, a cut last line included.
// The read goes in small steps and stops at the first one, which in a running child is its
// launch prompt near the head, so a running child still costs about its metadata.
function holdsUserRecord(file: string, size: number): boolean {
  const mark = Buffer.from('"type":"user"');
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.allocUnsafe(4 * 1024);
    let pos = 0;
    while (pos < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
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
    /* unreadable; answered as no user record */
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
  // The slash command rule of `personSignIn`, meta records included, with the launch
  // exception the typed-prompt branch below also carries. A slash command is the launch
  // prompt only in a background session, when it is the first prompt this scan counts and
  // no user record came before it, including the bytes a partial scan skipped.
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

// Whether an assistant record holds a call that asks to write to a file, read through the
// same table the turn's tool mix is counted with, so a tool that starts editing is known to
// both at once.
//
// The request, not the result. An edit that failed still says somebody meant to change this
// tree, and reading the result would mean carrying a second rule about what each tool calls
// success. Both readings err the same way, towards calling the session a person's.
function askedToChangeAFile(record: Record<string, unknown>): boolean {
  return calledATool(record, (name) => TOOL_KIND[name] === 'edits');
}

// The tools that stop the turn and put a choice to the reader. A call to one of them says
// the agent expected somebody to be there, and a first turn otherwise says nothing about
// that either way.
//
// Print mode is not the line. The panel's own composer drives `claude -p` and puts these
// asks to the reader. `claudewire.ts` reads the same name to tell a question from an
// ordinary permission ask. A bare run with no permission tool allows every tool without
// asking. What earns a name its place here is that an agent working alone has no reason to
// call it.
//
// Measured over every transcript of this workspace: none of the sessions this rule
// calls a run holds one of these calls, and twelve that it calls a person's do.
const ASKS_THE_READER = new Set(['AskUserQuestion']);

// Whether an assistant record holds a call that puts a question to the reader. The request
// again and not the answer, for the reason above: a question that came back an error still
// says the agent expected somebody to be there.
function askedTheReader(record: Record<string, unknown>): boolean {
  return calledATool(record, (name) => ASKS_THE_READER.has(name));
}

// Whether an assistant record closed a turn. A response that stopped to call a tool has not
// finished anything; anything else it stopped for ended the turn. This is the same reading
// `readSession` takes when it decides which turn is the one still running.
export function finishedATurn(record: Record<string, unknown>): boolean {
  const stop = (record.message as { stop_reason?: unknown } | undefined)?.stop_reason;
  return typeof stop === 'string' && stop.length > 0 && stop !== 'tool_use';
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

// Tool results are the bulk of a transcript. A cheap substring keeps a line out of
// JSON.parse unless it carries something the timeline reports.
//
// `gitOperation` is written by the CLI when it recognizes a commit in the output, not when
// the command asked for one. Measured over this project's transcripts, it is on nearly every
// result that printed a commit line and on almost none that printed none. So a quiet
// commit's result is skipped here, and every reader downstream sees a turn that committed
// nothing.
//
// A fast-forward merge is the same problem. It prints `Updating a..b` and `Fast-forward`, and
// no `gitOperation` is written for it either.
//
// `wrote` is what fixes both. The caller passes the call ids whose command said `git commit`
// or `git merge`, which it already knows by the time the result arrives, and a result
// answering one of them is read whatever it printed. A caller with no such set keeps the
// behavior it had.
//
// A read of a child's own transcript passes two more kinds of id: its Edit, Write and
// NotebookEdit calls, and every call that ran git. A child's record carries none of the
// fields named above, not even `gitOperation`, so without those ids its edits and its
// commits reach no reader at all. The change of an edit lives in the call's own input, and
// the commit lives in the text the result printed.
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
    line.indexOf('"gitOperation"') >= 0
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

const LOCAL_COMMAND_OUTPUT = /<local-command-(?:stdout|stderr)>/;

// The answer Claude Code records for a command it runs by itself, such as `/rename` or
// `/usage`. The typed command opened a turn, and no assistant record follows it. `parent` is
// the id of the record the answer replies to. A reader withdraws a turn for this answer only
// when `parent` names the typed record that opened the turn, because an answer to a harness
// command such as `/effort` can follow a prompt that is still waiting for the model.
//
// A `local_command` record without an output tag holds a command, not an answer.
export function claudeLocalAnswer(record: unknown): { at: number; parent: string } | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }
  const value = record as Record<string, unknown>;
  if (value.type !== 'system' || value.subtype !== 'local_command' || value.isSidechain) {
    return null;
  }
  const parent = value.parentUuid;
  if (typeof parent !== 'string' || !parent) {
    return null;
  }
  if (!LOCAL_COMMAND_OUTPUT.test(textOf(value.content))) {
    return null;
  }
  return { at: stamp(value.timestamp), parent };
}

// Whether an assistant record is the model answering: an error, a tool call, reply text, or
// any output at all.
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
// answer withdrew the command, such a record makes the command a turn again in every reader.
// A process end, a notice or a `<synthetic>` reply does not.
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
  // The outcome that the newest typed prompt replaced. A local command answer withdraws the
  // command's outcome and puts this one back.
  let previous = null as { outcome: TurnOutcome | null; modelAnswered: boolean } | null;
  // The command's outcome that a local command answer withdrew, until the model works after it.
  let withdrawn: TurnOutcome | null = null;
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
      withdrawn = null;
      outcome = { finished: false, error: false, interrupted: false, endedAt: startedAt, startedAt };
      command = claudeRecordId(o);
      modelAnswered = false;
      continue;
    }
    const localAnswer = claudeLocalAnswer(o);
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
        outcome = previous?.outcome ?? null;
        modelAnswered = previous?.modelAnswered ?? false;
        command = null;
        previous = null;
      }
      continue;
    }
    if (withdrawn && claudeModelWorks(o)) {
      // Model work after the answer makes the command a turn again.
      outcome = withdrawn;
      withdrawn = null;
      command = null;
      previous = null;
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
    if (
      !outcome &&
      childTranscript &&
      type === 'assistant' &&
      (o.message as { stop_reason?: unknown } | undefined)?.stop_reason
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
    if ((o.message as { stop_reason?: unknown } | undefined)?.stop_reason) {
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

export function activityIn(lines: string[]): number | null {
  let newest: number | null = null;
  for (const line of lines) {
    if (line.indexOf('"timestamp"') < 0) {
      continue;
    }
    let o: { timestamp?: unknown };
    try {
      o = JSON.parse(line) as { timestamp?: unknown };
    } catch {
      continue;
    }
    if (o.timestamp === undefined || o.timestamp === null) {
      continue;
    }
    const t = Date.parse(String(o.timestamp));
    if (Number.isNaN(t)) {
      continue;
    }
    if (newest === null || t > newest) {
      newest = t;
    }
  }
  return newest;
}

// True when `target` is, or sits inside, one of `folders`. Shared with the Codex reader,
// which decides membership per file for the same reason and must decide it the same way.
export function isInside(target: string, folders: string[]): boolean {
  const t = normalizeFsPath(target);
  return folders.some((f) => {
    const base = normalizeFsPath(f).replace(/\/$/, '');
    return t === base || t.startsWith(base + '/');
  });
}

// Transcript directories belonging to the given workspace folders.
//
// The directory name is a *hint*, never the answer. The slug replaces every
// non-alphanumeric character with a dash, so `~/work/a_b` and `~/work/a-b` produce the
// same name, and a prefix match can lie in the same way (`~/a/b` prefixes `~/a/b-c`). A
// name that matches, exactly or as a prefix, only earns the cost of reading the cwd the
// session actually recorded; that cwd decides. Getting this wrong would show one
// project's prompts and summaries in another project's window.
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
    // With a cwd to read, it decides, whatever the name suggested. With none to read the
    // directory holds nothing to show anyway, and an exact name match is kept only so the
    // panel can say it found the directory and it was empty.
    if (cwd ? isInside(cwd, folders) : exact) {
      out.push(full);
    }
  }
  return out;
}

// Every session belonging to these workspace folders, newest first.
//
// One directory can hold sessions from two different folders, because the slug collapses
// every non-alphanumeric character to a dash. So the cwd decides per *file*, not per
// directory: sampling one transcript accepts the whole directory when the sample matches
// and rejects it when the sample does not, and both answers are wrong for every session
// the sample does not speak for. One shows another project's work in this window; the
// other hides this project's own.
//
// `cwdOf` is injected because a session's cwd never moves once written, so the panel can
// read it once per file instead of once per poll. Directories are re-listed every call:
// caching that answer freezes a directory out of the panel when a session appears inside
// one that was empty when it was first scanned.
// A path relative to the workspace folder holding it, with the folder's own name in front when
// there is more than one open, and with forward slashes throughout. Forward slashes because
// the result goes into a message or a config file, which want them on either platform.
//
// The comparison goes through `normalizeFsPath` like every other path rule here, because the
// two readers record a path in different shapes and the folder comes from a third place again.
// But the *result* is cut out of the original string rather than out of the normalized one:
// normalizing lower-cases the whole path on Windows, and a relative path pasted into a message
// or a terminal has to be the case the disk actually holds or it names nothing.
//
// A path outside every folder has no relative form, so the absolute one is returned. That is
// what the explorer does too, and it is the honest answer: a scratch file under the temp
// directory is not "../../../AppData/Local/Temp/...", it is where it is.
export function relativePath(target: string, folders: string[]): string {
  const t = normalizeFsPath(target);
  // Longest first, so a folder nested inside another names the file by the nearer of the two.
  const sorted = [...folders].sort((a, b) => normalizeFsPath(b).length - normalizeFsPath(a).length);
  for (const folder of sorted) {
    const base = normalizeFsPath(folder).replace(/\/$/, '');
    // The same test `isInside` makes, including the equal case: a path that is the folder is
    // in it. Two slightly different definitions of inside a folder, in one file, is the shape
    // that goes wrong later even where it cannot go wrong now.
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

// The file a summary link names, with any line anchor stripped, or null when the link is
// not a file at all. The two anchor shapes are the ones links actually carry: `#L42` or
// `#L42-L51` from an @-mention, and a trailing `:42` or `:42:7` the way a compiler writes
// a location. A scheme with `//` after it is a URL, which is a link with no file to copy;
// a Windows drive letter is a colon without the slashes and stays a file.
export function linkTarget(href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    return null;
  }
  const anchor = /#L(\d+)(?:-L?(\d+))?$/.exec(href) || /:(\d+)(?::\d+)?$/.exec(href);
  return (anchor ? href.slice(0, anchor.index) : href) || null;
}

export function linkTargetIsHtml(target: string): boolean {
  return /\.html?$/i.test(target);
}

export function linkTargetIsMarkdown(target: string): boolean {
  return /\.(?:md|markdown)$/i.test(target);
}

// Where a link's file is on disk: an absolute target is itself, and a relative one joins
// the folder that actually holds it. When none does, the first folder's join is returned
// anyway, because that is where opening the link would have looked, and a copied path that
// says where the file was expected beats copying nothing with no explanation.
export function resolveLink(target: string, folders: string[], exists: (p: string) => boolean): string | null {
  if (!target) {
    return null;
  }
  if (path.isAbsolute(target)) {
    return target;
  }
  const joined = folders.map((f) => path.join(f, target));
  return joined.find(exists) ?? joined[0] ?? null;
}

export function sessionFilesFor(
  root: string,
  folders: string[],
  cwdOf: (file: string, session: SessionFile) => string | null = readSessionCwd,
  missingCwdFolders: string[] = folders,
): SessionFile[] {
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
  const missingCwdSlugs = missingCwdFolders.map((f) => projectSlug(f).toLowerCase());
  const out: SessionFile[] = [];
  for (const d of dirs) {
    const name = d.toLowerCase();
    if (!slugs.some((slug) => projectDirectoryMatches(name, slug))) {
      continue;
    }
    for (const f of listSessionFiles(path.join(root, d))) {
      const cwd = cwdOf(f.file, f);
      // With a cwd to read, it decides. With none the file says nothing about where it
      // ran, and only a directory whose name matches exactly is trusted to hold it.
      if (cwd ? isInside(cwd, folders) : missingCwdSlugs.includes(name)) {
        out.push(cwd ? { ...f, cwd } : f);
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Session transcripts in a project directory, newest first.
export function listSessionFiles(dir: string): SessionFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) {
        continue;
      }
      out.push({
        agent: 'claude',
        file,
        sessionId: name.slice(0, -'.jsonl'.length),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ...(stat.ino > 0 ? { ino: stat.ino } : {}),
      });
    } catch {
      /* vanished mid-scan */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Reads the parent-owned identity edge without retaining the parent's turns. The result is
// independent of the bounded selected-session cache, so old launches remain available after
// that cache is evicted or after the extension host restarts.
export function readClaudeChildSessionReferences(
  parent: Pick<SessionFile, 'file' | 'sessionId' | 'childTranscript'>,
): ClaudeChildSessionReference[] {
  return scanClaudeChildSessionReferences(parent).references;
}

// A subagent's own transcript records an `Agent` result as text alone, with no
// `toolUseResult`, so the text is the only sign that a nested launch returned. A background
// launch returns at once with text that opens "Async agent launched" and names the child on its
// `agentId:` line. It closes through its completion notice. A foreground launch returns when
// the nested agent stops. Its text then usually ends with an `agentId:` line and a `<usage>`
// block of the figures the main transcript records in `toolUseResult`. The id counts only
// with the `<usage>` block after it, because the report above can end on an `agentId:` line
// of its own. The reader and the child reference scan both read the text here, so they pair
// a launch with the same child.
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

export function scanClaudeChildSessionReferences(
  parent: Pick<SessionFile, 'file' | 'sessionId' | 'childTranscript'>,
): ClaudeChildReferenceScan {
  const launches = new Set<string>();
  const children = new Map<string, Set<string>>();
  const shellLaunches = new Map<string, ClaudeShellLaunch>();
  const dispatches = new Map<string, ClaudeDispatchSessionReference[]>();
  // References take the room `MAX_CLAUDE_CHILD_REFERENCES_PER_FILE` gives in the order the file
  // first names them, subagents and dispatches alike. A parent that grows only appends, so it
  // keeps every child it already linked, and the derived session cache keeps the parent.
  let linked = 0;
  const complete = scanLines(parent.file, (line) => {
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
          const kind = claudeLaunchKind(block.input.command);
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
      } else if (linked < MAX_CLAUDE_CHILD_REFERENCES_PER_FILE) {
        linked++;
        children.set(sessionId, new Set([toolUseId]));
      }
    }
    const shellLaunch = shellLaunches.get(resultToolUseId);
    if (!shellLaunch || dispatches.has(resultToolUseId)) {
      return;
    }
    const launchKind = shellLaunch.kind;
    const stdout = (record.toolUseResult as { stdout?: unknown } | undefined)?.stdout;
    const output =
      launchKind === 'receipt'
        ? typeof stdout === 'string' && stdout.length > 0
          ? stdout
          : null
        : shellResultText(record);
    const launched =
      output === null
        ? []
        : launchKind === 'receipt'
          ? claudeDispatchReceipts(output, shellLaunch.count)
          : [claudeDispatchFromOutput(output)].filter((dispatch) => dispatch !== null);
    const kept = launched.slice(0, MAX_CLAUDE_CHILD_REFERENCES_PER_FILE - linked);
    if (kept.length) {
      linked += kept.length;
      dispatches.set(
        resultToolUseId,
        kept.map((dispatch) => ({
          kind: 'dispatch',
          parentSessionId: parent.sessionId,
          sessionId: dispatch.sessionId,
          file: null,
          toolUseIds: [resultToolUseId],
          name: dispatch.name,
          owned: dispatch.owned,
        })),
      );
    }
  });
  const references: ClaudeChildSessionReference[] = [...children].map(([sessionId, toolUseIds]) => ({
    kind: 'subagent' as const,
    parentSessionId: parent.sessionId,
    sessionId,
    file: parent.childTranscript
      ? path.join(path.dirname(parent.file), `agent-${sessionId}.jsonl`)
      : path.join(path.dirname(parent.file), parent.sessionId, 'subagents', `agent-${sessionId}.jsonl`),
    toolUseIds: [...toolUseIds],
  }));
  references.push(...[...dispatches.values()].flat());
  return { complete, references };
}

function launchesClaudeSession(command: string): boolean {
  return claudeLaunchKind(command) !== null;
}

// The Claude launches in one Bash command, all of one kind, and how many there are.
interface ClaudeShellLaunch {
  kind: 'native' | 'receipt';
  count: number;
}

// A command that resumes a session anywhere in it launches nothing, because its output can
// name the resumed session and the reader cannot tell whose line that is. Opted-in launches
// read together, because each receipt names its own session. An opted-in launch beside a
// direct one launches nothing, because the direct launch prints no receipt.
export function claudeLaunchKind(command: string): ClaudeShellLaunch | null {
  let launch: ClaudeShellLaunch['kind'] | null = null;
  let count = 0;
  let mixed = false;
  for (const segment of commandSegments(command)) {
    for (const offset of commandStartOffsets(segment.masked)) {
      const kind = claudeCommandKind(commandWords(segment.text, offset, segment.masked));
      if (kind === 'resume') {
        return null;
      }
      if (!kind) {
        continue;
      }
      mixed ||= launch !== null && launch !== kind;
      launch = kind;
      count++;
    }
  }
  return mixed || !launch ? null : { kind: launch, count };
}

function commandStartOffsets(masked: string): number[] {
  const offsets = [0];
  for (const match of masked.matchAll(/[({|&]/g)) {
    offsets.push((match.index ?? 0) + 1);
  }
  return offsets;
}

// Read shell words from one command boundary. Quoted executable paths keep their contents,
// while quoted output elsewhere remains behind a non-launching command word such as `grep`.
// The words end wherever `masked` hides text outside a quoted word. That text is a heredoc
// body or a PowerShell here-string, which is input to the command and never its arguments.
// Words after a heredoc opener on its own line are still arguments, so the opener itself does
// not end them. A backslash escapes a double quote inside double quotes, as `maskQuoted`
// reads it, so the two scans stay in step. A quote that `masked` hides sits inside another
// quoted string, as in a quoted command substitution, and closes nothing.
function commandWords(command: string, offset: number, masked: string): string[] {
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
    if (/[(){}|&]/.test(c)) {
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

function claudeCommandKind(words: readonly string[]): 'native' | 'receipt' | 'resume' | null {
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
  sessionId: string;
  name: string | null;
  owned: boolean;
}

// The receipt lines an opted-in wrapper prints, one for each session it started, so one
// command that chains two launches links both. `owned` is optional and can only be `true`: the
// wrapper writes it when the reader asked for the session, and any other value rejects the
// receipt, the way an unknown key does. One rejected line rejects every receipt in the result.
// So do two receipts that name one session, and more receipts than the command has opted-in
// launches, because output relayed from another command can quote that command's receipts. A
// short id is a prefix of the full one, so two ids that share their first eight characters
// count as one session. A result with more than `MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT`
// receipts links nothing, whatever the launch count, so one command cannot fill the references
// a parent file keeps.
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
      fields.agent !== 'claude' ||
      typeof fields.session_id !== 'string' ||
      !/^(?:[0-9a-f]{8}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(fields.session_id) ||
      (fields.name !== undefined && typeof fields.name !== 'string') ||
      (fields.owned !== undefined && fields.owned !== true)
    ) {
      return [];
    }
    const session = fields.session_id.slice(0, 8).toLowerCase();
    if (named.has(session)) {
      return [];
    }
    named.add(session);
    receipts.push({
      sessionId: fields.session_id,
      name: typeof fields.name === 'string' ? fields.name.trim() || null : null,
      owned: fields.owned === true,
    });
  }
  return receipts;
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
    return { sessionId: background[1], name: background[2].trim() || null, owned: false };
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
      return { sessionId: result.session_id, name: null, owned: false };
    }
  }
  return null;
}

export function resolveClaudeDispatchReferences(
  references: readonly ClaudeChildSessionReference[],
  catalog: readonly SessionFile[],
): ClaudeChildSessionReference[] {
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
    const match = byPrefix.get(reference.sessionId.toLowerCase());
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

interface CachedClaudeChildSession {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  cwd: string | null;
}

export class ClaudeChildSessionCache implements ClaudeChildSessionResolver {
  private entries = new Map<string, CachedClaudeChildSession>();

  constructor(private readonly cwdOf: (file: string) => string | null = readSessionCwd) {}

  read(reference: ClaudeSubagentSessionReference, repositoryRoots: readonly string[]): ClaudeChildSessionFile | null {
    const key = normalizeFsPath(reference.file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(reference.file);
      if (!stat.isFile() || stat.size === 0) {
        this.entries.delete(key);
        return null;
      }
    } catch {
      this.entries.delete(key);
      return null;
    }
    const held = this.entries.get(key);
    const cwd =
      held && held.size === stat.size && held.mtimeMs === stat.mtimeMs && held.dev === stat.dev && held.ino === stat.ino
        ? held.cwd
        : this.cwdOf(reference.file);
    this.entries.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino, cwd });
    if (!cwd || !isInside(cwd, [...repositoryRoots])) {
      return null;
    }
    return {
      agent: 'claude',
      file: reference.file,
      sessionId: reference.sessionId,
      parentSessionId: reference.parentSessionId,
      toolUseIds: [...reference.toolUseIds],
      mtimeMs: stat.mtimeMs,
      size: stat.size,
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

// Locations an agent writes to for itself: scratch scripts, memory, internal state. The
// snapshot hook skips them (plugins/arc-hooks/scripts/lib.js `ignoreRoots`) and the timeline hides them for
// the same reason, so both views of a turn agree on which files are the user's. Keep the
// two lists in step.
//
// One root per agent the panel reads, because each hides its own state the same way and a
// turn that rewrote its own configuration is not a change the user asked to review.
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

// A path in a form two sources can be compared by. Transcripts write Windows paths with
// forward slashes and a lower-case drive letter; the snapshot store writes them with
// backslashes and whatever case the session's cwd had.
export function normalizeFsPath(target: string): string {
  const unified = target.replace(/\\/g, '/');
  const drive = /^([a-zA-Z]):\//.exec(unified);
  const cased = drive ? drive[1].toLowerCase() + unified.slice(1) : unified;
  return drive || process.platform === 'win32' ? cased.toLowerCase() : cased;
}

// A Windows absolute path in the one spelling Windows itself writes: upper-case drive
// letter, backslashes throughout. Anything else comes back untouched.
//
// The two readers record the same file in four spellings, so a path copied from one turn
// and the same path copied from the next were not the same string. Counting the
// `file_path` values that start with a drive letter across every transcript under the
// Claude projects directory on this machine: `c:\` 50657, `C:\` 11868, `D:/` 2162, `c:/`
// 1300, `D:\` 809, `C:/` 403, `d:\` 269, `d:/` 34. The lower-case drive letter is the
// common case and the backslash is the common separator, but neither is the whole corpus,
// and 510 of the 6752 distinct files are written more than one of those ways.
//
// The gate is the shape of the string, never `process.platform`. A drive letter followed
// by a separator is a Windows absolute path and is not an absolute path on any POSIX
// system, so both normalizers apply Windows case rules to that shape on every platform.
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

// The same read, saying as well whether it reached the start of the file.
//
// The size comes from the open descriptor rather than from a stat of the path, so the size
// and the bytes are one answer. Two calls could disagree: a file that crossed the window
// between them would be read as a window and reported as a whole file, which is a count
// drawn as a total when it is a floor. That is the one direction this reader must not be
// wrong in, and it also saves a syscall on every read.
export interface FileRevision {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export interface BackwardLineCursor {
  revision: FileRevision;
  // The exclusive older edge of the bytes already inspected.
  end: number;
  // The beginning fragment dropped by the tail read. It becomes a complete JSONL record
  // when an older chunk supplies the rest of its line.
  fragment: Buffer;
}

export interface BackwardLine {
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
  lines: string[];
  whole: boolean;
  readBytes: number;
  // The byte offset in the file where the first of `lines` begins.
  offset?: number;
  cursor?: BackwardLineCursor;
}

function revisionOf(stat: fs.Stats): FileRevision {
  return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
}

function sameFileRevision(stat: fs.Stats, revision: FileRevision): boolean {
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
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    const body = buf.subarray(0, read);
    const lines = body.toString('utf8').split('\n');
    if (start > 0) {
      lines.shift();
    }
    const firstNewline = body.indexOf(0x0a);
    const fragment = firstNewline < 0 ? body : body.subarray(0, firstNewline);
    return {
      lines,
      whole: start === 0,
      readBytes: body.length,
      offset: start === 0 ? 0 : start + (firstNewline < 0 ? body.length : firstNewline + 1),
      ...(keepCursor && start > 0
        ? {
            cursor: {
              revision: revisionOf(stat),
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
    if (!sameFileRevision(fs.fstatSync(fd), revision)) {
      return null;
    }
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const next = fs.readSync(fd, buffer, read, length - read, start + read);
      if (next <= 0) {
        return null;
      }
      read += next;
    }
    if (!sameFileRevision(fs.fstatSync(fd), revision)) {
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
): BackwardLineBatch | null {
  const length = Math.min(Math.max(1, bytes), cursor.end);
  const start = cursor.end - length;
  const chunk = readRange(file, start, length, cursor.revision);
  if (!chunk || chunk.length !== length) {
    return null;
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

// Context the harness wraps around a prompt: IDE state, injected reminders, and the name it
// repeats back around a command. None of it is what the user typed.
//
// `command-name` and `command-args` are deliberately not in this list. They hold the command
// the reader invoked and what they typed after it, which is the whole prompt in a
// session opened with one. Deleting them left such a session with no typed prompt
// at all, so `holdsHumanPrompt` answered false and the rail never listed it. The generic tag
// strip in `cleanPrompt` takes their tags off and keeps what is between them.
const WRAPPED =
  /<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder|local-command-stdout|local-command-caveat|command-message|command-contents|task-notification)>[\s\S]*?<\/\1>/g;

// The harness's own commands, which act on the session rather than ask for work. The name
// and its argument are a setting, not something the reader typed to be read back, so a
// session holding nothing else is not one anybody had.
//
// Measured over the 113 most recently written transcripts on this machine, six of these
// names cover every such prompt: `/compact` 213, `/model` 47, `/context` 15, `/clear` 4,
// `/config` 2, `/plugin` 2. Every other name in that corpus is a skill the reader invoked,
// and its arguments are the request. `/effort` changes the session's effort level rather
// than asking for work, so it belongs beside them on the same reasoning.
//
// Whether a command carries arguments does not separate the two, which is the rule to reach
// for first. `/model` carries one on 45 of its 47 prompts, so that rule is the one to refuse.
//
// A name this code has never seen counts as work. A command added to the harness later
// reads oddly as a prompt until this list names it too. That is the direction this list
// gets wrong. The other direction leaves a reader's own session off the rail, with nothing
// anywhere saying it existed.
const HARNESS_COMMANDS = new Set(['/clear', '/compact', '/config', '/context', '/effort', '/model', '/plugin']);

const COMMAND_NAMED = /<command-name>\s*(\/[^\s<]*)/;
const COMMAND_SCAFFOLD = /<(command-name|command-args)>[\s\S]*?<\/\1>/g;

// A command and its arguments, rejoined the way the reader typed them: one line, one space
// between the two. The transcript writes them as separate tags on separate lines, and the
// composer holds the single line that was sent. The panel drops its own copy of a mid-turn
// prompt only when the two compare equal, so a newline here drew the reader's prompt twice
// on the card until the turn stopped. Newlines inside the arguments are the reader's own and
// are kept.
const COMMAND_INVOCATION = /<command-name>\s*([^<]*?)\s*<\/command-name>\s*<command-args>([\s\S]*?)<\/command-args>/g;

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

// What the user typed, with the harness's wrappers removed. Line structure is kept: a
// prompt is often a list, and folding it into one run-on line is most of why the panel
// keeps its line structure rather than folding into one run-on line. Runs of blank lines
// collapse to one.
export function cleanPrompt(raw: string): string {
  const named = COMMAND_NAMED.exec(raw);
  const body = named && HARNESS_COMMANDS.has(named[1]) ? raw.replace(COMMAND_SCAFFOLD, ' ') : raw;
  return body
    .replace(WRAPPED, ' ')
    .replace(COMMAND_INVOCATION, (_all, name: string, args: string) => `${name} ${args}`)
    .replace(/<\/?[a-z][a-z0-9-]{0,38}>/gi, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A queued command the reader typed, told apart from the two other things written on the
// same kind of line: a message from another session, and a background task reporting back.
// Measured over the 25 most recent transcripts of this workspace, 172 of these records: a
// `commandMode` of `prompt` with an origin that is not a peer picks out the reader's own,
// and the shape of the prompt agrees with it on every one. An absent origin counts as the
// reader, which is how a `user` line is read here too.
export function isReaderQueued(attachment: Record<string, unknown> | null | undefined): boolean {
  if (!attachment || attachment.type !== 'queued_command') {
    return false;
  }
  if (attachment.commandMode !== 'prompt') {
    return false;
  }
  const origin = attachment.origin;
  // An absent origin is the reader, which is what the records written before the field
  // existed carry. Anything present that is not a plain object with a name on it is not a
  // record this understands, and guessing at it would put another session's message under
  // the reader's own heading.
  if (origin === undefined || origin === null) {
    return true;
  }
  if (typeof origin !== 'object' || Array.isArray(origin)) {
    return false;
  }
  const kind = (origin as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind !== 'peer';
}

// A background agent's completion notice, in either of the two shapes Claude Code records,
// returned as the raw text that carries its tags. A notice written while the main agent
// works lands as a queued attachment with no origin at all, and its text sits in
// `attachment.prompt`. A notice written while the main agent waits lands as a `user` record
// with a `task-notification` origin, and its text sits in `message.content`. Every reader
// that acts on a completion calls this one rule. Two copies of the test are how the second
// shape stayed unread, and 42 percent of the completions in this project came in it.
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

// The text of a notice, whatever shape its content block takes. The caller reads tags out of
// it with a regular expression, so a block the reader has no name for still has to reach it
// whole. `textOf` keeps text blocks alone, and a notice recorded in any other block shape
// would otherwise arrive as `[object Object]` with the child id lost.
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

// A prompt-derived title's Markdown syntax, reduced to the text a reader would see.
//
// Titles stay plain text in every display path, so a prompt opening with a link shows its
// syntax verbatim, target and all: a quoted skill link such as `[$name]\(path)` put the
// whole address into the picker and the headings. Conservative on purpose. Only syntax
// whose visible text is beyond doubt is converted, and anything unbalanced, malformed or
// intraword (`foo_bar`, `a*b`, a lone backtick) is left exactly as typed: a title that
// keeps stray syntax is readable, and one that lost real characters is not.
//
// The private stripMarkdown below is not this rule. It removes a stray backtick outright,
// misses the escaped `\(` the wrapper writes, and leaves an image's `!` in front of its
// text; headlines read that way, titles do not.

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

// Repeat the pass above until nothing changes, so a run nested inside another one of the
// same marker character comes off from the inside out, same as marked reads it. Real text
// nests emphasis at most a few levels deep, so this is a handful of linear passes, not a
// pass per character.
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

// Split a line on balanced backtick pairs, run `transform` on the text outside a code
// span, and put a code span back exactly as written. A code span's text is shown as it
// stands: `*x*` inside one renders literally, and a transform run over it would eat
// characters the reader can see. Shared by `plainTitle` and `stripMarkdown`, which differ
// only in what they do to the text outside a code span.
function withCodeSpansPreserved(line: string, transform: (piece: string) => string): string {
  return line
    .split(/(`[^`\n]+`)/g)
    .map((piece, i) => (i % 2 ? piece.slice(1, -1) : transform(piece)))
    .join('');
}

export function plainTitle(line: string): string {
  return withCodeSpansPreserved(line, plainTitlePiece);
}

// A session name is plain text on every surface. Reduce Markdown whose visible text is
// unambiguous, remove host-only rich content, flatten whitespace, and apply the title limit
// once so the rail card's own actions, the timeline heading, search results and saved
// comments receive one value. The rail card's drawn name is a wider, separate cut of the
// unbounded source below, built where the host assembles the rail's name.
export function normalizeSessionTitle(text: string | null | undefined): string | null {
  const full = normalizeFullSessionTitle(text);
  return full ? shortenTo(full, 60, '...') : null;
}

// Compact surfaces use the shortened value above. The rename editor and the Details dialog
// read this unbounded source directly, so callers must not try to reconstruct it from the
// display title. The rail card reads its own bounded copy, built where the host assembles
// the rail's name, not here: bounding it in this shared function would also cut what the
// rename editor and Details show.
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

// A fence around a block of code. The line carrying it is punctuation, not content: stripped
// of its backticks it reads as the bare language tag, for example "markdown", which is not
// what the turn said. Skip the fence line itself; the lines it encloses are read as before.
const FENCE = /^\s*(```|~~~)/;

// Bullet, heading, and ordered-item markers, taken off the true start of the raw line. They
// run once here rather than per code-span piece: a plain-text piece that happens to follow a
// code span, such as the " - rest" in `` `code` - rest ``, is not a bullet just because it
// starts with a dash once split out on its own.
function stripStructuralMarkdown(line: string): string {
  return line
    .replace(BULLET, '') // bullet
    .replace(/^#{1,6}\s*/, '') // heading
    .replace(/^\s*\d+\.\s+/, ''); // ordered item
}

// Link text, emphasis marks by the GFM rule `stripEmphasisMarkers` applies, and a stray
// backtick that never paired into a code span. The structural markers above are already
// gone by the time this runs.
function stripInlineMarkdown(line: string): string {
  const withLinkText = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // link text
  return withCodeSpansPreserved(withLinkText, (piece) => stripEmphasisMarkers(piece).replace(/`/g, '')).trim();
}

function stripMarkdown(line: string): string {
  return stripInlineMarkdown(stripStructuralMarkdown(line));
}

// The raw line `headlineOf` and `headlineMarkdownOf` agree on, with its structural markers
// gone and its inline markup untouched, or null where no line in the summary carries
// content. One finder for both, so they always pick the same line: a fence or a section
// heading is skipped the same way whether the caller wants the line plain or with its
// markup kept.
function headlineLine(summary: string): string | null {
  for (const raw of summary.split('\n')) {
    if (FENCE.test(raw)) {
      continue;
    }
    const structural = stripStructuralMarkdown(raw);
    const plain = stripInlineMarkdown(structural);
    if (!plain || SECTION_ONLY.test(plain)) {
      continue;
    }
    return structural;
  }
  return null;
}

// The one line that says what the turn did: the first line of the summary that carries
// content rather than naming a section.
export function headlineOf(summary: string): string {
  const line = headlineLine(summary);
  return line === null ? '' : stripInlineMarkdown(line);
}

// The same line as `headlineOf`, with its inline Markdown kept: a code span's backticks, an
// emphasis run's stars or underscores, and a link's target. The folded card's headline draws
// this, since the open card already renders the response as Markdown and the folded line
// should read the same way.
export function headlineMarkdownOf(summary: string): string {
  const line = headlineLine(summary);
  return line === null ? '' : line.trim();
}

// The lines of the list a summary opens with, one line each for what the turn did, with
// their markdown taken off.
//
// It stops at the end of that first list, and the reason is the reason it is worth having.
// A summary closes with a list too, and those rows are written whether or not they hold
// anything: every summary carries a row for what the reader has to do and a row for open
// questions. Reading the whole summary would find those on every turn and say the same
// thing about all of them.
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
    // A wrapped or nested line carries no symbol of its own, and ending the list on it
    // would drop every item under it while leaving the ones above, which reads on a card as
    // a turn that said less than it did.
    if (lines.length && CONTINUATION.test(raw)) {
      continue;
    }
    break;
  }
  return lines;
}

// The rows a summary closes with, as the text each one carries, or null for a row that is
// not written. `openingLines` reads the list a summary opens with and stops before these on
// purpose; this reads only these, and the two never overlap.
//
// The rows are the reader's half of the summary: what only they can do, and what is waiting
// on an answer from them. A row is omitted when it has nothing to say, so the text being
// there is most of the signal. Every turn recorded before that rule wrote both rows
// regardless, filling an empty one with "none", which is why what counts as empty is
// decided on the card rather than here.
//
// The newer format writes one "Waiting on you" section instead of the two rows, and it
// arrives here as `actions` with no questions beside it, so everything reading these rows
// keeps working unchanged. `WAITING_LABEL` below says what that section is.
export interface ClosingRows {
  actions: string | null;
  questions: string | null;
}

// A row is taken only where one can begin: at the start of a line, behind nothing but the
// symbol it opens with, and split from its text by a colon or by a dash with a space on
// each side. A summary that discusses the format in its own prose names these rows in
// passing, mid sentence and behind a comma, and that is what the guards keep out.
//
// The spaces around the dash are not decoration, and they are why the dash needs one on
// each side. The questions row is written "Open questions / follow-ups", so a separator
// that may sit against a letter finds the hyphen inside "follow-ups" first, and the row on
// every turn then reads as beginning with the word "ups". Either space alone keeps that
// out, which is why the test that proves it takes both away.
const CLOSING_ROW_NAME = {
  actions: /^[^\p{L}]*your actions\b/iu,
  questions: /^[^\p{L}]*open questions\b/iu,
};

// The text of a row written as one line, taken from whatever follows its name.
const ROW_TEXT = /^[^:\n]{0,30}?(?::|\s[–—-])\s+(.+)$/u;

// How much may sit between the name and nothing at all before the line stops reading as a
// row's heading. "Open questions / follow-ups" is the only qualifier in use, and a line
// carrying more than that is a sentence the row's name happens to start.
const ROW_QUALIFIER = 20;

// The label the newer summary format closes with. That format carries no symbols and no
// named rows: everything the reader has to do or still has to decide, open questions
// included, is folded into one "Waiting on you" section, whose label sits on a line of its
// own above a flat list. Both shapes are on disk, so both are read, and the section maps
// onto the actions row, which is the half the card's waiting signal fires on.
//
// It is matched against the line as written rather than against its stripped text, because
// the bold is the only thing telling the label apart from the same four words in a
// sentence, and stripping the markdown first takes it away. The colon is written on either
// side of the bold by hand, so it is allowed in both places and belongs to neither.
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
      // A label with no list under it is not a section: the format never writes one, and
      // reading it as an empty section would wipe out a real row found earlier. What is
      // found obeys the same last-wins rule as the named rows, across both shapes, since a
      // summary holding one of each is quoting the shape it is not using. The section holds
      // what the questions row used to, so it takes that row with it rather than leaving an
      // older one standing beside it.
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
      // The last row with something in it wins. The rows close the summary, so an earlier
      // one that got this far is prose about them rather than the row itself. A later line
      // that starts with the name and holds nothing does not overwrite a real row with
      // nothing: a sentence beginning "Your actions are done" is not the row going empty.
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

// Whether a line is one of the named rows itself, which is where the list under the row
// above it ends.
//
// A row, not a line that begins with a row's name: "Your actions here decide the release
// date" is an ordinary item of the list it sits in, and both names are ordinary English for
// the very thing these rows hold. Reading one as a row ends the list on it and throws away
// that item and everything under it, which is the feature failing in the direction nobody
// would notice: a turn that really is waiting shows no badge and drops out of the filter.
// So a row has to look like one, by the same two shapes `rowTextAt` accepts.
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

// The list under a row written as a heading with nothing on its own line. Two shapes of
// summary are on disk: the row and its text on one line, and the older one where the name
// is a heading of its own and what it holds is the bullets below it. Both are real rows,
// and reading only the first shape leaves every older turn looking as though it asked for
// nothing.
function listUnder(lines: string[], from: number): string | null {
  const parts: string[] = [];
  for (let i = from + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    // One blank line may sit between the heading and its list. A second means the list is
    // over, and so does anything that is not an item of it.
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
    // The rows are bullets themselves, so the next row looks exactly like another item of
    // this one. Without this a heading row swallows every row below it, and an empty one
    // takes the next row's text and claims the reader is needed.
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

// The list under a "Waiting on you" label, one item to a line, or null where the label
// stands alone. Blank lines sit anywhere inside the section, and anything that is not an
// item of it ends it. A named row of the older shape ends it too: that row is a bullet like
// any item, so a section written above one would otherwise swallow it, and the row it holds
// is the later of the two and the one the turn meant.
//
// `end` is the last line the section took, so the caller can carry on past it and no item is
// read a second time as a row of its own. Items are ordinary sentences, and both of the
// older row names are ordinary English for the very thing an item says.
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
    // The same item shapes the older heading reader takes: a numbered item is an item,
    // and a line set in under one is the rest of it rather than one of its own. The
    // convention writes each item flat on one line, but an item that wrapped anyway
    // still belongs to the section, and ending it there would silently drop every item
    // after the wrap.
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

// A row wrapped over several lines is one row. Its later lines are set in under the first,
// which is what tells them apart from the row below, and they carry the rest of the text:
// stopping at the first line would drop questions three and four of four.
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

// A compaction summary opens with a fixed note to the next agent saying the session ran
// out of context. The panel says that already in its own heading, so the summary starts
// where the content does.
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
  const text = cleanPrompt(textOf(content));
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

// What a shell call ran, and where it was standing when it started. The transcript keeps
// no working directory on the tool call itself; the record carrying the call has a
// top-level `cwd`, and that one is the directory *before* the command ran, which is what a
// relative `cd` inside it resolves against. The record carrying the result has the
// directory after, which is the wrong one.
export interface CommandCall {
  id?: string; // source tool call id, when the reader records one
  command: string;
  cwd: string | null;
  at: number; // epoch ms of the record that issued the call, which opens its window
}

// What a reader knows about the call whose output is being read for commits.
//
// A `CommandCall` is the command that ran, and it decides. `null` is a reader that records
// the command behind a result and recorded none for this one: nothing says git ran, so
// nothing is read. `'unreadable'` is a source that cannot pair a command with the output in
// front of it, and its output is read the way every result was read before the rule. One Codex
// outer call runs a JavaScript program that can complete several commands, so that output has
// no safe command pairing. A completed Codex command carries its own command, directory,
// result, output, and execution window, so it supplies a readable `CommandCall` instead.
export type CommitCall = CommandCall | null | 'unreadable';

// Stands in for quoted text and heredoc bodies while a command is being read. It is not
// whitespace and not an operator, so a `;` inside a commit message and the words
// `git commit` inside a heredoc both disappear before anything is split or matched.
const FILL = '\u0001';

// A copy of the command with quoted interiors and heredoc bodies replaced by the filler,
// the same length as the original, so an index into one is an index into the other and a
// path can be read back out of the text at the position the masked copy matched at.
//
// One pass reads the command as bash nests it, and reads each character once. `open` holds
// the quotes, command substitutions `$(`, arithmetic expansions `$((` and parentheses that
// enclose the current character. Everything inside a quoted string is masked, nested
// constructs included, and the quote that closes the outermost string is not, so
// `commandWords` finds where that argument ends. A command substitution is a script of its
// own even inside double quotes, so a quote, a heredoc or another substitution in it nests.
// A `<<` opener in a script queues its heredoc. The queued bodies follow the next newline of
// a script, in the order their openers came. Each body ends at a line that is exactly its
// delimiter, after leading tabs are removed for `<<-`, or at the end of the command.
// Arithmetic reads `<<` as a shift, and `<<<` passes a string, so neither opens a heredoc.
function maskQuoted(command: string): string {
  const out = command.split('');
  const open: string[] = [];
  let quotes = 0;
  let pending: { delim: string; tabs: boolean }[] = [];
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
    if (quotes > 0) {
      mask(at, to);
    }
    return to;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    const top = open[open.length - 1];
    if (top === "'" || top === '"') {
      if (c === top) {
        open.pop();
        quotes--;
        i = pass(i, i + 1);
      } else if (top === '"' && c === '\\') {
        mask(i, Math.min(i + 2, command.length));
        i += 2;
      } else if (top === '"' && command.startsWith('$(', i)) {
        const arithmetic = command[i + 2] === '(';
        open.push(arithmetic ? '$((' : '$(');
        i = pass(i, i + (arithmetic ? 3 : 2));
      } else {
        out[i] = FILL;
        i++;
      }
      continue;
    }
    if (c === '\\') {
      i = pass(i, Math.min(i + 2, command.length));
      continue;
    }
    if (c === '"' || c === "'") {
      i = pass(i, i + 1);
      open.push(c);
      quotes++;
      continue;
    }
    if (command.startsWith('$(', i)) {
      const arithmetic = command[i + 2] === '(';
      open.push(arithmetic ? '$((' : '$(');
      i = pass(i, i + (arithmetic ? 3 : 2));
      continue;
    }
    // A parenthesis inside arithmetic groups a sum, so everything inside it is arithmetic too.
    const arithmetic = top === '$((' || top === 'arith(';
    if (c === '(' && open.length > 0) {
      open.push(arithmetic ? 'arith(' : '(');
      i = pass(i, i + 1);
      continue;
    }
    if (c === ')' && open.length > 0) {
      const closes = top === '$((' && command[i + 1] === ')' ? 2 : 1;
      open.pop();
      i = pass(i, i + closes);
      continue;
    }
    if (arithmetic) {
      i = pass(i, i + 1);
      continue;
    }
    // PowerShell's here-strings, `@'` and `@"`. An opener counts only when nothing but
    // whitespace follows it up to the end of its line, and a terminator only when its quote
    // and `@` are the first two characters of a line, because PowerShell accepts them
    // nowhere else; the end-of-line test is what keeps an ordinary `user@'host'` argument
    // from opening one. The terminator is masked along with the body, since its quote would
    // otherwise open a quoted run of its own in the scan that carries on after it. Without
    // the mask an apostrophe in the body puts that scan out of step, and the `git add` and
    // `git commit` written after the here-string read as text inside a string rather than
    // as calls.
    if (c === '@' && open.length === 0 && (command[i + 1] === "'" || command[i + 1] === '"')) {
      if (eol < i) {
        const nl = command.indexOf('\n', i);
        eol = nl < 0 ? command.length : nl;
        ink = eol - 1;
        while (ink > i && /\s/.test(command[ink])) {
          ink--;
        }
      }
      if (eol < command.length && ink === i + 1) {
        // With no terminator anywhere the body runs to the end of the command, which is the
        // answer a heredoc gives for the same shape.
        const term = command[i + 1] + '@';
        let end = command.length;
        let k = eol;
        while (k >= 0) {
          if (command.startsWith(term, k + 1)) {
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
      const heredoc = heredocOpener(command, i);
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
      for (const { delim, tabs } of pending) {
        while (k < command.length) {
          const stop = command.indexOf('\n', k + 1);
          const end = stop < 0 ? command.length : stop;
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
    i = pass(i, i + 1);
  }
  return out.join('');
}

// The heredoc opener whose `<<` sits at `at`. `delim` is its delimiter word after quote
// removal, or null when no word follows. `after` is the index just past that word.
function heredocOpener(command: string, at: number): { delim: string | null; tabs: boolean; after: number } {
  let j = at + 2;
  const tabs = command[j] === '-';
  if (tabs) {
    j++;
  }
  while (command[j] === ' ' || command[j] === '\t') {
    j++;
  }
  const start = j;
  let delim = '';
  while (j < command.length && !/[\s;&|()<>]/.test(command[j])) {
    const c = command[j];
    if (c === '"' || c === "'") {
      const close = command.indexOf(c, j + 1);
      const stop = close < 0 ? command.length : close;
      delim += command.slice(j + 1, stop);
      j = Math.min(stop + 1, command.length);
    } else if (c === '\\' && j + 1 < command.length) {
      delim += command[j + 1];
      j += 2;
    } else {
      delim += c;
      j++;
    }
  }
  return { delim: j > start ? delim : null, tabs, after: j };
}

// The commands in one call, split on the `&&`, `||`, `;` and newlines that are real
// operators rather than characters inside a quoted string or a heredoc. Each command is
// carried in both spellings: the original, which the paths are read out of, and the
// masked copy, which everything is matched against.
function commandSegments(command: string): { text: string; masked: string }[] {
  const m = maskQuoted(command);
  const parts: { text: string; masked: string }[] = [];
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
    parts.push({ text: command.slice(start, i), masked: m.slice(start, i) });
    i += width - 1;
    start = i + 1;
  }
  parts.push({ text: command.slice(start), masked: m.slice(start) });
  return parts;
}

// Git Bash writes `/c/x`, WSL writes `/mnt/c/x` and Cygwin writes `/cygdrive/c/x`, and all
// three name a Windows drive. Left alone they read as absolute paths under the root, which
// is inside nothing and outside everything.
// A drive with nothing after it keeps its slash: `C:` on its own is not an absolute path,
// and a path built on it is joined onto wherever the call started instead.
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

// What a backslash outside quotes takes out of the shell's hands. It is how a space or a
// quote is written into a path that is not quoted, and it is nothing else: every other
// backslash is a character of the path itself, which is how Windows spells every path it
// writes. Dropping those turns `C:\Users\dev` into `C:Usersdev`, which is no longer
// absolute and is joined onto the current directory as though it were relative.
const ESCAPABLE = /[\s'"]/;

// One argument with its quotes taken off, read from the start of `rest`. The original text
// is what is read, not the masked copy, because the path itself is usually what was quoted.
function firstArg(rest: string): string | null {
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
        quote = '';
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
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      out += s[++i];
      continue;
    }
    out += c;
  }
  return out;
}

// The directory an argument names, or null when nothing here can say. A target built from
// a variable is the common unresolvable one: `cd "$REPO"` names a directory this reader
// has no way to expand, and guessing would be worse than saying nothing.
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

// The commands that move the shell, in both shells the panel reads. `cd`, `Set-Location`
// and `chdir` are one command under three names; `pushd` and `Push-Location` also change
// the directory, and the stack they push is not tracked, so `popd` is the shape below.
const CHANGE_DIR = /^(cd|chdir|set-location|pushd|push-location)(\s|$)/i;
// A move the reader cannot follow. Where the shell went is then unknown rather than
// unchanged, and an unknown directory attributes nothing, which is the safe answer.
const UNTRACKED_DIR = /^(popd|pop-location)(\s|$)/i;

// The parameter PowerShell names the destination with. `-Path` and `-LiteralPath` are the
// two spellings of it, and either may be joined to its value by a colon or an equals sign.
const DIR_PARAM = /^-(?:Path|LiteralPath)(?=[\s:=]|$)/i;

// A switch in front of the destination that this reader cannot read past, which is not the
// same answer as a command naming no destination at all.
const UNREADABLE = Symbol('unreadable switch');

// The destination a move names, read past any parameter written in front of it. PowerShell
// writes `Set-Location -Path <dir>` as readily as it writes the directory bare, and the
// PowerShell tool makes about one commit in nine in this data, so a reader that takes the
// first token whatever it is records `-Path` as the directory and joins it onto the current
// one. A switch this reader does not know could be hiding the destination behind it, so it
// answers `UNREADABLE` and the shell's directory stops being tracked rather than guessed.
function moveTarget(rest: string): string | null | typeof UNREADABLE {
  let s = rest.trim();
  // `-` on its own is the previous directory, which is a destination and not a switch.
  while (s.startsWith('-') && s !== '-' && !/^-\s/.test(s)) {
    const m = DIR_PARAM.exec(s);
    if (!m) {
      return UNREADABLE;
    }
    s = s.slice(m[0].length).replace(/^[:=]/, '').trim();
  }
  return firstArg(s);
}

// A `git commit`, with any `-C` git was given in front of it. `-C` names the directory for
// that one call and does not move the shell, and it is how eight of the nine foreign
// commits measured over the real transcripts were made, so a rule reading `cd` alone
// misses them. Matched against the masked copy, where a quoted argument is a run of filler
// and therefore still one token.
const COMMIT_CALL = /(^|[\s(])git((?:\s+-C\s+\S+)*)\s+commit(?=\s|$)/g;

// A `git merge`, read the same way. A merge makes no commit of its own when it fast-forwards,
// so `commitDirs` never sees it and the call records nothing without this.
const MERGE_CALL = /(^|[\s(])git((?:\s+-C\s+\S+)*)\s+merge(?=\s|$)/g;

/**
 * The directory each `git commit` in one call was made in, in the order the call makes
 * them, with null wherever the directory cannot be worked out.
 *
 * `cwd` is the directory the call started in, which is the `cwd` of the record carrying
 * the tool call. An empty answer means the call makes no commit this reader can see.
 */
export function commitDirs(command: string, cwd: string | null, home: string = os.homedir()): (string | null)[] {
  return gitCallDirs(command, cwd, home, COMMIT_CALL);
}

/**
 * The same answer for each `git merge` in one call. A fast-forward landing is attributed the
 * way a commit is: the command says which repository, and the repository says what landed.
 */
export function mergeDirs(command: string, cwd: string | null, home: string = os.homedir()): (string | null)[] {
  return gitCallDirs(command, cwd, home, MERGE_CALL);
}

function gitCallDirs(command: string, cwd: string | null, home: string, call: RegExp): (string | null)[] {
  const homeDir = normalizeDir(driveForm((home || '').replace(/\\/g, '/')));
  let cur = cwd ? normalizeDir(driveForm(cwd.replace(/\\/g, '/'))) : null;
  const out: (string | null)[] = [];
  for (const seg of commandSegments(command)) {
    const trimmed = seg.text.trim();
    const move = CHANGE_DIR.exec(trimmed);
    if (move) {
      const arg = moveTarget(trimmed.slice(move[1].length));
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
        dir = resolveDir(firstArg(opts.slice(at, at + a[1].length)) ?? '', dir, homeDir);
      }
      out.push(dir);
    }
  }
  return out;
}

// A segment that runs git: its command word is `git`, behind nothing but the environment
// assignments a shell allows in front of one. Matched against the masked copy of the
// segment, so the word `git` inside a quoted string, a commit message or a heredoc body is
// a run of filler by the time it reaches here and cannot qualify on its own.
//
// A command word begins at the start of the segment or behind one of the characters a
// shell opens a command with. `commandSegments` splits on the operators that separate
// commands, and a guarded commit keeps the whole
// `if ((git rev-parse --short HEAD) -eq "abc1234") { git commit -F msg.txt }` in one
// segment; three commits in one measured run of the real transcripts were made that way,
// and a rule reading only the head of a segment loses all of them.
const GIT_CALL = /(?:^|[({|&])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git(?:\s|$)/;

/**
 * Whether one call ran git as a command.
 *
 * It is not narrowed to `git commit`. A revert and a cherry-pick print the same line for a
 * commit they really made, measured against git itself, and so do a rebase and a pull; all
 * of them are the turn's own work. `git merge` prints no such line: the line for a merge
 * comes from the `git commit` that closes a conflicted one.
 *
 * The cost is a commit made by a script that calls git for itself, a release task or a
 * hook, which stops being drawn. That is the trade: git's line reaches a transcript as the
 * output of a call that ran git, and anything else printing that shape is quoting a commit
 * somebody else made.
 */
export function ranGit(command: string): boolean {
  return commandSegments(command).some((seg) => GIT_CALL.test(seg.masked));
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
 * Whether the call's exit status stands for the commit it made.
 *
 * This decides whether a call that printed nothing is read back from the repository at
 * all. `A && B` qualifies: a skipped B leaves the whole call non-zero, and a call that
 * failed is refused already. An or-else, a semicolon, a newline and a conditional block do
 * not. Each one exits zero with the commit never made, so the window around it holds only
 * what another session landed, and the card would draw that as this turn's work. A pipe is
 * allowed because the repository count and head log still identify the commit.
 *
 * An or-else disqualifies a command wherever it sits, not only after the commit. It skips
 * the commit when it comes before one, and it hides the failure when it comes after.
 *
 * The guarded shape
 * `[[ "$(git rev-parse --short HEAD)" == "abc1234" ]] && git commit -F msg.txt || echo aborting`
 * is what the reader's own instructions teach, so it is the shape most likely to arrive
 * rather than a corner case.
 */
export function commitStatusIsReadable(command: string): boolean {
  return gitStatusIsReadable(command, COMMIT_CALL);
}

/**
 * The same question for `git merge`. A fast-forward is read out of the head log inside the
 * call's window, so a call whose exit status does not stand for its merge would take whatever
 * another session landed in that window.
 */
export function mergeStatusIsReadable(command: string): boolean {
  return gitStatusIsReadable(command, MERGE_CALL);
}

function gitStatusIsReadable(command: string, call: RegExp): boolean {
  const masked = maskQuoted(command);
  if (CONDITIONAL.test(masked) || masked.includes('||')) {
    return false;
  }
  // These three read the command as written as well as the masked copy. Quoting an option
  // changes nothing about what git does with it, and masking would hide it. A commit message
  // holding the same words costs a commit that would have been drawn, and claims none.
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
  // From the first commit rather than the last. A separator between two commits hides the
  // first one's failure exactly as one after the last hides that one's, and a command making
  // two commits is read as making two whether or not the first happened. Reading from the
  // first costs nothing before it: a separator there sits ahead of every commit the command
  // makes, and the status still ends up being git's.
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
 * Where a call's commits landed, when that is somewhere other than this workspace, and
 * null in every other case.
 *
 * Pairing a directory with a single commit is not safe: the count of commit-making calls
 * in a command does not match the number of commit lines git printed, on 4% of calls
 * measured, and in both directions. A commit that finds nothing staged prints no line, and
 * one measured call printed four lines for six calls. So the whole call is answered or
 * none of it is.
 *
 * Every commit naming the same directory is the named answer. Directories that disagree
 * were once no answer at all, which lost six commits across three measured calls, each of
 * them committing to two different foreign repositories in one command. Where every one of
 * those directories is outside the workspace, the call is marked and no directory is given:
 * that cannot name the wrong repository, because it names none, and it cannot touch a
 * commit made here, because one directory inside the workspace stops the whole call.
 *
 * Marking a commit made in this workspace as foreign is the failure that must not happen,
 * because the reader would go looking for work that is on the card in front of them.
 * Missing a foreign one only leaves the row as it was.
 *
 */
export function commitPlaceOf(call: CommandCall | null, folders: string[], home: string = os.homedir()): CommitPlace {
  if (!call || folders.length === 0) {
    return null;
  }
  const agreed = commitDirOf(call, folders, home);
  if (agreed !== null) {
    return isInside(agreed, folders) ? null : { kind: 'named', dir: agreed };
  }
  // An agreed directory is not available when the call used more than one repository.
  // Re-read the individual directories only to preserve the existing safe `unnamed`
  // wording for a call whose every target is foreign.
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
// `git commit` prints "[<branch> <sha>] <subject>" on the first line it writes for the
// new commit. Reading it back is how a turn can say what it actually landed.
//
// What sits before the sha is not one token. A repository's first commit is
// "[main (root-commit) 049b47a]" and a commit made off a branch is
// "[detached HEAD cac66e9]", so a rule that allows a single token drops both: the first
// commit of every repository, ever, and every commit made during a bisect or a rebase.
//
// The two extra tokens are named rather than allowed for as "any number of tokens". This
// runs against the stdout of every tool call, not only `git commit`, so what it accepts is
// what it will read out of unrelated command output: a bracketed log line such as
// "[2026-08-26 10:23:45 deadbeef] service started" is three tokens and a hex-shaped word,
// and a rule counting tokens draws it on a card as a commit that never happened. Only the
// two things git actually writes are allowed, so nothing wider than git's own output gets in.
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

// `call` is what the tool ran and where it was standing. It says two things: whether git
// printed this output at all, and, once a commit line has been found in it, which
// repository the commits landed in.
//
// The first is the gate. This runs against the stdout of every tool call, so without it
// anything quoting git's line is drawn on a card as a commit the turn made: a session that
// surveyed other agents' transcripts printed one of their commit lines as sample output,
// and the card claimed that commit as its own work.
//
// `window` is what the reader knows about the call itself, and only a reader that can supply
// it gets an intent recorded. Without one, output that printed no commit line is read exactly
// as it was read before this rule.
export function recordCommits(
  turn: { commits: TurnCommit[]; commitIntents?: CommitIntent[]; landingIntents?: LandingIntent[] },
  stdout: string,
  at: number,
  call: CommitCall = null,
  folders: string[] = [],
  defaultDir: string | null = null,
  window: { from: number; failed: boolean } | null = null,
): void {
  if (call === null || (call !== 'unreadable' && !ranGit(call.command))) {
    return;
  }
  // A source whose command cannot be read supplies no place wording. It may still supply a
  // default directory for opening the commit, while its commits remain unmarked.
  const ran = call === 'unreadable' ? null : call;
  const lines = stdout.split('\n');
  let place: CommitPlace | undefined;
  let printed = false;
  const dir = call === 'unreadable' ? defaultDir : commitDirOf(ran, folders);
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
    if (turn.commits.some((c) => sameCommitSha(c.sha, sha))) {
      continue;
    }
    // The stat line is usually the next line, but git writes its own headers in between
    // whenever the author or the author date differs from the committer's, which is every
    // amend and every cherry-pick. Reading only the next line loses those commits' figures.
    // A commit that changed nothing prints no stat line at all, so the scan has to give up.
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

// What is left when the output held no commit line: the fact that the call committed, and
// the window it committed in.
//
// A call that failed records nothing. Its own commit did not happen, so a window that holds
// one holds somebody else's, and claiming it is the failure this whole path exists to avoid.
// A call whose shape hides that failure records nothing either, for the same reason.
//
// A call whose command named more than one repository records nothing either. There is no
// single directory to ask, and asking the wrong one answers about the wrong repository.
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

// The same record for a call that merged. A fast-forward prints no identity at all, so there
// is no printed answer to prefer and nothing to suppress the record.
//
// The refusals are the commit's refusals, and for the same reason. A call that failed made no
// landing, and a call whose shape hides that failure proves nothing about the one in its
// window. A command that named more than one repository has no single directory to ask.
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
  tailBytes?: number;
  maxTurns?: number;
  // Prepare a byte cursor when this tail begins inside the newest turn. Only the selected
  // session asks for one; background sessions keep their ordinary bounded read.
  prepareNewestTurnDiscovery?: boolean;
  sessionTitle?: string | null;
  // The open workspace folders. A commit made inside one of them is this workspace's own
  // work and carries no directory; with none given, nothing is outside anything and no
  // commit is marked.
  folders?: string[];
  // The child transcript behind an id the parent recorded. The panel supplies a cached
  // filesystem lookup; tests and callers that only need the parent can omit it.
  agentSpendOf?: AgentSpendLookup;
  // Resolves a paired launch and result to a child session after the provider adapter
  // verifies the child's transcript and recorded working directory.
  agentSessionTargetOf?: AgentSessionTargetLookup;
  childTranscript?: boolean;
  // Set by a caller that keeps only the turns. Its compactions then carry no first request cache
  // read, because finding it can read the head of a large transcript.
  turnsOnly?: boolean;
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
};

// Kept as JSON data so an incremental scanner can save it beside its byte offset and resume
// after the extension host restarts.
export interface ClaudeUsageReducerState {
  // Every request a parent read has billed, oldest first, and the newest of them in a child
  // read. This is the saved form, so it stays an array.
  seenRequestKeys: string[];
  // The same keys as a set, which answers membership without a scan. A parent transcript
  // holds thousands of requests and repeats each one, so a scan for every record turns a read
  // into a stall. Built from the saved queue on the first record after a restore, and left
  // out of the saved form.
  seenRequests?: Set<string>;
  closedTurns: number;
  openTurn: boolean;
  openTurnAnswered: boolean;
  // How many compaction summaries this transcript has held.
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
  // The newest main request, which sizes the next compaction's input.
  lastRequest?: ClaudeLastRequest | null;
  // The cache read of the first request this transcript billed, set once. A cold compaction
  // reads back that much, and null means no request has been read yet.
  firstRequestCacheRead?: number | null;
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
  // The id of the typed record that opened the current turn. A local command answer that names
  // it as its parent withdraws the turn. Absent in a state saved before the field existed.
  currentTurnCommand?: string | null;
  // The turn the current typed prompt followed, as it stood when that prompt arrived. A local
  // command answer withdraws the command's turn and puts this one back as the newest turn.
  // Null once anything answers the current turn, because no answer can withdraw it then.
  currentTurnPrevious?: ClaudePreviousTurn | null;
  // The command turn a local command answer withdrew, held until the next typed prompt. Model
  // work after the answer puts it back as the newest turn, as the full reader keeps the
  // command open for that work.
  currentTurnWithdrawn?: ClaudePreviousTurn | null;
  // The index behind currentTurnOutcome.closedChildren. It is rebuilt once after a restore
  // and omitted from snapshots, like seenRequests above.
  closedChildIndex?: Map<string, number>;
  // The last event for each of the newest request keys, kept so that a later line revising one
  // of them can remove what it replaces. Only a child read fills this. `RETAINED_REQUESTS`
  // bounds this map and the child read's queue alike, so every request that queue calls
  // counted keeps its event here.
  requestEvents?: Record<string, UsageEvent>;
  // The model id the newest `model` attachment names, such as `us.anthropic.claude-opus-5-5[1m]`.
  // Claude Code writes one at the start of a session and one at each `/model` switch. On Amazon
  // Bedrock the id carries the inference profile, which sets the request's price.
  modelProfile?: string | null;
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

function copyUnsizedCompaction(value: ClaudeUnsizedCompaction | null | undefined): ClaudeUnsizedCompaction | null {
  return value ? { ...value, previous: value.previous ? { ...value.previous } : null } : null;
}

// The length of a compaction summary's stored text, the continuation preamble included. The
// compaction estimate's characters per output token were measured on this count.
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

export function retainNewestCompaction(
  state: { recentCompactions: ReducerCompaction[] },
  compaction: ReducerCompaction,
): void {
  state.recentCompactions.push(compaction);
  while (state.recentCompactions.length > RETAINED_COMPACTIONS) {
    state.recentCompactions.shift();
  }
}

function reduceClaudeTurnRecord(
  state: ClaudeUsageReducerState,
  record: Record<string, unknown>,
  childTranscript = false,
): void {
  if (record.isSidechain && !childTranscript) {
    return;
  }
  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    const metadata = record.compactMetadata as Record<string, unknown> | undefined;
    state.pendingCompactionTrigger =
      typeof metadata?.trigger === 'string' && metadata.trigger ? metadata.trigger : null;
    const at = stamp(record.timestamp);
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
    retainNewestCompaction(state, {
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
    state.currentTurnPrevious = copyPreviousTurn(currentClaudeTurn(state));
    state.currentTurnWithdrawn = null;
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
  if (withdrawn && claudeModelWorks(record)) {
    // Model work after the answer makes the command a turn again, the same step a typed
    // prompt takes. The record below then answers it.
    state.currentTurnWithdrawn = null;
    if (state.openTurn && state.openTurnAnswered) {
      state.closedTurns++;
    }
    restoreClaudeTurn(state, withdrawn);
  }
  if (!state.openTurn) {
    return;
  }
  const localAnswer = claudeLocalAnswer(record);
  if (localAnswer !== null) {
    if (
      !state.openTurnAnswered &&
      state.currentTurnOutcome &&
      state.currentTurnCommand &&
      localAnswer.parent === state.currentTurnCommand
    ) {
      // The CLI answered the command itself, so the command is no turn and the turn before it
      // is the newest again. `visibleTurns` keeps its step, because it only names turns apart.
      // The command is held, finished, as the full reader holds it.
      const previous = state.currentTurnPrevious ?? null;
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
      };
      if (previous?.open && previous.answered) {
        state.closedTurns--;
      }
      restoreClaudeTurn(state, previous);
      // A prompt that got no reply before the command keeps a turn of its own, as the full reader
      // gives it a card, so the next typed prompt counts it rather than taking it in.
      state.openTurnAnswered = state.openTurn;
      state.currentTurnWithdrawn = withdrawn;
    }
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
  if (message?.stop_reason && state.currentTurnOutcome) {
    state.currentTurnOutcome.finished = finishedATurn(record);
  }
}

// One Claude response's usage in the common turn shape. Kept here for both the parent and
// child readers, so a cache tier cannot be priced one way on the card and another in its
// per-agent breakdown.
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
    // Older transcripts have the total but not the split; charge those at the 1-hour rate,
    // which is what this harness asks for.
    cacheWrite1h: total1h || (total5m ? 0 : usage.cache_creation_input_tokens || 0),
    cacheWrite5m: total5m,
    cacheWrite30m: 0,
    output: usage.output_tokens || 0,
    thinking: (usage.output_tokens_details as { thinking_tokens?: number } | undefined)?.thinking_tokens ?? 0,
  };
}

// Which lifetime a Claude response bought, or null where the record named none.
//
// `claudeUsage` charges an unsplit write at the hour, which is what this harness asks for.
// That is a price fallback, and a reader told "bought for 1 hour" on the strength of it is
// being shown an assumption as evidence. Both read the same field, so neither can drift.
export function claudeCacheLifetime(usage: ClaudeUsage): CacheLifetime | null {
  const created = usage.cache_creation as
    | { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
    | undefined;
  const hour = created?.ephemeral_1h_input_tokens;
  const short = created?.ephemeral_5m_input_tokens;
  // A request that wrote both has no single lifetime, and picking either one prices part of
  // the context at a rate it was never bought at. Neither the larger write nor the longer one
  // is the answer, so the answer is that there is none.
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

function numericUsageField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Reads the tier a Claude request billed at, carrying a non-standard speed through the same
// channel as service_tier. pricing.ts prices a `fast` tier at the model's fast-mode rate where
// the model publishes one, and refuses any other speed the way it refuses a tier it has no rate
// for. An absent speed reads as standard, matching an older transcript that recorded no such
// field.
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

// Amazon Bedrock writes a `msg_bdrk_` message id and names the first-party model, so the id is the
// only mark of a Bedrock request. Bedrock bills every inference profile except `global.` at 1.1
// times list. A request with no profile read pays the charge too, because Claude Code's Bedrock
// default is a `us.` profile. The Bedrock class replaces the in-region one, and a `global.` Bedrock
// request takes no class at all, so it pays list whatever its `inference_geo` says.
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

// The set behind the saved queue, built on first use. Every replacement path updates the
// queue and the set together, so membership checks stay constant-time across long child runs.
function seenRequestIndex(state: ClaudeUsageReducerState): Set<string> {
  if (state.seenRequests instanceof Set) {
    return state.seenRequests;
  }
  const index = new Set(state.seenRequestKeys);
  state.seenRequests = index;
  return index;
}

// Reduces one parsed Claude transcript record into its billed request. The caller owns the
// state, which makes a full scan and an appended-chunk scan take exactly the same path.
export function reduceClaudeUsageRecord(
  state: ClaudeUsageReducerState,
  record: Record<string, unknown>,
  opts: ClaudeUsageReadOptions = {},
): UsageEvent | null {
  if (record.type !== 'assistant') {
    return null;
  }
  if (record.isSidechain && opts.countSidechain !== true) {
    return null;
  }
  const message = record.message as
    | {
        id?: unknown;
        model?: unknown;
        usage?: ClaudeUsage;
      }
    | undefined;
  const usage = message?.usage;
  if (!usage || message?.model === '<synthetic>') {
    return null;
  }
  const messageId = typeof message.id === 'string' && message.id ? message.id : null;
  const uuid = typeof record.uuid === 'string' && record.uuid ? record.uuid : null;
  const timestamp = Date.parse(String(record.timestamp ?? ''));
  const requestKey = `claude:${messageId ?? uuid ?? `${Number.isNaN(timestamp) ? '' : timestamp}:${String(message.model ?? '')}`}`;
  if (opts.emitRepeats !== true) {
    // Claude Code writes one assistant record for each content block of a response, and each
    // one repeats the whole usage. Thousands of other requests can separate the first of those
    // records from the last, so this queue keeps every request the file has billed. A window
    // over it bills the response again as soon as the window has moved past it.
    const seen = seenRequestIndex(state);
    if (seen.has(requestKey)) {
      return null;
    }
    seen.add(requestKey);
    state.seenRequestKeys.push(requestKey);
  }
  const counted = claudeUsage(usage);
  const inferenceClass = claudeRequestInferenceClass(messageId, state.modelProfile, usage.inference_geo);
  const serviceTier = claudeServiceTier(usage);
  const model = typeof message.model === 'string' && message.model ? message.model : null;
  // A request that only reads the prefix back names no lifetime, and still sits inside the one
  // the session bought last.
  state.firstRequestCacheRead ??= counted.cacheRead;
  state.lastRequest = {
    tokens: counted.input + counted.cacheRead + counted.cacheWrite1h + counted.cacheWrite5m,
    cacheRead: counted.cacheRead,
    cacheWrite: counted.cacheWrite1h + counted.cacheWrite5m + (counted.cacheWrite30m ?? 0),
    at: Number.isNaN(timestamp) ? null : timestamp,
    lifetime: claudeCacheLifetime(usage) ?? state.lastRequest?.lifetime ?? null,
    inferenceClass,
    serviceTier,
    model,
  };
  return {
    timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
    agent: 'claude',
    // Claude records no provider identity on this response. A model family is not proof of
    // the service that billed it.
    provider: null,
    model,
    contextWindow: null,
    contextBand: null,
    billingClass: 'unknown',
    inferenceClass,
    serviceTier,
    effort: typeof record.effort === 'string' && record.effort ? record.effort : null,
    toolListVersion: state.toolListVersion ?? 0,
    reportedCost: numericUsageField(usage.cost_usd) ?? numericUsageField(usage.cost),
    // A sidechain response runs under the child agent's own prompt, and this reader counts
    // no visible turn for it. It reports none rather than the parent turn that was open.
    visibleTurnId: record.isSidechain || state.visibleTurns === 0 ? null : `claude-turn:${state.visibleTurns}`,
    cacheLifetime: claudeCacheLifetime(usage),
    compactionsBefore: state.compactionCount,
    usage: counted,
    requestKey,
  };
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
  const usage = compactionEstimate({
    model: previous.model,
    at,
    durationMs: size.durationMs,
    contextBefore: size.before || previous.tokens,
    contextAfter: size.after,
    previousRequest: previous,
    firstRequestCacheRead: state.firstRequestCacheRead ?? null,
    summaryChars: compaction.summaryChars ?? null,
  })?.usage;
  if (!usage) {
    return null;
  }
  return {
    timestamp: at > 0 ? at : (previous.at ?? 0),
    agent: 'claude',
    provider: null,
    model: previous.model,
    contextWindow: null,
    contextBand: null,
    billingClass: 'unknown',
    inferenceClass: previous.inferenceClass ?? null,
    serviceTier: previous.serviceTier ?? null,
    reportedCost: null,
    visibleTurnId: null,
    compactionsBefore: compaction.ordinal,
    compactionEstimate: true,
    usage,
    requestKey: `claude-compaction:${compaction.ordinal}`,
  };
}

export function reduceClaudeUsageLine(
  state: ClaudeUsageReducerState,
  line: string,
  opts: ClaudeUsageReadOptions = {},
): UsageEvent | null {
  // Tool results carry most transcript bytes. Prompts now reach the same incremental pass so
  // it can count turns while it is already scanning the file; every other user record still
  // stays out before JSON parsing.
  const isUser = /"type"\s*:\s*"user"/.test(line);
  const isAssistant = /"type"\s*:\s*"assistant"/.test(line);
  const isProcessEnd = /"type"\s*:\s*"cost-state"/.test(line);
  const isLocalCommand = /"subtype"\s*:\s*"local_command"/.test(line);
  const isCompactionBoundary = /"subtype"\s*:\s*"compact_boundary"/.test(line);
  const isToolDelta = /"type"\s*:\s*"deferred_tools_delta"/.test(line);
  const isModelAttachment = line.indexOf(MODEL_ATTACHMENT_MARK) >= 0;
  // A background agent that finishes while the main agent works reports back as an
  // attachment, not as a user record. That report can be the turn's last event, so the line has
  // to reach the turn reducer. The scan runs only over lines this gate would drop.
  if (
    !isUser &&
    !isAssistant &&
    !isProcessEnd &&
    !isLocalCommand &&
    !isCompactionBoundary &&
    !isToolDelta &&
    !isModelAttachment &&
    line.indexOf('task-notification') < 0
  ) {
    return null;
  }
  if (skipsOrdinaryToolResult(line, isUser)) {
    return null;
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  reduceClaudeTurnRecord(state, record, opts.countSidechain === true);
  return record.type === 'assistant' ? reduceClaudeUsageRecord(state, record, opts) : null;
}

export interface ClaudeUsageLineReducer {
  parserKind: 'claude';
  pushLine(line: string): readonly UsageEvent[];
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

// Child responses are cumulative records: a later line for one request replaces the earlier
// one. The project index is append-only, so the child reducer removes the prior event and adds
// the new one. Its snapshot keeps the prior event beside the byte cursor, including every field
// that selects a daily bucket.
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
  };
}

function removalFor(event: UsageEvent): UsageEvent {
  return {
    ...event,
    reportedCost: event.reportedCost === null ? null : -event.reportedCost,
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
  const restoredKeys = [...(restored?.seenRequestKeys ?? [])];
  const state: ClaudeUsageReducerState = restored
    ? {
        seenRequestKeys: restoredKeys,
        closedTurns: restored.closedTurns ?? 0,
        openTurn: restored.openTurn,
        openTurnAnswered: restored.openTurnAnswered,
        compactionCount: restored.compactionCount ?? 0,
        recentCompactions: (restored.recentCompactions ?? []).map((item) => ({ ...item })),
        pendingCompactionTrigger: restored.pendingCompactionTrigger ?? null,
        pendingCompactionSize: restored.pendingCompactionSize ? { ...restored.pendingCompactionSize } : null,
        unsizedCompaction: copyUnsizedCompaction(restored.unsizedCompaction),
        lastRequest: restored.lastRequest ? { ...restored.lastRequest } : null,
        firstRequestCacheRead: restored.firstRequestCacheRead ?? null,
        ...(restored.modelProfile ? { modelProfile: restored.modelProfile } : {}),
        visibleTurns: restored.visibleTurns ?? 0,
        firstTurnAt: restored.firstTurnAt ?? null,
        currentTurnStartedAt: restored.currentTurnStartedAt ?? null,
        currentTurnEndedAt: restored.currentTurnEndedAt ?? null,
        currentTurnCommand: restored.currentTurnCommand ?? null,
        currentTurnPrevious: copyPreviousTurn(restored.currentTurnPrevious),
        currentTurnWithdrawn: copyPreviousTurn(restored.currentTurnWithdrawn),
        currentTurnOutcome: copyTurnOutcome(restored.currentTurnOutcome),
        // Only a child read removes what a revision replaces, so only a child read carries the
        // events forward. A parent read drops a repeat outright and reads no event. Carrying
        // the events forward would save a map that nothing can pair with the queue.
        ...(opts.childTranscript && restored.requestEvents
          ? {
              requestEvents: {
                ...retainedRequestEvents(restoredKeys, restored.requestEvents),
              },
            }
          : {}),
      }
    : emptyClaudeUsageReducerState();
  return {
    parserKind: 'claude',
    pushLine: (line) => {
      const event = reduceClaudeUsageLine(
        state,
        line,
        opts.childTranscript ? { countSidechain: true, emitRepeats: true } : {},
      );
      // Only a summary or a boundary completes a pair, and neither line carries a request.
      const estimate = claudeCompactionEstimateEvent(state);
      if (estimate) {
        return [estimate];
      }
      if (!event || !opts.childTranscript || !event.requestKey) {
        return event ? [event] : [];
      }
      return replaceClaudeUsageEvent(state, event);
    },
    snapshot: () => ({
      seenRequestKeys: [...state.seenRequestKeys],
      closedTurns: state.closedTurns,
      openTurn: state.openTurn,
      openTurnAnswered: state.openTurnAnswered,
      compactionCount: state.compactionCount,
      recentCompactions: state.recentCompactions.map((item) => ({ ...item })),
      pendingCompactionTrigger: state.pendingCompactionTrigger ?? null,
      pendingCompactionSize: state.pendingCompactionSize ? { ...state.pendingCompactionSize } : null,
      unsizedCompaction: copyUnsizedCompaction(state.unsizedCompaction),
      lastRequest: state.lastRequest ? { ...state.lastRequest } : null,
      firstRequestCacheRead: state.firstRequestCacheRead ?? null,
      ...(state.modelProfile ? { modelProfile: state.modelProfile } : {}),
      visibleTurns: state.visibleTurns,
      firstTurnAt: state.firstTurnAt,
      currentTurnStartedAt: state.currentTurnStartedAt,
      currentTurnEndedAt: state.currentTurnEndedAt,
      currentTurnCommand: state.currentTurnCommand ?? null,
      currentTurnPrevious: copyPreviousTurn(state.currentTurnPrevious),
      currentTurnWithdrawn: copyPreviousTurn(state.currentTurnWithdrawn),
      currentTurnOutcome: copyTurnOutcome(state.currentTurnOutcome),
      ...(state.requestEvents ? { requestEvents: { ...state.requestEvents } } : {}),
    }),
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

// All billed requests in one Claude child transcript, grouped by the model each response
// names. A response is written more than once, and only its last record carries the whole
// output and thinking count. Each request therefore keeps its last record, not its first.
//
// Each compaction the usage reducer can estimate joins the usage parts as its own estimated
// part, so this figure and the session total price the same requests. The model totals keep
// recorded usage only.
//
// A dispatched session is read with `childTranscript` false. Its figure counts the inline
// sidechain requests, but its own session total sizes a compaction from the last main request.
// A second reducer state therefore follows the requests the spend index reads, with the spend
// index's options, and only that state pairs and sizes compactions.
//
// The figure includes the spend of every subagent this transcript launched, and of theirs in
// turn. Commits and artifacts stay the transcript's own. The figure is partial when a launch has
// no meta file, when a descendant transcript cannot be read, or when a descendant's last turn is
// still open.
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
      let record: unknown;
      try {
        record = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      } catch {
        continue;
      }
      if (!record || typeof record !== 'object') {
        continue;
      }
      const { toolUseId, parentAgentId } = record as { toolUseId?: unknown; parentAgentId?: unknown };
      meta = {
        id: match[1],
        file: path.join(directory, `agent-${match[1]}.jsonl`),
        toolUseId: typeof toolUseId === 'string' && toolUseId ? toolUseId : null,
        parentAgentId: typeof parentAgentId === 'string' && parentAgentId ? parentAgentId : null,
      };
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

// The key over every child spend figure some turns show. The worker files it with each window
// it reads. The host builds it again from the files on disk, and a different key marks those
// figures stale. Both sides build it here, so the two keys agree until a child or one of its
// nested subagents writes. `versionOf` lets a caller read each file once for several keys.
// `now` decides whether a running child has gone quiet. A caller that stores a key for spend
// read on a trip passes the clock reading the trip used.
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
      // A running child writes many times a minute. Its band moves at most once a band, so its
      // cost so far stays current and its parent repaints at that rate. A running child that has
      // gone quiet for a band keys on its exact version, as a finished child does.
      if (agentSpendIsOpen(ref.status)) {
        const band = file ? openSpendBand(versionOf(file), now) : 'none';
        if (band !== null) {
          return `${ref.id || ref.path || ref.name}:open:${band}`;
        }
      }
      return file ? `${file}:${versionOf(file)}` : `${ref.id || ref.path || ref.name}:missing`;
    }),
  );
  return (
    [...recorded, ...(structuralKey ? [structuralKey] : [])].join('\n') +
    codexChildFiles
      .map((file) => `\n${file}:${versionOf(file)}`)
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
  usageParts: TurnUsagePart[];
  // Each launch that started a subagent or may have. A launch whose tool result is an error
  // started nothing, so it leaves no meta file to find.
  launches: string[];
  partial: boolean;
  effort: string | null;
  finished: boolean;
  record: ClaudeSpendRecord | null;
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
  // The reducer takes a state object for its window of seen requests. This read keeps every
  // repeat, so nothing on this path reads or writes that window.
  const usageState = emptyClaudeUsageReducerState();
  const launches = new Set<string>();
  const failedToolUses = new Set<string>();
  let partial = false;
  let effort: string | null = null;
  let lastLine = '';
  const estimates: UsageEvent[] = [];
  const compactionState = emptyClaudeUsageReducerState();
  const compactionOptions: ClaudeUsageReadOptions = childTranscript ? { countSidechain: true, emitRepeats: true } : {};
  // A session's own transcript is read whole here, so the person fact rides on this read and
  // a dispatched session pays no second read for it.
  const person: PersonScan | null =
    withRecord && !childTranscript
      ? { bytes: 0, person: false, prompts: 0, bg: false, start: 0, userBefore: false }
      : null;
  const child = createClaudeSessionReducer(path.basename(file, path.extname(file)), {
    childTranscript,
    folders,
    maxTurns: Number.MAX_SAFE_INTEGER,
  });
  const found = scanLines(file, (line) => {
    child.pushLine(line);
    if (line.trim()) {
      lastLine = line;
    }
    if (person && !person.person && mayHoldPersonSign(line, person)) {
      try {
        person.person = personSpokeIn(JSON.parse(line), person);
      } catch {
        /* a cut line is no sign */
      }
    }
    if (line.indexOf('"type":"assistant"') < 0) {
      // Both states price requests, so both read the profile each `model` attachment names.
      if (line.indexOf(MODEL_ATTACHMENT_MARK) >= 0) {
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
    reduceClaudeUsageRecord(compactionState, o, compactionOptions);
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
    const event = reduceClaudeUsageRecord(usageState, o, { countSidechain: true, emitRepeats: true });
    if (event) {
      replaceClaudeUsageEvent(usageState, event, Number.POSITIVE_INFINITY);
    }
  });
  const byRequest = Object.values(usageState.requestEvents ?? {});
  const byModel = new Map<string | null, TurnUsage>();
  for (const request of byRequest) {
    addModelUsage(byModel, request.model, request.usage);
  }
  const exact = { usageParts: [] as TurnUsagePart[] };
  for (const request of [...byRequest, ...estimates]) {
    addTurnUsagePart(exact, request);
  }
  const childTurns = child.finish().turns;
  let record: ClaudeSpendRecord | null = null;
  if (withRecord) {
    const span = childTurnSpan(childTurns);
    const startedAt = span.startedAt ?? null;
    // This read's own rule sits on top of the shared span: the first turn's own endedAt is
    // folded in even where its process ended earlier, so a process end recorded before that
    // turn's last record never pulls a dispatched session's shown span earlier than the turn
    // itself. A later turn keeps the shared rule, its process end where one was recorded.
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
    usageParts: exact.usageParts,
    launches: [...launches].filter((id) => !failedToolUses.has(id)),
    partial,
    effort,
    finished: childTurns.at(-1)?.finished === true,
    record,
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
    }
  }
  const models = modelSpends(byModel).map((spend) => ({
    ...spend,
    usageParts: usageParts.filter((part) => part.model === spend.model),
  }));
  const record = own.record ? structuredClone(own.record) : {};
  // A subagent's parent records no result for a background launch, so a descendant counts as
  // running until its own last turn closes.
  return { spend: { models, found: true, partial, effort: own.effort, ...record }, finished: own.finished };
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

// The cache read of the first request a Claude transcript billed, read from the head of the file
// the way the spend reducer reads it, or null where the file holds no request. The scan stops at
// that request, so it reads no further than the first answer.
//
// A transcript only grows, so its first request never changes and each file is read from its head
// once. The held answer stands while the file keeps its device and inode and is no smaller than it
// was when the read began. A file that changed identity or shrank was replaced, and is read again.
// A file that held no request is read again once it grows.
export function claudeFirstRequestCacheRead(file: string, childTranscript = false): number | null {
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
    return state.firstRequestCacheRead != null;
  });
  return state.firstRequestCacheRead ?? null;
}

// Gives each Claude compaction the cache read of its transcript's first request. A tail read
// never sees that request on a large transcript, so the head of the file answers it, as the spend
// index answers it for the session total. Only a compaction with a request before it asks, and
// only when it does not carry the answer already.
export function withClaudeFirstRequest(file: string, compactions: Compaction[], childTranscript = false): void {
  const asking = compactions.filter(
    (compaction) => compaction.previousRequest && compaction.firstRequestCacheRead === undefined,
  );
  if (!asking.length) {
    return;
  }
  const read = claudeFirstRequestCacheRead(file, childTranscript);
  if (read === null) {
    return;
  }
  for (const compaction of asking) {
    compaction.firstRequestCacheRead = read;
  }
}

// Turns and compactions in the tail of one session transcript, each oldest first.
export function readSession(file: string, sessionId: string, opts: ReadOptions = {}): SessionRead {
  const tailBytes = opts.tailBytes ?? 4 * 1024 * 1024;
  const tail = tailOf(file, tailBytes, opts.prepareNewestTurnDiscovery === true);
  const read = readSessionLines(tail.lines, sessionId, opts, tail.readBytes, tail.offset);
  if (!opts.turnsOnly) {
    withClaudeFirstRequest(file, read.compactions, opts.childTranscript === true);
  }
  if (opts.prepareNewestTurnDiscovery && !tail.whole && tail.cursor && sessionTurnStartsIn(tail.lines).length === 0) {
    read.newestTurnCursor = tail.cursor;
  }
  return read;
}

export function discoverClaudeNewestTurn(
  file: string,
  cursor: BackwardLineCursor,
  options: BoundaryDiscoveryOptions = {},
): Promise<BoundaryDiscovery> {
  return discoverBackwardBoundary(file, cursor, (line) => humanPromptIn(line.text, false) !== null, options);
}

interface RecordedTitleState {
  title: string;
  fullTitle: string | null;
  start: number;
  end: number;
  at: number | null;
}

export interface ClaudeSessionParserState {
  version: 6;
  turns: Turn[];
  turnRanges: Array<{ start: number; end: number }>;
  turnMembershipStarts: number[];
  compactions: Compaction[];
  compactionRanges: Array<{ start: number; end: number }>;
  compactionMetadataRanges: Array<{ start: number; end: number } | null>;
  compactionValueSources: Array<{
    context: { start: number; end: number } | null;
    model: { start: number; end: number } | null;
    // Where the previous request came from. Absent in a checkpoint saved before it existed.
    previous?: { start: number; end: number } | null;
  }>;
  turnLimitReached: boolean;
  // The newest discarded prompt proves whether advancing the tail removed every overflow.
  turnLimitStart: number | null;
  lastContext: number;
  // The last lifetime this session recorded, which a later request that wrote nothing
  // still sits inside. A request that only reads the prefix back names none of its own, and
  // reporting no lifetime there would leave a live cache described as unknown for good.
  lastLifetime: CacheLifetime | null;
  lastContextSource: { start: number; end: number } | null;
  // The request that set lastContext, for the compaction that follows it.
  lastContextRequest?: ContextRequest | null;
  // What that request read from and wrote to the cache. Absent in a checkpoint saved before it existed.
  lastContextCache?: { read: number; write: number } | null;
  lastModel: string | null;
  lastModelSource: { start: number; end: number } | null;
  currentModelSource: { start: number; end: number } | null;
  compactMeta: Array<{ at: number; data: CompactMetadata; start: number; end: number }>;
  launched: Map<string, TurnAgent>;
  toolNames: Map<string, string>;
  stepById: Map<string, TurnStep>;
  // Every skill load a later record can still revise, keyed by the call id that loaded it.
  // Two records revise one: a result that came back as an error withdraws the load, and the
  // record carrying the skill's own instructions supplies the file it read them from.
  skillUseById: Map<string, { use: TurnSkillUse; owner: Turn | SourcedBuilding }>;
  // A typed command record naming a skill, held for exactly one more record. Claude Code
  // writes the base-directory line that proves it as the very next record when the command
  // loaded a skill, and writes something else when it did not. Whatever arrives next either
  // resolves this into a `TurnSkillUse` or clears it; nothing in between is ever proof.
  pendingTypedSkill: { name: string; sourceId: string; at: number } | null;
  // The subagents anywhere in the session whose handback already woke the agent, by the id
  // the handback names as its sender. That id is the `<task-id>` of the subagent's completion
  // notice. The value is true once a reply closed after the handback, and it stays true
  // across a typed prompt: a notice for the same id is a repeat in any later turn, not only
  // the one that closed the reply. `repeatNotice` holds whether the newest wake was a
  // completion notice for a subagent whose handback a reply already answered, with no tool
  // call since that reply closed. A notice that arrives before that reply, or after a tool
  // call the agent made since, repeats nothing: the reply that follows answers the work
  // rather than the notice. A peer message, a prompt, another notice and a tool call each
  // clear `repeatNotice`. A closed reply ends it too, but Claude Code writes the blocks of
  // one message as separate lines that share the message id, so `repeatReplyId` holds the id
  // of the reply that closed under the repeat, and the flag clears when a line of another
  // message arrives. `workedSinceReply` tracks whether a tool call happened since the last
  // closed reply, so a notice queued after that work never marks the reply that follows it.
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
  // What an Edit, Write or NotebookEdit call asked for, by call id, held until its result
  // says the call went through. Only a child read fills this, because only a child record
  // reaches this reader with no `toolUseResult` to read the change from. An entry holds the
  // figures the input came to and never its text, so a `Write` of a whole file costs a path
  // and three numbers rather than the file.
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
  cur: SourcedBuilding | null;
  // The id of the typed record that opened `cur`, and whether a local command answer that
  // names it has finished `cur`. Such a turn is no turn. It closes with no card unless the
  // model works in it later, and a process end goes to the newest card instead.
  curCommand: string | null;
  curLocalAnswer: boolean;
  // The unanswered turn that `cur` took in when its prompt was typed, with that turn's source
  // range as plain numbers, because a symbol does not cross the worker boundary. A local
  // command answer hands it back as a card of its own.
  curCarried: { turn: Building; start: number; end: number; membership: number } | null;
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
  pushLine(line: string | ParserLine): void;
  trimBefore(offset: number): boolean | void;
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
    version: 6,
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
    cur: null,
    curCommand: null,
    curLocalAnswer: false,
    curCarried: null,
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
  state.turns.push(emitted);
  for (const [id, owner] of state.toolOwnerById) {
    if (owner === turn) {
      state.toolOwnerById.set(id, emitted);
    }
  }
  // The emitted turn is a shallow copy, so its skill count is a figure of its own. A load
  // withdrawn by a result that arrives after the turn closed has to reach that figure, or
  // the card counts a load the list no longer holds.
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

function boundClaudeToolAssociations(state: ClaudeSessionParserState): void {
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

function pruneClaudeTurnAssociations(state: ClaudeSessionParserState): void {
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
  boundClaudeToolAssociations(state);
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
    state.curCarried = null;
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
  // A typed invocation of this same skill may already have resolved on this turn, from the
  // command record that opened it. That use and this one name the same load: the reader
  // typed a skill and the model also named it, not two loads. A second `Skill` call for a
  // name an earlier `Skill` call already recorded is a second load, not this case, so the
  // skip only fires for a use the typed path itself recorded.
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

// A skill the reader loaded by typing its command, proven by the base-directory line the
// command record's immediate successor carries. The command record itself names the skill,
// and the successor supplies the file, the same two facts a `Skill` tool call and its own
// base-directory record supply for the other path. This resolves on the second record of a
// turn the command record itself just opened, before any `Skill` tool call for this turn has
// run, so `turn.skillUses` is always empty here and no dedupe check runs on this path.
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

// What a completion notice changes on the row its launch drew. Both recorded shapes reach
// this with the same raw text, so the status, the child id and the reported figures follow
// one rule. A notice that names no launched row changes nothing: the same task can report
// twice, and a second report carries the id of the message that woke the agent rather than
// the id of its launch. A second row for a resumed agent would count its cost twice.
function applyClaudeTaskNotification(state: ClaudeSessionParserState, raw: string, at: number): void {
  const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(raw);
  const task = /<task-id>([^<]+)<\/task-id>/.exec(raw);
  setClaudeRepeatNotice(state, task !== null && state.handbacks.get(task[1]) === true && !state.workedSinceReply);
  // The notice reports this agent's own background work, not a new request, so a reply to it
  // after a `SubagentHandback` call stays a receipt. A later report arrives as a second call.
  const status = /<status>([^<]+)<\/status>/.exec(raw);
  const agent = id ? state.launched.get(id[1]) : undefined;
  if (agent && status) {
    agent.status = status[1];
    if (status[1] !== 'running') {
      agent.closedAt = at;
    }
  }
  // A subagent that ran in the background reports what it spent here, and nowhere else the
  // reader can see: its own lines are written to a separate file, not into this transcript.
  // Without this its row shows a description and no figures.
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
  // Only the call that launched the agent ends here. A notice that names no launched row
  // carries some other id: the same task reports twice, and the second report arrives under
  // the id of the message that woke the agent. `finishClaudeTool` drops the name, the step,
  // the owner and the call held for an id, so ending an unknown one cuts a message that is
  // still in flight loose from its own result.
  if (agent && id && status && status[1] !== 'running') {
    finishClaudeTool(state, id[1], true);
  }
}

// A nested launch's text-only result, applied to the row its launch drew. A background launch
// only names its child here and stays open for its completion notice.
function applyClaudeAgentResultText(state: ClaudeSessionParserState, id: string, content: unknown): void {
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

// Whether the model worked in a turn, or the reader interrupted it.
function claudeModelWorked(turn: SourcedBuilding): boolean {
  return turn.toolUses > 0 || turn.usage.output > 0 || turn.summary !== '' || turn.error !== null || turn.interrupted;
}

// Whether anything answered a turn: the model, an interruption, or the end of the process.
function claudeTurnAnswered(turn: SourcedBuilding): boolean {
  return claudeModelWorked(turn) || turn.processEndedAt !== undefined;
}

function closeClaudeTurn(state: ClaudeSessionParserState, maxTurns: number): void {
  const turn = state.cur;
  if (!turn) {
    return;
  }
  const localOnly = state.curLocalAnswer && !claudeModelWorked(turn);
  const answered = claudeTurnAnswered(turn);
  state.curCommand = null;
  state.curLocalAnswer = false;
  state.curCarried = null;
  if (localOnly) {
    // The CLI answered the command itself, so it leaves no card. Words queued ahead of the
    // command, or behind it, go to the next prompt. The command's own text is the last part.
    state.queued.push(
      ...(turn.promptParts ?? []).slice(0, -1),
      ...turn.laterPrompts.map((ask) => ({ ...ask, stepsBefore: 0 })),
    );
    state.pending.held = null;
  } else if (answered) {
    emitClaudeTurn(state, turn, maxTurns);
    state.pending.held = null;
  } else {
    state.pending.held = turn;
  }
  state.cur = null;
  state.currentModelSource = null;
  state.awaited = [];
  pruneClaudeAgentAssociations(state);
  pruneClaudeTurnAssociations(state);
}

function settleClaudeSteps(state: ClaudeSessionParserState): void {
  for (const step of state.awaited) {
    if (step.status === 'running') {
      step.status = 'done';
    }
  }
  state.awaited = [];
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
  if (line.length < 20) {
    return;
  }
  if (line.indexOf(MODEL_ATTACHMENT_MARK) >= 0) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if ((!o.isSidechain || opts.childTranscript) && noteClaudeModelProfile(state.usageState, o)) {
        return;
      }
    } catch {
      /* skip malformed line */
    }
  }
  if (line.indexOf('"compactMetadata"') >= 0) {
    try {
      const o = JSON.parse(line) as { compactMetadata?: CompactMetadata; timestamp?: unknown };
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
  // What the reader typed while the agent was already working. Claude Code writes that as
  // an attachment rather than as a user line, so the filter below would never see it, and
  // the agent answers it inside the running turn. Tested by the rarest substring on the
  // line: the same file holds thousands of other attachments, and parsing to reject them
  // would put back the cost this filter exists to avoid.
  if (line.indexOf('"queued_command"') >= 0) {
    let attachmentLine = false;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      attachmentLine = o.type === 'attachment';
      const attachment = o.attachment as Record<string, unknown> | undefined;
      if (attachmentLine && !o.isSidechain && isReaderQueued(attachment) && state.cur) {
        const text = cleanPrompt(textOf(attachment?.prompt));
        if (text) {
          setClaudeRepeatNotice(state, false);
          state.cur.laterPrompts.push({
            text,
            at: stamp(attachment?.timestamp ?? o.timestamp),
            stepsBefore: state.cur.stepCount,
          });
          if (state.cur.laterPrompts.length > TURN_ASK_LIMIT) {
            state.cur.laterPrompts.shift();
          }
          extendSourceRange(state.cur, sourceStart, sourceEnd);
        }
      }
      // A subagent's handback that arrives while the agent works is queued here with a peer
      // origin, rather than written as a meta user record.
      if (attachmentLine && !o.isSidechain && attachment?.commandMode === 'prompt' && state.cur) {
        applyClaudePeerMessage(state, attachment.origin);
      }
      // A background agent that finishes while the main agent works reports back on this
      // same line rather than as a user record. The row keeps the status its launch wrote
      // without this, and the child id never arrives, so the child's cost stays out of the
      // turn total. The notice is still not a prompt, and nothing above draws it as one.
      const notice = attachmentLine && !o.isSidechain ? taskNotificationText(o) : null;
      if (notice !== null && state.cur) {
        const at = claudeRecordAt(o);
        applyClaudeTaskNotification(state, notice, at);
        state.cur.endedAt = Math.max(state.cur.endedAt, at);
        extendSourceRange(state.cur, sourceStart, sourceEnd);
      }
    } catch {
      /* skip malformed line */
    }
    // Only a real attachment is taken out of the stream here. Those two words are a
    // substring away from any prompt or tool argument that happens to hold them, and a
    // user or assistant line dropped in passing takes its whole turn with it.
    if (attachmentLine) {
      return;
    }
  }
  if (line.indexOf('"type":"cost-state"') >= 0) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const processEndedAt = claudeProcessEndedAt(o);
      if (processEndedAt !== null && state.cur && !o.isSidechain) {
        if (state.curLocalAnswer && !claudeModelWorked(state.cur)) {
          // The command is no turn, so the process end belongs to the turn before it, which is
          // the newest card. With no card before the command, it belongs to no turn.
          const newest = state.turns[state.turns.length - 1];
          if (newest) {
            newest.processEndedAt = Math.max(newest.processEndedAt ?? 0, processEndedAt);
          }
        } else {
          state.cur.processEndedAt = Math.max(state.cur.processEndedAt ?? 0, processEndedAt);
          extendSourceRange(state.cur, sourceStart, sourceEnd);
        }
      }
    } catch {
      /* skip malformed line */
    }
    return;
  }
  // The answer to a command the CLI ran by itself, such as `/rename`. No assistant record
  // follows that command, and the answer makes the command no turn. A user or assistant line
  // that merely mentions the subtype goes on to the readers below.
  if (line.indexOf('"local_command"') >= 0) {
    let systemLine = false;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      systemLine = o.type === 'system';
      const answer = claudeLocalAnswer(o);
      const cur = state.cur;
      if (
        answer !== null &&
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
          emitClaudeTurn(state, held, maxTurns);
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
        // The command stays open, finished, so model work that follows it has a turn to land on
        // and makes it a card again, as in every reader. `closeClaudeTurn` drops it otherwise, at
        // the next prompt or the end of the read.
        cur.finished = true;
        cur.endedAt = Math.max(cur.endedAt, answer.at);
        state.curLocalAnswer = true;
        // The answer proves the command named no skill.
        state.pendingTypedSkill = null;
        extendSourceRange(cur, sourceStart, sourceEnd);
      }
    } catch {
      /* skip malformed line */
    }
    if (systemLine) {
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
  // timeline reports: an edit, a subagent's result, a failure, or repository output.
  if (skipsOrdinaryToolResult(line, isUser, state.wrote)) {
    return;
  }

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  // A subagent writes its own transcript to a separate file, so nothing of its work
  // reaches this one except the launch and the result. This guard is the belt on top of
  // that: it costs nothing and keeps the rule true if the format ever changes.
  if (o.isSidechain && !opts.childTranscript) {
    return;
  }
  // A typed command waits exactly one record for proof it named a skill. This is that
  // record, whatever it turns out to be: it either carries the base-directory line and
  // resolves the load, or it carries something else and the command named no skill.
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
    boundClaudeCompactions(state, maxTurns);
    return;
  }

  if (isUser && isTypedPrompt(o, opts.childTranscript)) {
    closeClaudeTurn(state, maxTurns);
    const at = stamp(o.timestamp);
    // A held prompt got no reply of its own, so it belongs to this turn.
    const carried = state.pending.held;
    // Whatever was typed into the held turn comes with it. Those words were the reader's
    // and the turn they were sent into never answered, so dropping them here is the card
    // saying less than it was asked, which is the same fault on a different line.
    const carriedAsks: TurnAsk[] = carried ? carried.laterPrompts : [];
    // Its parts rather than its prompt. A turn carried forward can itself be carrying
    // one, and its joined prompt handed on whole puts two of them in one part again.
    if (carried) {
      state.queued.push(...(carried.promptParts ?? []));
      state.pending.held = null;
    }
    const rawText = textOf((o.message as { content?: unknown }).content);
    const asked = [...state.queued, { text: cleanPrompt(rawText), at, stepsBefore: 0 }];
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
      laterPrompts: carriedAsks.slice(-TURN_ASK_LIMIT),
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
    state.curCommand = claudeRecordId(o);
    state.curLocalAnswer = false;
    state.curCarried = carried
      ? {
          turn: carried,
          start: carried[SOURCE_START] ?? sourceStart,
          end: carried[SOURCE_END] ?? carried[SOURCE_START] ?? sourceStart,
          membership: carried[MEMBERSHIP_START] ?? carried[SOURCE_START] ?? sourceStart,
        }
      : null;
    state.currentModelSource = null;
    // A command names a skill only when it is not one of the harness's own controls. The
    // very next record either proves it with a base-directory line or proves it did not,
    // so nothing is recorded yet.
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
  if (!state.cur) {
    return;
  } // a turn that began before the window; no prompt to attach it to
  const cur = state.cur;
  extendSourceRange(cur, sourceStart, sourceEnd);

  if (isUser) {
    const notice = taskNotificationText(o);
    if (notice !== null) {
      const at = stamp(o.timestamp);
      applyClaudeTaskNotification(state, notice, at);
      cur.endedAt = Math.max(cur.endedAt, at);
      return;
    }
    if (o.isMeta) {
      applyClaudePeerMessage(state, o.origin);
    }
    if (interruptedATurn(o)) {
      cur.interrupted = true;
      cur.endedAt = Math.max(cur.endedAt, stamp(o.timestamp));
      return;
    }
    // The record carrying a loaded skill's own instructions, which is where the file the
    // client read is recorded. It names the call it belongs to, so the path reaches that
    // load and no other. Nothing looser would do: a successful `Skill` result is filtered
    // out before this reader sees it, so the load and this record are not neighbours in
    // anything the reader reads, and a client that re-invokes a loaded skill writes a note
    // of its own between them.
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
    // Whether this record's own structured result holds the evidence. A Claude child
    // records nearly every result as text alone, and the few that carry a `toolUseResult`
    // carry neither the output nor a patch inside it, so the call and its text stay the
    // only source for those too. An array is typed as an object and holds neither field,
    // which is why the shape is read rather than its type. The two sources never both run
    // for one result.
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
            applyClaudeAgentResultText(state, toolId, b.content);
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
      // The launch already added a row for this subagent; fill it in rather than
      // listing the same run twice.
      const existing = state.launched.get(toolUseIdOf(o.message));
      if (existing) {
        Object.assign(existing, row);
        delete existing.toolUsesFromArtifacts;
      } else {
        cur.agents.push(row);
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
  if (message.model) {
    cur.model = message.model;
    state.currentModelSource = { start: sourceStart, end: sourceEnd };
  }
  // Sits beside `type` and `message` on the line, not inside `message`. Taken from the
  // last reply that recorded one rather than from the last reply, because roughly one
  // line in twenty carries none and the turn's effort did not change when it did.
  if (typeof o.effort === 'string' && o.effort) {
    cur.effort = o.effort;
  }
  // The turn is over once a reply stops for any reason other than calling a tool. A
  // turn still in flight always ends on a tool call, which is what tells the two apart.
  if (message.stop_reason) {
    cur.finished = finishedATurn(o);
  }
  const usageEvent = reduceClaudeUsageRecord(
    state.usageState,
    o,
    opts.childTranscript ? { countSidechain: true, emitRepeats: true } : {},
  );
  if (usageEvent) {
    const usage = usageEvent.usage;
    cur.contextTokens = usage.input + usage.cacheRead + usage.cacheWrite1h + usage.cacheWrite5m;
    const wrote = message.usage ? claudeCacheLifetime(message.usage) : null;
    if (wrote) {
      state.lastLifetime = wrote;
    }
    cur.contextRequest = {
      at: stamp(o.timestamp),
      lifetime: wrote ?? state.lastLifetime,
      inferenceClass: usageEvent.inferenceClass,
      serviceTier: usageEvent.serviceTier,
      readBack: usage.cacheRead > 0,
      outputTokens: usage.output,
    };
    const turnStart = cur[SOURCE_START] ?? sourceStart;
    state.lastContext = cur.contextTokens;
    state.lastContextRequest = cur.contextRequest;
    state.lastContextCache = {
      read: usage.cacheRead,
      write: usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0),
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
    const events = opts.childTranscript ? replaceClaudeUsageEvent(state.usageState, usageEvent) : [usageEvent];
    for (const event of events) {
      addUsage(cur.usage, event.usage);
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
    // Everything the agent asked for before this line has come back, or it could not be
    // writing this one.
    settleClaudeSteps(state);
    let answeredLine = false;
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
        // The skill this call loaded, where it named one. A call that named none loaded
        // nothing this reader can report, and the panel says nothing rather than naming a
        // skill it made up.
        const loadedSkill =
          block.name === 'Skill' && typeof block.input?.skill === 'string' ? block.input.skill.trim() : '';
        cur.toolUses++;
        // A skill load is in neither tool category table, so counted here it would land in
        // `other` and the mix would name a skill load an unrecognized call. The raw tool
        // total above still counts it, because the call happened.
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
            // Until a result comes back, which for the call the agent is on now never
            // happens while the panel is reading.
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
          if (cur.steps.length > TURN_STEP_LIMIT) {
            cur.steps.shift();
          }
          // Recorded beside the step and kept outside the step window, so a long turn still
          // says which skills it loaded after the calls that loaded them scroll out of it.
          // The call id is the identity a reread deduplicates by and the one the path and a
          // failed result both arrive under, so a call without one records no load.
          if (loadedSkill && block.id) {
            recordClaudeSkillUse(state, cur, block.id, loadedSkill, stamp(o.timestamp));
          }
        }
        // The cwd of this record, not of the result's: this one is the directory the
        // command started in, which is what a relative `cd` inside it resolves against.
        if (block.id && typeof block.input?.command === 'string') {
          const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : null;
          state.calls.delete(block.id);
          state.calls.set(block.id, { id: block.id, command: block.input.command, cwd, at: stamp(o.timestamp) });
          if (commitDirs(block.input.command, cwd).length > 0 || mergeDirs(block.input.command, cwd).length > 0) {
            state.wrote.add(block.id);
          }
          // A child's result record carries no `gitOperation` and no recorded output, so
          // this set is the only way its text reaches the reader. `git commit` is too
          // narrow for it: a revert, a cherry-pick, a rebase and a pull each print a
          // commit line for a commit they really made, and a commit run through `git -c`
          // prints one too. `ranGit` is the set `recordCommits` itself accepts a commit
          // line from, so widening to it admits exactly the results that reader can use
          // and leaves every other command's result skipped.
          else if (opts.childTranscript === true && ranGit(block.input.command)) {
            state.wrote.add(block.id);
          }
        }
        // A child record carries no patch, so what an edit changed is only ever in the
        // call's own input. The result still has to come back before the change is real,
        // so the figures wait here for it.
        if (block.id && block.name && opts.childTranscript === true) {
          const pending = pendingFileEdit(block.name, block.input ?? {});
          if (pending) {
            state.editCalls.delete(block.id);
            state.editCalls.set(block.id, pending);
            // A child's edit result carries no field the line gate recognizes, so without
            // this the result never reaches JSON.parse and the change is never read.
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
          cur.agents.push(row);
        }
        // A subagent in auto mode delivers its report as this call's message, and what it
        // writes after the call is a receipt. The report is therefore the turn's response.
        // The call closes no reply of this agent's own, so it settles no handback here.
        //
        // Some subagents write the report as a closing reply first and send it again after a
        // reminder that it was not delivered. When one of the two texts contains the other, the
        // turn keeps one answer with the longer text, so the card and the search text hold the
        // report once. Two texts that differ in any other way are both kept. Only the closing
        // reply in `closingReply` counts, so an earlier report, or a reply to an earlier wake,
        // is never merged.
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
          state.handedBack = true;
          state.closingReply = null;
        }
      } else if (block.type === 'text') {
        const text = String(block.text ?? '');
        if (!text.trim()) {
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
        if (!notResponse) {
          cur.summary = text;
        }
        // A text on a line whose response stopped for anything but a tool call closes
        // an answer. The line itself says so: measured over every transcript in this
        // workspace's store, every text line carries a stop_reason, so no reading of
        // the user lines between answers is needed, which matters because a skill
        // load arrives as a meta line mid-work exactly like the peer message that
        // wakes a finished response. Two text blocks on one line close one answer,
        // the last text winning the way it wins the summary. A later block that is not a
        // response closes its own answer, so the block before it keeps its answer.
        if (closes) {
          const answer: TurnAnswer = { text, at: stamp(o.timestamp), stepsBefore: cur.stepCount };
          if (notResponse) {
            answer.notResponse = notResponse;
          }
          const keepsLast = notResponse && !cur.answers[cur.answers.length - 1]?.notResponse;
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
      if (!notResponse) {
        cur.summary = content;
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
  boundClaudeToolAssociations(state);
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
    pruneClaudeTurnAssociations(state);
  }
}

// Records whether the newest wake repeats a handback's completion notice. Any change ends the
// reply that closed under the previous repeat.
function setClaudeRepeatNotice(state: ClaudeSessionParserState, repeat: boolean): void {
  state.repeatNotice = repeat;
  state.repeatReplyId = null;
}

// A message from another session wakes the agent. A subagent's handback is one, and its sender
// id is what the subagent's later completion notice names. A coordinator message, a parent's
// follow-up to its running subagent, wakes that subagent after its `SubagentHandback` call, so
// the reply to it can be the response. Any other origin changes nothing.
function applyClaudePeerMessage(state: ClaudeSessionParserState, origin: unknown): void {
  const peer = origin as { kind?: unknown; from?: unknown; handback?: unknown } | null | undefined;
  if (peer && typeof peer === 'object' && peer.kind === 'coordinator') {
    state.handedBack = false;
    state.closingReply = null;
    return;
  }
  if (!peer || typeof peer !== 'object' || peer.kind !== 'peer') {
    return;
  }
  if (peer.handback === true && typeof peer.from === 'string' && peer.from) {
    state.handbacks.set(peer.from, false);
  }
  setClaudeRepeatNotice(state, false);
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
    line.indexOf('"type":"cost-state"') >= 0 ||
    line.indexOf('"local_command"') >= 0
  ) {
    return true;
  }
  const isAssistant = line.indexOf('"type":"assistant"') >= 0;
  const isUser = !isAssistant && line.indexOf('"type":"user"') >= 0;
  return (isAssistant || isUser) && !skipsOrdinaryToolResult(line, isUser);
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

// The snapshot a caller may send across the progressive worker boundary, where a structured
// clone drops every symbol key and non-enumerable field the reducer hangs on its turns.
function claudeSnapshot(state: ClaudeSessionParserState): ClaudeSessionParserState {
  const copy = cloneParserState(state);
  copy.hidden = hiddenParserState(claudeHiddenSlots(copy), CLAUDE_HIDDEN_POLICY);
  return copy;
}

export function createClaudeSessionReducer(
  sessionId: string,
  opts: ReadOptions = {},
  restored?: ClaudeSessionParserState,
): ClaudeSessionReducer {
  const state = restored ? cloneParserState(restored) : emptyClaudeSessionParserState(opts);
  if (state.version !== 6) {
    throw new Error('Incompatible Claude parser state');
  }
  applyHiddenParserState(claudeHiddenSlots(state), state.hidden, CLAUDE_HIDDEN_POLICY);
  delete state.hidden;
  state.compactionMetadataRanges ??= state.compactions.map(() => null);
  state.compactionValueSources ??= state.compactions.map(() => ({ context: null, model: null }));
  state.lastContextSource ??= null;
  state.lastModelSource ??= null;
  state.currentModelSource ??= null;
  state.pendingTypedSkill ??= null;
  state.handbacks ??= new Map();
  state.handedBack ??= false;
  state.closingReply ??= null;
  state.repeatNotice ??= false;
  state.repeatReplyId ??= null;
  state.workedSinceReply ??= false;
  state.curCommand ??= null;
  state.curLocalAnswer ??= false;
  state.curCarried ??= null;
  return {
    pushLine: (line) => reduceClaudeSessionLine(state, line, sessionId, opts),
    trimBefore: (offset) => trimClaudeBefore(state, offset, opts.maxTurns ?? 40),
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
      refreshClaudeAgentFacts(completed.turns, opts.agentSpendOf, opts.agentSessionTargetOf);
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

export function refreshClaudeAgentFacts(
  turns: Turn[],
  lookup: AgentSpendLookup | undefined,
  targetOf: AgentSessionTargetLookup | undefined,
): void {
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
      if (!agent.effort) {
        agent.effort = spend.effort;
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
    }
  }
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

// A compaction's figures are written on a line of their own, a few milliseconds either
// side of the summary, so each is given to the nearest compaction. The window is wide
// enough to survive a slow write and far narrower than the gap between two compactions.
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

// A path an input named, or null where it named none this reader can read. A field of any
// other type is a shape this reader does not know, and turning it into text invents a path
// out of it, such as the one an object gives.
function editInputPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || isEphemeralPath(value)) {
    return null;
  }
  return value;
}

// The text an input field held, or null for a field of any other type. A missing field is
// empty text, which is what a call that supplies no before side or no content means. An
// array joined into text reads as one line that nobody wrote.
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

// The change one edit call asked for, or null for a call that changes no file this reader can
// read. Read from the input because a child's record holds no patch for any of these three
// tools. A count taken from an input is a floor on a file row, so an input whose lines a
// floor cannot describe yields a row with no counts at all.
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
    // `replace_all` runs the same replacement wherever it matches, and the input does not say
    // how many times that was. The lines of one application are a floor on the file, but a
    // row that carries them says every other application moved nothing, so the row says the
    // file changed and not by how much.
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
    // A Write carries the whole after side and nothing of the before side. Over a path that
    // already held those lines, the content's line count is a ceiling and not a floor, and
    // the input does not say whether the path existed. So the row says the file changed, and
    // it does not call the file new either.
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
    // An insert adds the cell it carries. A replace and a delete each need the cell as it
    // stood, which the input does not hold, so the row says the file changed and not by how
    // much.
    return String(input.edit_mode || 'replace') === 'insert'
      ? countedFileEdit(target, countLines(source), 0)
      : uncountedFileEdit(target, 'notebook');
  }
  return null;
}

// One file a child changed, from the call that changed it. It merges into the same map
// `recordEdit` fills, so a path an edit and a shell command both reached keeps one row. No
// edit record joins the row, because no patch exists to draw: the diff view already falls
// back for a row that carries none.
function recordEditFromCall(turn: Building, edit: PendingFileEdit): void {
  const key = normalizeFsPath(edit.path);
  const entry = turn.files.get(key) || { path: edit.path, added: 0, removed: 0, isNew: false, edits: [] };
  // The mark stays once any call on this path arrived without countable lines, whichever
  // order the calls came in. The lines the counted calls moved stay on the row beside it, so
  // the row's totals are a floor and the row says so. The cause follows the call that most
  // recently left the row uncounted, which is true of that call even where an earlier one on
  // the same path had a different cause.
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

// A child's evidence for one result, from the call's input and the result's own text. A
// Claude child transcript records no `toolUseResult`, so the files come from what an edit
// call asked for, and the commits come from what a shell call printed. That text is the
// command's own output, which is what `recordCommits` reads out of `stdout` elsewhere.
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
  // No commit window is supplied, so output that printed no commit line records no intent,
  // exactly as output whose own call a reader cannot place reads elsewhere.
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
  // A row's countsUnknown flag says the file carries zero real hunks. This one just gained
  // some, so the flag goes, whether an earlier shell record named this same file with none.
  delete entry.countsUnknown;
  delete entry.unknownReason;
  entry.added += added;
  entry.removed += removed;
  if (created) {
    entry.isNew = true;
  }
  // A whole-file diff can only start from the turn's first sight of the file, so the copy a
  // later edit records is of the file part-way through the turn and is never read. Dropping
  // it keeps a file edited many times in one turn from holding a copy per edit.
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

// A Bash result's own record of the files a shell command changed inside a git repository.
// Its hunks are the same shape `structuredPatch` writes, so they cross `patchHunks` unchanged,
// and its rows merge into the same map `recordEdit` fills, so a file touched by both an edit
// tool and a shell command in one turn keeps one row. The CLI caps `files` at five entries;
// every other changed path still appears in `changedFiles` and becomes a row with no counts.
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
    // Same rule as `recordEdit`: a row that just gained real hunks is never left marked as
    // carrying none, whichever record reached it first.
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
    // The rule that keeps both processing orders on one answer: a row carries countsUnknown
    // only while it holds zero real hunks. A file this turn already detailed, through an edit
    // tool or another shell record's own `files` entry, keeps its real counts here rather than
    // being downgraded back to unknown, so the row this candidate resolves to is the same
    // whether the detailed record or this unlisted mention was read first.
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

// A subagent launched in the background whose completion has not arrived yet.
export function agentIsRunning(agent: TurnAgent): boolean {
  return agent.status === 'running' || agent.status === 'async_launched';
}

// How long a burst of appends is gathered for before the panel reads again.
//
// Both CLIs append to the transcript as each message lands, which is what makes the file a
// live feed rather than a record written at the end. Measured on a running turn: seven
// writes in twenty-five seconds, arriving in pairs a few milliseconds apart. A fifth of a
// second folds a pair into one read and is still far below what a reader notices.
export const TRANSCRIPT_WAKE_MS = 200;

// The directories to watch for those appends, one entry per directory whatever it holds.
//
// Directories rather than files: a session started while the panel is open writes a
// file that did not exist when the watch was set up, and a per-file watch would never see
// it. Both agents keep a workspace's transcripts in a handful of directories, so this is a
// short list however many sessions it covers.
//
// Sorted, and with no duplicates, so two calls over the same sessions answer the same thing
// and the caller can tell whether the set has actually moved.
export function watchDirs(files: { file: string }[]): string[] {
  const dirs = new Set<string>();
  for (const one of files) {
    const dir = path.dirname(one.file);
    if (dir && dir !== '.') {
      dirs.add(dir);
    }
  }
  return [...dirs].sort();
}
