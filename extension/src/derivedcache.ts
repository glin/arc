import * as fs from 'node:fs';
import { writeFileAtomically } from './atomicfile';
import { storedCodexMetas } from './codexopenings';
import {
  replacedTranscript,
  resolveSessionName,
  storedSessionName,
  type SessionName,
  type SessionNameSource,
} from './sessionnames';
import type { CodexSessionMeta } from './codex';
import {
  agentRunOfScan,
  isCacheLifetime,
  MAX_CLAUDE_CHILD_REFERENCES_PER_FILE,
  normalizeFsPath,
  sameSessionRevision,
  sessionOutcomeOf,
  sessionStatFactsOf,
  type AgentRunScan,
  type ClaudeChildSessionReference,
  type FileRevision,
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
  mtimeMs: number;
  size: number;
  label: string;
  fullLabel: string;
  activityMs: number | null;
  agentRun: boolean;
  outcome: TurnOutcome | null;
  // The background commands the tail read found when it held no typed prompt. `outcome` can
  // still hold the lifetime outcome of the same turn.
  backgroundCommands?: BackgroundCommand[];
  stats: SessionStatFacts | null;
  // The facts an earlier read of this session found. A card draws these while the session's
  // own read finds none.
  heldStats?: SessionStatFacts;
  expandedStatsRead?: boolean;
  metadataWindow?: { whole: boolean; windowBytes: number; exhausted?: boolean };
  sourceIdentity?: { dev: number; ino: number };
  starts?: TurnStarts;
  foldedLabel?: string;
  agentRunScan?: AgentRunScan;
  // Where a Claude `label` came from. The held name keeps its source so a later read that
  // saw a lower-ranked source cannot replace it.
  nameSource?: SessionNameSource;
  // The byte offset of the record a Claude name came from. Within one rank the later
  // record wins.
  nameAt?: number;
  // The fingerprint of the transcript's first record, which tells a replaced file from a
  // grown one.
  headKey?: string;
}

// How much of a Claude transcript the metadata read takes. `agentRunIn` answers from that
// window only when it reaches the start of the file, so a larger top-level session gets its
// agent-run answer from the whole-file scan the rail enrichment runs. A child transcript
// never needs that scan: see `needsAgentRunScan`.
export const CLAUDE_METADATA_TAIL_BYTES = 256 * 1024;

// Whether a session needs the whole-file agent-run scan beside its turn starts. A child
// transcript never does: the parent's `Agent` call that started it is a positive fact the
// scan cannot improve on, and every record in a child transcript is a sidechain record the
// scan would count as nobody's prompt.
export function needsAgentRunScan(session: { agent: string; size: number; childTranscript?: boolean }): boolean {
  return session.agent === 'claude' && session.size > CLAUDE_METADATA_TAIL_BYTES && session.childTranscript !== true;
}

// The bytes the next agent-run scan reads. A person answer reads none, and a file that
// shrank is read again from the start.
export function agentRunScanUnread(
  session: { agent: string; size: number; childTranscript?: boolean },
  scan: AgentRunScan | undefined,
): number {
  if (!needsAgentRunScan(session) || scan?.person) {
    return 0;
  }
  return session.size - (scan && scan.bytes <= session.size ? scan.bytes : 0);
}

// A new metadata entry for a changed revision keeps the scan cursor of the entry it replaces,
// so the next scan reads only what was appended. The agent-run answer stays the metadata
// reading until that scan runs, with two exceptions, both guarded on the file only growing:
// no smaller size, and `replacedTranscript` finds no other head.
//
// The metadata read answers nothing for a file past its window, and that reads as a person.
// So a run that files under Run by agents would move to Today on each append and back once
// a scan caught up. An entry with no scan yet, answered `agentRun: true` from a whole-file
// tail read below the window, keeps that answer forward once the file crosses the window,
// until the first scan runs and replaces it. That carry needs `session` to name the file a
// Claude session past `CLAUDE_METADATA_TAIL_BYTES`: a caller with no session, or a Codex
// session, or a Claude session that stayed inside the window, never gets it, so a grown
// entry's own correct tail read is never overwritten by a stale `agentRun: true`.
//
// An entry with a scan decides its carried answer from the scan alone, never from the
// previous entry's own `agentRun` field. A scan result that lands through
// `withAgentRunScanProgress` moves the cursor forward but leaves `agentRun` at whatever the
// entry already held, so a carry that read `agentRun` there would drop a run answer the scan
// itself already found. A scan that found a person is sticky and never carries a run answer,
// whatever `agentRun` says.
//
// A session that no longer needs the scan drops any cursor carried from before. A child
// transcript is the case that matters: its metadata read already answers the agent-run
// question on its own, and a scan cursor left over from a stale cached entry must not come
// back and overwrite that answer.
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

// Whether a stat list says how full the session's context window is.
//
// Two reads answer no. A metadata read of a tail a running turn has filled with answers finds
// no typed prompt, so it yields no facts at all. A read taken just after a turn boundary finds
// the new turn, which carries no usage record until its first response lands.
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
  if (entry.heldStats === undefined) {
    return entry;
  }
  const out = { ...entry };
  delete out.heldStats;
  return out;
}

// The facts a new entry carries over from the entry it replaces.
//
// The rail chip drawn from a session's facts would leave the card between two appends and come
// back on the next one. The last facts the session had stand in over that gap, and they are
// held apart from `stats`, which stays as the read left it, because an empty `stats` is what
// asks for the whole-file read that finds the real facts.
//
// A context figure, a complete negative read, shrinkage, or detected replacement releases held facts.
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
  const held = statsHaveContext(previous.stats) ? (previous.stats ?? undefined) : previous.heldStats;
  return held ? { ...carried, heldStats: held } : released(carried);
}

// The Claude session name a new entry keeps from the entry it replaces. The rule is
// `resolveSessionName`. A file that shrank, or whose first record changed, is another
// transcript, and its own read answers.
function carrySessionName(previous: DerivedTitleEntry | undefined, next: DerivedTitleEntry): DerivedTitleEntry {
  const held = storedSessionName(previous);
  if (!previous || !held || replacedTranscript(previous, next)) {
    return next;
  }
  const name = resolveSessionName(held, storedSessionName(next));
  return name ? withSessionName(next, name) : next;
}

// An entry that holds a Claude session name, with the label search folds kept in step.
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

// The session facts a card draws: this read's own, or the last ones this session had.
export function derivedTitleStats(entry: DerivedTitleEntry): SessionStatFacts | null {
  if (entry.heldStats && !statsHaveContext(entry.stats)) {
    return entry.heldStats;
  }
  return entry.stats;
}

// Cache metadata keeps the held request through an incomplete running turn. A newer failure
// or compaction changes that request's cache state, so it takes precedence over held facts.
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

// One figure for each session, held against the facts object it was derived from. A read
// derives the figure again only for a session whose facts object changed, or whose held figure
// `current` rejects. Every other session keeps its held figure. `derive` must read only the
// facts and values that never change. An input that changes outside the facts, such as the
// clock, must enter through `current`, which rejects a held figure that input has made stale.
// The caller must replace changed facts with a new object, because a figure derived from facts
// edited in place stays stale. The record keeps its identity while no session moves, joins or
// leaves, and a session that leaves the list drops its figure.
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
    // Every kept entry came from the held map, so equal sizes mean the same sessions.
    if (moved || next.size !== this.held.size) {
      this.value = Object.fromEntries([...next].map(([sessionId, entry]) => [sessionId, entry.value]));
    }
    this.held = next;
    return this.value;
  }
}

// The entry after rail enrichment. A scan answers whether the session is an agent run and
// sets `agentRun` from it. With no scan, the entry keeps whatever `agentRun` it already
// holds, stale or not: `agentRunAnswer` in turnrail.ts answers true for a child transcript
// whatever this entry holds, so a stale `false` here never reaches the rail.
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

// The scan to apply during rail enrichment. A session that no longer needs the scan gets
// none, so a cursor held from before a size change or a child-transcript flag never
// overrides the metadata reading.
export function scanForRailEnrichment(
  session: { agent: string; size: number; childTranscript?: boolean },
  scan: AgentRunScan | undefined,
): AgentRunScan | undefined {
  return needsAgentRunScan(session) ? scan : undefined;
}

// Whether a file only grew between two readings: the same file, and no shorter.
export function onlyGrew(before: FileRevision | null, after: FileRevision | null): boolean {
  return !!before && !!after && before.dev === after.dev && before.ino === after.ino && after.size >= before.size;
}

// The agent-run scan a stale worker read still returns. A file that only grew while the scan
// ran still holds every byte the scan read, so the cursor stays good. Any other change drops it.
export function scanKeptThroughGrowth(
  value: { kind: string; agentRunScan?: AgentRunScan },
  before: FileRevision | null,
  after: FileRevision | null,
): AgentRunScan | undefined {
  return value.kind === 'starts' && onlyGrew(before, after) ? value.agentRunScan : undefined;
}

// The entry after a scan whose result arrived stale. Only the scan cursor changes, and only
// forward, so a result for an older revision never replaces the starts or the agent-run answer
// of a newer entry, and never moves a newer cursor back. A person answer is the one exception:
// it also sets `agentRun: false`, because a person answer is final and must not leave a stale
// carried run beside it until the next scan. Null when the entry keeps its own.
export function withAgentRunScanProgress(entry: DerivedTitleEntry, scan: AgentRunScan): DerivedTitleEntry | null {
  const held = entry.agentRunScan;
  if (scan.bytes > entry.size || (held && (held.person || held.bytes >= scan.bytes))) {
    return null;
  }
  return { ...entry, agentRunScan: scan, ...(scan.person ? { agentRun: false } : {}) };
}

export interface DerivedCache {
  reuse?: { reason: string; storedGeneration?: unknown; rejectedRelationships?: number };
  discovery?: import('./progressiveworker').DiscoveryCheckpoint;
  // The Codex opening rows a workspace file written before the shared `codex-openings.json`
  // holds. They seed that file once, when it is missing. A save writes none.
  codexMetas: Map<string, CodexSessionMeta>;
  titles: Map<string, DerivedTitleEntry>;
  claudeChildReferences: Map<string, ClaudeChildReferenceCacheEntry>;
  // The last name each session had before a `VERSION` bump dropped its entry. The rail draws
  // it until a metadata read of that session stores a new entry.
  carriedNames: Map<string, CarriedName>;
}

export interface CarriedName {
  label: string;
  fullLabel: string;
}

export const CLAUDE_CHILD_REFERENCE_PARSER_VERSION = 23;
export const MAX_CLAUDE_CHILD_REFERENCE_FILES = 10_000;
export const MAX_CODEX_DISPATCH_CURSOR_BYTES = 64 * 1024 * 1024;
export { MAX_CLAUDE_CHILD_REFERENCES_PER_FILE };

export interface ClaudeChildReferenceCacheEntry {
  sourceGeneration?: number;
  sequence?: number;
  parserVersion: number;
  source?: 'claude' | 'codex';
  complete?: boolean;
  visitedEof?: boolean;
  cursor?: import('./codex').CodexDispatchCursor;
  claudeCursor?: import('./transcript').ClaudeRelationshipCursor;
  resetReason?: string;
  pendingReferences?: ClaudeChildSessionReference[];
  relationshipComplete?: boolean;
  appliedCut?: number;
  validatedRevision?: import('./transcript').FileRevision;
  mtimeMs: number;
  size: number;
  dev: number;
  ino: number;
  sessionId: string;
  childTranscript: boolean;
  references: ClaudeChildSessionReference[];
}

interface StoredTitle {
  file: string;
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
  discovery?: import('./progressiveworker').DiscoveryCheckpoint;
  version: number;
  titles: StoredTitle[];
  claudeChildReferences: StoredChildReferences[];
  carriedNames: StoredCarriedName[];
}

// The shape and the meaning of everything stored below. A file whose version does not match
// this one is dropped at load, and the panel derives all of it again. Only the name of each
// session survives, as a carried name the rail draws until a read replaces it.
//
// Bump it for either kind of change. A field added to or taken out of a stored entry is the
// obvious kind. The other is a fact that keeps its name and its type while the rule behind
// it changes. That one is easy to miss. The stored value stays valid, so nothing rejects it,
// and a session whose file has stopped growing keeps the old answer for good.
//
// `agentRun` is the example. `transcript.ts` guesses it for Claude and `codex.ts` for Codex.
// A change to either guess is invisible from this file.
//
// Weigh the bump against the rebuild. The first metadata pass reads at most
// `INITIAL_RAIL_READ_BYTES`, so a large workspace rebuilds over many refreshes, not in one
// pass. Until its own read arrives, a session draws its carried name, and its card shows the
// values the file itself gives in place of the dropped derived facts. A rule change that
// affects a few recognizable entries can drop only those entries at load instead of bumping
// the version.
//
// Codex opening records are not under this version. They carry `CODEX_META_VERSION` from
// `codexopenings.ts`, and a bump here keeps them.
export const VERSION = 44;

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
    entry = { ...entry, metadataWindow: { ...entry.metadataWindow, exhausted: false } };
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

export function derivedTitleNeedsRailFacts(entry: DerivedTitleEntry): boolean {
  return (
    (unresolvedMetadata(entry) && entry.expandedStatsRead !== true && entry.metadataWindow?.exhausted !== true) ||
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
    entry.metadataWindow.exhausted !== true;
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

// A name a stored row can carry: a nonempty label and a full label, both text. Every other
// field of the row is left behind.
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
    (!Object.prototype.hasOwnProperty.call(value, 'backgroundCommands') ||
      (Array.isArray(value.backgroundCommands) && value.backgroundCommands.every(backgroundCommand)))
  );
}

function turnStarts(value: unknown): value is TurnStarts {
  return record(value) && Array.isArray(value.starts) && value.starts.every(finite) && typeof value.whole === 'boolean';
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function contextRequest(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      finite(value.at) &&
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
    (value.expandedStatsRead === undefined || typeof value.expandedStatsRead === 'boolean') &&
    (value.metadataWindow === undefined ||
      (record(value.metadataWindow) &&
        typeof value.metadataWindow.whole === 'boolean' &&
        nonNegative(value.metadataWindow.windowBytes) &&
        (value.metadataWindow.exhausted === undefined || typeof value.metadataWindow.exhausted === 'boolean'))) &&
    (value.sourceIdentity === undefined ||
      (record(value.sourceIdentity) && finite(value.sourceIdentity.dev) && finite(value.sourceIdentity.ino))) &&
    (value.starts === undefined || turnStarts(value.starts)) &&
    (value.foldedLabel === undefined || text(value.foldedLabel)) &&
    (value.agentRunScan === undefined || agentRunScan(value.agentRunScan)) &&
    (value.nameSource === undefined ||
      value.nameSource === 'custom' ||
      value.nameSource === 'generated' ||
      value.nameSource === 'prompt') &&
    (value.nameAt === undefined || (typeof value.nameAt === 'number' && Number.isFinite(value.nameAt))) &&
    (value.headKey === undefined || typeof value.headKey === 'string')
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
  // A dispatch reference stored before references carried `owned` fails here, so its parent
  // is read again once. No receipt could say owned then, because the reader rejected the key.
  return (
    value.kind === 'dispatch' &&
    (value.agent === 'claude' || value.agent === 'codex') &&
    (value.agent !== 'codex' || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.sessionId)) &&
    value.file === null &&
    (value.name === null || typeof value.name === 'string') &&
    typeof value.owned === 'boolean'
  );
}

function codexDispatchCursor(value: unknown, parentSessionId: string, size: number): boolean {
  if (!record(value)) return false;
  return (
    nonNegative(value.offset) &&
    Number.isInteger(value.offset) &&
    value.offset <= size &&
    value.size === size &&
    nonNegative(value.mtimeMs) &&
    typeof value.fragment === 'string' &&
    value.fragment.length <= 6 * 1024 * 1024 &&
    (value.fragmentStart === null ||
      (nonNegative(value.fragmentStart) &&
        Number.isInteger(value.fragmentStart) &&
        value.fragmentStart <= value.offset)) &&
    typeof value.skipLongLine === 'boolean' &&
    typeof value.head === 'string' &&
    /^[0-9a-f]{64}$/.test(value.head) &&
    typeof value.anchor === 'string' &&
    /^[0-9a-f]{64}$/.test(value.anchor) &&
    nonNegative(value.dev) &&
    nonNegative(value.ino) &&
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
    (value.validatedRevision === undefined ||
      (record(value.validatedRevision) &&
        [
          value.validatedRevision.size,
          value.validatedRevision.mtimeMs,
          value.validatedRevision.dev,
          value.validatedRevision.ino,
        ].every(nonNegative))) &&
    (value.pendingReferences === undefined ||
      (Array.isArray(value.pendingReferences) &&
        value.pendingReferences.length <= MAX_CLAUDE_CHILD_REFERENCES_PER_FILE &&
        value.pendingReferences.every((reference) => childReference(reference, sessionId)))) &&
    (value.visitedEof === undefined || typeof value.visitedEof === 'boolean') &&
    (value.claudeCursor === undefined || claudeRelationshipCursor(value.claudeCursor, sessionId)) &&
    (value.source !== 'codex' ||
      (typeof value.complete === 'boolean' &&
        (value.cursor === undefined || codexDispatchCursor(value.cursor, sessionId, value.size as number)))) &&
    nonNegative(value.mtimeMs) &&
    nonNegative(value.size) &&
    nonNegative(value.dev) &&
    nonNegative(value.ino) &&
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
      value.revision.dev,
      value.revision.ino,
    ].every(nonNegative) &&
    (value.applied as number) <= (value.offset as number) &&
    (value.offset as number) <= (value.target as number) &&
    (value.target as number) <= (value.revision.size as number) &&
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

export function loadDerivedCache(file: string): DerivedCache {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const loaded = empty();
    loaded.reuse = { reason: 'reused' };
    // Codex rows answer to their own version, so a `VERSION` bump keeps them.
    loaded.codexMetas = storedCodexMetas(parsed);
    if (!record(parsed)) {
      loaded.reuse = { reason: 'invalid-format' };
      return loaded;
    }
    // A name carried through an earlier bump and not read since stays carried. A title row of
    // an older version overrides it, because that row was stored later.
    carryNames(loaded.carriedNames, parsed.carriedNames, (row) => row);
    if (parsed.version !== VERSION) {
      loaded.reuse = { reason: 'generation-mismatch', storedGeneration: parsed.version };
      carryNames(loaded.carriedNames, parsed.titles, (row) => row.entry);
      return loaded;
    }
    if (
      !Array.isArray(parsed.titles) ||
      (parsed.claudeChildReferences !== undefined && !Array.isArray(parsed.claudeChildReferences))
    ) {
      loaded.reuse = { reason: 'invalid-rows' };
      return loaded;
    }
    for (const row of parsed.titles) {
      if (record(row) && fileName(row.file) && titleEntry(row.entry)) {
        loaded.titles.set(row.file, row.entry);
        loaded.carriedNames.delete(row.file);
      }
    }
    for (const row of parsed.claudeChildReferences ?? []) {
      if (record(row) && fileName(row.file) && childReferenceEntry(row.entry)) {
        loaded.claudeChildReferences.set(normalizeFsPath(row.file), row.entry);
      }
    }
    loaded.reuse.rejectedRelationships =
      (parsed.claudeChildReferences?.length ?? 0) - loaded.claudeChildReferences.size;
    loaded.claudeChildReferences = new Map(limitCodexDispatchCursors(loaded.claudeChildReferences));
    const pending = parsed.discovery;
    if (
      record(pending) &&
      (pending.epoch === undefined || nonEmptyText(pending.epoch)) &&
      (pending.parserVersion === undefined || pending.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION) &&
      (pending.spendSources === undefined ||
        (record(pending.spendSources) &&
          Array.isArray(pending.spendSources.claude) &&
          pending.spendSources.claude.every(
            (source: unknown) =>
              record(source) &&
              fileName(source.file) &&
              nonEmptyText(source.sessionId) &&
              (source.primary === undefined || typeof source.primary === 'boolean') &&
              (source.nativeParentFile === undefined || fileName(source.nativeParentFile)) &&
              (source.dispatchedFrom === undefined || nonEmptyText(source.dispatchedFrom)),
          ) &&
          Array.isArray(pending.spendSources.codex) &&
          pending.spendSources.codex.every((source: unknown) => record(source) && fileName(source.file)) &&
          Array.isArray(pending.spendSources.children) &&
          pending.spendSources.children.every(
            (child: unknown) =>
              record(child) &&
              fileName(child.file) &&
              nonEmptyText(child.threadId) &&
              (child.parentThreadId === null || nonEmptyText(child.parentThreadId)) &&
              (child.agentPath === null || typeof child.agentPath === 'string') &&
              (child.openedAt === null || nonNegative(child.openedAt)) &&
              (child.startedAt === null || nonNegative(child.startedAt)) &&
              (child.threadSource === null || typeof child.threadSource === 'string') &&
              typeof child.backgroundReview === 'boolean',
          ))) &&
      Array.isArray(pending.parents) &&
      Array.isArray(pending.catalog) &&
      Array.isArray(pending.repositoryRoots) &&
      pending.repositoryRoots.every(fileName) &&
      Array.isArray(pending.completed) &&
      pending.completed.every(fileName) &&
      nonNegative(pending.position) &&
      nonNegative(pending.sequence) &&
      (pending.protectedFile === undefined || fileName(pending.protectedFile)) &&
      [...pending.parents, ...pending.catalog].every(
        (row: unknown) =>
          record(row) &&
          fileName(row.file) &&
          nonEmptyText(row.sessionId) &&
          (row.agent === 'claude' || row.agent === 'codex') &&
          nonNegative(row.size) &&
          nonNegative(row.mtimeMs),
      )
    ) {
      loaded.discovery = pending as unknown as import('./progressiveworker').DiscoveryCheckpoint;
      loaded.discovery.completed = loaded.discovery.completed.filter(
        (file) => loaded.claudeChildReferences.get(file)?.complete === true,
      );
    }
    return loaded;
  } catch (error) {
    return {
      ...empty(),
      reuse: { reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' },
    };
  }
}

export function saveDerivedCache(
  file: string,
  titles: Iterable<[string, DerivedTitleEntry]>,
  claudeChildReferences: Iterable<[string, ClaudeChildReferenceCacheEntry]> = [],
  carriedNames: Iterable<[string, CarriedName]> = [],
  replace: (temporary: string, target: string) => void = fs.renameSync,
  discovery?: import('./progressiveworker').DiscoveryCheckpoint,
): void {
  const titleRows = [...titles]
    .map(([entryFile, entry]) => ({ file: entryFile, entry }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const titled = new Set(titleRows.map((row) => row.file));
  const childRows = limitCodexDispatchCursors(claudeChildReferences)
    .filter(([, entry]) => entry.references.length <= MAX_CLAUDE_CHILD_REFERENCES_PER_FILE)
    .map(([entryFile, entry]) => ({ file: normalizeFsPath(entryFile), entry }))
    .sort(
      (a, b) =>
        Number(b.entry.claudeCursor !== undefined && b.entry.claudeCursor.offset < b.entry.claudeCursor.target) -
          Number(a.entry.claudeCursor !== undefined && a.entry.claudeCursor.offset < a.entry.claudeCursor.target) ||
        a.file.localeCompare(b.file),
    );
  const data: StoredCache = {
    version: VERSION,
    discovery,
    titles: titleRows,
    claudeChildReferences: childRows.slice(0, MAX_CLAUDE_CHILD_REFERENCE_FILES),
    // A carried name waits in the file until a read of its session stores a title, so a
    // restart before that read still draws it.
    carriedNames: [...carriedNames]
      .filter(([entryFile]) => !titled.has(entryFile))
      .map(([entryFile, name]) => ({ file: entryFile, label: name.label, fullLabel: name.fullLabel }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  };
  writeFileAtomically(file, JSON.stringify(data), replace);
}

// A cursor is rebuildable from its parent file. Keep cursors that have not reached EOF before
// cursors waiting for an append, so retention does not restart an unfinished scan.
export function limitCodexDispatchCursors(
  entries: Iterable<[string, ClaudeChildReferenceCacheEntry]>,
  byteLimit = MAX_CODEX_DISPATCH_CURSOR_BYTES,
): Array<[string, ClaudeChildReferenceCacheEntry]> {
  const rows = [...entries];
  // Pending Claude state contains unmatched launches and cannot be recreated at its offset.
  // Keep it even above the soft target. The scheduler protects one large pending source.
  let claudeBytes = rows.reduce(
    (sum, [, entry]) => sum + (entry.claudeCursor ? Buffer.byteLength(JSON.stringify(entry.claudeCursor)) : 0),
    0,
  );
  for (let index = 0; index < rows.length && claudeBytes > byteLimit; index++) {
    const [file, entry] = rows[index];
    if (
      !entry.claudeCursor ||
      entry.claudeCursor.offset < entry.claudeCursor.target ||
      (entry.claudeCursor.fragmentBytes && !entry.claudeCursor.terminalApplied)
    )
      continue;
    claudeBytes -= Buffer.byteLength(JSON.stringify(entry.claudeCursor));
    rows[index] = [file, { ...entry, claudeCursor: undefined }];
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
    rows[row.index] = [file, { ...entry, cursor: undefined }];
    total -= row.bytes;
  }
  return rows;
}
