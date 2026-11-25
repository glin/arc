// The stores of compressed rollout facts. One directory per store holds an `epoch` file, the lock `backfill.lock`,
// segments of one JSON line per revision, compacted shards and the manifests that name them. Only the worker writes.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { processIsRunning, temporaryWriterGone, writeFileAtomically } from './atomicfile';
import { CODEX_META_VERSION, createExclusive, releaseCodexOpeningsLock, takeCodexOpeningsLock } from './codexopenings';
import { openingRecordOf, readRolloutStat, ROLLOUT_NAME, type CodexSessionMeta } from './codex';
import {
  hashCompressedRollout,
  readCompressedFirstRecord,
  sameStat,
  type CompressedRepair,
} from './compressedrollouts';
import type { DerivedTitleEntry } from './derivedcache';
import { METADATA_GENERATIONS } from './derivedcache';
import { COMPRESSED_BATCH_BYTES, compressedEntryBatches } from './compressedbatches';

import {
  commitSourceStamp,
  sameRelationshipStamp,
  supportedFileIdentity,
  type FileRevision,
  type RelationshipStamp,
} from './transcript';
import {
  spendRecordTotal,
  spendTotalCompare,
  normalizeWorkspace,
  PROJECT_SPEND_PARSER_GENERATIONS,
  type SpendFileIndex,
} from './projectspend';

export { COMPRESSED_BATCH_BYTES, compressedEntryBatches } from './compressedbatches';

// Versions the stored entry. Bump it when a change prevents reuse of an older entry.
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
const FOLLOW_SLICE_BYTES = 4 * 1024 * 1024;
// An entry above this many bytes drops its title entry. The row keeps a carried name and its cost.
export const COMPRESSED_ENTRY_TITLE_BYTES = 1024 * 1024;
// The worker posts at most this many bytes of entries in one batch, or one larger record.
const COMPRESSED_EXACT_LINE_BYTES = 4 * COMPRESSED_BATCH_BYTES;
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
  fileIdentity?: Pick<FileRevision, 'dev' | 'ino'>;
  // A slim seed keeps a conflict even after dropping the disagreeing facts.
  identityConflict?: true;
  // The seed still needs the compressed revision after the title and spend have been dropped.
  factsNeedIdentity?: true;
  // The source that supplied the amount, independently of the compressed envelope that now carries it.
  spendOrigin?: {
    version: 1;
    threadId: string | null;
    sourceIdentity: string | null;
    size?: number;
    mtimeMs?: number;
    hash?: string;
    retained?: true;
  };
  spendNeedsRepair?: true;
  // The original derivation's revision for a carried amount, and the complete revision that superseded older amounts.
  spendRevision?: CompressedSpendRevision;
  spendAuthority?: CompressedSpendRevision;
  // The exact durable line, carried between the worker and host.
  storeRecord?: CompressedStoreRecord;
  // The durable line that supplied held spend when it differs from the ranked envelope.
  spendRecord?: CompressedStoreRecord;
  // An eligible amount that follows a different line than the displayed row.
  spendWitness?: CompressedStoreRecord;
  // A seed omits spend. The line must still be read before replacing a verified amount.
  hasSpend?: true;
  // The openings store saves the retry clock for an accepted repair.
  repairRetry?: { launch: string; source: CompressedRepair; attempts: number; at: number };
  hash?: string;
  // Original order of the compressed facts, independent of the source of any retained spend.
  factsOrder?: CompressedOrder;
  // A later observation of the same bytes can select an earlier, stronger derivation.
  revisionObservation?: CompressedOrder;
  threadId?: string | null;
  decodedLength?: number;
  skippedRecords?: number;
  undercount?: boolean;
  // True when the decode ended on a frame boundary. An adopted entry is complete, because its plain record was.
  complete?: boolean;
  adopted?: boolean;
  adoptionFailed?: boolean;
  nameOnly?: boolean;
  // The backfill could not decode this revision. `unreadableLaunch` names the launch that last tried it, and another
  // launch tries the file once.
  unreadable?: boolean;
  unreadableLaunch?: string;
  title?: DerivedTitleEntry;
  carriedName?: { label: string; fullLabel: string };
  opening?: CodexSessionMeta | null;
  // Only a read of the compressed opening qualifies it for machine placement.
  physicalOpening?: true;
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
  physicalOpening?: { opening: CodexSessionMeta; stamp: RelationshipStamp | null };
  // The stat of the twin that the header read and the hash covered.
  revision: ReturnType<typeof readRolloutStat>;
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

// The session a rollout belongs to: the id of its opening, or the id in its file name for an opening with none.
export function sessionKeyOf(file: string, opening: CodexSessionMeta | null | undefined): string | null {
  return opening?.sessionId ?? ROLLOUT_NAME.exec(path.basename(file).replace(/\.zst$/, ''))?.[1] ?? null;
}

// Take the facts of a plain rollout for its twin. The twin's first line must be an opening of the same thread, the
// times must be equal and the plain spend record must be complete. The twin's stat is one revision across the header
// read and the hash. Anything else discards the plain facts, and the entry marks the twin for the backfill.
export async function adoptCompressedTwin(
  input: CompressedAdoptionInput,
  hash: typeof hashCompressedRollout = hashCompressedRollout,
): Promise<CompressedAdoptionResult> {
  const stamp = commitSourceStamp(input.twin);
  const stat = stamp ? { ...stamp, isFile: true } : readRolloutStat(input.twin);
  let first: string | null = null;
  try {
    if (stat) first = await readCompressedFirstRecord(input.twin, COMPRESSED_ENTRY_TITLE_BYTES, undefined, stat);
  } catch {
    first = null;
  }
  const opening = openingRecordOf(first);
  const threadId = opening?.sessionId ?? null;
  const expected = sessionKeyOf(input.plain, input.opening);
  const failed = (): CompressedAdoptionResult => ({
    adopted: false,
    revision: stat,
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
    !opening ||
    !threadId ||
    threadId !== expected ||
    stat.mtimeMs !== input.plainMtimeMs ||
    !input.spend ||
    input.spend.complete === false
  )
    return failed();
  const hashed = await hash(input.twin);
  if (!hashed || !sameStat(hashed.stat, stat) || !adoptionRevisionCurrent(input.twin, stat, stamp)) return failed();
  return {
    adopted: true,
    physicalOpening: { opening, stamp },
    revision: stat,
    entry: {
      file: input.twin,
      pairKey: compressedPairKey(input.twin),
      ...compressedEntryVersions(),
      size: hashed.stat.size,
      mtimeMs: hashed.stat.mtimeMs,
      fileIdentity: { dev: hashed.stat.dev, ino: hashed.stat.ino },
      hash: hashed.hash,
      threadId,
      complete: true,
      adopted: true,
      skippedRecords: 0,
      undercount: false,
      ...(input.title ? { title: { ...input.title, size: hashed.stat.size, mtimeMs: hashed.stat.mtimeMs } } : {}),
      opening: input.opening ?? opening,
      spend: input.spend,
      spendOrigin: compressedSpendOrigin(threadId, input.spend),
    },
  };
}

function adoptionRevisionCurrent(
  file: string,
  revision: CompressedAdoptionResult['revision'],
  stamp: RelationshipStamp | null,
): boolean {
  return stamp ? sameRelationshipStamp(commitSourceStamp(file), stamp) : sameStat(readRolloutStat(file), revision);
}

// The physical opening and revision that the machine store uses to place a rollout.
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
    fileIdentity: compressedEntryIdentity(entry) ?? undefined,
    threadId: entry.threadId,
    opening: entry.opening,
    physicalOpening: true,
    hash: entry.hash,
  };
}

// An entry above 1 MiB drops its title entry and keeps a carried name and its cost.
export function boundedCompressedEntry(entry: CompressedFactEntry): CompressedFactEntry {
  if (!entry.title || Buffer.byteLength(JSON.stringify(entry)) < COMPRESSED_ENTRY_TITLE_BYTES) return entry;
  const { title, ...rest } = entry;
  return { ...rest, carriedName: { label: title.label, fullLabel: title.fullLabel } };
}

export function compressedSpendOrigin(
  threadId: CompressedFactEntry['threadId'],
  spend: SpendFileIndex,
  hash?: string,
): NonNullable<CompressedFactEntry['spendOrigin']> {
  return {
    version: 1,
    threadId: threadId ?? null,
    sourceIdentity: spend.sourceIdentity ?? null,
    size: spend.size,
    mtimeMs: spend.mtimeMs,
    hash,
  };
}

function verifiedSpendOrigin(entry: CompressedFactEntry): boolean {
  const origin = entry.spendOrigin;
  return (
    origin?.version === 1 &&
    origin.threadId === (entry.threadId ?? null) &&
    (!entry.spend ||
      (origin.sourceIdentity === (entry.spend.sourceIdentity ?? null) &&
        origin.size === entry.spend.size &&
        origin.mtimeMs === entry.spend.mtimeMs)) &&
    (origin.retained || entry.adopted || origin.hash === entry.hash)
  );
}

// A legacy marked total can belong to an earlier session even when its physical witnesses agree.
export function quarantineCompressedSpend(entry: CompressedFactEntry): CompressedFactEntry {
  if (!entry.spend || !entry.undercount || verifiedSpendOrigin(entry)) return entry;
  const identity = compressedEntryIdentity(entry);
  const { spend: _spend, spendOrigin: _origin, spendRevision: _revision, spendAuthority: _authority, ...facts } = entry;
  return {
    ...facts,
    spendNeedsRepair: true,
    ...(identity === null ? { identityConflict: true } : identity ? { fileIdentity: identity } : {}),
  };
}

// Keep applicable spend when both entries belong to the same rollout and session.
export function withKeptUndercount(
  previous: CompressedFactEntry | undefined,
  next: CompressedFactEntry,
  quotedAt?: number,
  afterCoverage = false,
): CompressedFactEntry {
  if (!next.spend || (!next.undercount && !next.unreadable && !next.adopted)) return next;
  const donor = previous && compressedFactsSameOwner(previous, next) ? previous : undefined;
  const heldAuthority = donor && completeSpendRevision(donor);
  if (!next.undercount && !next.unreadable) {
    const revision = spendRevision(next);
    return donor &&
      donor.hash === next.hash &&
      sameDecodedSpend(heldAuthority, revision) &&
      compareRevisionStats(heldAuthority, revision) === 0
      ? donor
      : next;
  }
  const authority = laterSpendRevision(heldAuthority, completeSpendRevision(next));
  const result = authority === next.spendAuthority ? next : { ...next, spendAuthority: authority };
  const revision = spendRevision(next);
  // Coverage under the lease puts this new measurement after the same-byte adoption. Retained amounts keep their rank.
  const followsAdoption =
    afterCoverage &&
    !!donor &&
    !!authority &&
    !authority.decoded &&
    !!authority.order &&
    authority.hash === next.hash &&
    compareRevisionStats(authority, revision) === 0 &&
    !revision.order &&
    !next.storeRecord &&
    !recordedFactsOrder(next) &&
    !next.spendOrigin?.retained &&
    !next.spendRecord &&
    !next.adopted &&
    next.undercount &&
    verifiesCompressedBytes(next) &&
    verifiedSpendOrigin(next) &&
    eligibleCompressedSpend(next);
  const superseded = !followsAdoption && precedesSpendAuthority(revision, authority);
  if (!donor || !eligibleCompressedSpend(donor) || precedesSpendAuthority(spendRevision(donor), authority)) {
    if (!superseded) return result;
    const { spend: _spend, spendOrigin: _origin, spendRevision: _revision, spendRecord: _record, ...facts } = result;
    return { ...facts, spendNeedsRepair: true };
  }
  if (!superseded && compareSpendEntries(donor, next, quotedAt) <= 0) return result;
  return withSpendFrom(result, donor);
}

function withSpendFrom(entry: CompressedFactEntry, donor: CompressedFactEntry): CompressedFactEntry {
  const spend = donor.spend!;
  return {
    ...entry,
    spend,
    spendRecord: donor.spendRecord ?? donor.storeRecord,
    spendRevision: spendRevision(donor),
    undercount: true,
    spendOrigin: {
      ...(donor.spendOrigin ?? compressedSpendOrigin(donor.threadId, spend, donor.hash)),
      retained: true,
    },
  };
}

function eligibleCompressedSpend(entry: CompressedFactEntry): boolean {
  return (
    !!entry.spend &&
    entry.spendGeneration === PROJECT_SPEND_PARSER_GENERATIONS.codex &&
    !entry.spendNeedsRepair &&
    (!entry.undercount || verifiedSpendOrigin(entry)) &&
    !entry.nameOnly &&
    !entry.adoptionFailed &&
    !!entry.threadId &&
    compressedEntryIdentity(entry) !== null
  );
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

type CompressedRevision = Pick<FileRevision, 'size' | 'mtimeMs'> & Partial<Pick<FileRevision, 'dev' | 'ino'>>;
type CompressedIdentity = NonNullable<CompressedFactEntry['fileIdentity']>;

function spendFileIdentity(spend: SpendFileIndex | undefined): CompressedIdentity | undefined {
  if (typeof spend?.sourceIdentity !== 'string') return undefined;
  const parts = spend.sourceIdentity.split(':');
  const identity = { dev: parts[0], ino: parts[1] };
  return parts.length === 2 && supportedFileIdentity(identity) ? identity : undefined;
}

// A decoded entry can store the compressed identity in its title and spend. An adopted entry stores plain identities there.
export function compressedEntryIdentity(entry: CompressedFactEntry): CompressedIdentity | null | undefined {
  const { opening, threadId } = entry;
  if (entry.identityConflict || (opening?.sessionId && threadId && opening.sessionId !== threadId)) return null;
  let identity = entry.fileIdentity && supportedFileIdentity(entry.fileIdentity) ? entry.fileIdentity : undefined;
  const title = entry.title?.sourceIdentity;
  const spend = spendFileIdentity(entry.spend);
  if (entry.spendOrigin && !verifiedSpendOrigin(entry)) return null;
  if (entry.adopted) {
    return title && supportedFileIdentity(title) && spend && !compressedIdentityMatches(title, spend) ? null : identity;
  }
  for (const witness of [title, entry.spendOrigin?.retained ? undefined : spend]) {
    if (!witness || !supportedFileIdentity(witness)) continue;
    if (identity && !compressedIdentityMatches(identity, witness)) return null;
    identity ??= witness;
  }
  return identity;
}

export function compressedFactsSameOwner(previous: CompressedFactEntry, next: CompressedFactEntry): boolean {
  if (previous.file !== next.file || !previous.threadId || previous.threadId !== next.threadId) return false;
  const before = compressedEntryIdentity(previous);
  const after = compressedEntryIdentity(next);
  return !!(
    before !== null &&
    after !== null &&
    ((before && after && compressedIdentityMatches(before, after)) || (previous.hash && previous.hash === next.hash))
  );
}

function compressedIdentityConflicts(
  identity: CompressedIdentity | null | undefined,
  stat: CompressedRevision,
): boolean {
  return identity === null || !!(identity && supportedFileIdentity(stat) && !compressedIdentityMatches(identity, stat));
}

export function compressedEntryConflicts(entry: CompressedFactEntry, stat: CompressedRevision): boolean {
  return compressedIdentityConflicts(compressedEntryIdentity(entry), stat);
}

function factsNeedIdentity(entry: CompressedFactEntry): boolean {
  return (
    entry.factsNeedIdentity === true ||
    (entry.decodedLength !== undefined && !!(entry.title || entry.spend || entry.carriedName))
  );
}

// An entry is current when its revision and parser versions match.
export function compressedEntryCurrent(entry: CompressedFactEntry, stat: CompressedRevision | null): boolean {
  if (
    !stat ||
    entry.spendNeedsRepair ||
    entry.size !== stat.size ||
    entry.mtimeMs !== stat.mtimeMs ||
    entry.factsVersion !== COMPRESSED_FACTS_VERSION ||
    entry.codexMetaVersion !== CODEX_META_VERSION ||
    entry.metadataGeneration !== METADATA_GENERATIONS.codex ||
    entry.spendGeneration !== PROJECT_SPEND_PARSER_GENERATIONS.codex
  )
    return false;
  const identity = compressedEntryIdentity(entry);
  return (
    !compressedIdentityConflicts(identity, stat) &&
    (!!identity || !factsNeedIdentity(entry) || !supportedFileIdentity(stat))
  );
}

function compressedIdentityMatches(
  identity: Partial<Pick<FileRevision, 'dev' | 'ino'>>,
  stat: Partial<Pick<FileRevision, 'dev' | 'ino'>>,
): boolean {
  return (
    supportedFileIdentity(identity) &&
    supportedFileIdentity(stat) &&
    String(identity.dev) === String(stat.dev) &&
    String(identity.ino) === String(stat.ino)
  );
}

// A contested row takes display facts only from the revision its opening qualified.
export function compressedFactsMatchSource(entry: CompressedFactEntry, source: CompressedRevision): boolean {
  if (entry.unreadable || entry.size !== source.size || entry.mtimeMs !== source.mtimeMs) return false;
  const identity = compressedEntryIdentity(entry);
  if (identity) return compressedIdentityMatches(identity, source);
  return identity !== null && !entry.title && !entry.spend && !entry.carriedName;
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

function readManifest(directory: string, name: string, onUnreadable?: (name: string) => void): StoreManifest | null {
  try {
    const manifest = parseManifest(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (!manifest) onUnreadable?.(name);
    return manifest;
  } catch {
    onUnreadable?.(name);
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
      ? quarantineCompressedSpend(value as CompressedFactEntry)
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
export function compressedPhysicalStat(file: string): CompressedRevision | null {
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
  fileIdentity?: CompressedIdentity | null;
  threadId?: string | null;
  hash?: string;
  decodedLength?: number;
  spendNeedsRepair?: true;
  verifiedBytes?: boolean;
  fullDecode?: boolean;
  adoptionFailed?: boolean;
  nameOnly?: boolean;
}

function verifiesCompressedBytes(entry: CompressedFactEntry): boolean {
  return (
    entry.factsVersion === COMPRESSED_FACTS_VERSION &&
    entry.codexMetaVersion === CODEX_META_VERSION &&
    entry.metadataGeneration === METADATA_GENERATIONS.codex &&
    entry.spendGeneration === PROJECT_SPEND_PARSER_GENERATIONS.codex &&
    !!entry.hash &&
    !!entry.threadId &&
    !entry.unreadable &&
    !entry.spendNeedsRepair &&
    !entry.adoptionFailed &&
    !entry.nameOnly &&
    (!!entry.adopted || entry.decodedLength !== undefined)
  );
}

function rankFields(entry: CompressedFactEntry): RankFields {
  return {
    file: entry.file,
    pairKey: entry.pairKey,
    factsVersion: entry.factsVersion,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    fileIdentity: compressedEntryIdentity(entry),
    threadId: entry.threadId,
    hash: entry.hash,
    decodedLength: entry.decodedLength,
    spendNeedsRepair: entry.spendNeedsRepair,
    verifiedBytes: verifiesCompressedBytes(entry),
    fullDecode: entry.decodedLength !== undefined && !entry.adopted && entry.complete !== false && !entry.undercount,
    adoptionFailed: entry.adoptionFailed,
    nameOnly: entry.nameOnly,
  };
}

// An entry without its title entry and spend record. The worker keeps it to plan the backfill, and the host sends it to
// a new worker, so that worker reads no store bytes it already answered.
export type CompressedEntrySeed = Omit<CompressedFactEntry, 'title' | 'spend' | 'carriedName'>;

export function compressedEntrySeed(entry: CompressedFactEntry): CompressedEntrySeed {
  const { title: _title, spend, carriedName: _carried, ...seed } = entry;
  if (spend) {
    seed.hasSpend = true;
    if (entry.unreadable && !entry.spendOrigin?.retained) seed.spendRevision = spendRevision(entry);
  }
  const identity = compressedEntryIdentity(entry);
  if (identity === null) return { ...seed, identityConflict: true };
  if (identity) return { ...seed, fileIdentity: identity };
  return factsNeedIdentity(entry) ? { ...seed, factsNeedIdentity: true } : seed;
}

export interface CompressedLoadResume {
  consumed: [string, number][];
  entries: CompressedEntrySeed[];
  // The names the store holds with no facts, which the offsets cover and the host holds only as paths.
  nameOnly?: string[];
  lineage?: CompressedLineage[];
}

interface CompressedRankReference {
  entry: RankFields;
  record: CompressedStoreRecord;
  observation?: CompressedOrder;
}

interface CompressedSpendReference {
  amount: CompressedRankReference;
  baseline?: CompressedRankReference;
}

export interface CompressedLineage {
  file: string;
  // A selected seed marks a live group. A file alone removes the previous group.
  selected?: CompressedEntrySeed;
  // Indices share exact addresses across row, observation and spend. The selected row uses -1.
  sources?: CompressedRankReference[];
  latest?: number;
  alternatives?: number[];
  spend?: [hash: string, amount: number, baseline?: number][];
}

export interface CompressedStoreRecord {
  input: string;
  offset: number;
  bytes: number;
  digest: string;
  spendDigest?: string;
  order?: CompressedOrder;
  spendRevision?: CompressedSpendRevision;
}

type CompressedOrder = [epoch: number, token: string, sequence: number, offset: number];

interface CompressedSpendRevision {
  mtimeMs?: number;
  size?: number;
  hash?: string;
  decoded?: true;
  order?: CompressedOrder;
  observation?: CompressedOrder;
}

function spendRevision(entry: CompressedFactEntry, ranked?: RankedEntry): CompressedSpendRevision {
  const stored = entry.spendRevision ?? entry.spendRecord?.spendRevision ?? entry.storeRecord?.spendRevision;
  const origin = entry.spendOrigin;
  if (origin?.retained) {
    if (stored && (stored.hash || stored.mtimeMs === origin.mtimeMs)) return stored;
    return { mtimeMs: origin.mtimeMs };
  }
  // A failed read only supplies a new envelope. An old spend size measures plain or decoded bytes.
  if (entry.unreadable) return { mtimeMs: origin?.mtimeMs ?? entry.spend?.mtimeMs ?? entry.spendRevision?.mtimeMs };
  const source = ranked ?? (entry.storeRecord && rankedRecord(entry));
  const order = stored?.order ?? (source && factsOrder(source));
  return {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    hash: entry.hash,
    decoded:
      entry.decodedLength !== undefined && !entry.adopted && entry.complete !== false && !entry.undercount
        ? true
        : undefined,
    order,
  };
}

function completeSpendRevision(entry: CompressedFactEntry, ranked?: RankedEntry): CompressedSpendRevision | undefined {
  if (
    !entry.spendNeedsRepair &&
    !entry.nameOnly &&
    !entry.adoptionFailed &&
    entry.spendGeneration === PROJECT_SPEND_PARSER_GENERATIONS.codex &&
    entry.complete !== false &&
    !entry.undercount &&
    !entry.unreadable &&
    !entry.spendOrigin?.retained &&
    (entry.spend || entry.hasSpend)
  ) {
    const revision = spendRevision(entry, ranked);
    const observation = entry.revisionObservation ?? ranked?.observation;
    return observation ? { ...revision, observation } : revision;
  }
  return entry.spendAuthority;
}

function sameDecodedSpend(
  left: CompressedSpendRevision | undefined,
  right: CompressedSpendRevision,
): left is CompressedSpendRevision & { decoded: true } {
  return !!(left?.decoded && left.hash && left.hash === right.hash);
}

function compareSpendRevisions(left: CompressedSpendRevision, right: CompressedSpendRevision): number {
  const revision = compareRevisionStats(left, right);
  if (revision) return revision;
  if (sameDecodedSpend(left, right) || sameDecodedSpend(right, left)) {
    const decoded = Number(!!left.decoded) - Number(!!right.decoded);
    if (decoded) return decoded;
  }
  if (left.hash && left.hash === right.hash) return compareOrder(left.order, right.order);
  return compareOrder(left.observation ?? left.order, right.observation ?? right.order);
}

function compareOrder(left: CompressedOrder | undefined, right: CompressedOrder | undefined): number {
  if (!left || !right) return Number(!!left) - Number(!!right);
  const [aEpoch, aToken, aSequence, aOffset] = left;
  const [bEpoch, bToken, bSequence, bOffset] = right;
  return (
    aEpoch - bEpoch || (aToken === bToken ? 0 : aToken > bToken ? 1 : -1) || aSequence - bSequence || aOffset - bOffset
  );
}

function compareSpendEntries(left: CompressedFactEntry, right: CompressedFactEntry, quotedAt?: number): number {
  return (
    spendTotalCompare(left.spend!, right.spend!, quotedAt) ||
    compareSpendRevisions(spendRevision(left), spendRevision(right))
  );
}

function laterSpendRevision(
  left: CompressedSpendRevision | undefined,
  right: CompressedSpendRevision | undefined,
): CompressedSpendRevision | undefined {
  if (!left || !right) return left ?? right;
  const rank = compareSpendRevisions(left, right);
  return rank > 0 || (rank === 0 && compareOrder(left.observation, right.observation) > 0) ? left : right;
}

function precedesSpendAuthority(
  revision: CompressedSpendRevision | undefined,
  authority: CompressedSpendRevision | undefined,
): boolean {
  return !!revision && !!authority && compareSpendRevisions(revision, authority) < 0;
}

export type CompressedSpendRequest = {
  file: string;
  record: CompressedStoreRecord;
};

function spendDigest(spend: SpendFileIndex | undefined): string | undefined {
  return spend && recordDigest(JSON.stringify(spend));
}

function recordDigest(line: Buffer | string): string {
  return createHash('sha256').update(line).digest('base64url');
}

// A host can return the exact amount it kept from a line that an older compactor retired.
export function heldCompressedSpend(
  entry: CompressedFactEntry | undefined,
  { file, record }: CompressedSpendRequest,
): CompressedFactEntry | undefined {
  const held = entry?.spendRecord ?? entry?.storeRecord;
  if (
    !entry ||
    entry.file !== file ||
    held?.digest !== record.digest ||
    !record.spendDigest ||
    !eligibleCompressedSpend(entry) ||
    spendDigest(entry.spend) !== record.spendDigest
  )
    return undefined;
  const revision = spendRevision(entry);
  const requested = record.spendRevision;
  if (
    requested &&
    (requested.hash !== revision.hash ||
      requested.mtimeMs !== revision.mtimeMs ||
      requested.size !== revision.size ||
      requested.decoded !== revision.decoded ||
      compareOrder(requested.order, revision.order) !== 0)
  )
    return undefined;
  const { pairKey, fileIdentity, size, mtimeMs, threadId, hash, spend, spendOrigin, adopted, unreadable, undercount } =
    entry;
  const witness = {
    file,
    pairKey,
    fileIdentity: compressedEntryIdentity(entry) ?? fileIdentity,
    size,
    mtimeMs,
    threadId,
    hash,
    spend,
    spendOrigin,
    spendRevision: revision,
    spendAuthority: completeSpendRevision(entry),
    decodedLength: entry.decodedLength,
    revisionObservation: entry.revisionObservation,
    complete: entry.complete,
    adopted,
    unreadable,
    undercount,
    factsVersion: entry.factsVersion,
    codexMetaVersion: entry.codexMetaVersion,
    metadataGeneration: entry.metadataGeneration,
    spendGeneration: entry.spendGeneration,
    storeRecord: held,
  };
  return Buffer.byteLength(JSON.stringify(witness)) <= COMPRESSED_BATCH_BYTES ? witness : undefined;
}

interface RankedEntry {
  entry: RankFields;
  epoch: number;
  token: string;
  // The file and byte offset of the line. `seq` orders a holder's files in the order it wrote them.
  input: string;
  offset: number;
  seq: number;
  order?: CompressedOrder;
  observation?: CompressedOrder;
  record?: CompressedStoreRecord;
  completeSpend?: RankedSpend;
}

function rankSummary(ranked: RankedEntry): CompressedRankReference {
  return {
    entry: ranked.entry,
    record: { ...ranked.record!, order: factsOrder(ranked) },
    observation: ranked.observation,
  };
}

function rankReference({ entry, record, observation }: CompressedRankReference): RankedEntry {
  const input = storeName(record.input)!;
  return {
    entry,
    record,
    order: record.order,
    observation,
    epoch: input.epoch,
    token: input.token,
    input: input.name,
    offset: record.offset,
    seq: input.seq,
  };
}

function factsOrder(ranked: RankedEntry): CompressedOrder | undefined {
  return ranked.order ?? (ranked.epoch < 0 ? undefined : [ranked.epoch, ranked.token, ranked.seq, ranked.offset]);
}

function recordedFactsOrder(entry: CompressedEntrySeed): CompressedOrder | undefined {
  if (entry.factsOrder) return entry.factsOrder;
  const revision = entry.spendRevision;
  if (
    revision &&
    !entry.unreadable &&
    !entry.spendOrigin?.retained &&
    revision.mtimeMs === entry.mtimeMs &&
    revision.size === entry.size &&
    (!revision.hash || revision.hash === entry.hash)
  )
    return revision.order;
  return undefined;
}

function rankedLine(entry: CompressedFactEntry, input: StoreName, offset: number): RankedEntry {
  return {
    entry: rankFields(entry),
    epoch: input.epoch,
    token: input.token,
    input: input.name,
    offset,
    seq: input.seq,
    order: recordedFactsOrder(entry),
  };
}

function compareRevisionStats(
  left: Pick<RankFields, 'mtimeMs' | 'size'>,
  right: Pick<RankFields, 'mtimeMs' | 'size'>,
): number {
  return (left.mtimeMs ?? -1) - (right.mtimeMs ?? -1) || (left.size ?? -1) - (right.size ?? -1);
}

function currentStatRank(entry: RankFields, stat: CompressedRevision | null): number {
  if (!stat || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs || entry.fileIdentity === null) return 0;
  if (!entry.fileIdentity || !supportedFileIdentity(stat)) return 1;
  return compressedIdentityMatches(entry.fileIdentity, stat) ? 2 : 0;
}

// Compares derivations within the selected bytes, and entries that lack comparable byte observations.
export function compareRankedEntries(left: RankedEntry, right: RankedEntry, stat: CompressedRevision | null): number {
  const a = left.entry;
  const b = right.entry;
  const version =
    Number(a.factsVersion === COMPRESSED_FACTS_VERSION) - Number(b.factsVersion === COMPRESSED_FACTS_VERSION);
  if (version) return version;
  const statRank = currentStatRank(a, stat) - currentStatRank(b, stat);
  if (statRank) return statRank;
  const revision = compareRevisionStats(a, b);
  if (revision) return revision;
  // A current derived or terminal entry replaces an ambiguous amount, including across compaction and old writers.
  const verified = Number(!a.spendNeedsRepair) - Number(!b.spendNeedsRepair);
  if (verified) return verified;
  if (a.verifiedBytes && b.verifiedBytes && a.hash === b.hash && rankedSameOwner(left, right)) {
    const full = Number(!!a.fullDecode) - Number(!!b.fullDecode);
    if (full) return full;
  }
  const decoded = Number(a.decodedLength !== undefined) - Number(b.decodedLength !== undefined);
  if (decoded) return decoded;
  const withFacts = (entry: RankFields) => (entry.adoptionFailed || entry.nameOnly ? 0 : 1);
  // An `unreadable` entry with no facts carries `nameOnly`, so this rank also orders it below an entry with facts.
  const facts = withFacts(a) - withFacts(b);
  if (facts) return facts;
  return (
    compareOrder(factsOrder(left), factsOrder(right)) ||
    left.epoch - right.epoch ||
    (left.token === right.token ? 0 : left.token > right.token ? 1 : -1) ||
    left.seq - right.seq ||
    left.offset - right.offset
  );
}

function rankedRecord(entry: CompressedEntrySeed): RankedEntry {
  const ref = entry.storeRecord;
  const input = ref && storeName(ref.input);
  return {
    entry: rankFields(entry),
    epoch: input ? input.epoch : -1,
    token: input ? input.token : '',
    input: input ? input.name : '',
    offset: ref?.offset ?? -1,
    seq: input ? input.seq : -1,
    order: recordedFactsOrder(entry) ?? ref?.order,
    observation: entry.revisionObservation,
    record: ref,
  };
}

export function compareCompressedEntries(
  left: CompressedEntrySeed,
  right: CompressedEntrySeed,
  stat: CompressedRevision | null,
): number {
  const a = rankedRecord(left);
  const b = rankedRecord(right);
  if (a.entry.hash !== b.entry.hash && comparableObservations(a, b, stat))
    return compareOrder(observationOrder(a), observationOrder(b));
  return compareRankedEntries(a, b, stat);
}

function observationOrder(ranked: RankedEntry): CompressedOrder | undefined {
  return ranked.observation ?? factsOrder(ranked);
}

export interface CompressedByteObservation {
  hash: string;
  order: CompressedOrder;
}

// The recorded compressed envelope supplies this observation. Carried amounts supply no byte evidence.
export function compressedByteObservation(entry: CompressedEntrySeed): CompressedByteObservation | undefined {
  if (!entry.hash || !verifiesCompressedBytes(entry) || compressedEntryIdentity(entry) === null) return undefined;
  const order = observationOrder(rankedRecord(entry));
  return order && { hash: entry.hash, order };
}

export function compareCompressedObservations(
  left: CompressedByteObservation,
  right: CompressedByteObservation,
): number {
  return compareOrder(left.order, right.order);
}

function comparableObservations(a: RankedEntry, b: RankedEntry, stat: CompressedRevision | null): boolean {
  const before = a.entry.fileIdentity;
  const after = b.entry.fileIdentity;
  return (
    !!a.entry.verifiedBytes &&
    !!b.entry.verifiedBytes &&
    a.entry.size !== undefined &&
    a.entry.mtimeMs !== undefined &&
    compareRevisionStats(a.entry, b.entry) === 0 &&
    currentStatRank(a.entry, stat) === currentStatRank(b.entry, stat) &&
    (!before || !after || compressedIdentityMatches(before, after)) &&
    (rankedSameOwner(a, b) ||
      (a.entry.file === b.entry.file && !!before && !!after && a.entry.hash !== b.entry.hash)) &&
    (a.entry.hash === b.entry.hash || (!!observationOrder(a) && !!observationOrder(b)))
  );
}

interface RankedFacts {
  row: RankedEntry;
  latest: RankedEntry;
  alternatives?: Map<string, RankedEntry>;
}

function preserveRecordedOrder(
  ranked: RankedEntry,
  entry: CompressedFactEntry,
  held?: RankedFacts,
  spend?: CompressedSpendReference,
): void {
  const record = ranked.record;
  if (ranked.order || !record || !held) return;
  const { digest } = record;
  const prior = [held.latest, held.alternatives?.get(entry.hash!), held.row].find(
    (source) => source?.record?.digest === digest,
  );
  const amount = [spend?.amount, spend?.baseline].find((source) => source?.record.digest === digest);
  if (!prior && !amount) return;
  ranked.order = prior ? factsOrder(prior) : amount?.record.order;
  record.order = ranked.order;
  if (record.spendRevision) record.spendRevision = spendRevision(entry, ranked);
}

function rankFacts(held: RankedFacts | undefined, next: RankedEntry, stat: CompressedRevision | null): RankedFacts {
  if (!held) return { row: next, latest: next };
  if (!comparableObservations(held.latest, next, stat))
    return compareRankedEntries(next, held.row, stat) <= 0 ? held : { row: next, latest: next };
  const order = compareOrder(observationOrder(next), observationOrder(held.latest));
  // The same physical path can acquire a different owner. Facts and spend still rank within one owner.
  if (!rankedSameOwner(held.latest, next)) return order > 0 ? { row: next, latest: next } : held;
  const hash = next.entry.hash!;
  const latest =
    order > 0 ||
    (order === 0 && next.entry.hash === held.latest.entry.hash && compareRankedEntries(next, held.latest, stat) > 0)
      ? next
      : held.latest;
  let alternatives = held.alternatives;
  const earlier = alternatives?.get(hash) ?? (held.row.entry.hash === hash ? held.row : undefined);
  const strongest = earlier && compareRankedEntries(next, earlier, stat) <= 0 ? earlier : next;
  if (strongest !== earlier && (alternatives || held.row.entry.hash !== hash)) {
    alternatives = new Map(alternatives ?? [[held.row.entry.hash!, held.row]]);
    alternatives.set(hash, strongest);
  }
  const row = latest.entry.hash === hash ? strongest : held.row;
  if (row === held.row && latest === held.latest && alternatives === held.alternatives) return held;
  return { row, latest, alternatives };
}

function hasDistinctObservation(facts: RankedFacts): boolean {
  return !!facts.latest.record && facts.latest.record.digest !== facts.row.record?.digest;
}

// Only later observations of the same bytes travel with the chosen row.
function observedEntry(entry: CompressedFactEntry, facts: RankedFacts): CompressedFactEntry {
  const observation = observationOrder(facts.latest);
  const revisionObservation = compareOrder(observation, factsOrder(facts.row)) > 0 ? observation : undefined;
  return entry.revisionObservation === revisionObservation ? entry : { ...entry, revisionObservation };
}

export function reconcileCompressedEntries(
  held: CompressedFactEntry,
  next: CompressedFactEntry,
  stat: CompressedRevision | null = null,
): CompressedFactEntry | undefined {
  if (!held.hash || !next.hash) return undefined;
  const before = rankedRecord(held);
  const after = rankedRecord(next);
  if (!comparableObservations(before, after, stat)) return undefined;
  const selected = rankFacts({ row: before, latest: before }, after, stat);
  const keepHeld =
    selected.row === before &&
    (before.entry.hash !== after.entry.hash || compareRankedEntries(before, after, stat) > 0);
  const row = keepHeld ? held : next;
  return observedEntry(row, selected);
}

interface RankedSpend {
  ranked: RankedEntry;
  revision: CompressedSpendRevision;
  authority: CompressedSpendRevision | undefined;
  authorityLine: RankedEntry | undefined;
  total: ReturnType<typeof spendRecordTotal>;
}

function spendSummary(spend: RankedSpend, hash: string): CompressedSpendReference | undefined {
  if (!spend.ranked.record || spend.revision.hash !== hash) return undefined;
  const baseline = spend.authority?.hash === hash ? spend.authorityLine : undefined;
  return {
    amount: rankSummary(spend.ranked),
    baseline:
      baseline?.record && baseline.record.digest !== spend.ranked.record.digest ? rankSummary(baseline) : undefined,
  };
}

function rankedSameOwner(a: RankedEntry, b: RankedEntry): boolean {
  const { file, fileIdentity, threadId, hash } = a.entry;
  const other = b.entry;
  return (
    file === other.file &&
    !!threadId &&
    threadId === other.threadId &&
    fileIdentity !== null &&
    other.fileIdentity !== null &&
    ((!!fileIdentity && !!other.fileIdentity && compressedIdentityMatches(fileIdentity, other.fileIdentity)) ||
      (!!hash && hash === other.hash))
  );
}

// An authoritative revision can lower its contribution. A later partial revision can only raise it for the same owner.
function selectedCompleteSpend(facts: RankedFacts): RankedSpend | undefined {
  const spend = facts.row.completeSpend;
  if (!spend?.authority) return undefined;
  const observation = observationOrder(facts.latest);
  if (compareOrder(observation, spend.authority.order) <= 0) return spend;
  return { ...spend, authority: { ...spend.authority, observation } };
}

function noteCompleteSpend(entry: CompressedFactEntry, ranked: RankedEntry, quotedAt: number): void {
  if (!ranked.entry.verifiedBytes || !eligibleCompressedSpend(entry)) return;
  const revision = completeSpendRevision(entry, ranked);
  if (!revision || entry.spendOrigin?.retained || entry.undercount || entry.complete === false) return;
  ranked.completeSpend = {
    ranked,
    revision: spendRevision(entry, ranked),
    authority: revision,
    authorityLine: ranked,
    total: spendRecordTotal(entry.spend!, quotedAt),
  };
}

function rankSpend(
  entry: CompressedFactEntry,
  ranked: RankedEntry,
  held: RankedSpend | undefined,
  quotedAt: number,
  resumedAuthority?: CompressedSpendRevision,
  complete?: RankedSpend,
): RankedSpend | undefined {
  const previous = held;
  const selectedAuthority = complete?.authority;
  if (complete && (!held || precedesSpendAuthority(held.revision, selectedAuthority))) held = complete;
  resumedAuthority = laterSpendRevision(resumedAuthority, selectedAuthority);
  const selected = held !== previous ? held : undefined;
  if (!eligibleCompressedSpend(entry)) return selected;
  if (held && !rankedSameOwner(held.ranked, ranked)) {
    if (compareRankedEntries(ranked, held.ranked, null) <= 0) return selected;
    held = undefined;
  }
  const revision = spendRevision(entry, ranked);
  const supplied = completeSpendRevision(entry, ranked);
  const authority = laterSpendRevision(laterSpendRevision(held?.authority, resumedAuthority), supplied);
  const authorityLine = supplied && authority === supplied ? ranked : held?.authorityLine;
  if (precedesSpendAuthority(revision, authority)) {
    return held && authority !== held.authority && !precedesSpendAuthority(held.revision, authority)
      ? { ...held, authority, authorityLine }
      : selected;
  }
  const total = ranked.completeSpend?.total ?? spendRecordTotal(entry.spend!, quotedAt);
  if (!held || precedesSpendAuthority(held.revision, authority))
    return { ranked, revision, authority, authorityLine, total };
  const amount = total.dollars - held.total.dollars || total.requests - held.total.requests;
  if (amount > 0 || (!amount && compareSpendRevisions(revision, held.revision) > 0))
    return { ranked, revision, authority, authorityLine, total };
  if (authority !== held.authority) return { ...held, authority, authorityLine };
  return selected;
}

interface StoreView {
  // The fact-version files that a reader merges, in reading order.
  inputs: StoreName[];
  manifests: StoreName[];
  valid: StoreManifest[];
  current: StoreManifest | null;
  retired: Set<string>;
}

// An absent store is empty. Any other failure tells the caller that the read did not see the store.
function listDirectory(directory: string, onUnreadable?: (name: string) => void): string[] {
  try {
    return fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onUnreadable?.(directory);
    return [];
  }
}

// The files that this build can read: its own fact version and older ones. A manifest is valid when all its shards are present. A reader ignores a shard
// that no valid manifest names and skips an input that one names.
function storeView(directory: string, names: readonly string[], onUnreadable?: (name: string) => void): StoreView {
  const present = new Set(names);
  const parsed = names.flatMap((name) => {
    const stored = storeName(name);
    return stored ? [stored] : [];
  });
  const manifests = parsed.filter((stored) => stored.kind === 'manifest');
  const valid: StoreManifest[] = [];
  for (const stored of manifests) {
    const manifest = readManifest(directory, stored.name, onUnreadable);
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
  inputs.sort(
    (left, right) => left.epoch - right.epoch || left.token.localeCompare(right.token) || left.seq - right.seq,
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
  onUnreadable?: (name: string) => void,
): CompressedStoreRead {
  const steps = storeReadSteps(directory, statOf, onUnreadable);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

// The same read with a yield after each file, so no step holds the worker past one file of at most 4 MiB and one entry.
export async function readCompressedStoreInSteps(
  directory: string,
  statOf: (file: string) => { size: number; mtimeMs: number } | null,
  yieldStep: () => Promise<void> = yieldToEvents,
  onUnreadable?: (name: string) => void,
): Promise<CompressedStoreRead> {
  const steps = storeReadSteps(directory, statOf, onUnreadable);
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
  onUnreadable?: (name: string) => void,
): Generator<void, CompressedStoreRead, void> {
  const names = listDirectory(directory, onUnreadable);
  const view = storeView(directory, names, onUnreadable);
  const best = new Map<string, { facts: RankedFacts; entry: CompressedFactEntry }>();
  for (const input of view.inputs) {
    if (!readableFactsVersion(fileFactsVersion(path.join(directory, input.name)))) continue;
    const readLine = (line: Buffer, offset: number) => {
      const entry = parseEntry(line.toString('utf8'));
      if (!entry || !readableFactsVersion(entry.factsVersion)) return;
      const ranked = rankedLine(entry, input, offset);
      const held = best.get(entry.file);
      if (ranked.entry.verifiedBytes) {
        ranked.record = referenceOf(entry, ranked, line);
        preserveRecordedOrder(ranked, entry, held?.facts);
      }
      const facts = rankFacts(held?.facts, ranked, held ? statOf(entry.file) : null);
      if (facts === held?.facts) return;
      const selected =
        facts.row === ranked
          ? entry
          : facts.row === held?.facts.row
            ? held.entry
            : facts.row.record && readCompressedRecord(directory, entry.file, facts.row.record);
      if (selected) best.set(entry.file, { facts, entry: observedEntry(selected, facts) });
    };
    try {
      eachLine(path.join(directory, input.name), readLine);
    } catch {
      // A compaction can retire any file at any time.
      onUnreadable?.(input.name);
    }
    yield;
  }
  const entries = new Map<string, CompressedFactEntry>();
  for (const [file, { entry }] of best) entries.set(file, entry);
  return { entries, names };
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

function referenceOf(entry: CompressedFactEntry, ranked: RankedEntry, line: Buffer): CompressedStoreRecord {
  return {
    input: ranked.input,
    offset: ranked.offset,
    bytes: line.length + 1,
    digest: createHash('sha256').update(line).update('\n').digest('base64url'),
    spendDigest: spendDigest(entry.spend),
    order: ranked.order,
    ...(eligibleCompressedSpend(entry) ? { spendRevision: spendRevision(entry, ranked) } : {}),
  };
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
  const identity = compressedEntryIdentity(entry);
  return [
    entry.size,
    entry.mtimeMs,
    identity === null,
    identity?.dev,
    identity?.ino,
    entry.hash,
    entry.threadId,
    entry.spendNeedsRepair,
    entry.spendOrigin ? JSON.stringify(entry.spendOrigin) : undefined,
    entry.spendRevision ? JSON.stringify(entry.spendRevision) : undefined,
    entry.spendAuthority ? JSON.stringify(entry.spendAuthority) : undefined,
    entry.revisionObservation?.join(':'),

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
    entry.unreadable,
    entry.unreadableLaunch,
  ].join('|');
}

export function compressedEntrySame(left: CompressedFactEntry, right: CompressedFactEntry): boolean {
  return (
    (!left.storeRecord || !right.storeRecord || left.storeRecord.digest === right.storeRecord.digest) &&
    compressedEntryMark(left) === compressedEntryMark(right)
  );
}

// Read one complete line from the store that supplied its address.
export function readCompressedRecord(
  directory: string,
  file: string,
  record: CompressedStoreRecord,
  maxBytes = Infinity,
  onRead?: (bytes: number) => void,
  openInput = openForRead,
): CompressedFactEntry | undefined {
  const { input, offset, bytes, digest } = record;
  const name = storeName(input);
  if (
    !name ||
    name.kind === 'manifest' ||
    path.basename(input) !== input ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 2 ||
    bytes > maxBytes ||
    !Number.isSafeInteger(offset + bytes)
  )
    return undefined;
  let fd: number | undefined;
  try {
    fd = openInput(path.join(directory, input));
    if (fs.fstatSync(fd).size < offset + bytes) return undefined;
    const line = Buffer.allocUnsafe(bytes);
    let read = 0;
    while (read < bytes) {
      const count = fs.readSync(fd, line, read, bytes - read, offset + read);
      if (!count) return undefined;
      onRead?.(count);
      read += count;
    }
    if (line[bytes - 1] !== 0x0a || recordDigest(line) !== digest) return undefined;
    const entry = parseEntry(line.subarray(0, bytes - 1).toString('utf8'));
    return entry?.file === file ? { ...entry, storeRecord: record } : undefined;
  } catch {
    // A compaction can retire the input before the next follow.
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

type InputStatus = 'covered' | 'partial' | 'refused' | 'relocating' | 'terminal';
type TerminalRefusal = { offset: number; end: number; digest: string; stat: fs.BigIntStats };
type AdoptionScan = {
  file: string;
  pairKey: string;
  record: CompressedStoreRecord;
  ranked: boolean;
  ordered: boolean;
  inputs: Map<string, fs.BigIntStats>;
};

function sameStoreInput(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.size === right.size &&
    left.ino !== 0n &&
    left.ino === right.ino &&
    left.dev === right.dev &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

type LineageRefusal = { kind: 'unresolved' | 'oversized'; record: CompressedStoreRecord };
type LineageRead = { kind: 'verified'; entry: CompressedFactEntry } | { kind: 'retired' } | LineageRefusal;

// Reads one store as it changes. The first poll reads every file. Each later poll lists the store and reads only the
// bytes appended since, so another window's entry arrives without a restart.
export class CompressedStoreFollower {
  private readonly consumed = new Map<string, number>();
  private readonly inputs = new Map<
    string,
    {
      position: number;
      start: number;
      fragments: Buffer[];
      versionKnown: boolean;
      unsupported: boolean;
    }
  >();
  private readonly best = new Map<string, RankedFacts>();
  private readonly spend = new Map<string, RankedSpend & { record: CompressedStoreRecord }>();
  private readonly quotedAt = Date.now();
  private readonly resumedSpend = new Map<
    string,
    { source: RankedEntry; authority?: CompressedSpendRevision; records: CompressedStoreRecord[] }
  >();
  private readonly changedSpend = new Set<string>();
  private readonly lineage = new Map<string, Map<string, CompressedSpendReference>>();
  private readonly changedLineage = new Set<string>();
  private lineageNeedsPrune = false;
  private readonly relocated = new Map<string, CompressedStoreRecord>();
  private readonly spendRelocated = new Map<string, CompressedStoreRecord>();
  private readonly seeds = new Map<string, CompressedEntrySeed>();
  private readonly changed = new Map<string, CompressedFactEntry>();
  private readableInputs = new Set<string>();
  private retirementProved = false;
  private relocationScan?: {
    view: string;
    nextInput: number;
    offset: number;
    start: number;
    hash: ReturnType<typeof createHash>;
  };
  private readonly relocatedLineage = new Map<string, CompressedStoreRecord>();
  private readonly oversized = new Map<
    string,
    {
      file: string;
      pairKey: string;
      record: CompressedStoreRecord;
      facts: RankedFacts | undefined;
      terminal?: TerminalRefusal;
    }
  >();
  private adoptionScan?: AdoptionScan;
  private running: Promise<boolean> = Promise.resolve(true);
  bytesRead = 0;
  contributorBytesRead = 0;
  lineageBytesAttempted = 0;
  lineageLookups = 0;

  constructor(
    readonly directory: string,
    private readonly statOf: typeof compressedPhysicalStat = compressedPhysicalStat,
    private readonly yieldStep: () => Promise<void> = yieldToEvents,
    private readonly openInput: (file: string) => number = openForRead,
    private readonly heldSpend?: (request: CompressedSpendRequest) => Promise<CompressedFactEntry | null | undefined>,
    private readonly openingLine?: (entry: CompressedFactEntry) => void,
  ) {}

  static forOpenings(
    directory: string,
    yieldStep: () => Promise<void>,
    take: (entry: CompressedFactEntry) => void,
  ): CompressedStoreFollower {
    return new CompressedStoreFollower(directory, undefined, yieldStep, undefined, undefined, take);
  }

  // The host's offsets cover delivered envelopes and their spend witnesses.
  seed(resume: CompressedLoadResume): void {
    for (const [name, end] of resume.consumed) this.consumed.set(name, end);
    const nameSeeds = (resume.nameOnly ?? []).map((file): CompressedEntrySeed => ({
      file,
      pairKey: '',
      ...compressedEntryVersions(),
      nameOnly: true,
    }));
    for (const seed of [...nameSeeds, ...resume.entries]) {
      const ranked = rankedRecord(seed);
      this.best.set(seed.file, { row: ranked, latest: ranked });
      this.seeds.set(seed.file, seed);
      this.seedSpend(seed, ranked);
    }
    // The first view uses these names to detect inputs retired since the acknowledgment.
    this.readableInputs = new Set(this.consumed.keys());
    for (const { file, selected, sources, latest, alternatives, spend } of resume.lineage ?? []) {
      if (!selected?.hash || !selected.storeRecord || selected.file !== file || !sources) continue;
      const observed = latest !== undefined && latest !== -1 ? sources[latest] : undefined;
      if (!observed && !alternatives?.length) continue;
      const row = rankedRecord(selected);
      if (observed) row.observation = undefined;
      const selectedSource = rankSummary(row);
      const sourceAt = (index: number) => (index === -1 ? selectedSource : sources[index]);
      const candidates = alternatives?.length
        ? new Map(
            alternatives.map((index) => {
              const ref = sourceAt(index);
              return [ref.entry.hash!, rankReference(ref)];
            }),
          ).set(selected.hash, row)
        : undefined;
      this.best.set(file, { row, latest: observed ? rankReference(observed) : row, alternatives: candidates });
      this.seeds.set(file, selected);
      this.seedSpend(selected, row);
      const witnesses = new Map(
        spend?.map(([hash, amount, baseline]) => [
          hash,
          { amount: sourceAt(amount), baseline: baseline === undefined ? undefined : sourceAt(baseline) },
        ]),
      );
      this.lineage.set(file, witnesses);
      const held = witnesses.get(selected.hash);
      if (held) {
        const existing = this.resumedSpend.get(file);
        const authority = laterSpendRevision(
          existing?.authority ?? completeSpendRevision(selected),
          held.baseline?.record.spendRevision,
        );
        const records = [
          ...new Map(
            [held.amount.record, ...(existing?.records ?? [])]
              .filter((record) => !precedesSpendAuthority(record.spendRevision, authority))
              .map((record) => [record.digest, record]),
          ).values(),
        ];
        this.resumedSpend.set(file, { source: row, authority, records });
      }
    }
  }

  private seedSpend(seed: CompressedEntrySeed, source: RankedEntry): void {
    const held = seed.spendRecord ?? (seed.hasSpend ? seed.storeRecord : undefined);
    const authority = completeSpendRevision(seed);
    const records = [held && { ...held, spendRevision: spendRevision(seed) }, seed.spendWitness].filter(
      (record): record is CompressedStoreRecord =>
        record !== undefined && !precedesSpendAuthority(record.spendRevision, authority),
    );
    if (records.length || authority) this.resumedSpend.set(seed.file, { source, authority, records });
  }

  offsets(): [string, number][] {
    return [...this.consumed];
  }

  known(): ReadonlyMap<string, CompressedEntrySeed> {
    return this.seeds;
  }

  private takeRelocated(): [string, CompressedStoreRecord][] {
    const entries = [...this.relocated];
    this.relocated.clear();
    return entries;
  }

  private takeSpendRelocated(): [string, CompressedStoreRecord][] {
    const entries = [...this.spendRelocated].filter(
      ([file, record]) => this.spend.get(file)?.record.digest === record.digest,
    );
    this.spendRelocated.clear();
    return entries;
  }

  entry(file: string): CompressedFactEntry | undefined {
    const seed = this.seeds.get(file);
    const record = seed?.storeRecord;
    const entry = record && readCompressedRecord(this.directory, file, record);
    return entry && seed?.revisionObservation ? { ...entry, revisionObservation: seed.revisionObservation } : entry;
  }

  // A holder reads the same traversal as a follow. Only a follow takes the pending delivery.
  private scan(limit: number, signal?: AbortSignal): Promise<boolean> {
    const running = this.running.catch(() => false).then(() => this.readView(limit, signal));
    this.running = running;
    return running;
  }

  async poll(): Promise<CompressedFactEntry[]> {
    return (await this.follow()).entries;
  }

  async follow(signal?: AbortSignal): Promise<{
    entries: CompressedFactEntry[];
    offsets: [string, number][];
    relocated: [string, CompressedStoreRecord][];
    spendRelocated: [string, CompressedStoreRecord][];
    lineage: CompressedLineage[];
  }> {
    await this.scan(Infinity, signal);
    for (const file of this.changedSpend) {
      const entry = this.changed.get(file) ?? this.entry(file);
      if (!entry) continue;
      this.changed.set(file, entry);
      this.changedSpend.delete(file);
    }
    const entries = [...this.changed.values()].map((entry) => this.deliveryEntry(entry)!);
    this.changed.clear();
    const lineage = [...this.changedLineage].map((file) => this.lineageOf(file));
    this.changedLineage.clear();
    return {
      entries,
      lineage,
      offsets: this.offsets(),
      relocated: this.takeRelocated(),
      spendRelocated: this.takeSpendRelocated(),
    };
  }

  private deliveryEntry(entry: CompressedFactEntry, requireSpend = false): CompressedFactEntry | undefined {
    const source = rankedRecord(entry);
    const witness = this.spend.get(entry.file);
    const resumed = this.resumedSpend.get(entry.file);
    const live = witness && rankedSameOwner(witness.ranked, source) ? witness : undefined;
    const seed = resumed && rankedSameOwner(resumed.source, source) ? resumed : undefined;
    const authority = laterSpendRevision(live?.authority, seed?.authority);
    const record =
      live && !precedesSpendAuthority(live.revision, authority)
        ? live.record
        : seed?.records.find((ref) => !precedesSpendAuthority(ref.spendRevision, authority));
    const ownAuthority = completeSpendRevision(entry);
    const needsAuthority = authority && (!ownAuthority || compareSpendRevisions(authority, ownAuthority) > 0);
    const distinct = record && record.digest !== entry.storeRecord?.digest;
    if (!needsAuthority && !distinct) return entry;
    const next = {
      ...entry,
      ...(needsAuthority ? { spendAuthority: authority } : {}),
      ...(distinct ? { spendWitness: record } : {}),
    };
    const missing = !next.spend && !!record && verifiesCompressedBytes(next);
    if (!missing && (!next.spend || !precedesSpendAuthority(spendRevision(next), authority))) return next;
    const donor =
      record && this.readContributor(next.file, record, requireSpend ? COMPRESSED_EXACT_LINE_BYTES : Infinity);
    if (requireSpend && record && !donor) return undefined;
    if (missing && donor && eligibleCompressedSpend(donor) && compressedFactsSameOwner(donor, next))
      return withSpendFrom(next, donor);
    return withKeptUndercount(donor, next, this.quotedAt);
  }

  cover(): Promise<boolean> {
    return this.scan(FOLLOW_SLICE_BYTES);
  }

  private async readView(limit: number, signal?: AbortSignal): Promise<boolean> {
    let covered = true;
    const unreadable = () => {
      covered = false;
    };
    const names = listDirectory(this.directory, unreadable);
    const view = storeView(this.directory, names, unreadable);
    const canProveRetirement = covered && view.valid.length === view.manifests.length;
    const adoption = this.adoptionScan;
    let ordered = canProveRetirement;
    const present = new Set(names);
    const previousInputs = this.readableInputs;
    this.readableInputs = new Set(view.inputs.map(({ name }) => name));
    if (!covered) for (const name of previousInputs) if (present.has(name)) this.readableInputs.add(name);
    this.retirementProved =
      canProveRetirement &&
      view.inputs.every(({ kind, name }) => kind !== 'shard' || previousInputs.has(name)) &&
      this.retirementProved;
    for (const name of previousInputs) if (!this.readableInputs.has(name)) this.lineageNeedsPrune = true;
    if (canProveRetirement) {
      for (const name of this.consumed.keys()) if (!present.has(name)) this.consumed.delete(name);
      for (const name of this.inputs.keys()) if (!present.has(name)) this.inputs.delete(name);
      for (const name of this.oversized.keys()) if (!present.has(name)) this.oversized.delete(name);
    }
    for (const [digest, record] of this.relocatedLineage)
      if (!this.readableInputs.has(record.input)) this.relocatedLineage.delete(digest);
    let sliced = 0;
    const read = async (input: StoreName) => {
      let status: InputStatus;
      do {
        if (signal?.aborted) return 'refused';
        const before = this.bytesRead;
        status = this.readInput(input, Math.min(limit, FOLLOW_SLICE_BYTES - sliced));
        const bytes = this.bytesRead - before;
        limit -= bytes;
        sliced += bytes;
        if (sliced >= FOLLOW_SLICE_BYTES) {
          sliced = 0;
          await this.yieldStep();
        }
      } while (status === 'partial' && limit > 0);
      return status;
    };
    const waiting: StoreName[] = [];
    let shardsCovered = true;
    for (const input of view.inputs) {
      if (signal?.aborted) return false;
      const status = await read(input);
      if (status === 'relocating') waiting.push(input);
      else if (status !== 'covered') {
        covered = false;
        if (status !== 'terminal') ordered = false;
      }
      if (status !== 'covered' && input.kind === 'shard') shardsCovered = false;
    }
    if (canProveRetirement) {
      if (shardsCovered) this.retirementProved = true;
      else if (waiting.length && !this.retirementProved) {
        const shards = view.inputs.filter(({ kind }) => kind === 'shard');
        this.retirementProved = await this.findRelocatedLineage(
          shards,
          () => (signal?.aborted ? 0 : Math.min(limit, FOLLOW_SLICE_BYTES - sliced)),
          async (bytes) => {
            this.bytesRead += bytes;
            limit -= bytes;
            sliced += bytes;
            if (sliced >= FOLLOW_SLICE_BYTES) {
              sliced = 0;
              await this.yieldStep();
            }
          },
        );
      }
    }
    for (const input of waiting) {
      const status = !signal?.aborted && limit > 0 ? await read(input) : 'refused';
      if (status !== 'covered') {
        covered = false;
        if (status !== 'terminal') ordered = false;
      }
    }
    if (adoption && !covered && ordered && !signal?.aborted) adoption.ordered = this.sameAdoptionView(view, adoption);
    if (covered && this.retirementProved && this.lineageNeedsPrune) {
      this.pruneLineage();
      this.lineageNeedsPrune = false;
    }
    return covered;
  }

  // A terminal refusal proves nothing about another line unless the inputs and manifest still name the scanned view.
  private sameAdoptionView(view: StoreView, adoption: AdoptionScan): boolean {
    let readable = true;
    const unreadable = () => {
      readable = false;
    };
    const current = storeView(this.directory, listDirectory(this.directory, unreadable), unreadable);
    return (
      readable &&
      current.manifests.length === current.valid.length &&
      current.inputs.length === view.inputs.length &&
      JSON.stringify(current.valid) === JSON.stringify(view.valid) &&
      current.inputs.every(({ name }, index) => {
        if (name !== view.inputs[index].name) return false;
        const seen = adoption.inputs.get(name);
        if (!seen) return false;
        try {
          return sameStoreInput(seen, fs.statSync(path.join(this.directory, name), { bigint: true }));
        } catch {
          return false;
        }
      })
    );
  }

  // A replacement shard can contain the source that blocks its own ranking. Check its line addresses without
  // allocating the payload or advancing its delivery offset.
  private async findRelocatedLineage(
    shards: StoreName[],
    budget: () => number,
    charge: (bytes: number) => Promise<void>,
  ): Promise<boolean> {
    const view = shards.map(({ name }) => name).join('\0');
    if (this.relocationScan?.view !== view)
      this.relocationScan = { view, nextInput: 0, offset: 0, start: 0, hash: createHash('sha256') };
    const cursor = this.relocationScan;
    const refs = new Map<string, CompressedStoreRecord>();
    const remember = (ref: CompressedStoreRecord | undefined) => {
      if (ref && !this.readableInputs.has(ref.input) && !this.relocatedLineage.has(ref.digest))
        refs.set(ref.digest, ref);
    };
    for (const [file, perHash] of this.lineage) {
      const facts = this.best.get(file);
      for (const alternative of facts?.alternatives?.values() ?? []) remember(alternative.record);
      remember(facts?.latest.record);
      for (const { amount, baseline } of perHash.values()) {
        remember(amount.record);
        remember(baseline?.record);
      }
    }
    if (cursor.nextInput >= shards.length) return true;
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    for (; cursor.nextInput < shards.length && budget() > 0; cursor.nextInput++) {
      const input = shards[cursor.nextInput].name;
      let fd: number | undefined;
      try {
        fd = this.openInput(path.join(this.directory, input));
        const size = fs.fstatSync(fd).size;
        if (size < cursor.offset) return false;
        while (cursor.offset < size) {
          const bytes = Math.min(size - cursor.offset, buffer.length, budget());
          if (!bytes) return false;
          const count = fs.readSync(fd, buffer, 0, bytes, cursor.offset);
          if (!count) return false;
          const chunk = buffer.subarray(0, count);
          let from = 0;
          for (let newline = chunk.indexOf(0x0a); newline >= 0; newline = chunk.indexOf(0x0a, from)) {
            const end = newline + 1;
            const digest = cursor.hash.update(chunk.subarray(from, end)).digest('base64url');
            const ref = refs.get(digest);
            if (ref && ref.bytes === cursor.offset + end - cursor.start)
              this.relocatedLineage.set(digest, { ...ref, input, offset: cursor.start });
            cursor.hash = createHash('sha256');
            cursor.start = cursor.offset + end;
            from = end;
          }
          cursor.hash.update(chunk.subarray(from));
          cursor.offset += count;
          await charge(count);
        }
        if (cursor.offset !== cursor.start) return false;
        cursor.offset = cursor.start = 0;
      } catch {
        return false;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
    return cursor.nextInput === shards.length;
  }

  private lineageOf(file: string): CompressedLineage {
    const facts = this.best.get(file);
    const selected = this.seeds.get(file);
    if (!selected?.storeRecord || !facts?.latest.record || (!facts.alternatives && !hasDistinctObservation(facts)))
      return { file };
    const sources: CompressedRankReference[] = [];
    const indexes = new Map([[selected.storeRecord.digest, -1]]);
    const indexOf = (ref: CompressedRankReference): number => {
      const digest = ref.record.digest;
      const held = indexes.get(digest);
      if (held !== undefined) return held;
      const index = sources.length;
      sources.push(ref);
      indexes.set(digest, index);
      return index;
    };
    return {
      file,
      selected,
      sources,
      latest: indexOf(rankSummary(facts.latest)),
      ...(facts.alternatives && {
        alternatives: [...facts.alternatives.values()]
          .filter((ranked) => ranked.entry.hash !== selected.hash)
          .map((ranked) => indexOf(rankSummary(ranked))),
      }),
      spend: [...(this.lineage.get(file) ?? [])].map(([hash, { amount, baseline }]) => [
        hash,
        indexOf(amount),
        baseline && indexOf(baseline),
      ]),
    };
  }

  private pruneLineage(): void {
    for (const [file, spend] of this.lineage) {
      const facts = this.best.get(file);
      if (!facts) continue;
      if (hasDistinctObservation(facts)) {
        const previous = facts.latest.record!;
        const relocated = this.relocatedLineage.get(previous.digest);
        if (relocated && relocated.input !== previous.input) {
          facts.latest = { ...facts.latest, record: relocated };
          this.changedLineage.add(file);
        } else if (!this.readableInputs.has(previous.input)) {
          facts.latest = { ...facts.row, observation: observationOrder(facts.latest) };
          this.changedLineage.add(file);
        }
      }
      const alternatives = facts.alternatives;
      if (!alternatives) {
        if (!hasDistinctObservation(facts)) this.lineage.delete(file);
        continue;
      }
      const active = facts.row.entry.hash;
      for (const [hash, ranked] of alternatives) {
        if (hash === active) continue;
        const record = ranked.record && this.relocatedLineage.get(ranked.record.digest);
        if (record && record.input !== ranked.record?.input) {
          alternatives.set(hash, { ...ranked, record });
          this.changedLineage.add(file);
        } else if (!ranked.record || !this.readableInputs.has(ranked.record.input)) {
          alternatives.delete(hash);
          spend.delete(hash);
          this.changedLineage.add(file);
        }
      }
      for (const [hash, witness] of spend) {
        const { amount, baseline } = witness;
        const locatedAmount = this.relocatedLineage.get(amount.record.digest) ?? amount.record;
        const locatedBaseline = baseline && (this.relocatedLineage.get(baseline.record.digest) ?? baseline.record);
        if (locatedAmount !== amount.record || locatedBaseline !== baseline?.record) {
          spend.set(hash, {
            amount: { ...amount, record: locatedAmount },
            baseline: baseline && locatedBaseline && { ...baseline, record: locatedBaseline },
          });
          this.changedLineage.add(file);
        }
        if (!this.readableInputs.has(locatedAmount.input)) {
          spend.delete(hash);
          this.changedLineage.add(file);
        } else if (locatedBaseline && !this.readableInputs.has(locatedBaseline.input)) {
          spend.set(hash, { amount: { ...amount, record: locatedAmount } });
          this.changedLineage.add(file);
        }
      }
      if (alternatives.size < 2) {
        facts.alternatives = undefined;
        if (!hasDistinctObservation(facts)) this.lineage.delete(file);
        this.changedLineage.add(file);
      }
    }
  }

  private terminalStatus(
    name: string,
    entry: Pick<CompressedEntrySeed, 'file' | 'pairKey'>,
    terminal: TerminalRefusal | undefined,
  ): InputStatus {
    const adoption = this.adoptionScan;
    if (
      !adoption ||
      adoption.file === entry.file ||
      adoption.pairKey === entry.pairKey ||
      !terminal ||
      (this.consumed.get(name) ?? 0) !== terminal.offset
    )
      return 'refused';
    adoption.inputs.set(name, terminal.stat);
    return 'terminal';
  }

  private readInput(input: StoreName, limit: number): InputStatus {
    const blocked = this.oversized.get(input.name);
    if (blocked) {
      const ref = blocked.record;
      const record = this.relocatedLineage.get(ref.digest) ?? ref;
      if (
        record.input === ref.input &&
        this.readableInputs.has(ref.input) &&
        this.best.get(blocked.file) === blocked.facts
      )
        return this.terminalStatus(input.name, blocked, blocked.terminal);
      this.oversized.delete(input.name);
    }
    const file = path.join(this.directory, input.name);
    const start = this.consumed.get(input.name) ?? 0;
    let cursor = this.inputs.get(input.name);
    if (!cursor) {
      cursor = { position: start, start, fragments: [], versionKnown: start > 0, unsupported: false };
      this.inputs.set(input.name, cursor);
    }
    let fd: number | undefined;
    try {
      const stat = fs.statSync(file, { bigint: true });
      const size = Number(stat.size);
      const cover = () => {
        const adoption = this.adoptionScan;
        if (
          adoption &&
          (cursor.start === size || cursor.unsupported) &&
          (fd === undefined || sameStoreInput(stat, fs.fstatSync(fd, { bigint: true })))
        )
          adoption.inputs.set(input.name, stat);
        return 'covered' as const;
      };
      if (size < cursor.position) return 'refused';
      if (size === cursor.position) return cover();
      if (cursor.unsupported) {
        cursor.position = size;
        this.consumed.set(input.name, size);
        return cover();
      }
      if (limit <= 0) return 'partial';
      fd = this.openInput(file);
      const chunk = Buffer.allocUnsafe(READ_CHUNK);
      while (cursor.position < size && limit > 0) {
        const count = fs.readSync(fd, chunk, 0, Math.min(READ_CHUNK, size - cursor.position, limit), cursor.position);
        if (!count) return 'refused';
        this.bytesRead += count;
        limit -= count;
        const head = cursor.position;
        cursor.position += count;
        let from = 0;
        for (
          let end = chunk.subarray(0, count).indexOf(0x0a);
          end >= 0;
          end = chunk.subarray(0, count).indexOf(0x0a, from)
        ) {
          const part = chunk.subarray(from, end);
          const line = cursor.fragments.length ? Buffer.concat([...cursor.fragments, part]) : part;
          const entry = parseEntry(line.toString('utf8'));
          if (!cursor.versionKnown) {
            cursor.versionKnown = true;
            cursor.unsupported = !!entry && !readableFactsVersion(entry.factsVersion);
          }
          if (cursor.unsupported) {
            cursor.position = size;
            cursor.fragments = [];
            this.consumed.set(input.name, size);
            return cover();
          }
          if (entry && readableFactsVersion(entry.factsVersion)) {
            const ranked = this.rank(entry, input, cursor.start, line);
            if (ranked !== true) {
              cursor.position = cursor.start;
              cursor.fragments = [];
              if (ranked.kind === 'unresolved' && !this.readableInputs.has(ranked.record.input)) return 'relocating';
              const lineEnd = head + end + 1;
              const terminal =
                lineEnd === size && sameStoreInput(stat, fs.fstatSync(fd, { bigint: true }))
                  ? {
                      offset: cursor.start,
                      end: lineEnd,
                      digest: createHash('sha256').update(line).update('\n').digest('base64url'),
                      stat,
                    }
                  : undefined;
              if (ranked.kind === 'oversized')
                this.oversized.set(input.name, {
                  file: entry.file,
                  pairKey: entry.pairKey,
                  record: ranked.record,
                  facts: this.best.get(entry.file),
                  terminal,
                });
              return this.terminalStatus(input.name, entry, terminal);
            }
            const adoption = this.adoptionScan;
            if (
              adoption?.record.input === input.name &&
              adoption.record.offset === cursor.start &&
              adoption.record.digest === referenceOf(entry, rankedLine(entry, input, cursor.start), line).digest
            )
              adoption.ranked = true;
          }
          from = end + 1;
          cursor.start = head + from;
          cursor.fragments = [];
          this.consumed.set(input.name, cursor.start);
        }
        if (from < count) cursor.fragments.push(Buffer.from(chunk.subarray(from, count)));
      }
      return cursor.position === size ? cover() : 'partial';
    } catch {
      // A listed input that gave no answer leaves a conditional write pending.
      return 'refused';
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  noteAppend(entry: CompressedFactEntry, record: CompressedStoreRecord): boolean {
    const { input, offset, bytes } = record;
    const name = storeName(input)!;
    this.readableInputs.add(input);
    const cursor = this.inputs.get(input);
    if ((cursor?.position ?? this.consumed.get(input) ?? 0) !== offset || (cursor && cursor.start !== offset))
      return false;
    if (this.rank(entry, name, offset, record) !== true) return false;
    if (eligibleCompressedSpend(entry)) this.resumedSpend.delete(entry.file);
    const end = offset + bytes;
    this.consumed.set(input, end);
    this.inputs.set(input, { position: end, start: end, fragments: [], versionKnown: true, unsupported: false });
    return true;
  }

  async adoptedEntry(entry: CompressedEntrySeed, signal: AbortSignal): Promise<CompressedFactEntry | undefined> {
    const record = entry.storeRecord;
    if (!record || !entry.adopted || signal.aborted) return undefined;
    const pending = this.running
      .catch(() => false)
      .then(async () => {
        if (signal.aborted) return undefined;
        const adoption: AdoptionScan = {
          file: entry.file,
          pairKey: entry.pairKey,
          record,
          ranked: false,
          ordered: false,
          inputs: new Map(),
        };
        const sameAddress = (source: CompressedStoreRecord | undefined, ref: CompressedStoreRecord) =>
          source?.input === ref.input &&
          source.offset === ref.offset &&
          source.bytes === ref.bytes &&
          source.digest === ref.digest;
        const consumed = (this.consumed.get(record.input) ?? 0) >= record.offset + record.bytes;
        const before = this.best.get(entry.file)?.latest.record;
        this.adoptionScan = adoption;
        try {
          const covered = await this.readView(Infinity, signal);
          if (signal.aborted) return undefined;
          const selected = this.best.get(entry.file);
          const latest = selected?.latest.record;
          const acknowledged = latest?.digest === record.digest;
          const relocated =
            sameAddress(before, record) && consumed ? this.relocatedLineage.get(record.digest) : undefined;
          const copied =
            !covered &&
            adoption.ordered &&
            selected &&
            latest?.input !== record.input &&
            acknowledged &&
            latest?.bytes === record.bytes &&
            this.retirementProved &&
            !this.readableInputs.has(record.input) &&
            compareOrder(observationOrder(selected.latest), observationOrder(rankedRecord(entry))) === 0
              ? latest
              : undefined;
          const moved = relocated ?? copied;
          const rankedInView =
            adoption.ranked ||
            (acknowledged && consumed && sameAddress(latest, record) && this.readableInputs.has(record.input)) ||
            (acknowledged &&
              moved &&
              this.readableInputs.has(moved.input) &&
              (this.consumed.get(moved.input) ?? 0) >= moved.offset + moved.bytes &&
              (relocated ||
                (selected && this.readLineage(entry.file, selected.latest, new Map()).kind === 'verified')));
          if (!(covered ? adoption.ranked || acknowledged : adoption.ordered && rankedInView)) {
            if (!covered) return undefined;
            const retired =
              this.retirementProved &&
              !this.readableInputs.has(record.input) &&
              selected &&
              compareOrder(observationOrder(selected.latest), observationOrder(rankedRecord(entry))) >= 0;
            if (
              !retired &&
              !(
                consumed &&
                (this.consumed.get(record.input) ?? 0) >= record.offset + record.bytes &&
                this.readContributor(entry.file, record, COMPRESSED_EXACT_LINE_BYTES)
              )
            )
              return undefined;
          }
          const seed = this.seeds.get(entry.file);
          if (
            !seed?.storeRecord ||
            !selected ||
            seed.hash !== entry.hash ||
            !compressedFactsSameOwner(seed, entry) ||
            !compressedEntryCurrent(seed, this.statOf(entry.file))
          )
            return undefined;
          const held = this.changed.get(entry.file);
          if (held?.storeRecord?.digest === seed.storeRecord.digest) return this.deliveryEntry(held, true);
          const exact = this.readLineage(entry.file, selected.row, new Map());
          return exact.kind === 'verified'
            ? this.deliveryEntry({ ...exact.entry, revisionObservation: seed.revisionObservation }, true)
            : undefined;
        } finally {
          this.adoptionScan = undefined;
        }
      });
    this.running = pending.then(Boolean);
    return pending;
  }

  private readContributor(
    file: string,
    record: CompressedStoreRecord,
    maxBytes = Infinity,
  ): CompressedFactEntry | undefined {
    record = this.relocatedLineage.get(record.digest) ?? record;
    if (!this.readableInputs.has(record.input)) return undefined;
    const entry = readCompressedRecord(this.directory, file, record, maxBytes, undefined, this.openInput);
    if (entry) this.contributorBytesRead += record.bytes;
    return entry;
  }

  private rank(
    entry: CompressedFactEntry,
    input: StoreName,
    offset: number,
    line: Buffer | CompressedStoreRecord,
  ): true | LineageRefusal {
    const ranked = rankedLine(entry, input, offset);
    if (this.openingLine) {
      if (entry.opening !== undefined || entry.repairRetry) {
        const record = Buffer.isBuffer(line) ? referenceOf(entry, ranked, line) : line;
        this.openingLine({ ...entry, storeRecord: record });
      }
      return true;
    }
    const file = entry.file;
    const held = this.best.get(file);
    const prior = this.seeds.get(file);
    const witness = this.spend.get(file);
    const seed = this.resumedSpend.get(file);
    const authority = seed && rankedSameOwner(seed.source, ranked) ? seed.authority : undefined;
    const known = this.lineage.get(file);
    const previous = entry.hash ? known?.get(entry.hash) : undefined;
    const storeRecord = () => (ranked.record ??= Buffer.isBuffer(line) ? referenceOf(entry, ranked, line) : line);
    if (ranked.entry.verifiedBytes) {
      storeRecord();
      preserveRecordedOrder(ranked, entry, held, previous);
      const { digest } = storeRecord();
      if (
        [
          held?.row.record,
          held?.latest.record,
          held?.alternatives?.get(entry.hash!)?.record,
          previous?.amount.record,
          previous?.baseline?.record,
        ].some((record) => record?.digest === digest && !this.readableInputs.has(record.input))
      )
        this.relocatedLineage.set(digest, storeRecord());
      noteCompleteSpend(entry, ranked, this.quotedAt);
    }
    let facts = rankFacts(held, ranked, held ? this.statOf(file) : null);
    let restored: CompressedFactEntry | undefined;
    let retired: CompressedStoreRecord | undefined;
    let returned: { spend: RankedSpend; entry: CompressedFactEntry } | undefined;
    const inactive = facts.alternatives?.has(entry.hash!) && facts.latest.entry.hash !== entry.hash;
    const returning = facts.row !== ranked && facts.row !== held?.row;
    const pending = this.changed.get(file);
    const confirming =
      entry.adopted &&
      facts.latest === ranked &&
      facts.row !== ranked &&
      !!facts.row.record &&
      pending?.storeRecord?.digest !== facts.row.record.digest;
    if (returning || confirming || (inactive && previous && eligibleCompressedSpend(entry))) {
      const exact = new Map<string, CompressedFactEntry | null>();
      exact.set(storeRecord().digest, { ...entry, storeRecord: storeRecord() });
      if (returning || confirming) {
        // A surviving earlier derivation must answer before this observation can advance the input.
        const source = this.readLineage(file, facts.row, exact);
        if (source.kind === 'verified') {
          restored = source.entry;
          const row = { ...facts.row, record: source.entry.storeRecord };
          if (!row.completeSpend) noteCompleteSpend(restored, row, this.quotedAt);
          const alternatives = facts.alternatives && new Map(facts.alternatives);
          alternatives?.set(entry.hash!, row);
          facts = { ...facts, row, alternatives };
        } else if (source.kind === 'retired') {
          retired = facts.row.record;
          const alternatives = facts.alternatives && new Map(facts.alternatives);
          alternatives?.set(entry.hash!, ranked);
          facts = { ...facts, row: ranked, alternatives };
        } else return source;
      }
      if (previous) {
        const evidence = this.readLineageSpend(
          file,
          previous,
          exact,
          returning ? observationOrder(facts.latest) : undefined,
        );
        if (evidence && 'kind' in evidence) return evidence;
        returned = evidence;
      }
    }
    const better = facts.row !== held?.row || facts.latest !== held?.latest;
    if (facts !== held) this.best.set(file, facts);
    const complete = selectedCompleteSpend(facts);
    const erasedWitness = retired && witness?.record.digest === retired.digest;
    const erasedSeed = retired && seed?.source.record?.digest === retired.digest;
    if (erasedWitness) this.spend.delete(file);
    if (erasedSeed) this.resumedSpend.delete(file);
    const live = returning || erasedWitness ? returned?.spend : witness;
    let spend =
      rankSpend(entry, ranked, live, this.quotedAt, erasedSeed ? undefined : authority, complete) ??
      (returning || erasedWitness ? returned?.spend : undefined);
    if (facts.alternatives) {
      const perHash = known ?? new Map<string, CompressedSpendReference>();
      const previousHash = held?.row.entry.hash;
      if (previousHash && !held?.alternatives && witness) {
        const summary = spendSummary(witness, previousHash);
        if (summary) perHash.set(previousHash, summary);
      }
      const hash = entry.hash;
      if (hash && facts.alternatives.has(hash)) {
        const candidate = inactive ? rankSpend(entry, ranked, returned?.spend, this.quotedAt) : (spend ?? witness);
        const summary = candidate && spendSummary(candidate, hash);
        if (summary) {
          perHash.set(hash, summary);
          this.changedLineage.add(file);
        }
      }
      this.lineage.set(file, perHash);
      if (facts !== held) this.changedLineage.add(file);
    } else if (hasDistinctObservation(facts)) {
      if (!known) this.lineage.set(file, new Map());
      if (facts !== held) this.changedLineage.add(file);
    } else if (this.lineage.delete(file)) this.changedLineage.add(file);
    const canRelocate = witness && !this.readableInputs.has(witness.record.input);
    if (!better && !spend && !canRelocate) return true;
    const ref = storeRecord();
    const { digest } = ref;
    if (canRelocate && digest === witness.record.digest && !precedesSpendAuthority(witness.revision, authority)) {
      // The compactor copied the bytes. Move the reference without changing when the amount was derived.
      spend = spend?.authority === witness.authority || !spend ? { ...witness, ranked } : { ...spend, ranked };
      ref.spendRevision = witness.revision;
    }
    if (spend) {
      const record = spend.ranked === ranked ? ref : (spend.ranked.record ?? witness!.record);
      this.spend.set(file, { ...spend, record });
      if (
        spend.ranked === ranked &&
        (!better || this.resumedSpend.get(file)?.records.some((record) => record.digest === digest))
      )
        this.spendRelocated.set(file, ref);
      if (
        !better &&
        spend.authority &&
        (!witness?.authority || compareSpendRevisions(spend.authority, witness.authority) > 0)
      )
        this.changedSpend.add(file);
    }
    if (!better) return true;

    const selected = facts.row;
    const address = selected === ranked ? ref : selected.record;
    if (!address) return true;
    const chosen = selected === ranked ? entry : pending?.storeRecord?.digest === address.digest ? pending : restored;
    const located =
      chosen &&
      observedEntry(
        withKeptUndercount(
          spend && spend.ranked === returned?.spend.ranked ? returned.entry : undefined,
          {
            ...chosen,
            storeRecord: address,
          },
          this.quotedAt,
        ),
        facts,
      );
    if (located) {
      this.seeds.set(file, compressedEntrySeed(located));
    } else if (selected === held?.row && prior) {
      this.seeds.set(file, observedEntry(prior, facts));
    } else return true;
    const next = this.seeds.get(file)!;
    if (!prior || !compressedEntrySame(prior, next) || pending) {
      this.relocated.delete(file);
      if (located) this.changed.set(file, located);
      else {
        this.changed.delete(file);
        this.changedSpend.add(file);
      }
    } else if ((!next.nameOnly || next.unreadable) && prior.storeRecord?.input !== address.input) {
      this.relocated.set(file, address);
    }
    return true;
  }

  private readLineageSpend(
    file: string,
    witness: CompressedSpendReference,
    exact: Map<string, CompressedFactEntry | null>,
    observation?: CompressedOrder,
  ): { spend: RankedSpend; entry: CompressedFactEntry } | LineageRefusal | undefined {
    let amount = rankReference(witness.amount);
    const read = this.readLineage(file, amount, exact);
    if (read.kind === 'unresolved' || read.kind === 'oversized') return read;
    const baseline = witness.baseline ? rankReference(witness.baseline) : amount;
    const basis = witness.baseline ? this.readLineage(file, baseline, exact) : read;
    if (basis.kind === 'unresolved' || basis.kind === 'oversized') return basis;
    const complete = basis.kind === 'verified' ? basis.entry : undefined;
    if (complete) baseline.record = complete.storeRecord;
    const entry = read.kind === 'verified' ? read.entry : complete;
    if (!entry || !eligibleCompressedSpend(entry)) return undefined;
    if (read.kind === 'retired') amount = baseline;
    amount.record = entry.storeRecord;
    const revision = spendRevision(entry, amount);
    const authority =
      complete && (witness.baseline || !complete.undercount) ? completeSpendRevision(complete, baseline) : undefined;
    return {
      entry: { ...entry, storeRecord: amount.record },
      spend: {
        ranked: amount,
        revision,
        authority: authority && (observation ? { ...authority, observation } : authority),
        authorityLine: authority ? baseline : undefined,
        total: spendRecordTotal(entry.spend!, this.quotedAt),
      },
    };
  }

  private readLineage(file: string, ranked: RankedEntry, cache: Map<string, CompressedFactEntry | null>): LineageRead {
    const original = ranked.record!;
    const record = this.relocatedLineage.get(original.digest) ?? original;
    const known = cache.has(record.digest);
    if (!known) {
      if (!this.readableInputs.has(record.input))
        return this.retirementProved ? { kind: 'retired' } : { kind: 'unresolved', record };
      if (record.bytes > COMPRESSED_EXACT_LINE_BYTES) return { kind: 'oversized', record };
    }
    const entry = known
      ? cache.get(record.digest)
      : readCompressedRecord(
          this.directory,
          file,
          record,
          COMPRESSED_EXACT_LINE_BYTES,
          (bytes) => {
            this.lineageBytesAttempted += bytes;
          },
          this.openInput,
        );
    if (!known) {
      this.lineageLookups++;
      cache.set(record.digest, entry ?? null);
    }
    const verified =
      entry &&
      verifiesCompressedBytes(entry) &&
      rankedSameOwner(ranked, rankedRecord(entry)) &&
      entry.hash === ranked.entry.hash &&
      compareRevisionStats(entry, ranked.entry) === 0 &&
      spendDigest(entry.spend) === record.spendDigest;
    if (verified && !known) this.contributorBytesRead += record.bytes;
    return verified ? { kind: 'verified', entry } : { kind: 'unresolved', record };
  }

  // Exact hydration is limited to the affected path's ranked envelope and independent spend witnesses.
  async carriedEntry(next: CompressedFactEntry): Promise<CompressedFactEntry | undefined> {
    const file = next.file;
    const seed = this.seeds.get(file);
    const envelope = seed?.storeRecord;
    const observed = this.spend.get(file);
    const seeded = this.resumedSpend.get(file);
    const source = rankedRecord(next);
    const live = observed && rankedSameOwner(observed.ranked, source) ? observed : undefined;
    const resumed = seeded && rankedSameOwner(seeded.source, source) ? seeded : undefined;
    const authority = laterSpendRevision(live?.authority, resumed?.authority);
    const located = [
      ...(resumed?.records ?? []),
      ...(next.unreadable || seed?.hasSpend ? [envelope] : []),
      live?.record,
    ];
    const refs = new Map(located.flatMap((ref) => (ref ? [[ref.digest, ref]] : [])));
    let prior: CompressedFactEntry | undefined;
    const candidates: CompressedFactEntry[] = [];
    for (const ref of refs.values()) {
      const needsTitle = next.unreadable && ref.digest === envelope?.digest;
      if (!needsTitle && precedesSpendAuthority(ref.spendRevision, authority)) continue;
      let entry: CompressedFactEntry | undefined;
      if (this.readableInputs.has(ref.input)) {
        entry = readCompressedRecord(this.directory, file, ref);
        if (!entry) return undefined;
        this.contributorBytesRead += ref.bytes;
      } else if (ref.spendDigest && this.heldSpend && !precedesSpendAuthority(ref.spendRevision, authority)) {
        const answer = await this.heldSpend({ file, record: ref });
        if (answer === undefined) return undefined;
        entry = heldCompressedSpend(answer ?? undefined, { file, record: ref });
      }
      if (!entry) continue;
      if (!compressedFactsSameOwner(entry, next)) continue;
      if (ref.digest === envelope?.digest && !entry.nameOnly && !entry.adoptionFailed && !entry.spendNeedsRepair)
        prior = entry;
      if (eligibleCompressedSpend(entry)) candidates.push(entry);
    }
    let latest = authority;
    for (const entry of candidates) latest = laterSpendRevision(latest, completeSpendRevision(entry));
    let spent: CompressedFactEntry | undefined;
    for (const entry of candidates) {
      if (
        !precedesSpendAuthority(spendRevision(entry), latest) &&
        (!spent || compareSpendEntries(entry, spent, this.quotedAt) > 0)
      )
        spent = entry;
    }
    const current = latest ? { ...next, spendAuthority: latest } : next;
    if (!next.unreadable) return withKeptUndercount(spent, current, this.quotedAt, true);
    if (!prior && !spent) return current;
    const kept = prior ?? spent!;
    const { title, carriedName, complete } = kept;
    const spend = spent?.spend;
    return {
      ...current,
      nameOnly: undefined,
      title: compressedTitleCurrent(kept) ? title : undefined,
      carriedName:
        carriedName ??
        (title && !compressedTitleCurrent(kept) ? { label: title.label, fullLabel: title.fullLabel } : undefined),
      complete,
      hash: compressedEntryCurrent(kept, next as CompressedRevision) ? kept.hash : undefined,
      spend,
      spendRevision: spent && spendRevision(spent),
      spendOrigin:
        spend && spent
          ? {
              ...(spent.spendOrigin ?? compressedSpendOrigin(spent.threadId, spend, spent.hash)),
              retained: true,
            }
          : undefined,
    };
  }
}

// Post entries as batches of at most 4 MiB, at most one batch per second. The last batch stays for the reply.
export async function postCompressedBatches<T>(
  entries: readonly T[],
  signal: AbortSignal,
  post: (batch: T[]) => void,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T[]> {
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
  // True when the named segment file still exists.
  segmentPresent?: (file: string) => boolean;
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
  private readonly segmentPresent: (file: string) => boolean;
  private readonly segmentBytes: number;
  private readonly compactSegments: number;

  private readonly queue: CompressedFactEntry[] = [];
  private readonly flushed = new WeakMap<CompressedFactEntry, CompressedStoreRecord>();
  private readonly revisionTests = new WeakMap<CompressedFactEntry, () => boolean | undefined>();
  private readonly conditional = new WeakMap<CompressedFactEntry, CompressedStoreFollower>();
  private readonly finalized = new WeakMap<CompressedFactEntry, CompressedFactEntry>();
  private factsFollower?: CompressedStoreFollower;
  private covered = false;
  private readonly withdrawn = new WeakSet<CompressedFactEntry>();
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
    this.segmentPresent = options.segmentPresent ?? fs.existsSync;
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
  // `revisionHolds` runs at the write. A false answer withdraws the entry, and nothing writes its line.
  append(entries: readonly CompressedFactEntry[], revisionHolds?: () => boolean | undefined): Promise<boolean[]> {
    if (revisionHolds) for (const entry of entries) this.revisionTests.set(entry, revisionHolds);
    this.queue.push(...entries);
    return this.work().then(() => entries.map((entry) => this.flushed.has(entry)));
  }

  async appendCarryingFacts(
    entry: CompressedFactEntry,
    revisionHolds: () => boolean | undefined,
    follower?: CompressedStoreFollower,
  ): Promise<CompressedFactEntry | undefined> {
    this.factsFollower ??=
      follower ?? new CompressedStoreFollower(this.directory, this.statOf, this.yieldStep, this.openInput);
    if (entry.undercount || entry.unreadable) this.conditional.set(entry, this.factsFollower);
    const [written] = await this.append([entry], revisionHolds);
    return written || (await this.durable([entry])) ? this.finalized.get(entry) : undefined;
  }

  recordOf(entry: CompressedFactEntry): CompressedStoreRecord | undefined {
    return this.flushed.get(entry);
  }

  // True when every entry reaches the disk, or false when one is withdrawn or the holder is disposed first.
  durable(entries: readonly CompressedFactEntry[]): Promise<boolean> {
    if (entries.every((entry) => this.flushed.has(entry))) return Promise.resolve(true);
    if (entries.some((entry) => this.withdrawn.has(entry))) return Promise.resolve(false);
    if (this.disposed) return Promise.resolve(false);
    return new Promise((settle) => this.waiters.push({ entries, settle }));
  }

  // True when the entry's revision changed before its write.
  withdrew(entry: CompressedFactEntry): boolean {
    return this.withdrawn.has(entry);
  }

  // Run the queue until it is empty. A failed lease leaves the queue in place and retries after the jitter delay.
  work(): Promise<void> {
    return this.exclusive(() => this.run());
  }

  // One body at a time holds the writes of this holder.
  private exclusive(body: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.running ??= body().then(
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
    if (this.cancelRetry) return;
    this.cancelIdle?.();
    this.cancelIdle = null;
    if (this.queue.length && !this.token && !(await this.takeLease())) {
      this.retryLater();
      return;
    }
    const deferred = new Set<CompressedFactEntry>();
    while (this.queue.length && this.token && !this.disposed) {
      const first = this.queue[0];
      if (deferred.has(first)) {
        this.abandon();
        return;
      }
      const progress = await this.publishBatch();
      if (!this.token) return;
      if (!progress) {
        deferred.add(first);
        this.queue.push(this.queue.shift()!);
      }
      if (this.closedSegments >= this.compactSegments && this.compactionAllowed()) await this.compact(false);
      await this.yieldStep();
    }
    this.armIdleRelease();
  }

  private compactionAllowed(): boolean {
    return this.now() >= this.compactionRetryAt;
  }

  // The timed compaction waits for the appends to stop, because each one rewrites the whole store. While appends keep
  // arriving, the closed segment limit alone starts a compaction.
  private timedCompactionDue(): boolean {
    return (
      this.closedSegments > 0 &&
      this.now() - this.lastCompaction >= COMPACT_INTERVAL_MS &&
      this.compactionAllowed() &&
      this.segmentsOutweighShards(storeView(this.directory, listDirectory(this.directory)))
    );
  }

  // True when no shard exists or the closed segments hold at least as many bytes as the shards, so a compaction that
  // the segment limit did not force writes at most twice the bytes of the closed segments.
  private segmentsOutweighShards(view: StoreView): boolean {
    let segments = 0;
    let shards = 0;
    for (const stored of view.inputs) {
      if (stored.name === this.open?.name || !this.ownVersion(stored.name)) continue;
      const bytes = this.storedBytes(stored.name);
      if (stored.kind === 'shard') shards += bytes;
      else segments += bytes;
    }
    return shards === 0 || segments >= shards;
  }

  // A file that a compaction already retired holds no bytes.
  private storedBytes(name: string): number {
    try {
      return fs.statSync(path.join(this.directory, name)).size;
    } catch {
      return 0;
    }
  }

  // An append that arrives during the compaction keeps the lease for its own run.
  private async compactWhileIdle(): Promise<void> {
    await this.yieldStep();
    if (this.queue.length) return;
    await this.compact(false);
    if (this.token && !this.queue.length) this.abandonToken();
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
    this.covered = false;
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

  private async publishBatch(): Promise<boolean> {
    let bytes = 0;
    let taken = 0;
    let oversized = false;
    const lines: string[] = [];
    const prepared: CompressedFactEntry[] = [];
    while (taken < this.queue.length && bytes < this.segmentBytes) {
      const queued = this.queue[taken];
      const test = this.revisionTests.get(queued);
      let revision = test ? test() : true;
      if (revision === undefined) {
        if (!taken) return false;
        break;
      }
      if (!revision) {
        this.queue.splice(taken, 1);
        this.withdrawn.add(queued);
        this.settleWaiters();
        continue;
      }
      let entry = queued;
      const follower = this.conditional.get(queued);
      if (follower) {
        if (taken) break;
        if (!this.covered) {
          const covered = await follower.cover();
          if (!this.check() || !covered) return false;
          this.covered = true;
        }
        const final = await follower.carriedEntry(queued);
        if (!final) {
          this.covered = false;
          return false;
        }
        revision = test ? test() : true;
        if (revision === undefined) return false;
        if (!revision) {
          this.queue.splice(taken, 1);
          this.withdrawn.add(queued);
          this.settleWaiters();
          continue;
        }
        entry = final;
      }
      const {
        storeRecord: _reference,
        spendRecord: _spend,
        spendWitness: _witness,
        hasSpend: _hasSpend,
        revisionObservation: _observation,
        ...facts
      } = entry;
      const serialized = (segment: OpenSegment | null) => {
        const sequence = segment ? storeName(segment.name)!.seq : this.seq;
        const order: CompressedOrder = [this.epoch!.e, this.token!, sequence, (segment?.bytes ?? 0) + bytes];
        entry = { ...facts };
        if (eligibleCompressedSpend(entry) && !entry.spendRevision) {
          entry.spendRevision =
            !entry.unreadable && !entry.spendOrigin?.retained
              ? { mtimeMs: entry.mtimeMs, size: entry.size, order }
              : spendRevision(entry);
        }
        if ((verifiesCompressedBytes(entry) || entry.physicalOpening === true) && !recordedFactsOrder(entry))
          entry.factsOrder = order;
        entry = boundedCompressedEntry(entry);
        const line = `${JSON.stringify(entry)}\n`;
        return { line, length: Buffer.byteLength(line) };
      };
      let { line, length } = serialized(this.open);
      // A record above 4 MiB gets a segment file of its own.
      if (length > this.segmentBytes) {
        if (taken) break;
        oversized = true;
        if (this.open) ({ line, length } = serialized(null));
        lines.push(line);
        prepared.push(entry);
        bytes = length;
        taken = 1;
        break;
      }
      lines.push(line);
      prepared.push(entry);
      bytes += length;
      taken++;
      if (follower) break;
    }
    if (!taken) return true;
    if (!this.check()) return false;
    this.fault('segment:checked');
    if (oversized) this.closeSegment();
    const segment = this.open ?? this.openSegment();
    fs.writeSync(segment.fd, lines.join(''));
    fs.fsyncSync(segment.fd);
    segment.bytes += bytes;
    this.wrote(bytes);
    this.fault('segment:flushed');
    if (!this.flushReachedStore(segment)) return false;
    let offset = segment.bytes - bytes;
    for (const [at, flushed] of this.queue.splice(0, taken).entries()) {
      const line = lines[at];
      const length = Buffer.byteLength(line);
      const entry = prepared[at];
      const storeRecord = {
        input: segment.name,
        offset,
        bytes: length,
        digest: recordDigest(line),
        spendDigest: spendDigest(entry.spend),
        order: recordedFactsOrder(entry),
        spendRevision: eligibleCompressedSpend(entry) ? spendRevision(entry) : undefined,
      };
      this.flushed.set(flushed, storeRecord);
      this.finalized.set(flushed, { ...entry, storeRecord });
      if (this.covered && this.factsFollower && !this.factsFollower.noteAppend(entry, storeRecord))
        this.covered = false;
      offset += length;
    }
    this.settleWaiters();
    if (oversized || segment.bytes >= this.segmentBytes) this.closeSegment();
    return true;
  }

  // A holder paused since its publish check can write through the descriptor of a segment that a new holder compacted
  // and deleted. Its line is then in no store file, so the entries stay queued.
  private flushReachedStore(segment: OpenSegment): boolean {
    if (!this.check()) return false;
    if (this.segmentPresent(path.join(this.directory, segment.name))) return true;
    this.abandon();
    return false;
  }

  private settleWaiters(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) {
      if (waiter.entries.every((entry) => this.flushed.has(entry))) waiter.settle(true);
      else if (waiter.entries.some((entry) => this.withdrawn.has(entry))) waiter.settle(false);
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
    let refused = false;
    const unreadable = () => {
      refused = true;
    };
    const names = listDirectory(this.directory, unreadable);
    const view = storeView(this.directory, names, unreadable);
    this.fault('recovery:start');
    if (refused) {
      this.abandon();
      return;
    }
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
      (this.closedSegments && this.compactionDue(after) && this.segmentsOutweighShards(after))
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
    this.covered = false;
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
    const best = new Map<string, RankedFacts>();
    const openings = new Map<string, RankedEntry>();
    const spend = new Map<string, RankedSpend>();
    const quotedAt = this.now();
    for (const input of inputs) {
      this.readInputLines(input.name, (line, offset) => {
        const entry = parseEntry(line.toString('utf8'));
        if (!entry || !readableFactsVersion(entry.factsVersion)) return;
        const ranked = rankedLine(entry, input, offset);
        const held = best.get(entry.file);
        if (ranked.entry.verifiedBytes && !ranked.order) {
          ranked.record = referenceOf(entry, ranked, line);
          preserveRecordedOrder(ranked, entry, held);
        }
        noteCompleteSpend(entry, ranked, quotedAt);
        const stat = held ? this.statOf(entry.file) : null;
        const facts = rankFacts(held, ranked, stat);
        if (facts !== held) best.set(entry.file, facts);
        if (entry.physicalOpening === true && !entry.repairRetry) {
          const opening = openings.get(entry.file);
          if (!opening || compareRankedEntries(ranked, opening, stat) > 0) openings.set(entry.file, ranked);
        }
        const witness = rankSpend(
          entry,
          ranked,
          spend.get(entry.file),
          quotedAt,
          undefined,
          selectedCompleteSpend(facts),
        );
        if (witness) spend.set(entry.file, witness);
      });
      await this.yieldStep();
    }
    const kept = [...best.values()]
      .filter(({ row: { entry } }) => this.exists(entry.file) || this.exists(entry.file.replace(/\.zst$/, '')))
      .sort(({ row: left }, { row: right }) =>
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
    for (const ranked of kept.flatMap(({ row, latest }) => {
      const witness = spend.get(row.entry.file);
      const opening = openings.get(row.entry.file);
      const records =
        witness && rankedSameOwner(witness.ranked, row)
          ? new Set([row, latest, opening, witness.ranked, witness.authorityLine])
          : new Set([row, latest, opening]);
      return [...records]
        .filter((record) => record !== undefined)
        .sort((a, b) => compareOrder(factsOrder(a), factsOrder(b)));
    })) {
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
    if (this.timedCompactionDue()) {
      void this.exclusive(() => this.compactWhileIdle());
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
  options: {
    now?: () => number;
    yieldStep?: () => Promise<void>;
    statOf?: typeof compressedPhysicalStat;
    // The paths the store holds, when a follower already read it.
    known?: ReadonlyMap<string, unknown>;
    eligible?: () => boolean;
  } = {},
): Promise<void> {
  const now = options.now ?? performance.now.bind(performance);
  const yieldStep = options.yieldStep ?? yieldToEvents;
  const stored =
    options.known ??
    (await readCompressedStoreInSteps(holder.directory, options.statOf ?? compressedPhysicalStat, yieldStep)).entries;
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
      if (options.eligible?.() === false) return;
      sliceStarted = now();
    }
  }
  if (records.length) await holder.append(records, options.eligible);
}

// Adopt a twin and record the entry. The result is durable only after the entry's line is on disk, or false when the
// holder is disposed first, so the host keeps the plain path until the entry can no longer be lost. An entry can wait
// for the lease, so its write first compares the twin with the validated stat. A different stat restarts the adoption.
export async function recordCompressedAdoption(
  adoption: CompressedAdoptionInput,
  facts: CompressedStoreHolder,
  openings: CompressedStoreHolder,
): Promise<CompressedAdoptionResult & { durable: boolean }> {
  for (;;) {
    const result = await adoptCompressedTwin(adoption);
    const { physicalOpening } = result;
    const revisionHolds = physicalOpening
      ? () => adoptionRevisionCurrent(adoption.twin, result.revision, physicalOpening.stamp)
      : undefined;
    const [written] = await facts.append([result.entry], revisionHolds);
    const durable = written || (await facts.durable([result.entry]));
    if (!durable && facts.withdrew(result.entry)) continue;
    let openingDurable = true;
    if (durable && physicalOpening) {
      // A false answer keeps the plain path retained, so a later walk adopts again and writes the opening.
      const opening = compressedOpeningEntry({ ...result.entry, opening: physicalOpening.opening });
      const [written] = await openings.append([opening], revisionHolds);
      openingDurable = written || (await openings.durable([opening]));
    }
    return { ...result, durable: durable && openingDurable };
  }
}
