import { validClaudeTaskCompletions } from './transcript';
import * as fs from 'node:fs';
import { boundedCommitRepositories, type VerifiedCommitRepository } from './commitrepositories';
import { writeFileAtomically } from './atomicfile';
import { storedCodexMetas } from './codexopenings';
import { compatibleDiscovery, validDiscoveryCheckpoint } from './progressiveworker';
import {
  replacedTranscript,
  resolveSessionName,
  storedSessionName,
  type SessionName,
  type SessionNameSource,
} from './sessionnames';
import { codexSessionsRoot, type CodexSessionMeta } from './codex';
import {
  agentRunOfScan,
  isCacheLifetime,
  MAX_CLAUDE_CHILD_REFERENCES_PER_FILE,
  normalizeFsPath,
  sameSessionRevision,
  fileIdentityValue,
  isInside,
  projectsRoot,
  validRelationshipEvidence,
  sessionOutcomeOf,
  sessionStatFactsOf,
  type AgentKind,
  type SavedClaudeOpening,
  type AgentRunScan,
  type ClaudeChildSessionFile,
  type ClaudeChildSessionReference,
  type FileRevision,
  type HumanPromptScan,
  type SessionFile,
  type SessionRead,
  type SessionStatFacts,
  type BackgroundCommand,
  type TurnOutcome,
  type TurnStarts,
  type TurnUsage,
  type UsageCounts,
} from './transcript';

export interface DerivedTitleEntry {
  // Head-window evidence releases a command's provisional fallback name.
  withdrawnPrompt?: boolean;
  mtimeMs: number;
  size: number;
  label: string;
  fullLabel: string;
  activityMs: number | null;
  agentRun: boolean | null;
  outcome: TurnOutcome | null;
  // Background commands found by a tail read without a typed prompt.
  // `outcome` can still hold the lifetime outcome of that turn.
  backgroundCommands?: BackgroundCommand[];
  stats: SessionStatFacts | null;
  // Displays earlier facts while current stats lack positive context usage.
  heldStats?: SessionStatFacts;
  // The transcript revision whose read found `heldStats`.
  heldRevision?: Pick<FileRevision, 'mtimeMs' | 'size'>;
  expandedStatsRead?: boolean;
  metadataWindow?: { whole: boolean; windowBytes: number; exhausted?: boolean; exhaustedRule?: number };
  sourceIdentity?: Pick<FileRevision, 'dev' | 'ino'>;
  starts?: TurnStarts;
  foldedLabel?: string;
  agentRunScan?: AgentRunScan;
  // Claude name source. A lower-ranked source cannot replace a held name.
  nameSource?: SessionNameSource;
  // Claude name record offset. The later record wins within one rank.
  nameAt?: number;
  // First-record fingerprint used to detect transcript replacement.
  headKey?: string;
}

// Claude metadata tail budget. Agent-run classification needs the file start.
// Session list enrichment scans larger top-level sessions. Child transcripts need no scan.
export const CLAUDE_METADATA_TAIL_BYTES = 256 * 1024;

// Requests whole-file agent-run classification for large top-level Claude sessions.
// The parent Agent call identifies a child transcript as an agent run without another scan.
export function needsAgentRunScan(session: { agent: string; size: number; childTranscript?: boolean }): boolean {
  return session.agent === 'claude' && session.size > CLAUDE_METADATA_TAIL_BYTES && session.childTranscript !== true;
}

// Returns unread agent-run bytes. A person classification needs no further reads.
// Shrinkage restarts the scan at byte zero.
export function agentRunScanUnread(
  session: { agent: string; size: number; childTranscript?: boolean },
  scan: AgentRunScan | undefined,
): number {
  if (!needsAgentRunScan(session) || scan?.person) {
    return 0;
  }
  return session.size - (scan && scan.bytes <= session.size ? scan.bytes : 0);
}

// Carries the scan cursor into a changed revision.
// Only growth without detected replacement preserves an agent-run answer.
// The scan determines that answer when present. A person classification never carries a run answer.
// Without a scan, a Claude session crossing the tail budget retains its prior run classification.
// A session that needs no scan receives the new metadata entry without a carried cursor.
export function carryAgentRunScan(
  previous: DerivedTitleEntry | undefined,
  next: DerivedTitleEntry,
  session?: { agent: string; size: number; childTranscript?: boolean },
): DerivedTitleEntry {
  if (session && !needsAgentRunScan(session)) {
    return next;
  }
  if (!previous) {
    return next;
  }
  const grew = next.size >= previous.size && !replacedTranscript(previous, next);
  if (previous.agentRunScan) {
    const scan = previous.agentRunScan;
    const keepsRun = grew && !scan.person && agentRunOfScan(scan, scan.end ?? scan.bytes);
    return { ...next, agentRunScan: scan, ...(keepsRun ? { agentRun: true } : {}) };
  }
  const crossedWindow = session?.agent === 'claude' && next.size > CLAUDE_METADATA_TAIL_BYTES;
  return grew && crossedWindow && previous.agentRun ? { ...next, agentRun: true } : next;
}

// Reports whether the newest stat turn has positive context usage.
// A tail without a prompt supplies no stats. A new turn has no usage before its first response.
export function statsHaveContext(stats: SessionStatFacts | null): boolean {
  const newest = newestStatTurn(stats);
  if (!newest) {
    return false;
  }
  return typeof newest.contextTokens === 'number' && newest.contextTokens > 0;
}

function newestStatTurn(stats: SessionStatFacts | null) {
  if (!stats?.turns.length) {
    return null;
  }
  return stats.turns.reduce((latest, turn) => (turn.startedAt > latest.startedAt ? turn : latest));
}

function released(entry: DerivedTitleEntry): DerivedTitleEntry {
  if (entry.heldStats === undefined && entry.heldRevision === undefined) {
    return entry;
  }
  const out = { ...entry };
  delete out.heldStats;
  delete out.heldRevision;
  return out;
}

// Carries context facts across incomplete reads to keep the session list figures visible.
// `stats` stays unchanged so missing facts still request recovery.
// Current context, a complete negative read, shrinkage, or detected replacement releases held facts.
export function carryDerivedTitleFacts(
  previous: DerivedTitleEntry | undefined,
  next: DerivedTitleEntry,
  session?: { agent: string; size: number; childTranscript?: boolean },
): DerivedTitleEntry {
  const carried = carryAgentRunScan(previous, carrySessionName(previous, next), session);
  if (statsHaveContext(next.stats)) {
    return released(carried);
  }
  if (next.stats === null && next.expandedStatsRead === true) {
    return released(carried);
  }
  if (!previous || next.size < previous.size || replacedMetadataSource(previous, next)) {
    return released(carried);
  }
  if (previous.stats && statsHaveContext(previous.stats)) {
    return {
      ...carried,
      heldStats: previous.stats,
      heldRevision: { mtimeMs: previous.mtimeMs, size: previous.size },
    };
  }
  if (!previous.heldStats) {
    return released(carried);
  }
  const out: DerivedTitleEntry = { ...carried, heldStats: previous.heldStats };
  delete out.heldRevision;
  return previous.heldRevision ? { ...out, heldRevision: previous.heldRevision } : out;
}

// Carries the Claude session name through `resolveSessionName`.
// Withdrawal releases prompt names. Shrinkage or a changed first record releases every name.
function carrySessionName(previous: DerivedTitleEntry | undefined, next: DerivedTitleEntry): DerivedTitleEntry {
  const stored = storedSessionName(previous);
  const held = next.withdrawnPrompt && stored?.source === 'prompt' ? null : stored;
  if (!previous || !held || replacedTranscript(previous, next)) {
    return next;
  }
  const name = resolveSessionName(held, storedSessionName(next));
  return name ? withSessionName(next, name) : next;
}

// Updates the Claude session name and any existing folded search label.
export function withSessionName(entry: DerivedTitleEntry, name: SessionName): DerivedTitleEntry {
  if (
    name.source === entry.nameSource &&
    name.label === entry.label &&
    name.fullLabel === entry.fullLabel &&
    name.at === entry.nameAt
  ) {
    return entry;
  }
  const rest = { ...entry };
  delete rest.nameAt;
  return {
    ...rest,
    label: name.label,
    fullLabel: name.fullLabel,
    nameSource: name.source,
    ...(name.at === undefined ? {} : { nameAt: name.at }),
    ...(entry.foldedLabel === undefined ? {} : { foldedLabel: name.label.toLocaleLowerCase() }),
  };
}

// Returns current session facts, or held facts when current context is unavailable.
export function derivedTitleStats(entry: DerivedTitleEntry): SessionStatFacts | null {
  if (entry.heldStats && !statsHaveContext(entry.stats)) {
    return entry.heldStats;
  }
  return entry.stats;
}

// Preserves held cache metadata during an incomplete turn.
// A current failure or compaction after the held request takes precedence.
export function derivedTitleCacheStats(entry: DerivedTitleEntry): SessionStatFacts | null {
  const current = entry.stats;
  const held = entry.heldStats;
  if (!current || !held || statsHaveContext(current)) {
    return derivedTitleStats(entry);
  }
  if (newestStatTurn(current)?.error) {
    return current;
  }
  const heldRequestAt = newestStatTurn(held)?.contextRequest?.at;
  if (heldRequestAt !== undefined && current.compactions.some((compaction) => compaction.at > heldRequestAt)) {
    return current;
  }
  return held;
}

// Reports whether the entry's own read supplies its cache facts.
// Current context, a current failure, or a current compaction count. Held facts and a tail without context do not.
export function derivedTitleCacheCurrent(entry: DerivedTitleEntry): boolean {
  const current = entry.stats;
  if (!current) {
    return false;
  }
  if (statsHaveContext(current) || newestStatTurn(current)?.error) {
    return true;
  }
  if (!entry.heldStats) {
    return current.compactions.length > 0;
  }
  return derivedTitleCacheStats(entry) === current;
}

// Returns the transcript revision whose read found the entry's cache facts.
// Current facts rest on the entry's own revision and held facts on `heldRevision`.
// Returns null when no read supplies current or held facts, or when held facts carry no revision.
export function derivedTitleCacheRevision(entry: DerivedTitleEntry): Pick<FileRevision, 'mtimeMs' | 'size'> | null {
  if (derivedTitleCacheCurrent(entry)) {
    return { mtimeMs: entry.mtimeMs, size: entry.size };
  }
  const held = entry.heldStats;
  return held && derivedTitleCacheStats(entry) === held ? (entry.heldRevision ?? null) : null;
}

// Caches figures by session id and facts-object identity.
// The `current` predicate rejects figures affected by changing external inputs, such as the clock.
// The `derive` callback must use facts and other unchanging inputs. Callers must replace changed facts with a new object.
// `read` gives a new output when a figure moves, and the same output when every listed session keeps its figure.
// `patch` changes the output in place. Readers hold the output by identity, as `lastRailKey` in panelhost.ts does.
// Removed sessions lose their figures.
export class SessionFactFigures<F, V> {
  private held = new Map<string, { facts: F; value: V }>();
  private value: Readonly<Record<string, V>> = {};

  read(
    sessions: readonly (readonly [sessionId: string, facts: F])[],
    derive: (facts: F) => V,
    current: (value: V) => boolean = () => true,
  ): Readonly<Record<string, V>> {
    const next = new Map<string, { facts: F; value: V }>();
    let moved = false;
    for (const [sessionId, facts] of sessions) {
      const previous = this.held.get(sessionId);
      if (previous && previous.facts === facts && current(previous.value)) {
        next.set(sessionId, previous);
        continue;
      }
      moved = true;
      next.set(sessionId, { facts, value: derive(facts) });
    }
    // Unchanged entries come from the held map, so equal sizes also mean equal membership.
    if (moved || next.size !== this.held.size) {
      this.value = Object.fromEntries([...next].map(([sessionId, entry]) => [sessionId, entry.value]));
    }
    this.held = next;
    return this.value;
  }

  // Sets the figure of one session, or drops it with null. The output keeps its identity, so a reader that holds it by
  // identity, as `lastRailKey` in panelhost.ts does, sees no change. A caller that patches a figure posts the change itself.
  patch(sessionId: string, entry: { facts: F; value: V } | null): Readonly<Record<string, V>> {
    const value = this.value as Record<string, V>;
    if (entry) {
      this.held.set(sessionId, entry);
      value[sessionId] = entry.value;
    } else {
      this.held.delete(sessionId);
      delete value[sessionId];
    }
    return this.value;
  }
}

// Stores session list enrichment and uses scan results to set `agentRun`.
// Without a scan, it keeps the metadata answer. `agentRunAnswer` in turnrail.ts independently identifies child transcripts as agent runs.
export function withRailEnrichment(
  entry: DerivedTitleEntry,
  starts: TurnStarts,
  scan: AgentRunScan | undefined,
): DerivedTitleEntry {
  if (scan) {
    return { ...entry, starts, agentRunScan: scan, agentRun: agentRunOfScan(scan, entry.size) };
  }
  const next: DerivedTitleEntry = { ...entry, starts };
  delete next.agentRunScan;
  return next;
}

// Drops scans for sessions that no longer need them.
// Size changes and child-transcript classification cannot leave a stale cursor overriding metadata.
export function scanForRailEnrichment(
  session: { agent: string; size: number; childTranscript?: boolean },
  scan: AgentRunScan | undefined,
): AgentRunScan | undefined {
  return needsAgentRunScan(session) ? scan : undefined;
}

// Checks matching device and inode identifiers and a nondecreasing size.
export function onlyGrew(before: FileRevision | null, after: FileRevision | null): boolean {
  return !!before && !!after && before.dev === after.dev && before.ino === after.ino && after.size >= before.size;
}

// Retains a starts scan when device and inode match and size does not shrink.
export function scanKeptThroughGrowth(
  value: { kind: string; agentRunScan?: AgentRunScan },
  before: FileRevision | null,
  after: FileRevision | null,
): AgentRunScan | undefined {
  return value.kind === 'starts' && onlyGrew(before, after) ? value.agentRunScan : undefined;
}

// Advances a stale scan cursor without replacing newer starts or metadata classification.
// Oversized, older, and already settled person scans leave the entry unchanged.
// A new person classification also clears `agentRun` so a carried run answer cannot survive it.
// Returns null when the entry keeps its current cursor.
export function withAgentRunScanProgress(entry: DerivedTitleEntry, scan: AgentRunScan): DerivedTitleEntry | null {
  const held = entry.agentRunScan;
  if (scan.bytes > entry.size || (held && (held.person || held.bytes >= scan.bytes))) {
    return null;
  }
  return { ...entry, agentRunScan: scan, ...(scan.person ? { agentRun: false } : {}) };
}

export interface DerivedCache {
  commitRepositories?: VerifiedCommitRepository[];
  reuse?: {
    reason: string;
    storedGeneration?: unknown;
    rejectedRelationships?: number;
    rejectedTitles?: number;
    acceptedRelationships?: number;
    format?: number;
    source?: string;
    checkpoint?: string;
  };
  migrationPending?: boolean;
  discovery?: import('./progressiveworker').DiscoveryCheckpoint;
  // Legacy workspace Codex opening rows seed a missing shared `codex-openings.json`.
  // Workspace saves omit these rows.
  codexMetas: Map<string, CodexSessionMeta>;
  titles: Map<string, DerivedTitleEntry>;
  claudeChildReferences: Map<string, ClaudeChildReferenceCacheEntry>;
  // Names carried across a metadata generation change until a metadata read supplies a title entry.
  carriedNames: Map<string, CarriedName>;
  links?: SavedDiscoveryLinks;
  // The file held a link set that failed validation, so `links` is absent for that reason.
  linksMalformed?: boolean;
  // Complete prompt scans of Claude transcripts by file, each at the revision it read. See `savedPromptScanOf`.
  promptScans?: Map<string, HumanPromptScan>;
  // The openings that earlier launches read for Claude transcripts. See `savedOpeningCurrent`.
  claudeOpenings?: SavedClaudeOpenings;
  // Rollouts with an adoption of their compressed twin not yet settled, as plain path to twin path. The title and
  // opening of such a rollout stay across a restart.
  unsettledAdoptions?: Map<string, string>;
}

// The merged links and child rows of the last complete discovery reply that settled membership. A later start publishes its
// first catalog from them while discovery stays pending.
export interface SavedDiscoveryLinks {
  // `Date.now()` when the reply settled. No age check reads it, so a set of any age can publish.
  savedAt: number;
  // The repository roots of the reply, as JSON.
  scope: string;
  // `discoveryCompatibility` of the relationship parser version that produced the links.
  compatibility: string;
  // The device and inode of the receipt store directory that the reply's receipt scan read. Empty when the store was missing.
  receiptStore: string;
  references: ClaudeChildSessionReference[];
  children: ClaudeChildSessionFile[];
}
// A larger link set is not saved.
export const MAX_SAVED_DISCOVERY_LINKS = 65_536;

export type SavedLinksRefusal = 'missing' | 'malformed' | 'scope' | 'incompatible';
// Why a saved link set cannot publish a first catalog, before the walked rows are compared with it. Age never refuses a set.
export function savedLinksRefusal(
  saved: SavedDiscoveryLinks | undefined,
  malformed: boolean,
  scope: string,
  compatibility: string,
): SavedLinksRefusal | null {
  if (!saved) return malformed ? 'malformed' : 'missing';
  if (saved.scope !== scope) return 'scope';
  if (saved.compatibility !== compatibility) return 'incompatible';
  return null;
}

export interface CarriedName {
  label: string;
  fullLabel: string;
}

// Versions the prompt rules of saved prompt scans. A saved scan of another version is not loaded. Bump it when a change
// in transcript.ts can change what a complete scan finds. These functions decide that answer, with the patterns and
// constants they read: `humanPromptScanSteps`, `completeLineSteps`, `scanPromptLines`, `promptScanLists`,
// `claudePromptScanLineMayMatter`, `claudeSessionLineMayAffectRead`, `skipsOrdinaryToolResult`, `claudeRequestMarked`,
// `isTypedPrompt`, `cleanPrompt`, `extractPrompt`, `localCommandOutputOnly`, `textOf`, `stamp`, `promptPair`,
// `claudeRecordId`, `claudeCompactPrompt`, `advancePromptPair`, `readerQueuedAsk`, `isReaderQueued`, `claudeLocalAnswer`,
// `claudeCompactAnswer`, `claudeModelWorks`, `claudeModelAnswered`, `failedATurn`, `interruptedATurn` and
// `claudeProcessEndedAt`. The derived cache tests hash their source and fail when the hash moves without a bump.
// Prompt rules hash at version 1: 08789871281954b0.
export const PROMPT_SCAN_RULES_VERSION = 1;
// The derived cache keeps the saved prompt scans of the most recently modified files up to this count.
export const MAX_SAVED_PROMPT_SCANS = 10_000;

// The saved form of a complete prompt scan, or null when the scan cannot be saved. A saved scan holds whether it found a
// prompt, its complete-line cursor, and the size, modification time, device and inode of the file it read. A scan that
// is unfinished, holds a pending line, or read a file without a device and inode is not saved. A scan that found no
// prompt and holds a command is not saved, because a later compaction can restore a withdrawn command. A scan that found
// a prompt is final, so it is saved without its command. A complete scan that found no prompt reached the end of its file.
export function savedPromptScanOf(scan: HumanPromptScan): HumanPromptScan | null {
  const source = scan.source;
  if (scan.complete !== true || scan.pending || (scan.command && !scan.found) || !source) return null;
  if (!fileIdentityValue(source.dev) || !fileIdentityValue(source.ino)) return null;
  if (!Number.isSafeInteger(source.size) || source.size < 0 || !Number.isFinite(source.mtimeMs)) return null;
  if (!Number.isSafeInteger(scan.bytes) || scan.bytes < 0 || scan.bytes > source.size) return null;
  if (!scan.found && scan.bytes !== source.size) return null;
  return {
    bytes: scan.bytes,
    found: scan.found,
    complete: true,
    source: { size: source.size, mtimeMs: source.mtimeMs, dev: source.dev, ino: source.ino },
  };
}

interface StoredPromptScan {
  file: string;
  found: boolean;
  bytes: number;
  size: number;
  mtimeMs: number;
  dev: number | string;
  ino: number | string;
}

interface StoredPromptScans {
  rulesVersion: number;
  scans: StoredPromptScan[];
}

// The saved scans of a stored cache. Scans of another rules version, and rows that are not a complete scan, load nothing.
function storedPromptScans(value: unknown): Map<string, HumanPromptScan> {
  const scans = new Map<string, HumanPromptScan>();
  if (!record(value) || value.rulesVersion !== PROMPT_SCAN_RULES_VERSION || !Array.isArray(value.scans)) return scans;
  for (const row of value.scans) {
    if (!record(row) || !fileName(row.file) || typeof row.found !== 'boolean') continue;
    const scan = savedPromptScanOf({
      bytes: row.bytes as number,
      found: row.found,
      complete: true,
      source: {
        size: row.size as number,
        mtimeMs: row.mtimeMs as number,
        dev: row.dev as number | string,
        ino: row.ino as number | string,
      },
    });
    if (scan) scans.set(row.file, scan);
  }
  return new Map(limitPromptScans(scans));
}

// The scans of the most recently modified files, up to `MAX_SAVED_PROMPT_SCANS`.
function limitPromptScans(scans: ReadonlyMap<string, HumanPromptScan>): [string, HumanPromptScan][] {
  return [...scans]
    .sort(([a, left], [b, right]) => right.source!.mtimeMs - left.source!.mtimeMs || a.localeCompare(b))
    .slice(0, MAX_SAVED_PROMPT_SCANS);
}

// The saved openings of Claude transcripts, by file, for the first walk of a launch. An opening holds only a nonempty
// working directory, so a transcript whose opening names none reads again.
export interface SavedClaudeOpenings {
  parents: ReadonlyMap<string, SavedClaudeOpening>;
  children: ReadonlyMap<string, SavedClaudeOpening>;
}

// Versions the rules that read a working directory from a Claude transcript's opening. Saved openings of another version do
// not load. Bump it when `scanSessionCwd` or `cwdFromDescriptor` in transcript.ts can change the directory that they find.
export const CLAUDE_OPENINGS_RULES_VERSION = 1;
// The derived cache keeps the saved openings of the most recently modified files up to this count, for parents and for
// children separately.
export const MAX_SAVED_CLAUDE_OPENINGS = 10_000;

interface StoredClaudeOpening extends SavedClaudeOpening {
  file: string;
}

interface StoredClaudeOpenings {
  rulesVersion: number;
  parents: StoredClaudeOpening[];
  children: StoredClaudeOpening[];
}

function savedClaudeOpening(value: unknown): value is SavedClaudeOpening {
  return (
    record(value) &&
    nonEmptyText(value.cwd) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    finite(value.mtimeMs) &&
    (value.dev === undefined || fileIdentityValue(value.dev)) &&
    (value.ino === undefined || fileIdentityValue(value.ino))
  );
}

// The valid openings, newest first, up to `MAX_SAVED_CLAUDE_OPENINGS`.
function limitClaudeOpenings(openings: Iterable<[string, SavedClaudeOpening]>): [string, SavedClaudeOpening][] {
  return [...openings]
    .filter(([, opening]) => savedClaudeOpening(opening))
    .sort(([a, left], [b, right]) => right.mtimeMs - left.mtimeMs || a.localeCompare(b))
    .slice(0, MAX_SAVED_CLAUDE_OPENINGS);
}

function loadedClaudeOpenings(rows: unknown): ReadonlyMap<string, SavedClaudeOpening> {
  const openings: [string, SavedClaudeOpening][] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!record(row) || !fileName(row.file) || !savedClaudeOpening(row)) continue;
    const { file, ...opening } = row as unknown as StoredClaudeOpening;
    openings.push([file, opening]);
  }
  return new Map(limitClaudeOpenings(openings));
}

// A cache file of another rules version, or one without saved openings, loads none.
function storedClaudeOpenings(value: unknown): SavedClaudeOpenings {
  const current = record(value) && value.rulesVersion === CLAUDE_OPENINGS_RULES_VERSION;
  return {
    parents: loadedClaudeOpenings(current ? value.parents : undefined),
    children: loadedClaudeOpenings(current ? value.children : undefined),
  };
}

function storedClaudeOpeningRows(openings: ReadonlyMap<string, SavedClaudeOpening>): StoredClaudeOpening[] {
  return limitClaudeOpenings(openings)
    .map(([file, opening]) => ({ file, ...opening }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export const CLAUDE_CHILD_REFERENCE_PARSER_VERSION = 26;
export const MAX_CLAUDE_CHILD_REFERENCE_FILES = 10_000;
export const MAX_CODEX_DISPATCH_CURSOR_BYTES = 64 * 1024 * 1024;
export { MAX_CLAUDE_CHILD_REFERENCES_PER_FILE };
// Bump when Claude or Codex dispatched spend reading changes what it derives. A mismatch drops the saved
// facts and keeps their rows.
export const DISPATCH_FACTS_VERSION = 4;
export const MAX_SAVED_DISPATCH_FACTS_BYTES = 16 * 1024 * 1024;

// A dispatched session's settled spend facts at one file revision and spend tree.
export interface SavedDispatchFacts {
  version: number;
  revision: import('./transcript').FileRevision;
  tree: string;
  sourceGeneration?: number;
  codexDependencies?: string[];
  activity?: DispatchActivityRead;
  facts: import('./progressiveworker').DispatchSessionFacts;
}

// The activity read behind settled Claude dispatched facts. `covered` is true when the repeated-record map
// covered the file as the read ran. `artifactsComplete` holds the spend read's own value before the activity
// read marked the facts unfinished.
export interface DispatchActivityRead {
  covered: boolean;
  artifactsComplete: boolean | null;
}

export interface ClaudeChildReferenceCacheEntry {
  sourceGeneration?: number;
  sequence?: number;
  parserVersion: number;
  source?: 'claude' | 'codex';
  complete?: boolean;
  visitedEof?: boolean;
  cursor?: import('./codex').CodexDispatchCursor;
  claudeCursor?: import('./transcript').ClaudeRelationshipCursor;
  evidence?: import('./transcript').RelationshipEvidence;
  resetReason?: string;
  pendingReferences?: ClaudeChildSessionReference[];
  relationshipComplete?: boolean;
  appliedCut?: number;
  validatedRevision?: import('./transcript').FileRevision;
  // The head this source's file named when discovery resolved it as a Claude child, kept so a new worker skips the read.
  head?: import('./transcript').ClaudeChildHead;
  // The spend facts of this source's file when it was a settled dispatched session, kept so a new worker skips the read.
  dispatch?: SavedDispatchFacts;
  mtimeMs: number;
  size: number;
  dev: number | string;
  ino: number | string;
  sessionId: string;
  childTranscript: boolean;
  references: ClaudeChildSessionReference[];
}

interface StoredTitle {
  file: string;
  agent: AgentKind;
  entry: DerivedTitleEntry;
}
interface StoredChildReferences {
  file: string;
  entry: ClaudeChildReferenceCacheEntry;
}
interface StoredCarriedName extends CarriedName {
  file: string;
}
interface StoredCache {
  commitRepositories?: VerifiedCommitRepository[];
  discovery?: import('./progressiveworker').DiscoveryCheckpoint;
  formatVersion: 2;
  metadataGenerations: MetadataGenerations;
  titles: StoredTitle[];
  claudeChildReferences: StoredChildReferences[];
  carriedNames: StoredCarriedName[];
  unsettledAdoptions?: [string, string][];
  links?: SavedDiscoveryLinks;
  promptScans?: StoredPromptScans;
  claudeOpenings?: StoredClaudeOpenings;
}

export type MetadataGenerations = Readonly<Record<AgentKind, number>>;

// Versions stored metadata for each agent. A mismatch drops that agent's entries and carries their names until metadata replaces them.
// Bump an agent's generation for stored field changes or changed derivation rules of its sessions, including agent-run classification in transcript.ts and codex.ts.
// Bump both generations for a change that alters both agents' facts.
// Unchanged files otherwise retain valid-looking stale facts indefinitely.
// The initial metadata budget, `INITIAL_RAIL_READ_BYTES`, spreads large workspace rebuilds across refreshes.
// Targeted invalidation avoids a full rebuild when affected entries are identifiable at load.
// Codex opening rows use `CODEX_META_VERSION` from codexopenings.ts and survive these generation changes.
export const METADATA_GENERATIONS: MetadataGenerations = { claude: 74, codex: 73 };

// The agent generations that each shared `metadataVersion` of `derived-session-cache-v1.json` matches.
// Each pair names the agent generation of the stored facts.
// An absent pair matches no generation. A later bump of one agent's generation stops importing that agent's entries.
export const V1_METADATA_GENERATIONS: Readonly<Record<number, Partial<MetadataGenerations>>> = {
  70: { claude: 71 },
  71: { claude: 71, codex: 71 },
  72: { claude: 72, codex: 72 },
};

// The agent whose source root holds a file. A file inside neither root, or inside both, has no agent.
export function sourceAgentOf(file: string): AgentKind | null {
  const claude = isInside(file, [projectsRoot()]);
  const codex = isInside(file, [codexSessionsRoot()]);
  return claude === codex ? null : claude ? 'claude' : 'codex';
}

export class DerivedCacheCheckpointState {
  private generation = 0;
  private savedGeneration = 0;
  private urgentGeneration = 0;

  constructor(private savedAt: number) {}

  get dirty(): boolean {
    return this.generation !== this.savedGeneration;
  }

  markChanged(urgent = false): void {
    this.generation += 1;
    if (urgent) {
      this.urgentGeneration = this.generation;
    }
  }

  nextDelay(now: number, interval: number): number | null {
    if (!this.dirty) {
      return null;
    }
    if (this.urgentGeneration > this.savedGeneration) {
      return 0;
    }
    return Math.max(0, this.savedAt + interval - now);
  }

  markSaved(at: number): void {
    this.savedGeneration = this.generation;
    this.savedAt = at;
  }
}

export function enrichDerivedTitleEntry(entry: DerivedTitleEntry, read: SessionRead): DerivedTitleEntry {
  if (entry.metadataWindow?.exhausted) {
    const { exhaustedRule: _rule, ...window } = entry.metadataWindow;
    entry = { ...entry, metadataWindow: { ...window, exhausted: false } };
  }
  if (entry.stats !== null && entry.outcome !== null) {
    return entry;
  }
  const stats = entry.stats ?? sessionStatFactsOf(read);
  const outcome = entry.outcome ?? sessionOutcomeOf(read);
  if (stats === entry.stats && outcome === entry.outcome) {
    return entry;
  }
  return { ...entry, stats, outcome };
}

// The metadata recovery rule an exhausted entry was read under. An entry exhausted under an earlier rule is read again.
export const METADATA_EXHAUSTED_RULE = 2;

export function metadataRecoveryExhausted(entry: DerivedTitleEntry): boolean {
  return entry.metadataWindow?.exhausted === true && entry.metadataWindow.exhaustedRule === METADATA_EXHAUSTED_RULE;
}

export function derivedTitleNeedsRailFacts(entry: DerivedTitleEntry): boolean {
  return (
    (unresolvedMetadata(entry) && entry.expandedStatsRead !== true && !metadataRecoveryExhausted(entry)) ||
    entry.starts === undefined ||
    entry.foldedLabel === undefined
  );
}

export function railEnrichmentNeeds(
  entry: DerivedTitleEntry,
  session: Pick<SessionFile, 'mtimeMs' | 'size'>,
): { starts: boolean; metadata: boolean; recovery?: boolean } | null {
  if (!sameSessionRevision(entry, session)) {
    return null;
  }
  const starts = entry.starts === undefined;
  const metadata = unresolvedMetadata(entry) && entry.expandedStatsRead !== true && entry.metadataWindow === undefined;
  const recovery =
    unresolvedMetadata(entry) &&
    entry.expandedStatsRead !== true &&
    entry.metadataWindow?.whole === false &&
    !metadataRecoveryExhausted(entry);
  return starts || metadata || recovery ? { starts, metadata, ...(recovery ? { recovery: true } : {}) } : null;
}

export function unresolvedMetadata(entry: DerivedTitleEntry): boolean {
  return entry.stats === null || !statsHaveContext(entry.stats) || entry.outcome === null;
}

function replacedMetadataSource(previous: DerivedTitleEntry, next: DerivedTitleEntry): boolean {
  return (
    !!previous.sourceIdentity &&
    !!next.sourceIdentity &&
    (previous.sourceIdentity.dev !== next.sourceIdentity.dev || previous.sourceIdentity.ino !== next.sourceIdentity.ino)
  );
}

export function withMetadataCoverage(
  entry: DerivedTitleEntry,
  coverage: import('./transcript').MetadataCoverage,
): DerivedTitleEntry {
  return { ...entry, metadataWindow: coverage, ...(coverage.whole ? { expandedStatsRead: true } : {}) };
}

function empty(): DerivedCache {
  return { codexMetas: new Map(), titles: new Map(), claudeChildReferences: new Map(), carriedNames: new Map() };
}

// Carries only a nonempty label and a text full label from a stored row.
function carriedName(value: unknown): CarriedName | null {
  return record(value) && text(value.label) && value.label.length > 0 && text(value.fullLabel)
    ? { label: value.label, fullLabel: value.fullLabel }
    : null;
}

function carryNames(
  into: Map<string, CarriedName>,
  rows: unknown,
  nameOf: (row: Record<string, unknown>) => unknown,
): void {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!record(row) || !fileName(row.file)) {
      continue;
    }
    const name = carriedName(nameOf(row));
    if (name) {
      into.set(row.file, name);
    }
  }
}

function metadataGenerations(value: unknown): value is MetadataGenerations {
  return (
    record(value) &&
    [value.claude, value.codex].every((generation) => Number.isInteger(generation) && (generation as number) >= 0)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}
function nonEmptyText(value: unknown): value is string {
  return text(value) && value.length > 0;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function nullableFinite(value: unknown): value is number | null {
  return value === null || finite(value);
}

function closedChild(value: unknown): boolean {
  return nonEmptyText(value) || (record(value) && nonEmptyText(value.id) && finite(value.closedAt));
}

function backgroundCommand(value: unknown): boolean {
  return record(value) && nonEmptyText(value.id) && finite(value.startedAt);
}

function outcome(value: unknown): value is TurnOutcome | null {
  if (value === null) {
    return true;
  }
  return (
    record(value) &&
    typeof value.finished === 'boolean' &&
    typeof value.error === 'boolean' &&
    typeof value.interrupted === 'boolean' &&
    finite(value.endedAt) &&
    (!Object.prototype.hasOwnProperty.call(value, 'processEndedAt') || finite(value.processEndedAt)) &&
    (!Object.prototype.hasOwnProperty.call(value, 'openChildren') ||
      (Array.isArray(value.openChildren) && value.openChildren.every(nonEmptyText))) &&
    (!Object.prototype.hasOwnProperty.call(value, 'closedChildren') ||
      (Array.isArray(value.closedChildren) && value.closedChildren.every(closedChild))) &&
    (!Object.prototype.hasOwnProperty.call(value, 'taskCompletions') ||
      validClaudeTaskCompletions(value.taskCompletions)) &&
    (!Object.prototype.hasOwnProperty.call(value, 'backgroundCommands') ||
      (Array.isArray(value.backgroundCommands) && value.backgroundCommands.every(backgroundCommand)))
  );
}

function turnStarts(value: unknown): value is TurnStarts {
  return (
    record(value) &&
    Array.isArray(value.starts) &&
    value.starts.every(finite) &&
    typeof value.whole === 'boolean' &&
    (value.scheduled === undefined || (Array.isArray(value.scheduled) && value.scheduled.every(finite)))
  );
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function contextRequest(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      finite(value.at) &&
      (value.effort === undefined || value.effort === null || nonEmptyText(value.effort)) &&
      (value.bedrock === undefined || typeof value.bedrock === 'boolean') &&
      (value.lifetime === null || isCacheLifetime(value.lifetime)) &&
      (value.inferenceClass === null ||
        value.inferenceClass === 'in-region' ||
        value.inferenceClass === 'geo' ||
        value.inferenceClass === 'global' ||
        value.inferenceClass === 'bedrock-regional') &&
      (value.serviceTier === null || nonEmptyText(value.serviceTier)) &&
      typeof value.readBack === 'boolean' &&
      nonNegative(value.outputTokens))
  );
}

function usageCounts(value: unknown): value is UsageCounts {
  if (!record(value)) {
    return false;
  }
  const required = ['input', 'cacheWrite1h', 'cacheWrite5m', 'cacheRead', 'output', 'thinking'];
  return (
    required.every((key) => nonNegative(value[key])) &&
    (value.requests === undefined || nonNegative(value.requests)) &&
    (value.cacheWrite30m === undefined || nonNegative(value.cacheWrite30m))
  );
}

function usage(value: unknown): value is TurnUsage {
  if (!record(value)) {
    return false;
  }
  const usageRecord = value;
  if (!usageCounts(usageRecord)) {
    return false;
  }
  if (usageRecord.byContextBand === undefined) {
    return true;
  }
  const bands = usageRecord.byContextBand;
  if (!record(bands)) {
    return false;
  }
  const parts: UsageCounts[] = [];
  for (const band of ['short', 'long']) {
    const part = bands[band];
    if (part === undefined) {
      continue;
    }
    if (!usageCounts(part)) {
      return false;
    }
    parts.push(part);
  }
  if (!parts.length) {
    return false;
  }
  const total = parts.reduce(
    (sum, part) => ({
      requests: (sum.requests ?? 0) + (part.requests ?? 0),
      input: sum.input + part.input,
      cacheWrite1h: sum.cacheWrite1h + part.cacheWrite1h,
      cacheWrite5m: sum.cacheWrite5m + part.cacheWrite5m,
      cacheWrite30m: (sum.cacheWrite30m ?? 0) + (part.cacheWrite30m ?? 0),
      cacheRead: sum.cacheRead + part.cacheRead,
      output: sum.output + part.output,
      thinking: sum.thinking + part.thinking,
    }),
    {
      requests: 0,
      input: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
    },
  );
  return (
    (total.requests ?? 0) === (value.requests ?? 0) &&
    total.input === value.input &&
    total.cacheWrite1h === value.cacheWrite1h &&
    total.cacheWrite5m === value.cacheWrite5m &&
    (total.cacheWrite30m ?? 0) === (value.cacheWrite30m ?? 0) &&
    total.cacheRead === value.cacheRead &&
    total.output === value.output &&
    total.thinking === value.thinking
  );
}

// Tool kinds of a usage part. A kind's usage is its even part of its requests, so it can be fractional.
function usageTools(value: unknown): boolean {
  return (
    record(value) &&
    Number.isInteger(value.requests) &&
    Number(value.requests) >= 0 &&
    record(value.kinds) &&
    Object.values(value.kinds).every(
      (kind) =>
        record(kind) &&
        Number.isInteger(kind.requests) &&
        Number(kind.requests) >= 0 &&
        Number(kind.requests) <= Number(value.requests) &&
        usageCounts(kind.usage) &&
        ((kind.usage as TurnUsage).byContextBand === undefined ||
          (record((kind.usage as TurnUsage).byContextBand) &&
            Object.values((kind.usage as TurnUsage).byContextBand!).every(usageCounts))),
    )
  );
}

function usageParts(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.every(
      (part) =>
        record(part) &&
        (part.model === null || nonEmptyText(part.model)) &&
        (part.provider === null || nonEmptyText(part.provider)) &&
        nullableFinite(part.contextWindow) &&
        (part.contextBand === null || part.contextBand === 'short' || part.contextBand === 'long') &&
        (part.inferenceClass === null ||
          part.inferenceClass === 'in-region' ||
          part.inferenceClass === 'geo' ||
          part.inferenceClass === 'global' ||
          part.inferenceClass === 'bedrock-regional') &&
        (part.serviceTier === null || nonEmptyText(part.serviceTier)) &&
        (part.unclassifiedCacheWrite === undefined || nonNegative(part.unclassifiedCacheWrite)) &&
        (part.incomplete === undefined || typeof part.incomplete === 'boolean') &&
        (part.requestCountExact === undefined || part.requestCountExact === false) &&
        (part.linkedInvocationId === undefined ||
          part.linkedInvocationId === null ||
          nonEmptyText(part.linkedInvocationId)) &&
        (part.waits === undefined ||
          (record(part.waits) &&
            Number.isInteger(part.waits.requests) &&
            Number(part.waits.requests) > 0 &&
            Number.isInteger(part.waits.timedOut) &&
            Number(part.waits.timedOut) >= 0 &&
            Number(part.waits.timedOut) <= Number(part.waits.requests) &&
            (part.waits.tools === undefined ||
              (record(part.waits.tools) &&
                Object.values(part.waits.tools).every((count) => Number.isInteger(count) && Number(count) > 0))) &&
            usage(part.waits.usage))) &&
        (part.tools === undefined || usageTools(part.tools)) &&
        usage(part.usage),
    )
  );
}

function stats(value: unknown): value is SessionStatFacts | null {
  if (value === null) {
    return true;
  }
  if (!record(value) || !Array.isArray(value.turns) || !Array.isArray(value.compactions)) {
    return false;
  }
  return (
    value.turns.every(
      (turn) =>
        record(turn) &&
        finite(turn.startedAt) &&
        finite(turn.endedAt) &&
        typeof turn.finished === 'boolean' &&
        typeof turn.error === 'boolean' &&
        (turn.model === null || nonEmptyText(turn.model)) &&
        (turn.effort === undefined || turn.effort === null || nonEmptyText(turn.effort)) &&
        (turn.provider === null || nonEmptyText(turn.provider)) &&
        usage(turn.usage) &&
        usageParts(turn.usageParts) &&
        nonNegative(turn.contextTokens) &&
        nullableFinite(turn.contextWindow) &&
        contextRequest(turn.contextRequest) &&
        typeof turn.childSpendPartial === 'boolean',
    ) &&
    value.compactions.every(
      (compaction) =>
        record(compaction) &&
        finite(compaction.at) &&
        nonNegative(compaction.contextAfter) &&
        (compaction.retainedContext === undefined ||
          (record(compaction.retainedContext) &&
            nonNegative(compaction.retainedContext.tokens) &&
            nullableFinite(compaction.retainedContext.window))) &&
        text(compaction.trigger) &&
        (compaction.model === null || nonEmptyText(compaction.model)),
    )
  );
}

function titleEntry(value: unknown): value is DerivedTitleEntry {
  return (
    record(value) &&
    finite(value.mtimeMs) &&
    finite(value.size) &&
    text(value.label) &&
    text(value.fullLabel) &&
    nullableFinite(value.activityMs) &&
    typeof value.agentRun === 'boolean' &&
    outcome(value.outcome) &&
    (value.backgroundCommands === undefined ||
      (Array.isArray(value.backgroundCommands) && value.backgroundCommands.every(backgroundCommand))) &&
    stats(value.stats) &&
    (value.heldStats === undefined || stats(value.heldStats)) &&
    (value.heldRevision === undefined ||
      (value.heldStats !== undefined &&
        record(value.heldRevision) &&
        finite(value.heldRevision.mtimeMs) &&
        nonNegative(value.heldRevision.size))) &&
    (value.expandedStatsRead === undefined || typeof value.expandedStatsRead === 'boolean') &&
    (value.metadataWindow === undefined ||
      (record(value.metadataWindow) &&
        typeof value.metadataWindow.whole === 'boolean' &&
        nonNegative(value.metadataWindow.windowBytes) &&
        (value.metadataWindow.exhausted === undefined || typeof value.metadataWindow.exhausted === 'boolean') &&
        (value.metadataWindow.exhaustedRule === undefined || nonNegative(value.metadataWindow.exhaustedRule)))) &&
    (value.sourceIdentity === undefined ||
      (record(value.sourceIdentity) &&
        (finite(value.sourceIdentity.dev) ||
          (typeof value.sourceIdentity.dev === 'string' && /^(0|[1-9][0-9]*)$/.test(value.sourceIdentity.dev))) &&
        (finite(value.sourceIdentity.ino) ||
          (typeof value.sourceIdentity.ino === 'string' && /^[1-9][0-9]*$/.test(value.sourceIdentity.ino))))) &&
    (value.starts === undefined || turnStarts(value.starts)) &&
    (value.foldedLabel === undefined || text(value.foldedLabel)) &&
    (value.agentRunScan === undefined || agentRunScan(value.agentRunScan)) &&
    (value.nameSource === undefined ||
      value.nameSource === 'custom' ||
      value.nameSource === 'generated' ||
      value.nameSource === 'prompt') &&
    (value.nameAt === undefined || (typeof value.nameAt === 'number' && Number.isFinite(value.nameAt))) &&
    (value.headKey === undefined || typeof value.headKey === 'string') &&
    (value.withdrawnPrompt === undefined || typeof value.withdrawnPrompt === 'boolean')
  );
}

function agentRunScan(value: unknown): value is AgentRunScan {
  return (
    record(value) &&
    nonNegative(value.bytes) &&
    Number.isInteger(value.bytes) &&
    nonNegative(value.prompts) &&
    Number.isInteger(value.prompts) &&
    typeof value.finished === 'boolean' &&
    typeof value.person === 'boolean' &&
    typeof value.unattended === 'boolean' &&
    typeof value.changedFile === 'boolean' &&
    typeof value.deniedTool === 'boolean' &&
    typeof value.command === 'boolean' &&
    typeof value.bridgeSession === 'boolean' &&
    typeof value.bg === 'boolean' &&
    (value.end === undefined || (nonNegative(value.end) && Number.isInteger(value.end))) &&
    (value.entrypoint === undefined || value.entrypoint === 'sdk' || value.entrypoint === 'other')
  );
}

function fileName(value: unknown): value is string {
  return text(value) && value.length > 0;
}

function childReference(value: unknown, parentSessionId: string): value is ClaudeChildSessionReference {
  if (
    !record(value) ||
    value.parentSessionId !== parentSessionId ||
    !nonEmptyText(value.sessionId) ||
    !/^[A-Za-z0-9-]+$/.test(value.sessionId) ||
    !Array.isArray(value.toolUseIds) ||
    !value.toolUseIds.every(nonEmptyText)
  ) {
    return false;
  }
  if (value.kind === 'subagent') {
    return fileName(value.file);
  }
  // Dispatch references require an explicit `owned` boolean. Missing ownership rejects the cached entry and requests another parent read.
  return (
    value.kind === 'dispatch' &&
    (value.agent === 'claude' || value.agent === 'codex') &&
    (value.agent !== 'codex' || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.sessionId)) &&
    value.file === null &&
    (value.name === null || typeof value.name === 'string') &&
    typeof value.owned === 'boolean'
  );
}

// A merged link names its own parent. A resolved dispatch link also names the dispatched session's file.
function savedLink(value: unknown): value is ClaudeChildSessionReference {
  if (!record(value) || !nonEmptyText(value.parentSessionId)) return false;
  if (value.kind === undefined || value.kind === 'subagent')
    return childReference({ ...value, kind: 'subagent' }, value.parentSessionId);
  return (
    (value.file === null || fileName(value.file)) && childReference({ ...value, file: null }, value.parentSessionId)
  );
}

function savedChild(value: unknown): value is ClaudeChildSessionFile {
  return (
    record(value) &&
    value.agent === 'claude' &&
    fileName(value.file) &&
    nonEmptyText(value.sessionId) &&
    nonEmptyText(value.parentSessionId) &&
    nonEmptyText(value.cwd) &&
    value.childTranscript === true &&
    value.agentRun === true &&
    Array.isArray(value.toolUseIds) &&
    value.toolUseIds.every(nonEmptyText) &&
    nonNegative(value.size) &&
    nonNegative(value.mtimeMs) &&
    (value.dev === undefined || fileIdentityValue(value.dev)) &&
    (value.ino === undefined || fileIdentityValue(value.ino))
  );
}

function savedDiscoveryLinks(value: unknown): value is SavedDiscoveryLinks {
  return (
    record(value) &&
    finite(value.savedAt) &&
    text(value.scope) &&
    text(value.compatibility) &&
    text(value.receiptStore) &&
    Array.isArray(value.references) &&
    Array.isArray(value.children) &&
    value.references.length + value.children.length <= MAX_SAVED_DISCOVERY_LINKS &&
    value.references.every(savedLink) &&
    value.children.every(savedChild)
  );
}

function codexDispatchCursor(value: unknown, parentSessionId: string, size: number): boolean {
  if (!record(value)) return false;
  return (
    nonNegative(value.offset) &&
    Number.isInteger(value.offset) &&
    value.offset <= size &&
    value.size === size &&
    validRelationshipEvidence(value.evidence, value.offset) &&
    value.evidence.provisional.size === value.size &&
    value.evidence.provisional.mtimeMs === value.mtimeMs &&
    value.evidence.provisional.dev === value.dev &&
    value.evidence.provisional.ino === value.ino &&
    Number.isSafeInteger(value.target) &&
    (value.target as number) >= value.offset &&
    (value.target as number) <= size &&
    (value.replayThrough === undefined
      ? value.replayFragment === undefined
      : value.fragmentStart !== null &&
        nonNegative(value.fragmentStart) &&
        nonNegative(value.replayThrough) &&
        Number.isSafeInteger(value.replayThrough) &&
        value.replayThrough >= value.fragmentStart &&
        value.replayThrough <= value.offset &&
        typeof value.replayFragment === 'string' &&
        Buffer.from(value.replayFragment, 'base64').toString('base64') === value.replayFragment &&
        Buffer.byteLength(value.replayFragment, 'base64') <= 4 * 1024 * 1024 &&
        Buffer.byteLength(value.replayFragment, 'base64') === value.replayThrough - value.fragmentStart) &&
    nonNegative(value.mtimeMs) &&
    typeof value.fragment === 'string' &&
    Buffer.from(value.fragment, 'base64').toString('base64') === value.fragment &&
    value.fragment.length <= 6 * 1024 * 1024 &&
    (value.fragmentStart === null ||
      (nonNegative(value.fragmentStart) &&
        Number.isInteger(value.fragmentStart) &&
        value.fragmentStart <= value.offset)) &&
    typeof value.skipLongLine === 'boolean' &&
    (value.lostRecords === undefined || typeof value.lostRecords === 'boolean') &&
    value.exportPolicy === undefined &&
    typeof value.head === 'string' &&
    /^[0-9a-f]{64}$/.test(value.head) &&
    typeof value.anchor === 'string' &&
    /^[0-9a-f]{64}$/.test(value.anchor) &&
    fileIdentityValue(value.dev) &&
    fileIdentityValue(value.ino) &&
    value.parentSessionId === parentSessionId &&
    typeof value.terminalApplied === 'boolean' &&
    (value.openingTimestamp === null || nonNegative(value.openingTimestamp)) &&
    (value.openingSessionId === null || nonEmptyText(value.openingSessionId)) &&
    (value.nativeSpawnedAt === null || nonNegative(value.nativeSpawnedAt)) &&
    Array.isArray(value.pendingOwnershipTurnIds) &&
    value.pendingOwnershipTurnIds.length <= 64 &&
    value.pendingOwnershipTurnIds.every(nonEmptyText) &&
    typeof value.foreignSessionMeta === 'boolean' &&
    typeof value.currentTurnRepeated === 'boolean' &&
    (value.currentTurnId === null || nonEmptyText(value.currentTurnId)) &&
    nonNegative(value.currentOccurrence) &&
    Number.isInteger(value.currentOccurrence) &&
    typeof value.currentTurnClassified === 'boolean' &&
    typeof value.currentTurnCopied === 'boolean' &&
    (value.lastTurnId === null || nonEmptyText(value.lastTurnId)) &&
    nonNegative(value.lastOccurrence) &&
    Number.isInteger(value.lastOccurrence) &&
    Array.isArray(value.seenTurnIds) &&
    value.seenTurnIds.length <= 1024 &&
    value.seenTurnIds.every(nonEmptyText) &&
    (value.seenBloom === null || (typeof value.seenBloom === 'string' && value.seenBloom.length <= 90_000)) &&
    Array.isArray(value.candidates) &&
    value.candidates.length <= MAX_CLAUDE_CHILD_REFERENCES_PER_FILE &&
    value.candidates.every(
      (candidate: unknown) =>
        record(candidate) &&
        nonEmptyText(candidate.turnId) &&
        nonNegative(candidate.occurrence) &&
        Number.isInteger(candidate.occurrence) &&
        typeof candidate.classified === 'boolean' &&
        childReference(candidate.reference, parentSessionId),
    )
  );
}

function fileRevision(value: unknown): boolean {
  return (
    record(value) &&
    [value.size, value.mtimeMs].every(nonNegative) &&
    fileIdentityValue(value.dev) &&
    fileIdentityValue(value.ino)
  );
}

function dispatchActivityRead(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.covered === 'boolean' &&
    (value.artifactsComplete === null || typeof value.artifactsComplete === 'boolean')
  );
}

function savedDispatchFacts(value: unknown): value is SavedDispatchFacts {
  if (!record(value) || !record(value.facts)) return false;
  const facts = value.facts;
  const spend = facts.spend;
  if (!record(spend)) return false;
  return (
    value.version === DISPATCH_FACTS_VERSION &&
    fileRevision(value.revision) &&
    text(value.tree) &&
    (value.sourceGeneration === undefined || nonNegative(value.sourceGeneration)) &&
    (value.codexDependencies === undefined ||
      (Array.isArray(value.codexDependencies) && value.codexDependencies.every(nonEmptyText))) &&
    (value.activity === undefined || dispatchActivityRead(value.activity)) &&
    nonEmptyText(facts.sessionId) &&
    facts.refreshAt === null &&
    fileRevision(facts.revision) &&
    nullableFinite(facts.startedAt) &&
    nullableFinite(facts.endedAt) &&
    nonNegative(facts.toolUses) &&
    typeof facts.person === 'boolean' &&
    Array.isArray(spend.models) &&
    spend.models.every(record) &&
    (spend.ownModelTiers === undefined ||
      (Array.isArray(spend.ownModelTiers) &&
        spend.ownModelTiers.every(
          (part) =>
            record(part) &&
            (part.model === null || nonEmptyText(part.model)) &&
            (part.provider === undefined || part.provider === null || nonEmptyText(part.provider)) &&
            (part.serviceTier === undefined || part.serviceTier === null || nonEmptyText(part.serviceTier)),
        ))) &&
    typeof spend.found === 'boolean' &&
    typeof spend.partial === 'boolean'
  );
}

// Drops saved dispatched facts of another facts version, or any that fail their check, and keeps the row.
function withCurrentDispatch(value: unknown): unknown {
  if (!record(value) || value.dispatch === undefined || savedDispatchFacts(value.dispatch)) return value;
  const { dispatch: _dispatch, ...entry } = value;
  return entry;
}

// Keeps the smallest saved dispatched facts within `byteLimit` and drops the rest from their rows.
function limitSavedDispatchFacts(
  rows: Array<{ file: string; entry: ClaudeChildReferenceCacheEntry }>,
  byteLimit = MAX_SAVED_DISPATCH_FACTS_BYTES,
): Array<{ file: string; entry: ClaudeChildReferenceCacheEntry }> {
  const sized = rows
    .flatMap((row, index) =>
      row.entry.dispatch
        ? [{ index, file: row.file, bytes: Buffer.byteLength(JSON.stringify(row.entry.dispatch)) }]
        : [],
    )
    .sort((a, b) => a.bytes - b.bytes || a.file.localeCompare(b.file));
  let total = 0;
  const limited = [...rows];
  for (const row of sized) {
    if (total + row.bytes <= byteLimit) {
      total += row.bytes;
      continue;
    }
    const { dispatch: _dispatch, ...entry } = limited[row.index].entry;
    limited[row.index] = { file: row.file, entry };
  }
  return limited;
}

function childReferenceEntry(value: unknown): value is ClaudeChildReferenceCacheEntry {
  if (!record(value) || !nonEmptyText(value.sessionId)) {
    return false;
  }
  const sessionId = value.sessionId;
  return (
    value.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION &&
    (value.sourceGeneration === undefined || nonNegative(value.sourceGeneration)) &&
    (value.sequence === undefined || nonNegative(value.sequence)) &&
    (value.source === undefined || value.source === 'claude' || value.source === 'codex') &&
    (value.complete === undefined || typeof value.complete === 'boolean') &&
    (value.relationshipComplete === undefined || typeof value.relationshipComplete === 'boolean') &&
    (value.appliedCut === undefined || (nonNegative(value.appliedCut) && value.appliedCut <= (value.size as number))) &&
    (value.validatedRevision === undefined || fileRevision(value.validatedRevision)) &&
    (value.head === undefined ||
      (record(value.head) &&
        fileRevision(value.head.revision) &&
        (value.head.cwd === null || nonEmptyText(value.head.cwd)))) &&
    (value.dispatch === undefined || savedDispatchFacts(value.dispatch)) &&
    (value.pendingReferences === undefined ||
      (Array.isArray(value.pendingReferences) &&
        value.pendingReferences.length <= MAX_CLAUDE_CHILD_REFERENCES_PER_FILE &&
        value.pendingReferences.every((reference) => childReference(reference, sessionId)))) &&
    (value.visitedEof === undefined || typeof value.visitedEof === 'boolean') &&
    (value.evidence === undefined ||
      (record(value.evidence) &&
        validRelationshipEvidence(value.evidence, value.evidence.offset as number) &&
        value.evidence.provisional.size === value.size &&
        value.evidence.provisional.mtimeMs === value.mtimeMs &&
        value.evidence.provisional.dev === value.dev &&
        value.evidence.provisional.ino === value.ino &&
        (!(value.complete || value.visitedEof) ||
          (value.evidence.accepted !== null && !value.evidence.validation && value.evidence.offset === value.size)))) &&
    (value.claudeCursor === undefined || claudeRelationshipCursor(value.claudeCursor, sessionId)) &&
    (value.source !== 'codex' ||
      (typeof value.complete === 'boolean' &&
        (value.cursor === undefined || codexDispatchCursor(value.cursor, sessionId, value.size as number)))) &&
    nonNegative(value.mtimeMs) &&
    nonNegative(value.size) &&
    fileIdentityValue(value.dev) &&
    fileIdentityValue(value.ino) &&
    typeof value.childTranscript === 'boolean' &&
    Array.isArray(value.references) &&
    value.references.length <= MAX_CLAUDE_CHILD_REFERENCES_PER_FILE &&
    value.references.every((reference) => childReference(reference, sessionId))
  );
}

function claudeRelationshipCursor(value: unknown, sessionId: string): boolean {
  if (!record(value) || !record(value.state) || !record(value.revision)) return false;
  const state = value.state;
  const pairs = (rows: unknown, check: (value: unknown) => boolean) =>
    Array.isArray(rows) &&
    rows.every((row: unknown) => Array.isArray(row) && row.length === 2 && nonEmptyText(row[0]) && check(row[1]));
  return (
    value.sessionId === sessionId &&
    validRelationshipEvidence(value.evidence, value.offset as number) &&
    value.evidence.provisional.size === value.revision.size &&
    value.evidence.provisional.mtimeMs === value.revision.mtimeMs &&
    value.evidence.provisional.dev === value.revision.dev &&
    value.evidence.provisional.ino === value.revision.ino &&
    typeof value.childTranscript === 'boolean' &&
    [
      value.offset,
      value.target,
      value.applied,
      value.sequence,
      value.headBytes,
      value.fragmentBytes,
      value.revision.size,
      value.revision.mtimeMs,
    ].every(nonNegative) &&
    fileIdentityValue(value.revision.dev) &&
    fileIdentityValue(value.revision.ino) &&
    (value.applied as number) <= (value.offset as number) &&
    (value.offset as number) <= (value.target as number) &&
    (value.target as number) <= value.revision.size &&
    (value.headBytes as number) <= 256 &&
    typeof value.head === 'string' &&
    /^[0-9a-f]{64}$/.test(value.head) &&
    typeof value.anchor === 'string' &&
    /^[0-9a-f]{64}$/.test(value.anchor) &&
    typeof value.terminalApplied === 'boolean' &&
    Array.isArray(value.fragments) &&
    value.fragments.every(
      (part: unknown) =>
        typeof part === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part),
    ) &&
    value.fragments.reduce((sum: number, part: string) => sum + Buffer.byteLength(part, 'base64'), 0) ===
      value.fragmentBytes &&
    Array.isArray(state.launches) &&
    state.launches.every(nonEmptyText) &&
    pairs(state.children, (ids) => Array.isArray(ids) && ids.every(nonEmptyText)) &&
    pairs(
      state.shellLaunches,
      (launch) =>
        record(launch) &&
        ['native', 'codex-native', 'receipt'].includes(launch.kind as string) &&
        nonNegative(launch.count),
    ) &&
    pairs(
      state.dispatches,
      (references) =>
        Array.isArray(references) && references.every((reference) => childReference(reference, sessionId)),
    )
  );
}

export function sameClaudeChildReferenceCaches(
  left: ReadonlyMap<string, ClaudeChildReferenceCacheEntry>,
  right: ReadonlyMap<string, ClaudeChildReferenceCacheEntry>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [file, entry] of left) {
    const peer = right.get(file);
    if (!peer || JSON.stringify(entry) !== JSON.stringify(peer)) {
      return false;
    }
  }
  return true;
}

export interface DerivedCacheSources {
  // `derived-session-cache-v1.json`. Only absence of the current file permits its import.
  previous?: string;
  // `derived-session-cache.json`. Only absence of the current and previous files permits its import.
  legacy?: string;
  // Qualifies each entry's agent. Defaults to `sourceAgentOf`.
  agentOf?: (file: string) => AgentKind | null;
}

// Format 2 stores one metadata generation per agent and an agent on every title row.
// Format 1 rows carry no agent. Import takes each row's agent from `agentOf` and its generation from `V1_METADATA_GENERATIONS`.
// Rows of an unknown agent or an incompatible generation keep only their names.
export function loadDerivedCache(
  file: string,
  sources: string | DerivedCacheSources = {},
  generations: MetadataGenerations = METADATA_GENERATIONS,
): DerivedCache {
  const options = typeof sources === 'string' ? { legacy: sources } : sources;
  const agentOf = options.agentOf ?? sourceAgentOf;
  let source: 'current' | 'previous' | 'legacy' | undefined;
  try {
    let text = '';
    for (const [name, candidate] of [
      ['current', file],
      ['previous', options.previous],
      ['legacy', options.legacy],
    ] as const) {
      if (candidate === undefined) continue;
      try {
        text = fs.readFileSync(candidate, 'utf8');
        source = name;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (source === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    const parsed: unknown = JSON.parse(text);
    const loaded = empty();
    loaded.reuse = { reason: 'reused', source, checkpoint: 'missing' };
    if (!record(parsed)) {
      loaded.reuse.reason = 'invalid-format';
      return loaded;
    }
    const legacy = source === 'legacy' || (options.legacy === undefined && parsed.formatVersion === undefined);
    const format = legacy ? 0 : parsed.formatVersion;
    const valid =
      legacy ||
      (format === 2 && source === 'current' && metadataGenerations(parsed.metadataGenerations)) ||
      (format === 1 &&
        (source === 'previous' || options.previous === undefined) &&
        Number.isInteger(parsed.metadataVersion) &&
        (parsed.metadataVersion as number) >= 0);
    if (!valid) {
      loaded.reuse.reason = 'invalid-format';
      return loaded;
    }
    const knownLegacy = parsed.version === 63 || parsed.version === 64;
    if ((!legacy || knownLegacy) && Array.isArray(parsed.commitRepositories)) {
      loaded.commitRepositories = boundedCommitRepositories(parsed.commitRepositories);
    }
    loaded.reuse.format = format as number;
    loaded.codexMetas = legacy ? storedCodexMetas(parsed) : new Map();
    if (format === 2 && savedDiscoveryLinks(parsed.links)) loaded.links = parsed.links;
    else if (format === 2 && parsed.links !== undefined) loaded.linksMalformed = true;
    if (format === 2) loaded.promptScans = storedPromptScans(parsed.promptScans);
    if (format === 2) loaded.claudeOpenings = storedClaudeOpenings(parsed.claudeOpenings);
    if (Array.isArray(parsed.unsettledAdoptions)) {
      const rows = parsed.unsettledAdoptions.filter(
        (row): row is [string, string] =>
          Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string',
      );
      if (rows.length) loaded.unsettledAdoptions = new Map(rows);
    }
    carryNames(loaded.carriedNames, parsed.carriedNames, (row) => row);
    loaded.reuse.storedGeneration = legacy
      ? parsed.version
      : format === 1
        ? parsed.metadataVersion
        : parsed.metadataGenerations;
    // Legacy metadata matches no current generation.
    const stored: Partial<MetadataGenerations> = legacy
      ? {}
      : format === 1
        ? (V1_METADATA_GENERATIONS[parsed.metadataVersion as number] ?? {})
        : (parsed.metadataGenerations as MetadataGenerations);
    const compatible = (agent: AgentKind | null) => agent !== null && stored[agent] === generations[agent];
    const agentOfRow = (row: Record<string, unknown>): AgentKind | null => {
      if (format === 1) return agentOf(row.file as string);
      const qualified = agentOf(row.file as string);
      return (row.agent === 'claude' || row.agent === 'codex') && qualified === row.agent ? row.agent : null;
    };
    if (!compatible('claude') && !compatible('codex')) {
      loaded.reuse.reason = 'generation-mismatch';
      carryNames(loaded.carriedNames, parsed.titles, (row) => row.entry);
    } else if (!Array.isArray(parsed.titles)) {
      loaded.reuse.reason = 'invalid-rows';
    } else {
      let rejected = 0;
      for (const row of parsed.titles) {
        if (!record(row) || !fileName(row.file)) continue;
        if (!compatible(agentOfRow(row))) {
          rejected++;
          carryNames(loaded.carriedNames, [row], (title) => title.entry);
        } else if (titleEntry(row.entry)) {
          loaded.titles.set(row.file, row.entry);
          loaded.carriedNames.delete(row.file);
        }
      }
      if (rejected) loaded.reuse.rejectedTitles = rejected;
    }
    const relationshipRows = Array.isArray(parsed.claudeChildReferences) ? parsed.claudeChildReferences : [];
    for (const row of legacy && !knownLegacy ? [] : relationshipRows) {
      const entry = record(row) ? withCurrentDispatch(row.entry) : undefined;
      if (record(row) && fileName(row.file) && childReferenceEntry(entry) && (!legacy || entry.parserVersion === 26)) {
        loaded.claudeChildReferences.set(normalizeFsPath(row.file), entry);
      }
    }
    const admitted = loaded.claudeChildReferences;
    loaded.claudeChildReferences = new Map(
      limitCodexDispatchCursors(admitted).slice(0, MAX_CLAUDE_CHILD_REFERENCE_FILES),
    );
    loaded.reuse.rejectedRelationships = relationshipRows.length - loaded.claudeChildReferences.size;
    loaded.reuse.acceptedRelationships = loaded.claudeChildReferences.size;
    // Imported rows reach the current file at the next checkpoint, even when no source grows.
    loaded.migrationPending =
      format !== 2 &&
      !!(
        (legacy && knownLegacy) ||
        (format === 1 && record(parsed.discovery)) ||
        loaded.commitRepositories?.length ||
        loaded.titles.size ||
        loaded.claudeChildReferences.size ||
        loaded.carriedNames.size ||
        loaded.codexMetas.size
      );
    const pending = parsed.discovery;
    if (
      !legacy &&
      loaded.reuse.rejectedRelationships === 0 &&
      Array.isArray(parsed.claudeChildReferences) &&
      retainedDiscoveryRelationships(admitted, loaded.claudeChildReferences) &&
      record(pending) &&
      compatibleDiscovery(
        pending as unknown as import('./progressiveworker').DiscoveryCheckpoint,
        CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
      ) &&
      validDiscoveryCheckpoint(pending)
    ) {
      loaded.discovery = pending;
      if (
        !loaded.discovery.completed.every((file) => {
          const entry = loaded.claudeChildReferences.get(normalizeFsPath(file));
          return entry?.complete === true || entry?.visitedEof === true;
        })
      )
        loaded.discovery = undefined;
      loaded.reuse.checkpoint = loaded.discovery ? 'reused' : 'invalid';
    }
    if (pending && !loaded.discovery) loaded.reuse.checkpoint = legacy ? 'incompatible' : 'invalid';
    return loaded;
  } catch (error) {
    return {
      ...empty(),
      reuse: { reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' },
    };
  }
}

// A missing row or unfinished cursor invalidates the scheduler that depended on it.
function retainedDiscoveryRelationships(
  before: ReadonlyMap<string, ClaudeChildReferenceCacheEntry>,
  after: ReadonlyMap<string, ClaudeChildReferenceCacheEntry>,
): boolean {
  for (const [file, entry] of before) {
    const retained = after.get(normalizeFsPath(file));
    if (!retained || !childReferenceEntry(retained)) return false;
    if (
      !entry.complete &&
      !entry.visitedEof &&
      ((entry.cursor && !retained.cursor) || (entry.claudeCursor && !retained.claudeCursor))
    )
      return false;
    if ((entry.complete && !retained.complete) || (entry.visitedEof && !retained.visitedEof)) return false;
  }
  return true;
}

export function saveDerivedCache(
  file: string,
  titles: Iterable<[string, DerivedTitleEntry]>,
  claudeChildReferences: Iterable<[string, ClaudeChildReferenceCacheEntry]> = [],
  carriedNames: Iterable<[string, CarriedName]> = [],
  replace: (temporary: string, target: string) => void = fs.renameSync,
  discovery?: import('./progressiveworker').DiscoveryCheckpoint,
  commitRepositories: Iterable<VerifiedCommitRepository> = [],
  agentOf: (file: string) => AgentKind | null = sourceAgentOf,
  links?: SavedDiscoveryLinks,
  // A later scan of the same file replaces an earlier one. A scan that `savedPromptScanOf` refuses replaces nothing.
  promptScans: Iterable<[string, HumanPromptScan]> = [],
  unsettledAdoptions: Iterable<[string, string]> = [],
  claudeOpenings?: SavedClaudeOpenings,
): void {
  const savedScans = new Map<string, HumanPromptScan>();
  for (const [scanFile, scan] of promptScans) {
    const saved = savedPromptScanOf(scan);
    if (saved) savedScans.set(scanFile, saved);
  }
  const unqualified = new Map<string, CarriedName>();
  const titleRows: StoredTitle[] = [];
  for (const [entryFile, entry] of titles) {
    const agent = agentOf(entryFile);
    // An entry without a qualified agent keeps only its name.
    if (agent === null) unqualified.set(entryFile, { label: entry.label, fullLabel: entry.fullLabel });
    else
      titleRows.push({
        file: entryFile,
        agent,
        entry: entry.agentRun === null ? { ...entry, agentRun: false } : entry,
      });
  }
  titleRows.sort((a, b) => a.file.localeCompare(b.file));
  const titled = new Set(titleRows.map((row) => row.file));
  const sourceEntries = new Map([...claudeChildReferences].map(([key, entry]) => [normalizeFsPath(key), entry]));
  const childRows = limitCodexDispatchCursors(sourceEntries)
    .filter(([, entry]) => entry.references.length <= MAX_CLAUDE_CHILD_REFERENCES_PER_FILE)
    .map(([entryFile, entry]) => ({ file: normalizeFsPath(entryFile), entry }))
    .sort(
      (a, b) =>
        Number(b.entry.claudeCursor !== undefined && b.entry.claudeCursor.offset < b.entry.claudeCursor.target) -
          Number(a.entry.claudeCursor !== undefined && a.entry.claudeCursor.offset < a.entry.claudeCursor.target) ||
        a.file.localeCompare(b.file),
    );
  const data: StoredCache = {
    commitRepositories: boundedCommitRepositories(commitRepositories),
    formatVersion: 2,
    metadataGenerations: METADATA_GENERATIONS,
    discovery:
      compatibleDiscovery(discovery, CLAUDE_CHILD_REFERENCE_PARSER_VERSION) &&
      retainedDiscoveryRelationships(
        sourceEntries,
        new Map(childRows.slice(0, MAX_CLAUDE_CHILD_REFERENCE_FILES).map((row) => [row.file, row.entry])),
      )
        ? discovery
        : undefined,
    titles: titleRows,
    claudeChildReferences: limitSavedDispatchFacts(childRows.slice(0, MAX_CLAUDE_CHILD_REFERENCE_FILES)),
    // Persists carried names until a title entry replaces them, including across restarts.
    unsettledAdoptions: [...unsettledAdoptions],
    carriedNames: [...carriedNames, ...unqualified]
      .filter(([entryFile, name]) => !titled.has(entryFile) && carriedName(name))
      .map(([entryFile, name]) => ({ file: entryFile, label: name.label, fullLabel: name.fullLabel }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    links: links && links.references.length + links.children.length <= MAX_SAVED_DISCOVERY_LINKS ? links : undefined,
    promptScans: {
      rulesVersion: PROMPT_SCAN_RULES_VERSION,
      scans: limitPromptScans(savedScans)
        .map(([scanFile, scan]) => ({ file: scanFile, found: scan.found, bytes: scan.bytes, ...scan.source! }))
        .sort((a, b) => a.file.localeCompare(b.file)),
    },
    claudeOpenings: claudeOpenings && {
      rulesVersion: CLAUDE_OPENINGS_RULES_VERSION,
      parents: storedClaudeOpeningRows(claudeOpenings.parents),
      children: storedClaudeOpeningRows(claudeOpenings.children),
    },
  };
  writeFileAtomically(file, JSON.stringify(data), replace);
}

// Changed parent files recreate discarded cursors. Unchanged finished sources retain their evidence.
// Evicts Codex cursors at EOF before unfinished scans, then complete entries and larger cursors.
export function limitCodexDispatchCursors(
  entries: Iterable<[string, ClaudeChildReferenceCacheEntry]>,
  byteLimit = MAX_CODEX_DISPATCH_CURSOR_BYTES,
): Array<[string, ClaudeChildReferenceCacheEntry]> {
  const rows = [...entries];
  const retainEvidence = (entry: ClaudeChildReferenceCacheEntry) => {
    const evidence = entry.claudeCursor?.evidence ?? entry.cursor?.evidence;
    const finished =
      !!evidence &&
      validRelationshipEvidence(evidence, evidence.offset) &&
      evidence.accepted !== null &&
      !evidence.validation &&
      evidence.offset === entry.size &&
      evidence.provisional.size === entry.size &&
      evidence.provisional.mtimeMs === entry.mtimeMs &&
      evidence.provisional.dev === entry.dev &&
      evidence.provisional.ino === entry.ino;
    return {
      ...entry,
      evidence: finished ? evidence : undefined,
      complete: finished && entry.complete === true,
      relationshipComplete: finished && entry.relationshipComplete === true,
      visitedEof: finished && entry.visitedEof === true,
    };
  };
  // Unfinished Claude cursors retain unmatched launches that cannot be recreated at their saved offset.
  // Keep them above the soft budget. The scheduler protects one large pending source.
  let claudeBytes = rows.reduce(
    (sum, [, entry]) =>
      sum +
      (entry.claudeCursor ? Buffer.byteLength(JSON.stringify(entry.claudeCursor)) : 0) +
      (entry.evidence ? Buffer.byteLength(JSON.stringify(entry.evidence)) : 0),
    0,
  );
  for (let index = 0; index < rows.length && claudeBytes > byteLimit; index++) {
    const [file, entry] = rows[index];
    if (
      !entry.claudeCursor ||
      entry.claudeCursor.offset < entry.claudeCursor.target ||
      (entry.claudeCursor.fragmentBytes && !entry.claudeCursor.terminalApplied) ||
      entry.claudeCursor.evidence?.validation
    )
      continue;
    claudeBytes -= Buffer.byteLength(JSON.stringify(entry.claudeCursor));
    const retained = { ...retainEvidence(entry), claudeCursor: undefined };
    claudeBytes += retained.evidence ? Buffer.byteLength(JSON.stringify(retained.evidence)) : 0;
    rows[index] = [file, retained];
  }
  const sized = rows.flatMap(([file, entry], index) =>
    entry.source === 'codex' && entry.cursor
      ? [
          {
            file,
            index,
            bytes: Buffer.byteLength(JSON.stringify(entry.cursor)),
            visitedEof: entry.visitedEof === true,
            complete: entry.complete === true,
          },
        ]
      : [],
  );
  let total = claudeBytes + sized.reduce((sum, row) => sum + row.bytes, 0);
  for (const row of sized.sort(
    (a, b) =>
      Number(b.visitedEof) - Number(a.visitedEof) ||
      Number(b.complete) - Number(a.complete) ||
      b.bytes - a.bytes ||
      a.file.localeCompare(b.file),
  )) {
    if (total <= byteLimit) break;
    const [file, entry] = rows[row.index];
    const retained = { ...retainEvidence(entry), cursor: undefined };
    rows[row.index] = [file, retained];
    total -= row.bytes - (retained.evidence ? Buffer.byteLength(JSON.stringify(retained.evidence)) : 0);
  }
  return rows;
}
