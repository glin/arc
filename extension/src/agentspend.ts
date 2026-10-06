import fs from 'node:fs';
import { meterRead } from './readmeter';
import { StringDecoder } from 'node:string_decoder';
import type { ChildArtifacts } from './childartifacts';
import type { CommitIntent, TurnCommit, TurnUsage, TurnUsagePart, UsageContextBand, UsageCounts } from './transcript';

// One agent's billed usage under one model. Model changes retain separate counts for each model.
export interface ModelSpend {
  model: string | null;
  provider?: string | null;
  contextWindow?: number | null;
  // Some provider-owned results record the dollar amount already calculated for this
  // model. Keep its basis beside it so a list-price estimate is never presented as an
  // invoice amount.
  recordedCost?: number;
  costBasis?: string;
  // A model result can report cache creation without saying which cache lifetime was
  // used. Those tokens still belong in the volume, but cannot support a category price.
  unclassifiedCacheWrite?: number;
  usageParts?: TurnUsagePart[];
  usage: TurnUsage;
}

export interface AgentSpend {
  models: ModelSpend[];
  // The model the transcript's own requests used most, by token count. Nested subagents never
  // count toward it, although `models` includes them. Only the Claude reader sets it, because a
  // Codex spawn call already names the exact model its child runs.
  ownModel?: string | null;
  effort: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  toolUses?: number;
  // Whether the child transcript exists and is readable. An empty readable transcript establishes zero usage. A missing file does not.
  found: boolean;
  // The figures include nested subagents. True when metadata, a readable transcript, or a completed final turn is missing for a descendant.
  // Partial figures are a lower bound.
  partial: boolean;
  // A stopped dispatched session whose last turn never reached a final answer.
  unfinished?: boolean;
  // True when this transcript recorded a billed request without usable token counts.
  usageIncomplete?: boolean;
  // Commits read from the child's own turns. They stay owned by the child row even when
  // the parent card includes them in its turn total.
  commits?: TurnCommit[];
  commitIntents?: CommitIntent[];
  // The child's distinct files and commits. Present only when the child file was read.
  artifacts?: ChildArtifacts;
  // True when a session's own transcript holds a sign that only a person leaves, from
  // `personSpokeIn` in transcript.ts. Absent otherwise, and on a subagent's transcript.
  person?: boolean;
}

// What a parent transcript recorded well enough to identify one child transcript.
export interface AgentSpendRef {
  id: string | null;
  name: string;
  path: string | null;
  status: string;
  toolUseId?: string;
}

export type AgentSpendLookup = (agent: AgentSpendRef) => AgentSpend;

export type AgentSessionTargetLookup = (agent: AgentSpendRef) => string | null;

export function emptyUsage(): TurnUsage {
  return {
    requests: 0,
    input: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
  };
}

function addUsageCounts(into: UsageCounts, add: UsageCounts): void {
  into.requests = (into.requests ?? 0) + (add.requests ?? 0);
  into.input += add.input;
  into.cacheWrite1h += add.cacheWrite1h;
  into.cacheWrite5m += add.cacheWrite5m;
  into.cacheWrite30m = (into.cacheWrite30m ?? 0) + (add.cacheWrite30m ?? 0);
  into.cacheRead += add.cacheRead;
  into.output += add.output;
  into.thinking += add.thinking;
}

export function addUsage(into: TurnUsage, add: TurnUsage, contextBand: UsageContextBand | null = null): void {
  addUsageCounts(into, add);
  if (contextBand) {
    const held = into.byContextBand?.[contextBand] ?? emptyUsage();
    addUsageCounts(held, add);
    (into.byContextBand ??= {})[contextBand] = held;
    return;
  }
  for (const band of ['short', 'long'] as const) {
    const bandUsage = add.byContextBand?.[band];
    if (!bandUsage) {
      continue;
    }
    const held = into.byContextBand?.[band] ?? emptyUsage();
    addUsageCounts(held, bandUsage);
    (into.byContextBand ??= {})[band] = held;
  }
}

export function usageTokens(usage: TurnUsage): number {
  return (
    usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead + usage.output
  );
}

export function spendTokens(spend: readonly ModelSpend[]): number {
  return spend.reduce((total, part) => total + usageTokens(part.usage) + (part.unclassifiedCacheWrite ?? 0), 0);
}

export function agentSpendIsOpen(status: string): boolean {
  return status === 'running' || status === 'async_launched' || status === 'launched';
}

// Add one request to the bucket for the model that served it. A missing model keeps its own
// bucket, so the caller can report that part as unpriced without hiding the parts it can price.
export function addModelUsage(
  byModel: Map<string | null, TurnUsage>,
  model: string | null,
  usage: TurnUsage,
  contextBand: UsageContextBand | null = null,
): void {
  const held = byModel.get(model) ?? emptyUsage();
  addUsage(held, usage, contextBand);
  byModel.set(model, held);
}

// The known model with the largest token count. Usage that names no model never answers.
export function heaviestModel(parts: readonly ModelSpend[]): string | null {
  let heaviest: ModelSpend | null = null;
  for (const part of parts) {
    if (part.model && (!heaviest || usageTokens(part.usage) > usageTokens(heaviest.usage))) {
      heaviest = part;
    }
  }
  return heaviest?.model ?? null;
}

export function modelSpends(byModel: Map<string | null, TurnUsage>, provider: string | null = null): ModelSpend[] {
  return [...byModel]
    .filter(([, usage]) => usageTokens(usage) > 0)
    .map(([model, usage]) => ({
      model,
      ...(provider ? { provider } : {}),
      usage,
    }));
}

// How long the shortest revision band of a running child lasts. The parent card repaints for a
// running child's cost at most once a band, however often the child writes.
export const OPEN_SPEND_BAND_MS = 5_000;

// A running-child read covers its transcript and nested transcripts.
// The band doubles until its duration allows these bytes at about 1 MB per second.
export const OPEN_SPEND_BYTES_PER_MS = 1_000;

// The band length for a child whose figure reads this many bytes.
export function openSpendBandMs(bytes: number): number {
  let band = OPEN_SPEND_BAND_MS;
  while (band * OPEN_SPEND_BYTES_PER_MS < bytes) {
    band *= 2;
  }
  return band;
}

// Groups recent writes by their newest modification time and total file size.
// Each version line ends with `size:mtime`. After a full quiet band, the caller uses the exact version.
// A version with no valid file size and time returns `none`.
export function openSpendBand(version: string, now: number): string | null {
  let newest = -Infinity;
  let bytes = 0;
  for (const line of version.split('\n')) {
    const fields = line.split(':');
    const written = Number(fields[fields.length - 1]);
    const size = Number(fields[fields.length - 2]);
    if (fields.length < 2 || !Number.isFinite(written) || !Number.isFinite(size)) {
      continue;
    }
    newest = Math.max(newest, written);
    bytes += size;
  }
  if (!Number.isFinite(newest)) {
    return 'none';
  }
  const bandMs = openSpendBandMs(bytes);
  return now - newest > bandMs ? null : `${bandMs}:${Math.floor(newest / bandMs)}`;
}

// Recent descendant writes use the same band after the direct child finishes.
export function childSpendBand(status: string, version: string, now: number): string | null {
  return agentSpendIsOpen(status) ||
    (version.includes('codex-aggregate') && version.split('\n').some((line) => line.startsWith('[')))
    ? openSpendBand(version, now)
    : null;
}

export function childSpendRevisionKey(status: string, version: string, now: number): string {
  const band = childSpendBand(status, version, now);
  if (band === null) return version;
  const relationships = version
    .split('\n')
    .filter((line) => line.startsWith('[') || line.startsWith('source:'))
    .join('\n');
  return `open:${band}\n${relationships}`;
}

// Reads cached child usage for a parent card. Closed children refresh when their revision changes.
// Recent writes share a band and receive one final refresh after that band ends.
// Open children omit files, commits, and run details.
// The `versioned` flag includes the aggregate revision in the parse key.
// The `now` value must match the caller's render clock.
export function readChildSpend(
  cache: AgentSpendCache,
  file: string,
  status: string,
  version: string,
  load: (file: string) => AgentSpend,
  parseKey: string,
  versioned: boolean,
  now: number,
): AgentSpend {
  const open = agentSpendIsOpen(status);
  const band = childSpendBand(status, version, now);
  const key = versioned ? `${parseKey}\n${band === null ? version : 'open'}` : parseKey;
  const spend = cache.read(file, load, key, band ?? undefined, version.split('\n').includes('codex-aggregate'));
  if (!open) {
    return spend;
  }
  return {
    models: spend.models,
    ...(spend.ownModel ? { ownModel: spend.ownModel } : {}),
    found: spend.found,
    partial: spend.partial,
    effort: spend.effort,
    ...(spend.usageIncomplete ? { usageIncomplete: true } : {}),
  };
}

export function spendFileVersion(file: string): string {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : 'not-file';
  } catch {
    return 'missing';
  }
}

// Reads UTF-8 lines without retaining the full transcript. One unfinished line can span several read chunks.
// A visitor returning exactly true stops newline-delimited scanning and returns false.
// The final unterminated line is visited after EOF. Its visitor result does not change true completion.
export function scanLines(file: string, visit: (line: string) => unknown): boolean {
  let fd = -1;
  let readWholeFile = false;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let held: string[] = [];
    let stopped = false;
    const emit = (tail: string): boolean => {
      const line = held.length ? held.join('') + tail : tail;
      held = [];
      return visit(line.endsWith('\r') ? line.slice(0, -1) : line) === true;
    };
    while (!stopped) {
      const read = meterRead(file, fs.readSync(fd, chunk, 0, chunk.length, null));
      if (read === 0) {
        break;
      }
      const decoded = decoder.write(chunk.subarray(0, read));
      let start = 0;
      for (let end = decoded.indexOf('\n'); end >= 0 && !stopped; end = decoded.indexOf('\n', start)) {
        stopped = emit(decoded.slice(start, end));
        start = end + 1;
      }
      if (start < decoded.length) {
        held.push(decoded.slice(start));
      }
    }
    if (stopped) {
      return false;
    }
    const final = decoder.end();
    if (final) {
      held.push(final);
    }
    if (held.length) {
      emit('');
    }
    readWholeFile = true;
  } catch {
    /* an agent can remove its transcript while the store is being swept */
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return readWholeFile;
}

interface CachedSpend {
  revision: string;
  parseKey: string;
  value: AgentSpend;
}

// Caches child totals by file revision and parse inputs when a parent is reparsed.
// The entry limit bounds retained results while an editor window remains open.
export class AgentSpendCache {
  private entries = new Map<string, CachedSpend>();

  constructor(private readonly limit = 200) {}

  // A running child passes its `openSpendBand` as `band`. Its entry then answers every read in
  // that band, however often the child writes, so the child is read at most once a band.
  read(file: string, load: (file: string) => AgentSpend, parseKey = '', band?: string, aggregate = false): AgentSpend {
    const fileVersion = spendFileVersion(file);
    if (!aggregate && (fileVersion === 'missing' || fileVersion === 'not-file')) {
      this.entries.delete(file);
      return { models: [], found: false, partial: false, effort: null };
    }
    const revision = band === undefined ? fileVersion : `band:${band}`;
    const hit = this.entries.get(file);
    if (hit && hit.revision === revision && hit.parseKey === parseKey) {
      this.entries.delete(file);
      this.entries.set(file, hit);
      return hit.value;
    }
    const value = load(file);
    this.entries.delete(file);
    this.entries.set(file, { revision, parseKey, value });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
    return value;
  }
}
