import { wholePercent } from './view/tokens.ts';
// extension/src/turncard.ts
//
// One turn reduced to the card the panel draws: its headline, its status, its figures and the words on its controls.
//
// Split out of turnview.ts, which was 3,965 lines of pure functions with no shared state and
// no seam anyone could find. Nothing here was edited on the way: every declaration is the one
// that was there, in the order it was in. turnview.ts re-exports this module, so an import
// written against it still resolves.

import { mayHaveUnrecordedEdits, TOOL_KIND as CODEX_TOOL_KIND } from './codex';
import { TOOL_KIND as CLAUDE_TOOL_KIND } from './transcript';
import { FileIcon, iconFor } from './fileicons';
import {
  cacheExpiryInputCost,
  publicProjectSpendPrice,
  type CacheExpiryFacts,
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
  headlineMarkdownOf,
  headlineOf,
  isInside,
  normalizeFsPath,
  openingLines,
  responseAnswerIndex,
  sameCommitSha,
  shortenTo,
} from './transcript';
import { formatClock, formatDuration, formatRelative, formatTokens, formatWhen, shortModel } from './turnformat';
import { turnKey } from './turnread';
import {
  ModelSpend,
  addUsage,
  agentSpendIsOpen,
  emptyUsage,
  spendTokens,
  usageTokens,
  type AgentSpend,
} from './agentspend';
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

// A turn reduced to what the panel draws. Kept apart from the view so the wording and
// the numbers can be tested without a VS Code host.

export type TurnStatus = 'done' | 'failed' | 'interrupted' | 'running' | 'stopped';

export interface RelativeStatDetail {
  lead: string;
  at: number;
  title?: string;
  trail: string;
}

export interface StatDetailEntry {
  label: string;
  value?: string | RelativeStatDetail;
  // Draws the value in the tone the panel gives work still moving, rather than as plain text.
  busyValue?: true;
  // Added and removed lines, drawn in their own tones beside the label rather than as text.
  diff?: { added: number; removed: number };
  lines?: StatDetailLine[];
  separateBefore?: boolean;
  warning?: boolean;
}

export type StatDetailLine =
  | string
  | RelativeStatDetail
  | { text: string; cost?: true; cacheHit?: CacheHitDetail; warning?: true; lines?: StatDetailLine[] };

// Lead with figures and keep scope beside the figure it limits. Separate changes of subject.
// Use label/value rows for figures and bullets for explanations. Put relevant caveats last.
// Omit absent facts and derive plain detail from the same list to preserve reading order.
export interface StatDetailList {
  // `files`, `agents` and `commits` each name one of the turn's record arrays as well as the
  // shape the popover is drawn in. The browser reads the rows off the card's own array of
  // that name and builds them with the row component the card body builds, so the record
  // crosses to the panel once. The entries below stay as the words the plain-text hover and
  // the chip's spoken name are made of.
  layout?: 'economics' | 'files' | 'agents' | 'dispatched' | 'commits';
  // Set where the popover holds a press. The list says so once, so the browser never scans
  // its entries to find out what kind of surface it is drawing.
  actions?: true;
  heading?: StatDetailEntry & { fact?: string };
  entries: StatDetailEntry[];
  footer?: string[];
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
  // The agents figure's count of background children still at work, drawn after the label in
  // the busy tone. Present only while a child is live, and the same children the rail counts.
  // The dispatched figure counts its running dispatched rows the same way.
  running?: number;
  // What the chip is announced as, where what it draws does not read out. Only the diff
  // chip carries one: its two figures are read out as two numbers and a run of punctuation,
  // which is the fault `distinctNames` answers on a file row. A name replaces everything the
  // pill draws rather than joining it, so it says the file count as well as the lines.
  name?: string;
  // A figure whose complete meaning must be available without a pointer. The panel makes
  // the pill a focus target and announces `name`; ordinary figures stay out of the tab order.
  focusable?: true;
  // Detail announced by the card's existing roving control. This keeps the list at one tab
  // stop while making a chip's pointer-only hover available to a screen reader.
  headDetail?: true;
  // The context chip's band, and the same band as a noun phrase for the session heading's
  // accessible name. No other chip carries either. They ride beside `kind` rather than
  // inside it: `kind` is the four-value shape vocabulary every chip is drawn from, and
  // `warn` is the binary the failure-run chip needs, so a band folded into `kind` would put
  // values on every reader of it that only one chip can ever wear. See `CONTEXT_BANDS`.
  level?: ContextLevel;
  word?: string;
  warnings?: CacheWriteWarning[];
}

export type SessionMetric = 'cost' | 'turns' | 'context' | 'cache-expiry' | 'files' | 'commits';

export interface SessionStatChip extends StatChip {
  metric: SessionMetric;
  compactLabel: string;
  partialDetail?: string;
  // The estimate the drawn label was worded from, for a caller that adds several
  // sessions together. A heading over a run of cards has to sum the figures, and it
  // cannot sum `$1.87`: parsing the label back into a number would be a second copy of the
  // wording rule, and it would round twice. Only the cost chip carries this.
  dollars?: number;
  // Whether that estimate is a floor rather than a total, which is what the `+` on the drawn
  // label says. A caller adding several figures says the same thing about its own sum, and
  // one part the index left unpriced makes the whole sum a floor.
  partial?: boolean;
}

// The figures a folded card draws. A turn keeps one ordered row and shows it in both states,
// so closing the response never hides usage or work statistics.
export function foldedChips(chips: StatChip[]): StatChip[] {
  return chips;
}

// What a file row draws, in the body and in the Files chip popover alike.
//
// `path` is what the transcript recorded and what everything acting on the row uses.
// `shownPath` is the same path in the spelling the panel reads out and hovers with.
export interface FileCard {
  name: string;
  lead?: string;
  label: string;
  icon: RowIcon;
  path: string;
  shownPath: string;
  // What the row hovers with, where it has more to say than the path. A row a subagent changed
  // names that subagent here. Every other row hovers with its path alone.
  detail?: string;
  added: number;
  removed: number;
  isNew: boolean;
  // Set when a shell command named this file without carrying its hunks. The row draws its
  // name with no counts and opens no diff, the same flag `TurnFileChange` carries.
  countsUnknown?: true;
}

export interface AgentFigure extends AgentFigureFacts {
  // The record behind this figure, drawn in a popover of its own with the shape the card's
  // own records wear. A figure with nothing to say carries none, and the row draws it as
  // plain text the keyboard passes by.
  record?: StatDetailList;
}

// A subagent row draws two lines. The name, model, and effort lead with the state mark. Its
// figures line carries cost, commits, files, and how long the child ran, then a state word when
// one is needed. A completed child's tool uses stay in `hintDetail`, because they word the row's
// own state. The duration, the cost by usage, the commits, the paths and the token totals belong
// to the figures that total them, one fact to one home.
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
  // When the parent launched a child that still has live-process evidence, for the running word's time.
  since: number | null;
  hintDetail: string;
  sessionId: string | null;
}

// `running` has live-process evidence. `open` has an unfinished record Arc cannot place as
// live, so it reads running with no time and draws its mark in the idle tone.
export type AgentState = 'done' | 'running' | 'open' | 'failed' | 'interrupted' | 'stopped';

export interface CommitCard {
  objectSha?: string;
  kind: 'commit' | 'landing';
  key: string;
  sha: string;
  subject: string;
  // The repository the commit is in: git's key for it, the name a heading draws for it, and
  // whether it is the open folder's own. Null until git has named it.
  repository: { key: string; name: string; own: boolean } | null;
  branch: string | null;
  headKind: 'branch' | 'detached' | null;
  dir: string | null; // repository directory used when the commit opens in the editor
  // "in side-repo", drawn for a commit made outside the open folder: another repository by
  // name, or a worktree of this one. A grouped record draws it on the group heading, and a
  // one-group record draws it beside the count.
  where: string | null;
  detail: string; // the row's hover: the subject in full, its file count, and where it landed
  added: number | null;
  removed: number | null;
  at: number;
  // The full local time. The row ends its hover with it and reads it out in hidden text, and
  // both are written again on every clock tick, so a row drawn yesterday gains its day name.
  absolute: string;
  madeBy?: string;
  madeBySession: string | null; // the maker's own session, which the maker name opens
  mergedBranch?: string | null; // on a landing: the branch the merge brought in
  landingTarget?: string; // on a landing: the branch that moved
}

// What a file row draws in its icon column. The lettered badge is always worked out here, so
// no row is ever blank; the icon from the reader's own icon theme is drawn in front of it
// when there is one. Only the panel can fill that half in, because finding the theme needs
// the editor, so it arrives on the card rather than being built here.
export type RowIcon = FileIcon & {
  glyph?: { character: string; font: string; size: string; colour: string };
  image?: string; // a URI the panel can load the image from
};

// An answer the turn closed before its last one. The relative wording is not carried:
// the panel words it from its own clock through the same ticker every card time uses,
// the way the rail words its times, so a redraw cannot flick it backwards. The host
// fills `summaryHtml` in beside the card's own, because rendering needs the renderer.
export interface AnswerCard {
  summary: string; // the answer's markdown
  at: number;
  absolute: string; // the clock time, for the hover
  summaryHtml?: string;
}

// One mid-turn message, as the "Said while working" section draws it. Two records feed the
// section and it draws them the same way, so one shape carries both: a narration the agent
// wrote on its way to the answer, and a reply it closed before its last one.
//
// `id` is the message's identity, and the section keys every piece of its state by it. A
// message arriving with an earlier stamp inserts above the others and renumbers none of
// them, which a place in the list cannot promise.
//
// `text` is markdown and the host fills `summaryHtml` beside it, because rendering needs the
// renderer. `when` is the clock time the meta line draws, which carries no day and never
// moves. `absolute` is the same moment in full, for the hover every message now carries. It
// is the one clock-worded value here, so `cardPrint` projects it out. `answerIndex` is a
// reply's index into `earlierAnswers`, which the card still carries newest first: a comment
// anchors by that index, so the section draws it rather than a place of its own.
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

// One thing the reader typed after the turn had started, as the card draws it under
// "You asked". Drawn in full: the section names itself after everything the reader asked,
// and a turn that answered a question the card only summarises is a card the reader cannot
// check.
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
  // Whose the row is. A tool call belongs to the agent and a prompt to the reader, and the
  // log runs them together in time order, so the two are told apart by a word and a mark
  // rather than left to be inferred from the wording.
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
  // The words in front of the literal: "Read", "Started a subagent:". The whole row where
  // there is no literal on it.
  line: string;
  // What the agent handed the tool, drawn after the words in the editor's own face: a
  // command, a path, a pattern, a URL. Empty on a row that is all words.
  code: string;
  // The word the row ends on, which is what the glyph beside the line says and the words do
  // not. Empty on a row whose line says everything, and never set on the one still running,
  // whose figure is a clock.
  figure: string;
  // When the step started, for the one still running, whose figure the panel's own ticker
  // counts up. Null on every step that has come back.
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
  // A skill load sits in no tool category. It keeps its own so the breakdown of the
  // unrecognized calls does not list it as one.
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
  // The headline with its inline Markdown drawn, when the summary line it came from carried
  // any: a code span, an emphasis run. Absent everywhere else, including a headline taken
  // from an error, a running prompt or a stock line, which stay plain.
  headlineHtml?: string;
  prompt: string;
  delegation: string;
  promptHeading: string;
  promptNotice: string;
  summary: string;
  // Newest first, and no longer a render list: the section below draws these answers, and
  // this stays as the index a comment left on one anchors by.
  earlierAnswers: AnswerCard[];
  // Every message the agent produced while the turn ran, oldest first.
  saidMessages: SaidCard[];
  saidName: string; // what the section's head is announced by
  saidMix: string; // the counts the shut head shows, without the title
  // What the reader typed while the turn ran, oldest first, drawn under the opening prompt.
  laterPrompts: AskCard[];
  sessionTitle: string | null;
  // `path` is what the transcript recorded and what everything acting on the row uses:
  // opening it, the context object the editor's menu is drawn from, the store lookups.
  // `shownPath` is the same path in the spelling the panel reads out and hovers with.
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
  // The step the agent is on, drawn on a folded running card so what is happening is
  // readable without opening it. Empty on a turn that has done nothing yet or has stopped.
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

// What each agent is called on a card. One list now draws turns from two of them, and the
// model id is not the answer: a turn whose model was never recorded shows nothing at all,
// and a reader who has to know the model ids to tell the sources apart is being asked to
// hold the panel's own knowledge. Every card names its agent, including when only one is on
// screen, because a badge that appears only sometimes is one the reader has to reason about.
//
// The short name, not the product's. A card names which agent produced the turn, and one
// word against one word is what keeps the rail's meta line on one line at the widths the
// rail is drawn at; the two-word name wrapped there and took the time beside it with it.
// The product name stays where the reader is picking or configuring a program to run: the
// composer's agent list, and the setting holding the path to the executable.
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

// Every mark a card can carry, in the order they are said. The order is the order they
// are wanted in: what the reader has to act on, then what the turn said about itself, then
// what it did to the files. A card carries the ones it earned and nothing else, and says
// them in words: in the head row's accessible name and again on its hover.
//
// Two sources feed one list. The upper half is what the turn's own closing summary declared,
// one symbol at the head of each line of its opening list. The lower half is worked out
// here from what the turn changed, so it is right by construction and it is there on every
// turn already recorded, including every turn written before the summary format had
// symbols at all.
//
// Held as one table so a character, its place in the order and the word for it cannot drift
// apart. The word matters: a pictograph is read out by its Unicode name, so a tick would be
// announced as "white heavy check mark".
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

// The mark a character stands for, or undefined for anything else. A symbol written with a
// trailing variation selector, U+FE0F, is the same mark as the bare one. The warning sign
// is the case that matters: it is nearly always typed with the selector, and the table
// holds it without, because that form keeps its width steady wherever it is drawn.
const MARK_BY_CHARACTER = new Map(MARKS.map((m) => [m.character, m]));

function markFor(character: string): Mark | undefined {
  return MARK_BY_CHARACTER.get(character.replace(/\uFE0F/g, ''));
}

// Everything an emoji can be built out of: the pictograph, the joiner that ties two of them
// together, a skin tone, and the selector that asks for the coloured form. A symbol written
// as a joined sequence, a raised hand with a gender sign on it for one, is a run of these.
const SYMBOL_RUN = /^[\p{Extended_Pictographic}\u200D\uFE0F\u{1F3FB}-\u{1F3FF}]+/u;

// The symbol a line opens with, reduced to the character the table is keyed by. Read as
// whole characters rather than as the pairs a string is stored in, so an emoji is one thing
// and not two halves, and a joined sequence marks the same as the plain symbol it is
// built on.
export function leadingSymbol(line: string): string | null {
  const first = Array.from(line)[0];
  return first && markFor(first) ? first : null;
}

// The headline with the symbol it opens with taken off, and with whatever that symbol was
// joined to. The card already carries that symbol as a mark, said in words in the head
// row's name and on its hover, so leaving it here says the same thing twice and says it
// once as the Unicode name of a pictograph. A symbol the table does not hold is left where
// it was written, since no mark stands in for it.
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

// When a turn reads as a removal rather than a change: it took out at least twice what it
// put in. Twice, not more, because a turn that deletes a file and adds an import in its
// place is still a removal to whoever is reading the list.
const REMOVAL_RATIO = 2;

// What the turn's own summary said about itself, as mark ids. Only the list the summary
// opens with is read; `openingLines` says why.
function declaredMarkIds(summary: string): string[] {
  const ids: string[] = [];
  for (const line of openingLines(summary)) {
    const symbol = leadingSymbol(line);
    const mark = symbol ? markFor(symbol) : undefined;
    // A symbol the table does not hold adds no mark, and stays visible in the headline
    // where it was written. An invented one is then something the reader can see rather
    // than something the panel quietly swallowed.
    if (mark) {
      ids.push(mark.id);
    }
  }
  return ids;
}

// What the turn did, as mark ids, worked out from what it changed. A turn that touched a
// doc is marked as touching one; none of these claim the turn was only that, because a
// mark that only appears for a pure docs turn would never appear.
function derivedMarkIds(turn: Turn, added: number, removed: number): string[] {
  const ids: string[] = [];
  // Not a claim that the turn changed something, which is why it is worded as a gap rather
  // than as a count. It says the file list is the most the source could record, and that
  // the turn did the kind of work that can go unrecorded.
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
  // The first toned band, so the words on the head row and the tone on the chip beside them
  // arrive together. `MARKS` keeps its one fixed word, `context filling up`, because it is a
  // one-table vocabulary and the chip's own hover carries the gradation: a turn at 95% is
  // announced "context filling up" by its mark and "nearly full" by its chip, which is a
  // difference of intensity and not of fact.
  const share = contextShare(turn);
  if (share !== null && bandForPercent(wholePercent(share))) {
    ids.push('context');
  }
  return ids;
}

// What the turn is waiting on the reader for, read from the rows its summary closes with.
//
// A third source beside the two above, and the only one that can count. The declared marks
// read the symbol at the head of each line the summary opens with, so a turn says it needs
// the reader by writing a raised hand there; these rows say the same thing in a named row
// with the detail in it. A turn can do either or both, and the card marks it once.
export interface Waiting {
  needsYou: boolean; // the actions row carries something only the reader can do
  questions: boolean; // the questions row carries something waiting on an answer
  questionCount: number | null; // how many, when the row numbers them
}

// A row written to say it holds nothing. The summary format now leaves such a row out
// instead, but every turn recorded before that wrote one anyway, so reading those as real
// would mark every turn already on disk as waiting on the reader. That is the one thing
// this must not do: a filter that matches everything answers nothing.
const NOTHING_IN_IT = /^(none|nothing|no|n\/a|not applicable|not blocked)\b/i;

function rowHasContent(row: string | null): boolean {
  const text = (row ?? '').trim();
  return text !== '' && !NOTHING_IN_IT.test(text);
}

// How many questions a row holds, from the numbering it was written with, or null when it
// carries no count to read. Only a run starting at one counts: a stray (2) in prose is not
// two questions, and a row that numbers nothing is badged without a number rather than
// with a guess. A single question is written without numbering far more often than with
// it, so one lone marker is prose too.
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

// The same answer from rows already read. `toCard` reads a summary's rows once and hands
// them to this and to the chips, rather than parsing every summary twice on every repaint.
export function waitingFrom(rows: ClosingRows): Waiting {
  const questions = rowHasContent(rows.questions);
  return {
    needsYou: rowHasContent(rows.actions),
    questions,
    questionCount: questions ? enumeratedCount(rows.questions as string) : null,
  };
}

// Every mark the turn earned, each one once, in the table's order.
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

// Whether opening a card should record it as read.
//
// Not a running turn: a card's key is its session and its start, and neither moves as the
// turn grows, so one opened while it was still running would stay marked read after it
// gained the summary the reader never saw.
//
// Not a compaction either. A read turn is shown by taking the tint off the card and
// dropping its headline to the weight of ordinary text, and a compaction wears neither to
// begin with, so there is nothing the mark could change and no reason to spend a slot in
// the set on it.
export { canMarkRead } from './domain/read.ts';

// The section a turn card names itself by for the editor's own context menu. The section is
// the one piece of a webview's context a menu's when clause can match, so everything that
// decides which entries a card offers is spelled into the name rather than sent beside it.
//
// Two things decide it, and they move independently. Whether the read state can be set at
// all, which is `canMarkRead`, chooses between the mark and the way back and leaves the menu
// offering exactly the one the card has not already taken. Whether the card holds a summary
// decides whether the copy is offered, since a card with nothing to copy must not offer to.
// Five names cover the pair, and a card with neither names nothing: an entry that matches
// on a section then matches on none of them, which is what leaves such a card offering the
// comment entry alone.
//
// A card's kind is nowhere in the rule. A running turn and a compaction that carried a
// summary over both reach the summary-only name, because the question asked of each is the
// same one: this card cannot take a read state and it has something worth copying.
export const TURN_MENU_SECTIONS = {
  ...SHARED_TURN_MENU_SECTIONS,
} as const;

export function turnMenuSection(
  card: { kind: string; live?: boolean; summary?: string },
  isRead: boolean,
): string | null {
  return sharedTurnMenuSection(card, isRead);
}

// Where on a card the reader opened the menu. A card names itself to the editor in two
// places now, and the two are not quite the same offer.
export type TurnMenuNode = SharedTurnMenuNode;

// The whole context object one of a card's two nodes names itself to the editor by.
//
// Both nodes carry the same section and the same key, so the entries the editor draws are
// the same entries. What the card can take and what it has to copy is the whole of that
// decision, and where the reader happened to right-click was never part of it. The section
// a card with no summary reaches is already the right one, so neither node needs a name the
// manifest does not already match: this is one section written to a second element.
//
// The section stays the question of what the card can take and what it has to copy. The
// flag beside it is a second question, whether a comment left here would be drawn, and the
// two answer independently: a turn with no summary and no read state to take still takes a
// comment, and a compaction that carried a summary over offers the copy and no comment.
//
// The other difference is whether the editor's own entries are taken away, and it is the
// reason the node is asked about. The head row is a run of a glyph and figures with nothing
// on it worth copying, so it suppresses them and the reader is offered the turn's entries
// alone. The body holds the response, which is the one part of a card that is prose a reader
// selects, so it keeps the editor's own Copy and gains the turn's entries under it.
// Suppressing there would take a reader's copy off the very text they had just selected,
// which is what they opened the menu for.
//
// A rendered file link inside a summary carries a context of its own, and the editor reads
// the context off the element clicked and its ancestors with the nearest one winning, so a
// right-click on a link still draws the link's menu and not this. That is right: a reader
// on a link is asking about the file, not about the turn.
export function turnMenuContext(
  card: { kind: string; live?: boolean; summary?: string; key: string; sessionId: string },
  isRead: boolean,
  where: TurnMenuNode,
  hasComments: boolean,
): TurnMenuContext | null {
  return sharedTurnMenuContext(card, isRead, where, hasComments);
}

// Every field a card hands the editor. `webviewSection` is the one a `when` clause matches
// by name, and it is absent on a card with nothing to mark and nothing to copy.
// `arcTurn` is the flag a card that takes a comment carries, because the editor makes a
// context key of each field and the comment entry matches that one instead of a section.
// `arcComments` is the flag a card carries when that turn has comments on it, and what
// that entry copies is this turn's alone. `session` rides beside the key because the two
// together are what names a turn's comments: a turn key carries its session, but reading
// it back out of the key would be a second copy of `turnKey`'s shape.
export type TurnMenuContext = SharedTurnMenuContext;

// How each status is said. The card shows it as a coloured glyph, and a glyph is read out
// as nothing at all, so the word beside it is the only thing carrying it.
export const STATUS_WORDS: Record<TurnStatus, string> = {
  done: 'finished',
  failed: 'failed',
  interrupted: 'stopped by you',
  running: 'running',
  stopped: 'left unfinished',
};

// A card's head row is a run of a glyph and figures, which says nothing when read out in
// order, so the row carries a name built from the same values. Everything the row shows is
// in it: a name that leaves out text the reader can see is a name they cannot use to ask
// for the control they are looking at.
export function headLabel(kind: string, parts: (string | null)[], headline: string): string {
  return [kind, ...parts].filter(Boolean).join(', ') + '. ' + headline;
}

// What a file row is announced by. The row draws its name beside a count of added and
// removed lines, which reads aloud as a run of punctuation, so the row is named here
// instead. Two files in one turn can share a basename, and a reader who cannot see the two
// rows would hear the same thing twice, so each name grows leftwards along its own path
// until it tells them apart.
export function distinctNames(paths: string[]): string[] {
  const parts = paths.map((p) => p.split(/[\\/]/).filter(Boolean));
  const depth = parts.map(() => 1);
  const nameAt = (i: number) => parts[i].slice(Math.max(0, parts[i].length - depth[i])).join('/');
  for (;;) {
    // Every name is read before any of them grows, so each round decides from one picture
    // rather than from a list changing underneath it.
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

// A path in the one spelling the panel draws and announces.
//
// The two readers record a path in different shapes and a Windows path arrives with
// backslashes, so one card could show both: a commit's hover said `in C:/Users/dev/...`,
// because that directory is read out of a command and comes back unified, while the file
// rows above it said `C:\Users\dev\...`. Everything on screen is now the first shape.
//
// It is for reading only. Anything that acts on a path keeps what the transcript recorded:
// the copy commands, which write into a terminal or a file dialogue, the open message, the
// context object a row hands the editor, and the store lookups.
export function withForwardSlashes(target: string): string {
  return target.replace(/\\/g, '/');
}

// A path cut where the row draws it: the directory up to and including the last separator,
// and the filename after it. Handed a path already in the drawn spelling, because the row's
// hover carries that same spelling and the two have to read alike. A path with no directory
// in front of the filename has no lead at all, and is drawn as one piece.
function splitPath(target: string): { lead: string; name: string } {
  const cut = target.lastIndexOf('/');
  const name = target.slice(cut + 1);
  return name ? { lead: target.slice(0, cut + 1), name } : { lead: '', name: target };
}

// What a file row draws for its name, and what it is announced by.
//
// `name` is the filename, and the row never lets it shrink. `lead` is the directory in
// front of it, present only on a row drawing a whole path, and it is the piece that gives
// way when the panel is narrow.
export interface FileRowName {
  name: string;
  lead?: string;
  spoken: string;
}

// A file under one of the open folders is drawn by its basename, which is how the reader
// already talks about it. A file outside every open folder has a basename that says
// nothing about where it is: a scratch file in the temp directory and a source file in
// the repo both read as `notes.md`, and only one of them is the reader's work. Those are
// drawn by their whole path instead, in two pieces: the row truncates on the right, so one
// string would cut the filename off and leave the reader the half of the path they could
// already guess.
//
// With no folder open there is nothing to be outside of, so being outside is unknowable
// rather than true and every row says the smaller thing.
//
// The spoken name follows the drawn one. A row showing a whole path announced by a
// basename names something the reader cannot see, so a full-path row is announced by that
// path and only a basename row grows leftwards until it is distinct. Growing is decided
// over the basename rows alone: a path row is already distinct from everything and is
// never heard as a basename, so counting it in hangs a directory on a row that has no
// collision the reader can see or hear.
//
// Every piece that leaves here is in the drawn spelling, forward slashes throughout. A
// basename row is already there, since `distinctNames` splits on either separator and joins
// with one; a whole-path row is put there. The card carries the path as recorded beside
// these, for everything that acts on it rather than reads it.
export function fileRowNames(paths: string[], folders: string[]): FileRowName[] {
  const byBaseName = paths.map((p) => folders.length === 0 || isInside(p, folders));
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

// How long a turn may record nothing before the panel stops calling it running.
//
// A turn is closed by the record that ends it, so a turn whose agent was killed part-way
// through is never closed and stays the newest turn in its session. Without a bound it
// is drawn as running for as long as the workspace exists: the rail gives up its time for the
// word, the duration counts up from a process that is gone, and the session cannot be
// marked read, because a running turn is one whose end the reader has not seen.
//
// An hour, from what the transcripts hold. Over the 113 most recently written on this machine
// there are 55,961 gaps between records inside an open turn. Half are under two seconds, 99.9
// percent are under twelve minutes, and eight are longer than an hour. So an hour of silence
// is a dead agent far more often than a slow tool call, and the reading corrects itself on the
// next record either way.
export const TURN_QUIET_MS = 60 * 60 * 1000;

// The word a turn's card and its rail card both wear.
//
// `stopped` is the answer for a turn nothing is going to finish, and it already reads as left
// unfinished, so a turn whose agent died needs no word of its own. Which is also why the quiet
// window is read here rather than at the card: everything that asks what a turn is doing asks
// this, and a second place that decided it from the clock would let the rail and the card say
// different things about the same turn.
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
  // A turn whose end time could not be read carries a zero, because `stamp` answers zero for
  // a time it cannot parse. Aged against the clock a zero is older than anything, so the one
  // turn nobody can time would be the one turn always called dead. It keeps the word instead:
  // the window narrows a claim the panel already makes, and it must not widen it.
  return turn.endedAt <= 0 || now - turn.endedAt <= TURN_QUIET_MS ? 'running' : 'stopped';
}

// Whether any of these turns says something different at one clock from what it said at
// another. The newest turn of each session is what the caller passes, so `isLatest` is
// true for every one of them.
//
// The panel's poll skips the parse when nothing about the listing moved, and a turn whose agent
// died is never written to again, so its listing never moves. Without this the card it was
// drawn as would keep the word running for as long as the panel stayed open.
//
// Asked of `statusOf` at both clocks rather than by reading the window here. A second copy of
// the rule would wake the poll on a boundary the card does not draw, or leave the card sitting
// past one it does.
//
// A zero for the earlier clock means nothing has been drawn yet, and nothing drawn is nothing
// to have moved.
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

// One retained call category counted into a turn's mix.
//
// A category this panel has never heard of is an unrecognized tool, and `other` is where it
// belongs. A skill load is the exception. It holds its slot in `stepKinds` so the categories
// stay aligned with the step ordinals, and it counts in no tool category at all: a skill is
// instructions the agent took on rather than a tool it ran, and counting it as an unknown
// call is what put a skill load in the `other` breakdown.
function countStepKind(counts: ToolCounts, kind: string | undefined): void {
  if (kind === SKILL_STEP_KIND) {
    return;
  }
  counts[kind !== undefined && Object.hasOwn(counts, kind) ? (kind as keyof ToolCounts) : 'other']++;
}

// What the turn spent its calls on, longest first, so a research turn and an editing
// turn look different at a glance.
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

// The skills a turn loaded, one row each, in the order the turn first loaded them.
//
// A skill loaded twice is one row with a count, because the row's subject is the skill and
// not the call. Where two loads of one skill disagree, the first load that carried a value
// wins, and a recorded load outranks a best-effort one however many of those sit beside it:
// one record naming the skill is proof, and a file read is an inference.
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

// Which model a subagent ran on. The tool call names one only when the caller asked for it,
// which is rare, so the usual answer comes from the child's own transcript by way of its
// spend. The call still wins where both exist, because that is what the caller asked for.
// A child that changed model mid-run reports the one it spent most of its tokens under, and
// the full split stays in the cost rows. A child with no spend read yet has no answer here,
// which is the same silence as a call that named nothing.
function agentModel(agent: TurnAgent): string | null {
  if (agent.model) {
    return agent.model;
  }
  let heaviest: ModelSpend | null = null;
  for (const part of agent.spend) {
    if (!part.model) {
      continue;
    }
    if (!heaviest || usageTokens(part.usage) > usageTokens(heaviest.usage)) {
      heaviest = part;
    }
  }
  return heaviest ? heaviest.model : null;
}

// What a child's recorded status says about it. Both readers write `running`, and a child the
// parent turn ended without an answer from stays open as `async_launched` in Claude and
// `launched` in Codex. `completed` is the one clean finish. Claude passes other task words
// through raw, such as `killed`, and every word that names no finish and no fault reads as
// stopped, so only a real failure draws the red cross.
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

// The word a row draws on its face, and the word that closes its summary. An `open` child
// says what Arc holds rather than that work goes on, because the parent turn ended and nothing
// says the child is alive. Its mark already wears the idle tone, and its records and the turn's
// cost list say the same thing in a sentence.
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
// What a row in the `open` state says instead. Its turn ended, nothing says the child is alive,
// and the row draws its mark in the idle tone. A note that calls such a child still running
// claims more than the mark beside it, so it says what Arc actually holds.
const AGENT_COST_NO_ENDING = 'This subagent recorded no ending. This is the cost Arc read.';
const AGENT_USAGE_NO_ENDING = 'This subagent recorded no ending. This is the usage Arc read.';
const AGENT_NO_COST_NO_ENDING = 'This subagent recorded no ending. No cost is recorded.';
const AGENT_NESTED_COST_SO_FAR = 'Some nested subagents are still running or left no record. This is the cost so far.';
// A Claude CLI run that Codex started reports its cost only in a complete result.
const AGENT_CLI_COST_MISSING = 'Claude CLI did not report the full cost of this run.';
// Arc does not read the children a Codex subagent starts, so their cost never reaches its row.
const AGENT_CODEX_NESTED_COST_MISSING = 'This cost leaves out the subagents that this subagent started.';
// What a cost block says about itself rather than about what the child bought. A block whose
// only lines are these has no figures to head.
const COST_NOTES = new Set([
  AGENT_COST_SO_FAR,
  AGENT_COST_NO_ENDING,
  AGENT_NESTED_COST_SO_FAR,
  AGENT_CLI_COST_MISSING,
  AGENT_CODEX_NESTED_COST_MISSING,
]);
// What a partial record says about its own reach, on the figure that draws that record.
const AGENT_RECORD_CUT_SHORT = "This child session's record ended early, so this list holds only what Arc read.";

// What says a background child still works after its turn ended. `session` is a busy host
// process for the session. `children` holds the ids of the open children whose own
// transcript was written inside the quiet window, the ones the rail counts as live.
export interface AgentLive {
  session: boolean;
  children: ReadonlySet<string>;
}

// A synchronous child cannot outlive the turn that waited for it. A `running` record on a
// finished turn therefore marks a lost ending. Only background launch records can use the
// session's live-process signal or their own fresh write after their turn ends.
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

// One cost line as the hover writes it. The hint box has one line per item and no room for a
// second rank, so a line keeps its own words and leaves the cache reading and any line under
// it to the cost popover, which draws both.
function hintDetailLine(line: StatDetailLine): string {
  if (typeof line === 'string') {
    return line;
  }
  return 'text' in line ? line.text : `${line.lead}${line.trail}`;
}

// The cost figure's record: the blocks the cost popover draws for the same child, so the
// figure and the popover cannot price or group one spend part two ways. The total is left
// out, because the figure the record hangs under already carries it.
//
// A note is not a priced line. A spend part Arc cannot price leaves its entry with a heading
// and nothing under it but the note that says so, and a heading over a lone note reads as a
// section whose figures went missing. Such a block draws its note as its own line instead.
function agentCostEntries(agent: TurnAgent, partial: boolean, runner: AgentKind, noEnding: boolean): StatDetailEntry[] {
  if (!agent.spend.length) {
    return [];
  }
  const entries: StatDetailEntry[] = [];
  for (const entry of childCostEntries(agent, true, 'Cost by usage', runner, noEnding)) {
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
  // The child's own usage, under the money it came to. A priced child draws no tokens figure,
  // so this record is where its volume lives, and the turn's own token chip draws the same
  // blocks from the same builder. The totals cover every part above, including one that carried
  // no price, so a partial cost leads them with the words that say so. Without it the volume
  // reads as the usage the money beside it bought.
  const total = emptyUsage();
  for (const spend of agent.spend) {
    addUsage(total, spend.usage);
  }
  const usage = usageDetailEntries(total, partial ? [{ label: 'Every part above, priced or not' }] : []);
  if (usage.length) {
    entries.push({ ...usage[0], separateBefore: true }, ...usage.slice(1));
  }
  return entries;
}

// The commits figure's record as one run of text: the sha and the subject of each commit the
// child made. Where the child's evidence reached Arc as shas with no subjects behind them, the
// run names the shas alone. The drawn record is the card's own commit rows, filtered to these
// shas, so this run is what a reading without the popover is made of.
function agentCommitRecord(agent: TurnAgent, shas: readonly string[]): string[] {
  return agent.commits?.length ? agent.commits.map((commit) => `${commit.sha} ${commit.subject}`) : [...shas];
}

// The files figure's record as one run of text: the paths the child changed, whole rather than
// by their base names, because two children editing `index.ts` read as one file otherwise. The
// sentences `fileCountCaveats` wrote for the rows left short ride the record's own footer alone,
// so this run does not carry them a second time.
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
  // A recorded zero is absent from every figure, the same rule `diffHalves` holds for a
  // file's line counts, so a child that has not yet run a tool draws no figure at all.
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
  // A subagent row, a popover entry and the chip's text name no state for a finished child.
  // Only a state the reader acts on is drawn, such as a child still running or one that failed.
  const stateWord = AGENT_STATE_WORDS[state];
  const detail = [model, agent.effort, time, tools, ...usage];
  // The row's own record is the tool uses, which word the row's own state. The duration, the
  // cost, the commits, the paths and the token totals belong to the figures that total them,
  // so the row repeats no block a figure already answers for. The duration figure's record
  // splits the calls by tool name and draws no total, so this count is the only one. The count's
  // source depends on the row kind. docs/timeline.md names each source in the subagent
  // row's hover paragraph, which also says why a running child's hint keeps the time it has
  // run for.
  const figures = [open ? time : null, tools].filter(Boolean).join(' · ');
  return {
    hintDetail: figures,
    state,
    stateWord,
    summary: [...detail, stateWord].filter(Boolean).join(' · '),
    open,
  };
}

// The record a figure carries, headed by the words the figure itself speaks, so the popover
// never opens on the words under the pointer. A figure with nothing behind it takes no record,
// so the row draws it as plain text and the keyboard passes it by. A partial figure keeps its
// `At least` heading, and its record closes with how far the child's own record reached.
//
// `flat` is what a reading without the popover is made of. A record that draws rows carries
// none of them in its entries, so its own words have to be handed in.
//
// `headingLabel` stands in for `name` on the record's own heading alone, where a figure's
// spoken name and its record's heading are not the same words. The figure's name and the flat
// reading still carry `name`, because only the heading a reader opens differs.
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

// The usage figure a child draws where its row carries no cost. A priced child says its money
// on the cost figure and its token blocks inside that figure's record. A second figure for the
// same run would say one fact twice. A child whose spend carried no price keeps its usage here,
// and so does a child Arc read no spend for at all. Nothing else on such a row would hold it.
function agentTokensFigure(agent: TurnAgent, priced: boolean, running = false, noEnding = false): AgentFigure | null {
  if (priced) {
    return null;
  }
  // A recorded zero is absent, here as everywhere else on this row. A child whose record holds
  // no token at all draws no figure rather than a `0 tokens` the reader has to read first.
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
          entries: usageDetailEntries(total),
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

// Tool counts, largest first. Names that tie read in alphabetical order, so the same counts
// draw in the same order on every draw.
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

// The duration figure's record: what the child spent its time on and when it ran, read from
// the child's own transcript. The calls by tool name tell an implementer from a reviewer. They
// carry no total, because the row's hint already counts the child's tool uses. Failed calls
// appear only where one failed, and their count holds any failure whose tool went unnamed. The
// span is the local clock, because the figure already says how long. Turns joins the span,
// because it says how often the child ran rather than what it ran. It is absent for a Claude
// subagent, which always holds one turn, and present for a Codex child the parent prompted
// again or for a dispatched session someone resumed and typed into again.
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

// The duration figure's record as one run of text: the same lines `flatDetailList` would draw
// for its entries, minus its footer. No reader draws `detail` while a record exists, so the
// sentence `figureRecord` adds to the footer for an incomplete child stays there alone, the way
// the files figure's own flat run already leaves it, rather than doubling the payload for
// nothing.
function agentRunFlat(entries: StatDetailEntry[]): string[] {
  return entries.length
    ? ['', ...entries.flatMap((entry) => [...(entry.separateBefore ? [''] : []), ...flatDetailEntry(entry)])]
    : [];
}

// How long the child ran. The cost figure answers what it spent, and the commits and the files
// figures answer what it changed, so the time it held the turn up is the question the rest of
// the row leaves open. A recorded zero is absent, and a child whose record carries no time draws
// no figure at all. The figure opens the record of what the child ran, once Arc has read the
// child's own transcript.
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

// The card's own file rows, by the key a child's paths are already gathered under. A child
// records the spelling its transcript held, and the turn's file list records the spelling the
// edit held, so the two name one file in two spellings. The figure carries the card's own
// spelling, which is what the record filters its rows by.
export function fileRowPathsByKey(files: readonly { path: string }[]): Map<string, string> {
  const keyed = new Map<string, string>();
  for (const file of files) {
    keyed.set(normalizeFsPath(file.path), file.path);
  }
  return keyed;
}

function agentFigures(
  agent: TurnAgent,
  state: AgentState,
  rowPaths: ReadonlyMap<string, string>,
  now: number,
  runner: AgentKind,
): AgentFigure[] {
  const figures: AgentFigure[] = [];
  const priced = spendCost(agent);
  const cost = formatCost(priced.dollars);
  // A running child can still spend more, so its cost and tokens read as a lower bound. It
  // draws no commits and no files, because the child can still add to them or undo them.
  const running = state === 'running' || state === 'open';
  // An open child's turn ended and nothing says the child is alive, so its notes drop the words
  // that claim it still works and keep the idle tone its mark already wears.
  const noEnding = state === 'open';
  if (cost) {
    const partial = priced.partial || running;
    // The spoken name says what the money is, because the face carries the amount alone.
    const name = `${partial ? `At least ${cost}` : cost} spent`;
    figures.push({
      metric: 'cost',
      compactLabel: `${cost}${partial ? '+' : ''}`,
      name,
      ...figureRecord(name, { entries: agentCostEntries(agent, partial, runner, noEnding) }, false),
    });
  }
  if (running) {
    const tokens = agentTokensFigure(agent, !!cost, true, noEnding);
    return tokens ? [...figures, tokens] : figures;
  }
  const ran = agentDurationFigure(agent, now);
  if (ran) {
    figures.push(ran);
  }
  const artifacts = agent.artifacts;
  const partial = !!artifacts && !artifacts.complete;
  // A recorded zero is absent. A child that committed nothing draws no commits figure, rather
  // than a `0 commits` a reader has to read before learning it says nothing.
  if (artifacts?.commits.length) {
    const commits = `${artifacts.commits.length} commit${artifacts.commits.length === 1 ? '' : 's'}`;
    // The figure's own spoken name keeps `made`, the word a press announces. Its record's
    // heading does not: the heading sits beside the branch fact, where `made` reads as noise.
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
    const fileLabel = partial ? files.label.replace(' ', '+ ') : files.label;
    const name = files.name ? (partial ? `At least ${files.name}` : files.name) : fileLabel;
    // The figure speaks a name whatever its label comes to, because a figure that opens a
    // record is a press, and a press with no name reaches a screen reader as a nameless one.
    figures.push({
      metric: 'files',
      compactLabel: fileLabel,
      name,
      added: files.added,
      removed: files.removed,
      // Ordinary subagents read the parent card's merged rows. Dispatched children read their
      // own rows. Either path uses the spelling that its record filters.
      paths: artifacts.files.map((file) => rowPaths.get(normalizeFsPath(file.path)) ?? file.path),
      // The record draws the card's rows in place of entries, so the sentences that say why a
      // row's line counts are short ride its footer, the one text a record of rows draws beside
      // them. The figure's own face and spoken name say nothing about it.
      ...figureRecord(
        name,
        { layout: 'files', actions: true, entries: [], ...(caveats.length ? { footer: caveats } : {}) },
        partial,
        agentFileRecord(artifacts),
      ),
    });
  }
  const tokens = agentTokensFigure(agent, !!cost);
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
): AgentCard {
  const display = agentDisplay(agent, turnRunning, sessionLive);
  // Only a child with live-process evidence counts up. An open child draws no time.
  const launch = display.state === 'running' && agent.toolUseId ? launches.get(agent.toolUseId) : undefined;
  return {
    description: agent.description,
    model: shortModel(agentModel(agent)),
    effort: agent.effort,
    figures: agentFigures(agent, display.state, rowPaths, now, runner),
    state: display.state,
    stateWord: display.stateWord,
    since: display.state === 'running' ? agent.startedAt || launch?.step.at || null : null,
    hintDetail: display.hintDetail,
    sessionId: agent.childSessionId ?? null,
  };
}

// The state a dispatched session's row draws, from the session's rail status. A session whose
// main agent closed its turn still works while its background subagents or commands run, so
// the rail's `subagents` and `background` read running here. A status with no row word of its
// own, or none at all, reads stopped.
export function dispatchedState(status: RailStatus | undefined): AgentState {
  switch (status) {
    case 'running':
    case 'subagents':
    case 'background':
      return 'running';
    case 'failed':
    case 'interrupted':
    case 'done':
      return status;
    default:
      return 'stopped';
  }
}

// The Dispatched figure of a parent card, built from its dispatched rows. Its running mark and
// its popover heading count the running rows, as the subagents figure counts its live children.
// A dispatched session runs apart from its parent, so a row counts whether or not the parent's
// own turn still runs.
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
): AgentCard {
  const agent: TurnAgent = {
    id: sessionId,
    childSessionId: sessionId,
    description,
    agentType: null,
    model: null,
    effort: spend.effort,
    spend: spend.models,
    spendFound: spend.found,
    spendPartial: spend.partial,
    spendUnfinished: spend.unfinished,
    commits: spend.commits,
    artifacts: spend.artifacts,
    durationMs: state === 'running' || startedAt === null || endedAt === null ? null : Math.max(0, endedAt - startedAt),
    tokens: null,
    toolUses,
    status: state === 'done' ? 'completed' : state,
  };
  const live = { session: false, children: state === 'running' ? new Set([sessionId]) : new Set<string>() };
  const files = state === 'running' ? [] : fileCardsOf(spend.artifacts?.files ?? [], folders);
  const commits = state === 'running' ? [] : (spend.commits ?? []).map((commit) => commitCard(commit, now));
  const card = agentCard(agent, false, live, new Map(), fileRowPathsByKey(files), now);
  return { ...card, kind: 'dispatch', files, commits, since: state === 'running' ? startedAt : null };
}

// A subagent and the step that launched it, paired by the launch call's id. The card's
// Activity row for the step and the subagent's own row both read this one pairing. A step's
// time is when the parent recorded the call.
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

// What a file row says about a subagent that changed it. The row draws the file the same way
// whoever changed it, because it is one file and one press, so the name rides on the hover and
// on the row's spoken name.
const FILE_CHANGED_BY = (madeBy: string): string => `changed by ${madeBy}`;

// What the group heading and the hover say for a commit whose repository cannot be named. The
// heading draws the short words, and the hover carries the reason.
const COMMIT_ELSEWHERE = 'in another repository';

const COMMIT_ELSEWHERE_DETAIL =
  'In another repository. The call committed to more than one, so which one cannot be said.';

// What a commit made in a linked worktree of this repository says. The words stand on the
// group heading beside the branch, and the word `worktree` separates them from a nested
// repository, which the heading names by its own prefix.
//
// The worktree and the branch are different facts: the worktree is where to look on disk, and
// the branch is what to merge. A worktree named for the branch it holds says nothing the branch
// has not said, so its heading draws the branch alone.
const COMMIT_WORKTREE = (dir: string): string => `in worktree ${baseName(dir)}`;

// The same relation from the other side, for a reader whose open folder is a worktree. The
// tree the worktrees came from is not a worktree of anything, so it is not called one.
const COMMIT_MAINTREE = 'in the main tree';

// What a commit row carries, and what its hover says.
//
// The row draws the hash, the subject and the line counts. The record's group heading draws
// the branch and the place, from `branch`, `repository` and `where`, or the section heading does
// when the record holds one group. The hover repeats the subject and adds the file count, which
// has nowhere else to go, and ends with the full local time. It names the place only for another
// repository, whose heading names that repository by a short name. The time is kept out of
// `detail` so the clock can write it again without the card's content reading as changed.
//
// A commit made in another repository from the same session draws on this card exactly like
// one made here, so its heading names that repository and the hover carries the whole path. A
// commit made in a linked worktree of this repository is this project's own work, on a branch
// the reader will merge, so its heading names the worktree and never another repository.
//
// A call that committed to more than one repository, all of them outside the open folders, can
// say that much and no more. The heading carries the short words and the hover the reason.
//
// The path on the hover goes through `withForwardSlashes`, the way every other path the panel
// draws does.
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

// The repository a row names on its group heading. The open folder's own repository is named
// by nothing, since the card already stands in it. Another one is named by its tree's path
// under the open folder when it sits inside one, as a nested repository does, and by its
// folder name otherwise. A worktree of the open folder's repository is the same repository.
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

// One file the turn changed, and the child that changed it where a child did.
//
// The two count marks are what `settleCounts` leaves on the row. `countsUnknown` stays what the
// rest of the panel reads it as: the row carries no line count at all. `countsPartial` is the row
// that carries one and is still short, because one record of the path held its hunks and another
// named it without them. Its counts are a floor.
interface AttributedFile extends ChildFileChange {
  madeBy?: string;
}

// The turn's own file changes and every child's, merged into one list, the way `attributedCommits`
// merges a child's commits into the turn's.
//
// A child's edits are recorded in the child's own transcript, and the parent reducer drops every
// record a child wrote, so the turn's own list holds none of them. Without the merge a child's
// files record filters the card's rows down to nothing, and the card's Files section leaves a
// delegated change unnamed.
//
// A path more than one record names is one row, because it is one file. Its counts add up every
// record of it, since each record is a separate edit the turn made or delegated. A row says who
// changed it only where one child changed it and the turn's own record holds none of it, so a
// file two hands touched names neither of them.
function attributedFiles(turn: Turn): AttributedFile[] {
  const rows: AttributedFile[] = turn.files.map((file) => {
    const row: AttributedFile = {
      path: file.path,
      added: file.added,
      removed: file.removed,
      isNew: file.isNew,
      ...(file.countsUnknown ? { countsUnknown: file.countsUnknown } : {}),
      ...(file.unknownReason ? { unknownReason: file.unknownReason } : {}),
    };
    // The turn's own reader keeps an Edit's counted lines on a row a later Write left
    // uncounted, so the turn's own rows settle by the same rule a child's rows do.
    settleCounts(row);
    return row;
  });
  const at = new Map<string, number>();
  rows.forEach((row, index) => {
    at.set(normalizeFsPath(row.path), index);
  });
  for (const agent of turn.agents) {
    for (const file of agent.artifacts?.files ?? []) {
      const key = normalizeFsPath(file.path);
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
      // A child row can arrive already settled to partial, and it still carries the cause its
      // reducer kept. The later record's cause replaces the held one, the rule
      // `reduceChildArtifacts` follows for one child's records of a path.
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

// A tree the turn fast-forwarded, drawn in the commits record beside the commits.
//
// The fields are the commit row's fields, so the panel reads one shape. A landing whose merged
// branch holds a commit of the turn is drawn as that branch's arrival on its group heading, and
// any other landing is a row under the branch that moved. `groupCommitRows` decides which.
//
// A landing changes no files, so it carries no counts. Its time is when the turn landed it,
// which is later than the commit's own and often much later.
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

function inputTokenCategoryLines(usage: Turn['usage']): string[] {
  const out: string[] = [];
  const hit = cacheHitPercent(usage);
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

// What one run of usage comes to, block by block. The turn's own token chip and a subagent
// row's cost record both draw it, so the two cannot count or word one usage two ways.
function usageDetailEntries(u: Turn['usage'], lead: StatDetailEntry[] = []): StatDetailEntry[] {
  const entries: StatDetailEntry[] = [...lead];
  const input = inputSideTokens(u);
  if (input) {
    entries.push({ label: 'Input', value: `${detailedTokens(input)} tokens` });
  }
  if (u.output) {
    entries.push({
      label: 'Output',
      value: `${detailedTokens(u.output)} tokens`,
      ...(u.thinking
        ? {
            lines: [
              `Thinking: ${detailedTokens(u.thinking)} tokens (${Math.round((u.thinking / u.output) * 100)}% of output), included in output`,
            ],
          }
        : {}),
    });
  }
  const requests = u.requests ?? 0;
  const average = averageContextPerRequest(u);
  if (requests) {
    entries.push({
      label: 'Model requests',
      value: String(requests),
      ...(requests > 1 && average !== null && average > 0
        ? { lines: [`Average input per request: ${detailedTokens(average)} tokens`] }
        : {}),
    });
  }
  const breakdown = inputTokenCategoryLines(u);
  if (breakdown.length) {
    entries.push({ label: 'Input breakdown', separateBefore: true, lines: breakdown });
  }
  return entries;
}

// The token chip explains volume. Cost belongs to the cost chip, and a subagent's own usage
// belongs to that row's cost record, so neither is repeated here.
function tokenDetailList(turn: Turn): StatDetailList {
  return { entries: usageDetailEntries(turn.usage, turn.agents.length ? [{ label: 'Main agent only' }] : []) };
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

// The amount the chip can price, and whether a child is still outside it. A plus sign is a
// lower bound rather than an estimate invented for a missing transcript or unknown model.
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

// Prices a dispatched session's parts. The figures cache calls it once per change, so a card
// draw only reads the prices.
export function priceDispatchedParts(parts: readonly DispatchedCostUsage[]): PricedDispatchedCost[] {
  return parts.map((part) => priceSessionCost(part) as PricedDispatchedCost);
}

// What one dispatched session adds to the session that started it. `short` says that some of
// its usage has not joined yet. `ownSettledAt` is the start of the newest turn in the
// dispatched session's own transcript when that transcript's group is ready and the ledger no
// longer holds the file, and null otherwise.
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

// One dispatched session's share of a card's cost. Each Claude print row of the same session on
// the card keeps its own amount in `turnCost`, so the share holds the session's cost less those
// rows. The share can do that only when the contribution holds the requests the rows priced:
// the priced usage of its own transcript covers the rows, the ledger no longer holds that
// transcript, and its newest turn started inside the parent turn. Otherwise the own
// transcript adds none of its usage, the rows count alone, and the share is short.
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
  // The own transcript alone must cover the rows, because priced descendants can stand in for
  // own requests that have no price.
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

// The card's cost: the parsed turn, then each dispatched session the card counts. `turnCost`
// stays the parsed turn alone, because the session heading sums it into the turns it read.
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

// The index of these references and threads. It is built again only when either list is
// replaced, so a card batch and the activity redraws after it share one index.
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

// The dispatch references a turn card counts in its cost. A direct one names the turn's
// session as its parent and holds one of the card's call ids. A session that one of the turn's
// subagents started names that subagent as its parent. The turn's subagents are the Claude
// references the turn's session launched with a call id of the card or a subagent row's tool use
// id, the native Codex threads the card's agent rows name, and the subagents those subagents
// started in turn. Only the card that holds the first launch id counts a session: the first id
// of a direct reference, or the first id of the top subagent on a subagent's chain. A later card
// that holds a later receipt counts nothing, so a session that appears on two cards of one parent
// adds its cost once. The reference returned for a session is the last one its Dispatched row
// reads, so the row and the cost entry show one name.
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

// The dispatched sessions a turn card counts, each with its contribution from `costsOf`, which
// gives the contributions to the turn's session by dispatched session id. It is called only for
// a card that counts a session, so a card with none never reads the ledger. A counted session with no
// contribution is short while `waiting` says the ledger or dispatch discovery has not caught
// up, and adds nothing otherwise, as the session total does for a child that left the catalog.
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

// Short, cheap scopes often have little reusable input. Color only material input spend,
// so output-heavy work cannot trigger a cache warning by itself. Low reuse alone does not prove waste.
//
// The price beside the share answers the one question a reader can act on: what one more
// request on this scope costs. A share cannot answer it. The worst turn measured in this
// project ran at a 99% cached share and still cost $96.59, so every share-based signal
// stays silent on it. The figure is descriptive, never a warning, because repeated context
// is the normal shape of a long session that reuses its cache correctly.
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

// What the record can say about a scope beyond its usage buckets. `complete` means the record
// can split this usage by category. `finished` means the scope has stopped running, so its
// totals will not grow. `recordedTotal` is a total the CLI recorded, which no category split
// reproduces.
interface ScopeFacts {
  complete?: boolean;
  finished?: boolean;
  recordedTotal?: number;
  // The total a caller already priced this same usage to. `costEntry` prices a spend part
  // and hands the answer down here, so this record does not price it a second time to work
  // out the cache-rate warning's input cost. `undefined` means no caller has priced it yet,
  // so this record prices it itself.
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
  // The only price this entry pays. The record below reads the answer instead of pricing the
  // same usage again for the cache-rate warning's input cost. The turn total prices this usage
  // once more, in `turnCost`, so a spend part is priced twice per card build.
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

// `name` heads the block the way every other cost block is headed, with the auto review named
// as the work the money bought. The session list passes none, because there the review's own
// name is the whole subject of the row.
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
    // A child whose whole work is the review is named by the review already, so the heading
    // says it once.
    label: name && name !== identity ? `${name} · ${identity}` : identity,
    value: sessionCostValue(costs, incomplete),
    ...(lines.length ? { lines } : {}),
  };
}

// The cost blocks for one child. `name` heads every block a model name is added to. The cost
// popover heads them with the child's name, because it lists several children at once. The
// row's own hover heads them with the words the card's other cost lists use, because the row
// beside the hover already carries the name.
// `noEnding` says the row draws this child in the idle tone, because its turn ended and nothing
// says the child is alive. It changes only the words of the open-child note.
function childCostEntries(
  agent: TurnAgent,
  turnFinished = true,
  name = agent.description,
  runner: AgentKind = 'claude',
  noEnding = false,
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
  // A child whose every billed request is the auto review carries a description named for the
  // review, so the review's own block states the identity alone. A caller that heads the blocks
  // with words of its own, rather than with the child's description, keeps them.
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
        if (compactionNote) {
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

// What a caller with no session liveness to read holds. `agentState` gives `open` for a child
// no live record names, so this is the answer a row draws on a machine where nothing is alive.
const NO_AGENT_LIFE: AgentLive = { session: false, children: new Set<string>() };

// `noEnding` answers, for one child, whether the row draws it in the idle tone because the
// parent turn ended and nothing says the child is alive. The turn's list and that child's own
// row then word the open-child note the same way. `costDetail` exports this list and reads no
// liveness, so the default answers from the turn alone rather than saying no to every child.
// It asks `statusOf`, the one place that decides whether a turn still runs, because a turn
// whose process ended, or whose agent failed, or that the reader interrupted, draws a card
// that says stopped. A default that read `finished` alone called such a turn running and
// worded one child two ways. It asks at the turn's own last record, because this path holds
// no clock and no place in the list, so the quiet window never decides an answer here.
function costDetailList(
  turn: Turn,
  warnings: readonly CacheWriteWarning[] = [],
  noEnding: (agent: TurnAgent) => boolean = (agent) =>
    agentState(agent, statusOf(turn, true, turn.endedAt) === 'running', NO_AGENT_LIFE) === 'open',
  shares: readonly DispatchedShare[] = [],
): StatDetailList {
  const total = cardCostOf(turn, shares);
  const sharedCosts = shares.flatMap((share) => share.costs);
  const totalLabel = formatCost(total.dollars) ?? (shares.length ? ZERO_COST : null);
  const mainParts = (turn.usageParts ?? []).map((part): SessionCostUsage => ({
    agent: turn.agent,
    role: 'main',
    ...part,
  }));
  const finished = turn.finished;
  const mainWarnings = warnings.filter((warning) => warning.scope === 'main');
  // Built where an entry reads it, and nowhere else. A card with a subagent puts it straight
  // into `entries`. A card with none reads only its label, and only when a cache-write warning
  // changes the wording. Each call prices the turn's own usage, so nothing outside those two
  // places calls it.
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
            const childEntries = childCostEntries(agent, finished, agent.description, turn.agent, noEnding(agent));
            if (childEntries[0]) {
              withCostWarnings(
                childEntries[0],
                warnings.filter((warning) => warning.id?.startsWith(`${index}:`)),
              );
            }
            return childEntries;
          }),
          // Each dispatched session the card counts, named as its Dispatched row names it. The
          // value holds only an amount. The category lines describe the whole session, so a share
          // that a print row reduced draws none.
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
  return {
    heading: {
      label: 'Estimated total',
      value: totalLabel ? `${totalLabel}${total.partial ? '+' : ''}` : 'cost unavailable',
    },
    entries,
    footer: [
      ...(compactionNote ? [compactionNote] : []),
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
  ];
}

export interface SessionContextDetail {
  entries: StatDetailEntry[];
  footer?: string[];
}

function inputCostLabel(facts: CacheExpiryFacts): string {
  const priced = cacheExpiryInputCost(facts, publicProjectSpendPrice);
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

export interface CacheExpiryCountFact {
  count: number;
  // Whether `count` is a floor rather than the whole answer, the same way `SessionCostTotal`'s
  // `partial` marks a cost total. True wherever the classifier could not judge every adjacent
  // pair: an unjudged pair may itself have been a qualifying return the count has not added in.
  atLeast: boolean;
}

// The exact total of qualifying returns across every lifetime, and whether that total is a
// floor. Shared by the session heading's chip and the Rail's `cache-expiry:` filter, so the two
// never disagree about the count.
export function cacheExpiryReturnCount(facts: CacheExpiryFacts): CacheExpiryCountFact {
  return {
    count: facts.counts['5m'] + facts.counts['30m'] + facts.counts['1h'],
    atLeast: facts.unavailable > 0,
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
  const detailList: StatDetailList = {
    layout: 'economics',
    heading: { label: 'Cache expiry', value: `${count} affected ${count === 1 ? 'turn' : 'turns'}` },
    entries: [
      { label: 'Cache lifetimes', value: lifetimeParts.join(' · ') },
      { label: 'Input cost on affected requests', value: inputCostLabel(facts) },
      ...(facts.longestGapMs === null
        ? []
        : [{ label: 'Longest qualifying gap', value: formatExpiryGap(facts.longestGapMs) }]),
      ...(facts.excluded > 0 ? [{ label: 'Excluded ambiguous events', value: String(facts.excluded) }] : []),
    ],
    footer: [
      ...(facts.returns.some((item) => item.request.agent === 'codex')
        ? ['The record does not identify every cache-key change.']
        : []),
      ...(facts.returns.some((item) => item.request.reportedCost !== null)
        ? ['One or more affected requests have only a provider-reported total. Their input cost is not available.']
        : []),
    ],
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

export function sessionCompactionContextDetail(facts: readonly CompactionFact[]): SessionContextDetail | null {
  if (!facts.length) {
    return null;
  }
  const latest = facts.reduce((selected, fact) => (fact.ordinal > selected.ordinal ? fact : selected));
  const value = latest.trigger === 'manual' ? 'Manual' : latest.trigger === 'auto' ? 'Automatic' : 'Unknown';
  return { entries: [{ label: 'Latest compaction', value }] };
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
    const entries = [...chip.detailList.entries];
    if (metric === 'turns' && entries.at(-1)?.label === 'About these figures') {
      entries.splice(entries.length - 1, 0, ...addition.entries);
    } else {
      entries.push(...addition.entries);
    }
    const detailList: StatDetailList = {
      ...chip.detailList,
      layout: 'economics',
      entries,
      footer: [...(chip.detailList.footer ?? []), ...(addition.footer ?? [])],
    };
    return { ...chip, detailList, detail: flatDetailList(detailList).join('\n') };
  });
}

// The per-tier breakdown behind the cost, for the hover. Which tier the tokens landed in
// is what makes one turn cost ten times another, but it is detail rather than headline.
export function costDetail(turn: Turn): string[] {
  return flatDetailList(costDetailList(turn));
}

// The heading counts the children whose state is running, plus the live carried ones. An
// `open` child recorded no ending, and the row under the heading says so, so a heading that
// counted it would read against its own row.
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
  // After the turn ends the heading counts the children the agents figure counts. While the
  // turn runs, the figure counts only the carried ones and the heading counts every running
  // row. A card with carried subagents drops `in this turn`, which its own rows and the
  // footer below them say instead.
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
      // A card reaches here with rows of its own, with carried subagents, or with both, so
      // one of the two names above it is always there.
      label: own ?? carriedLine ?? 'Subagents',
      // Every child the count holds is one Arc reads live evidence for, so the count always
      // wears the busy tone.
      ...(running ? { value: `${running} running`, busyValue: true as const } : {}),
    },
    entries: agents.map((agent, index) => ({
      label: agent.description,
      lines: [displays[index].summary].filter(Boolean),
    })),
    // Both counts in one heading wrap beside the running figure in a narrow panel, so the
    // carried subagents take their own line when the card has rows of its own.
    ...(own && carriedLine ? { footer: [carriedLine] } : {}),
  };
}

// How the newest card names its live carried subagents. The card knows how many children the
// rail counts and not which turn launched each one, so the line counts subagents and never
// turns. Two carried subagents can come from one earlier turn or from two. A card with none
// has no line to say, so the caller never words a count of zero.
function carriedAgentsLine(carried: number): string | null {
  return carried > 0 ? `${carried} subagent${carried === 1 ? '' : 's'} started before this turn` : null;
}

// A compaction drawn on the timeline. It changed no files and answered no prompt, so it
// is a marker between turns rather than a card like them.
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

// A compaction is not free: it reads the whole session and writes a summary of it.
// Its header carries the run time, and its chips carry the cost and dropped context.
//
// A Codex record can carry the compaction request's own usage, and that is priced exactly.
// Claude records none, so its figure is an estimate of the usage as well as of the rate.
//
// What a compaction estimate priced, in the words of each basis `compactionEstimate` can give.
// A Claude estimate names each part it priced, because either face can price a part at zero.
function compactionEstimateLines(estimate: CompactionEstimate | null): string[] {
  if (!estimate || estimate.basis === 'read') {
    return ['Estimated as a cache read of the whole context, because the record carries no usage for this compaction.'];
  }
  return [
    claudeCompactionEstimateLine(estimate),
    'Claude Code records no usage for a compaction, so this cost is an estimate.',
  ];
}

function claudeCompactionEstimateLine({ usage, basis }: CompactionEstimate): string {
  const parts = [
    usage.cacheRead ? `${formatTokens(usage.cacheRead)} of cached input reads` : null,
    usage.cacheWrite5m ? `${formatTokens(usage.cacheWrite5m)} of new cache writes` : null,
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

// A compaction draws the same row whether it is open or shut, as every card does.
function compactionChips(c: Compaction): StatChip[] {
  const chips: StatChip[] = [];
  const exactUsage = c.usage;
  const exactCost = exactUsage
    ? (quoteUsage({
        usage: exactUsage,
        model: c.model,
        provider: c.provider ?? null,
        contextWindow: c.contextWindow ?? null,
        requestTokens:
          exactUsage.input +
          exactUsage.cacheRead +
          exactUsage.cacheWrite1h +
          exactUsage.cacheWrite5m +
          (exactUsage.cacheWrite30m ?? 0),
        inferenceClass: c.inferenceClass ?? null,
        serviceTier: c.serviceTier ?? null,
      })?.cost ?? null)
    : null;
  const estimateInput = {
    model: c.model,
    at: c.at,
    durationMs: c.durationMs,
    contextBefore: c.contextBefore,
    contextAfter: c.contextAfter,
    previousRequest: c.previousRequest ?? null,
    firstRequestCacheRead: c.firstRequestCacheRead ?? null,
    summaryChars: c.summaryChars ?? null,
  };
  const estimated = exactUsage ? null : compactionEstimate(estimateInput);
  const cost = formatCost(exactUsage ? exactCost : estimateCompactionCost(estimateInput));
  if (cost) {
    chips.push({
      kind: 'plain',
      metric: 'cost',
      label: cost,
      detail: exactUsage
        ? [
            'Exact request usage priced at the recorded model and provider context.',
            `${formatTokens(exactUsage.input)} uncached, ${formatTokens(exactUsage.cacheRead)} cached, ${formatTokens(exactUsage.output)} output.`,
            ...(exactUsage.cacheWrite30m
              ? [`30-minute cache writes: ${detailedTokens(exactUsage.cacheWrite30m)} tokens.`]
              : []),
            COST_ESTIMATE_NOTE,
          ].join('\n')
        : [
            `${formatTokens(estimated ? requestInputOf(estimated.usage) : c.contextBefore)} of context sent, ${formatTokens(estimated ? estimated.usage.output : c.contextAfter)} summary written.`,
            ...compactionEstimateLines(estimated),
            COST_ESTIMATE_NOTE,
          ].join('\n'),
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
  const why =
    c.trigger === 'auto' ? 'Compacted automatically.' : c.trigger === 'manual' ? 'Compacted by hand.' : 'Compacted.';
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

// How full the window is, as a scale rather than as a colour. A colour reads out as nothing,
// so every band carries a word and the word is the carrier.
export type ContextLevel = 'filling' | 'gettingFull' | 'nearlyFull';

// The four bands the context chip is drawn in, three of them toned, in ascending order. A
// share takes the last band it reaches; a share under the first band takes none and the chip
// is as quiet as every other figure in the row.
//
// Three toned bands and not five, and the bottom one plain. The tone is a 12 to 26% wash on a
// ground the theme controls, and past three the eye cannot separate two neighbours on some
// theme: five bands would ship two tints that differ only to whoever picked them. And a ramp
// starting at zero colours every card, which drowns the other chips beside it
// and drags the `context` mark with it, marking every turn.
//
// The thresholds are measured. Corpus: every `.jsonl` transcript under `~/.claude/projects`
// on this machine, of which 491 sessions carry a context figure, taken as the last recorded
// `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` with the window
// inferred the way `windowFor` answers it. At or above 50%: 116 sessions, 23%. At or above
// 75%: 43, 8%. At or above 90%: 20, 4%. Three quarters of sessions end under 50%, so each
// band is roughly half the one below it, the top band is not dead, and the quiet band still
// covers the bulk.
export const CONTEXT_BANDS: readonly { at: number; level: ContextLevel; word: string }[] = [
  { at: 0.5, level: 'filling', word: 'context filling up' },
  { at: 0.75, level: 'gettingFull', word: 'context getting full' },
  { at: 0.9, level: 'nearlyFull', word: 'context nearly full' },
];

// What a crowded session says the reader could do about it, on the session heading's
// context chip and nowhere else.
//
// It rides the top two bands and never the first: at 50% half a window remains and there is
// nothing to decide. It rides no turn card either, because a mid-history turn at 80% is a
// moment the reader has already gone past, and "this is a place to compact" would be a claim
// about a boundary behind them. A session heading's chip is the newest turn's by
// construction, which is where a boundary can honestly be named.
//
// The levels are taken off the band table rather than written again, so moving a threshold
// moves the sentence with it.
const HANDOFF_SENTENCE = 'This is a place to compact, or to hand the work to a fresh session.';

const HANDOFF_LEVELS: readonly ContextLevel[] = CONTEXT_BANDS.slice(1).map((b) => b.level);

// The word said as a sentence, for the chip's own hover. Worded off the band's own noun
// phrase rather than from a second table, so the heading's name and the chip's hover cannot
// come to say different things about one share.
function bandSentence(word: string): string {
  return `The window is ${word.replace(/^context /, '')}.`;
}

// The band a share sits in, or null below the first one. Exported because the usage strip
// takes this same scale: the panel keeps one vocabulary for getting full, and a second
// threshold table over there would be two answers to one question.
export function bandFor(share: number): { at: number; level: ContextLevel; word: string } | null {
  let found = null;
  for (const band of CONTEXT_BANDS) {
    if (share >= band.at) {
      found = band;
    }
  }
  return found;
}

// The band a printed figure sits in. Every drawn figure takes its tone from this rather
// than from the share behind it, because rounding can carry a share of 0.499 to 50 and a
// chip printing 50 with no tone would sit beside one printing 50 with one. The threshold
// table is still the one below.
export function bandForPercent(percent: number): { at: number; level: ContextLevel; word: string } | null {
  return bandFor(percent / 100);
}

// A share as a whole-number percentage. Rounded to nearest, which is what the CLI's own
// context report says: a window at 49.9% reads as 50 in both places, and a panel that said
// 49 beside it would look like a different measurement rather than a different rounding.
//
// Both ends are held back from rounding. 100 is kept for a window with nothing left in it
// and 0 for one nothing has been put in, so neither absolute is reached by a figure that
// has not actually got there. A share past 1 passes through, which is what the composer's
// figure draws when a session holds more than the window it was measured against; the
// usage strip clamps it to 100 of its own accord, because its figure is also a bar width.
export { wholePercent } from './view/tokens.ts';

// The window the turn ran against. What the source recorded wins over the price table: the
// table holds the figure a model is advertised with, while a turn that recorded one is
// saying what the session was actually given, which is smaller and moves with the plan the
// reader is on. The table answers for a source that records nothing.
type ContextTurn = Pick<Turn, 'contextWindow' | 'model' | 'provider' | 'contextTokens' | 'usage'>;

export function windowFor(turn: ContextTurn): number | null {
  return turn.contextWindow ?? contextWindowFor(turn.model, turn.provider ?? null);
}

// How full that window was when the turn ended, or null where the panel cannot say: no
// count recorded, no window known, or a count larger than the window, which is a stale
// table row or a model swapped mid-session. The chip and the card's mark both read this, so
// neither can call a turn crowded while the other does not.
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

function contextChip(turn: ContextTurn, when = 'Context at the end of the turn'): StatChip | null {
  if (!turn.contextTokens) {
    return null;
  }
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
    ],
    ...(window && share !== null
      ? {
          footer: [
            turn.contextWindow
              ? 'Recorded context window size.'
              : `Window size from the model fallback for ${shortModel(turn.model)}.`,
          ],
        }
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

// The file count and the two line figures as one chip.
//
// One fact, and it was drawn as two pills. A reader deciding whether to open a card reads
// how much moved, and neither figure answers that alone; the two are never drawn apart,
// since both sites build them under one condition; and each pill's hover said most of what
// the other's said, the card's file list twice over and the session heading's caveat twice
// over. One pill is also one thing to announce, which is what `name` carries.
//
// The label leads and the figures follow it, so the pill reads `2 files  +80 −12`.
//
// The line counts as one run of text, by the rule `diffHalves` holds, so a reading a reader
// copies out spells one count the way the drawn pair spells it. A record that moved nothing at
// all reads as nothing, and its caller drops the space in front of it.
function diffValue(added: number, removed: number): string {
  return diffHalves(added, removed)
    .map((half) => half.text)
    .join(' ');
}

// The words one cause sentence conjugates by count. `fileCauseSentence` builds this once and
// every clause below reads whichever of it the sentence needs.
interface FileCauseWords {
  count: number;
  files: string;
  was: string;
  its: string;
  plural: boolean;
}

// What left a row short of its count, one clause per cause, each naming the count and the
// mechanism. A `Record` keyed by `FileCountReason`, so a cause added to that type and missing
// here fails typecheck. The key order is the order the sentences read, so the run reads the
// same way on every card.
//
// Each clause names the mechanism without an instance count, "the shell" rather than "a shell
// command" and "replace_all" rather than "a replacement", because a plural count can come from
// several separate calls that each touched one file.
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

// The word a row's sentence ends in where it kept a count that is a floor. Local to this file:
// nothing draws it on a figure's own face any more, so it is not a name the panel has to reach.
const FILE_COUNTS_PARTIAL = 'partial';

// One cause's sentence for the rows it left short. A row with no count at all ends in what is
// unknown, following the owner's example `1 file was written whole, so its old lines are
// unknown`. A row that kept a count ends in `partial`, the word only the record uses.
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

// What a file list says about the rows whose line counts are short, in the words the turn's
// figure, a child's figure and the session heading's figure all use. Rows group by cause and by
// how they settled, so the reader is told a real fact and not a guess: an Edit and then a Write
// of one file says the file was written whole and its counts are partial. A row built without a
// cause still says how it settled. Every sentence names its files, never "them", so it reads
// true under any sentence the caller puts above it.
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

// The files-and-lines figure never says on its own face, or in its spoken name, that a row's
// line count is a floor. A reader who wants that reads the record the figure opens, where
// `fileCountCaveats` writes one sentence per cause and per way a row's count settled.
function filesAndLines(files: number, added: number, removed: number, detail: string): StatChip {
  const count = `${files} file${files === 1 ? '' : 's'}`;
  // Read out rather than drawn. `2 files` is followed by the figures in words, because a screen
  // reader reaching `+80 -12` says two numbers and some punctuation. A half that moved no line
  // is left out, the way the drawn pair leaves it out. The noun sits on the first figure alone,
  // so a sentence with both halves does not say `lines` twice, and a record that only lost
  // lines still carries the noun rather than reading as `1 file, 3 removed`.
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

// The stat line under the headline: one ordered row, drawn whole whether the response is
// open or shut. Only counts the turn actually produced appear, so a turn that changed
// nothing carries no row of zeros; it says so in one chip instead.
//
// The order is what a list is scanned in. Cost, context, and the files and lines lead,
// because those are what the reader steers by, and `sessionStats` draws the same three in
// the same order on the session heading above, so a card and its heading come to scan
// alike. The token totals, the commits and the subagents follow without being hidden by
// the response disclosure.
//
// Every chip reports a figure the turn produced. None of them asks the reader for
// anything: the row used to end with a `needs you` chip, read out of the rows the summary
// closed with, and it was never acted on. What the summary said it is waiting for is still
// carried, in the marks on the head row's name and hover.
//
// Two decisions inside that order.
//
// The two token figures stay in the tail rather than beside the context chip. The context
// chip carries a level and the window it sits in; the token chip carries a running total
// for the turn. Side by side they invite reading the total against the window, which is
// nonsense, and the two already cross-reference on their hovers.
//
// The files and the lines are one chip. See `filesAndLines`,
// which the session heading builds from as well.
//
// One builder, not two. A second full list for the open state lets one grow a hover or a
// tone the other does not draw, which is the same reason every chip on screen comes out of
// `chipNodes` in `panelhost.ts`. A record chip names its record on `layout` and carries no
// rows of its own, so the file, subagent and commit arrays reach the panel once, on the card,
// and a popover row is built from the same array a body row would be built from.

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
): StatChip[] {
  const chips: StatChip[] = [];
  const shares = dispatched.map((cost) => dispatchedShare(turn, cost));
  const total = cardCostOf(turn, shares);
  // A card that counts a dispatched session shows its cost even when the turn's own usage has
  // no price or no amount, so the session's cost is never hidden.
  const cost = formatCost(total.dollars) ?? (shares.length ? ZERO_COST : null);
  if (cost) {
    const warnings = cacheWriteWarnings(turnCacheWriteScopes(turn, turn.finished));
    const detailList = costDetailList(
      turn,
      warnings,
      (agent) => agentState(agent, status === 'running', sessionLive) === 'open',
      shares,
    );
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
      // The popover draws the card's rows in place of these entries and the heading's lines, so
      // the sentences that say why a row's line counts are short ride the footer, which it draws.
      ...(caveats.length ? { footer: caveats } : {}),
    };
    // The list already carries the footer, so the flat reading drops it with `footer: undefined`
    // before flattening. The footer is the one place the caveat sentences cross the wire.
    const files = filesAndLines(
      changed.length,
      added,
      removed,
      flatDetailList({ ...detailList, footer: undefined }).join('\n'),
    );
    chips.push({
      ...files,
      // The spoken name says how many of them a child changed, the way the commits chip does,
      // because the drawn figure counts the turn's own work and its delegated work as one.
      ...(subagentFileCount ? { name: `${files.name}, ${subagentFileCount} changed by a subagent` } : {}),
      metric: 'files',
      detailList,
    });
  } else if (status !== 'running') {
    // A bare row says nothing at all, so a turn with no file changes says so instead. It
    // does not claim to have changed nothing, because the panel cannot know that: a
    // subagent whose own record Arc could not read carries its edits away with it, a shell
    // write is not an edit tool, and scratch paths are dropped. The hover names all three
    // rather than a flat claim the row beside it can contradict. A running turn says nothing
    // yet, since it has not finished and the answer is still being written.
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
  // No chip counts the tool calls. It only ever showed on an opened card, and an opened
  // card now draws the Activity heading, which says the same number broken down by kind and
  // then lists the calls themselves. One fact, one place.
  //
  // Both raw counts, because the dollar figure hides which half a turn spent itself on.
  // Input dwarfs context and dwarfs output. Every model request processes retained context,
  // so a long turn pays for that context at every request boundary.
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
  // One chip for what the turn did to the repository. A landing is not a commit the turn wrote,
  // so it never joins the commit figure. It is named beside it, and it rides its branch's
  // heading as the merged word, or draws a row of its own when no branch of the record explains it.
  if (commitCards.length || landingCards.length) {
    const counted = commitCards.filter((c) => c.added !== null && c.removed !== null);
    const label = repositoryWorkLabel(commitCards.length, landingCards.length);
    // A record of one branch draws no group heading, so the heading names the branch instead,
    // muted beside the figure. It is a field of its own so the panel can draw it in its tone.
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
  // The subagents figure follows the turn's own figures, so the children read as a group of
  // their own. The cost, files and commits figures before it already count subagent work. The
  // host appends the dispatched figure after this list, which places it beside this one.
  if (turn.agents.length || carried > 0) {
    const displays = turn.agents.map((a) => agentDisplay(a, status === 'running', sessionLive));
    const carriedLine = carriedAgentsLine(carried);
    const detail = [
      ...turn.agents.map((a, index) => [a.description, displays[index].summary].filter(Boolean).join('\n  ')),
      ...(carriedLine ? [carriedLine] : []),
    ].join('\n');
    // A finished turn whose background children still work says how many on the figure, so
    // the card tells the reader the work goes on without opening the popover. It counts the
    // same children the rail counts: open rows whose own transcript wrote inside the quiet
    // window, under the statuses where the rail counts them. An open row with no fresh write
    // is not claimed as running here. The newest card adds its live carried subagents.
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

// The headline: what the turn did, why it failed, or what it is still working on.
//
// `readableSummary` defaults to `readableRichText(turn.summary)`, the full response's own
// translation of the collapsed copy's host-only rich-content references. `toCard` computes
// that translation once and passes it in here and to `headlineHtmlFor`, so a card is never
// built by running the same translation over the same summary twice.
export function headlineFor(
  turn: Pick<Turn, 'summary' | 'error' | 'prompt'>,
  status: TurnStatus,
  readableSummary: string = readableRichText(turn.summary),
): string {
  const headline = headlineOf(readableSummary);
  if (headline) {
    return headline;
  }
  if (turn.error) {
    return turn.error.split('\n')[0];
  }
  // A turn that has not said anything yet leads with what it was asked. It is the one thing
  // about the turn the reader already knows, and it is what the card was already showing a
  // moment earlier, while the press was in flight and no turn had been recorded at all. A
  // card that swapped those words for a stock line and then swapped them again for the
  // answer says three different things in the first few seconds of every prompt.
  if (status === 'running') {
    return turn.prompt.trim() ? firstLine(turn.prompt) : 'Still working.';
  }
  if (status === 'interrupted') {
    return 'Stopped by you before it answered.';
  }
  return 'Ended without a closing message.';
}

// The folded card's headline with its inline Markdown kept, drawn only where it is safe to.
// `headline` already dropped a leading symbol from the fully plain line, so this drops it
// from the Markdown line the same way. Stripping Markdown punctuation, the way `headlineOf`
// does, and rendering Markdown to HTML are two different readings of the same line. The strip
// reads emphasis by the same GFM rule the renderer does, so an underscore inside a word such
// as `calc_total` agrees on both sides. Two cases still disagree: a stray backtick with no
// closing mate stays literal text once rendered but is deleted by the strip, and GFM draws
// `~~x~~` as a struck span while the strip leaves the tildes in place. So the check renders
// first, reads back the HTML's own visible words, and compares those to the plain headline
// instead of comparing two strips. A mismatch falls back to the plain headline, keeping the
// accessible name, the hover and the folded line in agreement.
function headlineHtmlFor(summaryText: string, headline: string): string | undefined {
  const line = withoutLeadingSymbol(headlineMarkdownOf(summaryText));
  if (line === headline) {
    return undefined;
  }
  const html = renderInlineMarkdown(line);
  return visibleTextOf(html) === headline ? html : undefined;
}

// The answers a turn closed other than its response, newest first. The answer the summary came
// from, as `responseAnswerIndex` finds it, is drawn as the response. A reply marked
// `notResponse` can be newer than that answer and still lands here. On a turn whose newest
// text no response has closed yet, every closed answer is earlier than the live text, so all
// of them qualify. The marks,
// the closing rows and the waiting signal keep reading the summary alone: the format's rule
// is that the last answer stands alone and repeats what is still open, so a union would
// mark resolved asks as open.
//
// Newest first so a card reads in the same direction as the list around it. The response is
// the turn's newest text, so it heads the body, and each earlier answer follows it going
// back in time. The whole of that direction is decided here: the panel draws the array in
// the order it is handed and picks nothing.
//
// Reversed, not sorted by the clock. The transcript's own order is the record and it is
// already chronological: over every transcript on this machine, of the turns that closed
// more than one answer, not one holds its answers out of clock order. A sort would be a
// second opinion about a fact the file already carries, and it would order the answers
// differently from `searchableSummary`, which is the corpus a search snippet is cut from.
export function earlierAnswersOf(turn: Pick<Turn, 'answers' | 'summary'>, now: number = Date.now()): AnswerCard[] {
  return earlierAnswers(turn).map((a) => ({ summary: a.text, at: a.at, absolute: formatWhen(a.at, now) }));
}

function earlierAnswers(turn: Pick<Turn, 'answers' | 'summary'>): TurnAnswer[] {
  const response = responseAnswerIndex(turn);
  return turn.answers.filter((_, index) => index !== response).reverse();
}

// Everything the agent said while the turn ran, oldest first, for the section the card draws
// between its response and its activity log.
//
// Two records feed it and both are messages. `updates` of kind `commentary` are the narration
// the agent wrote as it worked. The answers `earlierAnswersOf` selects are the ones it closed
// before its last one. Reasoning stays out: thinking is not a message, and the log already
// carries it.
//
// `earlierAnswersOf` decides which answers are earlier, rather than a second rule here. Its
// index is kept on each entry as `answerIndex`, so a comment anchored to `answer:<index>`
// still names the answer it was left on after the section replaced the blocks it was written
// against.
//
// Ordered by the clock, and the recorded order breaks a tie. Neither source list is in clock
// order to begin with: `turnview.test.ts` holds that an answer stamp may go backwards, and an
// update stamp promises nothing either. So the two are sorted together rather than merged, or
// a narration recorded out of order drags the answer beside it out of order too.
//
// The sort is this display list's alone. `earlierAnswersOf` keeps the transcript's own order
// because that order is the record, and `searchableSummary` reads it. Sorting both would make
// them agree and would change what a search snippet is cut from.
//
// Stable, over the narrations followed by the answers, so each entry keeps its place among its
// own kind. Where a narration and an answer carry the same stamp the narration goes first,
// because an answer closes the stretch of narration that led to it.
//
// Each entry is given its identity after the sort, out of its kind, its stamp and its ordinal
// among the entries sharing both. That is what the section keys its per-message state by, so
// a message arriving mid-turn must not move anybody else's. Numbered before the sort, a
// narration recorded late would take the id an earlier one already holds. The reader would
// then watch a message they opened whole snap shut.
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
  // Back into the transcript's own order, with the newest-first index each answer keeps on
  // the card carried along with it. The index is the comment anchor, so it stays what
  // `earlierAnswersOf` numbered it and never follows where the section draws the entry.
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
    // A record whose timestamp would not parse arrives stamped zero, and the epoch is a real
    // moment both formatters will happily draw. A message the record gave no time carries
    // none, and the section then draws a reply as its word alone.
    return {
      ...entry,
      id: `${stamp}:${n}`,
      when: entry.at ? formatClock(entry.at) : '',
      absolute: entry.at ? formatWhen(entry.at, now) : '',
    };
  });
}

// What the section's head says, and what it is announced by.
//
// The name carries everything the row shows, so a reader who never opens the section learns
// how much was said either way. The mix is the same counts without the title, because the
// title is drawn beside it as its own word.
//
// The reply clause is dropped where there are none: a count of zero announced over a row
// that plainly holds messages is the control contradicting its own contents, which is the
// rule the activity name already follows. It counts replies rather than answers, so the head
// names the same thing the word on a message names.
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
// Retained so a replies-only Said section can be restored.
export function saidName(messages: readonly SaidCard[]): string {
  return [CARD_ACTIONS.saidSection, ...saidCounts(messages)].join(', ');
}
export function saidMix(messages: readonly SaidCard[]): string {
  return saidCounts(messages).join(', ');
}

// The word in front of a turn's duration, which the turn's status decides.
//
// The figure itself means two things. On a finished turn it is how long the turn took and
// it never moves again. On a running turn it is how long the turn has taken so far, and
// the panel's ticker grows it once a second, so a past tense in front of it contradicts
// the figure beside it and the glyph above it. Every other status is a turn that ended,
// however it ended, so all of them take the past tense.
//
// Written here and carried on the card, because the panel draws it and the panel has no
// tests. The head row's spoken name reads the same value, so the drawn word and the
// spoken one cannot disagree.
export function durationWord(status: TurnStatus): string {
  return status === 'running' ? CARD_ACTIONS.runningFor : CARD_ACTIONS.ranFor;
}

// `folders` are the open workspace folders, which decide whether a file row is drawn by
// its basename or by its whole path. The default is the empty list, which draws every row
// the way it was drawn before there was anything to be outside of.
// What each tool is said to have done, finished and in flight.
//
// The panel's own words, because a reader is not reading an API. Both agents are in one
// table: a tool either agent runs under a name this holds is said the same way whichever
// ran it, and a name the table does not hold is drawn as the agent wrote it, which is more
// use than a verb invented for it.
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

// A protocol activity gains its arrival time when the timeline receives it. The protocols
// do not timestamp these events, but the card needs a time to place them among recorded
// prompts and calls.
export interface TimedWireActivity extends WireActivity {
  at: number;
}

function activityCountOf(turn: Pick<Turn, 'stepCount' | 'steps'>): number {
  return Math.max(turn.stepCount, ...turn.steps.map((step) => step.ordinal));
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

// Add activity received directly from a running child to the newest recorded turn. The
// recorded copy wins as soon as the transcript catches up, keyed by the protocol's stable
// source id. The clone keeps these temporary rows out of transcript-derived counts.
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
    // Collaboration events already carry the useful human sentence. Making that sentence
    // the row label avoids presenting a protocol method name as the important part.
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
    // A live skill load counts the way a recorded one does. Left as an unknown call, the
    // counts would move a load out of `other` the moment the transcript caught up.
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

// The steps whose detail is language rather than a literal. A brief for a subagent and a
// web query are sentences somebody wrote, and a skill is named inside one. Set in the code
// face they would read as something the reader could run.
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
  // A verb with nothing after it loses its colon. Codex reads no detail off a subagent it
  // started, and none off an exec call no completed-command record names, so the row that
  // says only what was done is common there, and a colon with nothing behind it reads as a
  // fault.
  if (!step.detail) {
    return verb.endsWith(':') ? verb.slice(0, -1) : verb;
  }
  return STEP_PROSE.has(step.name) ? `${verb} ${step.detail}` : verb;
}

// What the step handed its tool, or nothing where the row is all words. A command, a path
// and a pattern are read character by character, and the prose face runs the characters
// together, so this half is drawn in the editor's face and the words around it are not.
export function stepCode(step: TurnStep): string {
  return step.detail && !STEP_PROSE.has(step.name) ? step.detail : '';
}

// The word a row ends on. The glyph in front of a failed row is the only thing on it the
// words do not already say, so the words say it too: colour and shape are never the only
// place a fact is.
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

// The prompt the panel has sent into this turn and the transcript does not hold yet, or
// nothing, which is the usual answer.
//
// Claude Code writes a queued prompt to the file when the agent picks it up, not when the
// reader presses: measured out of order in a real transcript, carrying the press time and
// appended 76 seconds later. Between those two moments the card is the only place the prompt
// could be, and a card that showed the answer while showing neither the question nor that one
// had been asked is the fault the reader reported.
//
// It goes on the turn that is running and started before the press. Once the transcript
// carries the same words the recorded one stands alone: the two are the same prompt, and the
// panel's own memory of it is the copy that goes.
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

// What the reader typed mid-turn, said as a row of the log. One line, and a pointer rather
// than the text: the whole of it is drawn under "You asked", and a card that printed the
// same words twice at full length would read as two different prompts.
export function askLine(ask: TurnAsk): string {
  return `You asked: ${shortenTo(firstLine(ask.text), STEP_DETAIL_LIMIT, STEP_CUT)}`;
}

// The rows a card draws under Activity: what the turn did and what it was asked while it
// did it, in the order the two happened. Merged here rather than in the parse, because the
// step list is what the count and the mix are taken from and a prompt is neither.
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
    // Only the one in flight counts up. A figure growing beside a call that came back
    // would read as work still being done, and so would one beside a call the turn was cut
    // off in the middle of: no call is in flight in a turn that is no longer running.
    since: running && step.status === 'running' ? step.at : null,
    title: step.fullDetail ?? (stepCode(step) ? step.detail : ''),
    ...(step.fullDetail || stepCode(step) ? { name: activityStepName(step) } : {}),
  });
  const askRow = (ask: TurnAsk): ActivityRow => ({
    kind: 'ask',
    // A prompt is something that happened rather than a call with an end, so it wears the
    // settled status and never a clock.
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
    // Narration is prose. Keep it out of the code face. The row wraps where a step row
    // does not, so the bound is on the payload alone and it is wider than a tool row needs.
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
  const appendRun = (end: number) => {
    if (end <= before) {
      return;
    }
    const first = before + 1;
    const kept = turn.steps.filter((step) => step.ordinal >= first && step.ordinal <= end);
    const count = end - before;
    before = end;
    if (count === 1 && kept.length === 1) {
      rows.push(stepRow(kept[0]));
      return;
    }
    const earlier = count - kept.length;
    const failed = new Set([
      ...turn.failedOrdinals,
      ...kept.filter((step) => step.status === 'failed').map((step) => step.ordinal),
    ]);
    const failedCount = [...failed].filter((ordinal) => ordinal >= first && ordinal <= end).length;
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

// What the disclosure that opens the Activity section is announced by. The count and the
// mix are on the control itself, so a reader who never opens it still learns both.
function activityName(count: number, asks: number, counts: readonly string[], tools: string): string {
  const parts: string[] = ['Activity', ...counts];
  // Said only when there are calls to count. A turn asked something while it was writing
  // prose has run no tool, and "0 steps" announced over a row that is plainly there is the
  // control contradicting its own contents.
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

// The line a folded running card draws under its headline: what the agent is doing now.
//
// The newest step, and only while it is still running. A finished step on a card that is
// still running says the agent is on something the panel cannot see, which is exactly the
// silence the card is here to fill; the head row's own figure carries the waiting instead.
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
): TurnCard {
  const live: AgentLive = { session: sessionLive, children: liveChildren };
  let added = 0;
  let removed = 0;
  // The turn's own changed files and every child's, as one list. Everything the card says about
  // files reads this: the rows, the figure over them, and the record a subagent figure opens.
  const changed = attributedFiles(turn);
  // A row is unknown only where no record of it counted a line, because `attributedFiles`
  // settles every row and leaves a counted one partial instead. The total holds every line the
  // turn measured, and only the record the figure opens says it is a floor. The exclusion stays
  // explicit so the total can never absorb a stray figure from a row that claims no count.
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
  const headline = withoutLeadingSymbol(headlineFor(turn, status, readableSummary));
  const headlineHtml = headlineHtmlFor(readableSummary, headline);
  const rows = closingRows(turn.summary);
  // The step the agent is on, named once: the folded card draws its words, its literal and
  // its clock, and three lookups of the same step is three chances for them to disagree.
  //
  // Only while the turn is running. A call is left recorded as running by a turn that was cut
  // off before the call came back, and a card saying it was left unfinished while naming a
  // command it is still on says two things about one turn.
  const onNow = status === 'running' ? doingOf(turn) : null;
  const narration = status === 'running' && !onNow ? latestCommentaryOf(turn) : null;
  // What the panel has sent into this turn and not seen come back, drawn beside the ones the
  // transcript does hold. Empty on all but the one running turn the reader just typed into.
  const pending = pendingAskOf(turn, press, status === 'running');
  const asked = pending ? [...turn.laterPrompts, pending] : turn.laterPrompts;
  const waiting = waitingFrom(rows);
  // Named once, because the section's list, its spoken name and the counts on its shut head
  // are three readings of one answer.
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
  const rowPaths = fileRowPathsByKey(fileCards);
  const agentCards = turn.agents.map((agent) =>
    agentCard(agent, status === 'running', live, launches, rowPaths, now, turn.agent),
  );
  const commitCards = attributedCommits(turn).map(({ commit, madeBy, madeBySession }) =>
    commitCard(commit, now, madeBy, madeBySession, folders),
  );
  const landingCards = (turn.landings ?? []).map((landing) => landingCard(landing, folders, now));
  const subagentCommitCount = commitCards.filter((commit) => Boolean(commit.madeBy)).length;
  const subagentFileCount = changed.filter((file) => Boolean(file.madeBy)).length;
  // A carried subagent stays open across typed prompts. The newest card counts every live child
  // the rail counts, under the statuses where the rail counts them. A live child that no own
  // row draws as running is carried, so the figure is the rail's live set whatever the rows say.
  const carried =
    isLatest && childrenOutliveTurn(status)
      ? [...liveChildren].filter((id) => !turn.agents.some((agent) => agent.id === id)).length
      : 0;
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
    // The marks are said in words here. Nothing on the card draws them as characters, so
    // this name and the head row's hover are the whole of what carries them, and both say
    // them as words rather than as the Unicode name of a pictograph.
    // The same words the head row draws, followed by chip detail that otherwise exists only
    // on a pointer hover. The head already owns the list's roving tab stop.
    label: [label, ...headDetails].join('\n'),
    live: status === 'running',
    activity: log.rows,
    activityCount,
    // Said here rather than in the panel, with the count and the mix folded in, because
    // every other word on the card is decided in this file and a heading spelt in the
    // webview is one nothing can check.
    activityWord: 'Activity',
    activityName: activityName(activityCount, asked.length, log.counts, activityTools),
    activityCounts: log.counts,
    activityTools,
    activityToolCategories,
    activitySkills,
    // The turn's own total, not the number of rows: a load the turn's bound dropped still
    // happened, and a skill loaded twice is one row.
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
    // `name` is what the row draws and `label` is what it is announced by. A row's counts
    // read aloud as punctuation, and whether the file is new is the one thing on it that
    // changes what opening it will show, so the label says that and drops those.
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
        // A skill load keeps its own category. Given `other` here it would be listed again in
        // the breakdown of the calls the panel did not recognize.
        category:
          name === 'Skill'
            ? SKILL_STEP_KIND
            : ((turn.agent === 'claude' ? CLAUDE_TOOL_KIND : CODEX_TOOL_KIND)[name] ?? 'other'),
      }))
      .sort(mostCalledFirst),
    agents: agentCards,
    // Landings use the commit-row shape but do not enter the commit total above.
    // A landing rides the commit list rather than a list of its own. It is the same row with
    // the same fields, and the reader reads what the turn did to the repository in one place
    // and in the order it happened.
    commits: [...commitCards, ...landingCards].sort((a, b) => a.at - b.at),
    errorText: turn.error,
  };
}

// The clock-worded fields are left out of the comparison below. They move on every render
// while anything runs, the ticker already rewrites their wording in place from data-at
// and data-since, and their attributes are refreshed in place by the update
// path, so a card that changed in no other way is not touched at all.
export const CARD_TIME_FIELDS: readonly string[] = [
  'relative',
  'absolute',
  'duration',
  'durationDetail',
  'lastRelative',
  'lastAbsolute',
  'label',
];

// Every field the card's DOM draws. A change in any of these rebuilds that one card in
// place, which is the one case a text selection inside it does not survive. Every field
// a card carries is in exactly one of these two lists; turnview.test.ts holds real cards
// against them, so a field added to a card forces the decision here. repositoryWorkLabel
// rides the same re-export so the commits chip's own label, built from this module's
// commitCards and landingCards, stays a public export of the root turn module too.
export { CARD_CONTENT_FIELDS, cardPrint, repositoryWorkLabel } from './view/card-presentation';

// What a whole session came to, worked out over the turns the panel read.
//
// Three different totals could each be called a session's cost and they are not the same
// number. Over the cards on screen, which follows the filters, so a reader who ticks "only
// turns that changed files" would watch the cost drop, which is a lie about the session.
// Over the session's whole life, which needs the whole transcript, the one thing the tail
// window exists to avoid reading. Or over the turns the panel read, which moves only when
// the reader reads further back, and which is what these are.
//
// The timeline heading's turns chip gets its whole-session count from the lifetime
// projection, the same way its cost chip does. Until that answer is ready the row carries no
// turns chip at all, the way it carries no cost chip either. The hover on every figure says
// its scope because figures beside one another can cover different windows without looking
// different.
//
// A level, not a sum, for context: adding two levels says nothing, because the later one
// already holds the earlier session. The newest turn supplies it unless a later
// compaction recorded what remained after the boundary.
//
// The chip also shows what the newest turn paid to re-read the session when that figure exists.
// See `contextDetailFacts`.
//
// `compactions` are the ones inside the read window. They establish the current context level.
// Indexed lifetime facts supply the latest compaction trigger after this projection is built.
//
// Required rather than optional, for the reason `statsBySession` states one level up: an
// optional list would default to empty at a caller that has one, and the context level would
// ignore a later compaction with no test able to see it.
//
// Where the session stands and what to do about it are one chip, not two: the context
// chip's hover carries `HANDOFF_SENTENCE` once the share is in the top two bands.
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
  tokens: number;
  outputTokens: number;
  window: number | null;
  model: string | null;
  provider: string | null;
  // The lifetime that request bought, or null where it named none.
  tier: CacheTier | null;
  // When the request that set the context level was recorded. The provider starts the lifetime
  // again on every request that uses the cache, so this is the clock the lifetime is measured
  // against, and never the moment the cache was first written.
  lastRequestAt: number;
  // What that request was billed under, so the floor is quoted at the rate it ran at.
  inferenceClass: UsageInferenceClass;
  serviceTier: string | null;
  // Whether that request read anything back from the cache. A cache that has only just been
  // written reads back nothing and is warm all the same, which is what the first turn of a
  // session looks like, so anything explaining the figure has to be able to say so.
  readBack: boolean;
  // Whether a compaction newer than the last request replaced the session. Nothing has
  // cached the replacement, so the next request writes it again. That is a recorded fact and
  // not a gap in the record, which is why it rides here rather than being inferred from an
  // absent lifetime.
  afterCompaction: boolean;
}

// Everything the next turn's floor price is worked out from.
//
// The context level, the lifetime and the clock all come from the one request that set the
// level, which is what `contextRequest` records. The turn's own end moves with a tool result
// and its usage is the sum over every request it made, so a figure taken from either would be
// dated or priced by a wider scope than the one it describes.
//
// A compaction that is newer records no cache write and no cache read for the history it
// wrote, so it establishes no lifetime for the replacement context. Nothing has cached what is
// there now, so the next request writes it again: `afterCompaction` says so, and the panel
// names the written price rather than a range.
//
// Newer than what is the whole question, and the cache answers it from the request rather than
// from the turn. A tool result and a synthetic response both move a turn's end without any
// model running, so a compaction can be newer than every request the turn made and older than
// the turn itself. Dated from the turn's end there, the panel carries the lifetime the request
// before the compaction bought and calls a session nobody has cached warm.
//
// It reads no transcript byte the panel was not already holding. The composer receives the
// request through the parsed turn, while the derived cache retains a copy for the rail.
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
  // The last model request measured its input and answer, but not a tool result that arrived
  // after it. A successfully closed turn guarantees that no such result is still waiting for
  // another request. A newer compaction is also complete because it records the replacement level.
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

// A failed turn can be the newest card without carrying a model request. The Composer skips
// only that empty failure. Any runtime evidence keeps its turn as the boundary, including the
// intentional lack of a forward price while work is unfinished or failed.
export function composerRuntimeBySession(
  turns: readonly Turn[],
  newestCompactions: ReadonlyMap<string, Compaction>,
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
      confirmedModel: newest?.model ?? null,
      confirmedModelAttachment: newest?.modelAttachment ?? null,
      confirmedEffort: newest?.effort ?? null,
      context: currentContextOf(newest, compaction),
      nextTurn: nextTurnBasisOf(newest, compaction),
    });
  }
  return result;
}

// Prices each recorded request group at the rate and tier it ran under, the way `turnCost`
// prices a parsed turn, so the rail's figure matches the card's.
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
    // The summed estimate and whether it is a floor, carried beside the wording rather than
    // thrown away with it. The `+` above and this flag are the same fact said twice, once for
    // the eye and once for a caller that adds several sessions together.
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
  usageOrigin?: 'claude-cost-state';
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
        // A compaction estimate is not recorded usage, so no warning rests on it.
        if (part.compactionEstimate || part.usageOrigin === 'claude-cost-state') {
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

// `short` marks the figure a lower bound for work that has no usage in `costs` yet. With no
// priced dollars, the line reports unavailable cost.
function sessionCostValue(costs: readonly PricedSessionCost[], short = false): string {
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

function delegatedCacheRateDetail(
  usage: Turn['usage'],
  allCosts: readonly PricedSessionCost[],
): { cacheHit?: CacheHitDetail } {
  const costs = recordedCosts(allCosts);
  const exactRequests = costs.every(
    (cost) => cost.part.requestCountExact !== false && cost.part.usage.requests !== undefined,
  );
  const detail = cacheRateDetail(usage, null, exactRequests);
  if (!detail.cacheHit || detail.cacheHit.percent >= 80) {
    return detail;
  }
  // A model subtotal can contain many cheap children. Only an identified child can meet the gate.
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
      usage: Turn['usage'];
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
      usage: emptyUsage(),
      complete: true,
      costs: [],
    };
    if (cost.dollars !== null) {
      held.dollars += cost.dollars;
      held.priced = true;
    }
    held.costs.push(cost);
    if (!cost.part.compactionEstimate) {
      addUsage(held.usage, cost.part.usage);
    }
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
        ...(identity.complete && !short ? delegatedCacheRateDetail(identity.usage, identity.costs) : {}),
      };
    });
}

// The costs priced from recorded usage, without compaction estimates.
function recordedCosts(costs: readonly PricedSessionCost[]): PricedSessionCost[] {
  return costs.filter((cost) => !cost.part.compactionEstimate && cost.part.usageOrigin !== 'claude-cost-state');
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

// `short` says that some delegated work has no usage in `parts` yet, such as a dispatched
// session whose record is still being written. The total is then a lower bound, marked the
// same way as usage that could not be priced. The popover then always draws the line that holds
// that work, marked the same way, even with no delegated usage yet: Delegated work, which sums
// every delegated scope, or Other delegated work in a layout that draws a line per scope or
// per model. Those other lines carry no mark, because none of them holds that work.
function otherDelegatedEntry(costs: readonly PricedSessionCost[], short: boolean): StatDetailEntry {
  return { label: 'Other delegated work', value: sessionCostValue(costs, short), lines: delegatedCostLines(costs) };
}

export function sessionCostProjection(
  parts: readonly SessionCostUsage[],
  coverage: boolean | SessionSpendCoverage = false,
): SessionCostProjection {
  const mainShort = typeof coverage === 'boolean' ? false : coverage.main;
  const short = typeof coverage === 'boolean' ? coverage : coverage.delegated;
  const scopeShort = (id: string) => typeof coverage !== 'boolean' && coverage.delegatedScopeIds.has(id);
  const delegatedShort = (held: readonly PricedSessionCost[]) =>
    held.some((cost) => cost.part.scopeId !== undefined && scopeShort(cost.part.scopeId));
  const incomplete = mainShort || short;
  const costs = parts.map(priceSessionCost);
  const totals: readonly SessionCostTotal[] = incomplete ? [...costs, { dollars: null, partial: true }] : costs;
  const total = sessionCostTotalOf(totals);
  const unavailable = unavailableUsage(costs);
  const scope = 'Includes the main session and delegated work.';
  const chip = costStat(totals, scope, () => [...unavailableUsageLines(unavailable), UNAVAILABLE_COST_NOTE].join('\n'));
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
                  value: sessionCostValue(main, mainShort),
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
                    value: sessionCostValue(main, mainShort),
                    lines: usageCategoryLines(main, true, mainShort),
                  },
                ]
              : []),
            ...(delegated.length || short
              ? [
                  {
                    label: 'Delegated work',
                    value: sessionCostValue(delegated, short),
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
  const compactionNote = compactionEstimateNote(costs);
  const detailList: StatDetailList = {
    heading: {
      label: 'Estimated total',
      value: chip.compactLabel,
    },
    entries,
    footer: [
      ...(compactionNote ? [compactionNote] : []),
      ...(mainShort ? ['Main agent usage is incomplete.'] : []),
      ...(short ? ['Delegated work usage is incomplete.'] : []),
      ...(unavailable.size > 0 || incomplete ? [UNAVAILABLE_COST_NOTE] : []),
      ...(costs.some((cost) => cost.categories.some((category) => category.key === 'cacheRead' && category.dollars > 0))
        ? [CACHED_INPUT_READ_EXPLANATION]
        : []),
      ...(costs.some((cost) => cost.part.model === 'codex-auto-review' && cost.publiclyPriced)
        ? [AUTO_REVIEW_RATE_NOTE]
        : []),
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
  const entries: StatDetailEntry[] = [{ label: `${label} in the main session` }];
  const notes = ['The turn count excludes delegated work.'];
  const first = stats?.firstTurnAt;
  const last = stats?.lastTurnAt;
  if (typeof first === 'number' && typeof last === 'number') {
    entries.push({ label: `${formatDuration(Math.max(0, last - first))} between the first and last turns` });
    notes.push('Elapsed time includes gaps between turns.');
  }
  const compactions = stats?.compactionCount;
  if (typeof compactions === 'number') {
    entries.push({
      label:
        compactions === 0
          ? 'No compactions recorded'
          : compactions === 1
            ? 'Context compacted once'
            : `Context compacted ${compactions} times`,
    });
  }
  entries.push({ label: 'About these figures', separateBefore: true, lines: notes });
  const detailList = { entries };
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
  // Keep only compactions in the current context window, which starts with the oldest selected turn.
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
  const ctx = current
    ? contextChip(
        contextTurn,
        current.afterCompaction ? 'Context after the latest compaction' : 'Latest recorded context',
      )
    : null;
  if (ctx && current) {
    const share = contextShare(contextTurn);
    const detailList = ctx.detailList!;
    const contextEntry = detailList.entries[detailList.entries.length - 1];
    contextEntry.lines = [
      ...(contextEntry.lines ?? []),
      'Context measures the current level, not cumulative token usage.',
      ...(ctx.level && HANDOFF_LEVELS.includes(ctx.level) ? [HANDOFF_SENTENCE] : []),
    ];
    const facts = contextDetailFacts(newest, !current.afterCompaction);
    if (facts.entries.length) {
      facts.entries[0].separateBefore = true;
    }
    detailList.entries.push(...facts.entries);
    const notes = [...(facts.footer ?? []), ...(detailList.footer ?? [])];
    detailList.footer = notes.length ? [notes.join(' ')] : [];
    chips.push({
      ...ctx,
      metric: 'context',
      compactLabel: share === null ? ctx.label : `${wholePercent(share)}% ctx`,
      detail: flatDetailList(detailList).join('\n'),
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
  // One entry per distinct path this session's turns touched, folding every turn's own record
  // of that path into one row and settling it with `settleCounts`, the rule the turn's own
  // figure settles its rows by. A path one turn named without hunks and a later turn edited
  // with real counts settles to partial, not unknown, because the later turn's lines reached it.
  // The line totals add the settled rows, so a row's counted lines reach the totals whenever
  // they reach its row, the same way the turn's figure adds them.
  //
  // Through `normalizeFsPath`, which is the repo's one path rule, and not a bare lower-casing.
  // The two readers record a path in different shapes, backslashes against forward slashes, so
  // the same file reached from both would otherwise count twice; and lower-casing everywhere
  // folds `Foo.ts` into `foo.ts` on the filesystems where those really are two files.
  const byPath = new Map<string, ChildFileChange>();
  for (const t of turns) {
    for (const f of t.files) {
      const key = normalizeFsPath(f.path);
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
        {
          label: 'About these figures',
          separateBefore: true,
          lines: [
            'Each file counts once, even when several turns change it.',
            'Line totals add recorded edits across those turns, rather than a final net diff.',
            ...caveats,
          ],
        },
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
  const footer: string[] = [];
  if (includeReread) {
    const reread = formatCost(cacheReadCostOf(newest));
    if (reread) {
      entries.push({ label: 'Latest turn cached input reads', value: reread });
      footer.push(COST_ESTIMATE_NOTE);
    }
  }
  return { entries, footer };
}

// What a turn paid to read its cache back. Each recorded request group is priced at the rate
// and tier it ran under, so a fast turn's reads cost the fast read rate.
function cacheReadCostOf(turn: SessionFigureTurn): number | null {
  if (!turn.usageParts?.length) {
    return estimateCacheReadCost(turn.usage, turn.model, turn.provider ?? null, turn.contextWindow);
  }
  let dollars = 0;
  for (const part of turn.usageParts) {
    if (part.usage.cacheRead <= 0) {
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

// Whether a turn spent anything at all. A turn with no usage recorded is a prompt that never
// reached a model, and it is not a hole in a session's total.
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

// How much of a headline a tab title carries before it pushes everything after it off the
// end of the tab.
export const TITLE_HEADLINE_LIMIT = 60;

// The tab title for a turn's own diff. It names only the files whose two sides are not an
// exact whole-file record of what the turn did, so nothing on screen claims more than it
// can support: a file whose snapshot is still the one the session started from is drawn
// against that, so the diff can hold edits from earlier turns as well as this one, and a
// file with no recorded text is drawn as its changed regions alone. A turn whose files are
// all exact says nothing extra.
//
// Said as what the reader will see rather than by naming the store behind it. The words are
// for somebody reading a tab title, and a baseline is a thing only this code knows about.
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
