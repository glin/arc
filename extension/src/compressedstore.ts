// The stores of compressed rollout facts. One directory per store holds an `epoch` file, the lock `backfill.lock`,
// segments of one JSON line per revision, compacted shards and the manifests that name them. Only the worker writes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { processIsRunning, temporaryWriterGone, writeFileAtomically } from './atomicfile';
import { CODEX_META_VERSION, createExclusive, releaseCodexOpeningsLock, takeCodexOpeningsLock } from './codexopenings';
import { openingRecordOf, readRolloutStat, ROLLOUT_NAME, type CodexSessionMeta } from './codex';
import { hashCompressedRollout, readCompressedFirstRecord, sameStat } from './compressedrollouts';
import type { DerivedTitleEntry } from './derivedcache';
import { METADATA_GENERATIONS } from './derivedcache';
import {
  keepHigherSpend,
  normalizeWorkspace,
  PROJECT_SPEND_PARSER_GENERATIONS,
  type SpendFileIndex,
} from './projectspend';

// Versions the fields and the derivation of a stored entry. Bump it when a stored field or its derivation changes.
export const COMPRESSED_FACTS_VERSION = 1;
export const COMPRESSED_FACTS_STORE = 'compressed-rollout-facts-v1';
export const COMPRESSED_OPENINGS_STORE = 'compressed-rollout-openings-v1';

export const STORE_LOCK = 'backfill.lock';
const EPOCH_FILE = 'epoch';
const SEGMENT_BYTES = 4 * 1024 * 1024;
const COMPACT_SEGMENTS = 32;
const COMPACT_INTERVAL_MS = 300_000;
const RENEW_MS = 10_000;
// After an abandonment the holder waits a random time in this range before it takes the lock again.
const RETRY_MIN_MS = 5_000;
const RETRY_SPREAD_MS = 25_000;
// A holder with no work left releases the lock after this time, so an idle window holds no lease.
const IDLE_RELEASE_MS = 20_000;
const READ_CHUNK = 64 * 1024;
// An entry above this many bytes drops its title entry. The row keeps a carried name and its cost.
export const COMPRESSED_ENTRY_TITLE_BYTES = 1024 * 1024;
// The worker posts at most this many bytes of entries in one batch, or one larger record.
export const COMPRESSED_BATCH_BYTES = 4 * 1024 * 1024;
const COMPRESSED_BATCH_INTERVAL_MS = 1_000;
// A worker step that prepares a list of names holds the worker for at most this long.
const NAME_SLICE_MS = 25;

// The facts of one compressed rollout. An entry with `adoptionFailed` or `nameOnly` holds no facts, and the backfill
// reads the names it marks first.
export interface CompressedFactEntry {
  file: string;
  // `canonicalPath` of the rollout without `.zst`.
  pairKey: string;
  factsVersion: number;
  codexMetaVersion: number;
  metadataGeneration: number;
  spendGeneration: number;
  // The physical size and modification time of the `.jsonl.zst`. A name-only record has neither.
  size?: number;
  mtimeMs?: number;
  hash?: string;
  threadId?: string | null;
  decodedLength?: number;
  skippedRecords?: number;
  undercount?: boolean;
  // True when the decode ended on a frame boundary. An adopted entry is complete, because its plain record was.
  complete?: boolean;
  adopted?: boolean;
  adoptionFailed?: boolean;
  nameOnly?: boolean;
  title?: DerivedTitleEntry;
  carriedName?: { label: string; fullLabel: string };
  opening?: CodexSessionMeta | null;
  spend?: SpendFileIndex;
}

export interface CompressedStorePaths {
  facts: string;
  openings: string;
}

export interface CompressedAdoptionInput {
  twin: string;
  plain: string;
  plainMtimeMs: number;
  title?: DerivedTitleEntry;
  opening?: CodexSessionMeta | null;
  // The plain spend record, when it is complete.
  spend?: SpendFileIndex;
}

export interface CompressedAdoptionResult {
  adopted: boolean;
  entry: CompressedFactEntry;
}

// The pair key of a twin: the canonical path of the rollout without `.zst`. The plain file can be gone, so the twin's
// directory supplies the physical path and a pair under a junction alias still meets the ledger's path. A caller with
// many names passes `directories`, which keeps each resolved directory.
export function compressedPairKey(twin: string, directories: Map<string, string> = new Map()): string {
  const directory = path.dirname(twin);
  let real = directories.get(directory);
  if (real === undefined) {
    try {
      real = fs.realpathSync.native(directory);
    } catch {
      // A directory that cannot be resolved keeps its name.
      real = directory;
    }
    directories.set(directory, real);
  }
  return normalizeWorkspace(path.join(real, path.basename(twin).replace(/\.zst$/, '')));
}

function sessionKeyOf(file: string, opening: CodexSessionMeta | null | undefined): string | null {
  return opening?.sessionId ?? ROLLOUT_NAME.exec(path.basename(file).replace(/\.zst$/, ''))?.[1] ?? null;
}

// Take the facts of a plain rollout for its twin. The twin's first line must be an opening of the same thread, the
// times must be equal and the plain spend record must be complete. The twin's stat is one revision across the header
// read and the hash. Anything else discards the plain facts, and the entry marks the twin for the backfill.
export async function adoptCompressedTwin(
  input: CompressedAdoptionInput,
  hash: typeof hashCompressedRollout = hashCompressedRollout,
): Promise<CompressedAdoptionResult> {
  const stat = readRolloutStat(input.twin);
  let first: string | null = null;
  try {
    first = await readCompressedFirstRecord(input.twin, COMPRESSED_ENTRY_TITLE_BYTES);
  } catch {
    first = null;
  }
  const opening = openingRecordOf(first);
  const threadId = opening?.sessionId ?? null;
  const expected = sessionKeyOf(input.plain, input.opening);
  const failed = (): CompressedAdoptionResult => ({
    adopted: false,
    entry: {
      file: input.twin,
      pairKey: compressedPairKey(input.twin),
      ...compressedEntryVersions(),
      ...(stat ? { size: stat.size, mtimeMs: stat.mtimeMs } : {}),
      threadId,
      adoptionFailed: true,
    },
  });
  if (
    first === null ||
    !stat ||
    !threadId ||
    threadId !== expected ||
    stat.mtimeMs !== input.plainMtimeMs ||
    !input.spend ||
    input.spend.complete === false
  )
    return failed();
  const hashed = await hash(input.twin);
  if (!hashed || !sameStat(hashed.stat, stat) || !sameStat(readRolloutStat(input.twin), stat)) return failed();
  return {
    adopted: true,
    entry: {
      file: input.twin,
      pairKey: compressedPairKey(input.twin),
      ...compressedEntryVersions(),
      size: hashed.stat.size,
      mtimeMs: hashed.stat.mtimeMs,
      hash: hashed.hash,
      threadId,
      complete: true,
      adopted: true,
      skippedRecords: 0,
      undercount: false,
      ...(input.title ? { title: { ...input.title, size: hashed.stat.size, mtimeMs: hashed.stat.mtimeMs } } : {}),
      opening: input.opening ?? opening,
      spend: input.spend,
    },
  };
}

// The placing opening of an adopted entry for the machine store.
export function compressedOpeningEntry(entry: CompressedFactEntry): CompressedFactEntry {
  return {
    file: entry.file,
    pairKey: entry.pairKey,
    factsVersion: entry.factsVersion,
    codexMetaVersion: entry.codexMetaVersion,
    metadataGeneration: entry.metadataGeneration,
    spendGeneration: entry.spendGeneration,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    threadId: entry.threadId,
    opening: entry.opening,
  };
}

// A marked derivation never replaces a higher total. The entry keeps the higher spend record and takes the mark.
export function withKeptUndercount(
  previous: CompressedFactEntry | undefined,
  next: CompressedFactEntry,
): CompressedFactEntry {
  if (!previous?.spend || !next.undercount || !next.spend) return next;
  const spend = keepHigherSpend(previous.spend, next.spend);
  return spend === previous.spend ? { ...next, spend, undercount: true } : next;
}

// The version stamps of a new entry, as of this build.
export function compressedEntryVersions(): Pick<
  CompressedFactEntry,
  'factsVersion' | 'codexMetaVersion' | 'metadataGeneration' | 'spendGeneration'
> {
  return {
    factsVersion: COMPRESSED_FACTS_VERSION,
    codexMetaVersion: CODEX_META_VERSION,
    metadataGeneration: METADATA_GENERATIONS.codex,
    spendGeneration: PROJECT_SPEND_PARSER_GENERATIONS.codex,
  };
}

// True when the entry's title entry has this build's title versions. The row shows a carried name otherwise.
export function compressedTitleCurrent(entry: CompressedFactEntry): boolean {
  return entry.factsVersion === COMPRESSED_FACTS_VERSION && entry.metadataGeneration === METADATA_GENERATIONS.codex;
}

// An entry is current when its stat matches the file and each version matches this build.
export function compressedEntryCurrent(
  entry: CompressedFactEntry,
  stat: { size: number; mtimeMs: number } | null,
): boolean {
  return (
    !!stat &&
    entry.size === stat.size &&
    entry.mtimeMs === stat.mtimeMs &&
    entry.factsVersion === COMPRESSED_FACTS_VERSION &&
    entry.codexMetaVersion === CODEX_META_VERSION &&
    entry.metadataGeneration === METADATA_GENERATIONS.codex &&
    entry.spendGeneration === PROJECT_SPEND_PARSER_GENERATIONS.codex
  );
}

// A name that a store file carries, split into its parts. `seq` counts the files of one holder, so a name is unique.
const STORE_FILE = /^(segment|shard|manifest)-(\d+)-(.+)-(\d+)$/;
// `<target>.<token>.<time>.tmp`, with a token of `<pid>.<uuid>`.
const STORE_TEMPORARY = /^(.+)\.(\d+)\.([0-9a-f-]+)\.(\d+)\.tmp$/;

interface StoreName {
  name: string;
  kind: 'segment' | 'shard' | 'manifest';
  epoch: number;
  token: string;
  seq: number;
}

function storeName(name: string): StoreName | null {
  const parts = STORE_FILE.exec(name);
  return parts
    ? { name, kind: parts[1] as StoreName['kind'], epoch: Number(parts[2]), token: parts[3], seq: Number(parts[4]) }
    : null;
}

export interface StoreManifest {
  factsVersion: number;
  epoch: number;
  token: string;
  seq: number;
  shards: string[];
  inputs: string[];
}

function parseManifest(text: string): StoreManifest | null {
  try {
    const value = JSON.parse(text) as Partial<StoreManifest>;
    return typeof value.factsVersion === 'number' &&
      Array.isArray(value.shards) &&
      Array.isArray(value.inputs) &&
      typeof value.epoch === 'number' &&
      typeof value.token === 'string' &&
      typeof value.seq === 'number'
      ? (value as StoreManifest)
      : null;
  } catch {
    return null;
  }
}

function readManifest(directory: string, name: string): StoreManifest | null {
  try {
    return parseManifest(fs.readFileSync(path.join(directory, name), 'utf8'));
  } catch {
    return null;
  }
}

// One read of the fact lines of a file. The callback gets each complete line and its byte offset, so a caller holds one
// line at a time. A trailing line without a line break is skipped. A file that cannot be read throws.
// `start` skips the bytes that an earlier read already gave. The result counts the bytes read.
function eachLine(
  file: string,
  line: (text: Buffer, offset: number) => boolean | void,
  open: (file: string) => number = openForRead,
  start = 0,
): number {
  const fd = open(file);
  let total = 0;
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    let held: Buffer = Buffer.alloc(0);
    let heldAt = start;
    let position = start;
    while (true) {
      const read = fs.readSync(fd, chunk, 0, READ_CHUNK, position);
      if (read === 0) return total;
      total += read;
      const bytes = Buffer.concat([held, chunk.subarray(0, read)]);
      position += read;
      let from = 0;
      for (let end = bytes.indexOf(0x0a, from); end >= 0; end = bytes.indexOf(0x0a, from)) {
        if (line(bytes.subarray(from, end), heldAt + from) === false) return total;
        from = end + 1;
      }
      held = bytes.subarray(from);
      heldAt += from;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function openForRead(file: string): number {
  return fs.openSync(file, 'r');
}

// A reader skips a file that it cannot read, because a compaction can retire any file at any time.
function eachReadableLine(file: string, line: (text: Buffer, offset: number) => boolean | void): void {
  try {
    eachLine(file, line);
  } catch {
    // The file is gone or cannot be read.
  }
}

function parseEntry(text: string): CompressedFactEntry | null {
  try {
    const value = JSON.parse(text) as Partial<CompressedFactEntry>;
    return typeof value.file === 'string' && typeof value.factsVersion === 'number' && typeof value.pairKey === 'string'
      ? (value as CompressedFactEntry)
      : null;
  } catch {
    return null;
  }
}

// A newer build's file stays untouched. An older version is a stale candidate that still carries names and spend.
function readableFactsVersion(version: number | null): boolean {
  return version === null || version <= COMPRESSED_FACTS_VERSION;
}

// The physical stat that ranks an entry against its rollout, in the precision that adoption stores.
export function compressedPhysicalStat(file: string): { size: number; mtimeMs: number } | null {
  return readRolloutStat(file);
}

// The fact version of a store file, from its first complete line. Null when the file holds no complete line.
function fileFactsVersion(file: string): number | null {
  let version: number | null = null;
  eachReadableLine(file, (line) => {
    const entry = parseEntry(line.toString('utf8'));
    version = entry ? entry.factsVersion : null;
    return false;
  });
  return version;
}

// The fields of an entry that the merge ranks, kept apart from the entry so a compaction holds no entry body.
interface RankFields {
  file: string;
  pairKey: string;
  factsVersion: number;
  size?: number;
  mtimeMs?: number;
  decodedLength?: number;
}

function rankFields(entry: CompressedFactEntry): RankFields {
  return {
    file: entry.file,
    pairKey: entry.pairKey,
    factsVersion: entry.factsVersion,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    decodedLength: entry.decodedLength,
  };
}

interface RankedEntry {
  entry: RankFields;
  epoch: number;
  token: string;
  // The file and byte offset of the line. `seq` orders a holder's files in the order it wrote them.
  input: string;
  offset: number;
  seq: number;
}

// Greater when `left` ranks first. Current fact version first, then an equal stat, then greater mtimeMs and size, then
// an entry with a decoded length, the higher epoch, the greater holder token and the later line.
export function compareRankedEntries(
  left: RankedEntry,
  right: RankedEntry,
  stat: { size: number; mtimeMs: number } | null,
): number {
  const a = left.entry;
  const b = right.entry;
  const version =
    Number(a.factsVersion === COMPRESSED_FACTS_VERSION) - Number(b.factsVersion === COMPRESSED_FACTS_VERSION);
  if (version) return version;
  const equal = (entry: RankFields) => (!!stat && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs ? 1 : 0);
  const statRank = equal(a) - equal(b);
  if (statRank) return statRank;
  const mtime = (a.mtimeMs ?? -1) - (b.mtimeMs ?? -1);
  if (mtime) return mtime;
  const size = (a.size ?? -1) - (b.size ?? -1);
  if (size) return size;
  const decoded = Number(a.decodedLength !== undefined) - Number(b.decodedLength !== undefined);
  if (decoded) return decoded;
  if (left.epoch !== right.epoch) return left.epoch - right.epoch;
  if (left.token !== right.token) return left.token > right.token ? 1 : -1;
  return left.seq - right.seq || left.offset - right.offset;
}

interface StoreView {
  // The fact-version files that a reader merges, in reading order.
  inputs: StoreName[];
  manifests: StoreName[];
  valid: StoreManifest[];
  current: StoreManifest | null;
  retired: Set<string>;
}

function listDirectory(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

// The files that this build can read: its own fact version and older ones. A manifest is valid when all its shards are present. A reader ignores a shard
// that no valid manifest names and skips an input that one names.
function storeView(directory: string, names: readonly string[]): StoreView {
  const present = new Set(names);
  const parsed = names.flatMap((name) => {
    const stored = storeName(name);
    return stored ? [stored] : [];
  });
  const manifests = parsed.filter((stored) => stored.kind === 'manifest');
  const valid: StoreManifest[] = [];
  for (const stored of manifests) {
    const manifest = readManifest(directory, stored.name);
    if (manifest && readableFactsVersion(manifest.factsVersion) && manifest.shards.every((shard) => present.has(shard)))
      valid.push(manifest);
  }
  valid.sort((left, right) => left.epoch - right.epoch || left.seq - right.seq);
  const current = valid.at(-1) ?? null;
  const named = new Set(valid.flatMap((manifest) => manifest.shards));
  const retired = new Set(valid.flatMap((manifest) => manifest.inputs));
  const inputs = parsed.filter(
    (stored) =>
      (stored.kind === 'segment' || (stored.kind === 'shard' && named.has(stored.name))) && !retired.has(stored.name),
  );
  return { inputs, manifests, valid, current, retired };
}

export interface CompressedStoreRead {
  entries: Map<string, CompressedFactEntry>;
  names: readonly string[];
}

// Merge the store's files into one entry per path. A file or line of a newer fact version is skipped, and an older one
// is a stale candidate.
export function readCompressedStore(
  directory: string,
  statOf: (file: string) => { size: number; mtimeMs: number } | null = () => null,
): CompressedStoreRead {
  const steps = storeReadSteps(directory, statOf);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

// The same read with a yield after each file, so no step holds the worker past one file of at most 4 MiB and one entry.
export async function readCompressedStoreInSteps(
  directory: string,
  statOf: (file: string) => { size: number; mtimeMs: number } | null,
  yieldStep: () => Promise<void> = yieldToEvents,
): Promise<CompressedStoreRead> {
  const steps = storeReadSteps(directory, statOf);
  let step = steps.next();
  while (!step.done) {
    await yieldStep();
    step = steps.next();
  }
  return step.value;
}

function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function* storeReadSteps(
  directory: string,
  statOf: (file: string) => { size: number; mtimeMs: number } | null,
): Generator<void, CompressedStoreRead, void> {
  const names = listDirectory(directory);
  const view = storeView(directory, names);
  const best = new Map<string, { ranked: RankedEntry; entry: CompressedFactEntry }>();
  for (const input of view.inputs) {
    if (!readableFactsVersion(fileFactsVersion(path.join(directory, input.name)))) continue;
    eachReadableLine(path.join(directory, input.name), (line, offset) => {
      const entry = parseEntry(line.toString('utf8'));
      if (!entry || !readableFactsVersion(entry.factsVersion)) return;
      const ranked: RankedEntry = {
        entry: rankFields(entry),
        epoch: input.epoch,
        token: input.token,
        input: input.name,
        offset,
        seq: input.seq,
      };
      const held = best.get(entry.file);
      if (!held || compareRankedEntries(ranked, held.ranked, statOf(entry.file)) > 0)
        best.set(entry.file, { ranked, entry });
    });
    yield;
  }
  const entries = new Map<string, CompressedFactEntry>();
  for (const [file, { entry }] of best) entries.set(file, entry);
  return { entries, names };
}

// Split entries into batches of at most `bytes`. A single larger record forms its own batch.
export function compressedEntryBatches(
  entries: readonly CompressedFactEntry[],
  bytes = COMPRESSED_BATCH_BYTES,
): CompressedFactEntry[][] {
  const batches: CompressedFactEntry[][] = [];
  let current: CompressedFactEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const length = Buffer.byteLength(JSON.stringify(entry));
    if (current.length && size + length > bytes) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += length;
  }
  if (current.length) batches.push(current);
  return batches;
}

// The line that starts at `offset`, or null when it has no line break. A file that cannot be read throws.
function readLineAt(file: string, offset: number, open: (file: string) => number): string | null {
  const fd = open(file);
  try {
    const parts: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    let position = offset;
    while (true) {
      const read = fs.readSync(fd, chunk, 0, READ_CHUNK, position);
      if (read === 0) return null;
      const end = chunk.subarray(0, read).indexOf(0x0a);
      if (end >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, end)));
        return Buffer.concat(parts).toString('utf8');
      }
      parts.push(Buffer.from(chunk.subarray(0, read)));
      position += read;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readEpoch(directory: string): { e: number; token: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, EPOCH_FILE), 'utf8')) as {
      e?: unknown;
      token?: unknown;
    };
    return typeof parsed.e === 'number' && typeof parsed.token === 'string'
      ? { e: parsed.e, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

function readLockText(lock: string): string | null | 'missing' {
  try {
    return fs.readFileSync(lock, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null;
  }
}

// Every field of an entry that a reader can see change. A later file that repeats these values is not new for a host.
function compressedEntryMark(entry: CompressedFactEntry): string {
  return [
    entry.size,
    entry.mtimeMs,
    entry.hash,
    entry.factsVersion,
    entry.codexMetaVersion,
    entry.metadataGeneration,
    entry.spendGeneration,
    entry.decodedLength,
    entry.complete,
    entry.adopted,
    entry.adoptionFailed,
    entry.nameOnly,
    entry.undercount,
  ].join('|');
}

export function compressedEntrySame(left: CompressedFactEntry, right: CompressedFactEntry): boolean {
  return compressedEntryMark(left) === compressedEntryMark(right);
}

// Reads one store as it changes. The first poll reads every file. Each later poll lists the store and reads only the
// bytes appended since, so another window's entry arrives without a restart.
export class CompressedStoreFollower {
  private readonly consumed = new Map<string, number>();
  private readonly best = new Map<string, { ranked: RankedEntry; mark: string }>();
  // The bytes every poll read so far.
  bytesRead = 0;

  constructor(
    readonly directory: string,
    private readonly statOf: typeof compressedPhysicalStat = compressedPhysicalStat,
    private readonly yieldStep: () => Promise<void> = yieldToEvents,
  ) {}

  // The entries that are new or changed since the last poll.
  async poll(): Promise<CompressedFactEntry[]> {
    const names = listDirectory(this.directory);
    const view = storeView(this.directory, names);
    const present = new Set(names);
    for (const name of this.consumed.keys()) if (!present.has(name)) this.consumed.delete(name);
    const changed = new Map<string, CompressedFactEntry>();
    for (const input of view.inputs) {
      if (this.readInput(input, changed)) await this.yieldStep();
    }
    return [...changed.values()];
  }

  // True when the input had new bytes.
  private readInput(input: StoreName, changed: Map<string, CompressedFactEntry>): boolean {
    const file = path.join(this.directory, input.name);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return false;
    }
    let consumed = this.consumed.get(input.name);
    if (consumed === undefined) {
      if (!readableFactsVersion(fileFactsVersion(file))) {
        this.consumed.set(input.name, size);
        return false;
      }
      consumed = 0;
    }
    if (size <= consumed) return false;
    let end = consumed;
    try {
      this.bytesRead += eachLine(
        file,
        (line, offset) => {
          end = offset + line.length + 1;
          const entry = parseEntry(line.toString('utf8'));
          if (!entry || !readableFactsVersion(entry.factsVersion)) return;
          this.rank(entry, input, offset, changed);
        },
        openForRead,
        consumed,
      );
    } catch {
      // The file went away. The next listing no longer names it.
    }
    this.consumed.set(input.name, end);
    return true;
  }

  private rank(
    entry: CompressedFactEntry,
    input: StoreName,
    offset: number,
    changed: Map<string, CompressedFactEntry>,
  ): void {
    const ranked: RankedEntry = {
      entry: rankFields(entry),
      epoch: input.epoch,
      token: input.token,
      input: input.name,
      offset,
      seq: input.seq,
    };
    const held = this.best.get(entry.file);
    if (held && compareRankedEntries(ranked, held.ranked, this.statOf(entry.file)) <= 0) return;
    const mark = compressedEntryMark(entry);
    this.best.set(entry.file, { ranked, mark });
    if (held?.mark !== mark) changed.set(entry.file, entry);
  }
}

// Post entries as batches of at most 4 MiB, at most one batch per second. The last batch stays for the reply.
export async function postCompressedBatches(
  entries: readonly CompressedFactEntry[],
  signal: AbortSignal,
  post: (batch: CompressedFactEntry[]) => void,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<CompressedFactEntry[]> {
  const batches = compressedEntryBatches(entries);
  for (let at = 0; at < batches.length - 1 && !signal.aborted; at++) {
    post(batches[at]);
    await wait(COMPRESSED_BATCH_INTERVAL_MS);
  }
  return signal.aborted ? [] : (batches.at(-1) ?? []);
}

export interface CompressedStoreOptions {
  now?: () => number;
  schedule?: (milliseconds: number, run: () => void) => () => void;
  retryDelay?: () => number;
  yieldStep?: () => Promise<void>;
  // True when the rollout path still exists.
  exists?: (file: string) => boolean;
  statOf?: (file: string) => { size: number; mtimeMs: number } | null;
  // Called with the byte count of every store file write.
  wrote?: (bytes: number) => void;
  segmentBytes?: number;
  compactSegments?: number;
  // A hook that throws at a named step, for tests of a crash at that step.
  fault?: (point: string) => void;
  // Opens a compaction input for reading.
  openInput?: (file: string) => number;
}

// A compaction input could not be read. The compaction ends and retires nothing.
class CompactionInputError extends Error {}

interface OpenSegment {
  name: string;
  fd: number;
  bytes: number;
}

// One writer of a store. It queues entries, holds the lease while it works, and never loses a queued entry to a lost
// lease: an entry leaves the queue only after its line is written and flushed. The holder reports each entry as durable
// only then, so a caller keeps its source until the report.
export class CompressedStoreHolder {
  private readonly lock: string;
  private readonly now: () => number;
  private readonly schedule: (milliseconds: number, run: () => void) => () => void;
  private readonly retryDelay: () => number;
  private readonly yieldStep: () => Promise<void>;
  private readonly exists: (file: string) => boolean;
  private readonly statOf: (file: string) => { size: number; mtimeMs: number } | null;
  private readonly wrote: (bytes: number) => void;
  private readonly faultHook: (point: string) => void;
  // True after the fault hook of a test threw, so the holder stops as a crashed holder does.
  private faulted = false;
  private readonly openInput: (file: string) => number;
  private readonly segmentBytes: number;
  private readonly compactSegments: number;

  private readonly queue: CompressedFactEntry[] = [];
  private readonly flushed = new WeakSet<CompressedFactEntry>();
  private waiters: { entries: readonly CompressedFactEntry[]; settle: (durable: boolean) => void }[] = [];
  private token: string | null = null;
  private epoch: { e: number; token: string } | null = null;
  private seq = 0;
  private open: OpenSegment | null = null;
  private closedSegments = 0;
  private lastCompaction = 0;
  // A compaction that could not read an input waits for this time before the next one.
  private compactionRetryAt = 0;
  private running: Promise<void> | null = null;
  private cancelRenewal: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private cancelIdle: (() => void) | null = null;
  private disposed = false;

  constructor(
    readonly directory: string,
    options: CompressedStoreOptions = {},
  ) {
    this.lock = path.join(directory, STORE_LOCK);
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((milliseconds, run) => {
        const timer = setTimeout(run, milliseconds);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.retryDelay = options.retryDelay ?? (() => RETRY_MIN_MS + Math.random() * RETRY_SPREAD_MS);
    this.yieldStep = options.yieldStep ?? yieldToEvents;
    this.exists = options.exists ?? fs.existsSync;
    this.statOf = options.statOf ?? compressedPhysicalStat;
    this.wrote = options.wrote ?? (() => {});
    this.faultHook = options.fault ?? (() => {});
    this.openInput = options.openInput ?? openForRead;
    this.lastCompaction = this.now();
    this.segmentBytes = options.segmentBytes ?? SEGMENT_BYTES;
    this.compactSegments = options.compactSegments ?? COMPACT_SEGMENTS;
  }

  private fault(point: string): void {
    try {
      this.faultHook(point);
    } catch (error) {
      this.faulted = true;
      throw error;
    }
  }

  // True while this holder owns the lease.
  get held(): boolean {
    return this.token !== null;
  }

  get pending(): number {
    return this.queue.length;
  }

  // Queue entries and work them off. The returned promise settles when this run of the queue ends, with one value per
  // entry: true when its line is on disk. A false value leaves the entry queued, and `durable` reports its end.
  append(entries: readonly CompressedFactEntry[]): Promise<boolean[]> {
    this.queue.push(...entries);
    return this.work().then(() => entries.map((entry) => this.flushed.has(entry)));
  }

  // True when every entry reaches the disk, or false when the holder is disposed first.
  durable(entries: readonly CompressedFactEntry[]): Promise<boolean> {
    if (entries.every((entry) => this.flushed.has(entry))) return Promise.resolve(true);
    if (this.disposed) return Promise.resolve(false);
    return new Promise((settle) => this.waiters.push({ entries, settle }));
  }

  // Run the queue until it is empty. A failed lease leaves the queue in place and retries after the jitter delay.
  work(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.running ??= this.run().then(
      () => {
        this.running = null;
        // An entry that arrives after the last test of the queue starts its own run.
        if (this.queue.length && !this.disposed && !this.cancelRetry) void this.work();
      },
      (error: unknown) => {
        this.running = null;
        // A store error ends this lease. It never reaches the worker, and the queue retries after the jitter delay.
        if (this.faulted) throw error;
        this.abandon();
      },
    );
    return this.running;
  }

  private async run(): Promise<void> {
    while (this.queue.length && !this.disposed) {
      this.cancelIdle?.();
      this.cancelIdle = null;
      if (!this.token && !(await this.takeLease())) {
        this.retryLater();
        return;
      }
      while (this.queue.length && this.token) {
        if (!this.publishBatch()) return;
        if (this.closedSegments >= this.compactSegments && this.compactionAllowed()) await this.compact(false);
        await this.yieldStep();
      }
      if (!this.token) return;
      if (
        this.now() - this.lastCompaction >= COMPACT_INTERVAL_MS &&
        this.closedSegments > 0 &&
        this.compactionAllowed()
      )
        await this.compact(false);
      if (!this.token) return;
    }
    this.armIdleRelease();
  }

  private compactionAllowed(): boolean {
    return this.now() >= this.compactionRetryAt;
  }

  private armIdleRelease(): void {
    if (this.token && !this.disposed && !this.cancelIdle)
      this.cancelIdle = this.schedule(IDLE_RELEASE_MS, () => this.releaseIfIdle());
  }

  // Step 2 to step 4 of the abandonment sequence, and the recovery of a takeover.
  private async takeLease(): Promise<boolean> {
    fs.mkdirSync(this.directory, { recursive: true });
    const token = takeCodexOpeningsLock(this.lock, this.now());
    if (token === null) return false;
    const kept = readEpoch(this.directory);
    this.token = token;
    this.fault('takeover:after-lock');
    if (!this.fenceEpoch(kept)) return false;
    this.startRenewal();
    await this.recover();
    return this.token !== null;
  }

  private abandonToken(): void {
    const token = this.token;
    this.closeSegment();
    this.cancelRenewal?.();
    this.cancelRenewal = null;
    this.token = null;
    this.epoch = null;
    if (token) {
      try {
        releaseCodexOpeningsLock(this.lock, token);
      } catch {
        // A lock that cannot be read is left for the stale takeover.
      }
    }
  }

  // Step 4: write `epoch` above the kept value and every epoch in file names, or abandon when `epoch` moved.
  private fenceEpoch(kept: { e: number; token: string } | null): boolean {
    const now = readEpoch(this.directory);
    if ((now?.e ?? 0) !== (kept?.e ?? 0) || now?.token !== kept?.token) {
      this.abandon();
      return false;
    }
    const parsed = listDirectory(this.directory).flatMap((name) => {
      const stored = storeName(name);
      return stored ? [stored.epoch] : [];
    });
    const e = Math.max(kept?.e ?? 0, ...parsed) + 1;
    const value = { e, token: this.token! };
    this.writeAtomically(path.join(this.directory, EPOCH_FILE), JSON.stringify(value));
    this.epoch = value;
    this.seq = 0;
    return true;
  }

  // `durable` syncs a file that must survive a crash, because its inputs are deleted after it.
  private writeAtomically(target: string, text: string, durable = false): void {
    writeFileAtomically(target, text, fs.renameSync, undefined, false, this.token!, durable);
    this.wrote(Buffer.byteLength(text));
  }

  private nextName(kind: 'segment' | 'shard' | 'manifest'): string {
    return `${kind}-${this.epoch!.e}-${this.token}-${this.seq++}`;
  }

  // A check reads the lease token and `epoch`. A failure abandons.
  private check(): boolean {
    const held = this.token;
    if (!held || !this.epoch) return false;
    // A paused holder can remove the live lock once, so a missing lock follows the renewal rule.
    let lock = readLockText(this.lock);
    if (lock === 'missing' && createExclusive(this.lock, held)) lock = held;
    if (lock !== held) {
      this.abandon();
      return false;
    }
    const epoch = readEpoch(this.directory);
    if (epoch?.e !== this.epoch.e || epoch.token !== this.epoch.token) {
      this.abandon();
      return false;
    }
    return true;
  }

  // Every 10 s the holder reads the lock, compares the token and touches the mtime. Another token abandons. A missing
  // lock is created again, and a failed creation abandons.
  private startRenewal(): void {
    this.cancelRenewal?.();
    const tick = () => {
      this.cancelRenewal = this.schedule(RENEW_MS, tick);
      try {
        this.renew();
      } catch {
        this.abandon();
      }
    };
    this.cancelRenewal = this.schedule(RENEW_MS, tick);
  }

  // One renewal. Public for tests that drive the clock.
  renew(): boolean {
    if (!this.token) return false;
    const text = readLockText(this.lock);
    if (text === 'missing') {
      if (!createExclusive(this.lock, this.token)) {
        this.abandon();
        return false;
      }
      return this.renewalEpochHolds();
    }
    if (text !== this.token) {
      this.abandon();
      return false;
    }
    if (!this.renewalEpochHolds()) return false;
    const at = new Date(this.now());
    fs.utimesSync(this.lock, at, at);
    return true;
  }

  // An overwritten epoch ends the lease within one renewal, even with an unchanged lock.
  private renewalEpochHolds(): boolean {
    const epoch = readEpoch(this.directory);
    if (epoch?.e === this.epoch?.e && epoch?.token === this.epoch?.token) return true;
    this.abandon();
    return false;
  }

  // Step 1: stop, close the open segment, release the lock on a token match, then retry while work remains.
  private abandon(): void {
    this.abandonToken();
    this.cancelIdle?.();
    this.cancelIdle = null;
    if (this.queue.length) this.retryLater();
  }

  private retryLater(): void {
    if (this.cancelRetry || this.disposed) return;
    this.cancelRetry = this.schedule(this.retryDelay(), () => {
      this.cancelRetry = null;
      void this.work();
    });
  }

  private closeSegment(): void {
    if (!this.open) return;
    try {
      fs.closeSync(this.open.fd);
    } catch {
      // The holder keeps no descriptor after an error.
    }
    this.open = null;
    this.closedSegments++;
  }

  private publishBatch(): boolean {
    let bytes = 0;
    let taken = 0;
    let oversized = false;
    const lines: string[] = [];
    while (taken < this.queue.length && bytes < this.segmentBytes) {
      let entry = this.queue[taken];
      let line = `${JSON.stringify(entry)}\n`;
      if (entry.title && Buffer.byteLength(line) > COMPRESSED_ENTRY_TITLE_BYTES) {
        const { title, ...rest } = entry;
        entry = { ...rest, carriedName: { label: title.label, fullLabel: title.fullLabel } };
        line = `${JSON.stringify(entry)}\n`;
      }
      const length = Buffer.byteLength(line);
      // A record above 4 MiB gets a segment file of its own.
      if (length > this.segmentBytes) {
        if (taken) break;
        oversized = true;
        lines.push(line);
        bytes = length;
        taken = 1;
        break;
      }
      lines.push(line);
      bytes += length;
      taken++;
    }
    if (!this.check()) return false;
    if (oversized) this.closeSegment();
    const segment = this.open ?? this.openSegment();
    fs.writeSync(segment.fd, lines.join(''));
    fs.fsyncSync(segment.fd);
    segment.bytes += bytes;
    this.wrote(bytes);
    this.fault('segment:flushed');
    for (const flushed of this.queue.splice(0, taken)) this.flushed.add(flushed);
    this.settleWaiters();
    if (oversized || segment.bytes >= this.segmentBytes) this.closeSegment();
    return true;
  }

  private settleWaiters(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) {
      if (waiter.entries.every((entry) => this.flushed.has(entry))) waiter.settle(true);
      else this.waiters.push(waiter);
    }
  }

  private openSegment(): OpenSegment {
    const name = this.nextName('segment');
    const fd = fs.openSync(path.join(this.directory, name), 'a');
    this.open = { name, fd, bytes: 0 };
    return this.open;
  }

  // Recovery at a takeover, before the holder writes any shard, segment or manifest.
  private async recover(): Promise<void> {
    const names = listDirectory(this.directory);
    const view = storeView(this.directory, names);
    this.fault('recovery:start');
    // A holder paused since its listing deletes nothing, because the listing no longer describes the store.
    if (!this.check()) return;
    const current = view.current;
    const keepShards = new Set(current?.shards ?? []);
    for (const stored of view.manifests) {
      if (current && stored.name === this.manifestName(current)) continue;
      const manifest = readManifest(this.directory, stored.name);
      // A newer manifest belongs to a newer build.
      if (manifest && !readableFactsVersion(manifest.factsVersion)) continue;
      this.remove(stored.name);
    }
    if (current) for (const input of current.inputs) this.remove(input);
    for (const name of names) {
      const stored = storeName(name);
      if (stored?.kind === 'shard' && !keepShards.has(name) && this.ownVersion(name)) this.remove(name);
      const temporary = STORE_TEMPORARY.exec(name);
      if (temporary) {
        const pid = Number(temporary[2]);
        const token = `${temporary[2]}.${temporary[3]}`;
        const writtenAt = Number(temporary[4]);
        if (token !== this.token || temporaryWriterGone(pid, writtenAt, this.now(), processIsRunning))
          this.remove(name);
      }
    }
    this.fault('recovery:deleted');
    // Other holders' segments count as closed.
    const after = storeView(this.directory, listDirectory(this.directory));
    this.closedSegments = after.inputs.filter(
      (stored) => stored.kind === 'segment' && this.ownVersion(stored.name),
    ).length;
    if (
      this.closedSegments >= this.compactSegments ||
      after.valid.length > 1 ||
      (this.closedSegments && this.compactionDue(after))
    ) {
      await this.compact(true);
    }
  }

  // The newest manifest's time tells when any holder compacted last.
  private compactionDue(view: StoreView): boolean {
    if (!view.current) return true;
    try {
      const stat = fs.statSync(path.join(this.directory, this.manifestName(view.current)));
      return this.now() - stat.mtimeMs >= COMPACT_INTERVAL_MS;
    } catch {
      return true;
    }
  }

  private manifestName(manifest: StoreManifest): string {
    return `manifest-${manifest.epoch}-${manifest.token}-${manifest.seq}`;
  }

  private ownVersion(name: string): boolean {
    return readableFactsVersion(fileFactsVersion(path.join(this.directory, name)));
  }

  private remove(name: string): void {
    try {
      fs.rmSync(path.join(this.directory, name), { force: true });
    } catch {
      // A file that cannot be removed stays until the next holder.
    }
  }

  private async compact(recovery: boolean): Promise<void> {
    if (!this.token) return;
    this.closeSegment();
    this.fault('compact:start');
    const names = listDirectory(this.directory);
    const view = storeView(this.directory, names);
    const inputs = view.inputs.filter((stored) => this.ownVersion(stored.name));
    if (!inputs.length) return;
    const shards: string[] = [];
    try {
      await this.compactInputs(view, inputs, shards, recovery);
    } catch (error) {
      if (!(error instanceof CompactionInputError)) throw error;
      // The inputs stay, so every entry stays readable. The shards of this attempt go, and the next attempt waits.
      for (const name of shards) this.remove(name);
      this.compactionRetryAt = this.now() + COMPACT_INTERVAL_MS;
    }
  }

  private readInputLines(input: string, line: (text: Buffer, offset: number) => boolean | void): void {
    try {
      eachLine(path.join(this.directory, input), line, this.openInput);
    } catch (error) {
      throw new CompactionInputError(input, { cause: error });
    }
  }

  private readInputLine(input: string, offset: number): string {
    let text: string | null;
    try {
      text = readLineAt(path.join(this.directory, input), offset, this.openInput);
    } catch (error) {
      throw new CompactionInputError(input, { cause: error });
    }
    if (text === null) throw new CompactionInputError(input);
    return text;
  }

  private async compactInputs(
    view: StoreView,
    inputs: readonly StoreName[],
    shards: string[],
    recovery: boolean,
  ): Promise<void> {
    const best = new Map<string, RankedEntry>();
    for (const input of inputs) {
      this.readInputLines(input.name, (line, offset) => {
        const entry = parseEntry(line.toString('utf8'));
        if (!entry || !readableFactsVersion(entry.factsVersion)) return;
        const ranked: RankedEntry = {
          entry: rankFields(entry),
          epoch: input.epoch,
          token: input.token,
          input: input.name,
          offset,
          seq: input.seq,
        };
        const held = best.get(entry.file);
        if (!held || compareRankedEntries(ranked, held, this.statOf(entry.file)) > 0) best.set(entry.file, ranked);
      });
      await this.yieldStep();
    }
    const kept = [...best.values()]
      .filter(({ entry }) => this.exists(entry.file) || this.exists(entry.file.replace(/\.zst$/, '')))
      .sort((left, right) =>
        left.entry.pairKey < right.entry.pairKey ? -1 : left.entry.pairKey > right.entry.pairKey ? 1 : 0,
      );
    let text = '';
    let bytes = 0;
    const flush = () => {
      if (!text) return true;
      if (!this.check()) return false;
      const name = this.nextName('shard');
      this.writeAtomically(path.join(this.directory, name), text, true);
      shards.push(name);
      this.fault('compact:shard-written');
      text = '';
      bytes = 0;
      return true;
    };
    for (const ranked of kept) {
      const line = `${this.readInputLine(ranked.input, ranked.offset)}\n`;
      text += line;
      bytes += Buffer.byteLength(line);
      if (bytes >= this.segmentBytes) {
        if (!flush()) return;
        await this.yieldStep();
        if (!this.token) return;
      }
    }
    if (!flush()) return;
    if (!this.check()) return;
    this.fault('compact:before-manifest');
    const manifest: StoreManifest = {
      factsVersion: COMPRESSED_FACTS_VERSION,
      epoch: this.epoch!.e,
      token: this.token!,
      seq: this.seq++,
      shards,
      inputs: inputs.map((stored) => stored.name),
    };
    this.writeAtomically(path.join(this.directory, this.manifestName(manifest)), JSON.stringify(manifest), true);
    this.fault('compact:manifest-saved');
    // A holder paused since its last check retires nothing, because a new holder can have removed the shards it named.
    if (!this.check() || !shards.every((shard) => fs.existsSync(path.join(this.directory, shard)))) return;
    for (const input of inputs) this.remove(input.name);
    this.fault('compact:inputs-deleted');
    for (const stored of view.manifests)
      if (stored.name !== this.manifestName(manifest) && this.ownVersionManifest(stored.name)) this.remove(stored.name);
    this.closedSegments = 0;
    this.lastCompaction = this.now();
    this.fault(recovery ? 'recovery:compacted' : 'compact:done');
  }

  private ownVersionManifest(name: string): boolean {
    const manifest = readManifest(this.directory, name);
    return !manifest || readableFactsVersion(manifest.factsVersion);
  }

  private releaseIfIdle(): void {
    this.cancelIdle = null;
    if (!this.token) return;
    if (this.queue.length || this.running) {
      this.armIdleRelease();
      return;
    }
    this.abandonToken();
  }

  // Close the segment and release the lock at worker exit or dispose.
  dispose(): void {
    this.disposed = true;
    this.cancelRetry?.();
    this.cancelIdle?.();
    this.cancelRetry = null;
    this.cancelIdle = null;
    this.abandonToken();
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) waiter.settle(false);
  }
}

// Each list from the host is the complete set. A name that the store holds in any form needs no second record, because
// the backfill tests a stored entry for currency. Nothing here decodes a rollout.
export async function recordCompressedNames(
  list: readonly string[],
  holder: CompressedStoreHolder,
  options: { now?: () => number; yieldStep?: () => Promise<void>; statOf?: typeof compressedPhysicalStat } = {},
): Promise<void> {
  const now = options.now ?? performance.now.bind(performance);
  const yieldStep = options.yieldStep ?? yieldToEvents;
  const stored = (
    await readCompressedStoreInSteps(holder.directory, options.statOf ?? compressedPhysicalStat, yieldStep)
  ).entries;
  const directories = new Map<string, string>();
  const records: CompressedFactEntry[] = [];
  let sliceStarted = now();
  for (const file of list) {
    if (!stored.has(file))
      records.push({
        file,
        pairKey: compressedPairKey(file, directories),
        ...compressedEntryVersions(),
        nameOnly: true,
      });
    if (now() - sliceStarted >= NAME_SLICE_MS) {
      await yieldStep();
      sliceStarted = now();
    }
  }
  if (records.length) await holder.append(records);
}

// Adopt a twin and record the entry. The result is durable only after the entry's line is on disk, or false when the
// holder is disposed first, so the host keeps the plain path until the entry can no longer be lost.
export async function recordCompressedAdoption(
  adoption: CompressedAdoptionInput,
  facts: CompressedStoreHolder,
  openings: CompressedStoreHolder,
): Promise<CompressedAdoptionResult & { durable: boolean }> {
  const result = await adoptCompressedTwin(adoption);
  const [written] = await facts.append([result.entry]);
  const durable = written || (await facts.durable([result.entry]));
  if (durable && result.adopted && result.entry.opening) await openings.append([compressedOpeningEntry(result.entry)]);
  return { ...result, durable };
}
