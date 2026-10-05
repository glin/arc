import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { ChildArtifacts } from './childartifacts';
import type { CommitIntent, TurnCommit, TurnUsage, TurnUsagePart, UsageContextBand, UsageCounts } from './transcript';

// One agent's billed usage under one model. A child can change models while it runs, so the
// model stays beside the counts it prices rather than being taken from the child's last reply.
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
  effort: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  toolUses?: number;
  // Whether the child file was present and readable. An empty transcript that exists is a
  // known zero; an empty result for a missing file is not.
  found: boolean;
  // The figures include every subagent this transcript launched, and theirs in turn. True when
  // one of them is missing from the figures: a launch with no meta file, a descendant transcript
  // that cannot be read, or a descendant whose last turn is still open. The figures are then
  // a lower bound.
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

// A read of a running child parses its whole transcript and every nested one. A band doubles
// until it lasts one millisecond per this many of those bytes, so the reads of one band average
// at most about 1 MB a second, however large the child grows.
export const OPEN_SPEND_BYTES_PER_MS = 1_000;

// The band length for a child whose figure reads this many bytes.
export function openSpendBandMs(bytes: number): number {
  let band = OPEN_SPEND_BAND_MS;
  while (band * OPEN_SPEND_BYTES_PER_MS < bytes) {
    band *= 2;
  }
  return band;
}

// The band of a running child's spend version at `now`. Each line of a version ends in a
// `spendFileVersion`, `size:mtime`. The band takes the newest write time and the total size over
// every file the version names. A child that has written nothing for a whole band has no band,
// and its caller keys it by its exact version instead. Its last writes then reach the card once,
// even when the child ends without a status change. A version with no file on disk has the band
// `none`.
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

// One child's spend through the cache, as the worker reads it for a parent card. A finished
// child is read again whenever its version moves. A running child is read at most once a band,
// the band its parent's render key carries, and once more when it goes quiet. It shows its usage
// so far and leaves out its commits, files and run record, because the child can still add to
// them or undo them. `versioned` puts the version in the parse key, for a file whose figure also
// covers other files. `now` must be the clock reading the caller's render key used.
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
  const band = open ? openSpendBand(version, now) : null;
  const key = versioned ? `${parseKey}\n${band === null ? version : 'open'}` : parseKey;
  const spend = cache.read(file, load, key, band ?? undefined);
  if (!open) {
    return spend;
  }
  return {
    models: spend.models,
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

// Read a file one line at a time without holding the transcript itself in memory. Child
// transcripts are usually small, but nothing in either format limits one, and the result
// retained by the panel is only a few token counts.
//
// A visit that answers exactly true stops the scan, and the scan then answers false, because it did not
// read the whole file.
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
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
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

// The panel re-parses a parent whenever it grows. A parent can keep references to dozens of
// completed children, whose files have not moved, so their compact totals are cached by file
// revision and parse inputs. The entry count is bounded because old
// sessions rotate out of the panel while the window itself can stay open for weeks.
export class AgentSpendCache {
  private entries = new Map<string, CachedSpend>();

  constructor(private readonly limit = 200) {}

  // A running child passes its `openSpendBand` as `band`. Its entry then answers every read in
  // that band, however often the child writes, so the child is read at most once a band.
  read(file: string, load: (file: string) => AgentSpend, parseKey = '', band?: string): AgentSpend {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) {
        this.entries.delete(file);
        return { models: [], found: false, partial: false, effort: null };
      }
    } catch {
      this.entries.delete(file);
      return { models: [], found: false, partial: false, effort: null };
    }
    const revision = band === undefined ? `${stat.size}:${stat.mtimeMs}` : `band:${band}`;
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
