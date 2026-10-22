import { wholePercent } from './view/tokens.ts';
import type { ChildExpiryCost } from './childcacheexpiry';
import { outputRateText, type OutputRate, type OutputRateBasis } from './outputrate';
// Reduces turns to card headlines, status, figures, and control text.
// `turnview.ts` re-exports these projections for compatibility.

import { mayHaveUnrecordedEdits, TOOL_KIND as CODEX_TOOL_KIND } from './codex';
import { TOOL_KIND as CLAUDE_TOOL_KIND } from './transcript';
import type { SubagentContextFigure } from './subagentcontext';
import { FileIcon, iconFor } from './fileicons';
import {
  cacheExpiryExtraCost,
  publicProjectSpendPrice,
  type CacheExpiryCost,
  type CacheExpiryFacts,
  type CacheExpiryReturn,
  type CompactionFact,
  type SessionSpendPart,
  type SessionSpendCoverage,
  type SessionTurnStats,
} from './projectspend';
import {
  BEDROCK_LIST_COST_BASIS,
  CacheTier,
  CompactionEstimate,
  UsagePriceContext,
  cacheHitPercent,
  contextBandForRequest,
  contextWindowFor,
  compactionEstimate,
  estimateCacheReadCost,
  estimateCompactionCost,
  estimateCost,
  formatCost,
  hasRequestContextPricing,
  quoteUsage,
  recordedCostBasis,
  usesStandardPublicRate,
} from './pricing';
import {
  AgentKind,
  ClosingRows,
  Compaction,
  FileCountReason,
  NARRATION_DETAIL_LIMIT,
  SessionStatCompactionFacts,
  SessionStatTurnFacts,
  SKILL_STEP_KIND,
  SkillEvidence,
  STEP_CUT,
  STEP_DETAIL_LIMIT,
  ToolCounts,
  Turn,
  TurnAgent,
  TurnAnswer,
  TurnAsk,
  TurnCommit,
  TurnLanding,
  TurnSkillUse,
  TurnStep,
  TurnStepStatus,
  TurnUpdate,
  TurnOutcome,
  UsageInferenceClass,
  cleanPrompt,
  closingRows,
  firstLine,
  headlineSourceOf,
  headlineOf,
  type HeadlineSource,
  isInside,
  folderMatcher,
  normalizeFsPath,
  openingLines,
  responseAnswerIndex,
  sameCommitSha,
  shortenTo,
  type UsageOrigin,
} from './transcript';
import { formatClock, formatDuration, formatRelative, formatTokens, formatWhen, shortModel } from './turnformat';
import { turnKey } from './turnread';
import { addUsage, agentSpendIsOpen, emptyUsage, heaviestModel, spendTokens, type AgentSpend } from './agentspend';
import { childFileTotals, settleCounts, type ChildFileChange } from './childartifacts';
import { readableRichText, renderInlineMarkdown, visibleTextOf } from './richtext';
import type { WireActivity } from './agentwire';
import { CARD_ACTIONS, cacheWriteWarningCondition } from './view/card-words';
import { commitHeadFact, groupCommitRows, repositoryWorkLabel } from './view/card-presentation';
import {
  TURN_MENU_SECTIONS as SHARED_TURN_MENU_SECTIONS,
  turnMenuContext as sharedTurnMenuContext,
  turnMenuSection as sharedTurnMenuSection,
  type TurnMenuContext as SharedTurnMenuContext,
  type TurnMenuNode as SharedTurnMenuNode,
} from './view/card-menu.ts';
import { diffHalves, formatCacheHitDetail, type AgentFigureFacts, type CacheHitDetail } from './view/stat-detail.ts';
import { childrenOutliveTurn, type RailStatus } from './view/rail.ts';

// Card projections remain independent of the VS Code host.

export type TurnStatus = 'done' | 'failed' | 'interrupted' | 'running' | 'stopped';

export interface RelativeStatDetail {
  lead: string;
  at: number;
  title?: string;
  trail: string;
}

export interface StatDetailEntry {
  valueTitle?: string;
  label: string;
  value?: string | RelativeStatDetail;
  // Draws the value in the tone the panel gives work still moving, rather than as plain text.
  busyValue?: true;
  // Added and removed lines, drawn in their own tones beside the label rather than as text.
  diff?: { added: number; removed: number };
  lines?: StatDetailLine[];
  separateBefore?: boolean;
  warning?: boolean;
  // Draws the label as a muted group heading with no bullet, such as "Included above".
  group?: true;
}

export type StatDetailLine =
  | string
  | RelativeStatDetail
  | { text: string; title?: string; cost?: true; cacheHit?: CacheHitDetail; warning?: true; lines?: StatDetailLine[] };

// Lead with figures and keep scope beside the figure it limits. Separate changes of subject.
// Use label/value rows for figures and bullets for explanations. Put relevant caveats last.
// Omit absent facts and derive plain detail from the same list to preserve reading order.
export interface StatDetailList {
  // Record layouts read their rows from the card arrays with the same names.
  // The browser uses the card-body row components in popovers.
  // Entries supply plain-text hover content and accessible names.
  layout?: 'economics' | 'files' | 'agents' | 'dispatched' | 'commits';
  // Set when the popover contains an action.
  actions?: true;
  heading?: StatDetailEntry & { fact?: string };
  entries: StatDetailEntry[];
  // Lines that change how a figure reads: unpriced or incomplete usage, lower bounds, and count caveats.
  footer?: string[];
  // Standing explanations, drawn under a closed "About these figures" disclosure.
  notes?: string[];
}

export interface StatChip {
  kind: 'plain' | 'diff' | 'warn';
  // A card keeps this role stable while the chip's amount and detail change.
  metric?: string;
  label: string;
  detail: string; // the hover, which spells out what the number is made of
  detailList?: StatDetailList;
  added?: number;
  removed?: number;
  // Number of children with live-process evidence, also counted by the session list.
  // Dispatched figures count running dispatched rows.
  running?: number;
  // Accessible name for a diff chip, including file and line counts.
  // It replaces the visible punctuation and figures.
  name?: string;
  // Requests an explicit accessible name for a figure control.
  focusable?: true;
  // Detail announced through the card's existing roving control.
  headDetail?: true;
  // Context band and its accessible wording for the session heading.
  // Only context chips carry these fields. `kind` describes the chip shape.
  // See `CONTEXT_BANDS` for thresholds.
  level?: ContextLevel;
  word?: string;
  // Each warning draws the warning sign on the figure. A turn's cache expiry joins only at
  // `CACHE_EXPIRY_SIGN_DOLLARS` or more. Session figures carry cache-write warnings only.
  warnings?: (CacheWriteWarning | CacheExpiryWarning)[];
}

// A turn whose first request returned to an expired cache.
export interface CacheExpiryWarning {
  scope: 'cache-expiry';
  gapMs: number;
  // The cost added by that return, or null where it cannot be priced.
  dollars: number | null;
  status?: CacheExpiryCost['status'];
  children?: ChildExpiryCost;
  main?: { gapMs: number; dollars: number | null; status: CacheExpiryCost['status'] };
}

export type SessionMetric = 'cost' | 'turns' | 'context' | 'cache-expiry' | 'files' | 'commits';

export interface SessionStatChip extends StatChip {
  metric: SessionMetric;
  compactLabel: string;
  partialDetail?: string;
  // Unrounded cost estimate for sums across sessions.
  // Only cost chips carry it. Summing formatted labels would round twice.
  dollars?: number;
  // True when the cost estimate is a lower bound, displayed with `+`.
  // Any unpriced part makes an aggregate a lower bound.
  partial?: boolean;
}

// Expanded and folded cards display the same ordered figures.
export function foldedChips(chips: StatChip[]): StatChip[] {
  return chips;
}

// What a file row draws, in the body and in the Files chip popover alike.
//
// `path` is the path row actions use. Captured rows carry a project-relative path.
// `shownPath` is the same path in the spelling the panel reads out and hovers with.
export interface FileCard {
  name: string;
  lead?: string;
  label: string;
  icon: RowIcon;
  path: string;
  // Opaque captured identity distinguishes files with the same display path.
  identity?: string;
  shownPath: string;
  // Hover detail for a file changed by a subagent. Other rows use the path.
  detail?: string;
  added: number;
  removed: number;
  isNew: boolean;
  // Set when a shell command named this file without carrying its hunks. The row draws its
  // name with no counts and opens no diff, the same flag `TurnFileChange` carries.
  countsUnknown?: true;
}

export interface AgentFigure extends AgentFigureFacts {
  // Popover record for this figure, using the card's record layout.
  // Absent records leave a plain-text figure outside keyboard navigation.
  record?: StatDetailList;
}

// Subagent row with identity and state above its figures.
// Figures contain cost, commits, files, and duration.
// `hintDetail` contains tool uses for completed children.
export interface AgentCard {
  kind?: 'subagent' | 'dispatch';
  files?: FileCard[];
  commits?: CommitCard[];
  description: string;
  model: string | null;
  effort: string | null;
  figures: AgentFigure[];
  state: AgentState;
  // Empty for a finished child. Otherwise the state's own word, such as `running` or `stopped`.
  stateWord: string;
  // Child start time for elapsed duration when live-process evidence exists.
  since: number | null;
  hintDetail: string;
  sessionId: string | null;
}

// Running requires live-process evidence. Open means the record has no ending without current liveness evidence.
export type AgentState = 'done' | 'running' | 'open' | 'failed' | 'interrupted' | 'stopped';

export interface CommitCard {
  objectSha?: string;
  kind: 'commit' | 'landing';
  key: string;
  sha: string;
  subject: string;
  // Repository identity, display name, and open-folder membership. Null until Git resolves them.
  repository: { key: string; name: string; own: boolean } | null;
  branch: string | null;
  headKind: 'branch' | 'detached' | null;
  dir: string | null; // repository directory used when the commit opens in the editor
  // Location label for another repository or a worktree.
  // Grouped records display it in their headings. A single group displays it beside the count.
  where: string | null;
  detail: string; // the row's hover: the subject in full, its file count, and where it landed
  added: number | null;
  removed: number | null;
  at: number;
  // Full local time for hover and accessible text, refreshed on each clock tick.
  absolute: string;
  madeBy?: string;
  madeBySession: string | null; // the maker's own session, which the maker name opens
  mergedBranch?: string | null; // on a landing: the branch the merge brought in
  landingTarget?: string; // on a landing: the branch that moved
}

// File icon with a letter badge fallback.
// The host supplies theme artwork because icon theme lookup requires the editor.
export type RowIcon = FileIcon & {
  glyph?: { character: string; font: string; size: string; colour: string };
  image?: string; // a URI the panel can load the image from
};

// An earlier completed answer. The browser formats relative age with its shared clock.
// The host supplies rendered Markdown in `summaryHtml`.
export interface AnswerCard {
  summary: string; // the answer's markdown
  at: number;
  absolute: string; // the clock time, for the hover
  summaryHtml?: string;
}

// Mid-turn commentary or an earlier completed answer.
// Stable `id` keys preserve state when earlier messages arrive.
// The host renders `text` into `summaryHtml`.
// `when` contains fixed clock text. `absolute` contains full local time.
// `cardPrint` excludes clock-dependent `absolute` text.
// `answerIndex` preserves comment anchors into newest-first `earlierAnswers`.
export interface SaidCard {
  id: string;
  stepsBefore: number;
  kind: 'commentary' | 'answer';
  at: number;
  text: string;
  when: string; // the clock time, drawn on the meta line
  summaryHtml?: string;
  absolute: string; // the same moment in full, for the hover
  answerIndex?: number;
}

// A later prompt displayed in full under You asked.
export interface AskCard {
  text: string;
  when: string; // the clock time it was sent, drawn beside the label
  absolute: string; // the same moment in full, for the hover
  // The label over it, which says whether the transcript holds it yet.
  label: string;
}

// One thing the turn did, drawn as a line in the Activity section.
export interface ActivityRow {
  // Stable source identity lets a persisted row replace its live copy without a duplicate.
  sourceId?: string;
  // Activity kind distinguishes agent work from reader prompts in chronological order.
  kind: 'step' | 'ask' | 'commentary' | 'reasoning' | 'message' | 'run';
  id?: string;
  at?: number;
  messageKind?: SaidCard['kind'];
  text?: string;
  summaryHtml?: string;
  when?: string;
  absolute?: string;
  spoken?: string;
  answerIndex?: number;
  count?: number;
  failed?: number;
  earlier?: number;
  earlierLine?: string;
  mix?: string;
  label?: string;
  hint?: string;
  hintDetail?: string;
  inFlight?: boolean;
  steps?: ActivityRow[];
  status: TurnStepStatus;
  // Words preceding `code`, or the complete row when no literal is present.
  line: string;
  // Tool input displayed in code type, such as a command, path, pattern, or URL.
  code: string;
  // Trailing status text. Running steps use their elapsed clock instead.
  figure: string;
  // Start time for a running step's elapsed clock. Null after completion.
  since: number | null;
  // Full text for the native hover. Commands and narration can be longer than the bounded
  // line on the card, so the hover is the quiet path to the complete record.
  title: string;
  // Everything the focused row draws, with the exact subject in place of its preview.
  name?: string;
}

export interface ToolTallyRow {
  name: string;
  count: number;
  // Skill loads retain their own category and stay outside unrecognized tool calls.
  category: keyof ToolCounts | typeof SKILL_STEP_KIND;
}

export interface ActivityToolCategory {
  key: keyof ToolCounts;
  label: string;
  count: number;
}

// One skill a turn loaded, as the card draws it.
export interface ActivitySkill {
  name: string;
  // How many times the turn loaded this skill.
  count: number;
  description?: string;
  // The same description before it was cut to the row's length, for the row's hover.
  fullDescription?: string;
  // What the row opens, in the spelling the host acts on. Absent where no record named it.
  path?: string;
  // The same path in the spelling the panel reads out.
  shownPath?: string;
  evidence: SkillEvidence;
}

export interface TurnCard {
  promptId?: string;
  kind: 'turn';
  key: string;
  sessionId: string;
  status: TurnStatus;
  statusWord: string; // the status said as a word, for the glyph's hover
  relative: string; // relative start time, retained for the clock projection
  absolute: string; // "Aug 23 2:32 PM", the start time carried on the duration hover
  duration: string;
  durationWord: string; // the word in front of the duration, which the status decides
  durationDetail: string; // the start time revealed when the duration is hovered
  lastRelative: string; // when the turn last moved, drawn first on the card
  lastAbsolute: string; // the same moment as a clock time, carried on its hover
  label: string; // what the head row is announced by, since a glyph says nothing
  agent: string; // which agent recorded the turn, in words
  model: string | null;
  effort: string | null;
  headline: string;
  // Rendered inline Markdown for a summary-derived headline.
  // Error, running-prompt, and stock headlines remain plain text.
  headlineHtml?: string;
  prompt: string;
  delegation: string;
  promptHeading: string;
  promptNotice: string;
  summary: string;
  // Newest-first earlier answers, retained as indexes for comment anchors.
  earlierAnswers: AnswerCard[];
  // Every message the agent produced while the turn ran, oldest first.
  saidMessages: SaidCard[];
  saidName: string; // what the section's head is announced by
  saidMix: string; // the counts the shut head shows, without the title
  // What the reader typed while the turn ran, oldest first, drawn under the opening prompt.
  laterPrompts: AskCard[];
  sessionTitle: string | null;
  // File rows retain recorded paths for actions and formatted paths for display.
  files: FileCard[];
  fileCount: number;
  added: number;
  removed: number;
  // Every figure the card draws, in one order and in both card states.
  chips: StatChip[];
  marks: Mark[]; // what to scan the folded card by
  live: boolean; // the turn is still running, so its duration keeps counting
  // What the turn did, in order, for the Activity section an opened card draws.
  activity: ActivityRow[];
  // The true number of steps, which `activity` was cut from, and the words beside it.
  activityCount: number;
  activityWord: string;
  activityName: string;
  activityCounts: string[];
  activityTools: string;
  activityToolCategories: ActivityToolCategory[];
  // Distinct skills the turn loaded, in first-use order. Empty on a turn that loaded none.
  activitySkills: ActivitySkill[];
  // Total uses, which the heading button draws.
  activitySkillCount: number;
  // `1 skill` or `N skills`, which the button's visible text uses.
  activitySkillLabel: string;
  // Current activity on a folded running card. With no running tool step, it shows the latest commentary, including completed commentary.
  doing: string;
  // The literal half of that line, drawn in the code face the log's rows use.
  doingCode: string;
  doingSince: number | null;
  startedAt: number;
  endedAt: number;
  processEndedAt?: number;
  toolMix: string;
  toolTally: ToolTallyRow[];
  agents: AgentCard[];
  dispatched?: AgentCard[];
  commits: CommitCard[];
  errorText: string | null;
}

// Short agent names used on every card and session list row.
// Model identities are separate and remain absent when the source omits them.
export const AGENT_NAMES: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export { CARD_ACTIONS };

export interface Mark {
  id: string;
  character: string;
  word: string;
}

// Ordered marks with their glyphs and accessible words.
// Summary-declared marks precede marks derived from recorded work.
// The order places reader actions before turn status and file changes.
// Accessible names use `word` instead of the Unicode glyph name.
export const MARKS: Mark[] = [
  { id: 'needsYou', character: '\u{1F64B}', word: 'needs you' },
  { id: 'question', character: '❓', word: 'an open question' },
  { id: 'blocked', character: '⛔', word: 'blocked' },
  { id: 'caveat', character: '⚠', word: 'a caveat' },
  { id: 'unfinished', character: '\u{1F6A7}', word: 'unfinished' },
  { id: 'done', character: '✅', word: 'done' },
  { id: 'finding', character: '\u{1F50D}', word: 'a finding' },
  { id: 'proposal', character: '\u{1F4A1}', word: 'a proposal' },
  { id: 'gap', character: '\u{1F573}', word: 'a gap in what it recorded' },
  { id: 'commit', character: '\u{1F516}', word: 'committed' },
  { id: 'tests', character: '\u{1F9EA}', word: 'tests' },
  { id: 'docs', character: '\u{1F4C4}', word: 'docs' },
  { id: 'removal', character: '\u{1F53B}', word: 'more taken out than put in' },
  { id: 'agents', character: '\u{1F465}', word: 'subagents' },
  { id: 'context', character: '\u{1F4C8}', word: 'context filling up' },
];

// Lookup table keyed by bare mark characters. `markFor` removes variation selectors.
const MARK_BY_CHARACTER = new Map(MARKS.map((m) => [m.character, m]));

function markFor(character: string): Mark | undefined {
  return MARK_BY_CHARACTER.get(character.replace(/\uFE0F/g, ''));
}

// Leading pictographs, joiners, variation selectors, and skin tones form one removable symbol run.
const SYMBOL_RUN = /^[\p{Extended_Pictographic}\u200D\uFE0F\u{1F3FB}-\u{1F3FF}]+/u;

// Returns the first Unicode character when it names a known mark.
export function leadingSymbol(line: string): string | null {
  const codePoint = line.codePointAt(0);
  const first = codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
  return first && markFor(first) ? first : null;
}

// Removes a known leading mark and its joined sequence from a headline.
// Unknown symbols remain visible because no card mark replaces them.
export function withoutLeadingSymbol(line: string): string {
  if (!leadingSymbol(line)) {
    return line;
  }
  return line.replace(SYMBOL_RUN, '').trimStart();
}

// A path the reader reads rather than runs.
const DOC_PATH = /(^|[\\/])docs?[\\/]|\.mdx?$/i;

// A test file, by either of the two ways this repo and most others name one.
const TEST_PATH = /(^|[\\/])(tests?|specs?|__tests__)[\\/]|\.(test|spec)\./i;

// A removal mark requires removed lines to be at least twice added lines.
const REMOVAL_RATIO = 2;

// Reads declared mark IDs from the summary's opening list.
function declaredMarkIds(summary: string): string[] {
  const ids: string[] = [];
  for (const line of openingLines(summary)) {
    const symbol = leadingSymbol(line);
    const mark = symbol ? markFor(symbol) : undefined;
    // Unknown symbols remain visible in the headline and add no mark.
    if (mark) {
      ids.push(mark.id);
    }
  }
  return ids;
}

// Derives marks from recorded work. A docs mark does not require a docs-only turn.
function derivedMarkIds(turn: Turn, added: number, removed: number): string[] {
  const ids: string[] = [];
  // Mark a possible recording gap for Codex command activity without file rows. This does not establish that files changed.
  if (mayHaveUnrecordedEdits(turn)) {
    ids.push('gap');
  }
  if (turn.commits.length || turn.agents.some((agent) => (agent.commits?.length ?? 0) > 0)) {
    ids.push('commit');
  }
  if (turn.files.some((f) => TEST_PATH.test(f.path))) {
    ids.push('tests');
  }
  if (turn.files.some((f) => DOC_PATH.test(f.path))) {
    ids.push('docs');
  }
  if (removed && removed >= added * REMOVAL_RATIO) {
    ids.push('removal');
  }
  if (turn.agents.length) {
    ids.push('agents');
  }
  // Add the context mark from the first colored band onward.
  // The context chip carries the more specific band wording.
  const share = contextShare(turn);
  if (share !== null && bandForPercent(wholePercent(share))) {
    ids.push('context');
  }
  return ids;
}

// Reader actions and questions extracted from the summary's closing rows.
// These rows complement opening-list marks without duplicating the card's waiting mark.
export interface Waiting {
  needsYou: boolean; // the actions row carries something only the reader can do
  questions: boolean; // the questions row carries something waiting on an answer
  questionCount: number | null; // how many, when the row numbers them
}

// Empty-placeholder rows contribute no waiting state.
const NOTHING_IN_IT = /^(none|nothing|no|n\/a|not applicable|not blocked)\b/i;

function rowHasContent(row: string | null): boolean {
  const text = (row ?? '').trim();
  return text !== '' && !NOTHING_IN_IT.test(text);
}

// Counts a consecutive numbered run starting at one.
// A single marker or nonconsecutive run leaves the count unknown.
export function enumeratedCount(row: string): number | null {
  const numbers = [...row.matchAll(/\((\d+)\)/g)].map((m) => Number(m[1]));
  if (numbers.length < 2) {
    return null;
  }
  return numbers.every((n, i) => n === i + 1) ? numbers.length : null;
}

export function waitingOn(summary: string): Waiting {
  return waitingFrom(closingRows(summary));
}

// Reads waiting state from parsed closing rows shared with the card figures.
export function waitingFrom(rows: ClosingRows): Waiting {
  const questions = rowHasContent(rows.questions);
  return {
    needsYou: rowHasContent(rows.actions),
    questions,
    questionCount: questions ? enumeratedCount(rows.questions as string) : null,
  };
}

// Each applicable mark appears once, in table order.
function marksOf(turn: Turn, added: number, removed: number, waiting: Waiting): Mark[] {
  const closing: string[] = [];
  if (waiting.needsYou) {
    closing.push('needsYou');
  }
  if (waiting.questions) {
    closing.push('question');
  }
  const earned = new Set([...declaredMarkIds(turn.summary), ...closing, ...derivedMarkIds(turn, added, removed)]);
  return MARKS.filter((m) => earned.has(m.id));
}

// Nonrunning turn cards permit read state.
// Running turn keys remain stable as work arrives, so opening them cannot mark unseen work read.
// Compactions carry no read state.
export { canMarkRead } from './domain/read.ts';

// Native menu section names encode read-state and summary-copy availability.
// Cards without either capability carry no section.
// Card kind alone does not select the menu section.
export const TURN_MENU_SECTIONS = {
  ...SHARED_TURN_MENU_SECTIONS,
} as const;

export function turnMenuSection(
  card: { kind: string; live?: boolean; summary?: string },
  isRead: boolean,
): string | null {
  return sharedTurnMenuSection(card, isRead);
}

// Card node where the reader opened the native menu.
export type TurnMenuNode = SharedTurnMenuNode;

// Native menu context shared by a card's head and body.
// Both nodes carry the same turn identity and menu section.
// Comment availability is independent of summary-copy and read-state availability.
// The head suppresses editor menu entries. The response body retains native Copy.
// A descendant link supplies its own nearer context.
export function turnMenuContext(
  card: { kind: string; live?: boolean; summary?: string; key: string; sessionId: string },
  isRead: boolean,
  where: TurnMenuNode,
  hasComments: boolean,
): TurnMenuContext | null {
  return sharedTurnMenuContext(card, isRead, where, hasComments);
}

// Fields exposed to the editor's native menu conditions.
// `webviewSection` controls read and copy actions.
// `arcTurn` permits comments. `arcComments` permits copying existing comments.
// `session` and `key` identify the turn without parsing the key.
export type TurnMenuContext = SharedTurnMenuContext;

// Accessible words for the card's status glyph.
export const STATUS_WORDS: Record<TurnStatus, string> = {
  done: 'finished',
  failed: 'failed',
  interrupted: 'stopped by you',
  running: 'running',
  stopped: 'left unfinished',
};

// Combines status, figures, and headline into the head row's accessible name.
export function headLabel(kind: string, parts: (string | null)[], headline: string): string {
  return [kind, ...parts].filter(Boolean).join(', ') + '. ' + headline;
}

// Extends duplicate basenames with parent directories until names differ.
// The file row uses these names in accessible text.
export function distinctNames(paths: string[]): string[] {
  const parts = paths.map((p) => p.split(/[\\/]/).filter(Boolean));
  const depth = parts.map(() => 1);
  const nameAt = (i: number) => parts[i].slice(Math.max(0, parts[i].length - depth[i])).join('/');
  for (;;) {
    // Count collisions before extending any path in this round.
    const names = parts.map((_, i) => nameAt(i));
    const counts = new Map<string, number>();
    for (const name of names) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    let grew = false;
    for (let i = 0; i < parts.length; i++) {
      if ((counts.get(names[i]) ?? 0) > 1 && depth[i] < parts[i].length) {
        depth[i] += 1;
        grew = true;
      }
    }
    // Two rows for the same path cannot be told apart by their path, so this also ends.
    if (!grew) {
      return names;
    }
  }
}

// Formats paths with forward slashes for display and accessible text.
// Actions retain the recorded path separately.
export function withForwardSlashes(target: string): string {
  return target.replace(/\\/g, '/');
}

// Splits a display path into directory and filename at its last slash.
function splitPath(target: string): { lead: string; name: string } {
  const cut = target.lastIndexOf('/');
  const name = target.slice(cut + 1);
  return name ? { lead: target.slice(0, cut + 1), name } : { lead: '', name: target };
}

// File display name with an optional directory and accessible name.
// The browser preserves the filename while truncating the directory.
export interface FileRowName {
  name: string;
  lead?: string;
  spoken: string;
}

// Open-folder paths display basenames. Paths outside all open folders display their complete paths.
// With no open folders, every path displays its basename.
// Only basename rows participate in distinct-name calculation.
// Full-path rows announce their displayed paths. Display paths use forward slashes.
export function fileRowNames(paths: string[], folders: string[]): FileRowName[] {
  const inFolders = folderMatcher(folders);
  const byBaseName = paths.map((p) => folders.length === 0 || inFolders(p));
  const distinct = distinctNames(paths.filter((_, i) => byBaseName[i]));
  let next = 0;
  return paths.map((p, i) => {
    if (byBaseName[i]) {
      return { name: baseName(p), spoken: distinct[next++] };
    }
    const shown = withForwardSlashes(p);
    const { lead, name } = splitPath(shown);
    return lead ? { lead, name, spoken: shown } : { name, spoken: shown };
  });
}

// Maximum silence before an unfinished newest turn reads stopped.
// A later record restores running status if no terminal outcome exists.
export const TURN_QUIET_MS = 60 * 60 * 1000;

// Shared turn status for cards and session list rows, including quiet-time expiry.
export function statusOf(turn: Turn | TurnOutcome, isLatest: boolean, now: number = Date.now()): TurnStatus {
  if (turn.error) {
    return 'failed';
  }
  if (turn.finished) {
    return 'done';
  }
  if (turn.interrupted) {
    return 'interrupted';
  }
  if (turn.processEndedAt !== undefined) {
    return 'stopped';
  }
  if (!isLatest) {
    return 'stopped';
  }
  // An unreadable end timestamp retains running status instead of expiring against time zero.
  return turn.endedAt <= 0 || now - turn.endedAt <= TURN_QUIET_MS ? 'running' : 'stopped';
}

// Detects clock-driven status changes for the newest turn in each session.
// A nonpositive earlier clock means no previous status exists to compare.
export function statusMoved(turns: Iterable<Turn | TurnOutcome>, was: number, now: number): boolean {
  if (was <= 0) {
    return false;
  }
  for (const turn of turns) {
    if (statusOf(turn, true, was) !== statusOf(turn, true, now)) {
      return true;
    }
  }
  return false;
}

// Counts retained call categories while preserving step ordinals.
// Unknown categories count as `other`. Skill loads count in no tool category.
function countStepKind(counts: ToolCounts, kind: string | undefined): void {
  if (kind === SKILL_STEP_KIND) {
    return;
  }
  counts[kind !== undefined && Object.hasOwn(counts, kind) ? (kind as keyof ToolCounts) : 'other']++;
}

// Lists nonzero tool categories by descending call count.
export function toolCategoriesOf(counts: ToolCounts): ActivityToolCategory[] {
  const named: [keyof ToolCounts, string][] = [
    ['edits', 'edit'],
    ['commands', 'run'],
    ['reads', 'read'],
    ['searches', 'search'],
    ['agents', 'agent'],
    ['coordination', 'coordinate'],
    ['web', 'web'],
    ['other', 'other'],
  ];
  return named
    .filter(([key]) => counts[key] > 0)
    .sort((a, b) => counts[b[0]] - counts[a[0]])
    .map(([key, label]) => ({ key, label, count: counts[key] }));
}

export function toolMixOf(counts: ToolCounts): string {
  return toolCategoriesOf(counts)
    .map(({ count, label }) => `${count} ${label}`)
    .join(' · ');
}

// Groups skill uses by name in first-use order.
// Repeated loads increment the count and fill missing fields from the first available value.
// Recorded evidence takes precedence over best-effort evidence.
export function activitySkillsOf(uses: readonly TurnSkillUse[]): ActivitySkill[] {
  const rows = new Map<string, ActivitySkill>();
  for (const use of uses) {
    const held = rows.get(use.name);
    if (!held) {
      rows.set(use.name, {
        name: use.name,
        count: 1,
        evidence: use.evidence,
        ...(use.description ? { description: use.description } : {}),
        ...(use.fullDescription ? { fullDescription: use.fullDescription } : {}),
        ...(use.path ? { path: use.path, shownPath: withForwardSlashes(use.path) } : {}),
      });
      continue;
    }
    held.count++;
    if (!held.description && use.description) {
      held.description = use.description;
    }
    if (!held.fullDescription && use.fullDescription) {
      held.fullDescription = use.fullDescription;
    }
    if (!held.path && use.path) {
      held.path = use.path;
      held.shownPath = withForwardSlashes(use.path);
    }
    if (use.evidence === 'recorded' && held.evidence !== 'recorded') {
      held.evidence = use.evidence;
    }
  }
  return [...rows.values()];
}

// Names the model the child ran. The call can name only an alias such as `opus`, so the child's own
// heaviest model answers first. The spend total includes nested subagents, so its heaviest model
// answers only when neither the child nor the call names one.
function agentModel(agent: TurnAgent): string | null {
  return agent.ownModel ?? agent.model ?? heaviestModel(agent.spend);
}

// Maps recorded child status to a display state.
// Completed and done map to done. Unknown states map to stopped.
function agentRecordState(status: string): AgentState {
  if (agentSpendIsOpen(status)) {
    return 'running';
  }
  if (status === 'completed' || status === 'done') {
    return 'done';
  }
  if (status === 'failed' || status === 'errored' || status === 'error') {
    return 'failed';
  }
  if (status === 'interrupted') {
    return 'interrupted';
  }
  return 'stopped';
}

// Display words for child states. Finished children have no state word.
const AGENT_STATE_WORDS: Record<AgentState, string> = {
  done: '',
  running: 'running',
  open: 'no ending recorded',
  failed: 'failed',
  interrupted: 'interrupted',
  stopped: 'stopped',
};

const AGENT_COST_SO_FAR = 'Still running. This is the cost so far.';
const AGENT_USAGE_SO_FAR = 'Still running. This is the usage so far.';
// An open child has no recorded ending or current live-process evidence.
const AGENT_COST_NO_ENDING = 'This subagent recorded no ending. This is the cost Arc read.';
const AGENT_USAGE_NO_ENDING = 'This subagent recorded no ending. This is the usage Arc read.';
const AGENT_NO_COST_NO_ENDING = 'This subagent recorded no ending. No cost is recorded.';
const AGENT_NESTED_COST_SO_FAR = 'Some nested subagents are still running or left no record. This is the cost so far.';
// A Claude CLI run that Codex started reports its cost only in a complete result.
const AGENT_CLI_COST_MISSING = 'Claude CLI did not report the full cost of this run.';
// Cost note for a Codex child total that excludes nested subagents.
const AGENT_CODEX_NESTED_COST_MISSING = 'This cost leaves out the subagents that this subagent started.';
// Coverage notes do not form priced cost entries.
const COST_NOTES = new Set([
  AGENT_COST_SO_FAR,
  AGENT_COST_NO_ENDING,
  AGENT_NESTED_COST_SO_FAR,
  AGENT_CLI_COST_MISSING,
  AGENT_CODEX_NESTED_COST_MISSING,
]);
// What a partial record says about its own reach, on the figure that draws that record.
const AGENT_RECORD_CUT_SHORT = "This child session's record ended early, so this list holds only what Arc read.";

// Live-process evidence for the session and its children.
// Child IDs also include open children with records inside the quiet window.
export interface AgentLive {
  session: boolean;
  children: ReadonlySet<string>;
}

// Child live-process evidence takes precedence over recorded state.
// After a turn ends, launch states also use the session's live-process signal.
// Other unfinished children display open.
function agentState(agent: TurnAgent, turnRunning: boolean, sessionLive: AgentLive): AgentState {
  const recorded = agentRecordState(agent.status);
  if (agent.id && sessionLive.children.has(agent.id)) {
    return 'running';
  }
  if (recorded !== 'running' || turnRunning) {
    return recorded;
  }
  return sessionLive.session && (agent.status === 'async_launched' || agent.status === 'launched') ? 'running' : 'open';
}

// Flattens a cost line without nested breakdowns for hover text.
function hintDetailLine(line: StatDetailLine): string {
  if (typeof line === 'string') {
    return line;
  }
  return 'text' in line ? line.text : `${line.lead}${line.trail}`;
}

// Cost breakdown for a child figure, excluding its displayed total.
// Coverage-only blocks become standalone lines without headings. Compaction notes go to `notes`.
function agentCostEntries(
  agent: TurnAgent,
  runner: AgentKind,
  noEnding: boolean,
  notes: string[],
  row: TimedRow,
): StatDetailEntry[] {
  if (!agent.spend.length) {
    return [];
  }
  const entries: StatDetailEntry[] = [];
  for (const entry of childCostEntries(agent, true, 'Cost by usage', runner, noEnding, notes)) {
    const lines = entry.lines ?? [];
    if (!lines.length) {
      continue;
    }
    if (lines.every((line) => COST_NOTES.has(hintDetailLine(line)))) {
      entries.push(...lines.map((line) => ({ label: hintDetailLine(line) })));
      continue;
    }
    entries.push(entry);
  }
  // Include usage from every spend part, including unpriced parts.
  const total = emptyUsage();
  for (const spend of agent.spend) {
    addUsage(total, spend.usage);
  }
  const usage = usageDetailEntries(
    total,
    [],
    agent.outputRateModel ? agent.outputRate : undefined,
    runner,
    agent.outputRateModel,
    cacheDetailUsage(
      total,
      agent.spend.flatMap<Pick<SessionCostUsage, 'usage' | 'usageOrigin'>>((spend) =>
        spend.usageParts?.length ? spend.usageParts : [spend],
      ),
    ),
    agentRateBasis(runner),
    row,
  );
  if (usage.length) {
    entries.push({ ...usage[0], separateBefore: true }, ...usage.slice(1));
  }
  return entries;
}

// Plain-text commit record with subjects when available and hashes otherwise.
function agentCommitRecord(agent: TurnAgent, shas: readonly string[]): string[] {
  return agent.commits?.length ? agent.commits.map((commit) => `${commit.sha} ${commit.subject}`) : [...shas];
}

// Plain-text file record uses complete paths. Coverage caveats remain in the record footer.
function agentFileRecord(artifacts: NonNullable<TurnAgent['artifacts']>): string[] {
  if (!artifacts.files.length) {
    return [];
  }
  return artifacts.files.map((file) => file.path);
}

function agentDisplay(
  agent: TurnAgent,
  turnRunning: boolean,
  sessionLive: AgentLive,
): {
  hintDetail: string;
  state: AgentState;
  stateWord: string;
  summary: string;
  open: boolean;
} {
  const model = shortModel(agentModel(agent));
  const time = agent.durationMs != null ? formatDuration(agent.durationMs) : null;
  // Omit zero tool counts from the child's figures.
  const tools = agent.toolUses ? `${agent.toolUses} tools` : null;
  const usage: string[] = [];
  if (agent.spend.length) {
    const total = emptyUsage();
    for (const spend of agent.spend) {
      addUsage(total, spend.usage);
    }
    usage.push(...compactUsageParts(total));
  } else if (agent.tokens != null) {
    usage.push(formatTokens(agent.tokens));
  }
  const state = agentState(agent, turnRunning, sessionLive);
  const open = state === 'running' || state === 'open';
  // Finished children have no state word.
  const stateWord = AGENT_STATE_WORDS[state];
  const detail = [model, agent.effort, time, tools, ...usage];
  // Child hover text contains tool count and duration while open.
  // Cost, artifacts, and token breakdowns belong to their figure records.
  const figures = [open ? time : null, tools].filter(Boolean).join(' · ');
  return {
    hintDetail: figures,
    state,
    stateWord,
    summary: [...detail, stateWord].filter(Boolean).join(' · '),
    open,
  };
}

// Builds a figure's popover record and plain-text detail.
// Empty entries without a layout produce neither.
// `flat` supplies text for row layouts. `headingLabel` overrides only the popover heading.
// Partial records append a coverage footer.
function figureRecord(
  name: string,
  list: Omit<StatDetailList, 'heading'>,
  partial: boolean,
  flat?: string[],
  headingLabel: string = name,
): Pick<AgentFigure, 'record' | 'detail'> {
  if (!list.entries.length && !list.layout) {
    return {};
  }
  const record: StatDetailList = {
    heading: { label: headingLabel },
    ...list,
    ...(partial ? { footer: [...(list.footer ?? []), AGENT_RECORD_CUT_SHORT] } : {}),
  };
  return {
    record,
    detail: (flat ? [name, ...flat] : flatDetailList(record)).join('\n'),
  };
}

// A child cost record, with its compaction notes folded under the notes disclosure.
function costRecordList(
  agent: TurnAgent,
  partial: boolean,
  runner: AgentKind,
  noEnding: boolean,
  row: TimedRow,
): Omit<StatDetailList, 'heading'> {
  const notes: string[] = [];
  const entries = agentCostEntries(agent, runner, noEnding, notes, row);
  return notes.length ? { entries, notes } : { entries };
}

// A Claude child has no observed stream, so its own request records time it.
function agentRateBasis(runner: AgentKind): OutputRateBasis | undefined {
  return runner === 'claude' ? 'request' : undefined;
}

// Unpriced children display token usage as a separate figure.
// Priced children include that usage in their cost records.
function agentTokensFigure(
  agent: TurnAgent,
  priced: boolean,
  runner: AgentKind,
  row: TimedRow,
  running = false,
  noEnding = false,
): AgentFigure | null {
  if (priced) {
    return null;
  }
  // Omit zero token counts.
  const spent = agent.spend.length ? spendTokens(agent.spend) : 0;
  if (spent) {
    const total = emptyUsage();
    for (const spend of agent.spend) {
      addUsage(total, spend.usage);
    }
    const amount = formatTokens(spent);
    // A running child's tokens take the lower-bound mark and words of a partial cost.
    const name = running ? `At least ${amount} tokens` : `${amount} tokens`;
    return {
      metric: 'tokens',
      compactLabel: running ? `${amount}+ tokens` : name,
      name,
      ...figureRecord(
        name,
        {
          entries: usageDetailEntries(
            total,
            [],
            agent.outputRateModel ? agent.outputRate : undefined,
            runner,
            agent.outputRateModel,
            cacheDetailUsage(
              total,
              agent.spend.flatMap<Pick<SessionCostUsage, 'usage' | 'usageOrigin'>>((spend) =>
                spend.usageParts?.length ? spend.usageParts : [spend],
              ),
            ),
            agentRateBasis(runner),
            row,
          ),
          ...(running ? { footer: [noEnding ? AGENT_USAGE_NO_ENDING : AGENT_USAGE_SO_FAR] } : {}),
        },
        false,
      ),
    };
  }
  // The tokens a finished child's result reports. A running child has no result yet.
  if (running || !agent.tokens) {
    return null;
  }
  const name = `${formatTokens(agent.tokens)} tokens`;
  return { metric: 'tokens', compactLabel: name, name };
}

// Sort tool counts descending, with alphabetical names breaking ties.
function mostCalledFirst(one: { name: string; count: number }, other: { name: string; count: number }): number {
  return other.count - one.count || one.name.localeCompare(other.name);
}

// Counts by tool name, largest first, as `71 Bash`.
function countsByName(counts: Readonly<Record<string, number>>): string[] {
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort(mostCalledFirst)
    .map(({ name, count }) => `${count} ${name}`);
}

// Child run detail contains tool counts, failures, turn count, and local start and end times.
// Failed totals include unnamed tools. Only available facts appear.
function agentRunEntries(artifacts: NonNullable<TurnAgent['artifacts']>, now: number): StatDetailEntry[] {
  const entries: StatDetailEntry[] = [];
  if (artifacts.tools) {
    entries.push({ label: 'Calls by tool', lines: countsByName(artifacts.tools) });
  }
  if (artifacts.failed) {
    const named = countsByName(artifacts.failed.byTool);
    entries.push({
      label: 'Failed calls',
      value: String(artifacts.failed.count),
      ...(named.length ? { lines: named } : {}),
    });
  }
  // The span parts from the calls above it, the way the cost record parts its usage.
  const span = entries.length;
  if (artifacts.turnCount) {
    entries.push({ label: 'Turns', value: String(artifacts.turnCount) });
  }
  if (artifacts.startedAt) {
    entries.push({ label: 'Started', value: formatWhen(artifacts.startedAt, now) });
  }
  if (artifacts.endedAt) {
    entries.push({ label: 'Ended', value: formatWhen(artifacts.endedAt, now) });
  }
  if (span && entries[span]) {
    entries[span] = { ...entries[span], separateBefore: true };
  }
  return entries;
}

// Flattens run entries without duplicating the record's coverage footer.
function agentRunFlat(entries: StatDetailEntry[]): string[] {
  return entries.length
    ? ['', ...entries.flatMap((entry) => [...(entry.separateBefore ? [''] : []), ...flatDetailEntry(entry)])]
    : [];
}

// Nonzero child duration with run detail when artifact records are available.
function agentDurationFigure(agent: TurnAgent, now: number): AgentFigure | null {
  if (!agent.durationMs) {
    return null;
  }
  const label = formatDuration(agent.durationMs);
  const name = `Ran for ${label}`;
  const artifacts = agent.artifacts;
  const entries = artifacts ? agentRunEntries(artifacts, now) : [];
  return {
    metric: 'duration',
    compactLabel: label,
    name,
    ...(artifacts ? figureRecord(name, { entries }, !artifacts.complete, agentRunFlat(entries)) : {}),
  };
}

// Indexes recorded card paths by normalized filesystem identity for child-row filtering.
export function fileRowPathsByKey(files: readonly { path: string; identity?: string }[]): Map<string, string> {
  const keyed = new Map<string, string>();
  for (const file of files) {
    keyed.set(file.identity ?? normalizeFsPath(file.path), file.path);
  }
  return keyed;
}

function agentFigures(
  agent: TurnAgent,
  state: AgentState,
  rowPaths: ReadonlyMap<string, string>,
  now: number,
  runner: AgentKind,
  row: TimedRow,
): AgentFigure[] {
  const figures: AgentFigure[] = [];
  const priced = spendCost(agent);
  const cost = formatCost(priced.dollars);
  // Running and open children display lower-bound cost or tokens, without commit or file figures.
  const running = state === 'running' || state === 'open';
  // Open-child coverage wording states the missing ending without asserting live work.
  const noEnding = state === 'open';
  if (cost) {
    const partial = priced.partial || running;
    // The spoken name says what the money is, because the face carries the amount alone.
    const name = `${partial ? `At least ${cost}` : cost} spent`;
    figures.push({
      metric: 'cost',
      compactLabel: `${cost}${partial ? '+' : ''}`,
      name,
      ...figureRecord(name, costRecordList(agent, partial, runner, noEnding, row), false),
    });
  }
  if (running) {
    const tokens = agentTokensFigure(agent, !!cost, runner, row, true, noEnding);
    return tokens ? [...figures, tokens] : figures;
  }
  const ran = agentDurationFigure(agent, now);
  if (ran) {
    figures.push(ran);
  }
  const artifacts = agent.artifacts;
  const partial = !!artifacts && !artifacts.complete;
  // Omit zero commit counts.
  if (artifacts?.commits.length) {
    const commits = `${artifacts.commits.length} commit${artifacts.commits.length === 1 ? '' : 's'}`;
    // The accessible name includes made. The popover heading carries the count alone.
    const headingLabel = partial ? `At least ${commits}` : commits;
    const name = `${headingLabel} made`;
    figures.push({
      metric: 'commits',
      compactLabel: `${artifacts.commits.length}${partial ? '+' : ''} commit${artifacts.commits.length === 1 ? '' : 's'}`,
      name,
      shas: [...artifacts.commits],
      ...figureRecord(
        name,
        { layout: 'commits', actions: true, entries: [] },
        partial,
        agentCommitRecord(agent, artifacts.commits),
        headingLabel,
      ),
    });
  }
  if (artifacts?.files.length) {
    const totals = childFileTotals(artifacts.files);
    const files = filesAndLines(artifacts.files.length, totals.added, totals.removed, '');
    const caveats = fileCountCaveats(artifacts.files);
    const fileIdentities = artifacts.files.flatMap((file) => (file.identity ? [file.identity] : []));
    const fileLabel = partial ? files.label.replace(' ', '+ ') : files.label;
    const name = files.name ? (partial ? `At least ${files.name}` : files.name) : fileLabel;
    // Give the file-record action an accessible name even when its diff counts are absent.
    figures.push({
      metric: 'files',
      compactLabel: fileLabel,
      name,
      added: files.added,
      removed: files.removed,
      // Match card-row spelling for subagents and child-row spelling for dispatched sessions.
      paths: artifacts.files.map((file) => rowPaths.get(file.identity ?? normalizeFsPath(file.path)) ?? file.path),
      ...(fileIdentities.length ? { fileIdentities } : {}),
      // File-count caveats appear in the record footer, separate from the figure name.
      ...figureRecord(
        name,
        { layout: 'files', actions: true, entries: [], ...(caveats.length ? { footer: caveats } : {}) },
        partial,
        agentFileRecord(artifacts),
      ),
    });
  }
  const tokens = agentTokensFigure(agent, !!cost, runner, row);
  if (tokens) {
    figures.push(tokens);
  }
  return figures;
}

function agentCard(
  agent: TurnAgent,
  turnRunning: boolean,
  sessionLive: AgentLive,
  launches: ReadonlyMap<string, AgentLaunch>,
  rowPaths: ReadonlyMap<string, string>,
  now: number,
  runner: AgentKind = 'claude',
  row: TimedRow = 'subagent',
): AgentCard {
  const display = agentDisplay(agent, turnRunning, sessionLive);
  // Only a child with live-process evidence counts up. An open child draws no time.
  const launch = display.state === 'running' && agent.toolUseId ? launches.get(agent.toolUseId) : undefined;
  return {
    description: agent.description,
    model: shortModel(agentModel(agent)),
    effort: agent.effort,
    figures: agentFigures(agent, display.state, rowPaths, now, runner, row),
    state: display.state,
    stateWord: display.stateWord,
    since: display.state === 'running' ? agent.startedAt || launch?.step.at || null : null,
    hintDetail: display.hintDetail,
    sessionId: agent.childSessionId ?? null,
  };
}

// Maps session-list activity states to running, including subagents, background commands, and waiting for input.
export function dispatchedState(status: RailStatus | undefined): AgentState {
  switch (status) {
    case 'running':
    case 'subagents':
    case 'background':
    case 'waiting':
      return 'running';
    case 'failed':
    case 'interrupted':
    case 'done':
      return status;
    default:
      return 'stopped';
  }
}

// Counts dispatched rows and their running states independently of the parent turn's state.
export function dispatchedChip(rows: readonly AgentCard[]): StatChip {
  const running = rows.filter((row) => row.state === 'running').length;
  return {
    kind: 'plain',
    metric: 'dispatched',
    label: `${rows.length} dispatched`,
    ...(running > 0 ? { running } : {}),
    detail: rows.map((row) => row.description).join('\n'),
    detailList: {
      layout: 'dispatched',
      actions: true,
      heading: {
        label: `${rows.length} dispatched session${rows.length === 1 ? '' : 's'}`,
        ...(running > 0 ? { value: `${running} running`, busyValue: true as const } : {}),
      },
      entries: rows.map((row) => ({ label: row.description })),
    },
  };
}

export function dispatchedAgentCard(
  sessionId: string,
  description: string,
  spend: AgentSpend,
  state: AgentState,
  startedAt: number | null,
  endedAt: number | null,
  toolUses: number,
  folders: string[] = [],
  now: number = Date.now(),
  runner: AgentKind = 'claude',
  row: TimedRow = 'dispatched',
): AgentCard {
  const agent: TurnAgent = {
    id: sessionId,
    childSessionId: sessionId,
    description,
    agentType: null,
    model: null,
    ...(spend.ownModel ? { ownModel: spend.ownModel } : {}),
    effort: spend.effort,
    spend: spend.models,
    spendFound: spend.found,
    spendPartial: spend.partial,
    spendUnfinished: spend.unfinished,
    ...(spend.outputRate && spend.outputRateModel
      ? { outputRate: spend.outputRate, outputRateModel: spend.outputRateModel }
      : {}),
    commits: spend.commits,
    artifacts: spend.artifacts,
    durationMs: state === 'running' || startedAt === null || endedAt === null ? null : Math.max(0, endedAt - startedAt),
    tokens: null,
    toolUses,
    status: state === 'done' ? 'completed' : state === 'open' ? 'async_launched' : state,
  };
  const live = { session: false, children: state === 'running' ? new Set([sessionId]) : new Set<string>() };
  const files = state === 'running' ? [] : fileCardsOf(spend.artifacts?.files ?? [], folders);
  const commits = state === 'running' ? [] : (spend.commits ?? []).map((commit) => commitCard(commit, now));
  const card = agentCard(
    agent,
    false,
    live,
    new Map(),
    fileRowPathsByKey(spend.artifacts?.files ?? []),
    now,
    runner,
    row,
  );
  return { ...card, kind: 'dispatch', files, commits, since: state === 'running' ? startedAt : null };
}

// Pairs a child with its launch step by call ID for Activity and child-row projections.
interface AgentLaunch {
  step: TurnStep;
  agent: TurnAgent;
}

function agentLaunches(turn: Turn): Map<string, AgentLaunch> {
  const agents = new Map<string, TurnAgent>();
  for (const agent of turn.agents) {
    if (agent.toolUseId) {
      agents.set(agent.toolUseId, agent);
    }
  }
  const launches = new Map<string, AgentLaunch>();
  for (const step of turn.steps) {
    const agent = (step.name === 'Agent' || step.name === 'spawn_agent') && step.id ? agents.get(step.id) : undefined;
    if (agent) {
      launches.set(step.id!, { step, agent });
    }
  }
  return launches;
}

function agentOutcome(agent: TurnAgent): string {
  const parts: string[] = [];
  const model = shortModel(agentModel(agent));
  if (model) {
    parts.push(model);
  }
  if (agent.effort) {
    parts.push(agent.effort);
  }
  if (agent.durationMs != null) {
    parts.push(formatDuration(agent.durationMs));
  }
  if (agent.toolUses) {
    parts.push(`${agent.toolUses} tools`);
  }
  if (agent.tokens != null) {
    parts.push(formatTokens(agent.tokens));
  }
  return parts.join(' \u00b7 ');
}

// File-row hover and accessible text identify the subagent that changed the file.
const FILE_CHANGED_BY = (madeBy: string): string => `changed by ${madeBy}`;

// What the group heading and the hover say for a commit whose repository cannot be named. The
// heading draws the short words, and the hover carries the reason.
const COMMIT_ELSEWHERE = 'in another repository';

const COMMIT_ELSEWHERE_DETAIL =
  'In another repository. The call committed to more than one, so which one cannot be said.';

// Location label for a linked worktree. A matching branch name suppresses this label.
const COMMIT_WORKTREE = (dir: string): string => `in worktree ${baseName(dir)}`;

// Location label for the main checkout when the open folder is a linked worktree.
const COMMIT_MAINTREE = 'in the main tree';

// Projects a commit with repository, branch, line counts, and hover detail.
// A separate `absolute` field lets clock updates leave content detail unchanged.
// Other repositories include complete paths in the hover. Worktrees retain this repository's identity.
// Ambiguous external repositories use an unnamed location. Display paths use forward slashes.
export function commitCard(
  commit: TurnCommit,
  now: number = Date.now(),
  madeBy: string | null = null,
  madeBySession: string | null = null,
  folders: readonly string[] = [],
): CommitCard {
  const files = commit.files == null ? null : `${commit.files} ${commit.files === 1 ? 'file' : 'files'} changed`;
  const place = commit.place;
  const head = commit.head ?? null;
  const where =
    place === null
      ? null
      : place.kind === 'named'
        ? `in ${baseName(place.dir)}`
        : place.kind === 'worktree'
          ? head?.kind === 'branch' && head.name === baseName(place.dir)
            ? null
            : COMMIT_WORKTREE(place.dir)
          : place.kind === 'maintree'
            ? COMMIT_MAINTREE
            : place.kind === 'unnamed'
              ? COMMIT_ELSEWHERE
              : null;
  const landed =
    place === null
      ? null
      : place.kind === 'named'
        ? `in ${withForwardSlashes(place.dir)}`
        : place.kind === 'unnamed'
          ? COMMIT_ELSEWHERE_DETAIL
          : null;
  const absolute = formatWhen(commit.at, now);
  return {
    kind: 'commit',
    key: `commit:${(commit.printedSha ?? commit.sha).toLowerCase()}`,
    sha: commit.sha,
    ...(commit.printedSha ? { objectSha: commit.printedSha } : {}),
    subject: commit.subject,
    repository: repositoryView(commit, folders),
    branch: head?.kind === 'branch' ? head.name : null,
    headKind: head?.kind ?? null,
    dir: commit.dir,
    where,
    detail: [commit.subject, files, landed].filter(Boolean).join('\n'),
    added: commit.added,
    removed: commit.removed,
    at: commit.at,
    absolute,
    ...(madeBy ? { madeBy } : {}),
    madeBySession: madeBy ? madeBySession : null,
  };
}

// Repository display identity for a commit group.
// Nested repositories use their path below an open folder. Others use their folder name.
function repositoryView(
  commit: Pick<TurnCommit, 'place' | 'repository'>,
  folders: readonly string[],
): CommitCard['repository'] {
  const repository = commit.repository;
  if (!repository) {
    return null;
  }
  const own = repository.own;
  const root = withForwardSlashes(repository.root).replace(/\/+$/, '');
  const folder = folders
    .map((one) => withForwardSlashes(one).replace(/\/+$/, ''))
    .find((one) => normalizeFsPath(one) !== normalizeFsPath(root) && isInside(root, [one]));
  const name = folder ? root.slice(folder.length + 1) : baseName(root);
  return { key: repository.key, name, own };
}

// File change with optional child attribution.
// `countsUnknown` has no line count. `countsPartial` retains a lower bound after mixed counted and uncounted edits.
interface AttributedFile extends ChildFileChange {
  madeBy?: string;
}

// Combines parent and child file edits by normalized path and sums counted lines.
// A file keeps child attribution only when one child owns all recorded changes.
function attributedFiles(turn: Turn): AttributedFile[] {
  const rows: AttributedFile[] = turn.files.map((file) => {
    const row: AttributedFile = {
      path: file.path,
      ...(file.identity ? { identity: file.identity } : {}),
      added: file.added,
      removed: file.removed,
      isNew: file.isNew,
      ...(file.countsUnknown ? { countsUnknown: file.countsUnknown } : {}),
      ...(file.unknownReason ? { unknownReason: file.unknownReason } : {}),
    };
    // Preserve counted edits when another record leaves the same path uncounted.
    settleCounts(row);
    return row;
  });
  const at = new Map<string, number>();
  rows.forEach((row, index) => {
    at.set(row.identity ?? normalizeFsPath(row.path), index);
  });
  for (const agent of turn.agents) {
    for (const file of agent.artifacts?.files ?? []) {
      const key = file.identity ?? normalizeFsPath(file.path);
      const index = at.get(key);
      if (index === undefined) {
        at.set(key, rows.length);
        rows.push({ ...file, ...(agent.description ? { madeBy: agent.description } : {}) });
        settleCounts(rows[rows.length - 1]);
        continue;
      }
      const held = rows[index];
      held.added += file.added;
      held.removed += file.removed;
      if (file.isNew) {
        held.isNew = true;
      }
      if (file.countsUnknown) {
        held.countsUnknown = true;
      }
      if (file.countsPartial) {
        held.countsPartial = true;
      }
      // The latest recorded unknown-count reason replaces the held reason.
      if (file.unknownReason) {
        held.unknownReason = file.unknownReason;
      }
      if (held.madeBy !== agent.description) {
        delete held.madeBy;
      }
      settleCounts(held);
    }
  }
  return rows;
}

function fileCardsOf(files: readonly AttributedFile[], folders: string[]): FileCard[] {
  const names = fileRowNames(
    files.map((file) => file.path),
    folders,
  );
  return files.map((file, index) => ({
    name: names[index].name,
    lead: names[index].lead,
    label: `File ${names[index].spoken}${file.isNew ? ', new' : ''}${file.madeBy ? `, ${FILE_CHANGED_BY(file.madeBy)}` : ''}`,
    icon: iconFor(file.path),
    path: file.path,
    ...(file.identity ? { identity: file.identity } : {}),
    shownPath: withForwardSlashes(file.path),
    ...(file.madeBy ? { detail: `${withForwardSlashes(file.path)}\n${FILE_CHANGED_BY(file.madeBy)}` } : {}),
    added: file.added,
    removed: file.removed,
    isNew: file.isNew,
    ...(file.countsUnknown ? { countsUnknown: file.countsUnknown } : {}),
  }));
}

function attributedCommits(
  turn: Turn,
): Array<{ commit: TurnCommit; madeBy: string | null; madeBySession: string | null }> {
  const commits = turn.commits.map((commit) => ({
    commit,
    madeBy: null as string | null,
    madeBySession: null as string | null,
  }));
  for (const agent of turn.agents) {
    for (const commit of agent.commits ?? []) {
      const existing = commits.findIndex((held) =>
        sameCommitSha(held.commit.printedSha ?? held.commit.sha, commit.printedSha ?? commit.sha),
      );
      const attributed = { commit, madeBy: agent.description, madeBySession: agent.childSessionId ?? null };
      if (existing < 0) {
        commits.push(attributed);
      } else {
        commits[existing] = attributed;
      }
    }
  }
  return commits;
}

// Projects a fast-forward landing into the shared commit-row shape.
// `groupCommitRows` places it on a matching branch heading or under the target branch.
// Counts remain absent. Its timestamp records the landing rather than the commit.
export function landingCard(
  landing: TurnLanding,
  folders: readonly string[] = [],
  now: number = Date.now(),
): CommitCard {
  const head = landing.head ?? null;
  const target = head?.kind === 'branch' ? head.name : 'detached HEAD';
  const row = commitCard(
    {
      sha: landing.sha,
      subject: landing.subject,
      head,
      files: null,
      added: null,
      removed: null,
      at: landing.at,
      place: landing.place,
      dir: landing.dir,
      repository: landing.repository ?? null,
    },
    now,
    null,
    null,
    folders,
  );
  return {
    ...row,
    kind: 'landing',
    key: `landing:${landing.id}`,
    mergedBranch: landing.mergedBranch ?? null,
    landingTarget: target,
  };
}

function detailedTokens(tokens: number): string {
  return tokens < 10_000 ? Math.round(tokens).toLocaleString('en-US') : formatTokens(tokens);
}

function inputTokenCategoryLines(usage: Turn['usage'], cacheUsage = usage): string[] {
  const out: string[] = [];
  const hit = cacheHitPercent(cacheUsage);
  if (usage.cacheRead) {
    out.push(
      `Cached input reads: ${detailedTokens(usage.cacheRead)} tokens${hit == null ? '' : ` (${hit}% of input)`}`,
    );
  }
  if (usage.input) {
    out.push(`Uncached input: ${detailedTokens(usage.input)} tokens`);
  }
  if (usage.cacheWrite1h) {
    out.push(`1-hour cache writes: ${detailedTokens(usage.cacheWrite1h)} tokens`);
  }
  if (usage.cacheWrite5m) {
    out.push(`5-minute cache writes: ${detailedTokens(usage.cacheWrite5m)} tokens`);
  }
  if (usage.cacheWrite30m) {
    out.push(`30-minute cache writes: ${detailedTokens(usage.cacheWrite30m)} tokens`);
  }
  return out;
}

function compactUsageParts(usage: Turn['usage']): string[] {
  const parts: string[] = [];
  const requests = usage.requests ?? 0;
  if (requests) {
    parts.push(`${requests} request${requests === 1 ? '' : 's'}`);
  }
  const input = inputSideTokens(usage);
  if (input) {
    parts.push(`${formatTokens(input)} in`);
  }
  if (usage.output) {
    parts.push(`${formatTokens(usage.output)} out`);
  }
  return parts;
}

// The kind of row the speed tooltip names. An exported reader-started row is named a session.
export type TimedRow = 'subagent' | 'dispatched' | 'session';
const TIMED_ROW_NAMES: Record<TimedRow, string> = {
  subagent: 'subagent',
  dispatched: 'dispatched session',
  session: 'session',
};

// Shared usage breakdown for turn token figures and child cost records.
function usageDetailEntries(
  u: Turn['usage'],
  lead: StatDetailEntry[] = [],
  measurement?: OutputRate,
  provider: AgentKind = 'claude',
  measuredModel?: string,
  cacheUsage = u,
  basis: OutputRateBasis = 'stream',
  row: TimedRow = 'subagent',
): StatDetailEntry[] {
  const entries: StatDetailEntry[] = [...lead];
  const input = inputSideTokens(u);
  if (input) {
    entries.push({ label: 'Input', value: `${detailedTokens(input)} tokens` });
  }
  if (u.output) {
    const rate = outputRateText(measurement);
    const title =
      provider === 'claude'
        ? basis === 'request'
          ? 'Output tokens per second. Actual output includes thinking. Request time includes the wait for the first response event. Untimed responses are excluded.'
          : 'Output tokens per second. Actual output includes thinking. Observed response time excludes untimed responses.'
        : 'Output tokens per second. Actual output includes reasoning. Request time includes preparation and hooks. Blocking local tool waits and untimed responses are excluded.';
    const lines: StatDetailLine[] = rate
      ? [
          {
            text: rate,
            title: `${rate}. ${title}${measuredModel ? ` Measured model: ${measuredModel}. Only this ${TIMED_ROW_NAMES[row]} is timed. Usage totals include any delegated work.` : ''}`,
          },
        ]
      : [];
    if (u.thinking)
      lines.push(
        `Thinking: ${detailedTokens(u.thinking)} tokens (${Math.round((u.thinking / u.output) * 100)}% of output), included in output`,
      );
    entries.push({
      label: 'Output',
      value: `${detailedTokens(u.output)} tokens`,
      ...(lines.length ? { lines } : {}),
    });
  }
  const requests = u.requests ?? 0;
  const average = averageContextPerRequest(cacheUsage);
  if (requests) {
    entries.push({
      label: 'Model requests',
      value: String(requests),
      ...(requests > 1 && average !== null && average > 0
        ? { lines: [`Average input per request: ${detailedTokens(average)} tokens`] }
        : {}),
    });
  }
  const breakdown = inputTokenCategoryLines(u, cacheUsage);
  if (breakdown.length) {
    entries.push({ label: 'Input breakdown', separateBefore: true, lines: breakdown });
  }
  return entries;
}

function cacheDetailUsage(
  total: Turn['usage'],
  parts: readonly Pick<SessionCostUsage, 'usage' | 'usageOrigin' | 'compactionEstimate' | 'compactionUsage'>[],
): Turn['usage'] {
  if (!parts.length) return total;
  const usage = emptyUsage();
  for (const part of parts) {
    if (!part.usageOrigin && !part.compactionEstimate && !part.compactionUsage) addUsage(usage, part.usage);
  }
  return usage;
}

// Token detail includes main-agent usage alone when the turn has children.
function tokenDetailList(turn: Turn): StatDetailList {
  const entries = usageDetailEntries(
    turn.usage,
    turn.agents.length ? [{ label: 'Main agent only' }] : [],
    turn.interrupted ? undefined : turn.outputRate,
    turn.agent,
    undefined,
    cacheDetailUsage(turn.usage, turn.usageParts ?? []),
    turn.outputRateBasis,
  );
  return { entries };
}

export function tokenLines(turn: Turn): string[] {
  return flatDetailList(tokenDetailList(turn));
}

export function agentTokensOf(turn: Turn): number {
  return turn.agents.reduce(
    (total, agent) => total + (agent.spend.length ? spendTokens(agent.spend) : (agent.tokens ?? 0)),
    0,
  );
}

export interface SessionCostTotal {
  dollars: number | null;
  partial: boolean;
}

function spendCost(agent: TurnAgent): SessionCostTotal {
  let dollars = 0;
  let priced = false;
  let partial =
    !agent.spendFound ||
    agent.spendPartial ||
    Boolean(agent.spendUnfinished) ||
    Boolean(agent.spendIncomplete) ||
    agentSpendIsOpen(agent.status) ||
    (!agent.spend.length && (agent.tokens ?? 0) > 0);
  for (const part of agent.spend) {
    if (part.usageParts?.length && !(recordedCostBasis(part.costBasis) && part.recordedCost !== undefined)) {
      const exact = sessionCostTotalOf(
        part.usageParts.map((usagePart) =>
          priceSessionCost({
            agent: null,
            role: 'delegated',
            ...usagePart,
          }),
        ),
      );
      if (exact.dollars !== null) {
        dollars += exact.dollars;
        priced = true;
      }
      partial ||= exact.partial;
      continue;
    }
    const recordedListCost = recordedCostBasis(part.costBasis) ? part.recordedCost : undefined;
    const cost =
      recordedListCost ?? estimateCost(part.usage, part.model, part.provider ?? null, part.contextWindow ?? null);
    if (cost === null) {
      partial = true;
      continue;
    }
    dollars += cost;
    priced = true;
    if (recordedListCost === undefined && (part.unclassifiedCacheWrite ?? 0) > 0) {
      partial = true;
    }
  }
  return { dollars: priced ? dollars : null, partial };
}

// Prices the turn and its subagents. Unknown coverage makes the priced subtotal a lower bound.
export function turnCost(turn: Turn): SessionCostTotal {
  const hasExactOwn = Boolean(turn.usageParts?.length);
  const exactOwn = hasExactOwn
    ? sessionCostTotalOf(turn.usageParts!.map((part) => priceSessionCost({ agent: turn.agent, role: 'main', ...part })))
    : null;
  const own = hasExactOwn
    ? exactOwn!.dollars
    : estimateCost(turn.usage, turn.model, turn.provider ?? null, turn.contextWindow);
  let dollars = own ?? 0;
  let priced = own !== null;
  let partial = exactOwn?.partial ?? (own === null && spentTokens(turn.usage));
  for (const agent of turn.agents) {
    const cost = spendCost(agent);
    if (cost.dollars !== null) {
      dollars += cost.dollars;
      priced = true;
    }
    if (cost.partial) {
      partial = true;
    }
  }
  return { dollars: priced ? dollars : null, partial };
}

// A dispatched session's lifetime usage, with the parts of its own primary transcript marked.
export interface DispatchedCostUsage extends SessionCostUsage {
  own?: true;
}

// A dispatched session's usage part with its price.
export type PricedDispatchedCost = PricedSessionCost & { part: DispatchedCostUsage };

// Prices dispatched usage parts for cached figure reads.
export function priceDispatchedParts(parts: readonly DispatchedCostUsage[]): PricedDispatchedCost[] {
  return parts.map((part) => priceSessionCost(part) as PricedDispatchedCost);
}

// Dispatched session contribution and coverage state.
// `ownSettledAt` holds its newest turn start after its primary group settles and leaves the ledger.
export interface DispatchedSessionCost {
  costs: readonly PricedDispatchedCost[];
  short: boolean;
  ownSettledAt: number | null;
}

// A dispatched session a turn card counts in its cost, with the name its Dispatched row shows
// or would show.
export interface DispatchedTurnCost extends DispatchedSessionCost {
  sessionId: string;
  name: string;
}

// The contribution and discovery state that a drawn card used for its dispatched cost.
export function dispatchedCostPrint(
  costs: readonly DispatchedTurnCost[],
  hydrated: boolean,
  discoveryPending: boolean,
): string {
  return JSON.stringify([costs, hydrated, discoveryPending]);
}

export function movedDispatchedCards(
  drawn: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string[] {
  return [...current].filter(([key, print]) => drawn.has(key) && drawn.get(key) !== print).map(([key]) => key);
}

// Dispatched session cost after subtracting Claude print rows already counted on this card.
// Subtract only when settled primary usage covers those rows and its newest turn starts inside the parent turn.
// Otherwise exclude primary usage and mark the remaining contribution partial.
interface DispatchedShare {
  cost: DispatchedTurnCost;
  costs: readonly PricedDispatchedCost[];
  dollars: number | null;
  partial: boolean;
  printed: boolean;
}

// The amount a counted dispatched session shows when nothing it holds has a price yet.
const ZERO_COST = '$0.00';

// The rounding that summing the same requests in another order can leave.
const PRINTED_SLACK = 1e-9;

function dispatchedShare(turn: Turn, cost: DispatchedTurnCost): DispatchedShare {
  const rows = turn.agents.filter((agent) => agent.agentType === 'claude-cli' && agent.id === cost.sessionId);
  const all = cost.costs;
  if (!rows.length) {
    const total = sessionCostTotalOf(all);
    return { cost, costs: all, dollars: total.dollars, partial: cost.short || total.partial, printed: false };
  }
  const printed = rows.reduce((sum, row) => sum + (spendCost(row).dollars ?? 0), 0);
  // Require primary-transcript cost to cover printed rows. Descendant cost cannot establish that coverage.
  const own = sessionCostTotalOf(all.filter((priced) => priced.part.own));
  const holds =
    own.dollars !== null &&
    own.dollars - printed >= -PRINTED_SLACK &&
    cost.ownSettledAt !== null &&
    cost.ownSettledAt >= turn.startedAt;
  if (holds) {
    const total = sessionCostTotalOf(all);
    return {
      cost,
      costs: all,
      dollars: Math.max(0, total.dollars! - printed),
      partial: cost.short || total.partial,
      printed: true,
    };
  }
  const costs = all.filter((priced) => !priced.part.own);
  const rest = sessionCostTotalOf(costs);
  return { cost, costs, dollars: rest.dollars, partial: true, printed: true };
}

// Adds counted dispatched costs to the parsed turn and its subagents.
export function turnCardCost(turn: Turn, dispatched: readonly DispatchedTurnCost[] = []): SessionCostTotal {
  return cardCostOf(
    turn,
    dispatched.map((cost) => dispatchedShare(turn, cost)),
  );
}

function cardCostOf(turn: Turn, shares: readonly DispatchedShare[]): SessionCostTotal {
  return sessionCostTotalOf([
    turnCost(turn),
    ...shares.map((share) => ({ dollars: share.dollars, partial: share.partial })),
  ]);
}

// A ledger part in the form the cost projections price.
export function sessionCostUsageOf({ bucket, role, scopeId }: SessionSpendPart): SessionCostUsage {
  return {
    ...(bucket.usageOrigin ? { usageOrigin: bucket.usageOrigin } : {}),
    agent: bucket.agent,
    role,
    scopeId,
    model: bucket.model,
    provider: bucket.provider,
    contextWindow: bucket.contextWindow,
    contextBand: bucket.contextBand,
    inferenceClass: bucket.inferenceClass,
    serviceTier: bucket.serviceTier,
    ...(recordedCostBasis(bucket.reportedCostBasis) && bucket.reportedCost !== null
      ? { recordedCost: bucket.reportedCost }
      : {}),
    ...(bucket.reportedCostBasis ? { costBasis: bucket.reportedCostBasis } : {}),
    ...(bucket.unclassifiedCacheWrite ? { unclassifiedCacheWrite: bucket.unclassifiedCacheWrite } : {}),
    ...(bucket.incomplete ? { incomplete: true } : {}),
    ...(bucket.requestCountExact === false ? { requestCountExact: false as const } : {}),
    ...(bucket.compactionEstimate ? { compactionEstimate: true as const } : {}),
    ...(bucket.compactionUsage ? { compactionUsage: true as const } : {}),
    usage: bucket.usage,
  };
}

// A child session reference as the relationship reader records it.
export interface ChildSessionReference {
  kind?: string;
  parentSessionId: string;
  sessionId: string;
  toolUseIds: readonly string[];
  name?: string | null;
}

// A native Codex subagent's thread and the thread that started it.
export interface ChildThread {
  threadId: string;
  parentThreadId: string | null;
}

// A link from a session to a subagent it started. A Codex thread link carries no call id,
// because a turn finds its own threads through its agent rows.
interface SubagentLink {
  sessionId: string;
  toolUseIds: readonly string[];
  thread?: true;
}

// The references grouped once for every card that reads them.
interface DispatchReferenceIndex<R> {
  subagents: Map<string, SubagentLink[]>;
  dispatches: Map<string, R[]>;
  // The first receipt over every dispatch reference from a parent to a session.
  receipts: Map<string, string>;
}

const dispatchReferenceIndexes = new WeakMap<
  readonly ChildSessionReference[],
  { threads: readonly ChildThread[]; index: DispatchReferenceIndex<ChildSessionReference> }
>();

// Caches the reference index while reference and thread array identities remain unchanged.
function dispatchReferenceIndex<R extends ChildSessionReference>(
  references: readonly R[],
  threads: readonly ChildThread[],
): DispatchReferenceIndex<R> {
  const held = dispatchReferenceIndexes.get(references);
  if (held?.threads === threads) {
    return held.index as unknown as DispatchReferenceIndex<R>;
  }
  const index: DispatchReferenceIndex<R> = { subagents: new Map(), dispatches: new Map(), receipts: new Map() };
  const push = <V>(map: Map<string, V[]>, key: string, value: V) => {
    const list = map.get(key);
    if (list) {
      list.push(value);
    } else {
      map.set(key, [value]);
    }
  };
  for (const reference of references) {
    if (reference.kind !== 'dispatch') {
      push(index.subagents, reference.parentSessionId, reference);
      continue;
    }
    push(index.dispatches, reference.parentSessionId, reference);
    const receipt = `${reference.parentSessionId}\0${reference.sessionId}`;
    if (reference.toolUseIds.length && !index.receipts.has(receipt)) {
      index.receipts.set(receipt, reference.toolUseIds[0]);
    }
  }
  for (const thread of threads) {
    if (thread.parentThreadId !== null) {
      push(index.subagents, thread.parentThreadId, { sessionId: thread.threadId, toolUseIds: [], thread: true });
    }
  }
  dispatchReferenceIndexes.set(references, { threads, index });
  return index;
}

// Selects dispatched sessions attributable to this turn, including launches by its recursive subagents.
// The first launch ID assigns each session to one card.
// Direct references take precedence over indirect references. Equal kinds retain the latest reference for display.
export function countedDispatchReferences<R extends ChildSessionReference>(
  references: readonly R[],
  turn: Turn,
  callIds: ReadonlySet<string>,
  threads: readonly ChildThread[] = [],
): { reference: R; direct: boolean }[] {
  const index = dispatchReferenceIndex(references, threads);
  const launchIds = new Set([
    ...callIds,
    ...turn.agents.map((agent) => agent.toolUseId).filter((id): id is string => !!id),
  ]);
  // Each subagent of the turn, with the first launch id of the top subagent on its chain.
  const subagents = new Map<string, string>();
  const chain: string[] = [];
  const add = (sessionId: string, first: string) => {
    if (!subagents.has(sessionId)) {
      subagents.set(sessionId, first);
      chain.push(sessionId);
    }
  };
  const top = index.subagents.get(turn.sessionId) ?? [];
  for (const link of top) {
    if (!link.thread && link.toolUseIds.some((id) => launchIds.has(id))) {
      add(link.sessionId, link.toolUseIds[0]);
    }
  }
  if (top.some((link) => link.thread)) {
    const threadIds = new Set(top.filter((link) => link.thread).map((link) => link.sessionId));
    for (const agent of turn.agents) {
      const thread = [agent.childSessionId, agent.id].find((id): id is string => !!id && threadIds.has(id));
      if (thread) {
        // A Codex thread's row lives on one card, so its launch is that card's own.
        const first = agent.toolUseId ?? `thread:${thread}`;
        launchIds.add(first);
        add(thread, first);
      }
    }
  }
  for (let at = 0; at < chain.length; at++) {
    const first = subagents.get(chain[at])!;
    for (const link of index.subagents.get(chain[at]) ?? []) {
      add(link.sessionId, first);
    }
  }
  const counted = new Map<string, { reference: R; direct: boolean; first: string }>();
  const consider = (reference: R, direct: boolean, first: string | undefined) => {
    if (first === undefined) {
      return;
    }
    const held = counted.get(reference.sessionId);
    if (!held || (direct && !held.direct)) {
      counted.set(reference.sessionId, { reference, direct, first });
    } else if (direct === held.direct) {
      held.reference = reference;
    }
  };
  for (const reference of index.dispatches.get(turn.sessionId) ?? []) {
    if (reference.toolUseIds.some((id) => callIds.has(id))) {
      consider(reference, true, index.receipts.get(`${turn.sessionId}\0${reference.sessionId}`));
    }
  }
  for (const [sessionId, first] of subagents) {
    for (const reference of index.dispatches.get(sessionId) ?? []) {
      consider(reference, false, first);
    }
  }
  return [...counted.values()]
    .filter(({ direct, first }) => (direct ? callIds : launchIds).has(first))
    .map(({ reference, direct }) => ({ reference, direct }));
}

// Reads ledger contributions only when the card counts dispatched sessions.
// Missing contributions remain partial while discovery or ledger work is pending.
// Settled missing contributions add no cost.
export function countedDispatchedCosts(
  turn: Turn,
  references: readonly ChildSessionReference[],
  callIds: ReadonlySet<string>,
  costsOf: () => Readonly<Record<string, DispatchedSessionCost>> | undefined,
  waiting: boolean,
  threads: readonly ChildThread[] = [],
): DispatchedTurnCost[] {
  const counted = countedDispatchReferences(references, turn, callIds, threads);
  const costs = counted.length ? costsOf() : undefined;
  return counted.flatMap(({ reference }) => {
    const name = reference.name || reference.sessionId;
    // A launch can record only a unique prefix of the session id.
    const found =
      costs?.[reference.sessionId] ??
      Object.entries(costs ?? {}).find(([id]) => id.startsWith(reference.sessionId))?.[1];
    if (found) {
      return [{ sessionId: reference.sessionId, name, ...found }];
    }
    return waiting ? [{ sessionId: reference.sessionId, name, costs: [], short: true, ownSettledAt: null }] : [];
  });
}

type PricedUsageKey = 'input' | 'cacheWrite1h' | 'cacheWrite5m' | 'cacheWrite30m' | 'cacheRead' | 'output';

interface PricedUsageCategory {
  key: PricedUsageKey;
  label: string;
  dollars: number;
}

const USAGE_COST_CATEGORIES: readonly { key: PricedUsageKey; label: string }[] = [
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cached input reads' },
  { key: 'input', label: 'Uncached input' },
  { key: 'cacheWrite1h', label: '1-hour cache writes' },
  { key: 'cacheWrite5m', label: '5-minute cache writes' },
  { key: 'cacheWrite30m', label: '30-minute cache writes' },
];

const COST_ESTIMATE_NOTE = 'Estimated from published model rates. Your actual charge may differ.';
const AUTO_REVIEW_RATE_NOTE = 'Codex Auto Review uses the OpenAI Codex rate card.';
export const CACHED_INPUT_READ_EXPLANATION =
  "Input tokens served from the provider's prompt cache, billed at the cache-read rate. They can include tools, system and project instructions, and earlier messages.";

function usageCost(
  usage: Turn['usage'],
  model: string | null,
  provider: string | null,
  contextWindow: number | null,
  key: PricedUsageKey,
  priceContext: UsagePriceContext = {},
): number | null {
  const requestTokens = inputSideTokens(usage);
  if (
    !usage.byContextBand &&
    (usage.requests ?? 0) !== 1 &&
    hasRequestContextPricing(model, provider) &&
    contextBandForRequest(model, provider, requestTokens) !== 'short'
  ) {
    return null;
  }
  const part: Turn['usage'] = {
    requests: usage.requests ?? 0,
    input: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
  };
  part[key] = usage[key] ?? 0;
  if (usage.byContextBand) {
    part.byContextBand = {};
    for (const band of ['short', 'long'] as const) {
      const source = usage.byContextBand[band];
      if (!source) {
        continue;
      }
      const bandPart: Turn['usage'] = {
        requests: source.requests ?? 0,
        input: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead: 0,
        output: 0,
        thinking: 0,
      };
      bandPart[key] = source[key] ?? 0;
      part.byContextBand[band] = bandPart;
    }
  }
  return estimateCost(part, model, provider, contextWindow, requestTokens, priceContext);
}

function pricedUsageCategories(
  usage: Turn['usage'],
  model: string | null,
  provider: string | null,
  contextWindow: number | null,
  priceContext: UsagePriceContext = {},
): PricedUsageCategory[] {
  return USAGE_COST_CATEGORIES.filter(
    ({ key }) => (usage[key] ?? 0) > 0 || (key === 'cacheRead' && cacheHitPercent(usage) !== null),
  )
    .map(({ key, label }) => ({
      key,
      label,
      dollars: usageCost(usage, model, provider, contextWindow, key, priceContext),
    }))
    .filter((part): part is PricedUsageCategory => part.dollars !== null);
}

// Flags low cache reuse only with enough requests and material input cost.
// Output cost alone cannot trigger the warning.
// Optional request facts describe input size without classifying it as waste.
function cacheRateDetail(
  usage: Turn['usage'],
  inputCost: number | null,
  includeRequestFacts = false,
): { cacheHit?: CacheHitDetail } {
  const percent = cacheHitPercent(usage);
  if (percent === null) {
    return {};
  }
  const requests = usage.requests ?? 0;
  const average = includeRequestFacts && requests > 0 ? averageContextPerRequest(usage) : null;
  return {
    cacheHit: {
      percent,
      warning: percent < 80 && requests >= 5 && inputCost !== null && inputCost >= 0.5,
      ...(average !== null && average > 0 ? { requestScale: [requests, Math.round(average)] as [number, number] } : {}),
    },
  };
}

function formatUsageCostCategories(
  categories: readonly PricedUsageCategory[],
  usage?: Turn['usage'],
  inputCost: number | null = null,
  includeRequestFacts = false,
): StatDetailLine[] {
  return categories
    .filter(({ key, dollars }) => dollars > 0 || (key === 'cacheRead' && usage && cacheHitPercent(usage) !== null))
    .map(({ key, label, dollars }) => ({
      text: `${label}: ${formatCost(dollars) ?? '$0'}`,
      cost: true,
      ...(key === 'cacheRead' && usage ? cacheRateDetail(usage, inputCost, includeRequestFacts) : {}),
    }));
}

// Usage scope completeness, completion, and recorded CLI total.
// A recorded total is independent of the category breakdown.
interface ScopeFacts {
  complete?: boolean;
  finished?: boolean;
  recordedTotal?: number;
  // Already priced usage total. Undefined requests a calculation in this detail builder.
  total?: number | null;
}

function usageCostDetail(
  usage: Turn['usage'],
  model: string | null,
  provider: string | null,
  contextWindow: number | null,
  scope: ScopeFacts = {},
): StatDetailLine[] {
  const { complete = true, total: priced } = scope;
  const categories = pricedUsageCategories(usage, model, provider, contextWindow);
  const total = complete ? (priced !== undefined ? priced : estimateCost(usage, model, provider, contextWindow)) : null;
  const inputCost = total !== null ? inputCategoryCost(categories) : null;
  return formatUsageCostCategories(categories, usage, inputCost, true);
}

function hasPricedCacheRead(
  usage: Turn['usage'],
  model: string | null,
  provider: string | null,
  contextWindow: number | null,
): boolean {
  const dollars = usageCost(usage, model, provider, contextWindow, 'cacheRead');
  return dollars !== null && dollars > 0;
}

function costLabelWithModels(label: string, models: readonly (string | null)[]): string {
  const names = [...new Set(models.map((model) => shortModel(model) ?? 'model not recorded'))];
  return names.length ? `${label} · ${names.join(', ')}` : label;
}

function costEntry(
  name: string,
  model: string | null,
  provider: string | null,
  contextWindow: number | null,
  usage: Turn['usage'],
  recordedCost?: number,
  costBasis?: string,
  unclassifiedCacheWrite = 0,
  finished = true,
): StatDetailEntry {
  const recordedTotal = recordedCostBasis(costBasis) && recordedCost !== undefined ? recordedCost : undefined;
  // Reuse this price when calculating the input-cost warning below.
  const priced = recordedTotal ?? estimateCost(usage, model, provider, contextWindow);
  const cost = formatCost(priced);
  const lines = usageCostDetail(usage, model, provider, contextWindow, {
    complete: unclassifiedCacheWrite === 0 && recordedTotal === undefined,
    finished,
    recordedTotal,
    total: priced,
  });
  if (unclassifiedCacheWrite > 0) {
    lines.push(`Cache writes without a recorded lifetime: ${detailedTokens(unclassifiedCacheWrite)} tokens`);
  }
  if (recordedCost !== undefined) {
    const note = recordedCostNote(costBasis);
    if (note) {
      lines.push(note);
    }
  }
  return {
    label: costLabelWithModels(name, [model]),
    value: cost || 'cost unavailable',
    lines,
  };
}

// The line that says where a recorded total came from, or null for a basis the card does not show.
function recordedCostNote(basis: string | undefined): string | null {
  if (basis === 'list') {
    return 'Total recorded by Claude CLI at list price';
  }
  if (basis === BEDROCK_LIST_COST_BASIS) {
    return 'Total recorded by Claude CLI at list price, times 1.1 for Amazon Bedrock';
  }
  return null;
}

function exactCostEntry(name: string, parts: readonly SessionCostUsage[], finished = true): StatDetailEntry {
  const costs = parts.map(priceSessionCost);
  return {
    label: costLabelWithModels(
      name,
      parts.map((part) => part.model),
    ),
    value: sessionCostValue(costs),
    lines: usageCategoryLines(costs, finished),
  };
}

// Optional caller heading for auto-review cost. Session-list rows use the review identity alone.
function autoReviewCostEntry(
  provider: string | null | undefined,
  costs: readonly PricedSessionCost[],
  finished = true,
  name?: string,
  incomplete = false,
): StatDetailEntry {
  const reasons = new Set<string>();
  for (const cost of costs) {
    if (cost.partial) {
      for (const reason of unavailableReasons(cost)) {
        reasons.add(reason);
      }
    }
  }
  const lines = pricedUsageCategoryLines(costs, finished, incomplete);
  for (const basis of ['list', BEDROCK_LIST_COST_BASIS]) {
    if (costs.some((cost) => cost.part.costBasis === basis && cost.part.recordedCost !== undefined)) {
      lines.push(recordedCostNote(basis)!);
    }
  }
  lines.push(...[...reasons].sort().map(sentenceCaseReason));
  const identity = autoReviewUsageIdentity(provider).label;
  return {
    // Avoid repeating the review identity in the heading.
    label: name && name !== identity ? `${name} · ${identity}` : identity,
    value: sessionCostValue(costs, incomplete),
    ...(lines.length ? { lines } : {}),
  };
}

// Child cost blocks with an optional caller-supplied heading.
// `noEnding` selects missing-ending wording for an open child without live-process evidence.
function childCostEntries(
  agent: TurnAgent,
  turnFinished = true,
  name = agent.description,
  runner: AgentKind = 'claude',
  noEnding = false,
  // Receives each block's compaction note, led by the block label. Without it the note stays a block line.
  notes?: string[],
): StatDetailEntry[] {
  // A child that is still running, or whose own turn has not ended, reports a lower bound.
  const finished = turnFinished && !agentSpendIsOpen(agent.status);
  if (!agent.spend.length) {
    if (
      agent.spendFound &&
      !agentSpendIsOpen(agent.status) &&
      !agent.spendPartial &&
      !agent.spendIncomplete &&
      !agent.tokens
    ) {
      return [{ label: name, value: 'no billed usage' }];
    }
    const lines: string[] = [];
    if (agent.tokens) {
      lines.push(`${formatTokens(agent.tokens)} tokens recorded`);
    }
    if (agentSpendIsOpen(agent.status)) {
      lines.push(noEnding ? AGENT_NO_COST_NO_ENDING : 'Still running. No cost is recorded yet.');
    }
    return [{ label: name, value: 'cost unavailable', lines }];
  }
  const autoReviews = new Map<
    string,
    {
      provider: string | null;
      parts: TurnAgent['spend'];
    }
  >();
  for (const part of agent.spend) {
    if (part.model !== 'codex-auto-review') {
      continue;
    }
    const provider = part.provider ?? null;
    const identity = autoReviewUsageIdentity(provider);
    const held = autoReviews.get(identity.key) ?? { provider, parts: [] };
    held.parts.push(part);
    autoReviews.set(identity.key, held);
  }
  const emittedAutoReviews = new Set<string>();
  // Use review identity alone when every spend part is auto review and the heading is the child description.
  const describedByReview =
    name === agent.description && agent.spend.every((part) => part.model === 'codex-auto-review');
  const entries = agent.spend.flatMap((part) => {
    if (part.model !== 'codex-auto-review') {
      if (part.usageParts?.length && !(recordedCostBasis(part.costBasis) && part.recordedCost !== undefined)) {
        const parts = part.usageParts.map((usagePart): SessionCostUsage => ({
          agent: null,
          role: 'delegated',
          ...usagePart,
        }));
        const entry = exactCostEntry(name, parts, finished);
        // Each model's block names the compactions that model ran, in the session total's words.
        const compactionNote = compactionEstimateNote(parts.map(priceSessionCost));
        if (compactionNote && notes) {
          notes.push(`${entry.label}: ${compactionNote}`);
        } else if (compactionNote) {
          (entry.lines ?? (entry.lines = [])).push(compactionNote);
        }
        return [entry];
      }
      return [
        costEntry(
          name,
          part.model,
          part.provider ?? null,
          part.contextWindow ?? null,
          part.usage,
          part.recordedCost,
          part.costBasis,
          part.unclassifiedCacheWrite,
          finished,
        ),
      ];
    }
    const identity = autoReviewUsageIdentity(part.provider);
    if (emittedAutoReviews.has(identity.key)) {
      return [];
    }
    emittedAutoReviews.add(identity.key);
    const review = autoReviews.get(identity.key)!;
    const costs = review.parts.flatMap((held): PricedSessionCost[] => {
      if (held.usageParts?.length && !(recordedCostBasis(held.costBasis) && held.recordedCost !== undefined)) {
        return held.usageParts.map((usagePart) =>
          priceSessionCost({
            agent: null,
            role: 'delegated',
            ...usagePart,
          }),
        );
      }
      return [
        priceSessionCost({
          model: held.model,
          provider: held.provider ?? null,
          contextWindow: held.contextWindow ?? null,
          recordedCost: held.recordedCost,
          costBasis: held.costBasis,
          unclassifiedCacheWrite: held.unclassifiedCacheWrite,
          usage: held.usage,
        }),
      ];
    });
    return [autoReviewCostEntry(review.provider, costs, finished, describedByReview ? undefined : name)];
  });
  const last = entries.at(-1);
  if (last) {
    const lines = last.lines ?? (last.lines = []);
    if (agentSpendIsOpen(agent.status)) {
      lines.push(noEnding ? AGENT_COST_NO_ENDING : AGENT_COST_SO_FAR);
    }
    if (agent.spendPartial) {
      lines.push(
        agent.agentType === 'claude-cli'
          ? AGENT_CLI_COST_MISSING
          : runner === 'codex'
            ? AGENT_CODEX_NESTED_COST_MISSING
            : AGENT_NESTED_COST_SO_FAR,
      );
    }
  }
  return entries;
}

// Default liveness for projections without current process evidence.
const NO_AGENT_LIFE: AgentLive = { session: false, children: new Set<string>() };

// Cost detail shares child-ending wording with the child rows.
// Without a liveness callback, evaluate status at the turn's last record.
// This preserves terminal outcomes without applying clock-driven quiet expiry.
function costDetailList(
  turn: Turn,
  warnings: readonly CacheWriteWarning[] = [],
  noEnding: (agent: TurnAgent) => boolean = (agent) =>
    agentState(agent, statusOf(turn, true, turn.endedAt) === 'running', NO_AGENT_LIFE) === 'open',
  shares: readonly DispatchedShare[] = [],
  expiry: CacheExpiryWarning | null = null,
): StatDetailList {
  const total = cardCostOf(turn, shares);
  const sharedCosts = shares.flatMap((share) => share.costs);
  const childCompactionNotes: string[] = [];
  const totalLabel = formatCost(total.dollars) ?? (shares.length ? ZERO_COST : null);
  const mainParts = (turn.usageParts ?? []).map((part): SessionCostUsage => ({
    agent: turn.agent,
    role: 'main',
    ...part,
  }));
  const finished = turn.finished;
  const mainWarnings = warnings.filter((warning) => warning.scope === 'main');
  // Build the main-agent entry only when its cost block or warning label needs it.
  const mainEntry = (): StatDetailEntry =>
    mainParts.length
      ? exactCostEntry('Main agent', mainParts, finished)
      : costEntry(
          'Main agent',
          turn.model,
          turn.provider ?? null,
          turn.contextWindow,
          turn.usage,
          undefined,
          undefined,
          0,
          finished,
        );
  const entries =
    turn.agents.length || shares.length
      ? [
          withCostWarnings(mainEntry(), mainWarnings),
          ...turn.agents.flatMap((agent, index) => {
            const childEntries = childCostEntries(
              agent,
              finished,
              agent.description,
              turn.agent,
              noEnding(agent),
              childCompactionNotes,
            );
            if (childEntries[0]) {
              withCostWarnings(
                childEntries[0],
                warnings.filter((warning) => warning.id?.startsWith(`${index}:`)),
              );
            }
            return childEntries;
          }),
          // A dispatched share reduced by printed rows omits whole-session category lines.
          ...shares.map((share): StatDetailEntry => ({
            label: share.cost.name,
            value: `${formatCost(share.dollars) ?? ZERO_COST}${share.partial ? '+' : ''}`,
            ...(share.printed ? {} : { lines: delegatedCostLines(share.costs) }),
          })),
        ]
      : mainParts.length
        ? [exactCostEntry('Cost by usage', mainParts, finished)]
        : [
            {
              label: costLabelWithModels('Cost by usage', [turn.model]),
              lines: usageCostDetail(turn.usage, turn.model, turn.provider ?? null, turn.contextWindow, { finished }),
            },
          ];
  if (!turn.agents.length && !shares.length && mainWarnings.length) {
    entries[0].label = mainEntry().label;
    withCostWarnings(entries[0], mainWarnings);
  }
  const hasCacheRead =
    hasPricedCacheRead(turn.usage, turn.model, turn.provider ?? null, turn.contextWindow) ||
    turn.agents.some((agent) =>
      agent.spend.some((part) =>
        hasPricedCacheRead(part.usage, part.model, part.provider ?? null, part.contextWindow ?? null),
      ),
    ) ||
    sharedCosts.some((cost) =>
      cost.categories.some((category) => category.key === 'cacheRead' && category.dollars > 0),
    );
  // A dispatched session's notes follow the session total's rules.
  const compactionNote = compactionEstimateNote(sharedCosts);
  // The main agent's recorded and estimated compactions, which the turn names under "Included above".
  const mainCosts = mainParts.map(priceSessionCost);
  const compactions = mainCosts
    .filter((cost) => cost.part.compactionEstimate || cost.part.compactionUsage)
    .reduce((sum, cost) => sum + (cost.part.usage.requests ?? 0), 0);
  const included = includedAboveEntries(
    compactions > 0 ? { count: compactions, cost: compactionOverheadCost(compactions, mainCosts) } : null,
    null,
  );
  const mainEstimated =
    compactions > 0 && mainCosts.some((cost) => cost.part.compactionEstimate && cost.dollars !== null);
  const hasPublicAutoReview =
    (turn.model === 'codex-auto-review' &&
      estimateCost(turn.usage, turn.model, turn.provider ?? null, turn.contextWindow) !== null) ||
    turn.agents.some((agent) =>
      agent.spend.some(
        (part) =>
          part.model === 'codex-auto-review' &&
          !(recordedCostBasis(part.costBasis) && part.recordedCost !== undefined) &&
          estimateCost(part.usage, part.model, part.provider ?? null, part.contextWindow ?? null) !== null,
      ),
    ) ||
    sharedCosts.some((cost) => cost.part.model === 'codex-auto-review' && cost.publiclyPriced);
  const expiryText = expiry ? cacheExpiryWarningText(expiry) : '';
  return {
    heading: {
      label: 'Estimated total',
      value: totalLabel ? `${totalLabel}${total.partial ? '+' : ''}` : 'cost unavailable',
    },
    entries: [...(expiryText ? [{ label: expiryText, warning: true }] : []), ...entries, ...included],
    // The compaction notes say part of the cost is a modelled estimate, so they stay visible.
    ...(mainEstimated || compactionNote || childCompactionNotes.length
      ? {
          footer: [
            ...(mainEstimated ? [COMPACTION_ESTIMATE_FOOTER] : []),
            ...(compactionNote ? [compactionNote] : []),
            ...childCompactionNotes,
          ],
        }
      : {}),
    notes: [
      ...(hasCacheRead ? [CACHED_INPUT_READ_EXPLANATION] : []),
      ...(hasPublicAutoReview ? [AUTO_REVIEW_RATE_NOTE] : []),
      COST_ESTIMATE_NOTE,
    ],
  };
}

export { cacheWriteWarningCondition };

function warningLine(warning: CacheWriteWarning): StatDetailLine {
  return {
    text: `${cacheWriteWarningCondition(warning)}: ${formatCost(warning.cacheWriteCost)} of ${formatCost(warning.scopeCost)} went to cache writes`,
    warning: true,
  };
}

function withCostWarnings(entry: StatDetailEntry, warnings: readonly CacheWriteWarning[]): StatDetailEntry {
  if (warnings.length) {
    entry.lines = [...warnings.map(warningLine), ...(entry.lines ?? [])];
  }
  return entry;
}

function turnCacheWriteScopes(turn: Turn, complete: boolean): CacheWriteScope[] {
  const mainParts = (turn.usageParts ?? []).map((part): SessionCostUsage => ({
    agent: turn.agent,
    role: 'main',
    ...part,
  }));
  const delegated = turn.agents.flatMap((agent, index): CacheWriteScope[] => {
    const groups = new Map<string, SessionCostUsage[]>();
    for (const spend of agent.spend) {
      for (const part of spend.usageParts ?? []) {
        const key = part.linkedInvocationId ? `invocation:${part.linkedInvocationId}` : 'direct';
        const held = groups.get(key) ?? [];
        held.push({
          agent: null,
          role: 'delegated',
          ...part,
          recordedCost: spend.recordedCost,
          costBasis: spend.costBasis,
        });
        groups.set(key, held);
      }
    }
    return [...groups].map(([key, parts]) => ({
      scope: 'delegated',
      id: `${index}:${key}`,
      incomplete:
        !complete ||
        !agent.spendFound ||
        (key === 'direct' && Boolean(agent.spendIncomplete)) ||
        agentSpendIsOpen(agent.status) ||
        (key === 'direct' && agent.spend.some((part) => !part.usageParts)),
      parts,
    }));
  });
  return [{ scope: 'main', incomplete: !complete || !turn.usageParts, parts: mainParts }, ...delegated];
}

function flatDetailEntry(entry: StatDetailEntry): string[] {
  const flatLine = (line: StatDetailLine, indent: string): string[] => {
    if (typeof line === 'string') {
      return [`${indent}${line}`];
    }
    if (!('text' in line)) {
      return [`${indent}${line.lead}${line.trail}`];
    }
    return [
      `${indent}${line.text}${line.cacheHit ? formatCacheHitDetail(line.cacheHit) : ''}`,
      ...(line.lines ?? []).flatMap((held) => flatLine(held, `${indent}  `)),
    ];
  };
  const pair = entry.diff ? diffValue(entry.diff.added, entry.diff.removed) : '';
  const diff = pair ? `: ${pair}` : '';
  return [
    `${entry.label}${diff}${
      entry.value
        ? `: ${
            typeof entry.value === 'string'
              ? entry.value
              : `${entry.value.lead}${formatRelative(entry.value.at)}${entry.value.trail}`
          }`
        : ''
    }`,
    ...(entry.lines ?? []).flatMap((line) => flatLine(line, '  ')),
  ];
}

function flatDetailList(list: StatDetailList): string[] {
  return [
    ...(list.heading ? flatDetailEntry(list.heading) : []),
    ...(list.heading && list.entries.length ? [''] : []),
    ...list.entries.flatMap((entry) => [...(entry.separateBefore ? [''] : []), ...flatDetailEntry(entry)]),
    ...(list.footer ?? []),
    ...(list.notes ?? []),
  ];
}

export interface SessionContextDetail {
  entries: StatDetailEntry[];
  footer?: string[];
}

export const CACHE_EXPIRY_COST_ADDED_HINT =
  'Paid to resend context after the cache expired, beyond the cache-read price for the same tokens. New prompt text is not counted.';

function costAddedLabel(facts: CacheExpiryFacts): string {
  const priced = cacheExpiryExtraCost(facts, publicProjectSpendPrice);
  if (priced.dollars === null) {
    return 'Unavailable';
  }
  const value = formatCost(priced.dollars) ?? '$0.00';
  return priced.status === 'atLeast' ? `At least ${value}` : value;
}

function formatExpiryGap(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 24) {
    return formatDuration(ms);
  }
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return `${days}d${remainder ? ` ${remainder}h` : ''}`;
}

// The least known cost added that draws a warning in a turn's cost detail and figure.
export const CACHE_EXPIRY_SIGN_DOLLARS = 1;

// The return that opened `turn`, from the session's retained cache-expiry returns. A Claude
// return names its request, which is the turn's opening response. A Codex return names the turn.
export function turnCacheExpiryReturn(
  turn: Pick<Turn, 'agent' | 'promptId' | 'responseIds' | 'openingResponseId'>,
  returns: readonly CacheExpiryReturn[],
): CacheExpiryReturn | null {
  if (turn.agent === 'codex') {
    const id = turn.promptId ? `codex-turn:${turn.promptId}` : null;
    return (id && returns.find((item) => item.request.agent === 'codex' && item.visibleTurnId === id)) || null;
  }
  const responses = new Set([...(turn.openingResponseId ? [turn.openingResponseId] : []), ...(turn.responseIds ?? [])]);
  return (
    returns.find(
      (item) =>
        item.request.agent === 'claude' &&
        item.requestKey?.startsWith('claude:') &&
        responses.has(item.requestKey.slice('claude:'.length)),
    ) ?? null
  );
}

// The cache-expiry warning for `turn`, priced as cost added, or null when no retained return
// opened it.
export function turnCacheExpiryWarning(
  turn: Pick<Turn, 'agent' | 'promptId' | 'responseIds' | 'openingResponseId'>,
  facts: CacheExpiryFacts | null | undefined,
  children?: ChildExpiryCost,
): CacheExpiryWarning | null {
  const found = facts ? turnCacheExpiryReturn(turn, facts.returns) : null;
  if (!found && !children) {
    return null;
  }
  const priced =
    found && facts
      ? cacheExpiryExtraCost(
          { ...facts, returns: [found], truncated: false, childSources: undefined, incompleteSources: undefined },
          publicProjectSpendPrice,
        )
      : null;
  if (!children) return { scope: 'cache-expiry', gapMs: found!.gapMs, ...priced! };
  return {
    scope: 'cache-expiry',
    gapMs: found?.gapMs ?? children.longestGapMs,
    dollars: children.dollars,
    status: children.status,
    children,
    ...(found && priced ? { main: { gapMs: found.gapMs, ...priced } } : {}),
  };
}

// "a 1h 12m gap", "an 8h 0m gap", "an 11m gap": the article follows how the figure is spoken.
function gapPhrase(ms: number): string {
  const gap = formatExpiryGap(ms);
  return `${/^(8|1[18](?!\d))/.test(gap) ? 'an' : 'a'} ${gap} gap`;
}

// What a drawn card's cache-expiry warning depends on, so a host redraws the card when it moves.
export function cacheExpiryWarningPrint(warning: CacheExpiryWarning | null): string {
  return warning ? JSON.stringify(warning) : '';
}

export function cacheExpiryWarningText(warning: CacheExpiryWarning): string {
  if (warning.children) {
    const children = warning.children;
    const added =
      children.dollars === null
        ? ''
        : ` and added ${children.status === 'atLeast' ? 'at least ' : ''}${formatCost(children.dollars) ?? ZERO_COST}`;
    const childText =
      children.dollars !== null && children.dollars >= CACHE_EXPIRY_SIGN_DOLLARS
        ? `Cache expiry affected ${children.count} subagent ${children.count === 1 ? 'request' : 'requests'}${added}`
        : '';
    return [warning.main ? cacheExpiryWarningText({ scope: 'cache-expiry', ...warning.main }) : '', childText]
      .filter(Boolean)
      .join('. ');
  }
  if (warning.dollars === null || warning.dollars < CACHE_EXPIRY_SIGN_DOLLARS) return '';
  const added = warning.dollars === null ? null : (formatCost(warning.dollars) ?? ZERO_COST);
  return `Cache expired after ${gapPhrase(warning.gapMs)}${added ? ` and added ${warning.status === 'atLeast' ? 'at least ' : ''}${added}` : ''}`;
}

export interface CacheExpiryCountFact {
  count: number;
  // True when unclassified adjacent requests leave the expiry count as a lower bound.
  atLeast: boolean;
}

// Totals qualifying cache returns across lifetimes for heading figures and session-list filters.
export function cacheExpiryReturnCount(facts: CacheExpiryFacts): CacheExpiryCountFact {
  return {
    count: facts.counts['5m'] + facts.counts['30m'] + facts.counts['1h'],
    atLeast: facts.unavailable > 0 || Boolean(facts.incompleteSources),
  };
}

export function sessionCacheExpiryStats(facts: CacheExpiryFacts): SessionStatChip[] {
  const { count } = cacheExpiryReturnCount(facts);
  if (count === 0) {
    return [];
  }
  const label = `${count} cache ${count === 1 ? 'expiry' : 'expiries'}`;
  const lifetimeParts = (['5m', '30m', '1h'] as const)
    .filter((lifetime) => facts.counts[lifetime] > 0)
    .map((lifetime) => `${facts.counts[lifetime]} at ${lifetime}`);
  const allReturns = (test: (item: CacheExpiryReturn) => boolean) =>
    facts.returns.some(test) || (facts.childSources ?? []).some((source) => source.facts.returns.some(test));
  const detailList: StatDetailList = {
    layout: 'economics',
    heading: { label: 'Cache expiry', value: `${count} affected ${count === 1 ? 'request' : 'requests'}` },
    entries: [
      { label: 'Cache lifetimes', value: lifetimeParts.join(' · ') },
      { label: 'Cost added', value: costAddedLabel(facts), valueTitle: CACHE_EXPIRY_COST_ADDED_HINT },
      ...(facts.longestGapMs === null
        ? []
        : [{ label: 'Longest qualifying gap', value: formatExpiryGap(facts.longestGapMs) }]),
      ...(facts.excluded > 0 ? [{ label: 'Excluded ambiguous events', value: String(facts.excluded) }] : []),
    ],
    footer: [
      ...(facts.incompleteSources
        ? ['Subagent records are incomplete. Cache expiry counts and cost added are lower bounds.']
        : []),
      ...(allReturns((item) => item.request.reportedCost !== null)
        ? ['One or more affected requests have only a provider-reported total. Cost added is not available for them.']
        : []),
      ...(allReturns(
        (item) => item.previousInputSide === null && (item.timestamp != null || item.visibleTurnId !== null),
      )
        ? [
            'One or more affected requests follow a compaction whose cached size is not recorded. Cost added is not available for them.',
          ]
        : []),
      ...(allReturns((item) => item.previousInputSide === null && item.timestamp == null && item.visibleTurnId === null)
        ? [
            'One or more affected requests were recorded before Arc measured cost added. Cost added is not available for them.',
          ]
        : []),
    ],
    ...(allReturns((item) => item.request.agent === 'codex')
      ? { notes: ['The record does not identify every cache-key change.'] }
      : {}),
  };
  return [
    {
      metric: 'cache-expiry',
      compactLabel: label,
      kind: 'plain',
      label,
      detail: flatDetailList(detailList).join('\n'),
      detailList,
      focusable: true,
    },
  ];
}

// Names what started a compaction. A recorded word Arc does not know shows as recorded, capitalized.
export function compactionTriggerLabel(trigger: string | null | undefined): string {
  const word = (trigger ?? '').trim();
  if (word === 'manual') {
    return 'Manual';
  }
  if (word === 'auto') {
    return 'Automatic';
  }
  if (word === 'refusal') {
    return 'After a refusal';
  }
  return word ? `${word[0].toUpperCase()}${word.slice(1)}` : 'Unknown';
}

export function sessionCompactionContextDetail(facts: readonly CompactionFact[]): SessionContextDetail | null {
  if (!facts.length) {
    return null;
  }
  const latest = facts.reduce((selected, fact) => (fact.ordinal > selected.ordinal ? fact : selected));
  return { entries: [{ label: 'Latest compaction', value: compactionTriggerLabel(latest.trigger) }] };
}

export function withSessionContextDetail(
  chips: readonly SessionStatChip[],
  addition: SessionContextDetail | null | undefined,
): SessionStatChip[] {
  if (!addition) {
    return [...chips];
  }
  const metric = chips.some((chip) => chip.metric === 'context') ? 'context' : 'turns';
  return chips.map((chip) => {
    if (chip.metric !== metric || !chip.detailList) {
      return chip;
    }
    // The subagent results entry stays last.
    const last = chip.detailList.entries.at(-1);
    const entries =
      last?.label === SUBAGENT_RESULTS_LABEL
        ? [...chip.detailList.entries.slice(0, -1), ...addition.entries, last]
        : [...chip.detailList.entries, ...addition.entries];
    const detailList: StatDetailList = {
      ...chip.detailList,
      layout: 'economics',
      entries,
      footer: [...(chip.detailList.footer ?? []), ...(addition.footer ?? [])],
    };
    return { ...chip, detailList, detail: flatDetailList(detailList).join('\n') };
  });
}

// Plain-text cost breakdown and coverage notes for a turn.
export function costDetail(turn: Turn): string[] {
  return flatDetailList(costDetailList(turn));
}

// Counts running child rows and live carried children. Open children do not count as running.
function agentDetailList(
  agents: TurnAgent[],
  turnRunning: boolean,
  sessionLive: AgentLive,
  record?: true,
  // The live carried subagents, which the newest card counts beside its own.
  carried = 0,
): StatDetailList {
  const displays = agents.map((agent) => agentDisplay(agent, turnRunning, sessionLive));
  const carriedLine = carriedAgentsLine(carried);
  const running = displays.filter((display) => display.state === 'running').length + carried;
  // Include carried children in the total heading and describe their origin separately in the footer.
  const own =
    agents.length && !carried
      ? `${agents.length} subagent${agents.length === 1 ? '' : 's'} in this turn`
      : agents.length
        ? `${agents.length + carried} subagents`
        : null;
  return {
    // The record layout draws the card's own agent rows, so a card with none keeps the list.
    ...(record && agents.length ? { layout: 'agents' as const, actions: true as const } : {}),
    heading: {
      // Use the available child or carried-child count, with a generic fallback.
      label: own ?? carriedLine ?? 'Subagents',
      // Running counts use the busy tone.
      ...(running ? { value: `${running} running`, busyValue: true as const } : {}),
    },
    entries: agents.map((agent, index) => ({
      label: agent.description,
      lines: [displays[index].summary].filter(Boolean),
    })),
    // Put carried-child origins below the heading when this card also has its own child rows.
    ...(own && carriedLine ? { footer: [carriedLine] } : {}),
  };
}

// Names the nonzero count of live children launched before this turn.
function carriedAgentsLine(carried: number): string | null {
  return carried > 0 ? `${carried} subagent${carried === 1 ? '' : 's'} started before this turn` : null;
}

// Compaction boundary on the timeline, separate from prompt-response turns.
export interface CompactionCard {
  kind: 'compaction';
  key: string;
  sessionId: string;
  sessionTitle: string | null;
  at: number;
  statusWord: string; // what the glyph's hover says, since the glyph says nothing
  relative: string;
  absolute: string;
  duration: string;
  durationWord: string;
  durationDetail: string;
  label: string; // what the head row is announced by, since a glyph says nothing
  headline: string;
  chips: StatChip[];
  summary: string;
}

// Explains the usage basis of a compaction estimate.
// Claude compactions lack recorded request usage. Estimate wording identifies each priced input category.
function compactionEstimateLines(estimate: CompactionEstimate | null): string[] {
  if (!estimate || estimate.basis === 'read') {
    return ['Estimated as a cache read of the whole context, because the record carries no usage for this compaction.'];
  }
  return [claudeCompactionEstimateLine(estimate)];
}

// Says that a Claude compaction cost is a modelled estimate.
const CLAUDE_COMPACTION_ESTIMATE = 'Claude Code records no usage for a compaction, so this cost is an estimate.';

function claudeCompactionEstimateLine({ usage, basis }: CompactionEstimate): string {
  const parts = [
    usage.cacheRead ? `${formatTokens(usage.cacheRead)} of cached input reads` : null,
    usage.cacheWrite5m ? `${formatTokens(usage.cacheWrite5m)} of 5-minute cache writes` : null,
    usage.cacheWrite30m ? `${formatTokens(usage.cacheWrite30m)} of 30-minute cache writes` : null,
    usage.cacheWrite1h ? `${formatTokens(usage.cacheWrite1h)} of 1-hour cache writes` : null,
    usage.input ? `${formatTokens(usage.input)} of uncached input` : null,
  ].filter((part): part is string => part !== null);
  const list = parts.length > 2 ? `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}` : parts.join(' and ');
  if (basis === 'cold') {
    return `Estimated as ${list}, because the cache had expired and the context was sent again without it.`;
  }
  return usage.cacheRead
    ? `Estimated as ${list}, because the session was still cached.`
    : `Estimated as ${list}, because the request before it read no cached input.`;
}

// Prices a compaction request from its recorded usage, as one request.
function exactCompactionCost(
  usage: Turn['usage'],
  model: string | null,
  provider: string | null,
  contextWindow: number | null,
  inferenceClass: UsageInferenceClass,
  serviceTier: string | null,
): number | null {
  return (
    quoteUsage({
      usage,
      model,
      provider,
      contextWindow,
      requestTokens: requestInputOf(usage),
      inferenceClass,
      serviceTier,
    })?.cost ?? null
  );
}

// A compaction draws the same row whether it is open or shut, as every card does.
function compactionChips(c: Compaction): StatChip[] {
  const chips: StatChip[] = [];
  const exactUsage = c.usage;
  const exactCost = exactUsage
    ? exactCompactionCost(
        exactUsage,
        c.model,
        c.provider ?? null,
        c.contextWindow ?? null,
        c.inferenceClass ?? null,
        c.serviceTier ?? null,
      )
    : null;
  const estimateInput = {
    model: c.model,
    at: c.at,
    durationMs: c.durationMs,
    contextBefore: c.contextBefore,
    contextAfter: c.contextAfter,
    previousRequest: c.previousRequest ?? null,
    firstRequestCachedTokens: c.firstRequestCachedTokens ?? null,
    postCompactionCacheRead: c.postCompactionCacheRead ?? null,
    summaryChars: c.summaryChars ?? null,
  };
  const estimated = exactUsage ? null : compactionEstimate(estimateInput);
  const cost = formatCost(exactUsage ? exactCost : estimateCompactionCost(estimateInput));
  if (cost) {
    // The usage stays visible. The pricing basis folds into the notes.
    const detailList: StatDetailList = exactUsage
      ? {
          entries: [
            {
              label: `${formatTokens(exactUsage.input)} uncached, ${formatTokens(exactUsage.cacheRead)} cached, ${formatTokens(exactUsage.output)} output.`,
            },
            ...(exactUsage.cacheWrite30m
              ? [{ label: `30-minute cache writes: ${detailedTokens(exactUsage.cacheWrite30m)} tokens.` }]
              : []),
          ],
          notes: ['Exact request usage priced at the recorded model and provider context.', COST_ESTIMATE_NOTE],
        }
      : {
          entries: [
            {
              label: `${formatTokens(estimated ? requestInputOf(estimated.usage) : c.contextBefore)} of context sent, ${formatTokens(estimated ? estimated.usage.output : c.contextAfter)} summary written.`,
            },
          ],
          // The sentence that calls a Claude cost an estimate stays visible.
          ...(estimated && estimated.basis !== 'read' ? { footer: [CLAUDE_COMPACTION_ESTIMATE] } : {}),
          notes: [...compactionEstimateLines(estimated), COST_ESTIMATE_NOTE],
        };
    chips.push({
      kind: 'plain',
      metric: 'cost',
      label: cost,
      detail: flatDetailList(detailList).join('\n'),
      detailList,
    });
  }
  if (c.droppedTokens) {
    chips.push({
      kind: 'plain',
      metric: 'dropped-context',
      label: `${formatTokens(c.droppedTokens)} dropped`,
      detail: 'Tokens this session has dropped so far, across every compaction in it.',
    });
  }
  return chips;
}

export function toCompactionCard(c: Compaction, now: number = Date.now()): CompactionCard {
  const trigger = compactionTriggerLabel(c.trigger);
  const why =
    c.trigger === 'auto'
      ? 'Compacted automatically.'
      : c.trigger === 'manual'
        ? 'Compacted by hand.'
        : c.trigger === 'refusal'
          ? 'Compacted after a refusal.'
          : trigger === 'Unknown'
            ? 'Compacted.'
            : `Compacted (${trigger}).`;
  const size =
    c.contextBefore && c.contextAfter
      ? `${formatTokens(c.contextBefore)} of session became a ${formatTokens(c.contextAfter)} summary.`
      : c.contextAfter
        ? `The resulting context was ${formatTokens(c.contextAfter)}.`
        : c.summary && c.contextBefore
          ? `${formatTokens(c.contextBefore)} of session was replaced by a summary of itself.`
          : c.summary
            ? 'The session was replaced by a summary of itself.'
            : c.contextBefore
              ? `${formatTokens(c.contextBefore)} of session was compacted.`
              : '';
  const relative = formatRelative(c.at, now);
  const duration = c.durationMs ? formatDuration(c.durationMs) : '';
  const durationDetail = `Compacted ${formatWhen(c.at, now)}`;
  const headline = size ? `${why} ${size}` : why;
  return {
    kind: 'compaction',
    key: `${c.sessionId}:compact:${c.at}`,
    sessionId: c.sessionId,
    sessionTitle: null,
    at: c.at,
    statusWord: 'compaction',
    relative,
    absolute: formatWhen(c.at, now),
    duration,
    durationWord: durationWord('done'),
    durationDetail,
    label: headLabel('Compaction', [relative, duration ? `${durationWord('done')} ${duration}` : null], headline),
    headline,
    chips: compactionChips(c),
    summary: c.summary,
  };
}

function baseName(target: string): string {
  const parts = target.split(/[\\/]/);
  return parts[parts.length - 1] || target;
}

// Accessible context-band identities independent of their visual tones.
export type ContextLevel = 'filling' | 'gettingFull' | 'nearlyFull';

// Context bands in ascending threshold order. Below the first threshold, context figures remain uncolored.
// Each share takes the highest threshold it reaches.
export const CONTEXT_BANDS: readonly { at: number; level: ContextLevel; word: string }[] = [
  { at: 0.5, level: 'filling', word: 'context filling up' },
  { at: 0.75, level: 'gettingFull', word: 'context getting full' },
  { at: 0.9, level: 'nearlyFull', word: 'context nearly full' },
];

// Handoff guidance for the newest session-heading context figure.
// It appears in the top two context bands, selected from the shared band table.
// Historical turn cards carry no handoff guidance.
const HANDOFF_SENTENCE = 'This is a place to compact, or to hand the work to a fresh session.';

const HANDOFF_LEVELS: readonly ContextLevel[] = CONTEXT_BANDS.slice(1).map((b) => b.level);

// Converts the shared context-band phrase into hover wording.
function bandSentence(word: string): string {
  return `The window is ${word.replace(/^context /, '')}.`;
}

// Returns the highest context band reached, or null below the first threshold.
export function bandFor(share: number): { at: number; level: ContextLevel; word: string } | null {
  let found = null;
  for (const band of CONTEXT_BANDS) {
    if (share >= band.at) {
      found = band;
    }
  }
  return found;
}

// Classifies rounded displayed percentages so equal figures have equal tones.
export function bandForPercent(percent: number): { at: number; level: ContextLevel; word: string } | null {
  return bandFor(percent / 100);
}

// Rounds percentages while reserving zero and one hundred for exact endpoints.
// Values above the window pass through. Bar-width consumers clamp separately.
export { wholePercent } from './view/tokens.ts';

// Context fields used to resolve a recorded window or model fallback.
type ContextTurn = Pick<Turn, 'contextWindow' | 'model' | 'provider' | 'contextTokens' | 'usage' | 'subagentContext'>;

const SUBAGENT_RESULTS_LABEL = 'Subagent results';
const SUBAGENT_RESULT_LINES = 5;

// A share of context in whole percent at 10% or more, and with one decimal below it.
function subagentSharePercent(tokens: number, context: number): string {
  const percent = (tokens / context) * 100;
  if (percent === 0) {
    return '0%';
  }
  return percent >= 10 ? `${Math.round(percent)}%` : `${Number(percent.toFixed(1))}%`;
}

// How much of the context holds text that subagents returned, with one line per subagent.
function subagentContextEntry(figure: SubagentContextFigure | undefined, context: number): StatDetailEntry | null {
  if (!figure || !context) {
    return null;
  }
  const part = (tokens: number) => `${formatTokens(tokens)} tokens (${subagentSharePercent(tokens, context)})`;
  const shown = figure.agents.slice(0, SUBAGENT_RESULT_LINES);
  const rest = figure.agents.slice(SUBAGENT_RESULT_LINES);
  const restTokens = rest.reduce((sum, line) => sum + line.tokens, 0);
  const share = `${subagentSharePercent(figure.tokens, context)} (${formatTokens(figure.tokens)})`;
  return {
    label: SUBAGENT_RESULTS_LABEL,
    value: figure.partial ? `at least ${share}` : share,
    valueTitle: `${figure.tokens.toLocaleString()} tokens, estimate`,
    lines: [
      ...shown.map((line) => `${line.name}: ${part(line.tokens)}`),
      ...(rest.length ? [`${rest.length} more: ${part(restTokens)}`] : []),
      ...(figure.removed ? ['The latest compaction removed earlier results.'] : []),
      ...(figure.partial ? ['Part of the session record was not read.'] : []),
      'Estimated from text size.',
    ],
  };
}

export function windowFor(turn: ContextTurn): number | null {
  return turn.contextWindow ?? contextWindowFor(turn.model, turn.provider ?? null);
}

// Returns recorded context share, or null for absent counts, unknown windows, or counts exceeding the window.
function contextShare(turn: ContextTurn): number | null {
  if (!turn.contextTokens) {
    return null;
  }
  const window = windowFor(turn);
  if (!window || turn.contextTokens > window) {
    return null;
  }
  return turn.contextTokens / window;
}

function contextChip(
  turn: ContextTurn,
  when = 'Context at the end of the turn',
  subagents = turn.subagentContext,
): StatChip | null {
  if (!turn.contextTokens) {
    return null;
  }
  const subagentEntry = subagentContextEntry(subagents, turn.contextTokens);
  const window = windowFor(turn);
  const share = contextShare(turn);
  const percent = share === null ? null : wholePercent(share);
  const band = percent === null ? null : bandForPercent(percent);
  const word = band ? (percent === 100 ? 'context full' : band.word) : undefined;
  const detailList: StatDetailList = {
    entries: [
      ...(percent !== null && window
        ? [{ label: 'Context window used', value: `${percent}% of ${formatTokens(window)}` }]
        : []),
      {
        label: when,
        value: `${turn.contextTokens.toLocaleString()} tokens`,
        ...(word ? { lines: [bandSentence(word)] } : {}),
      },
      ...(subagentEntry ? [subagentEntry] : []),
    ],
    ...(window && share !== null
      ? turn.contextWindow
        ? { notes: ['Recorded context window size.'] }
        : { footer: [`Window size from the model fallback for ${shortModel(turn.model)}.`] }
      : {}),
  };
  return {
    kind: 'plain',
    metric: 'context',
    label:
      percent !== null && window
        ? `${percent}% of ${formatTokens(window)} ctx (${formatTokens(turn.contextTokens)})`
        : `${formatTokens(turn.contextTokens)} ctx`,
    detail: flatDetailList(detailList).join('\n'),
    detailList,
    ...(band ? { level: band.level, word } : {}),
  };
}

// Formats nonzero added and removed line counts with the shared diff wording.
function diffValue(added: number, removed: number): string {
  return diffHalves(added, removed)
    .map((half) => half.text)
    .join(' ');
}

// Count-dependent words reused by file-coverage clauses.
interface FileCauseWords {
  count: number;
  files: string;
  was: string;
  its: string;
  plural: boolean;
}

// File-count coverage clauses in display order. The type requires every cause to have a formatter.
// Clauses allow several calls to contribute the same file count.
const FILE_COUNT_CAUSES: Record<FileCountReason, (words: FileCauseWords) => string> = {
  write: ({ count, files, was }) => `${count} ${files} ${was} written whole`,
  shell: ({ count, files, was, its }) => `${count} ${files} ${was} named by the shell without ${its} lines`,
  replaceAll: ({ count, files, was }) =>
    `${count} ${files} ${was} edited with replace_all, which does not say how many times it matched`,
  // The notebook's cells rather than one cell, so the clause stays true of a file that lost
  // several cells and of several files at once.
  notebook: ({ count, files, was, its, plural }) =>
    `${count} ${files} ${was} ${plural ? 'notebooks' : 'a notebook'} edited with no record of what ${its} cells held before`,
  zero: ({ count, files, was }) => `${count} ${files} ${was} edited with nothing a line count can see`,
};
const FILE_COUNT_CAUSE_ORDER = Object.keys(FILE_COUNT_CAUSES) as FileCountReason[];

function fileCauseWords(count: number): FileCauseWords {
  const plural = count !== 1;
  return {
    count,
    plural,
    files: plural ? 'files' : 'file',
    was: plural ? 'were' : 'was',
    its: plural ? 'their' : 'its',
  };
}

// Coverage status used in file-record sentences, separate from figure labels.
const FILE_COUNTS_PARTIAL = 'partial';

// Explains a coverage cause and whether line counts remain unknown or partial.
function fileCauseSentence(cause: FileCountReason, count: number, settled: 'unknown' | 'partial'): string {
  const words = fileCauseWords(count);
  const tail =
    settled === 'partial'
      ? `${words.its} line counts are ${FILE_COUNTS_PARTIAL}`
      : cause === 'write'
        ? `${words.its} old lines are unknown`
        : `${words.its} line counts are unknown`;
  return `${FILE_COUNT_CAUSES[cause](words)}, so ${tail}.`;
}

interface FileCountFlags {
  countsUnknown?: true;
  unknownReason?: FileCountReason;
  countsPartial?: true;
}

// Groups file-count caveats by recorded cause and unknown or partial status.
// Rows without a cause retain their coverage status. Each sentence names its file count.
function fileCountCaveats(files: readonly FileCountFlags[]): string[] {
  const tally = {
    unknown: new Map<FileCountReason | null, number>(),
    partial: new Map<FileCountReason | null, number>(),
  };
  for (const file of files) {
    const settled = file.countsUnknown ? tally.unknown : file.countsPartial ? tally.partial : null;
    if (!settled) {
      continue;
    }
    const cause = file.unknownReason ?? null;
    settled.set(cause, (settled.get(cause) ?? 0) + 1);
  }
  const sentences: string[] = [];
  for (const settled of ['unknown', 'partial'] as const) {
    for (const cause of FILE_COUNT_CAUSE_ORDER) {
      const count = tally[settled].get(cause) ?? 0;
      if (count) {
        sentences.push(fileCauseSentence(cause, count, settled));
      }
    }
    const bare = tally[settled].get(null) ?? 0;
    if (bare) {
      const { files, plural } = fileCauseWords(bare);
      sentences.push(
        `${bare} ${files} ${plural ? 'carry' : 'carries'} ${settled === 'unknown' ? 'no' : FILE_COUNTS_PARTIAL} line counts.`,
      );
    }
  }
  return sentences;
}

// Combines file and line counts. Coverage caveats appear in the opened record.
function filesAndLines(files: number, added: number, removed: number, detail: string): StatChip {
  const count = `${files} file${files === 1 ? '' : 's'}`;
  // Accessible line counts omit zero values and name lines before the first nonzero count.
  const lines =
    added > 0 && removed > 0
      ? `${added} line${added === 1 ? '' : 's'} added, ${removed} removed`
      : added > 0
        ? `${added} line${added === 1 ? '' : 's'} added`
        : removed > 0
          ? `${removed} line${removed === 1 ? '' : 's'} removed`
          : '';
  return {
    kind: 'diff',
    label: count,
    name: `${count}${lines ? `, ${lines}` : ''}`,
    detail,
    added,
    removed,
  };
}

// Builds one ordered figure row shared by expanded and folded cards.
// Cost, context, and files precede token usage, repository work, and subagents.
// Record layouts use the card's arrays. They do not duplicate those rows in chip entries.

function chipsOf(
  turn: Turn,
  status: TurnStatus,
  sessionLive: AgentLive,
  // The turn's own changed files and every child's, as `attributedFiles` merged them.
  changed: AttributedFile[],
  added: number,
  removed: number,
  commitCards: CommitCard[],
  landingCards: CommitCard[],
  subagentCommitCount: number,
  subagentFileCount: number,
  // How many live carried subagents the newest card counts.
  carried = 0,
  // The dispatched sessions the card counts in its cost.
  dispatched: readonly DispatchedTurnCost[] = [],
  expiry: CacheExpiryWarning | null = null,
): StatChip[] {
  const chips: StatChip[] = [];
  const shares = dispatched.map((cost) => dispatchedShare(turn, cost));
  const total = cardCostOf(turn, shares);
  // Keep a dispatched cost figure even when the parsed turn has no priced usage.
  const cost = formatCost(total.dollars) ?? (shares.length ? ZERO_COST : null);
  if (cost) {
    const writeWarnings = cacheWriteWarnings(turnCacheWriteScopes(turn, turn.finished));
    const detailList = costDetailList(
      turn,
      writeWarnings,
      (agent) => agentState(agent, status === 'running', sessionLive) === 'open',
      shares,
      expiry,
    );
    const warnings: (CacheWriteWarning | CacheExpiryWarning)[] = [
      ...(expiry &&
      ((expiry.dollars !== null && expiry.dollars >= CACHE_EXPIRY_SIGN_DOLLARS) ||
        (expiry.main?.dollars !== null &&
          expiry.main?.dollars !== undefined &&
          expiry.main.dollars >= CACHE_EXPIRY_SIGN_DOLLARS))
        ? [expiry]
        : []),
      ...writeWarnings,
    ];
    const detail = flatDetailList(detailList).join('\n');
    chips.push({
      kind: 'plain',
      metric: 'cost',
      label: cost + (total.partial ? '+' : ''),
      detail,
      detailList,
      ...(warnings.length
        ? { warnings, name: detail, headDetail: true as const }
        : turn.agents.length || dispatched.length
          ? { name: detail, headDetail: true as const }
          : {}),
    });
  }
  const ctxChip = contextChip(turn);
  if (ctxChip) {
    chips.push(ctxChip);
  }
  if (changed.length) {
    const caveats = fileCountCaveats(changed);
    const detailList: StatDetailList = {
      layout: 'files',
      actions: true,
      heading: {
        label: `${changed.length} file${changed.length === 1 ? '' : 's'}`,
        diff: { added, removed },
      },
      entries: changed.map((file) =>
        file.countsUnknown
          ? { label: baseName(file.path) }
          : {
              label: baseName(file.path),
              value: [diffValue(file.added, file.removed), file.isNew ? 'new' : ''].filter(Boolean).join(' '),
            },
      ),
      // File-count caveats remain in the footer alongside the displayed card rows.
      ...(caveats.length ? { footer: caveats } : {}),
    };
    // Exclude the footer from flat detail to send each caveat once.
    const files = filesAndLines(
      changed.length,
      added,
      removed,
      flatDetailList({ ...detailList, footer: undefined }).join('\n'),
    );
    chips.push({
      ...files,
      // Include the subagent-changed file count in the accessible name.
      ...(subagentFileCount ? { name: `${files.name}, ${subagentFileCount} changed by a subagent` } : {}),
      metric: 'files',
      detailList,
    });
  } else if (
    status !== 'running' &&
    (turn.toolUses > 0 || turn.agents.length > 0 || turn.commits.length > 0 || turn.usage.output > 0)
  ) {
    // A nonrunning turn that did something but recorded no file changes names the recording limits.
    // This does not establish that the turn changed no files.
    // A turn where nothing happened shows no files figure, because it had no work that could change a file.
    const detailList: StatDetailList = {
      heading: { label: 'No file changes recorded for this turn' },
      entries: [
        {
          label: 'Not counted',
          lines: [
            'Changes outside edit tools',
            'Delegated changes Arc could not read',
            'Changes in scratch directories',
          ],
        },
      ],
    };
    chips.push({
      kind: 'plain',
      metric: 'files',
      label: 'no file changes',
      detail: flatDetailList(detailList).join('\n'),
      detailList,
    });
  }
  // Separate input and output token totals, including repeated context input across requests.
  const read =
    turn.usage.input +
    turn.usage.cacheRead +
    turn.usage.cacheWrite1h +
    turn.usage.cacheWrite5m +
    (turn.usage.cacheWrite30m ?? 0);
  if (read || turn.usage.output) {
    const parts: string[] = [];
    if (read) {
      parts.push(`${formatTokens(read)} in`);
    }
    if (turn.usage.output) {
      parts.push(`${formatTokens(turn.usage.output)} out`);
    }
    chips.push({
      kind: 'plain',
      metric: 'tokens',
      label: parts.join(' · '),
      detail: tokenLines(turn).join('\n'),
      detailList: tokenDetailList(turn),
    });
  }
  // Repository work lists commits and landings separately. Landings do not increase the commit count.
  if (commitCards.length || landingCards.length) {
    const counted = commitCards.filter((c) => c.added !== null && c.removed !== null);
    const label = repositoryWorkLabel(commitCards.length, landingCards.length);
    // A single commit group moves its branch fact to the section heading.
    const grouping = groupCommitRows([...commitCards, ...landingCards]);
    const single = grouping.single ? grouping.groups[0] : null;
    const detailList: StatDetailList = {
      layout: 'commits',
      actions: true,
      heading: {
        label,
        ...(single ? { fact: commitHeadFact(single) } : {}),
        ...(counted.length
          ? {
              diff: {
                added: counted.reduce((sum, c) => sum + (c.added ?? 0), 0),
                removed: counted.reduce((sum, c) => sum + (c.removed ?? 0), 0),
              },
            }
          : {}),
      },
      entries: [...commitCards, ...landingCards]
        .sort((a, b) => a.at - b.at)
        .map((c) => ({
          label: c.sha,
          value: c.kind === 'landing' ? `merged into ${c.landingTarget}` : c.subject,
        })),
    };
    chips.push({
      kind: 'plain',
      metric: 'commits',
      label,
      name: label + (subagentCommitCount ? `, ${subagentCommitCount} made by a subagent` : ''),
      focusable: true,
      detail: flatDetailList(detailList).join('\n'),
      detailList,
    });
  }
  // Subagent figures follow totals that already include their costs, files, and commits.
  if (turn.agents.length || carried > 0) {
    const displays = turn.agents.map((a) => agentDisplay(a, status === 'running', sessionLive));
    const carriedLine = carriedAgentsLine(carried);
    const detail = [
      ...turn.agents.map((a, index) => [a.description, displays[index].summary].filter(Boolean).join('\n  ')),
      ...(carriedLine ? [carriedLine] : []),
    ].join('\n');
    // Include live carried children and eligible children that outlive this turn.
    // Require current child liveness and running display state for this turn's rows.
    const live =
      carried +
      (!childrenOutliveTurn(status)
        ? 0
        : turn.agents.filter(
            (agent) =>
              agent.id &&
              sessionLive.children.has(agent.id) &&
              agentState(agent, status === 'running', sessionLive) === 'running',
          ).length);
    const count = turn.agents.length + carried;
    chips.push({
      kind: 'plain',
      metric: 'agents',
      label: `${count} subagent${count === 1 ? '' : 's'}`,
      ...(live > 0 ? { running: live } : {}),
      detail,
      detailList: agentDetailList(turn.agents, status === 'running', sessionLive, true, carried),
      ...(!cost ? { name: detail, headDetail: true as const } : {}),
    });
  }
  return chips;
}

function inputSideTokens(usage: Turn['usage']): number {
  return usage.input + usage.cacheRead + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0);
}

export function averageContextPerRequest(usage: Turn['usage']): number | null {
  const requests = usage.requests ?? 0;
  return requests > 0 ? inputSideTokens(usage) / requests : null;
}

// Selects a summary headline, error, running prompt, or stock ending text.
// Callers share the readable rich-text summary and its selected headline source with inline headline rendering.
export function headlineFor(
  turn: Pick<Turn, 'summary' | 'error' | 'prompt'>,
  status: TurnStatus,
  readableSummary: string = readableRichText(turn.summary),
  source: HeadlineSource | null = headlineSourceOf(readableSummary),
): string {
  const headline = headlineOf(readableSummary, source);
  if (headline) {
    return headline;
  }
  if (turn.error) {
    return turn.error.split('\n')[0];
  }
  // A running turn without a summary displays its prompt, or a stock working message.
  if (status === 'running') {
    return turn.prompt.trim() ? firstLine(turn.prompt) : 'Still working.';
  }
  if (status === 'interrupted') {
    return 'Stopped by you before it answered.';
  }
  return 'Ended without a closing message.';
}

// Renders summary-derived headline Markdown only when its visible text matches the plain headline.
// A mismatch leaves the plain headline for consistent display, hover, and accessible text.
function headlineHtmlFor(
  summaryText: string,
  headline: string,
  source: HeadlineSource | null = headlineSourceOf(summaryText),
): string | undefined {
  if (!source || source.fenced) return undefined;
  const line = withoutLeadingSymbol(source.text.trim());
  if (line === headline) {
    return undefined;
  }
  const html = renderInlineMarkdown(line, undefined, true);
  return visibleTextOf(html) === headline ? html : undefined;
}

// Completed answers other than the selected response, in reverse record order.
// `notResponse` answers remain eligible even when newer than the response.
// Waiting marks continue to read only the response summary.
export function earlierAnswersOf(turn: Pick<Turn, 'answers' | 'summary'>, now: number = Date.now()): AnswerCard[] {
  return earlierAnswers(turn).map((a) => ({ summary: a.text, at: a.at, absolute: formatWhen(a.at, now) }));
}

function earlierAnswers(turn: Pick<Turn, 'answers' | 'summary'>): TurnAnswer[] {
  const response = responseAnswerIndex(turn);
  return turn.answers.filter((_, index) => index !== response).reverse();
}

// Combines commentary and nonresponse answers in timestamp order. Reasoning remains in Activity.
// Equal timestamps preserve source order, with commentary before answers.
// `answerIndex` preserves newest-first comment anchors independently of display position.
// IDs use kind, timestamp, and the ordinal among entries sharing both.
export function saidMessagesOf(
  turn: Pick<Turn, 'answers' | 'summary' | 'updates'>,
  now: number = Date.now(),
): SaidCard[] {
  const said = (turn.updates ?? [])
    .filter((update) => update.kind === 'commentary')
    .map((update) => ({
      kind: 'commentary' as const,
      at: update.at,
      text: update.text,
      stepsBefore: update.stepsBefore,
    }));
  // Restore record order while preserving the newest-first answer index used by comment anchors.
  const answers = earlierAnswers(turn)
    .map((answer, index) => ({
      kind: 'answer' as const,
      at: answer.at,
      text: answer.text,
      answerIndex: index,
      stepsBefore: answer.stepsBefore,
    }))
    .reverse();
  const ordered = [...said, ...answers].sort((one, other) => one.at - other.at);
  const ordinals = new Map<string, number>();
  return ordered.map((entry) => {
    const stamp = `${entry.kind}:${entry.at}`;
    const n = ordinals.get(stamp) ?? 0;
    ordinals.set(stamp, n + 1);
    // Zero timestamps produce no clock text.
    return {
      ...entry,
      id: `${stamp}:${n}`,
      when: entry.at ? formatClock(entry.at) : '',
      absolute: entry.at ? formatWhen(entry.at, now) : '',
    };
  });
}

// Counts all messages and nonzero replies for section headings and accessible names.
function saidCounts(messages: readonly Pick<SaidCard, 'kind'>[]): string[] {
  if (!messages.length) {
    return [];
  }
  const replies = messages.filter((m) => m.kind === 'answer').length;
  const parts = [messages.length === 1 ? '1 message' : `${messages.length} messages`];
  if (replies) {
    parts.push(replies === 1 ? '1 reply' : `${replies} replies`);
  }
  return parts;
}
// Accessible name for the Said section, including message counts.
export function saidName(messages: readonly SaidCard[]): string {
  return [CARD_ACTIONS.saidSection, ...saidCounts(messages)].join(', ');
}
export function saidMix(messages: readonly SaidCard[]): string {
  return saidCounts(messages).join(', ');
}

// Uses present duration wording for running turns and past wording for terminal states.
export function durationWord(status: TurnStatus): string {
  return status === 'running' ? CARD_ACTIONS.runningFor : CARD_ACTIONS.ranFor;
}

// Completed and running verbs for known tools from both agents.
// Unknown tool names retain their recorded spelling.
const STEP_VERBS: Record<string, [string, string]> = {
  Read: ['Read', 'Reading'],
  Edit: ['Edited', 'Editing'],
  Write: ['Wrote', 'Writing'],
  NotebookEdit: ['Edited', 'Editing'],
  Bash: ['Ran', 'Running'],
  PowerShell: ['Ran', 'Running'],
  Grep: ['Searched for', 'Searching for'],
  Glob: ['Matched', 'Matching'],
  WebFetch: ['Fetched', 'Fetching'],
  WebSearch: ['Searched the web for', 'Searching the web for'],
  ToolSearch: ['Searched tools for', 'Searching tools for'],
  Task: ['Started a subagent:', 'Starting a subagent:'],
  Agent: ['Started a subagent:', 'Starting a subagent:'],
  SendMessage: ['Messaged a subagent:', 'Messaging a subagent:'],
  TaskOutput: ['Read subagent output:', 'Reading subagent output:'],
  TaskStop: ['Stopped a subagent:', 'Stopping a subagent:'],
  SubagentHandback: ['Handed back the report', 'Handing back the report'],
  ListAgents: ['Checked subagents', 'Checking subagents'],
  AskUserQuestion: ['Asked', 'Asking'],
  SendUserFile: ['Sent', 'Sending'],
  ReportFindings: ['Reported', 'Reporting'],
  TodoWrite: ['Updated tasks', 'Updating tasks'],
  Skill: ['Loaded', 'Loading'],
  // Codex names its own. An older or ambiguous exec record can still carry no detail.
  exec: ['Ran', 'Running'],
  exec_command: ['Ran', 'Running'],
  shell: ['Ran', 'Running'],
  Shell: ['Ran', 'Running'],
  apply_patch: ['Edited', 'Editing'],
  update_plan: ['Updated plan', 'Updating plan'],
  wait: ['Waited for subagents', 'Waiting for subagents'],
  wait_agent: ['Waited for subagents', 'Waiting for subagents'],
  send_message: ['Messaged a subagent:', 'Messaging a subagent:'],
  followup_task: ['Followed up with a subagent:', 'Following up with a subagent:'],
  list_agents: ['Checked subagents', 'Checking subagents'],
  web_search: ['Searched the web', 'Searching the web'],
  web__run: ['Used the web', 'Using the web'],
  spawn_agent: ['Started a subagent:', 'Starting a subagent:'],
  view_image: ['Viewed', 'Viewing'],
  write_stdin: ['Continued command', 'Continuing command'],
};

const LIVE_COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'Shell', 'shell', 'exec', 'exec_command']);

// Protocol activity timestamped on arrival for ordering beside recorded prompts and calls.
export interface TimedWireActivity extends WireActivity {
  at: number;
}

function activityCountOf(turn: Pick<Turn, 'stepCount' | 'steps'>): number {
  let count = turn.stepCount;
  for (const step of turn.steps) count = Math.max(count, step.ordinal);
  return count;
}

export interface PendingAskPosition {
  stepsBefore?: number;
  turnStartedAt?: number;
  afterTurnStartedAt?: number;
}

export function pendingAskPosition(
  recorded: Turn | undefined,
  activity: readonly TimedWireActivity[],
  since: number | undefined,
): PendingAskPosition {
  if (recorded && !recorded.finished && (since === undefined || recorded.endedAt >= since)) {
    return { stepsBefore: activityCountOf(withLiveActivity(recorded, activity)), turnStartedAt: recorded.startedAt };
  }
  const boundary = Math.max(since ?? 0, recorded?.endedAt ?? 0);
  const calls = activity.filter(
    (item) => item.at >= boundary && item.kind !== 'commentary' && item.kind !== 'reasoning',
  );
  return {
    stepsBefore: new Set(calls.map((item) => item.sourceId)).size,
    ...(recorded ? { afterTurnStartedAt: recorded.startedAt } : {}),
  };
}

// Adds temporary live activity to a cloned turn.
// Recorded source IDs suppress matching live copies when the transcript catches up.
export function withLiveActivity(turn: Turn, activity: readonly TimedWireActivity[]): Turn {
  if (!activity.length) {
    return turn;
  }
  const known = new Set<string>();
  for (const step of turn.steps) {
    if (step.sourceId) {
      known.add(step.sourceId);
    }
  }
  for (const update of turn.updates ?? []) {
    known.add(update.sourceId);
  }
  const steps = [...turn.steps];
  const stepKinds = [...turn.stepKinds];
  const updates = [...(turn.updates ?? [])];
  let ordinal = activityCountOf(turn);
  let changed = false;
  for (const item of activity) {
    if (item.at < turn.startedAt || known.has(item.sourceId)) {
      continue;
    }
    const text = item.detail.trim();
    if (item.kind === 'commentary' || item.kind === 'reasoning') {
      if (!text) {
        continue;
      }
      updates.push({
        stepsBefore: ordinal,
        sourceId: item.sourceId,
        kind: item.kind,
        text,
        at: item.at,
        status: item.status,
      });
      known.add(item.sourceId);
      changed = true;
      continue;
    }
    const detail = shortenTo(text.replace(/\s+/g, ' '), STEP_DETAIL_LIMIT, STEP_CUT);
    let name = item.name;
    let headline = item.headline.trim();
    if (headline === name || ['Running', 'Ran', 'Editing', 'Edited'].includes(headline)) {
      headline = '';
    }
    // Use the collaboration event's readable headline as the row label.
    if (item.kind === 'collaboration' && headline) {
      name = headline;
      headline = '';
    }
    const step: TurnStep = {
      ordinal: ++ordinal,
      name,
      sourceId: item.sourceId,
      ...(headline ? { headline } : {}),
      detail,
      at: item.at,
      status: item.status,
    };
    if (text && (LIVE_COMMAND_TOOLS.has(item.name) || text !== detail)) {
      Object.defineProperty(step, 'fullDetail', {
        value: text,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    steps.push(step);
    // Classify live skill loads separately from tool categories, matching recorded loads.
    stepKinds[step.ordinal - 1] =
      item.name === 'Skill'
        ? SKILL_STEP_KIND
        : (CLAUDE_TOOL_KIND[item.name] ??
          CODEX_TOOL_KIND[item.name] ??
          (LIVE_COMMAND_TOOLS.has(item.name) ? 'commands' : 'other'));
    known.add(item.sourceId);
    changed = true;
  }
  return changed ? { ...turn, steps, updates, stepKinds } : turn;
}

// Tools whose details display as prose rather than code.
const STEP_PROSE: ReadonlySet<string> = new Set([
  'Skill',
  'Task',
  'Agent',
  'spawn_agent',
  'WebSearch',
  'web_search',
  'ToolSearch',
  'SendMessage',
  'TaskOutput',
  'TaskStop',
  'AskUserQuestion',
  'ReportFindings',
  'send_message',
  'followup_task',
  'web__run',
]);

// The words one step is drawn as, in front of whatever `stepCode` gives back.
export function stepLine(step: TurnStep): string {
  const pair = STEP_VERBS[step.name];
  const headline = step.headline
    ? shortenTo(step.headline.replace(/\s+/g, ' ').trim(), STEP_DETAIL_LIMIT, STEP_CUT)
    : '';
  if (!pair) {
    if (headline) {
      return `${step.name}: ${headline}${step.detail ? ':' : ''}`;
    }
    return step.detail ? `${step.name}:` : step.name;
  }
  const verb = step.status === 'running' ? pair[1] : pair[0];
  // A skill is the one row whose noun needs saying: "Loaded polish" reads as a file.
  if (step.name === 'Skill') {
    return step.detail ? `${verb} the ${step.detail} skill` : `${verb} a skill`;
  }
  if (headline) {
    const state = step.status === 'interrupted' ? 'stopped' : step.status;
    return `${headline} (${state})${step.detail ? ':' : ''}`;
  }
  // Remove a trailing colon when the step has no detail.
  if (!step.detail) {
    return verb.endsWith(':') ? verb.slice(0, -1) : verb;
  }
  return STEP_PROSE.has(step.name) ? `${verb} ${step.detail}` : verb;
}

// Returns literal tool detail for code type. Prose details remain in the row's words.
export function stepCode(step: TurnStep): string {
  return step.detail && !STEP_PROSE.has(step.name) ? step.detail : '';
}

// Trailing text for failed or interrupted steps without their own headline.
export function stepFigure(step: TurnStep): string {
  if (step.headline) {
    return '';
  }
  return step.status === 'failed' ? 'failed' : step.status === 'interrupted' ? 'stopped' : '';
}

function activityStepName(step: TurnStep): string {
  const exact = step.fullDetail ? { ...step, detail: step.fullDetail } : step;
  const status = step.status === 'done' ? 'done' : step.status === 'interrupted' ? 'stopped' : step.status;
  return [stepLine(exact), stepCode(exact), step.headline ? '' : stepFigure(exact) || status].filter(Boolean).join(' ');
}

// Pending mid-turn prompt absent from the transcript.
// Require running state and the captured turn boundary.
// A matching recorded prompt suppresses the temporary copy.
export function pendingAskOf(
  turn: Pick<Turn, 'laterPrompts' | 'startedAt' | 'stepCount'>,
  press: ({ text: string; at: number; midTurn: boolean } & PendingAskPosition) | null,
  running: boolean,
): TurnAsk | null {
  if (!press || !press.midTurn || !running) {
    return null;
  }
  if (press.at < turn.startedAt) {
    return null;
  }
  if (press.turnStartedAt !== undefined && press.turnStartedAt !== turn.startedAt) {
    return null;
  }
  if (press.afterTurnStartedAt !== undefined && turn.startedAt <= press.afterTurnStartedAt) {
    return null;
  }
  const text = cleanPrompt(press.text);
  if (!text) {
    return null;
  }
  if (turn.laterPrompts.some((a) => a.text === text)) {
    return null;
  }
  return { text, at: press.at, stepsBefore: press.stepsBefore ?? turn.stepCount };
}

// Activity preview of a mid-turn prompt. You asked displays its complete text.
export function askLine(ask: TurnAsk): string {
  return `You asked: ${shortenTo(firstLine(ask.text), STEP_DETAIL_LIMIT, STEP_CUT)}`;
}

// Combines tool runs, prompts, messages, and reasoning by recorded step position and timestamp.
export function logOf(
  turn: Turn,
  pending: TurnAsk | null = null,
  running: boolean = true,
  now: number = Date.now(),
): { rows: ActivityRow[]; messages: SaidCard[]; counts: string[] } {
  const launches = agentLaunches(turn);
  const stepRow = (step: TurnStep): ActivityRow => ({
    id: `step:${step.ordinal}`,
    at: step.at,
    hintDetail: [step.at ? formatWhen(step.at, now) : '', CARD_ACTIONS.logRowsDetail].filter(Boolean).join('. '),
    ...(step.sourceId ? { sourceId: step.sourceId } : {}),
    kind: 'step',
    status: step.status,
    line: stepLine(step),
    code: stepCode(step),
    figure:
      stepFigure(step) ||
      (() => {
        const launch = step.id ? launches.get(step.id) : undefined;
        return launch?.step === step ? agentOutcome(launch.agent) : '';
      })(),
    // Start the elapsed clock only for a running step on a running turn.
    since: running && step.status === 'running' ? step.at : null,
    title: step.fullDetail ?? (stepCode(step) ? step.detail : ''),
    ...(step.fullDetail || stepCode(step) ? { name: activityStepName(step) } : {}),
  });
  const askRow = (ask: TurnAsk): ActivityRow => ({
    kind: 'ask',
    // Prompt rows represent completed submissions and carry no elapsed clock.
    status: 'done',
    line: askLine(ask),
    code: '',
    figure: '',
    since: null,
    title: '',
  });
  const updateRow = (update: TurnUpdate): ActivityRow => ({
    sourceId: update.sourceId,
    kind: update.kind,
    status: update.status,
    // Wrap narration as prose within the narration payload limit.
    line: shortenTo(update.text.replace(/\s+/g, ' ').trim(), NARRATION_DETAIL_LIMIT, STEP_CUT),
    code: '',
    figure: update.status === 'failed' ? 'failed' : '',
    since: running && update.status === 'running' ? update.at : null,
    title: update.text,
  });
  const rows: ActivityRow[] = [];
  const messages = saidMessagesOf(turn, now);
  const waiting = pending ? [...turn.laterPrompts, pending] : turn.laterPrompts;
  const prose = [
    ...waiting.map((ask) => ({ ...ask, row: askRow(ask) })),
    ...messages.map((message) => ({
      ...message,
      row: {
        ...message,
        kind: 'message' as const,
        messageKind: message.kind,
        spoken: [message.kind === 'answer' ? CARD_ACTIONS.saidReplied : '', message.absolute]
          .filter(Boolean)
          .join(', '),
        status: 'done' as const,
        line: '',
        code: '',
        figure: '',
        since: null,
        title: '',
      },
    })),
    ...(turn.updates ?? [])
      .filter((update) => update.kind === 'reasoning')
      .map((update) => ({ ...update, row: updateRow(update) })),
  ].sort((one, other) => one.stepsBefore - other.stepsBefore || one.at - other.at);
  let before = 0;
  let previousAt = turn.startedAt;
  let stepIndex = 0;
  let failedIndex = 0;
  const failedOrdinals = [
    ...new Set([
      ...turn.failedOrdinals,
      ...turn.steps.filter((step) => step.status === 'failed').map((step) => step.ordinal),
    ]),
  ].sort((a, b) => a - b);
  const appendRun = (end: number) => {
    if (end <= before) {
      return;
    }
    const first = before + 1;
    const kept: TurnStep[] = [];
    while (stepIndex < turn.steps.length && turn.steps[stepIndex].ordinal <= end) {
      const step = turn.steps[stepIndex++];
      if (step.ordinal >= first) kept.push(step);
    }
    let failedCount = 0;
    while (failedIndex < failedOrdinals.length && failedOrdinals[failedIndex] <= end) {
      if (failedOrdinals[failedIndex++] >= first) failedCount++;
    }
    const count = end - before;
    before = end;
    if (count === 1 && kept.length === 1) {
      rows.push(stepRow(kept[0]));
      return;
    }
    const earlier = count - kept.length;
    const kinds = { edits: 0, reads: 0, searches: 0, commands: 0, agents: 0, coordination: 0, web: 0, other: 0 };
    for (let ordinal = first; ordinal <= end; ordinal++) {
      countStepKind(kinds, turn.stepKinds[ordinal - 1]);
    }
    const mix = toolMixOf(kinds);
    const inFlight = running && kept.some((step) => step.status === 'running');
    const line = `${count} ${kept.length ? '' : 'earlier '}tool ${count === 1 ? 'call' : 'calls'}`;
    const start = kept[0]?.at || previousAt;
    const finish = kept[kept.length - 1]?.at || start;
    const span = inFlight ? `Started ${formatWhen(start, now)}` : `${formatWhen(start, now)} to ${formatClock(finish)}`;
    rows.push({
      kind: 'run',
      id: `run:${first}`,
      count,
      earlier,
      failed: failedCount,
      mix,
      line,
      earlierLine: earlier === 1 ? 'and 1 earlier step' : `and ${earlier} earlier steps`,
      label: [
        line,
        failedCount ? `${failedCount} failed` : '',
        inFlight ? CARD_ACTIONS.logRunning : '',
        earlier && kept.length ? `${earlier} earlier` : '',
        mix.replace(/ · /g, ', '),
      ]
        .filter(Boolean)
        .join(', '),
      hint: inFlight ? CARD_ACTIONS.logRunHide : CARD_ACTIONS.logRunShow,
      hintDetail: `${span}. ${CARD_ACTIONS.logRowsDetail}`,
      inFlight,
      status: inFlight ? 'running' : kept.some((step) => step.status === 'interrupted') ? 'interrupted' : 'done',
      steps: kept.map(stepRow),
      code: '',
      figure: failedCount ? `${failedCount} failed` : '',
      since: null,
      title: '',
    });
  };
  for (const entry of prose) {
    appendRun(entry.stepsBefore);
    rows.push(entry.row);
    previousAt = entry.at;
  }
  appendRun(activityCountOf(turn));
  return {
    rows,
    messages,
    counts: saidCounts(rows.filter((row) => row.kind === 'message').map((row) => ({ kind: row.messageKind! }))),
  };
}

// Accessible Activity heading with message, step, tool, and prompt counts.
function activityName(count: number, asks: number, counts: readonly string[], tools: string): string {
  const parts: string[] = ['Activity', ...counts];
  // Omit step counts when no tool calls exist.
  if (count) {
    parts.push(count === 1 ? '1 step' : `${count} steps`);
    if (tools) {
      parts.push(tools);
    }
  }
  if (asks) {
    parts.push(asks === 1 ? '1 prompt' : `${asks} prompts`);
  }
  return parts.join(', ');
}

// Returns the newest retained step still recorded as running.
export function doingOf(turn: Turn): TurnStep | null {
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    if (turn.steps[i].status === 'running') {
      return turn.steps[i];
    }
  }
  return null;
}

function latestCommentaryOf(turn: Turn): TurnUpdate | null {
  const updates = turn.updates ?? [];
  for (let i = updates.length - 1; i >= 0; i--) {
    if (updates[i].kind === 'commentary') {
      return updates[i];
    }
  }
  return null;
}

// The newest eligible card counts live child IDs absent from its own subagent rows.
export function carriedSubagentCount(
  turn: Pick<Turn, 'agents'>,
  isLatest: boolean,
  status: TurnStatus,
  liveChildren: ReadonlySet<string>,
): number {
  return isLatest && childrenOutliveTurn(status)
    ? [...liveChildren].filter((id) => !turn.agents.some((agent) => agent.id === id)).length
    : 0;
}

export function commitRowsOf(turn: Turn, now: number = Date.now(), folders: readonly string[] = []) {
  const commits = attributedCommits(turn).map(({ commit, madeBy, madeBySession }) =>
    commitCard(commit, now, madeBy, madeBySession, folders),
  );
  const landings = (turn.landings ?? []).map((landing) => landingCard(landing, folders, now));
  return { commits, landings, rows: [...commits, ...landings].sort((a, b) => a.at - b.at) };
}

export function toCard(
  turn: Turn,
  isLatest: boolean,
  now: number = Date.now(),
  folders: string[] = [],
  press: ({ text: string; at: number; midTurn: boolean } & PendingAskPosition) | null = null,
  sessionLive: boolean = false,
  // The ids of the session's live open background children, from `liveOpenChildren`.
  liveChildren: ReadonlySet<string> = new Set(),
  // The dispatched sessions the card counts in its cost, from `countedDispatchedCosts`.
  dispatched: readonly DispatchedTurnCost[] = [],
  // The return to an expired cache that opened this turn, from `turnCacheExpiryWarning`.
  expiry: CacheExpiryWarning | null = null,
): TurnCard {
  const live: AgentLive = { session: sessionLive, children: liveChildren };
  let added = 0;
  let removed = 0;
  // Use the combined parent and child file list for rows and figures.
  const changed = attributedFiles(turn);
  // Exclude unknown-count rows from line totals. Partial rows retain their measured lines.
  for (const f of changed) {
    if (f.countsUnknown) {
      continue;
    }
    added += f.added;
    removed += f.removed;
  }
  const status = statusOf(turn, isLatest, now);
  const relative = formatRelative(turn.startedAt, now);
  const durationEnd =
    status === 'running' ? now : status === 'stopped' ? (turn.processEndedAt ?? turn.endedAt) : turn.endedAt;
  const duration = formatDuration(durationEnd - turn.startedAt);
  const lastRelative = formatRelative(turn.endedAt, now);
  const model = shortModel(turn.model);
  const readableSummary = readableRichText(turn.summary);
  const headlineSource = headlineSourceOf(readableSummary);
  const headline = withoutLeadingSymbol(headlineFor(turn, status, readableSummary, headlineSource));
  const headlineHtml = headlineHtmlFor(readableSummary, headline, headlineSource);
  const rows = closingRows(turn.summary);
  // Select current activity only while the turn displays running.
  const onNow = status === 'running' ? doingOf(turn) : null;
  const narration = status === 'running' && !onNow ? latestCommentaryOf(turn) : null;
  // Add a pending mid-turn prompt until the transcript records it.
  const pending = pendingAskOf(turn, press, status === 'running');
  const asked = pending ? [...turn.laterPrompts, pending] : turn.laterPrompts;
  const waiting = waitingFrom(rows);
  // Share Activity rows and counts across visible and accessible projections.
  const log = logOf(turn, pending, status === 'running', now);
  const activityCounts: ToolCounts = {
    edits: 0,
    reads: 0,
    searches: 0,
    commands: 0,
    agents: 0,
    coordination: 0,
    web: 0,
    other: 0,
  };
  for (const kind of turn.stepKinds) {
    countStepKind(activityCounts, kind);
  }
  const activityToolCategories = toolCategoriesOf(turn.stepKinds.length ? activityCounts : turn.toolCounts);
  const activitySkills = activitySkillsOf(turn.skillUses);
  const activityTools = activityToolCategories.map(({ count, label }) => `${count} ${label}`).join(' · ');
  const activityCount = activityCountOf(turn);
  const said = log.messages;
  const marks = marksOf(turn, added, removed, waiting);
  const key = turnKey(turn);
  const fileCards = fileCardsOf(changed, folders);
  const launches = agentLaunches(turn);
  const rowPaths = fileRowPathsByKey(changed);
  const agentCards = turn.agents.map((agent) =>
    agentCard(agent, status === 'running', live, launches, rowPaths, now, turn.agent),
  );
  const { commits: commitCards, landings: landingCards, rows: commitRows } = commitRowsOf(turn, now, folders);
  const subagentCommitCount = commitCards.filter((commit) => Boolean(commit.madeBy)).length;
  const subagentFileCount = changed.filter((file) => Boolean(file.madeBy)).length;
  const carried = carriedSubagentCount(turn, isLatest, status, liveChildren);
  const chips = chipsOf(
    turn,
    status,
    live,
    changed,
    added,
    removed,
    commitCards,
    landingCards,
    subagentCommitCount,
    subagentFileCount,
    carried,
    dispatched,
    expiry,
  );
  const headDetails = chips.filter((chip) => chip.headDetail).map((chip) => chip.name || chip.detail);
  const label = headLabel(
    'Turn',
    [
      STATUS_WORDS[status],
      lastRelative,
      duration ? `${durationWord(status)} ${duration}` : null,
      `started ${formatWhen(turn.startedAt, now)}`,
      [AGENT_NAMES[turn.agent], model, turn.effort].filter(Boolean).join(' ') || null,
      marks.map((m) => m.word).join(', ') || null,
    ],
    headline,
  );
  return {
    kind: 'turn',
    key,
    sessionId: turn.sessionId,
    status,
    statusWord: STATUS_WORDS[status],
    relative,
    absolute: formatWhen(turn.startedAt, now),
    duration,
    durationWord: durationWord(status),
    durationDetail: `Started ${formatWhen(turn.startedAt, now)}`,
    lastRelative,
    lastAbsolute: formatWhen(turn.endedAt, now),
    // Combine the head's visible words, mark descriptions, and pointer-only figure detail in its accessible name.
    label: [label, ...headDetails].join('\n'),
    live: status === 'running',
    activity: log.rows,
    activityCount,
    // Activity heading shared with its count and accessible name.
    activityWord: 'Activity',
    activityName: activityName(activityCount, asked.length, log.counts, activityTools),
    activityCounts: log.counts,
    activityTools,
    activityToolCategories,
    activitySkills,
    // Use the total skill-load count, including repeated loads and records outside the retained rows.
    activitySkillCount: turn.skillUseCount,
    activitySkillLabel: turn.skillUseCount === 1 ? '1 skill' : `${turn.skillUseCount} skills`,
    doing: onNow
      ? stepLine(onNow)
      : narration
        ? shortenTo(narration.text.replace(/\s+/g, ' ').trim(), STEP_DETAIL_LIMIT, STEP_CUT)
        : '',
    doingCode: onNow ? stepCode(onNow) : '',
    doingSince: onNow?.at ?? (narration?.status === 'running' ? narration.at : null),
    startedAt: turn.startedAt,
    promptId: turn.promptId,
    endedAt: turn.endedAt,
    ...(turn.processEndedAt !== undefined ? { processEndedAt: turn.processEndedAt } : {}),
    agent: AGENT_NAMES[turn.agent],
    model,
    effort: turn.effort,
    headline,
    ...(headlineHtml ? { headlineHtml } : {}),
    prompt: turn.prompt,
    delegation: turn.delegation?.text || '',
    promptHeading: turn.prompt ? 'You asked' : turn.delegation ? 'Assigned task' : 'You asked',
    promptNotice:
      !turn.prompt && turn.delegation && !turn.delegation.complete
        ? 'Full instructions unavailable in this session'
        : '',
    summary: turn.summary,
    earlierAnswers: earlierAnswersOf(turn, now),
    saidMessages: said,
    saidName: saidName(said),
    saidMix: saidMix(said),
    laterPrompts: asked.map((ask) => ({
      text: ask.text,
      when: formatClock(ask.at),
      absolute: formatWhen(ask.at, now),
      label: ask === pending ? CARD_ACTIONS.askedJustSent : CARD_ACTIONS.askedMidTurn,
    })),
    sessionTitle: turn.sessionTitle,
    // File labels name the path, new-file status, and child attribution. Line counts remain on the figures.
    files: fileCards,
    fileCount: fileCards.length,
    added,
    removed,
    chips,
    marks,
    toolMix: [log.counts.join(', '), activityTools].filter(Boolean).join(' · '),
    toolTally: Object.entries(turn.toolTally)
      .map(([name, count]): ToolTallyRow => ({
        name,
        count,
        // Skill calls keep their own tally category outside other tools.
        category:
          name === 'Skill'
            ? SKILL_STEP_KIND
            : ((turn.agent === 'claude' ? CLAUDE_TOOL_KIND : CODEX_TOOL_KIND)[name] ?? 'other'),
      }))
      .sort(mostCalledFirst),
    agents: agentCards,
    // List commits and landings together by timestamp. Only commits contribute to the commit count.
    commits: commitRows,
    errorText: turn.error,
  };
}

// Clock-dependent fields excluded from content comparison. The browser refreshes them in place.
export const CARD_TIME_FIELDS: readonly string[] = [
  'relative',
  'absolute',
  'duration',
  'durationDetail',
  'lastRelative',
  'lastAbsolute',
  'label',
];

// Shared content comparison and repository-work wording used by card and host projections.
export { CARD_CONTENT_FIELDS, cardPrint, repositoryWorkLabel } from './view/card-presentation';

// Parsed session-turn facts used for figures, context selection, and request-price projections.
type SessionFigureTurn = Omit<SessionStatTurnFacts, 'childSpendPartial' | 'provider' | 'error'> & {
  provider?: string | null;
  childSpendPartial?: boolean;
  error?: boolean | string | null;
};
type SessionFigureCompaction = SessionStatCompactionFacts;

export interface CurrentContextSelection {
  tokens: number;
  window: number | null;
  afterCompaction: boolean;
}

// The current context comes from whichever boundary is newer. A compaction with no
// recorded result invalidates the earlier turn's level until another request records one.
export function currentContextOf(
  newest: SessionFigureTurn | null,
  newestCompaction: SessionFigureCompaction | null,
): CurrentContextSelection | null {
  if (!newest) {
    return null;
  }
  const afterCompaction = Boolean(newestCompaction && newestCompaction.at > newest.endedAt);
  const retained = newestCompaction?.retainedContext;
  if (afterCompaction && !retained?.tokens && !newestCompaction?.contextAfter) {
    return null;
  }
  const context =
    afterCompaction && newestCompaction
      ? {
          ...newest,
          contextTokens: retained?.tokens ?? newestCompaction.contextAfter,
          contextWindow: retained?.window ?? null,
          model: newestCompaction.model ?? newest.model,
        }
      : newest;
  if (!context.contextTokens) {
    return null;
  }
  return { tokens: context.contextTokens, window: windowFor(context), afterCompaction };
}

export interface NextTurnBasis {
  effort?: string | null;
  bedrock?: boolean;
  tokens: number;
  outputTokens: number;
  window: number | null;
  model: string | null;
  provider: string | null;
  // The lifetime that request bought, or null where it named none.
  tier: CacheTier | null;
  // Timestamp of the model request that established this context and its cache lifetime.
  lastRequestAt: number;
  // What that request was billed under, so the floor is quoted at the rate it ran at.
  inferenceClass: UsageInferenceClass;
  serviceTier: string | null;
  // True when the request read cached input. A fresh cache write alone leaves this false.
  readBack: boolean;
  // True when a newer compaction establishes replacement context without request cache evidence.
  afterCompaction: boolean;
}

// Derives next-turn pricing inputs from the latest model request or a newer compaction.
// Compare compaction time with the request clock because tool results also advance the turn clock.
// Require a finished successful turn for request-based pricing. Replacement context resets cache lifetime evidence.
export function nextTurnBasisOf(
  newest: (SessionFigureTurn & Pick<Turn, 'contextRequest'>) | null,
  newestCompaction: SessionFigureCompaction | null,
): NextTurnBasis | null {
  if (!newest) {
    return null;
  }
  const request = newest.contextRequest ?? null;
  const compacted = newestCompaction && newestCompaction.at > (request?.at ?? newest.endedAt) ? newestCompaction : null;
  if (compacted && !compacted.contextAfter) {
    return null;
  }
  // Unfinished or failed turns leave tool-result input unmeasured. A newer compaction supplies its own complete context level.
  if (!compacted && (Boolean(newest.error) || !newest.finished || !request)) {
    return null;
  }
  const model = compacted?.model ?? newest.model;
  const tokens = compacted?.contextAfter ?? newest.contextTokens;
  if (!tokens) {
    return null;
  }
  const window = compacted
    ? windowFor({ ...newest, contextTokens: tokens, contextWindow: null, model })
    : windowFor(newest);
  return {
    tokens,
    outputTokens: compacted ? 0 : (request?.outputTokens ?? 0),
    effort: request?.effort ?? null,
    bedrock: request?.bedrock ?? false,
    window,
    model,
    provider: newest.provider ?? null,
    tier: compacted ? null : (request?.lifetime ?? null),
    lastRequestAt: compacted?.at ?? request?.at ?? newest.endedAt,
    inferenceClass: request?.inferenceClass ?? null,
    serviceTier: request?.serviceTier ?? null,
    readBack: compacted ? false : (request?.readBack ?? false),
    afterCompaction: Boolean(compacted),
  };
}

export interface ComposerRuntimeFacts {
  confirmedModel: string | null;
  confirmedModelAttachment: string | null;
  confirmedEffort: string | null;
  context: CurrentContextSelection | null;
  nextTurn: NextTurnBasis | null;
}

// Select the newest turn with runtime evidence, skipping only finished failures with no model, effort, context, or usage facts.
export function composerRuntimeBySession(
  turns: readonly Turn[],
  newestCompactions: ReadonlyMap<string, Compaction>,
  lastReportedModels: ReadonlyMap<string, string | null> = new Map(),
): Map<string, ComposerRuntimeFacts> {
  const turnsBySession = new Map<string, Turn[]>();
  for (const turn of turns) {
    const held = turnsBySession.get(turn.sessionId) ?? [];
    held.push(turn);
    turnsBySession.set(turn.sessionId, held);
  }
  const result = new Map<string, ComposerRuntimeFacts>();
  for (const [sessionId, sessionTurns] of turnsBySession) {
    const ordered = [...sessionTurns].sort((a, b) => b.startedAt - a.startedAt);
    const compaction = newestCompactions.get(sessionId) ?? null;
    const newest =
      ordered.find(
        (turn) =>
          !(
            Boolean(turn.error) &&
            turn.finished &&
            !turn.model &&
            !turn.effort &&
            !turn.contextTokens &&
            !turn.contextWindow &&
            !turn.contextRequest &&
            !(turn.usage.requests ?? 0) &&
            !spentTokens(turn.usage)
          ),
      ) ?? null;
    result.set(sessionId, {
      confirmedModel:
        newest?.model ??
        (newest?.agent === 'codex' && newest.interrupted
          ? lastReportedModels.has(sessionId)
            ? (lastReportedModels.get(sessionId) ?? null)
            : (ordered.find((turn) => turn.model)?.model ?? null)
          : null),
      confirmedModelAttachment: newest?.modelAttachment ?? null,
      confirmedEffort: newest?.effort ?? null,
      context: currentContextOf(newest, compaction),
      nextTurn: nextTurnBasisOf(newest, compaction),
    });
  }
  return result;
}

// Prices request groups with retained rate and tier facts, falling back to aggregate usage when absent.
function factCost(turn: SessionFigureTurn): SessionCostTotal {
  const exact = turn.usageParts?.length
    ? sessionCostTotalOf(turn.usageParts.map((part) => priceSessionCost({ role: 'main', ...part })))
    : null;
  const dollars = exact
    ? exact.dollars
    : estimateCost(turn.usage, turn.model, turn.provider ?? null, turn.contextWindow);
  return {
    dollars,
    partial: Boolean(turn.childSpendPartial) || (exact?.partial ?? (dollars === null && spentTokens(turn.usage))),
  };
}

function costStat(
  costs: readonly SessionCostTotal[],
  scope: string,
  partialDetail: (missing: number) => string,
): SessionStatChip | null {
  let missing = 0;
  for (const cost of costs) {
    if (cost.partial) {
      missing++;
    }
  }
  const { dollars } = sessionCostTotalOf(costs);
  if (dollars === null) {
    return null;
  }
  const label = formatCost(dollars);
  if (!label) {
    return null;
  }
  return {
    metric: 'cost',
    compactLabel: missing ? `${label}+` : label,
    kind: 'plain',
    label: missing ? `${label}+` : label,
    // Carry the unrounded cost and partial flag for aggregate callers.
    dollars,
    partial: missing > 0,
    detail: [
      `${label} estimated from published model rates. Your actual charge may differ.`,
      ...(missing ? [partialDetail(missing)] : []),
      scope,
    ].join('\n'),
  };
}

export interface SessionCostUsage {
  usageOrigin?: UsageOrigin;
  linkedInvocationId?: string | null;
  agent?: string | null;
  role?: 'main' | 'delegated';
  scopeId?: string;
  model: string | null;
  provider: string | null;
  contextWindow: number | null;
  contextBand?: 'short' | 'long' | null;
  inferenceClass?: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null;
  serviceTier?: string | null;
  recordedCost?: number;
  costBasis?: string;
  unclassifiedCacheWrite?: number;
  incomplete?: boolean;
  requestCountExact?: false;
  // Estimated compaction requests, which the source recorded no usage for.
  compactionEstimate?: true;
  compactionUsage?: true;
  usage: Turn['usage'];
}

export interface CacheWriteScope {
  scope: 'main' | 'delegated';
  id?: string;
  incomplete?: boolean;
  parts: readonly SessionCostUsage[];
}

export interface CacheWriteWarning {
  scope: CacheWriteScope['scope'];
  id?: string;
  requests: number;
  cachedInputShare: number;
  cachedInputPercent: number;
  cacheWriteShare: number;
  cacheWriteCost: number;
  scopeCost: number;
}

export function cacheWriteWarnings(scopes: readonly CacheWriteScope[]): CacheWriteWarning[] {
  return scopes
    .flatMap((scope): CacheWriteWarning[] => {
      if (scope.incomplete || !scope.parts.length) {
        return [];
      }
      const usage = emptyUsage();
      let scopeCost = 0;
      let cacheWriteCost = 0;
      for (const part of scope.parts) {
        // Compaction requests, cost snapshots and advisor consultations supply no cache-write warning.
        if (part.compactionEstimate || part.compactionUsage || part.usageOrigin) {
          continue;
        }
        if (
          part.requestCountExact === false ||
          part.usage.requests === undefined ||
          (part.unclassifiedCacheWrite ?? 0) > 0
        ) {
          return [];
        }
        const priced = priceSessionCost(part);
        if (priced.partial || priced.dollars === null || priced.unallocatedRecordedCost) {
          return [];
        }
        for (const key of ['cacheWrite1h', 'cacheWrite5m', 'cacheWrite30m'] as const) {
          if (!(part.usage[key] ?? 0)) {
            continue;
          }
          const category = priced.categories.find((category) => category.key === key);
          if (!category) {
            return [];
          }
          cacheWriteCost += category.dollars;
        }
        scopeCost += priced.dollars;
        addUsage(usage, part.usage);
      }
      const requests = usage.requests ?? 0;
      const input = inputSideTokens(usage);
      const writes = usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0);
      const cacheWriteShare = input > 0 ? writes / input : 0;
      if (requests < 5 || !(cacheWriteShare > 0.5) || !(cacheWriteCost > 5)) {
        return [];
      }
      return [
        {
          scope: scope.scope,
          ...(scope.id === undefined ? {} : { id: scope.id }),
          requests,
          cachedInputShare: usage.cacheRead / input,
          cachedInputPercent: cacheHitPercent(usage)!,
          cacheWriteShare,
          cacheWriteCost,
          scopeCost,
        },
      ];
    })
    .sort((left, right) => Number(left.scope === 'delegated') - Number(right.scope === 'delegated'));
}

export interface SessionCostProjection {
  stats: SessionStatChip[];
  total: SessionCostTotal;
}

function sessionCostTotalOf(costs: readonly SessionCostTotal[]): SessionCostTotal {
  let dollars = 0;
  let priced = false;
  for (const cost of costs) {
    if (cost.dollars === null) {
      continue;
    }
    dollars += cost.dollars;
    priced = true;
  }
  return { dollars: priced ? dollars : null, partial: costs.some((cost) => cost.partial) };
}

function usageInContextBand(usage: Turn['usage'], band: 'short' | 'long'): Turn['usage'] {
  if (usage.byContextBand) return usage;
  const counts = {
    requests: usage.requests ?? 0,
    input: usage.input,
    cacheWrite1h: usage.cacheWrite1h,
    cacheWrite5m: usage.cacheWrite5m,
    cacheWrite30m: usage.cacheWrite30m ?? 0,
    cacheRead: usage.cacheRead,
    output: usage.output,
    thinking: usage.thinking,
  };
  return { ...counts, byContextBand: { [band]: counts } };
}

interface UsageIdentity {
  key: string;
  label: string;
}

function displayAgentName(agent: string | null | undefined): string | null {
  if (!agent) {
    return null;
  }
  if (agent.toLowerCase() === 'claude') {
    return 'Claude';
  }
  if (agent.toLowerCase() === 'codex') {
    return 'Codex';
  }
  return agent;
}

function displayProviderName(provider: string): string {
  const known = provider.toLowerCase();
  if (known === 'openai') {
    return 'OpenAI';
  }
  if (known === 'anthropic') {
    return 'Anthropic';
  }
  if (known === 'amazon-bedrock') {
    return 'Amazon Bedrock';
  }
  return provider;
}

function autoReviewUsageIdentity(provider: string | null | undefined): UsageIdentity {
  const displayed = provider ? displayProviderName(provider) : null;
  const namedProvider = displayed && displayed !== 'OpenAI' ? ` · ${displayed}` : '';
  return {
    key: JSON.stringify([null, 'codex-auto-review', namedProvider]),
    label: `Codex Auto Review${namedProvider}`,
  };
}

function usageIdentity(part: SessionCostUsage): UsageIdentity {
  const agent = displayAgentName(part.agent);
  const provider = part.provider ? displayProviderName(part.provider) : null;
  if (part.model === 'codex-auto-review') {
    return autoReviewUsageIdentity(part.provider);
  }
  const model = shortModel(part.model);
  const key = JSON.stringify([agent, provider, model]);
  if (!agent && !model && !provider) {
    return { key, label: 'Model and provider not recorded' };
  }
  const label = [agent, model ?? 'model not recorded', provider ?? (!agent ? 'provider not recorded' : null)]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return { key, label };
}

interface UnavailableUsageIdentity extends UsageIdentity {
  reasons: Set<string>;
}

function sortedUnavailableUsage(identities: ReadonlyMap<string, UnavailableUsageIdentity>): UnavailableUsageIdentity[] {
  return [...identities.values()].sort((left, right) => left.label.localeCompare(right.label));
}

const UNAVAILABLE_COST_NOTE = 'Some usage could not be priced, so the estimated total may be low.';

function unavailableReasonText(identity: UnavailableUsageIdentity): string {
  return [...identity.reasons].sort().join('; ');
}

function unavailableUsageLine(identity: UnavailableUsageIdentity): string {
  return `Cost unavailable for ${identity.label}: ${unavailableReasonText(identity)}.`;
}

function unavailableUsageLines(identities: ReadonlyMap<string, UnavailableUsageIdentity>): string[] {
  return sortedUnavailableUsage(identities).map(unavailableUsageLine);
}

function unavailableUsageName(identities: ReadonlyMap<string, UnavailableUsageIdentity>): string {
  const listed = sortedUnavailableUsage(identities);
  if (!listed.length) {
    return UNAVAILABLE_COST_NOTE;
  }
  const first = unavailableUsageLine(listed[0]);
  if (listed.length === 1) {
    return `${first} ${UNAVAILABLE_COST_NOTE}`;
  }
  return `${first} Cost is also unavailable for ${listed.length - 1} more. ${UNAVAILABLE_COST_NOTE}`;
}

interface PricedSessionCost {
  part: SessionCostUsage;
  dollars: number | null;
  partial: boolean;
  categories: PricedUsageCategory[];
  unallocatedRecordedCost: boolean;
  publiclyPriced: boolean;
}

function priceSessionCost(part: SessionCostUsage): PricedSessionCost {
  const usage = part.contextBand ? usageInContextBand(part.usage, part.contextBand) : part.usage;
  const priceContext = {
    inferenceClass: part.inferenceClass ?? null,
    serviceTier: part.serviceTier ?? null,
  };
  const recordedListCost = recordedCostBasis(part.costBasis) ? part.recordedCost : undefined;
  const hasRecordedListCost = recordedListCost !== undefined;
  const dollars =
    recordedListCost ??
    (part.incomplete && (!spentTokens(part.usage) || part.usageOrigin === 'claude-cost-state')
      ? null
      : estimateCost(usage, part.model, part.provider, part.contextWindow, null, priceContext));
  const partial =
    part.incomplete === true ||
    (part.requestCountExact === false &&
      part.usageOrigin !== 'claude-cost-state' &&
      part.agent?.toLowerCase() !== 'claude' &&
      !part.linkedInvocationId) ||
    (dollars === null && spentTokens(part.usage)) ||
    (!hasRecordedListCost && (part.unclassifiedCacheWrite ?? 0) > 0);
  return {
    part,
    dollars,
    partial,
    categories:
      !hasRecordedListCost && dollars !== null
        ? pricedUsageCategories(usage, part.model, part.provider, part.contextWindow, priceContext)
        : [],
    unallocatedRecordedCost: hasRecordedListCost && (dollars ?? 0) > 0,
    publiclyPriced: !hasRecordedListCost && dollars !== null,
  };
}

function unavailableReasons(cost: PricedSessionCost): string[] {
  const reasons: string[] = [];
  if (cost.part.incomplete === true) {
    reasons.push('usage record incomplete');
  }
  if (cost.dollars === null && spentTokens(cost.part.usage)) {
    if (
      cost.part.serviceTier &&
      !usesStandardPublicRate(cost.part.provider, cost.part.serviceTier) &&
      priceSessionCost({ ...cost.part, serviceTier: null }).dollars !== null
    ) {
      reasons.push(
        cost.part.serviceTier === 'fast'
          ? 'fast-mode price unavailable'
          : `${cost.part.serviceTier} service-tier price unavailable`,
      );
    } else {
      reasons.push('reliable list-price estimate unavailable');
    }
  }
  if ((cost.part.unclassifiedCacheWrite ?? 0) > 0) {
    reasons.push('cache-write duration not recorded');
  }
  if (!reasons.length) {
    reasons.push('reliable cost estimate unavailable');
  }
  return reasons;
}

function unavailableUsage(costs: readonly PricedSessionCost[]): Map<string, UnavailableUsageIdentity> {
  const identities = new Map<string, UnavailableUsageIdentity>();
  for (const cost of costs) {
    if (!cost.partial) {
      continue;
    }
    const identity = usageIdentity(cost.part);
    const held = identities.get(identity.key) ?? { ...identity, reasons: new Set<string>() };
    for (const reason of unavailableReasons(cost)) {
      held.reasons.add(reason);
    }
    identities.set(identity.key, held);
  }
  return identities;
}

// `short` marks missing usage outside these cost parts.
// Without a formatted price, partial totals read unavailable and complete totals read no billed usage.
function sessionCostValue(costs: readonly SessionCostTotal[], short = false): string {
  let dollars = 0;
  let priced = false;
  for (const cost of costs) {
    if (cost.dollars === null) {
      continue;
    }
    dollars += cost.dollars;
    priced = true;
  }
  const label = priced ? formatCost(dollars) : null;
  const partial = short || costs.some((cost) => cost.partial);
  if (!label) {
    return partial ? 'cost unavailable' : 'no billed usage';
  }
  return `${label}${partial ? '+' : ''}`;
}

function inputCategoryCost(categories: readonly PricedUsageCategory[]): number {
  return categories.reduce((sum, category) => sum + (category.key === 'output' ? 0 : category.dollars), 0);
}

function pricedInputCost(costs: readonly PricedSessionCost[]): number | null {
  // A recorded total cannot establish its input share. Keep incomplete or unpriced scopes muted.
  if (
    costs.some(
      (cost) =>
        cost.partial ||
        cost.dollars === null ||
        cost.unallocatedRecordedCost ||
        cost.part.unclassifiedCacheWrite ||
        recordedCostBasis(cost.part.costBasis),
    )
  ) {
    return null;
  }
  return costs.reduce((sum, cost) => sum + inputCategoryCost(cost.categories), 0);
}

function pricedUsageCategoryLines(
  costs: readonly PricedSessionCost[],
  _finished = true,
  incomplete = false,
): StatDetailLine[] {
  const categoryDollars = new Map<PricedUsageKey, number>();
  for (const cost of costs) {
    for (const category of cost.categories) {
      categoryDollars.set(category.key, (categoryDollars.get(category.key) ?? 0) + category.dollars);
    }
  }
  // The cached share and the request facts describe recorded usage only.
  const recorded = recordedCosts(costs);
  const usage = emptyUsage();
  const complete = !incomplete && recorded.every((cost) => !cost.part.incomplete && !cost.part.unclassifiedCacheWrite);
  for (const cost of recorded) {
    addUsage(usage, cost.part.usage);
  }
  const categories = USAGE_COST_CATEGORIES.flatMap(({ key, label }) => {
    const dollars = categoryDollars.get(key) ?? 0;
    return dollars > 0 ||
      (key === 'cacheRead' &&
        complete &&
        cacheHitPercent(usage) !== null &&
        costs.every((cost) => !cost.partial && !cost.unallocatedRecordedCost))
      ? [{ key, label, dollars }]
      : [];
  });
  const exactRequests = recorded.every(
    (cost) => cost.part.requestCountExact !== false && cost.part.usage.requests !== undefined,
  );
  const lines = formatUsageCostCategories(
    categories,
    complete ? usage : undefined,
    pricedInputCost(recorded),
    exactRequests,
  );
  if (costs.some((cost) => cost.unallocatedRecordedCost)) {
    lines.push('Some recorded cost cannot be split by usage.');
  }
  return lines;
}

function usageCategoryLines(
  costs: readonly PricedSessionCost[],
  finished = true,
  incomplete = false,
): StatDetailLine[] {
  const lines = pricedUsageCategoryLines(costs, finished, incomplete);
  const unavailable = unavailableUsage(costs);
  if (unavailable.size > 0) {
    lines.push(...unavailableUsageLines(unavailable));
  }
  return lines;
}

interface SessionCostIdentityGroup {
  key: string;
  label: string;
  costs: PricedSessionCost[];
}

function roleUsageIdentity(part: SessionCostUsage, role: 'main' | 'delegated'): UsageIdentity {
  const identity = usageIdentity(part);
  if (role === 'delegated') {
    return identity;
  }
  const agent = displayAgentName(part.agent);
  const provider = part.provider ? displayProviderName(part.provider) : null;
  const standardProvider =
    (agent === 'Codex' && provider === 'OpenAI') || (agent === 'Claude' && provider === 'Anthropic');
  const label = [
    'Main agent',
    shortModel(part.model) ?? 'model not recorded',
    provider && !standardProvider ? provider : null,
  ]
    .filter((held): held is string => Boolean(held))
    .join(' · ');
  return { key: identity.key, label };
}

function sentenceCaseReason(reason: string): string {
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

function sessionCostIdentityEntries(
  costs: readonly PricedSessionCost[],
  role: 'main' | 'delegated',
  incomplete: (costs: readonly PricedSessionCost[]) => boolean = () => false,
): StatDetailEntry[] {
  const byIdentity = new Map<string, SessionCostIdentityGroup>();
  for (const cost of costs) {
    const identity = roleUsageIdentity(cost.part, role);
    const held = byIdentity.get(identity.key) ?? {
      key: identity.key,
      label: identity.label,
      costs: [],
    };
    held.costs.push(cost);
    byIdentity.set(identity.key, held);
  }
  const grouped = [...byIdentity.values()];
  return grouped
    .sort((left, right) => {
      const leftDollars = left.costs.reduce((total, cost) => total + (cost.dollars ?? 0), 0);
      const rightDollars = right.costs.reduce((total, cost) => total + (cost.dollars ?? 0), 0);
      return rightDollars - leftDollars || left.label.localeCompare(right.label);
    })
    .map((identity) => {
      const reasons = new Set<string>();
      for (const cost of identity.costs) {
        if (cost.partial) {
          for (const reason of unavailableReasons(cost)) {
            reasons.add(reason);
          }
        }
      }
      if (identity.costs[0].part.model === 'codex-auto-review') {
        return autoReviewCostEntry(
          identity.costs[0].part.provider,
          identity.costs,
          true,
          undefined,
          incomplete(identity.costs),
        );
      }
      const lines = pricedUsageCategoryLines(identity.costs, true, incomplete(identity.costs));
      lines.push(...[...reasons].sort().map(sentenceCaseReason));
      return {
        label: identity.label,
        value: sessionCostValue(identity.costs, incomplete(identity.costs)),
        ...(lines.length ? { lines } : {}),
      };
    });
}

function delegatedCacheRateDetail(allCosts: readonly PricedSessionCost[]): { cacheHit?: CacheHitDetail } {
  const costs = recordedCosts(allCosts);
  const usage = emptyUsage();
  for (const cost of costs) addUsage(usage, cost.part.usage);
  const exactRequests = costs.every(
    (cost) => cost.part.requestCountExact !== false && cost.part.usage.requests !== undefined,
  );
  const detail = cacheRateDetail(usage, null, exactRequests);
  if (!detail.cacheHit || detail.cacheHit.percent >= 80) {
    return detail;
  }
  // Evaluate low-reuse warning thresholds per identified child, rather than across unrelated model usage.
  const scopes = new Map<string, PricedSessionCost[]>();
  for (const cost of costs) {
    const id = cost.part.scopeId;
    if (id === undefined) {
      continue;
    }
    const scope = scopes.get(id) ?? [];
    scope.push(cost);
    scopes.set(id, scope);
  }
  detail.cacheHit.warning = [...scopes.values()].some((scope) => {
    const ownUsage = emptyUsage();
    for (const cost of scope) {
      addUsage(ownUsage, cost.part.usage);
    }
    return cacheRateDetail(ownUsage, pricedInputCost(scope)).cacheHit?.warning === true;
  });
  return detail;
}

function delegatedCostLines(
  costs: readonly PricedSessionCost[],
  incomplete: (costs: readonly PricedSessionCost[]) => boolean = () => false,
): StatDetailLine[] {
  const byIdentity = new Map<
    string,
    {
      label: string;
      dollars: number;
      priced: boolean;
      partial: boolean;
      reasons: Set<string>;
      complete: boolean;
      costs: PricedSessionCost[];
    }
  >();
  for (const cost of costs) {
    const identity = usageIdentity(cost.part);
    const held = byIdentity.get(identity.key) ?? {
      label: identity.label,
      dollars: 0,
      priced: false,
      partial: false,
      reasons: new Set<string>(),
      complete: true,
      costs: [],
    };
    if (cost.dollars !== null) {
      held.dollars += cost.dollars;
      held.priced = true;
    }
    held.costs.push(cost);
    held.complete = held.complete && !cost.part.incomplete && !cost.part.unclassifiedCacheWrite;
    held.partial = held.partial || cost.partial;
    if (cost.partial) {
      for (const reason of unavailableReasons(cost)) {
        held.reasons.add(reason);
      }
    }
    byIdentity.set(identity.key, held);
  }
  return [...byIdentity.values()]
    .sort((left, right) => right.dollars - left.dollars || left.label.localeCompare(right.label))
    .map((identity) => {
      const short = incomplete(identity.costs);
      const label = identity.priced ? formatCost(identity.dollars) : null;
      const reason = [...identity.reasons].sort().join('; ');
      const value = label
        ? `${label}${identity.partial || short ? '+' : ''}${reason ? ` (${reason})` : ''}`
        : identity.partial || short
          ? `cost unavailable${reason ? ` (${reason})` : ''}`
          : 'no billed usage';
      return {
        text: `${identity.label}: ${value}`,
        ...(identity.complete && !short ? delegatedCacheRateDetail(identity.costs) : {}),
      };
    });
}

// Advisor consultations can record cache reads and writes. These figures cover executor requests alone.
function recordedCosts(costs: readonly PricedSessionCost[]): PricedSessionCost[] {
  return costs.filter((cost) => !cost.part.compactionEstimate && !cost.part.compactionUsage && !cost.part.usageOrigin);
}

function requestInputOf(usage: Turn['usage']): number {
  return usage.input + usage.cacheRead + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0);
}

// What part of a session total is a compaction estimate rather than recorded usage.
function compactionEstimateNote(costs: readonly PricedSessionCost[]): string | null {
  const estimates = costs.filter((cost) => cost.part.compactionEstimate && cost.dollars !== null);
  if (!estimates.length) {
    return null;
  }
  const dollars = estimates.reduce((sum, cost) => sum + (cost.dollars ?? 0), 0);
  const count = estimates.reduce((sum, cost) => sum + (cost.part.usage.requests ?? 0), 0);
  const label = formatCost(dollars) ?? '$0.00';
  return `Includes an estimated ${label} for ${count} compaction${count === 1 ? '' : 's'}. Claude Code records no usage for a compaction.`;
}

// Says that compaction costs in an "Included above" row are modelled estimates.
const COMPACTION_ESTIMATE_FOOTER = 'Compaction costs are estimates. Claude Code records no usage for a compaction.';

// Defines the cache expiry row of an "Included above" group.
const CACHE_EXPIRY_ROW_NOTE =
  "A cache expiry's cost is what resending the context cost above a cache read of the same tokens.";

// The cost of overheads a total already counts, as one value-column figure.
function overheadCostValue(cost: CacheExpiryCost): string {
  if (cost.dollars === null) {
    return 'cost unavailable';
  }
  return `${formatCost(cost.dollars) ?? ZERO_COST}${cost.status === 'atLeast' ? '+' : ''}`;
}

// Prices recorded and estimated compaction requests already included in the total.
// Fewer priced compactions than counted make the cost a lower bound.
function compactionOverheadCost(count: number, costs: readonly PricedSessionCost[]): CacheExpiryCost {
  let dollars = 0;
  let priced = 0;
  for (const cost of costs) {
    if ((cost.part.compactionEstimate || cost.part.compactionUsage) && cost.dollars !== null) {
      dollars += cost.dollars;
      priced += cost.part.usage.requests ?? 0;
    }
  }
  if (priced === 0) {
    return { dollars: null, status: 'unknown' };
  }
  return { dollars, status: priced < count ? 'atLeast' : 'exact' };
}

// The "Included above" group: overheads a total already counts, each with its count in the label.
function includedAboveEntries(
  compactions: { count: number; cost: CacheExpiryCost } | null,
  expiries: { count: number; cost: CacheExpiryCost } | null,
): StatDetailEntry[] {
  const rows: StatDetailEntry[] = [
    ...(compactions && compactions.count > 0
      ? [
          {
            label: `${compactions.count} compaction${compactions.count === 1 ? '' : 's'}`,
            value: overheadCostValue(compactions.cost),
            valueTitle:
              'A cold Claude compaction avoids the history cache-write charge included in a cold next turn. It still pays for uncached history and summary output.',
          },
        ]
      : []),
    ...(expiries && expiries.count > 0
      ? [
          {
            label: `${expiries.count} cache ${expiries.count === 1 ? 'expiry' : 'expiries'}`,
            value: overheadCostValue(expiries.cost),
            valueTitle: CACHE_EXPIRY_COST_ADDED_HINT,
          },
        ]
      : []),
  ];
  return rows.length ? [{ label: 'Included above', group: true, separateBefore: true }, ...rows] : [];
}

// The overheads a session cost popover names under "Included above".
export interface SessionOverheads {
  // The exact lifetime count of completed primary-session compactions.
  compactionCount?: number | null;
  expiry?: CacheExpiryFacts | null;
}

// Groups delegated work without a named scope, marking missing usage as partial.
function otherDelegatedEntry(costs: readonly PricedSessionCost[], short: boolean): StatDetailEntry {
  return { label: 'Other delegated work', value: sessionCostValue(costs, short), lines: delegatedCostLines(costs) };
}

export function sessionCostProjection(
  parts: readonly SessionCostUsage[],
  coverage: boolean | SessionSpendCoverage = false,
  overheads: SessionOverheads = {},
  captured?: { main: SessionCostTotal; delegated: SessionCostTotal; combined: SessionCostTotal },
): SessionCostProjection {
  const mainShort = typeof coverage === 'boolean' ? false : coverage.main;
  const short = typeof coverage === 'boolean' ? coverage : coverage.delegated;
  const scopeShort = (id: string) => typeof coverage !== 'boolean' && coverage.delegatedScopeIds.has(id);
  const delegatedShort = (held: readonly PricedSessionCost[]) =>
    held.some((cost) => cost.part.scopeId !== undefined && scopeShort(cost.part.scopeId));
  const incomplete = mainShort || short;
  const costs = parts.map(priceSessionCost);
  const totals: readonly SessionCostTotal[] = incomplete ? [...costs, { dollars: null, partial: true }] : costs;
  const total = captured?.combined ?? sessionCostTotalOf(totals);
  const unavailable = unavailableUsage(costs);
  const scope = 'Includes the main session and delegated work.';
  const chip = costStat(captured ? [total] : totals, scope, () =>
    [...unavailableUsageLines(unavailable), UNAVAILABLE_COST_NOTE].join('\n'),
  );
  if (!chip) {
    return { stats: [], total };
  }
  if (unavailable.size > 0 || incomplete) {
    chip.partialDetail = unavailableUsageName(unavailable);
  }
  const delegated = costs.filter((cost) => cost.part.role === 'delegated');
  const main = costs.filter((cost) => cost.part.role !== 'delegated');
  const delegatedScopes = new Map<string, SessionCostUsage[]>();
  for (const part of parts.filter((part) => part.role === 'delegated')) {
    const id = part.scopeId;
    if (id === undefined) {
      continue;
    }
    const held = delegatedScopes.get(id) ?? [];
    held.push(part);
    delegatedScopes.set(id, held);
  }
  const warningScopes: CacheWriteScope[] = [
    { scope: 'main', incomplete: mainShort, parts: main.map((cost) => cost.part) },
    ...[...delegatedScopes].map(([id, held]): CacheWriteScope => ({
      scope: 'delegated',
      id,
      incomplete: scopeShort(id),
      parts: held,
    })),
  ];
  const warnings = cacheWriteWarnings(warningScopes);
  const hasAutoReview = delegated.some((cost) => cost.part.model === 'codex-auto-review');
  const entries = warnings.length
    ? [
        ...(main.length || mainShort
          ? [
              withCostWarnings(
                {
                  label: costLabelWithModels(
                    'Main agent',
                    main.map((cost) => cost.part.model),
                  ),
                  value: sessionCostValue(captured ? [captured.main] : main, captured ? false : mainShort),
                  lines: usageCategoryLines(main, true, mainShort),
                },
                warnings.filter((warning) => warning.scope === 'main'),
              ),
            ]
          : []),
        ...[...delegatedScopes].map(([id, held], index) => {
          const scopeCosts = held.map(priceSessionCost);
          const identities = [...new Set(held.map((part) => usageIdentity(part).label))];
          return withCostWarnings(
            {
              label: `Subagent ${index + 1} · ${identities.join(', ')}`,
              value: sessionCostValue(scopeCosts, scopeShort(id)),
              lines: usageCategoryLines(scopeCosts, true, scopeShort(id)),
            },
            warnings.filter((warning) => warning.scope === 'delegated' && warning.id === id),
          );
        }),
        ...(short || delegated.some((cost) => cost.part.scopeId === undefined)
          ? [
              otherDelegatedEntry(
                delegated.filter((cost) => cost.part.scopeId === undefined),
                short,
              ),
            ]
          : []),
      ]
    : delegated.length || short || mainShort
      ? hasAutoReview
        ? [
            ...sessionCostIdentityEntries(main, 'main', () => mainShort),
            ...(mainShort && !main.length ? [{ label: 'Main agent', value: 'cost unavailable' }] : []),
            ...sessionCostIdentityEntries(delegated, 'delegated', delegatedShort),
            ...(short ? [otherDelegatedEntry([], short)] : []),
          ]
        : [
            ...(main.length || mainShort
              ? [
                  {
                    label: costLabelWithModels(
                      'Main agent',
                      main.map((cost) => cost.part.model),
                    ),
                    value: sessionCostValue(captured ? [captured.main] : main, captured ? false : mainShort),
                    lines: usageCategoryLines(main, true, mainShort),
                  },
                ]
              : []),
            ...(delegated.length || short
              ? [
                  {
                    label: 'Delegated work',
                    value: sessionCostValue(captured ? [captured.delegated] : delegated, captured ? false : short),
                    lines: delegatedCostLines(delegated, delegatedShort),
                  },
                ]
              : []),
          ]
      : [
          {
            label: costLabelWithModels(
              'Cost by usage',
              main.map((cost) => cost.part.model),
            ),
            lines: usageCategoryLines(main),
          },
        ];
  const compactionCount = overheads.compactionCount ?? 0;
  const expiryCount = overheads.expiry ? cacheExpiryReturnCount(overheads.expiry).count : 0;
  const included = includedAboveEntries(
    compactionCount > 0 ? { count: compactionCount, cost: compactionOverheadCost(compactionCount, main) } : null,
    overheads.expiry && expiryCount > 0
      ? { count: expiryCount, cost: cacheExpiryExtraCost(overheads.expiry, publicProjectSpendPrice) }
      : null,
  );
  // Beside a compactions row, the main session's note drops the count and dollars the row shows.
  // The row prices main compactions only, so delegated estimates keep their counted note.
  const compactionNotes =
    compactionCount > 0
      ? [
          ...(main.some((cost) => cost.part.compactionEstimate && cost.dollars !== null)
            ? [COMPACTION_ESTIMATE_FOOTER]
            : []),
          ...[compactionEstimateNote(delegated)].filter((note) => note !== null),
        ]
      : [compactionEstimateNote(costs)].filter((note) => note !== null);
  const detailList: StatDetailList = {
    heading: {
      label: 'Estimated total',
      value: chip.compactLabel,
    },
    entries: [...entries, ...included],
    footer: [
      // The compaction note says part of the total is a modelled estimate, so it stays visible.
      ...compactionNotes,
      ...(mainShort ? ['Main agent usage is incomplete.'] : []),
      ...(short ? ['Delegated work usage is incomplete.'] : []),
      ...(unavailable.size > 0 || incomplete ? [UNAVAILABLE_COST_NOTE] : []),
    ],
    notes: [
      ...(costs.some((cost) => cost.categories.some((category) => category.key === 'cacheRead' && category.dollars > 0))
        ? [CACHED_INPUT_READ_EXPLANATION]
        : []),
      ...(costs.some((cost) => cost.part.model === 'codex-auto-review' && cost.publiclyPriced)
        ? [AUTO_REVIEW_RATE_NOTE]
        : []),
      ...(expiryCount > 0 ? [CACHE_EXPIRY_ROW_NOTE] : []),
      scope,
      COST_ESTIMATE_NOTE,
    ],
  };
  chip.detailList = detailList;
  chip.detail = flatDetailList(detailList).join('\n');
  if (warnings.length) {
    chip.warnings = warnings;
    chip.name = chip.detail;
    chip.headDetail = true;
  }
  return { stats: [chip], total };
}

export function sessionCostStats(parts: readonly SessionCostUsage[]): SessionStatChip[] {
  return sessionCostProjection(parts).stats;
}

// Ledger spans include gaps between turns. Older ledgers omit timestamps and compaction counts.
export function sessionTurnStats(stats: SessionTurnStats | null | undefined): SessionStatChip[] {
  const turns = stats?.turnCount;
  if (!Number.isSafeInteger(turns) || (turns ?? 0) <= 0) {
    return [];
  }
  const label = `${turns} turn${turns === 1 ? '' : 's'}`;
  // Label and right-aligned value rows, as the cache-expiry figure draws them.
  const entries: StatDetailEntry[] = [{ label: 'Turns in the main session', value: String(turns) }];
  const notes = ['The turn count excludes delegated work.'];
  const first = stats?.firstTurnAt;
  const last = stats?.lastTurnAt;
  if (
    typeof first === 'number' &&
    typeof last === 'number' &&
    Number.isFinite(first) &&
    Number.isFinite(last) &&
    first > 0 &&
    last > first
  ) {
    const duration = formatExpiryGap(last - first);
    if (duration !== '0s') {
      entries.push({ label: 'First to last turn', value: duration });
      notes.push('Elapsed time includes gaps between turns.');
    }
  }
  const compactions = stats?.compactionCount;
  if (typeof compactions === 'number' && compactions > 0) {
    entries.push({ label: 'Compactions', value: String(compactions) });
  }
  const detailList: StatDetailList = { layout: 'economics', entries, notes };
  return [
    {
      metric: 'turns',
      compactLabel: label,
      kind: 'plain',
      label,
      detail: flatDetailList(detailList).join('\n'),
      detailList,
    },
  ];
}

function sessionFigureStats(
  turns: readonly SessionFigureTurn[],
  compactions: readonly SessionFigureCompaction[],
  costOf: (turn: SessionFigureTurn) => SessionCostTotal,
): SessionStatChip[] {
  if (!turns.length) {
    return [];
  }
  const chips: SessionStatChip[] = [];
  const read = `Over the ${turns.length} turn${turns.length === 1 ? '' : 's'} read, not the whole session.`;
  // Keep compactions at or after the oldest loaded turn's start.
  const oldest = turns.reduce((low, t) => Math.min(low, t.startedAt), Infinity);
  const inside = compactions.filter((c) => c.at >= oldest);

  const cost = costStat(
    turns.map(costOf),
    read,
    (missing) =>
      `Some usage could not be priced in ${missing} of ${turns.length} turn${turns.length === 1 ? '' : 's'}, so the estimated total may be low.`,
  );
  if (cost) {
    chips.push(cost);
  }

  const newest = turns.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
  const lastCompaction = inside.length ? inside.reduce((a, b) => (b.at > a.at ? b : a)) : null;
  const current = currentContextOf(newest, lastCompaction);
  const contextTurn = current ? { ...newest, contextTokens: current.tokens, contextWindow: current.window } : newest;
  const contextLabel = current?.afterCompaction ? 'Context after the latest compaction' : 'Latest recorded context';
  // After a compaction, the results in context are the ones the compaction kept.
  const subagentFigure = current?.afterCompaction
    ? (lastCompaction?.subagentContext ??
      (newest.subagentContext
        ? {
            tokens: 0,
            partial: false,
            removed: newest.subagentContext.tokens > 0 || newest.subagentContext.removed,
            agents: [],
          }
        : undefined))
    : newest.subagentContext;
  const ctx = current ? contextChip(contextTurn, contextLabel, subagentFigure) : null;
  if (ctx && current) {
    const share = contextShare(contextTurn);
    const detailList = ctx.detailList!;
    // Handoff advice belongs to the context level, not to an entry added after it.
    const contextEntry = detailList.entries.find((entry) => entry.label === contextLabel)!;
    contextEntry.lines = [
      ...(contextEntry.lines ?? []),
      ...(ctx.level && HANDOFF_LEVELS.includes(ctx.level) ? [HANDOFF_SENTENCE] : []),
    ];
    const facts = contextDetailFacts(newest, !current.afterCompaction);
    if (facts.entries.length) {
      facts.entries[0].separateBefore = true;
    }
    // The facts follow the context level, and the subagent results entry stays last.
    detailList.entries.splice(detailList.entries.indexOf(contextEntry) + 1, 0, ...facts.entries);
    detailList.notes = [
      'Context measures the current level, not cumulative token usage.',
      ...(facts.notes ?? []),
      ...(detailList.notes ?? []),
    ];
    chips.push({
      ...ctx,
      metric: 'context',
      compactLabel: share === null ? ctx.label : `${wholePercent(share)}% ctx`,
      // The session list shows this text, and the subagent results stay in the popover alone.
      detail: flatDetailList({
        ...detailList,
        entries: detailList.entries.filter((entry) => entry.label !== SUBAGENT_RESULTS_LABEL),
      }).join('\n'),
      detailList,
    });
  }

  return chips;
}

export function sessionStatsFromFacts(
  facts: {
    readonly turns: readonly SessionFigureTurn[];
    readonly compactions: readonly SessionFigureCompaction[];
  } | null,
): SessionStatChip[] {
  return facts ? sessionFigureStats(facts.turns, facts.compactions, factCost) : [];
}

export function sessionStats(turns: Turn[], compactions: Compaction[]): SessionStatChip[] {
  const chips = sessionFigureStats(turns, compactions, (turn) => turnCost(turn as Turn));
  const read = `Over the ${turns.length} turn${turns.length === 1 ? '' : 's'} read, not the whole session.`;

  let added = 0;
  let removed = 0;
  let commits = 0;
  // Combine recorded paths across loaded turns with platform-aware filesystem normalization.
  // Sum counted edits and settle mixed coverage into partial counts.
  // Windows drive-absolute paths fold case on every host. Other paths preserve case on non-Windows hosts.
  const byPath = new Map<string, ChildFileChange>();
  for (const t of turns) {
    for (const f of t.files) {
      const key = f.identity ?? normalizeFsPath(f.path);
      let held = byPath.get(key);
      if (!held) {
        held = { path: f.path, added: 0, removed: 0, isNew: false };
        byPath.set(key, held);
      }
      held.added += f.added;
      held.removed += f.removed;
      if (f.isNew) {
        held.isNew = true;
      }
      if (f.countsUnknown) {
        held.countsUnknown = true;
        if (f.unknownReason) {
          held.unknownReason = f.unknownReason;
        }
      }
    }
    commits += attributedCommits(t).length;
  }
  for (const held of byPath.values()) {
    settleCounts(held);
    // A row left unknown holds no count, so it adds nothing here and still counts as a file.
    if (!held.countsUnknown) {
      added += held.added;
      removed += held.removed;
    }
  }
  if (byPath.size) {
    const floorFiles = [...byPath.values()].filter((file) => file.countsUnknown || file.countsPartial);
    const caveats = fileCountCaveats(floorFiles);
    const detailList: StatDetailList = {
      entries: [
        { label: 'Distinct files changed', value: String(byPath.size) },
        {
          label: 'Lines changed',
          value: diffValue(added, removed),
          lines: [`Across the ${turns.length} loaded turn${turns.length === 1 ? '' : 's'}`],
        },
      ],
      ...(caveats.length ? { footer: caveats } : {}),
      notes: [
        'Each file counts once, even when several turns change it.',
        'Line totals add recorded edits across those turns, rather than a final net diff.',
      ],
    };
    const files = {
      ...filesAndLines(byPath.size, added, removed, flatDetailList(detailList).join('\n')),
      detailList,
    };
    chips.push({ ...files, metric: 'files', compactLabel: files.label });
  }
  if (commits) {
    const label = `${commits} commit${commits === 1 ? '' : 's'}`;
    chips.push({
      metric: 'commits',
      compactLabel: label,
      kind: 'plain',
      label,
      detail: `${commits} commit${commits === 1 ? '' : 's'} recorded.\n${read}`,
    });
  }

  return chips;
}

// Supporting context facts retain the scope of the loaded history and the latest priced turn.
function contextDetailFacts(newest: SessionFigureTurn, includeReread = true): StatDetailList {
  const entries: StatDetailEntry[] = [];
  const notes: string[] = [];
  if (includeReread) {
    const reread = formatCost(cacheReadCostOf(newest));
    if (reread) {
      entries.push({ label: 'Latest turn cached input reads', value: reread });
      notes.push(COST_ESTIMATE_NOTE);
    }
  }
  return { entries, notes };
}

// Prices cached input reads with retained request rates and tiers, falling back to aggregate usage when absent.
function cacheReadCostOf(turn: SessionFigureTurn): number | null {
  if (!turn.usageParts?.length) {
    return estimateCacheReadCost(turn.usage, turn.model, turn.provider ?? null, turn.contextWindow);
  }
  let dollars = 0;
  for (const part of turn.usageParts) {
    // Compaction requests stay out of ordinary request cache reads.
    if (part.compactionEstimate || part.compactionUsage || part.usage.cacheRead <= 0) {
      continue;
    }
    const usage = part.contextBand ? usageInContextBand(part.usage, part.contextBand) : part.usage;
    const cost = usageCost(usage, part.model, part.provider, part.contextWindow, 'cacheRead', {
      inferenceClass: part.inferenceClass,
      serviceTier: part.serviceTier,
    });
    if (cost === null) {
      return null;
    }
    dollars += cost;
  }
  return dollars;
}

// True when recorded usage contains a positive input or output token total.
function spentTokens(usage: Turn['usage']): boolean {
  return (
    usage.input +
      usage.cacheWrite1h +
      usage.cacheWrite5m +
      (usage.cacheWrite30m ?? 0) +
      usage.cacheRead +
      usage.output >
    0
  );
}

// Maximum headline length in a diff tab title.
export const TITLE_HEADLINE_LIMIT = 60;

// Diff tab title with counts for snapshot comparisons and hunk-only files.
// Snapshot comparisons can include earlier edits. Hunk-only comparisons lack complete file text.
export function diffTitle(headline: string, againstBaseline: number, asHunks: number): string {
  const head = shortenTo(headline, TITLE_HEADLINE_LIMIT, '…');
  const notes: string[] = [];
  if (againstBaseline) {
    notes.push(`${againstBaseline} may include earlier edits`);
  }
  if (asHunks) {
    notes.push(`${asHunks} as hunks only`);
  }
  return `Changes · ${head}` + (notes.length ? ` · ${notes.join(', ')}` : '');
}
