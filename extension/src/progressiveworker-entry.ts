import {
  readAgyHistoryPage,
  createAgySessionReducer,
  agyRetainedLine,
  readAgySession,
  readAgySessionAsync,
  type AgyCheckpoint,
  type AgyHistoryCursor,
} from './agyhistory';
import { sessionOutcomeOf, sessionStatFactsOf } from './transcript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCodexContext } from './codexcontext';
import { randomUUID } from 'node:crypto';
import {
  beginForwardSessionRecovery,
  ForwardRecoveryLimit,
  type ForwardReadOptions,
  type ForwardRecoveryControl,
  type IncrementalSessionResult,
} from './history';
import { parentPort } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { closeReadWindow, openReadWindow } from './readmeter';
import {
  readClaudeHistoryPageAsync,
  readClaudeSessionIncrementalAsync,
  type ClaudeForwardCheckpoint,
  type ClaudeHistoryCursor,
} from './claudehistory';
import {
  readCodexHistoryPageAsync,
  readCodexSessionIncrementalAsync,
  type CodexForwardCheckpoint,
  type CodexHistoryCursor,
} from './codexhistory';
import {
  codexStructuralAgentIds,
  codexSubagentFor,
  discoverCodexNewestTurn,
  codexAgentSpendReader,
  codexAgentSpendVersion,
  codexSpendIndex,
  readCodexDispatchedSpendQuantum,
  rememberRestartEvidence,
  releaseCodexDispatchSpend,
  retainCodexDispatchSpend,
  retainCodexDispatchSpendRoots,
  type CodexDispatchSpendEntry,
  scanForCodexPerson,
  type CodexPersonScan,
  readCodexSessionActivity,
  createCodexSessionReducer,
  readCodexSessionMeta,
  openingRecordOf,
  observeRolloutStat,
  codexSessionLineMayAffectRead,
  readCodexSessionTitlePair,
  readCodexTurnStarts,
  refreshCodexStructuralAgents,
  scanCodexDispatchReferencesAsync,
} from './codex';
import {
  adoptClaudeRepeatedMap,
  blankClaudeRepeated,
  claudeRepeatedMap,
  createClaudeRepeatedFilter,
  onClaudeRepeatedCoverage,
  type ClaudeRepeatedHeldMap,
} from './clauderepeated';
import { historyPageBytes } from './historypages';
import { claudeRelationshipKey } from './selectedsource';
import { applyHiddenTurnFields, hiddenTurnFields } from './parserstate';
import {
  agentSpendDependencyKey,
  ClaudeChildSessionCache,
  childSpendVersion,
  claudeAgentSpendVersion,
  claudeChildFileFor,
  claudeSubagentMetaReader,
  discoverClaudeChildSessions,
  discoverClaudeNewestTurn,
  isInside,
  normalizeFsPath,
  type SessionFile,
  commitSourceStamp,
  bindCommitSources,
  readClaudeAgentSpend,
  resolveClaudeDispatchReferences,
  scanClaudeRelationshipQuantum,
  readSessionMeta,
  createClaudeSessionReducer,
  claudeSessionLineMayAffectRead,
  claudeRetainedLine,
  readSessionTurnStarts,
  refreshRetainedClaudeAgentFacts,
  scanForAgentRun,
  scanForPerson,
  tailOf,
  withClaudeRepeated,
  revisionOf as fileRevisionOf,
  type FileRevision,
  relationshipStamp,
  sameRelationshipStamp,
  RELATIONSHIP_QUANTUM_BYTES,
  RELATIONSHIP_RESERVE_BYTES,
  RELATIONSHIP_SLICE_MS,
  type PersonScan,
} from './transcript';
import {
  CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
  DISPATCH_FACTS_VERSION,
  limitCodexDispatchCursors,
  needsAgentRunScan,
  onlyGrew,
  scanKeptThroughGrowth,
  type ClaudeChildReferenceCacheEntry,
  type DispatchActivityRead,
  type SavedDispatchFacts,
} from './derivedcache';
import {
  AgentSpendCache,
  readChildSpend,
  childSpendRevisionKey,
  scanLinesIncremental,
  spendFileVersion,
  type AgentSpend,
  type AgentSessionTargetLookup,
  type AgentSpendLookup,
  type AgentSpendRef,
} from './agentspend';
import type {
  ProgressiveCheckpoint,
  ProgressiveRequest,
  ProgressiveWireRequest,
  ProgressiveResult,
  ProgressiveValue,
  DiscoveryCheckpoint,
  DiscoveryCharges,
} from './progressiveworker';
import type {
  CompressedLoadRequest,
  CompressedNamesReceipt,
  CompressedTransferCancellation,
  CompressedTransferPart,
  CompressedTransferReceipt,
  DispatchRootCharges,
  DispatchSessionFacts,
  WorkerWindowRead,
} from './progressiveworker';
import {
  CHILD_EDIT_READ_BYTES,
  assembleCompressedLoad,
  progressiveTurns,
  workerErrorIdentity,
  discoveryCompatibility,
  compatibleDiscovery,
  validDiscoveryCheckpoint,
} from './progressiveworker';
import { TURN_QUIET_MS, statusOf } from './turncard';
import {
  DispatchReceipts,
  dispatchFileKey,
  dispatchRevisionModifiedAt,
  dispatchStartupRevision,
  joinedStoreRevision,
  type DispatchRelationshipStop,
  type DispatchRootNames,
  type DispatchStartupRevision,
  type DispatchStoreRevisions,
} from './dispatchreceipts';
import { admittedDispatchReferences } from './turnrail';
import {
  CompressedStoreFollower,
  CompressedStoreHolder,
  type CompressedStorePaths,
  compareCompressedObservations,
  compressedByteObservation,
  compressedEntryCurrent,
  compressedEntrySeed,
  postCompressedBatches,
  recordCompressedAdoption,
  recordCompressedNames,
} from './compressedstore';
import { CompressedBackfill, DiscoveryQueue } from './compressedbackfill';
import { folderMatcher } from './transcript';
import {
  announceCompressedDecodes,
  COMPRESSED_ROLLOUT_NAME,
  compressedByteSource,
  compressedStat,
  decodeCompressedRollout,
  hashCompressedRollout,
  isCompressedRollout,
  type CompressedBody,
  type CompressedBodyRead,
} from './compressedrollouts';

const agentSpends = new AgentSpendCache();
const claudeChildSessions = new ClaudeChildSessionCache();
const claudeChildReferences = new Map<string, ClaudeChildReferenceCacheEntry>();
// The highest source generation of each reference row that this worker thread received or wrote, by row key. The host
// refuses a row older than the one it holds. So a row that the worker builds for a source without a held row starts above it.
const sourceGenerations = new Map<string, number>();
function noteSourceGeneration(key: string, entry: ClaudeChildReferenceCacheEntry): void {
  const generation = entry.sourceGeneration ?? 0;
  if (generation > (sourceGenerations.get(key) ?? 0)) sourceGenerations.set(key, generation);
}
// The read cause of each candidate source whose relationship scan started from byte 0 and has not reached its target.
// Later slices of that scan count their bytes under this cause.
const relationshipOrigins = new Map<string, 'noEntry' | 'rejected'>();
// Cached subagent revisions invalidate the dispatched session's spend.
// Claude retains its append scan for reader input.
// Codex retains its prompt cursor across quiet reads to correct copied-turn classification.
interface HeldDispatchFacts {
  revision: FileRevision;
  tree: string;
  facts: DispatchSessionFacts;
  refreshAt: number;
  person?: PersonScan;
  codexPerson?: CodexPersonScan;
  codexDependencies?: string[];
  sourceGeneration?: number;
  spendPending?: boolean;
  // Whether a later activation can reuse these facts for the same revision and tree.
  settled?: boolean;
  activity?: DispatchActivityRead;
  // True when the repeated-record map covered the file after an activity read that it did not cover.
  activityStale?: boolean;
  saved?: SavedDispatchFacts;
}
const dispatchFacts = new Map<string, HeldDispatchFacts>();
// The bytes of each dispatched Claude session's last spend read, by session ID, so a later read from byte 0 counts as a restart.
const claudeSpendEnds = new Map<string, number>();
// Row keys this worker already looked up for saved dispatched facts, so an entry the worker dropped stays dropped.
const seededDispatchFacts = new Set<string>();
// The settled facts each dispatched file saves with its reference row, by row key, from the last dispatch pass.
// Null before this worker's first pass, so reply rows keep the facts they arrived with.
let savedDispatchFacts: Map<string, SavedDispatchFacts> | null = null;
// The dispatch references of the last complete discovery reply and the roots it answered for. A spend-only request
// reads their facts again without a discovery epoch.
let heldDispatchReferences: {
  scope: string;
  references: readonly import('./transcript').ClaudeChildSessionReference[];
  admittedReferences: ReturnType<typeof admittedDispatchReferences>;
} | null = null;
// A new worker takes a dispatched file's facts from its saved reference row once.
function seededDispatch(file: string): HeldDispatchFacts | undefined {
  const key = normalizeFsPath(file);
  if (seededDispatchFacts.has(key)) return undefined;
  seededDispatchFacts.add(key);
  const saved = claudeChildReferences.get(key)?.dispatch;
  if (saved?.version !== DISPATCH_FACTS_VERSION) return undefined;
  const held: HeldDispatchFacts = {
    revision: saved.revision,
    tree: saved.tree,
    facts: saved.facts,
    refreshAt: Number.POSITIVE_INFINITY,
    codexDependencies: saved.codexDependencies,
    sourceGeneration: saved.sourceGeneration,
    settled: true,
    activity: saved.activity,
    // A map that covered the file before this first visit sent its notice to no held facts.
    activityStale:
      saved.activity?.covered === false && claudeRepeatedMap(file, Number.MAX_SAFE_INTEGER, 0)?.covered === true,
    saved,
  };
  dispatchFacts.set(file, held);
  return held;
}
// A reply row carries the head its file named and its settled dispatched facts, so the next activation
// resolves an unchanged child with one stat and reuses unchanged dispatched spend.
function withSavedFacts([file, entry]: [string, ClaudeChildReferenceCacheEntry]): [
  string,
  ClaudeChildReferenceCacheEntry,
] {
  const head = claudeChildSessions.heads().get(file);
  let row = !head || head === entry.head ? entry : { ...entry, head };
  if (savedDispatchFacts) {
    const dispatch = savedDispatchFacts.get(file);
    if (dispatch) row = dispatch === row.dispatch ? row : { ...row, dispatch };
    else if (row.dispatch) {
      const { dispatch: _dispatch, ...rest } = row;
      row = rest;
    }
  }
  return [file, row];
}
const DISPATCH_METADATA_BYTES = 256 * 1024;
export const CODEX_DISPATCH_REQUEST_BYTES = 8 * 1024 * 1024;
// The receipt scan's limits in each slice. Each step advances the scan by at most one store entry and one file
// check.
const RECEIPT_SLICE_MS = 1500;
const RECEIPT_STEPS = 65536;
// The steps that one event-loop turn of the receipt scan runs. A receipt filesystem call averages about 0.5 ms in a
// recorded large store, so a window read enters the worker about 4 ms behind a scan turn. One slow call has no bound. While a
// window read runs, the scan runs one step in each event-loop turn.
const RECEIPT_TURN_STEPS = 8;
const receiptScanTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
let discoveryYield = false;
let discoveryEpoch: DiscoveryCheckpoint | null = null;
// The reference rows of this worker's last discovery reply, by key, with the epoch and sequence of that reply. A row keeps
// its entry and the head and dispatch facts that the reply added to it.
let sentReferences: {
  epoch: string;
  sequence: number;
  rows: Map<string, { entry: ClaudeChildReferenceCacheEntry; head: unknown; dispatch: unknown }>;
} | null = null;
// A source's identity in a discovery epoch. A NUL separates the fields, because no path holds one.
function discoverySourceKey(row: SessionFile): string {
  return `${normalizeFsPath(row.file)}\0${row.sessionId}\0${row.agent}\0${row.childTranscript === true}`;
}
// The parent keys of the current epoch. The worker builds them when an epoch starts and when a root change replaces its
// parents. The host returns the epoch's own checkpoint, so an adopted checkpoint of the same epoch keeps them.
let epochParentKeys: { epoch: string | undefined; keys: Set<string> } | null = null;
// The files of the sources that the worker marked complete in an epoch because they were missing, by row key.
// The worker checks each one again before a complete reply of that epoch, whether or not the walk still reaches it.
let missingSources: { epoch: string | undefined; files: Map<string, string> } | null = null;
interface ReceiptScan {
  epoch: string | undefined;
  store: DispatchReceipts;
  // Receipt lookups read this catalog, which follows the epoch when its repository roots change. It is the epoch's catalog
  // plus the rows of `compressed`.
  catalog: SessionFile[];
  // The compressed rollout names whose rows the catalog holds.
  compressed: CompressedRequesters | null;
  steps: ReturnType<DispatchReceipts['relationships']>;
  // Each visited launch whose read reached a catalog lookup, with the identities it looked up, found or not.
  launches: Map<string, string[]>;
  references: Map<string, import('./transcript').ClaudeDispatchSessionReference>;
  retries: string[];
  retry: ReturnType<DispatchReceipts['relationship']> | null;
  storeRead: boolean;
  competitionRefused: boolean;
  controller: AbortController;
  // The physical identity of the store directory when the scan opened it.
  storeIdentity: string;
  // The store revision at the opening of the scan, or undefined when the store proves nothing about a later read.
  storeRevision: string | undefined;
  // The parts of the store revision that the root names and the cache reads of the scan answer for. The next epoch follows a
  // part that differs or is undefined.
  revisions: DispatchStoreRevisions;
  // The names of the last complete listing of the store root, by launch ID.
  rootNames: Map<string, string>;
  // Each launch whose last read used the relationship cache.
  cacheLaunches: Set<string>;
  // The published file that the last read of each launch threw on. `stable` is true when the read before took the same stats.
  unread: Map<string, { name: string; revision?: string; stable: boolean }>;
  // The root entries that the last read of each launch found absent.
  absent: Map<string, string[]>;
  // Each launch that waits for another read. Its last read ran in a reused scan without proof. Or it threw on a present
  // published file, or found absent a root entry that the listing holds.
  owed: Set<string>;
  // Each launch that this scan read.
  read: Set<string>;
  // What a reused scan follows, or null for a scan from the first entry.
  follow: ReceiptFollow | null;
  // True after a refused read.
  unproved: boolean;
  // Each launch that a step named, with or without a link.
  visited: Set<string>;
  // The dispatched transcript of each linked launch, with the revision of its opening check.
  startups: Map<string, DispatchStartupRevision>;
  // The stop of each launch whose last read named both identities and ended without a link.
  stops: Map<string, DispatchRelationshipStop>;
  // When the scan that last read the store from its first entry opened. A reused scan keeps the time of the scan it reused.
  fullAt: number;
  // Each launch that a reused scan sent to be read again and that has not been read yet, with true when the launch ended
  // without a link in the completed scan.
  reuseRetries: Map<string, boolean>;
  // Each launch that a reused scan kept from the completed scan and has not sent to be read again, with true when the launch
  // ended without a link in the completed scan. A fresh scan holds none.
  reuseClasses: Map<string, boolean>;
}
let receiptScan: ReceiptScan | null = null;
// The store revision parts at the opening of a reused scan, what the scan follows, and its counts. `young` is true when a
// part was too young to read. `launches` holds each launch that the follow sends to be read again.
interface ReceiptFollow {
  before: DispatchStoreRevisions;
  young: boolean;
  root: boolean;
  cache: boolean;
  names: number;
  changed: number;
  launches: Set<string>;
}
// The discovery pass looks up compressed rollouts by their filename IDs. A duplicate ID maps to null.
type CompressedRequesters = Map<string, string | null>;
let compressedRequesters: CompressedRequesters | null = null;
const compressedRequesterLists = new WeakMap<readonly string[], CompressedRequesters>();
function compressedRequestersOf(names: readonly string[]): CompressedRequesters {
  const held = compressedRequesterLists.get(names);
  if (held) return held;
  const files: CompressedRequesters = new Map();
  for (const file of names) {
    const sessionId = isCompressedRollout(file) ? COMPRESSED_ROLLOUT_NAME.exec(file)?.[1] : undefined;
    if (sessionId !== undefined) files.set(sessionId, files.has(sessionId) ? null : file);
  }
  compressedRequesterLists.set(names, files);
  return files;
}
// The catalog of a receipt scan. The parents of a discovery request hold no compressed rollout, so a receipt whose requester is
// a compressed rollout finds no requester row among them. The scan adds a Codex row for each compressed name whose session
// ID one name alone carries and no row of the catalog holds. The host matches a parent by its session ID alone, so a row of
// any agent with that ID excludes the name. The lookup reads only the agent, the session ID and the file of an added row.
// The catalog itself returns when there is no row to add.
function receiptCatalogOf(catalog: SessionFile[]): SessionFile[] {
  if (!compressedRequesters?.size) return catalog;
  const held = new Set(catalog.map((row) => row.sessionId));
  const added: SessionFile[] = [];
  for (const [sessionId, file] of compressedRequesters)
    if (file !== null && !held.has(sessionId)) added.push({ agent: 'codex', sessionId, file } as SessionFile);
  return added.length ? [...catalog, ...added] : catalog;
}
// Sets the catalog of an open scan from its epoch's catalog. Each recorded launch whose identities changed rows is read again.
function updateReceiptCatalog(scan: ReceiptScan, catalog: SessionFile[]): void {
  const next = receiptCatalogOf(catalog);
  const changed = changedCatalogIdentities(scan.catalog, next, scan.store.platform);
  for (const [launchId, identities] of scan.launches)
    if (identities.some((identity) => changed.has(identity))) retryReceiptLaunch(scan, launchId);
  scan.catalog = next;
  scan.compressed = compressedRequesters;
}
// A completed scan answers a new epoch only within the full pass age bound of the host's walk gate, from the opening of the
// scan that last read the store from its first entry.
const RECEIPT_SCAN_REUSE_MAX_AGE_MS = 10 * 60_000;
// The last completed receipt scan. The next epoch reuses it unless keptScanRefusal names a reason, and follows a store that
// moved.
let keptReceiptScan: ReceiptScan | null = null;
// Why the last receipt scan of this worker closed. The next scan counts it when it opens.
let receiptScanClosed: 'epoch' | 'store' | 'refusal' | 'completion' | undefined;
const RECEIPT_SCAN_OPEN_CHARGES = {
  epoch: 'receiptScanOpensAfterEpoch',
  store: 'receiptScanOpensAfterStore',
  refusal: 'receiptScanOpensAfterRefusal',
  completion: 'receiptScanOpensAfterCompletion',
} as const;
// Why a completed scan cannot answer the next epoch, in the order that the gate checks.
const KEPT_SCAN_REFUSAL_CHARGES = {
  store: 'receiptScanOpensAfterCompletionStore',
  age: 'receiptScanOpensAfterCompletionAge',
  unproved: 'receiptScanOpensAfterCompletionUnproved',
} as const;
type ReceiptOpenCharge =
  | 'receiptScanOpens'
  | 'receiptScanOpensNewWorker'
  | 'receiptScanReuses'
  | (typeof RECEIPT_SCAN_OPEN_CHARGES)[keyof typeof RECEIPT_SCAN_OPEN_CHARGES]
  | (typeof KEPT_SCAN_REFUSAL_CHARGES)[keyof typeof KEPT_SCAN_REFUSAL_CHARGES];
// Receipt scans and receipt work that no reply counted yet, by the repository roots of the request that did them. The worker
// counts them in its next reply to an uncancelled discovery request for the same roots, so a scan that opened in a cancelled
// request and the launches and turns of that request still count, and no other roots receive them.
interface HeldReceiptCounts {
  opens: ReceiptOpenCharge[];
  work: {
    receiptLaunchesRead: number;
    receiptLaunchesRejectedAtRequester: number;
    receiptScanTurns: number;
    receiptScanReuseLaunches: number;
    receiptScanReuseLaunchesUnlinked: number;
    receiptScanReuseUnlinkedSession: number;
    receiptScanReuseUnlinkedFile: number;
    receiptScanReuseUnlinkedPath: number;
    receiptScanReuseUnlinkedOpening: number;
  };
}
const heldReceiptCounts = new Map<string, HeldReceiptCounts>();
function heldReceiptCountsFor(scope: string): HeldReceiptCounts {
  let held = heldReceiptCounts.get(scope);
  if (!held) {
    held = {
      opens: [],
      work: {
        receiptLaunchesRead: 0,
        receiptLaunchesRejectedAtRequester: 0,
        receiptScanTurns: 0,
        receiptScanReuseLaunches: 0,
        receiptScanReuseLaunchesUnlinked: 0,
        receiptScanReuseUnlinkedSession: 0,
        receiptScanReuseUnlinkedFile: 0,
        receiptScanReuseUnlinkedPath: 0,
        receiptScanReuseUnlinkedOpening: 0,
      },
    };
    heldReceiptCounts.set(scope, held);
  }
  return held;
}
function holdReceiptWork(charges: DiscoveryCharges, scope: string): void {
  const { work } = heldReceiptCountsFor(scope);
  for (const key of Object.keys(work) as Array<keyof HeldReceiptCounts['work']>) work[key] += charges[key]!;
}
function recordHeldReceiptCounts(charges: DiscoveryCharges, scope: string): void {
  const held = heldReceiptCounts.get(scope);
  if (!held) return;
  heldReceiptCounts.delete(scope);
  for (const key of held.opens) charges[key] = (charges[key] ?? 0) + 1;
  for (const key of Object.keys(held.work) as Array<keyof HeldReceiptCounts['work']>) charges[key]! += held.work[key];
}
function closeReceiptScan(cause: 'epoch' | 'store' | 'refusal'): void {
  if (receiptScan) receiptScanClosed = cause;
  receiptScan?.controller.abort();
  receiptScan?.steps.return(undefined);
  receiptScan?.retry?.return(null);
  receiptScan = null;
  keptReceiptScan = null;
}
// The first reason that a completed scan cannot answer a new epoch, or undefined when it can. The store must keep its
// identity, no read of the completed scan was refused, and the scan that read the store must be within the age bound.
// A clock that reads earlier than the opening of that scan proves no age.
function keptScanRefusal(kept: ReceiptScan): keyof typeof KEPT_SCAN_REFUSAL_CHARGES | undefined {
  if (kept.store.storeIdentity() !== kept.storeIdentity) return 'store';
  const age = Date.now() - kept.fullAt;
  if (age < 0 || age > RECEIPT_SCAN_REUSE_MAX_AGE_MS) return 'age';
  return kept.unproved ? 'unproved' : undefined;
}
// The count of each stop of a launch without a link that a reused scan holds.
const REUSE_UNLINKED_CHARGES = {
  session: 'receiptScanReuseUnlinkedSession',
  file: 'receiptScanReuseUnlinkedFile',
  path: 'receiptScanReuseUnlinkedPath',
  opening: 'receiptScanReuseUnlinkedOpening',
} as const satisfies Record<DispatchRelationshipStop, keyof HeldReceiptCounts['work']>;
// A scan for a new epoch from a completed scan. It reads again each launch whose requester or dispatched session changed
// catalog rows. It also reads again each launch without a link whose read went past the file comparison of its dispatched
// session. Such a read depends on files outside the store, such as the opening of the dispatched transcript. A launch without a
// link can stop at the lookup of its dispatched session or at the file comparison. Such a read uses only store files and
// catalog rows. So only a change of those rows or of the store can link it. Any other launch without a link stopped at its requester or on
// a store file. Arc publishes each such file with a new name in the store root, which the follow of a moved root reads.
// A young part follows at once and proves nothing. The steps of the scan then check the dispatched transcript of each link
// that the scan holds. `work` counts each launch without a link that names both identities, by its
// stop.
function reusedReceiptScan(
  kept: ReceiptScan,
  epoch: DiscoveryCheckpoint,
  work: HeldReceiptCounts['work'],
): ReceiptScan {
  const catalog = receiptCatalogOf(epoch.catalog);
  const changed = changedCatalogIdentities(kept.catalog, catalog, kept.store.platform);
  const before = kept.store.storeRevisions();
  const scan: ReceiptScan = {
    ...kept,
    storeRevision: joinedStoreRevision(before),
    read: new Set(),
    follow: {
      before,
      young: before.root === undefined || before.cache === undefined,
      root: before.root === undefined || before.root !== kept.revisions.root,
      cache: before.cache === undefined || before.cache !== kept.revisions.cache,
      names: 0,
      changed: 0,
      launches: new Set(),
    },
    epoch: epoch.epoch,
    catalog,
    compressed: compressedRequesters,
    controller: new AbortController(),
    steps: keptStartupChecks(() => scan),
    retries: [],
    retry: null,
    storeRead: false,
    competitionRefused: false,
    unproved: false,
    reuseRetries: new Map(),
    reuseClasses: new Map([...kept.visited].map((launchId) => [launchId, !kept.references.has(launchId)])),
  };
  for (const launchId of kept.visited) {
    // The identities hold the requester, and then the dispatched session when the read reached it.
    const identities = scan.launches.get(launchId) ?? [];
    const unlinked = scan.reuseClasses.get(launchId)! && identities.length > 1;
    const stop = unlinked ? scan.stops.get(launchId) : undefined;
    if (stop) work[REUSE_UNLINKED_CHARGES[stop]]++;
    if (identities.some((identity) => changed.has(identity))) retryReceiptLaunch(scan, launchId);
    else if (unlinked && stop !== 'session' && stop !== 'file') retryReceiptLaunch(scan, launchId);
  }
  return scan;
}
// Sends a launch of a scan to be read again. A launch that a reused scan kept from the completed scan counts as a reuse read
// when that read ends, with its class from the completed scan. Each launch counts once in a reused scan.
function retryReceiptLaunch(scan: ReceiptScan, launchId: string): void {
  scan.launches.delete(launchId);
  scan.references.delete(launchId);
  scan.startups.delete(launchId);
  scan.stops.delete(launchId);
  scan.retries.push(launchId);
  const unlinked = scan.reuseClasses.get(launchId);
  if (unlinked === undefined) return;
  scan.reuseClasses.delete(launchId);
  scan.reuseRetries.set(launchId, unlinked);
}
// Sends a launch of a reused scan to be read again for its follow, once in the scan. A launch that the scan read already
// stays owed when the store moved after that read, because the follow then lacks proof.
function followReceiptLaunch(scan: ReceiptScan, launchId: string): void {
  if (scan.read.has(launchId) || scan.follow!.launches.has(launchId)) return;
  scan.follow!.launches.add(launchId);
  retryReceiptLaunch(scan, launchId);
}
// The steps of a reused scan. The first step reads nothing. A follow of the root then lists the root with one step for each
// entry. It sends each launch whose names changed to be read again. A follow of the cache sends each launch whose last read
// used the cache. A follow then sends each owed launch. Each later step stats the dispatched transcript of one
// link. A transcript that cannot be read sends its launch to be read again. So does a transcript whose device, inode, size
// or times differ from its opening check, so the read checks the opening again.
function* keptStartupChecks(current: () => ReceiptScan): ReceiptScan['steps'] {
  yield { entries: 0, bytes: 0, checks: 0 };
  const scan = current();
  const follow = scan.follow!;
  if (follow.root) {
    const listing: DispatchRootNames = { names: new Map(), complete: false };
    yield* scan.store.relationships([], scan.controller.signal, listing, false);
    if (listing.complete) {
      for (const launchId of new Set([...scan.rootNames.keys(), ...listing.names.keys()])) {
        const names = [scan.rootNames.get(launchId), listing.names.get(launchId)];
        follow.names += names[1]?.split('\0').length ?? 0;
        if (names[0] === names[1]) continue;
        follow.changed++;
        // A full scan reads only a launch that has a directory.
        if (names.some((value) => value?.split('\0').includes(`${launchId}/`))) followReceiptLaunch(scan, launchId);
      }
      scan.rootNames = listing.names;
      scan.revisions = { ...scan.revisions, root: follow.before.root };
    } else {
      // An incomplete listing ends the scan as a refused competition. A scan that holds links then ends with a progress reply,
      // and the next request reads the store from its first entry.
      scan.competitionRefused = true;
      scan.unproved = true;
      return;
    }
  }
  if (follow.cache) {
    for (const launchId of scan.cacheLaunches) followReceiptLaunch(scan, launchId);
    scan.revisions = { ...scan.revisions, cache: follow.before.cache };
  }
  for (const launchId of scan.owed) followReceiptLaunch(scan, launchId);
  for (const [launchId, startup] of [...scan.startups]) {
    if (!scan.references.has(launchId)) continue;
    let moved: boolean;
    try {
      moved = dispatchStartupRevision(startup.file) !== startup.revision;
    } catch {
      moved = true;
    }
    if (moved) retryReceiptLaunch(scan, launchId);
    yield { entries: 0, bytes: 0, checks: 1 };
  }
}
const catalogIdentity = (agent: string, sessionId: string) => JSON.stringify([agent, sessionId]);
// A row's file in the form that the file comparison of a receipt read uses on the platform of the receipts. Two rows with one
// key compare the same way.
const catalogRowPlace = (row: SessionFile, platform: NodeJS.Platform) =>
  `${dispatchFileKey(row.file, platform)}|${row.childTranscript === true}`;
function changedCatalogIdentities(
  before: readonly SessionFile[],
  after: readonly SessionFile[],
  platform: NodeJS.Platform,
): Set<string> {
  const rows = (catalog: readonly SessionFile[]) => {
    const byIdentity = new Map<string, string[]>();
    for (const row of catalog) {
      const key = catalogIdentity(row.agent, row.sessionId);
      const files = byIdentity.get(key) ?? [];
      files.push(catalogRowPlace(row, platform));
      byIdentity.set(key, files);
    }
    return new Map([...byIdentity].map(([key, files]) => [key, JSON.stringify(files.sort())]));
  };
  const held = rows(before);
  const next = rows(after);
  return new Set([...held.keys(), ...next.keys()].filter((key) => held.get(key) !== next.get(key)));
}
const admittedCompletions = new Set<string>();
const epochChildSessions = new Map<string, import('./transcript').ClaudeChildSessionFile | null>();
let discoveryPosition = 0;
let metadataRecovery: {
  file: string;
  sessionId: string;
  agyRecovery?: number;
  work: ForwardReadOptions & { recovery: ForwardRecoveryControl };
  scan: Generator<void, IncrementalSessionResult<unknown>>;
} | null = null;

function dispatchActivity(
  file: string,
  sessionId: string,
  revision: FileRevision,
  now: number,
  agent: 'claude' | 'codex',
): {
  activeUntil: number;
  unfinished: boolean;
} {
  const outcome =
    agent === 'codex'
      ? readCodexSessionActivity(file, DISPATCH_METADATA_BYTES).outcome
      : readSessionMeta(file, DISPATCH_METADATA_BYTES, sessionId, true).outcome;
  if (outcome === null) {
    return { activeUntil: revision.mtimeMs + TURN_QUIET_MS, unfinished: true };
  }
  const endedAt = outcome.endedAt > 0 ? outcome.endedAt : revision.mtimeMs;
  return {
    activeUntil: statusOf({ ...outcome, endedAt }, true, now) === 'running' ? endedAt + TURN_QUIET_MS : 0,
    unfinished: !outcome.finished,
  };
}

function revisionOf(file: string): FileRevision | null {
  try {
    return fileRevisionOf(fs.statSync(file, { bigint: true }));
  } catch {
    return null;
  }
}

// The one decoded body this worker holds, and the one decode that window and page requests wait on. A request for
// another compressed path aborts the running decode and waits until every request on the current path ends, so the
// worker never decodes or holds two bodies. The host releases the body when the selection leaves its session.
interface BodyDecode {
  file: string;
  controller: AbortController;
  // Requests that wait on this decode. The decode stops when the last of them ends.
  waiters: number;
  read: Promise<CompressedBodyRead>;
}
let heldBody: CompressedBody | null = null;
let bodyDecode: BodyDecode | null = null;
// The compressed path that window and page requests read, how many of them run, and the requests for another path
// that wait until they end.
let bodyPath: string | null = null;
let bodyUsers = 0;
let bodyDrained: Array<() => void> = [];
// The host's body releases, and the body that each window or page request read with the release count before it
// opened that body, by the signal of the request. A window whose body the host released during its open or read
// answers stale with `interrupted`.
let bodyReleases = 0;
const requestBodies = new WeakMap<AbortSignal, { body: CompressedBody; releases: number }>();
// Every host release in arrival order, the last release of each file, and the release count that each request read
// when it arrived, by its signal. A request whose file the host released after it arrived drops the body it decoded.
let releaseSequence = 0;
const fileReleases = new Map<string, number>();
const arrivalReleases = new WeakMap<AbortSignal, number>();

function releaseCompressedBody(): void {
  heldBody = null;
  bodyDecode?.controller.abort();
}

// The host releases the body of `file`. The release stamps the file for the requests that wait. A release of another
// path than `bodyPath` changes nothing else. The released path leaves `bodyPath`, so a later request for it waits until
// the reads of the released body end and never decodes a second body beside it.
function releaseHostBody(file: string): void {
  fileReleases.set(file, ++releaseSequence);
  if (bodyPath !== file) return;
  bodyReleases += 1;
  bodyPath = null;
  releaseCompressedBody();
}

// Enter the compressed path of a window or page request. A request for another path, or any request while one waits,
// waits until the requests on the current path end. False when the request ended first.
async function enterBodyPath(file: string, signal: AbortSignal): Promise<boolean> {
  // Another request changes the path and the user count while this one waits.
  const mustWait = () => bodyUsers > 0 && (bodyPath !== file || bodyDrained.length > 0);
  while (mustWait()) {
    if (bodyPath !== file) releaseCompressedBody();
    await new Promise<void>((resolve) => bodyDrained.push(resolve));
  }
  if (signal.aborted) return false;
  if (bodyPath !== file) {
    releaseCompressedBody();
    bodyPath = file;
  }
  bodyUsers += 1;
  return true;
}

// A request whose file the host released after the request arrived keeps no body. It drops the body it decoded, as a
// release during its read does.
function releasedSinceArrival(file: string, body: CompressedBody, signal: AbortSignal): boolean {
  if ((fileReleases.get(file) ?? 0) <= (arrivalReleases.get(signal) ?? releaseSequence)) return false;
  if (heldBody === body) heldBody = null;
  if (bodyPath === file) bodyPath = null;
  return true;
}

function leaveBodyPath(): void {
  bodyUsers -= 1;
  if (bodyUsers > 0) return;
  const drained = bodyDrained;
  bodyDrained = [];
  for (const resolve of drained) resolve();
}

// Wait on a decode. A request that ends stops waiting, and the decode stops when no request waits on it.
async function awaitDecode(decode: BodyDecode, signal: AbortSignal): Promise<CompressedBodyRead> {
  decode.waiters += 1;
  const leave = () => {
    decode.waiters -= 1;
    if (decode.waiters === 0) decode.controller.abort();
  };
  signal.addEventListener('abort', leave, { once: true });
  try {
    const read = await decode.read;
    return signal.aborted ? { kind: 'cancelled' } : read;
  } finally {
    if (!signal.aborted) {
      signal.removeEventListener('abort', leave);
      decode.waiters -= 1;
    }
  }
}

// The decoded body of a compressed rollout. `verify` hashes the file again, and a hash or revision that differs from
// the held body decodes the file again. Without `verify` an unchanged `fstat` keeps the held body. A decode that a
// release or another path stopped answers `cancelled`.
async function openCompressedBody(
  file: string,
  verify: boolean,
  signal: AbortSignal,
  limits?: import('./progressiveworker').ProgressiveInput['compressedLimits'],
): Promise<CompressedBodyRead> {
  if (heldBody && heldBody.file !== file) heldBody = null;
  if (heldBody) {
    const body = heldBody;
    const stat = compressedStat(file);
    if (stat && sameRevision(stat, body.stat)) {
      if (!verify) return { kind: 'body', body };
      const hashed = await hashCompressedRollout(file, signal);
      if (signal.aborted) return { kind: 'cancelled' };
      // A release during the hash dropped the body, so the request answers like a stopped decode.
      if (heldBody !== body) return { kind: 'cancelled' };
      if (hashed && hashed.hash === body.hash && sameRevision(hashed.stat, body.stat)) return { kind: 'body', body };
    }
    if (heldBody === body) heldBody = null;
  }
  // A stopped decode ends within one chunk. A new one starts after it.
  for (let running = bodyDecode; running?.controller.signal.aborted; running = bodyDecode) await running.read;
  if (signal.aborted) return { kind: 'cancelled' };
  if (!bodyDecode) {
    const controller = new AbortController();
    const decode: BodyDecode = {
      file,
      controller,
      waiters: 0,
      read: decodeCompressedRollout(file, { ...limits, signal: controller.signal }).then((read) => {
        if (bodyDecode === decode) bodyDecode = null;
        if (controller.signal.aborted) return { kind: 'cancelled' };
        if (read.kind === 'body' && bodyPath === file) heldBody = read.body;
        return read;
      }),
    };
    bodyDecode = decode;
  }
  return awaitDecode(bodyDecode, signal);
}

function missingFile(file: string): boolean {
  try {
    fs.statSync(file);
    return false;
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
}

function sameRevision(left: FileRevision | null, right: FileRevision | null): boolean {
  return (
    !!left &&
    !!right &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

// Accepted evidence at the current end permits reuse after heavy cursor state is evicted.
function qualifiedRelationships(
  held: ClaudeChildReferenceCacheEntry | undefined,
  parent: { agent: string; sessionId: string; childTranscript?: boolean },
  revision: import('./transcript').RelationshipStamp,
): boolean {
  if (!revision) return false;
  const evidence = held?.claudeCursor?.evidence ?? held?.cursor?.evidence ?? held?.evidence;
  return (
    !!evidence &&
    sameRelationshipStamp(evidence.accepted, revision) &&
    !evidence.validation &&
    held?.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION &&
    held.source === parent.agent &&
    held.sessionId === parent.sessionId &&
    held.childTranscript === (parent.childTranscript === true) &&
    sameRevision(held, revision)
  );
}

function unchangedFinished(
  held: ClaudeChildReferenceCacheEntry | undefined,
  parent: { agent: string; sessionId: string; childTranscript?: boolean },
  revision: import('./transcript').RelationshipStamp,
): boolean {
  const evidence = held?.claudeCursor?.evidence ?? held?.cursor?.evidence ?? held?.evidence;
  return (
    qualifiedRelationships(held, parent, revision) &&
    !!held &&
    (held.complete === true || (held.source === 'codex' && held.visitedEof === true)) &&
    (held.claudeCursor?.offset ?? held.cursor?.offset ?? evidence!.offset) === revision.size
  );
}

function revive(checkpoint: ProgressiveCheckpoint | undefined): ProgressiveCheckpoint | undefined {
  if (!checkpoint) {
    return undefined;
  }
  checkpoint.lineFragment = Buffer.from(checkpoint.lineFragment);
  if (checkpoint.skippedFragment) checkpoint.skippedFragment = Buffer.from(checkpoint.skippedFragment);
  checkpoint.contentAnchor.bytes = Buffer.from(checkpoint.contentAnchor.bytes);
  return checkpoint;
}

// The host counts every decoder before the worker creates it.
let compressedDecodeIds = 0;
const compressedDecodeAcks = new Map<number, () => void>();
if (parentPort)
  announceCompressedDecodes(
    () =>
      new Promise((resolve) => {
        const id = ++compressedDecodeIds;
        compressedDecodeAcks.set(id, resolve);
        parentPort?.postMessage({ compressedDecode: id });
      }),
  );

// One holder per store directory, for the life of the worker.
const compressedHolders = new Map<string, CompressedStoreHolder>();
let compressedWriteBytes = 0;

function compressedHolder(directory: string): CompressedStoreHolder {
  let holder = compressedHolders.get(directory);
  if (!holder) {
    holder = new CompressedStoreHolder(directory, { wrote: (bytes) => (compressedWriteBytes += bytes) });
    compressedHolders.set(directory, holder);
  }
  return holder;
}

function takeCompressedWriteBytes(): number {
  const bytes = compressedWriteBytes;
  compressedWriteBytes = 0;
  return bytes;
}

async function executeCompressedAdopt(
  request: Extract<ProgressiveRequest, { kind: 'compressed-adopt' }>,
  signal: AbortSignal,
  acknowledge?: (value: ProgressiveValue) => void,
): Promise<ProgressiveValue> {
  const { twin } = request.adoption;
  const key = compressedStoresKey(request.stores);
  const runningFollower = compressedFollowers.get(key)?.follower;
  const follower = runningFollower ?? new CompressedStoreFollower(request.stores.facts);
  const noteAdoption = (entry: import('./compressedstore').CompressedFactEntry, pending = false) => {
    const backfill = compressedBackfills.get(key);
    if (backfill?.membershipOf(twin) === request.membership) backfill?.noteAdoption(entry, pending);
  };
  const settle = async (entry: import('./compressedstore').CompressedEntrySeed): Promise<ProgressiveValue> => {
    const selected = await follower.adoptedEntry(entry, signal);
    if (selected) noteAdoption(selected);
    return {
      kind: 'compressed-adopt',
      adopted: true,
      entry: selected ?? entry,
      durable: !!selected,
      ...(selected ? {} : { pending: true }),
      writeBytes: takeCompressedWriteBytes(),
    };
  };
  const pending = request.pending;
  if (pending?.file === twin && pending.adopted && pending.storeRecord) {
    const stat = observeRolloutStat(twin);
    if (stat === undefined) {
      return { kind: 'compressed-adopt', adopted: true, entry: pending, durable: false, pending: true, writeBytes: 0 };
    }
    const current = follower.known().get(twin);
    const held = compressedByteObservation(pending);
    const latest = current && compressedEntryCurrent(current, stat) && compressedByteObservation(current);
    const reobserved = held && latest && held.hash !== latest.hash && compareCompressedObservations(latest, held) > 0;
    if (!reobserved && compressedEntryCurrent(pending, stat)) return settle(pending);
  }
  const facts = compressedHolder(request.stores.facts);
  const result = await recordCompressedAdoption(request.adoption, facts, compressedHolder(request.stores.openings));
  const record = facts.recordOf(result.entry);
  const entry = record ? { ...result.entry, storeRecord: record } : result.entry;
  if (!result.durable || !result.adopted || !record) {
    if (result.durable && !result.adopted) noteAdoption(entry);
    return {
      kind: 'compressed-adopt',
      adopted: result.adopted,
      entry,
      durable: result.durable && !result.adopted,
      writeBytes: takeCompressedWriteBytes(),
    };
  }
  noteAdoption(entry, true);
  const saved = compressedEntrySeed(entry);
  acknowledge?.({
    kind: 'compressed-adopt',
    adopted: true,
    entry: saved,
    durable: false,
    pending: true,
    writeBytes: 0,
  });
  return settle(saved);
}

// A worker keeps one follower per store. The first request of a worker reads the whole store, and a later request reads
// only the bytes appended since.
interface CompressedFollow {
  follower: CompressedStoreFollower;
  owed: Map<string, { entry: import('./compressedstore').CompressedFactEntry; horizon?: number }>;
  relocated: Map<string, import('./compressedstore').CompressedStoreRecord>;
  spendRelocated: Map<string, import('./compressedstore').CompressedStoreRecord>;
  lineage: Map<string, import('./compressedstore').CompressedLineage>;
  started?: true;
  nextDelivery?: number;
  offered?: { id: number; accept: () => void };
  placementScope?: number;
  configured?: true;
  running?: Promise<ProgressiveValue>;
}

const compressedFollowers = new Map<string, CompressedFollow>();

function compressedStoresKey(stores: CompressedStorePaths): string {
  return JSON.stringify([stores.facts, stores.openings]);
}

type StagedCompressedParts = {
  id: number;
  scope?: number;
  parts?: CompressedTransferPart['records'][];
  // A retry after a lost final reply takes the same result without following the store again.
  committed?: { part: number; value: ProgressiveValue };
};

const compressedTransfers = new Map<string, StagedCompressedParts>();
let sealedDiscovery:
  | {
      id: number;
      generation: number;
      scope?: number;
      stores: CompressedStorePaths;
      revision: number;
      files: string[];
      memberships?: number[];
      inventory?: CompressedLoadRequest['compressedInventory'];
    }
  | undefined;

function compressedTransferKey(key: string, purpose: CompressedTransferPart['purpose']): string {
  return JSON.stringify([key, purpose]);
}

const incompleteCompressedLoad = { kind: 'compressed-load' as const, entries: [], done: false };

function stageCompressedPart(key: string, scope: number | undefined, part: CompressedTransferPart): ProgressiveValue {
  if (olderCompressedScope(key, scope)) return incompleteCompressedLoad;
  const transferKey = compressedTransferKey(key, part.purpose);
  let pending = compressedTransfers.get(transferKey);
  if (part.part === 0 && (!pending || part.id > pending.id)) {
    pending = { id: part.id, scope, parts: [] };
    compressedTransfers.set(transferKey, pending);
  }
  if (pending?.id !== part.id || pending.scope !== scope || pending.parts?.length !== part.part)
    return incompleteCompressedLoad;
  pending.parts.push(part.records);
  return { ...incompleteCompressedLoad, stagedTransfer: { id: part.id, part: part.part } };
}

function takeCompressedParts(
  key: string,
  scope: number | undefined,
  purpose: CompressedTransferPart['purpose'],
  receipt: CompressedTransferReceipt,
): StagedCompressedParts['parts'] {
  const pending = compressedTransfers.get(compressedTransferKey(key, purpose));
  if (pending?.id !== receipt.id || pending.scope !== scope || pending.parts?.length !== receipt.part) return undefined;
  const parts = pending.parts;
  pending.parts = undefined;
  return parts;
}

let nextCompressedSpendRequest = 0;
const compressedSpendRequests = new Map<
  number,
  (entry?: import('./compressedstore').CompressedFactEntry | null) => void
>();

function requestHeldCompressedSpend(
  request: import('./compressedstore').CompressedSpendRequest,
): Promise<import('./compressedstore').CompressedFactEntry | null | undefined> {
  if (!parentPort) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const id = ++nextCompressedSpendRequest;
    const settle = (entry?: import('./compressedstore').CompressedFactEntry | null) => {
      clearTimeout(deadline);
      compressedSpendRequests.delete(id);
      resolve(entry);
    };
    const deadline = setTimeout(settle, 100);
    deadline.unref();
    compressedSpendRequests.set(id, settle);
    parentPort!.postMessage({ compressedSpendRequest: { id, request } });
  });
}

async function executeCompressedLoad(
  request: CompressedLoadRequest,
  signal: AbortSignal,
  acknowledge?: (value: ProgressiveValue) => void,
): Promise<ProgressiveValue> {
  const key = compressedStoresKey(request.stores);
  if (signal.aborted || olderCompressedScope(key, request.repairScope)) return incompleteCompressedLoad;
  if (request.transferPart) return stageCompressedPart(key, request.repairScope, request.transferPart);
  const seal = request.discoverySeal;
  if (seal) {
    const parts = seal.part ? takeCompressedParts(key, request.repairScope, 'discovery', seal) : [];
    if (!parts) return incompleteCompressedLoad;
    const list = assembleCompressedLoad({ ...request, compressed: [] }, parts);
    if (!parts.every((part) => part.every(([field]) => field === 'name'))) return incompleteCompressedLoad;
    sealedDiscovery = {
      id: seal.id,
      generation: seal.generation,
      revision: seal.revision,
      scope: request.repairScope,
      stores: request.stores,
      files: list.compressed!,
      memberships: list.compressedMemberships,
      inventory: list.compressedInventory,
    };
    return { ...incompleteCompressedLoad, stagedTransfer: { id: seal.id, part: seal.part } };
  }
  const transfer = request.transfer;
  const pending = compressedTransfers.get(compressedTransferKey(key, 'load'));
  if (transfer) {
    if (
      pending?.id === transfer.id &&
      pending.scope === request.repairScope &&
      pending.committed?.part === transfer.part
    )
      return pending.committed.value;
    const parts = takeCompressedParts(key, request.repairScope, 'load', transfer);
    if (!parts) return incompleteCompressedLoad;
    request = assembleCompressedLoad(request, parts);
  } else if (pending) pending.committed = undefined;
  let follow = compressedFollowers.get(key);
  if (!follow) {
    const follower = new CompressedStoreFollower(
      request.stores.facts,
      undefined,
      undefined,
      undefined,
      requestHeldCompressedSpend,
    );
    follow = { follower, owed: new Map(), relocated: new Map(), spendRelocated: new Map(), lineage: new Map() };
    compressedFollowers.set(key, follow);
  }
  const previous = follow.running;
  const running = previous
    ? previous.catch(() => undefined).then(() => followCompressedLoad(follow, request, signal, acknowledge))
    : followCompressedLoad(follow, request, signal, acknowledge);
  follow.running = running;
  try {
    const value = await running;
    if (transfer && pending && value.kind === 'compressed-load' && value.done)
      pending.committed = { part: transfer.part, value };
    return value;
  } finally {
    if (follow.running === running) follow.running = undefined;
  }
}

async function followCompressedLoad(
  follow: CompressedFollow,
  request: CompressedLoadRequest,
  signal: AbortSignal,
  acknowledge?: (value: ProgressiveValue) => void,
): Promise<ProgressiveValue> {
  const { follower, owed, relocated, spendRelocated, lineage } = follow;
  const { stores, repairScope } = request;
  const key = compressedStoresKey(stores);
  if (signal.aborted || olderCompressedScope(key, repairScope)) return incompleteCompressedLoad;
  const tracked = request.receivedDelivery !== undefined;
  if (follow.offered && request.receivedDelivery === follow.offered.id) {
    follow.offered.accept();
    follow.offered = undefined;
  }
  if (repairScope !== undefined && repairScope !== follow.placementScope) {
    follow.placementScope = repairScope;
    follow.configured = undefined;
    compressedBackfills.get(key)?.suspendScope(repairScope);
  }
  if (!follow.started) {
    if (request.resume) follower.seed(request.resume);
    follow.started = true;
  }
  const polled = await follower.follow();
  for (const entry of polled.entries) {
    relocated.delete(entry.file);
    owed.set(entry.file, { entry });
  }
  for (const [file, record] of polled.relocated) relocated.set(file, record);
  for (const [file, record] of polled.spendRelocated) spendRelocated.set(file, record);
  for (const group of polled.lineage) lineage.set(group.file, group);
  if (signal.aborted || compressedFollowers.get(key) !== follow || olderCompressedScope(key, repairScope))
    return incompleteCompressedLoad;
  const snapshot = compressedNames.get(key);
  const held = snapshot?.recorded ? undefined : snapshot;
  const inline = request.compressedRevision !== undefined && request.compressedRevision > (snapshot?.revision ?? -1);
  const revision = inline ? request.compressedRevision : snapshot?.revision;
  const files = inline ? request.compressed : snapshot?.files;
  const memberships = inline ? request.compressedMemberships : snapshot?.memberships;
  const settlementRevision = request.settlementRevision;
  if (
    (memberships && memberships.length !== files?.length) ||
    (settlementRevision !== undefined && (settlementRevision !== revision || !files))
  )
    return incompleteCompressedLoad;
  const worker = startCompressedBackfill(request, follower, request.placements);
  const settlements = settlementRevision !== undefined ? request.settlements : undefined;
  follow.configured = true;
  const compressedNamesReceipt = request.compressed
    ? acceptCompressedNames(
        request.compressed,
        request.compressedRevision,
        repairScope,
        stores,
        request.compressedMemberships,
        settlements,
        request.compressedInventory,
      )
    : undefined;
  if (!compressedNamesReceipt) installCompressedNames(key, stores, settlements);
  const inventory = compressedNames.get(key);
  const authorityOwed = [...owed.values()].some(({ entry }) => !entry.nameOnly || !!entry.unreadable);
  const horizon = worker?.setRoots(request.backfill?.roots, tracked && authorityOwed) ?? 0;
  for (const pending of owed.values()) pending.horizon = horizon;
  if (worker && authorityOwed) await worker.coverWorkspaceFacts();
  if (signal.aborted || compressedFollowers.get(key) !== follow || olderCompressedScope(key, repairScope))
    return incompleteCompressedLoad;
  const acceptedRepairs = request.repairs?.length ? worker?.acceptRepairs(request.repairs) : undefined;
  const facts = [];
  const offered = new Map<string, { entry: import('./compressedstore').CompressedFactEntry; posted: boolean }>();
  const account = (entry: import('./compressedstore').CompressedFactEntry, posted: boolean) => {
    if (tracked) offered.set(entry.file, { entry, posted });
    else {
      owed.delete(entry.file);
      if (posted) worker?.followed(entry);
    }
  };
  for (const { entry, horizon: input } of owed.values()) {
    if (entry.nameOnly && !entry.unreadable) continue;
    const disposition = tracked && !inventory?.inventory ? 'hold' : worker?.workspaceDelivery(entry, input ?? 0);
    if (disposition === 'accounted') account(entry, false);
    if (!disposition || disposition === 'post') {
      const membership = worker?.membershipOf(entry.file);
      facts.push({
        entry,
        input,
        ...(membership === undefined ? {} : { member: [entry.file, membership] as [string, number] }),
      });
    }
  }
  const delivery = [...facts, ...[...lineage.values()].map((group) => ({ group }))];
  const takeBatch = (batch: typeof delivery) => {
    const entries: import('./compressedstore').CompressedFactEntry[] = [];
    const memberships: [string, number][] = [];
    const groups: import('./compressedstore').CompressedLineage[] = [];
    for (const item of batch) {
      if ('group' in item) {
        groups.push(item.group);
        continue;
      }
      const { entry, input, member } = item;
      if (worker?.membershipOf(entry.file) !== member?.[1]) continue;
      const disposition = worker?.workspaceDelivery(entry, input ?? 0);
      if (disposition === 'hold') continue;
      account(entry, disposition !== 'accounted');
      if (disposition === 'accounted') continue;
      entries.push(entry);
      if (member) memberships.push(member);
    }
    return { entries, ...(memberships.length ? { memberships } : {}), ...(groups.length ? { lineage: groups } : {}) };
  };
  const last = await postCompressedBatches(delivery, signal, (batch) => {
    if (acknowledge) acknowledge({ kind: 'compressed-load', ...takeBatch(batch), done: false });
  });
  if (signal.aborted || olderCompressedScope(key, repairScope) || (tracked && inventory !== compressedNames.get(key)))
    return incompleteCompressedLoad;
  const delivered = takeBatch(acknowledge ? last : delivery);
  const nameOnly: string[] = [];
  for (const [file, { entry }] of owed) {
    if (!entry.nameOnly || entry.unreadable) continue;
    nameOnly.push(file);
    account(entry, false);
  }
  const locations = [...relocated];
  const spendLocations = [...spendRelocated];
  const consumed = owed.size === offered.size;
  let deliveryId: number | undefined;
  if (tracked) {
    deliveryId = follow.nextDelivery = (follow.nextDelivery ?? 0) + 1;
    follow.offered = {
      id: deliveryId,
      accept: () => {
        for (const [file, { entry, posted }] of offered) {
          if (owed.get(file)?.entry !== entry) continue;
          owed.delete(file);
          if (posted) worker?.followed(entry);
        }
        if (consumed) lineage.clear();
        relocated.clear();
        spendRelocated.clear();
      },
    };
  } else {
    if (consumed) lineage.clear();
    relocated.clear();
    spendRelocated.clear();
  }
  return {
    kind: 'compressed-load',
    ...delivered,
    done: true,
    ...(deliveryId !== undefined && { delivery: deliveryId }),
    ...(consumed && { consumed: polled.offsets }),
    nameOnly,
    ...(locations.length ? { relocated: locations } : {}),
    ...(spendLocations.length ? { spendRelocated: spendLocations } : {}),
    ...(held?.recorded ? { heldNamesRecorded: held.files.length } : {}),
    ...(compressedNamesReceipt ? { compressedNames: compressedNamesReceipt } : {}),
    ...(acceptedRepairs?.length ? { acceptedRepairs } : {}),
    ...(worker && settlementRevision !== undefined ? { settlementRevision } : {}),
  };
}

// An accepted list waits until a load has configured the backfill for its scope.
const compressedBackfills = new Map<string, CompressedBackfill>();
interface CompressedNames {
  files: readonly string[];
  memberships?: readonly number[];
  inventory?: CompressedLoadRequest['compressedInventory'];
  revision: number;
  scope?: number;
  recorded?: true;
  backfill?: CompressedBackfill;
}
const compressedNames = new Map<string, CompressedNames>();
let discoveryCompressedStores: string | undefined;

function olderCompressedScope(key: string, scope?: number): boolean {
  return (
    scope !== undefined &&
    scope < Math.max(compressedNames.get(key)?.scope ?? -1, compressedFollowers.get(key)?.placementScope ?? -1)
  );
}

function readerWaits(): boolean {
  return !!activeKinds.window || !!activeKinds.page;
}

function backfillBusy(): boolean {
  return discovery.busy || readerWaits();
}

function startCompressedBackfill(
  request: CompressedLoadRequest,
  follower: CompressedStoreFollower,
  placements: readonly import('./compressedrollouts').CompressedPlacement[] | undefined,
): CompressedBackfill | undefined {
  const { stores, backfill: start, repairScope } = request;
  const key = compressedStoresKey(stores);
  let backfill = compressedBackfills.get(key);
  if (backfill) {
    backfill.configureScope(start?.roots, repairScope, placements);
    return backfill;
  }
  if (!start) return undefined;
  backfill = new CompressedBackfill({
    facts: compressedHolder(stores.facts),
    openings: compressedHolder(stores.openings),
    workspace: start.workspace,
    roots: start.roots,
    launch: start.launch,
    busy: backfillBusy,
    reading: readerWaits,
    known: () => follower.known(),
    readKnown: (file) => follower.entry(file),
    follower,
    inFolders: (roots) => folderMatcher([...roots]),
    post: (batch) => {
      parentPort?.postMessage({ compressedFacts: batch });
      const bytes = takeCompressedWriteBytes();
      if (bytes) parentPort?.postMessage({ compressedStoreWrite: bytes });
    },
  });
  compressedBackfills.set(key, backfill);
  backfill.configureScope(start.roots, repairScope, placements);
  return backfill;
}

function installCompressedNames(
  key: string,
  stores: CompressedStorePaths,
  settlements?: CompressedLoadRequest['settlements'],
): void {
  const names = compressedNames.get(key);
  const follow = compressedFollowers.get(key);
  if (!names || !follow?.configured || (names.scope !== undefined && names.scope > (follow.placementScope ?? -1)))
    return;
  const backfill = compressedBackfills.get(key);
  if (backfill && names.backfill !== backfill) {
    names.backfill = backfill;
    backfill.setNames(names.files, names.memberships, settlements, names.inventory);
  } else if (settlements) backfill?.restoreRepairSettlements(settlements);
  if (names.recorded) return;
  names.recorded = true;
  setImmediate(() => {
    if (compressedNames.get(key) !== names) return;
    void recordCompressedNames(names.files, compressedHolder(stores.facts), {
      known: follow.follower.known(),
      eligible: () => compressedNames.get(key) === names,
    }).then(() => {
      const bytes = takeCompressedWriteBytes();
      if (bytes) parentPort?.postMessage({ compressedStoreWrite: bytes });
    });
  });
}

function acceptCompressedNames(
  files: readonly string[],
  revision: number | undefined,
  scope: number | undefined,
  stores: CompressedStorePaths,
  memberships?: readonly number[],
  settlements?: CompressedLoadRequest['settlements'],
  inventory?: CompressedLoadRequest['compressedInventory'],
): CompressedNamesReceipt | undefined {
  const key = compressedStoresKey(stores);
  if (
    revision === undefined ||
    olderCompressedScope(key, scope) ||
    (memberships && memberships.length !== files.length) ||
    (inventory && files.length > 0 && (!memberships || memberships.some((id) => !Number.isSafeInteger(id) || id === 0)))
  )
    return undefined;
  const held = compressedNames.get(key);
  if (held && revision < held.revision) return undefined;
  const names = held?.revision === revision ? held : { files, memberships, revision, scope, inventory };
  if (scope !== undefined && (names.scope === undefined || scope > names.scope)) names.scope = scope;
  compressedNames.set(key, names);
  discoveryCompressedStores = key;
  const followedScope = compressedFollowers.get(key)?.placementScope;
  if (scope !== undefined && followedScope !== undefined && scope > followedScope)
    compressedBackfills.get(key)?.suspendScope(scope);
  installCompressedNames(key, stores, settlements);
  return {
    revision,
    state: names.recorded && (scope === undefined || followedScope === scope) ? 'recorded' : 'held',
  };
}

function discoveryCompressedRequesters(request: Extract<ProgressiveRequest, { kind: 'claude-children' }>) {
  const key = request.compressedStores ? compressedStoresKey(request.compressedStores) : discoveryCompressedStores;
  const held = key ? compressedNames.get(key) : undefined;
  const revision = request.compressedRevision;
  if (
    request.compressed &&
    revision !== undefined &&
    key &&
    !olderCompressedScope(key, request.compressedScope) &&
    revision > (held?.revision ?? -1)
  )
    return compressedRequestersOf(request.compressed);
  return held ? compressedRequestersOf(held.files) : null;
}

async function execute(
  request: ProgressiveRequest,
  signal: AbortSignal,
  acknowledge?: (value: ProgressiveValue) => void,
): Promise<ProgressiveValue> {
  if (request.kind === 'compressed-adopt') return executeCompressedAdopt(request, signal, acknowledge);
  if (request.kind === 'compressed-load') return executeCompressedLoad(request, signal, acknowledge);
  if (request.kind === 'codex-context') {
    if (isCompressedRollout(request.session.file)) return { kind: 'codex-context', estimate: null };
    const revision = revisionOf(request.session.file);
    return {
      kind: 'codex-context',
      estimate: revision
        ? await readCodexContext(request.session.file, request.session.sessionId, revision, signal)
        : null,
    };
  }
  if (request.kind === 'commit-repositories') return executeCommitRepositories(request, signal);
  if (request.kind === 'child-file-edits') return executeChildFileEdits(request, signal);
  if (request.kind === 'metadata-recovery') {
    if (isCompressedRollout(request.session.file)) return { kind: 'stale', unread: true };
    if (metadataRecovery && !request.eligible.includes(metadataRecovery.sessionId)) metadataRecovery = null;
    if (metadataRecovery && metadataRecovery.sessionId !== request.session.sessionId) {
      return { kind: 'stale' };
    }
    if (
      !metadataRecovery ||
      metadataRecovery.file !== request.session.file ||
      metadataRecovery.agyRecovery !== request.agyRecovery
    ) {
      const session = request.session;
      const control: ForwardRecoveryControl = {
        through: 0,
        readBytes: 0,
        retainedCharge: 0,
        retainedLimit: request.retainedBytes ?? 64 * 1024 * 1024,
        recordLimit: request.recordBytes ?? 16 * 1024 * 1024,
        reduceAbove: session.agent === 'agy' ? Infinity : (request.reduceAboveBytes ?? 1024 * 1024),
        ...(session.agent === 'agy'
          ? { retain: agyRetainedLine }
          : session.agent === 'codex'
            ? { accepts: codexSessionLineMayAffectRead }
            : { accepts: claudeSessionLineMayAffectRead, retain: claudeRetainedLine }),
        fragments: [],
        fragmentBytes: 0,
      };
      const work = { recovery: control, signal, chunkBytes: 256 * 1024 };
      metadataRecovery = {
        file: session.file,
        sessionId: session.sessionId,
        agyRecovery: request.agyRecovery,
        work,
        scan: beginForwardSessionRecovery<unknown>(
          session.file,
          session.agent,
          session.sessionId,
          () =>
            session.agent === 'agy'
              ? createAgySessionReducer(session.file, session.sessionId, Number.MAX_SAFE_INTEGER)
              : session.agent === 'codex'
                ? createCodexSessionReducer(session.sessionId, { maxTurns: 40 }, request.opening ?? null)
                : createClaudeSessionReducer(
                    session.sessionId,
                    withClaudeRepeated(session.file, { maxTurns: 40, childTranscript: session.childTranscript }),
                  ),
          work,
        ),
      };
    }
    const active = metadataRecovery;
    active.work.signal = signal;
    const before = active.work.recovery.readBytes;
    const limit = Math.max(1, Math.min(request.sliceBytes, 16 * 1024 * 1024));
    try {
      while (active.work.recovery.readBytes - before < limit) {
        active.work.chunkBytes = Math.min(256 * 1024, limit - (active.work.recovery.readBytes - before));
        const next = active.scan.next();
        if (next.done) {
          metadataRecovery = null;
          return next.value.read
            ? {
                kind: 'metadata-recovery',
                status: 'complete',
                read: next.value.read,
                readBytes: next.value.readBytes - before,
                through: active.work.recovery.through,
              }
            : { kind: 'stale' };
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal.aborted) {
          metadataRecovery = null;
          return { kind: 'stale' };
        }
      }
      return {
        kind: 'metadata-recovery',
        status: 'pending',
        readBytes: active.work.recovery.readBytes - before,
        through: active.work.recovery.through,
      };
    } catch (error) {
      metadataRecovery = null;
      if (!(error instanceof ForwardRecoveryLimit)) throw error;
      return {
        kind: 'metadata-recovery',
        status: 'exhausted',
        readBytes: active.work.recovery.readBytes - before,
        through: active.work.recovery.through,
      };
    }
  }
  if (request.kind === 'claude-children') {
    const passStarted = performance.now();
    if (request.spendOnly) {
      const held = heldDispatchReferences;
      if (!held || held.scope !== JSON.stringify(request.repositoryRoots))
        return { kind: 'dispatch-spend', held: false };
      const charges = emptyDiscoveryCharges();
      charges.dispatchSpendOnlyPasses!++;
      const spend = collectDispatchFacts(request, held.references, held.admittedReferences, charges, true);
      charges.passMs = performance.now() - passStarted;
      return {
        kind: 'dispatch-spend',
        held: true,
        dispatchFacts: spend.dispatched,
        continuation: spend.continuation,
        savedDispatch: spend.savedChanges,
        charges,
        dispatchRoots: spend.dispatchRoots,
      };
    }
    compressedRequesters = discoveryCompressedRequesters(request);
    for (const [file, entry] of request.referenceEntries ?? []) {
      const key = normalizeFsPath(file);
      noteSourceGeneration(key, entry);
      // A source that the held epoch recorded as missing stays complete with no row, so its old edges stay out of the walk.
      const missing = discoveryEpoch && missingSources?.epoch === discoveryEpoch.epoch ? missingSources : null;
      if (missing?.files.has(key)) continue;
      if (!claudeChildReferences.has(key)) {
        claudeChildReferences.set(key, entry);
      }
      if (entry.head) claudeChildSessions.seed(key, entry.head);
    }
    const scope = JSON.stringify(request.repositoryRoots);
    const heldEpoch = discoveryEpoch;
    if (
      validDiscoveryCheckpoint(request.discovery) &&
      compatibleDiscovery(request.discovery, CLAUDE_CHILD_REFERENCE_PARSER_VERSION, request.repositoryRoots) &&
      JSON.stringify(request.discovery.repositoryRoots) === scope &&
      (!discoveryEpoch ||
        (request.discovery.epoch === discoveryEpoch.epoch && request.discovery.sequence >= discoveryEpoch.sequence))
    )
      discoveryEpoch = request.discovery;
    const released: string[] = [];
    if (
      discoveryEpoch &&
      JSON.stringify(discoveryEpoch.repositoryRoots) !== scope &&
      discoveryEpoch.compatibility === discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION) &&
      discoveryEpoch.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION
    ) {
      // A root change continues the epoch. Retained sources keep their rows and captured cuts, and new sources join it.
      const held = discoveryEpoch;
      const retained = (rows: readonly SessionFile[], next: readonly SessionFile[]) => {
        const old = new Map(rows.map((row) => [discoverySourceKey(row), row]));
        return next.map((row) => old.get(discoverySourceKey(row)) ?? row);
      };
      const parents = retained(held.parents, request.parents);
      const catalog = retained(held.catalog, request.catalog ?? request.parents);
      const kept = new Set(parents.map(discoverySourceKey));
      const parentFiles = new Set(parents.map((row) => normalizeFsPath(row.file)));
      // Removed parents leave the completions. A child with a reference entry keeps its completion and captured cut. A child
      // that returns without an entry, or a missing file, checks its completion again.
      const heldParents = new Map(held.parents.map((row) => [normalizeFsPath(row.file), row]));
      const completedFiles = new Set<string>();
      for (const key of held.completed) {
        const parent = heldParents.get(key);
        if (parent ? kept.has(discoverySourceKey(parent)) : claudeChildReferences.has(key)) completedFiles.add(key);
        else released.push(key);
      }
      const inRoots = (cwd: string | null | undefined) => !!cwd && isInside(cwd, [...request.repositoryRoots]);
      const protectedFile =
        held.protectedFile &&
        (parentFiles.has(held.protectedFile) || inRoots(claudeChildSessions.heads().get(held.protectedFile)?.cwd))
          ? held.protectedFile
          : undefined;
      // A child read answers for the roots it was read under.
      for (const [key, child] of epochChildSessions) if (!child || !inRoots(child.cwd)) epochChildSessions.delete(key);
      if (receiptScan && receiptScan.epoch === held.epoch) updateReceiptCatalog(receiptScan, catalog);
      const { protectedFile: _protectedFile, ...rest } = held;
      epochParentKeys = null;
      discoveryEpoch = {
        ...rest,
        parents,
        catalog,
        repositoryRoots: request.repositoryRoots,
        completed: [...completedFiles],
        ...(protectedFile ? { protectedFile } : {}),
      };
    } else if (!discoveryEpoch || JSON.stringify(discoveryEpoch.repositoryRoots) !== scope) {
      discoveryEpoch = {
        epoch: randomUUID(),
        compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
        parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
        parents: request.parents,
        catalog: request.catalog ?? request.parents,
        repositoryRoots: request.repositoryRoots,
        completed: [],
        position: discoveryPosition,
        sequence: 0,
      };
    }
    const epoch = discoveryEpoch;
    // The host's checkpoint as the request carried it. A receipt reply is a delta only while the epoch is that checkpoint.
    const hostCheckpoint =
      epoch === request.discovery ? { sequence: epoch.sequence, completed: epoch.completed } : null;
    let replied = false;
    if (receiptScan && receiptScan.epoch !== epoch.epoch) closeReceiptScan('epoch');
    // A list that arrived while the scan is open changes its compressed rows, as a root change does.
    if (receiptScan && receiptScan.compressed !== compressedRequesters)
      updateReceiptCatalog(receiptScan, epoch.catalog);
    // A new worker checks saved completions as their sources become reachable.
    const seeding = heldEpoch?.epoch !== epoch.epoch;
    if (seeding) {
      admittedCompletions.clear();
      epochChildSessions.clear();
    }
    const completed = new Set(epoch.completed);
    const completionChanges = new Map<string, boolean>(released.map((key) => [key, false]));
    const charges = emptyDiscoveryCharges();
    // A parent check is one stat of a candidate source, so it reads no bytes.
    const parentCheck = <T>(check: () => T): T => {
      const startedAt = performance.now();
      try {
        return check();
      } finally {
        charges.parentChecks++;
        charges.parentCheckMs += performance.now() - startedAt;
      }
    };
    const parentStamps = new Map<string, import('./transcript').RelationshipStamp | null>();
    const checkParent = (file: string) => {
      const key = normalizeFsPath(file);
      if (parentStamps.has(key)) return parentStamps.get(key)!;
      const stamp = parentCheck(() => {
        try {
          return relationshipStamp(fs.statSync(file, { bigint: true }));
        } catch {
          return null;
        }
      });
      parentStamps.set(key, stamp);
      return stamp;
    };
    const checkMissing = (file: string) => parentCheck(() => missingFile(file));
    // A finished source that this epoch reads again, by why its saved cut no longer qualifies. A source whose size, time and
    // identity match its entry moved only its change time or its saved evidence.
    const countRescan = (
      entry: ClaudeChildReferenceCacheEntry | undefined,
      revision: import('./transcript').RelationshipStamp | null,
    ) => {
      if (!entry || !revision || !(entry.complete === true || (entry.source === 'codex' && entry.visitedEof === true)))
        return;
      charges.transcriptRescans!++;
      charges[sameRevision(entry, revision) ? 'transcriptRescansMetadata' : 'transcriptRescansChanged']!++;
    };
    let continuation = false;
    // The membership branches that asked for another pass in this request. A complete reply counts each one. The worker skips
    // the unread check once another branch asked, so the count adds no file check.
    const unsettled = { unfinished: false, deferred: false, unread: false, changed: false, parents: false };
    let incomplete = false;
    let admitting = seeding;
    const candidates = new Map<string, import('./transcript').SessionFile>();
    // Each epoch retains admitted child metadata. The charge covers newly resolved child heads.
    const walk = () => {
      candidates.clear();
      const reads = openReadWindow();
      try {
        return discoverClaudeChildSessions(
          epoch.parents,
          epoch.repositoryRoots,
          (parent) => {
            const key = normalizeFsPath(parent.file);
            candidates.set(key, parent);
            const entry = claudeChildReferences.get(key);
            if (!entry) {
              if (!admittedCompletions.has(key) && completed.delete(key)) completionChanges.set(key, false);
              return [];
            }
            // Saved completions require admission when an ancestor first exposes their source.
            if (completed.has(key) && !admittedCompletions.has(key)) {
              const revision = checkParent(parent.file);
              if (revision && unchangedFinished(entry, parent, revision)) admittedCompletions.add(key);
              else {
                countRescan(entry, revision);
                completed.delete(key);
                completionChanges.set(key, false);
                claudeChildReferences.set(key, {
                  ...entry,
                  complete: false,
                  relationshipComplete: false,
                  visitedEof: false,
                });
              }
            }
            // Completed cuts stay fixed for this epoch. Later writes enter the next refresh.
            if (!admitting && completed.has(key)) return entry.references;
            // Unfinished Claude sources expose no edges until their scanner qualifies the cut.
            if (!admitting) return parent.agent === 'codex' ? entry.references : [];
            const current = checkParent(parent.file)!;
            return (
              parent.agent === 'codex'
                ? entry.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION &&
                  entry.source === 'codex' &&
                  entry.sessionId === parent.sessionId &&
                  entry.childTranscript === (parent.childTranscript === true) &&
                  !!(entry.cursor?.evidence ?? entry.evidence) &&
                  onlyGrew(entry, current)
                : unchangedFinished(entry, parent, current)
            )
              ? entry.references
              : [];
          },
          {
            read(reference, roots) {
              const key = normalizeFsPath(reference.file);
              if (!epochChildSessions.has(key)) epochChildSessions.set(key, claudeChildSessions.read(reference, roots));
              const child = epochChildSessions.get(key);
              return child
                ? { ...child, parentSessionId: reference.parentSessionId, toolUseIds: [...reference.toolUseIds] }
                : null;
            },
          },
        );
      } catch {
        incomplete = true;
        return { references: [], children: [] };
      } finally {
        const tally = closeReadWindow(reads);
        charges.childHeadFiles += tally.files;
        charges.childHeadBytes += tally.bytes;
        charges.childHeadMs += tally.ms;
      }
    };
    // A delta without a source carries completion changes alone, such as the seed's. A receipt delta carries `rows`.
    const pending = (
      source?: string,
      delta = source !== undefined,
      rows?: Array<[string, ClaudeChildReferenceCacheEntry]>,
    ) => {
      charges.passMs = performance.now() - passStarted;
      epoch.sequence++;
      replied = true;
      // Request boundaries return whole checkpoints. Quanta reuse the host's frozen header.
      if (delta) {
        const referenceEntries = rows ?? (source ? [withSavedFacts([source, claudeChildReferences.get(source)!])] : []);
        const sent = sentReferences;
        if (sent && sent.epoch === epoch.epoch) {
          sent.sequence = epoch.sequence;
          for (const [file, row] of referenceEntries)
            sent.rows.set(file, {
              entry: claudeChildReferences.get(file)!,
              head: row.head,
              dispatch: row.dispatch,
            });
        }
        const value = {
          kind: 'claude-children-delta' as const,
          referenceEntries,
          checkpoint: header,
          epoch: epoch.epoch!,
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          sequence: epoch.sequence,
          position: epoch.position,
          protectedFile: epoch.protectedFile,
          completed: [...completionChanges],
          continuation: true as const,
          charges,
        };
        header = undefined;
        completionChanges.clear();
        return value;
      }
      const entries = limitCodexDispatchCursors(claudeChildReferences);
      claudeChildReferences.clear();
      for (const [file, entry] of entries) claudeChildReferences.set(file, entry);
      for (const [file, entry] of entries) if (!entry.complete && !entry.visitedEof) completed.delete(file);
      epoch.completed = [...completed];
      if (!signal.aborted) recordHeldReceiptCounts(charges, scope);
      const referenceEntries = entries.map(withSavedFacts);
      sentReferences = {
        epoch: epoch.epoch!,
        sequence: epoch.sequence,
        rows: new Map(
          referenceEntries.map(([file, row], index) => [
            file,
            { entry: entries[index][1], head: row.head, dispatch: row.dispatch },
          ]),
        ),
      };
      return {
        kind: 'claude-children-progress' as const,
        referenceEntries,
        checkpoint: epoch,
        continuation: true as const,
        charges,
      };
    };
    let found = walk();
    if (epoch.protectedFile && !candidates.has(epoch.protectedFile)) {
      const held = claudeChildReferences.get(epoch.protectedFile);
      // Pending parent validation hides ownership edges while the child still needs parsing.
      if (held?.source === 'claude' && held.childTranscript)
        candidates.set(epoch.protectedFile, {
          file: epoch.protectedFile,
          sessionId: held.sessionId,
          agent: held.source,
          childTranscript: held.childTranscript,
          mtimeMs: held.mtimeMs,
          size: held.size,
          dev: held.dev,
          ino: held.ino,
        });
      else delete epoch.protectedFile;
    }
    if (epoch.protectedFile && completed.has(epoch.protectedFile)) delete epoch.protectedFile;
    // Scanners capture their own revision. Admission shares one source observation before the publication walk.
    const seedMissing = new Set<string>();
    if (seeding) {
      let checked = 0;
      for (const [key, parent] of candidates) {
        if (++checked % 256 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (signal.aborted) break;
        }
        const revision = checkParent(parent.file);
        if (!revision) seedMissing.add(key);
        if (revision && unchangedFinished(claudeChildReferences.get(key), parent, revision)) {
          charges.hits++;
          if (!completed.has(key)) completionChanges.set(key, true);
          completed.add(key);
          admittedCompletions.add(key);
          if (epoch.protectedFile === key) delete epoch.protectedFile;
        } else {
          if (completed.delete(key)) completionChanges.set(key, false);
          const entry = claudeChildReferences.get(key);
          countRescan(entry, revision);
          if (entry)
            claudeChildReferences.set(key, {
              ...entry,
              complete: false,
              relationshipComplete: false,
              visitedEof: false,
            });
        }
      }
      epoch.completed = [...completed];
    }
    admitting = false;
    let header = request.discovery?.epoch === epoch.epoch ? undefined : { ...epoch, completed: [...completed] };
    if (signal.aborted) return pending();
    // The seeded count reaches the host at once, whatever agent the remaining sources belong to.
    if (completionChanges.size) acknowledge?.(pending(undefined, true));
    const relationshipRejections = new Set(request.relationshipRejections);
    for (const key of relationshipOrigins.keys()) if (!candidates.has(key)) relationshipOrigins.delete(key);
    const requestBytes = Math.min(request.discoveryBytes ?? CODEX_DISPATCH_REQUEST_BYTES, CODEX_DISPATCH_REQUEST_BYTES);
    const quantumBytes = Math.min(request.quantumBytes ?? RELATIONSHIP_QUANTUM_BYTES, RELATIONSHIP_QUANTUM_BYTES);
    const pendingCharge = (entry: ClaudeChildReferenceCacheEntry | undefined) =>
      entry?.claudeCursor && entry.claudeCursor.offset < entry.claudeCursor.target
        ? Buffer.byteLength(JSON.stringify(entry.claudeCursor))
        : 0;
    let pendingBytes = [...claudeChildReferences.values()].reduce((sum, entry) => sum + pendingCharge(entry), 0);
    const rows = [...candidates];
    const start = epoch.position % Math.max(1, rows.length);
    const ordered = [...rows.slice(start), ...rows.slice(0, start)];
    for (const [key, parent] of ordered) {
      if (parent.agent === 'agy') continue;
      if (completed.has(key) || (epoch.protectedFile && key !== epoch.protectedFile)) continue;
      epoch.position = (rows.findIndex(([file]) => file === key) + 1) % Math.max(1, rows.length);
      const revision = seedMissing.delete(key) ? null : checkParent(parent.file);
      if (!revision) {
        if (checkMissing(parent.file)) {
          completed.add(key);
          admittedCompletions.add(key);
          completionChanges.set(key, true);
          if (!missingSources || missingSources.epoch !== epoch.epoch)
            missingSources = { epoch: epoch.epoch, files: new Map() };
          missingSources.files.set(key, parent.file);
          claudeChildReferences.delete(key);
          relationshipOrigins.delete(key);
          epochChildSessions.set(key, null);
          dispatchFacts.delete(parent.file);
          if (epoch.protectedFile === key) delete epoch.protectedFile;
          continue;
        }
        incomplete = true;
        continue;
      }
      const held = claudeChildReferences.get(key);
      const identity =
        held?.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION &&
        held.source === parent.agent &&
        held.sessionId === parent.sessionId &&
        held.childTranscript === (parent.childTranscript === true);
      if (unchangedFinished(held, parent, revision)) {
        charges.hits++;
        completed.add(key);
        admittedCompletions.add(key);
        completionChanges.set(key, true);
        continue;
      }
      const allowance = Math.min(
        parent.agent === 'codex' ? requestBytes : quantumBytes,
        requestBytes - charges.readBytes,
      );
      if (allowance <= RELATIONSHIP_RESERVE_BYTES || charges.quanta >= 8 || signal.aborted) {
        if (parent.agent === 'codex' && !signal.aborted) {
          epoch.position = rows.findIndex(([file]) => file === key);
          continuation = true;
          unsettled.deferred = true;
          break;
        }
        if (!signal.aborted) charges.transcriptPassEnds++;
        return pending();
      }
      const readsBefore = charges.readBytes;
      const startedAt = performance.now();
      try {
        let references: import('./transcript').ClaudeChildSessionReference[];
        let complete: boolean;
        let qualified: boolean;
        let cursor: import('./codex').CodexDispatchCursor | undefined;
        let claudeCursor: import('./transcript').ClaudeRelationshipCursor | undefined;
        let reset = !identity || (!!held && !(held.claudeCursor?.evidence ?? held.cursor?.evidence));
        // A scan that resumes a held cursor keeps the cause of the scan from byte 0 that made the cursor.
        const resumes = identity && !!(parent.agent === 'codex' ? held?.cursor : held?.claudeCursor);
        const origin = resumes
          ? relationshipOrigins.get(key)
          : held || relationshipRejections.has(key)
            ? ('rejected' as const)
            : ('noEntry' as const);
        let rebuilt = false;
        if (parent.agent === 'codex') {
          const scan = await scanCodexDispatchReferencesAsync(
            parent.file,
            parent.sessionId,
            identity ? (held?.cursor ?? null) : null,
            allowance,
            () => signal.aborted,
            charges,
            undefined,
            origin,
          );
          cursor = scan.cursor;
          complete = scan.complete;
          qualified = scan.qualified && !scan.reset;
          rebuilt = scan.reset;
          reset ||= scan.reset;
          references = scan.qualified
            ? scan.references
            : [
                ...(identity && held && !scan.reset
                  ? (held.pendingReferences ?? held.references).filter(
                      (reference) =>
                        !reference.toolUseIds.some((id) => scan.retractedToolUseIds.has(id)) &&
                        !scan.references.some((scanned) =>
                          scanned.toolUseIds.some((id) => reference.toolUseIds.includes(id)),
                        ),
                    )
                  : []),
                ...scan.references,
              ];
          reset ||=
            !!held?.cursor &&
            (cursor.dev !== held.cursor.dev || cursor.ino !== held.cursor.ino || cursor.offset < held.cursor.offset);
        } else {
          const scan = await scanClaudeRelationshipQuantum(
            parent,
            identity ? held?.claudeCursor : undefined,
            allowance,
            signal,
            charges,
            undefined,
            origin,
          );
          claudeCursor = scan.cursor;
          complete = scan.complete;
          qualified = scan.qualified && !scan.reset;
          references = scan.references;
          rebuilt = scan.reset;
          reset ||= scan.reset;
        }
        charges.resets += Number(reset && !!held);
        const compatible = identity && held && !reset;
        const scanRevision = claudeCursor?.revision ?? {
          size: cursor!.size,
          mtimeMs: cursor!.mtimeMs,
          dev: cursor!.dev,
          ino: cursor!.ino,
        };
        const evidence = claudeCursor?.evidence ?? cursor!.evidence;
        const reachedTarget = cursor ? cursor.offset === cursor.target : claudeCursor!.offset === claudeCursor!.target;
        // A mismatch starts the source again from byte 0, and the slices that rebuild it count as rejected.
        const scanOrigin = rebuilt ? 'rejected' : origin;
        if (reachedTarget || !scanOrigin) relationshipOrigins.delete(key);
        else relationshipOrigins.set(key, scanOrigin);
        const accepted =
          qualified &&
          (complete || (parent.agent === 'claude' && reachedTarget && claudeCursor!.offset === scanRevision.size));
        const finished = qualified && reachedTarget && (claudeCursor?.offset ?? cursor!.offset) === scanRevision.size;
        claudeChildReferences.set(key, {
          sourceGeneration: held ? (held.sourceGeneration ?? 0) + Number(reset) : (sourceGenerations.get(key) ?? 0) + 1,
          sequence: (held?.sequence ?? 0) + 1,
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          source: parent.agent,
          ...scanRevision,
          sessionId: parent.sessionId,
          childTranscript: parent.childTranscript === true,
          complete: accepted,
          visitedEof: qualified && reachedTarget,
          cursor,
          claudeCursor,
          references:
            qualified && (complete || reachedTarget || parent.agent === 'codex')
              ? references
              : compatible
                ? held.references
                : [],
          pendingReferences: accepted ? undefined : references,
          relationshipComplete: accepted,
          appliedCut:
            qualified && (complete || reachedTarget)
              ? (claudeCursor?.applied ??
                (cursor!.terminalApplied
                  ? cursor!.offset
                  : (cursor!.fragmentStart ?? cursor!.offset - Buffer.byteLength(cursor!.fragment, 'base64'))))
              : compatible
                ? held.appliedCut
                : undefined,
          validatedRevision:
            qualified && (complete || reachedTarget)
              ? evidence!.accepted!
              : compatible
                ? held.validatedRevision
                : undefined,
          ...(reset && held ? { resetReason: 'source generation changed' } : {}),
        });
        noteSourceGeneration(key, claudeChildReferences.get(key)!);
        if (reset) dispatchFacts.delete(parent.file);
        pendingBytes += pendingCharge(claudeChildReferences.get(key)) - pendingCharge(held);
        if (!reachedTarget && claudeCursor && pendingBytes > 64 * 1024 * 1024) epoch.protectedFile ??= key;
        if (finished || parent.agent === 'codex') {
          completed.add(key);
          admittedCompletions.add(key);
          completionChanges.set(key, true);
        }
        const childCut = epochChildSessions.get(key);
        if (childCut && !sameRevision({ ...childCut, dev: childCut.dev ?? '', ino: childCut.ino ?? '' }, scanRevision))
          epochChildSessions.delete(key);
        if (qualified && reachedTarget && epoch.protectedFile === key) delete epoch.protectedFile;
        if (
          !reachedTarget &&
          claudeCursor &&
          (claudeCursor.fragmentBytes > 256 * 1024 ||
            Buffer.byteLength(JSON.stringify(claudeCursor.state)) > 8 * 1024 * 1024)
        )
          epoch.protectedFile = key;
        if (epoch.protectedFile === key && !reachedTarget) {
          completed.delete(key);
          completionChanges.set(key, false);
        }
        if (!finished) {
          continuation = true;
          unsettled.unfinished = true;
        }
        if (!finished && parent.agent === 'claude') {
          completed.delete(key);
          completionChanges.set(key, false);
        }
        if (charges.readBytes > readsBefore || performance.now() - startedAt >= RELATIONSHIP_SLICE_MS) {
          charges.quanta++;
          acknowledge?.(pending(key));
        }
      } catch (error) {
        if (charges.readBytes > readsBefore || performance.now() - startedAt >= RELATIONSHIP_SLICE_MS) charges.quanta++;
        incomplete = true;
        const generation = sourceGenerations.get(key);
        claudeChildReferences.set(key, {
          ...(held ??
            (generation === undefined
              ? { ...revision, references: [] }
              : { ...revision, references: [], sourceGeneration: generation + 1 })),
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          source: parent.agent,
          sessionId: parent.sessionId,
          childTranscript: parent.childTranscript === true,
          complete: false,
          relationshipComplete: false,
          resetReason: error instanceof Error ? error.message : 'Source unavailable',
        });
        noteSourceGeneration(key, claudeChildReferences.get(key)!);
        completed.delete(key);
        completionChanges.set(key, false);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    parentStamps.clear();
    found = walk();
    if (incomplete || [...candidates].some(([key, parent]) => parent.agent === 'claude' && !completed.has(key))) {
      // A Claude transcript left unread or unfinished ends the pass on the transcript allowance. A failed read ends it otherwise.
      if (!signal.aborted) charges[incomplete ? 'otherPassEnds' : 'transcriptPassEnds']++;
      return pending();
    }
    for (const [file] of candidates) {
      if (completed.has(file)) continue;
      const entry = claudeChildReferences.get(file);
      if (!entry) {
        if (!continuation && !checkMissing(file)) {
          continuation = true;
          unsettled.unread = true;
        }
        continue;
      }
      const current = checkParent(file);
      if (!current || !unchangedFinished(entry, candidates.get(file)!, current)) {
        completed.delete(file);
        completionChanges.set(file, false);
        claudeChildReferences.set(file, { ...entry, complete: false, relationshipComplete: false });
        continuation = true;
        // A source that kept its identity and revision and stays unfinished waits for the allowance of a later request.
        const parent = candidates.get(file)!;
        if (
          current &&
          entry.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION &&
          entry.source === parent.agent &&
          entry.sessionId === parent.sessionId &&
          entry.childTranscript === (parent.childTranscript === true) &&
          sameRevision(entry, current)
        )
          unsettled.deferred = true;
        else unsettled.changed = true;
        if (candidates.get(file)!.agent === 'claude') {
          charges.otherPassEnds++;
          return pending();
        }
      }
    }

    for (const file of [...claudeChildReferences.keys()]) if (!candidates.has(file)) claudeChildReferences.delete(file);
    const boundedEntries = limitCodexDispatchCursors(claudeChildReferences);
    for (const [file, entry] of boundedEntries) if (!entry.complete && !entry.visitedEof) completed.delete(file);
    claudeChildReferences.clear();
    for (const [file, entry] of boundedEntries) claudeChildReferences.set(file, entry);
    // A walk and a targeted refresh list the same parents in different orders, and a listing can name a parent twice. The
    // epoch reads its own parents, so only a parent that joins, leaves or changes identity asks for another pass.
    if (!epochParentKeys || !epoch.epoch || epochParentKeys.epoch !== epoch.epoch)
      epochParentKeys = { epoch: epoch.epoch, keys: new Set(epoch.parents.map(discoverySourceKey)) };
    const epochParents = epochParentKeys.keys;
    const requestParents = new Set(request.parents.map(discoverySourceKey));
    unsettled.parents =
      epochParents.size !== requestParents.size || [...requestParents].some((key) => !epochParents.has(key));
    continuation ||= unsettled.parents;
    // A replaced store directory starts the scan again from its first entry, here and before publication. Other store changes
    // keep the scan's position.
    if (receiptScan && receiptScan.store.storeIdentity() !== receiptScan.storeIdentity) closeReceiptScan('store');
    // The scan of a new epoch reuses the last completed scan unless keptScanRefusal names a reason, and follows a store that
    // moved. Otherwise it reads the store from its first entry.
    if (!receiptScan) {
      const kept = keptReceiptScan;
      keptReceiptScan = null;
      const refusal = kept ? keptScanRefusal(kept) : undefined;
      const opens = heldReceiptCountsFor(scope).opens;
      if (kept && !refusal) {
        opens.push('receiptScanReuses');
        receiptScan = reusedReceiptScan(kept, epoch, heldReceiptCountsFor(scope).work);
      } else {
        opens.push(
          'receiptScanOpens',
          receiptScanClosed ? RECEIPT_SCAN_OPEN_CHARGES[receiptScanClosed] : 'receiptScanOpensNewWorker',
        );
        if (refusal) opens.push(KEPT_SCAN_REFUSAL_CHARGES[refusal]);
        const controller = new AbortController();
        const store = new DispatchReceipts();
        const revisions = store.storeRevisions();
        const listing: DispatchRootNames = { names: new Map(), complete: false };
        const scan: ReceiptScan = {
          storeIdentity: store.storeIdentity(),
          storeRevision: joinedStoreRevision(revisions),
          revisions,
          rootNames: listing.names,
          cacheLaunches: new Set(),
          unread: new Map(),
          absent: new Map(),
          owed: new Set(),
          read: new Set(),
          follow: null,
          unproved: false,
          epoch: epoch.epoch,
          store,
          controller,
          catalog: receiptCatalogOf(epoch.catalog),
          compressed: compressedRequesters,
          steps: store.relationships(() => scan.catalog, controller.signal, listing),
          launches: new Map(),
          references: new Map(),
          retries: [],
          retry: null,
          storeRead: false,
          competitionRefused: false,
          visited: new Set(),
          startups: new Map(),
          stops: new Map(),
          fullAt: Date.now(),
          reuseRetries: new Map(),
          reuseClasses: new Map(),
        };
        receiptScan = scan;
      }
    }
    const activeReceipts = receiptScan;
    // A receipt slice changes no reference entry. When this request sent no earlier reply and the host's checkpoint is the
    // one that this worker's last reply left, the reply is a delta with the rows and completions that differ from that reply.
    // Otherwise it is a whole progress reply.
    const receiptReply = () => {
      const sent = sentReferences;
      if (
        replied ||
        !hostCheckpoint ||
        !sent ||
        sent.epoch !== epoch.epoch ||
        sent.sequence !== hostCheckpoint.sequence
      )
        return pending();
      const rows: Array<[string, ClaudeChildReferenceCacheEntry]> = [];
      for (const [file, entry] of claudeChildReferences) {
        const row = withSavedFacts([file, entry]);
        const held = sent.rows.get(file);
        if (!held || held.entry !== entry || held.head !== row[1].head || held.dispatch !== row[1].dispatch)
          rows.push(row);
      }
      const hostCompleted = new Set(hostCheckpoint.completed);
      completionChanges.clear();
      for (const file of completed) if (!hostCompleted.has(file)) completionChanges.set(file, true);
      for (const file of hostCompleted) if (!completed.has(file)) completionChanges.set(file, false);
      epoch.completed = [...completed];
      if (!signal.aborted) recordHeldReceiptCounts(charges, scope);
      return pending(undefined, true, rows);
    };
    let receiptDeadline = performance.now() + RECEIPT_SLICE_MS;
    let receiptSliceStart = 0;
    let receiptSteps = 0;
    let turnSteps = 0;
    let turnEntered = false;
    let statusAt = performance.now();
    // A receipt slice changes no completion, so the source count of the status messages is the same for the whole loop.
    let sourceCount: { completed: number; known: number } | undefined;
    // The deadline ends a slice after its first step, so a paused worker still advances.
    while (!signal.aborted) {
      if (
        requestBytes <= charges.readBytes - receiptSliceStart ||
        receiptSteps >= RECEIPT_STEPS ||
        (receiptSteps > 0 && performance.now() >= receiptDeadline)
      ) {
        charges.receiptPassEnds++;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal.aborted) break;
        if (discoveryYield) return receiptReply();
        if (request.sliceReply) return receiptReply();
        // A backfill takes discovery turns only after the worker's first complete reply, as between requests.
        if (discovery.repliedComplete) {
          await Promise.all([...compressedBackfills.values()].flatMap((backfill) => backfill.takeTurn() ?? []));
          if (signal.aborted) break;
          // A request that arrived during the turn takes its reply before another slice.
          if (discoveryYield) return receiptReply();
        }
        if (performance.now() - statusAt >= 250) {
          statusAt = performance.now();
          if (!sourceCount) {
            const known = new Set([...epoch.parents, ...epoch.catalog].map((row) => normalizeFsPath(row.file)));
            const done = new Set([...completed].map(normalizeFsPath).filter((file) => known.has(file)));
            sourceCount = { completed: done.size, known: known.size };
          }
          acknowledge?.({ kind: 'discovery-status', ...sourceCount, receiptEntries: charges.receiptEntries! });
        }
        receiptSliceStart = charges.readBytes;
        receiptSteps = 0;
        turnSteps = 0;
        turnEntered = false;
        receiptDeadline = performance.now() + RECEIPT_SLICE_MS;
      }
      // A recorded launch whose identities changed catalog rows is read again before the scan completes.
      const retryId = activeReceipts.retry ? undefined : activeReceipts.retries.shift();
      if (retryId !== undefined)
        activeReceipts.retry = activeReceipts.store.relationship(
          retryId,
          () => activeReceipts.catalog,
          activeReceipts.controller.signal,
        );
      if (!activeReceipts.retry && activeReceipts.storeRead) break;
      if (!turnEntered) {
        turnEntered = true;
        charges.receiptScanTurns!++;
      }
      const grant = { entries: 1, checks: 1, bytes: requestBytes - (charges.readBytes - receiptSliceStart) };
      const step = activeReceipts.retry ? activeReceipts.retry.next(grant) : activeReceipts.steps.next(grant);
      if (step.done) {
        if (activeReceipts.retry) activeReceipts.retry = null;
        else activeReceipts.storeRead = true;
        continue;
      }
      charges.receiptEntries! += step.value.entries;
      charges.receiptChecks! += step.value.checks;
      charges.receiptBytes! += step.value.bytes;
      charges.readBytes += step.value.bytes;
      const launchId = step.value.launchId;
      if (launchId !== undefined) {
        const identities = step.value.identities;
        // A launch that a reused scan sent to be read again counts when its read ends.
        const reused = activeReceipts.reuseRetries.get(launchId);
        if (reused !== undefined) {
          activeReceipts.reuseRetries.delete(launchId);
          charges.receiptScanReuseLaunches!++;
          if (reused) charges.receiptScanReuseLaunchesUnlinked!++;
        }
        activeReceipts.visited.add(launchId);
        activeReceipts.read.add(launchId);
        if (step.value.cache) activeReceipts.cacheLaunches.add(launchId);
        else activeReceipts.cacheLaunches.delete(launchId);
        const unread = step.value.unread;
        const previous = activeReceipts.unread.get(launchId)?.revision;
        if (unread)
          activeReceipts.unread.set(launchId, { ...unread, stable: !!previous && previous === unread.revision });
        else activeReceipts.unread.delete(launchId);
        if (step.value.absent) activeReceipts.absent.set(launchId, step.value.absent);
        else activeReceipts.absent.delete(launchId);
        activeReceipts.references.delete(launchId);
        activeReceipts.startups.delete(launchId);
        if (step.value.startup) activeReceipts.startups.set(launchId, step.value.startup);
        if (step.value.stop) activeReceipts.stops.set(launchId, step.value.stop);
        else activeReceipts.stops.delete(launchId);
        if (identities?.child) charges.receiptLaunchesRead!++;
        else if (identities) charges.receiptLaunchesRejectedAtRequester!++;
        if (identities)
          activeReceipts.launches.set(launchId, [
            catalogIdentity(identities.requester.agent, identities.requester.sessionId),
            ...(identities.child ? [catalogIdentity(identities.child.agent, identities.child.sessionId)] : []),
          ]);
        else activeReceipts.launches.delete(launchId);
      }
      if (step.value.reference) {
        activeReceipts.references.set(launchId ?? `step-${activeReceipts.references.size}`, step.value.reference);
        activeReceipts.store.checkpointRelationships();
      }
      if (step.value.refusal) activeReceipts.unproved = true;
      if (step.value.refusal && ('launchId' in step.value.refusal || step.value.refusal.storeOpened))
        activeReceipts.competitionRefused = true;
      receiptSteps++;
      if (++turnSteps >= RECEIPT_TURN_STEPS || windowReads.size > 0) {
        turnSteps = 0;
        turnEntered = false;
        await receiptScanTurn();
      }
    }
    if (signal.aborted) {
      holdReceiptWork(charges, scope);
      return { kind: 'stale' };
    }
    // Links read from a replaced store never publish with retries read from its replacement.
    if (activeReceipts.store.storeIdentity() !== activeReceipts.storeIdentity) {
      closeReceiptScan('store');
      charges.receiptPassEnds++;
      return pending();
    }
    // A missing source that returned ends the request with a progress reply. The next request reads the source from its
    // first byte, so the complete reply carries its children.
    if (missingSources && missingSources.epoch === epoch.epoch) {
      let returned = false;
      for (const [key, file] of missingSources.files) {
        if (completed.has(key) && checkMissing(file)) continue;
        missingSources.files.delete(key);
        // A child source that returned resolves again in the next walk.
        epochChildSessions.delete(key);
        if (!completed.delete(key)) continue;
        returned = true;
        admittedCompletions.delete(key);
        completionChanges.set(key, false);
        claudeChildReferences.delete(key);
      }
      if (returned) {
        charges.transcriptPassEnds++;
        return pending();
      }
    }
    const transcriptReferences = resolveClaudeDispatchReferences(found.references, epoch.catalog);
    if (
      activeReceipts.competitionRefused &&
      (activeReceipts.references.size ||
        transcriptReferences.some((reference) => reference.kind === 'dispatch' && reference.file))
    ) {
      closeReceiptScan('refusal');
      charges.otherPassEnds++;
      return pending();
    }
    // A reused scan proves its reads when the store revision after its last read equals the revision at its opening. A
    // launch read without that proof stays owed. So does a launch whose read threw on a present published file. So does a
    // launch whose read found absent a root entry that the listing holds.
    const follow = activeReceipts.follow;
    const proven =
      !follow ||
      (activeReceipts.storeRevision !== undefined &&
        activeReceipts.store.storeRevision() === activeReceipts.storeRevision);
    for (const launchId of activeReceipts.read) {
      const names = activeReceipts.rootNames.get(launchId)?.split('\0') ?? [];
      const listed = activeReceipts.absent.get(launchId)?.some((name) => names.includes(name));
      if (!proven || activeReceipts.unread.has(launchId) || listed) activeReceipts.owed.add(launchId);
      else activeReceipts.owed.delete(launchId);
    }
    // An owed launch whose read threw withholds nothing once two reads take the same stats of its published entries, and the
    // newest of them is older than the age bound.
    // The full scan at the age bound reads a later write in place. Each follow still reads the launch again.
    const withheld = [...activeReceipts.owed].some((launchId) => {
      const unread = activeReceipts.unread.get(launchId);
      const modifiedAt = unread?.stable && unread.revision ? dispatchRevisionModifiedAt(unread.revision) : undefined;
      return modifiedAt === undefined || Date.now() - modifiedAt <= RECEIPT_SCAN_REUSE_MAX_AGE_MS;
    });
    // A follow without proof and a withheld launch give a reply without a store revision.
    const receiptsProved = proven && !withheld;
    if (follow) {
      if (follow.root || follow.cache || follow.launches.size) charges.receiptScanFollows!++;
      if (follow.young) charges.receiptScanFollowsYoung!++;
      if (!proven) charges.receiptScanFollowsUnproved!++;
      if (follow.root) charges.receiptScanFollowsRoot!++;
      if (follow.cache) charges.receiptScanFollowsCache!++;
      charges.receiptScanFollowNames! += follow.names;
      charges.receiptScanFollowNamesChanged! += follow.changed;
      charges.receiptScanFollowLaunches! += follow.launches.size;
    }
    charges.receiptScanOwedLaunches! += activeReceipts.owed.size;
    discoveryPosition = epoch.position;
    discoveryEpoch = null;
    epochParentKeys = null;
    receiptScan = null;
    keptReceiptScan = activeReceipts;
    receiptScanClosed = 'completion';
    const references = [...transcriptReferences, ...activeReceipts.references.values()];
    const admittedReferences = admittedDispatchReferences(references, found.children, request.codexChildren);
    retainCodexDispatchSpendRoots(
      new Set(admittedReferences.flatMap((reference) => (reference.file ? [reference.file] : []))),
    );
    const spend = collectDispatchFacts(request, references, admittedReferences, charges);
    heldDispatchReferences = {
      scope: JSON.stringify(epoch.repositoryRoots),
      references,
      admittedReferences,
    };
    recordHeldReceiptCounts(charges, scope);
    if (unsettled.unfinished) charges.unsettledUnfinishedSources!++;
    if (unsettled.deferred) charges.unsettledDeferredSources!++;
    if (unsettled.unread) charges.unsettledUnreadSources!++;
    if (unsettled.changed) charges.unsettledChangedSources!++;
    if (unsettled.parents) charges.unsettledParentChanges!++;
    charges.passMs = performance.now() - passStarted;
    // The host clears its checkpoint on a complete reply, so the next request starts from whole replies.
    sentReferences = null;
    return {
      kind: 'claude-children',
      checkpoint: { ...epoch, completed: [...completed], sequence: epoch.sequence + 1 },
      ...found,
      references,
      dispatchFacts: spend.dispatched,
      referenceEntries: [...claudeChildReferences].map(withSavedFacts),
      complete: true,
      continuation: continuation || spend.continuation,
      membershipSettled: !continuation,
      charges,
      dispatchRoots: spend.dispatchRoots,
      roots: epoch.parents,
      scope: epoch.repositoryRoots,
      receiptStore: activeReceipts.storeIdentity,
      ...(activeReceipts.storeRevision !== undefined && !activeReceipts.unproved && receiptsProved
        ? { receiptRevision: { store: activeReceipts.storeRevision, observedAt: activeReceipts.fullAt } }
        : {}),
    };
  }
  if ((request.kind === 'starts' || request.kind === 'metadata') && isCompressedRollout(request.session.file)) {
    return { kind: 'stale', unread: true };
  }
  if (request.kind === 'starts') {
    if (request.session.agent === 'agy') {
      const { file, sessionId, size } = request.session;
      const parsed = readAgySession(file, sessionId, { maxTurns: Number.MAX_SAFE_INTEGER });
      return {
        kind: 'starts',
        starts: {
          starts: parsed.read?.turns.map((turn) => turn.startedAt) ?? [],
          whole: parsed.read !== null && parsed.read.readBytes === size,
        },
      };
    }
    const starts =
      request.session.agent === 'claude'
        ? readSessionTurnStarts(request.session.file, undefined, request.session.childTranscript === true)
        : readCodexTurnStarts(request.session.file);
    return needsAgentRunScan(request.session)
      ? {
          kind: 'starts',
          starts,
          agentRunScan: scanForAgentRun(request.session.file, request.session.size, request.agentRunScan),
        }
      : { kind: 'starts', starts };
  }
  if (request.kind === 'metadata') {
    const session = request.session;
    const tailBytes = request.tailBytes ?? 256 * 1024;
    if (session.agent === 'agy') {
      const { read } = readAgySession(session.file, session.sessionId, {
        tailBytes,
        maxTurns: Number.MAX_SAFE_INTEGER,
      });
      if (!read) return { kind: 'stale', unread: true };
      const label = session.agyFirstPrompt ?? '';
      return {
        kind: 'metadata',
        coverage: { whole: read.readBytes === session.size, windowBytes: tailBytes },
        entry: {
          sourceIdentity: { dev: session.dev ?? -1, ino: session.ino ?? -1 },
          mtimeMs: session.mtimeMs,
          size: session.size,
          label,
          fullLabel: label,
          foldedLabel: label.toLocaleLowerCase(),
          activityMs: read.turns.at(-1)?.endedAt ?? session.mtimeMs,
          agentRun: false,
          outcome: sessionOutcomeOf(read),
          stats: sessionStatFactsOf(read),
        },
      };
    }
    const meta =
      session.agent === 'claude'
        ? readSessionMeta(session.file, tailBytes, session.sessionId, session.childTranscript === true)
        : readCodexSessionActivity(session.file, tailBytes, {
            sessionId: session.sessionId,
            meta: request.opening ?? null,
          });
    const title = session.agent === 'codex' ? readCodexSessionTitlePair(session.file) : null;
    // A Claude tail with no recorded title leaves the first prompt to a read of the head,
    // which `metadataReadBudget` charges for.
    const claude = session.agent === 'claude' ? (meta as ReturnType<typeof readSessionMeta>) : null;
    const label = title?.short || claude?.title || '';
    return {
      kind: 'metadata',
      coverage: meta.coverage,
      entry: {
        sourceIdentity: { dev: session.dev ?? -1, ino: session.ino ?? -1 },
        mtimeMs: session.mtimeMs,
        size: session.size,
        label,
        fullLabel: title?.full || claude?.fullTitle || '',
        activityMs: meta.activityMs,
        agentRun: session.agentRun === true ? true : claude ? claude.agentRun : false,
        outcome: meta.outcome,
        stats: meta.stats ?? null,
        ...(claude?.backgroundCommands ? { backgroundCommands: claude.backgroundCommands } : {}),
        foldedLabel: label.toLocaleLowerCase(),
        ...(claude?.title && claude.titleSource ? { nameSource: claude.titleSource } : {}),
        ...(claude?.title && claude.titleSource && claude.titleAt !== undefined ? { nameAt: claude.titleAt } : {}),
        ...(claude?.headKey ? { headKey: claude.headKey } : {}),
        ...(claude?.withdrawnPrompt ? { withdrawnPrompt: true } : {}),
      },
    };
  }
  const {
    session,
    folders,
    children,
    claudeChildren = [],
    claudeChildReferences: references = [],
    maxTurns,
    tailBytes,
  } = request.input;
  if (session.agent === 'agy' && request.kind === 'window') {
    const checkpoint = revive(request.checkpoint) as AgyCheckpoint | undefined;
    let result = await readAgySessionAsync(session.file, session.sessionId, maxTurns, tailBytes, checkpoint, {
      signal,
    });
    if (result.read && !result.read.turns.length && result.checkpoint.coveredFrom > 0) {
      const page = await readAgyHistoryPage(session.file, session.sessionId, null, { signal, targetTurns: 1 });
      if (page.kind === 'page' && page.page.turns.length)
        result = await readAgySessionAsync(
          session.file,
          session.sessionId,
          maxTurns,
          page.page.revision.size - page.page.ownedRange.start + 1,
          undefined,
          { signal },
        );
    }
    if (!result.read) return { kind: 'stale' };
    return {
      kind: 'window',
      read: result.read,
      checkpoint: result.checkpoint,
      reset: result.kind === 'reset',
      appendFrom: result.appendFrom,
      readBytes: result.readBytes,
      agentKey: '',
      structuralKey: '',
      retainedBytes: Buffer.byteLength(JSON.stringify([result.read, result.checkpoint])),
      checkpointBytes: Buffer.byteLength(JSON.stringify(result.checkpoint)),
    };
  }
  const claudeChildFor = (agent: AgentSpendRef) =>
    agent.toolUseId
      ? claudeChildren.find(
          (candidate) =>
            candidate.parentSessionId === session.sessionId &&
            candidate.sessionId === agent.id &&
            candidate.toolUseIds.includes(agent.toolUseId as string),
        )
      : undefined;
  const versions = new Map<string, string>();
  const codexIndex = session.agent === 'codex' ? codexSpendIndex(children) : null;
  const readCodexSpend = codexIndex ? codexAgentSpendReader(codexIndex) : null;
  const subagentMetas = claudeSubagentMetaReader();
  const agentFile = (agent: AgentSpendRef) =>
    session.agent === 'claude'
      ? claudeChildFileFor(references, session, agent, subagentMetas)
      : (codexSubagentFor(children, session.sessionId, agent)?.file ?? null);
  const versionOf = (file: string): string => {
    let version = versions.get(file);
    if (version === undefined) {
      version =
        session.agent === 'codex'
          ? codexAgentSpendVersion(file, codexIndex!, undefined, undefined, session.file)
          : childSpendVersion(session.agent, file, subagentMetas);
      versions.set(file, version);
    }
    return version;
  };
  const structuralKey =
    session.agent === 'codex'
      ? children
          .filter((child) => child.parentThreadId === session.sessionId)
          .map(
            (child) =>
              `${child.threadId}:${child.openedAt ?? ''}:${child.threadSource ?? ''}:${child.backgroundReview}:${child.file}`,
          )
          .sort()
          .join('\n')
      : claudeRelationshipKey(session.sessionId, references, claudeChildren);
  const claudeSpendParseKey = session.agent === 'claude' ? folders.map(normalizeFsPath).sort().join('\n') : '';
  // Use one clock reading for child spend and its dependency key.
  const spendNow = request.input.spendNow ?? Date.now();
  const agentSpendOf: AgentSpendLookup = (agent) => {
    const file = agentFile(agent);
    if (!file) {
      return { models: [], found: false, partial: false, effort: null };
    }
    return session.agent === 'claude'
      ? readChildSpend(
          agentSpends,
          file,
          agent.status,
          versionOf(file),
          (source) => readClaudeAgentSpend(source, folders, true, subagentMetas),
          claudeSpendParseKey,
          true,
          spendNow,
        )
      : readChildSpend(
          agentSpends,
          file,
          agent.status,
          versionOf(file),
          readCodexSpend!,
          versionOf(file)
            .split('\n')
            .filter((line) => line.startsWith('[') || line.startsWith('source:'))
            .join('\n'),
          true,
          spendNow,
        );
  };
  const agentSessionTargetOf: AgentSessionTargetLookup = (agent) => {
    if (session.agent !== 'claude' || !agent.id || !agent.toolUseId || !/^[A-Za-z0-9-]+$/.test(agent.id)) {
      return null;
    }
    const child = claudeChildFor(agent);
    return child?.sessionId ?? null;
  };
  const options = {
    maxTurns,
    tailBytes,
    folders,
    agentSpendOf,
    agentSessionTargetOf,
    childTranscript: session.childTranscript === true,
    structuralChildren: children,
  };
  if (request.kind === 'retained') {
    const retained = request.pages.flatMap((page) => page.turns);
    retained.forEach((turn, index) => applyHiddenTurnFields(turn, request.hidden?.[index], session.agent === 'codex'));
    // Retained pages refresh together, and with the newest window when the host sends it last.
    if (session.agent === 'claude')
      refreshRetainedClaudeAgentFacts(request.pages, agentSpendOf, agentSessionTargetOf, request.endsAtNewest === true);
    return {
      kind: 'retained',
      pages: request.pages.map((page) => {
        if (session.agent === 'codex') {
          refreshCodexStructuralAgents(
            page.turns,
            session.sessionId,
            options.structuralChildren,
            agentSpendOf,
            request.structuralAgentIds,
          );
        }
        return { ...page, bytes: historyPageBytes(page) };
      }),
    };
  }
  // A compressed rollout opens through its decoded body. A cursor or checkpoint of another form, path or hash is stale.
  const compressedFile = isCompressedRollout(session.file);
  const openCompressed = async (verify: boolean) => {
    if (!compressedFile) return null;
    if (session.agent !== 'codex') return { kind: 'stale' as const };
    const releases = bodyReleases;
    const opened = await openCompressedBody(session.file, verify, signal, request.input.compressedLimits);
    if (opened.kind === 'body') for (const backfill of compressedBackfills.values()) backfill.noteOpened(session.file);
    if (opened.kind !== 'body') return opened;
    if (releasedSinceArrival(session.file, opened.body, signal)) return { kind: 'cancelled' as const };
    requestBodies.set(signal, { body: opened.body, releases });
    const source = compressedByteSource(opened.body);
    const opening = openingRecordOf(source.opening());
    return { kind: 'source' as const, source, opening };
  };
  if (request.kind === 'page') {
    const opened = await openCompressed(false);
    const failed = { kind: 'page' as const, page: { kind: 'failed' as const }, recoveryBytes: 0 };
    const stale = { kind: 'page' as const, page: { kind: 'stale' as const }, recoveryBytes: 0 };
    if (opened && opened.kind !== 'source') return opened.kind === 'failed' ? failed : stale;
    const compressed = opened?.kind === 'source' ? opened : null;
    if (
      request.cursor &&
      (compressed
        ? request.cursor.bodyHash !== compressed.source.body.hash || request.cursor.bodyFile !== session.file
        : request.cursor.bodyHash !== undefined)
    )
      return stale;
    const sourceStamp = commitSourceStamp(session.file);
    if (request.cursor) {
      request.cursor.fragment = Buffer.from(request.cursor.fragment);
    }
    const bodyOptions = compressed
      ? {
          revision: compressed.source.revision,
          readRange: compressed.source.readRange,
          evidenceReadRange: compressed.source.readRange,
          opening: () => compressed.opening,
        }
      : {};
    const result =
      session.agent === 'claude'
        ? await readClaudeHistoryPageAsync(
            session.file,
            session.sessionId,
            request.cursor as ClaudeHistoryCursor | null,
            { signal, targetTurns: 20 },
            options,
          )
        : session.agent === 'agy'
          ? await readAgyHistoryPage(session.file, session.sessionId, request.cursor as AgyHistoryCursor | null, {
              signal,
              targetTurns: 20,
            })
          : await readCodexHistoryPageAsync(
              session.file,
              session.sessionId,
              request.cursor as CodexHistoryCursor | null,
              { signal, targetTurns: 20, ...bodyOptions },
              options,
            );
    if (result.kind === 'page') bindCommitSources(result.page.turns, session.file, sourceStamp);
    const body = compressed?.source.body;
    if (body && result.kind === 'page' && result.page.nextOlderCursor) {
      result.page.nextOlderCursor.bodyFile = body.file;
      result.page.nextOlderCursor.bodyHash = body.hash;
    }
    return {
      kind: 'page',
      ...(body && !body.complete ? { partial: body.frames } : {}),
      ...(body?.skippedRecords ? { skippedRecords: body.skippedRecords } : {}),
      recoveryBytes: result.kind === 'page' ? (result.page.recoveryBytes ?? 0) : 0,
      page:
        result.kind === 'page'
          ? {
              kind: 'page',
              turns: result.page.turns,
              compactions: result.page.compactions,
              cursor: result.page.nextOlderCursor,
              ownedRange: result.page.ownedRange,
              openRange: result.openRange,
            }
          : result.kind === 'stale'
            ? { kind: 'stale' }
            : { kind: 'failed' },
    };
  }
  const opened = await openCompressed(true);
  if (opened && opened.kind !== 'source') {
    return opened.kind === 'unsupported'
      ? { kind: 'failed', unsupported: true }
      : opened.kind === 'failed'
        ? { kind: 'failed' }
        : opened.kind === 'cancelled'
          ? { kind: 'stale', interrupted: true }
          : { kind: 'stale' };
  }
  const compressed = opened?.kind === 'source' ? opened : null;
  const body = compressed?.source.body;
  const revived = revive(request.checkpoint);
  // The host sends a compressed checkpoint for an equal physical revision. A new hash or form drops it.
  const checkpoint = revived && revived.bodyHash === body?.hash ? revived : undefined;
  const bodyWork = compressed
    ? {
        revision: compressed.source.revision,
        readRange: compressed.source.readRange,
        opening: () => compressed.opening,
      }
    : {};
  const sessionSize = body ? body.length : session.size;
  let recoveryBytes = 0;
  const read = async (bytes: number, held = checkpoint) => {
    const result = await (session.agent === 'claude'
      ? readClaudeSessionIncrementalAsync(
          session.file,
          session.sessionId,
          held as ClaudeForwardCheckpoint | undefined,
          { ...options, tailBytes: bytes },
          { signal },
        )
      : readCodexSessionIncrementalAsync(
          session.file,
          session.sessionId,
          held as CodexForwardCheckpoint | undefined,
          { ...options, tailBytes: bytes },
          { signal, ...bodyWork },
        ));
    recoveryBytes += 'recoveryBytes' in result ? Number(result.recoveryBytes) : 0;
    return result;
  };
  const retainedBytes = checkpoint
    ? Math.max(tailBytes, Number(JSON.parse(checkpoint.parserKey).tailBytes) || tailBytes)
    : tailBytes;
  const sourceStamp = commitSourceStamp(session.file);
  let result = await read(retainedBytes);
  if (!result.read) {
    return { kind: 'stale', recoveryBytes };
  }
  let appendFrom = result.appendFrom;
  const initialRevision = result.checkpoint.revision;
  if (!result.read.turns.length && result.checkpoint.coveredFrom > 0) {
    const tail = compressed ? compressed.source.tail(tailBytes, true) : tailOf(session.file, tailBytes, true);
    if (session.agent === 'claude') {
      tail.lines = blankClaudeRepeated(session.file, tail.lines, tail.offset ?? 0, Number.MAX_SAFE_INTEGER);
    }
    if (tail.cursor) {
      if (session.agent === 'claude' && session.childTranscript) {
        result = await read(session.size, undefined);
      } else {
        const discovered =
          session.agent === 'claude'
            ? await discoverClaudeNewestTurn(session.file, tail.cursor, { signal, chunkBytes: 256 * 1024 }, tail.lines)
            : await discoverCodexNewestTurn(session.file, tail.cursor, undefined, {
                signal,
                chunkBytes: 256 * 1024,
                ...(compressed
                  ? { readRange: compressed.source.readRange, agentPath: compressed.opening?.agentPath ?? null }
                  : {}),
              });
        if (discovered.kind === 'cancelled' || discovered.kind === 'stale') {
          return { kind: 'stale', recoveryBytes };
        }
        const bytes = discovered.kind === 'found' ? discovered.readBytes : sessionSize;
        result = await read(bytes, undefined);
      }
      appendFrom =
        appendFrom && result.checkpoint && sameRevision(initialRevision, result.checkpoint.revision)
          ? appendFrom
          : null;
    }
  }
  if (!result.read) {
    return { kind: 'stale', recoveryBytes };
  }
  const codexChildFiles =
    session.agent === 'codex'
      ? children.filter((child) => child.parentThreadId === session.sessionId).map((child) => child.file)
      : [];
  if (!result.checkpoint.lineFragment.length && !result.checkpoint.discardUntilNewline)
    bindCommitSources(result.read.turns, session.file, sourceStamp);
  if (body) result.checkpoint.bodyHash = body.hash;
  return {
    kind: 'window',
    ...(body && !body.complete ? { partial: body.frames } : {}),
    ...(body?.skippedRecords ? { skippedRecords: body.skippedRecords } : {}),
    ...(body?.undercount ? { undercount: true as const } : {}),
    read: result.read,
    checkpoint: result.checkpoint,
    reset: result.kind === 'reset',
    appendFrom,
    readBytes: result.readBytes,
    recoveryBytes,
    recoveryPending: 'recoveryPending' in result && result.recoveryPending === true,
    agentKey: agentSpendDependencyKey(
      result.read.turns,
      agentFile,
      versionOf,
      structuralKey,
      codexChildFiles,
      spendNow,
    ),
    structuralKey,
    structuralAgentIds: session.agent === 'codex' ? codexStructuralAgentIds(result.read.turns) : undefined,
    retainedBytes: Buffer.byteLength(JSON.stringify([result.read, result.checkpoint])),
    checkpointBytes: Buffer.byteLength(JSON.stringify(result.checkpoint)),
  };
}

const requests = new Map<number, AbortController>();
// Window read lifecycles in this worker. Times use this worker's monotonic clock, so only their differences leave it.
// Overlap counts name other work that ran on this thread during the read, not the time that work took.
const WINDOW_READS = 8;
function emptyDiscoveryCharges(): DiscoveryCharges {
  return {
    readBytes: 0,
    receiptEntries: 0,
    receiptChecks: 0,
    receiptBytes: 0,
    receiptLaunchesRead: 0,
    receiptLaunchesRejectedAtRequester: 0,
    receiptScanTurns: 0,
    receiptScanOpens: 0,
    receiptScanOpensNewWorker: 0,
    receiptScanOpensAfterEpoch: 0,
    receiptScanOpensAfterStore: 0,
    receiptScanOpensAfterRefusal: 0,
    receiptScanOpensAfterCompletion: 0,
    receiptScanOpensAfterCompletionStore: 0,
    receiptScanOpensAfterCompletionAge: 0,
    receiptScanOpensAfterCompletionUnproved: 0,
    receiptScanOpensAfterCompletionRevision: 0,
    receiptScanReuses: 0,
    receiptScanReuseLaunches: 0,
    receiptScanReuseLaunchesUnlinked: 0,
    receiptScanReuseUnlinkedSession: 0,
    receiptScanReuseUnlinkedFile: 0,
    receiptScanReuseUnlinkedPath: 0,
    receiptScanReuseUnlinkedOpening: 0,
    receiptScanFollows: 0,
    receiptScanFollowsYoung: 0,
    receiptScanFollowsUnproved: 0,
    receiptScanFollowsRoot: 0,
    receiptScanFollowsCache: 0,
    receiptScanFollowNames: 0,
    receiptScanFollowNamesChanged: 0,
    receiptScanFollowLaunches: 0,
    receiptScanOwedLaunches: 0,
    unsettledUnfinishedSources: 0,
    unsettledDeferredSources: 0,
    unsettledUnreadSources: 0,
    unsettledChangedSources: 0,
    unsettledParentChanges: 0,
    dispatchSpendPasses: 0,
    dispatchSpendOnlyPasses: 0,
    dispatchSpendSettledSkips: 0,
    dispatchSpendHeldRoots: 0,
    transcriptRescans: 0,
    transcriptRescansChanged: 0,
    transcriptRescansMetadata: 0,
    revalidationBytes: 0,
    hits: 0,
    resets: 0,
    quanta: 0,
    dispatchRetries: 0,
    parentChecks: 0,
    parentCheckMs: 0,
    childHeadFiles: 0,
    childHeadBytes: 0,
    childHeadMs: 0,
    dispatchSpendVisits: 0,
    dispatchSpendRereads: 0,
    dispatchSpendFiles: 0,
    dispatchSpendBytes: 0,
    dispatchSpendMs: 0,
    dispatchSpendAggregateStarts: 0,
    dispatchSpendAggregateCompletions: 0,
    dispatchSpendRelationshipInvalidations: 0,
    dispatchSpendConsumedSourceInvalidations: 0,
    dispatchSpendSourceRestarts: 0,
    dispatchSpendParserAdvancements: 0,
    dispatchSpendRootWaits: 0,
    dispatchSpendAggregateExhaustedBytes: 0,
    dispatchSpendAggregateExhaustedTime: 0,
    dispatchSpendAggregateExhaustedSource: 0,
    dispatchPersonBytes: 0,
    dispatchAggregateBytes: 0,
    dispatchClaudeSpendBytes: 0,
    dispatchAggregateRemainingBytes: 0,
    dispatchAggregateRemainingMs: 0,
    dispatchSpendRootRestarts: 0,
    passMs: 0,
    transcriptPassEnds: 0,
    receiptPassEnds: 0,
    otherPassEnds: 0,
  };
}

// The root where the next spend-only pass starts, so the spend slice rotates across passes.
let nextDispatchSpendRoot: string | null = null;

// Reads the spend and person facts of every admitted dispatched session. A pass that leaves any of that work unfinished
// returns `continuation`. It changes no catalog member or relationship, so a spend-only request can run it alone.
function collectDispatchFacts(
  request: Extract<ProgressiveRequest, { kind: 'claude-children' }>,
  references: readonly import('./transcript').ClaudeChildSessionReference[],
  admittedReferences: ReturnType<typeof admittedDispatchReferences>,
  charges: DiscoveryCharges,
  spendOnly = false,
): {
  dispatched: DispatchSessionFacts[];
  dispatchRoots: Record<string, DispatchRootCharges>;
  continuation: boolean;
  // The saved facts this pass settled or dropped, by row key, so a spend-only reply can carry them to the host's cache.
  savedChanges: Array<[string, SavedDispatchFacts | null]>;
} {
  let continuation = false;
  charges.dispatchSpendPasses!++;
  const dispatched: DispatchSessionFacts[] = [];
  const dispatchRoots: Record<string, DispatchRootCharges> = {};
  // Each request caps Codex spend reads independently of relationship discovery and of the other dispatch visits.
  const dispatchBudget: { bytes: number; ms: number; advanced?: boolean } = {
    bytes: CODEX_DISPATCH_REQUEST_BYTES,
    ms: RELATIONSHIP_SLICE_MS,
  };
  // The slice is spent when the budget refuses the next Codex spend read, which `readCodexDispatchedSpendQuantum` counts as
  // a root wait.
  const sliceSpent = () => dispatchBudget.bytes <= 0 || (dispatchBudget.advanced === true && dispatchBudget.ms <= 0);
  // Each dispatched session counts once, at its first admitted reference.
  const roots: (typeof admittedReferences)[number][] = [];
  const seen = new Set<string>();
  for (const reference of admittedReferences) {
    if (reference.kind !== 'dispatch' || !reference.file || seen.has(reference.sessionId)) continue;
    seen.add(reference.sessionId);
    roots.push(reference);
  }
  // A spend-only pass starts at the first root that the previous spend-only pass reached after its slice was spent, so each
  // pending root takes the slice in turn. A full pass starts at the first root.
  const start = spendOnly
    ? Math.max(
        0,
        roots.findIndex((reference) => reference.sessionId === nextDispatchSpendRoot),
      )
    : 0;
  const order = start ? [...roots.slice(start), ...roots.slice(0, start)] : roots;
  let reachedAfterSlice: string | null = null;
  const dispatchReads = openReadWindow();
  // The open root takes every read from the start of its visit to the start of the next root's visit.
  let openRoot: { root: DispatchRootCharges; before: number } | null = null;
  const closeRoot = () => {
    if (openRoot) openRoot.root.bytes += dispatchReads.bytes - openRoot.before;
    openRoot = null;
  };
  try {
    const subagentMetas = claudeSubagentMetaReader();
    for (const reference of order) {
      if (reference.kind !== 'dispatch' || !reference.file) continue;
      closeRoot();
      // Once a spend-only pass spends its slice, each later root with held facts returns them with no stat, spend tree or
      // person check. A root whose file changed keeps its old facts until a later pass reaches it, so every held root asks
      // for another pass. That pass starts at the first held root and passes over the unchanged ones as settled.
      if (spendOnly && sliceSpent()) {
        reachedAfterSlice ??= reference.sessionId;
        const heldFacts = dispatchFacts.get(reference.file);
        if (
          heldFacts &&
          heldFacts.sourceGeneration === claudeChildReferences.get(normalizeFsPath(reference.file))?.sourceGeneration
        ) {
          charges.dispatchSpendHeldRoots!++;
          continuation = true;
          dispatched.push(heldFacts.facts);
          continue;
        }
      }
      const revision = revisionOf(reference.file);
      const heldValue = revision ? (dispatchFacts.get(reference.file) ?? seededDispatch(reference.file)) : undefined;
      const sourceGeneration = claudeChildReferences.get(normalizeFsPath(reference.file))?.sourceGeneration;
      // A spend-only pass passes over a settled root whose file kept its revision, without its spend tree or a read. A
      // full pass still checks the spend tree of every root.
      if (
        spendOnly &&
        revision &&
        heldValue?.settled &&
        !heldValue.activityStale &&
        heldValue.sourceGeneration === sourceGeneration &&
        sameRevision(heldValue.revision, revision)
      ) {
        charges.dispatchSpendSettledSkips!++;
        dispatched.push(heldValue.facts);
        continue;
      }
      charges.dispatchSpendVisits++;
      const root: DispatchRootCharges = {
        agent: reference.agent,
        passes: 1,
        bytes: 0,
        rereads: 0,
        rootWaits: 0,
        restarts: 0,
        remainingBytes: 0,
        size: null,
      };
      dispatchRoots[reference.sessionId] = root;
      openRoot = { root, before: dispatchReads.bytes };
      if (!revision) {
        continue;
      }
      root.size = revision.size;
      const held =
        heldValue &&
        heldValue.sourceGeneration === sourceGeneration &&
        onlyGrew(heldValue.revision, revision) &&
        (heldValue.revision.size < revision.size || sameRevision(heldValue.revision, revision))
          ? heldValue
          : undefined;
      const now = Date.now();
      let codexDependencies = held?.codexDependencies ?? [reference.file];
      const sourceFile = reference.file;
      const codexVersion = () =>
        codexAgentSpendVersion(
          sourceFile,
          codexSpendIndex(request.codexChildren ?? []),
          reference.sessionId,
          codexDependencies,
        );
      const tree =
        reference.agent === 'codex'
          ? childSpendRevisionKey('completed', codexVersion(), now)
          : claudeAgentSpendVersion(reference.file, false, subagentMetas);
      if (
        held &&
        sameRevision(held.revision, revision) &&
        held.tree === tree &&
        !held.spendPending &&
        !held.activityStale &&
        now < held.refreshAt &&
        (!held.codexPerson || held.codexPerson.bytes >= revision.size)
      ) {
        dispatched.push(held.facts);
        continue;
      }
      // The spend of an unchanged file and tree stays true when only its activity answer is stale.
      if (held?.activityStale && held.activity && sameRevision(held.revision, revision) && held.tree === tree) {
        const activity = dispatchActivity(reference.file, reference.sessionId, revision, now, reference.agent);
        const covered = claudeRepeatedMap(reference.file, Number.MAX_SAFE_INTEGER, 0)?.covered === true;
        if (now >= activity.activeUntil && sameRevision(revision, revisionOf(reference.file))) {
          // The Claude spend read never marks spend unfinished. Only an activity answer does.
          const spend: AgentSpend = { ...held.facts.spend };
          delete spend.unfinished;
          if (spend.artifacts && held.activity.artifactsComplete !== null)
            spend.artifacts = { ...spend.artifacts, complete: held.activity.artifactsComplete };
          if (activity.unfinished) {
            spend.unfinished = true;
            if (spend.artifacts) spend.artifacts = { ...spend.artifacts, complete: false };
          }
          const facts = { ...held.facts, spend };
          dispatchFacts.set(reference.file, {
            ...held,
            facts,
            activity: { ...held.activity, covered },
            activityStale: false,
            saved: undefined,
          });
          dispatched.push(facts);
          continue;
        }
      }
      // A visit that resumes a pending spend aggregate at the same revision does not count as a reread.
      if (!held?.spendPending || !sameRevision(held.revision, revision)) {
        charges.dispatchSpendRereads++;
        root.rereads++;
      }
      const previousPerson =
        held &&
        held.revision.dev === revision.dev &&
        held.revision.ino === revision.ino &&
        (held.revision.size < revision.size || sameRevision(held.revision, revision))
          ? held.codexPerson
          : undefined;
      const previousBytes = previousPerson?.bytes ?? 0;
      const personBefore = dispatchReads.bytes;
      const codexPerson =
        reference.agent === 'codex'
          ? scanForCodexPerson(reference.file, revision.size, previousPerson, reference.sessionId)
          : undefined;
      charges.dispatchPersonBytes += dispatchReads.bytes - personBefore;
      if (!sameRevision(revision, revisionOf(reference.file))) {
        charges.dispatchRetries++;
        continuation = true;
        const compatible = held && onlyGrew(held.revision, revisionOf(reference.file));
        dispatched.push(
          compatible
            ? { ...held.facts, spend: { ...held.facts.spend, partial: true } }
            : {
                sessionId: reference.sessionId,
                revision,
                refreshAt: now,
                startedAt: null,
                endedAt: null,
                toolUses: 0,
                person: false,
                ...(reference.agent === 'codex' ? { personPending: true as const } : {}),
                spend: { models: [], found: false, partial: true, effort: null },
              },
        );
        dispatchFacts.delete(reference.file);
        continue;
      }
      continuation ||= !!codexPerson && codexPerson.bytes < revision.size && codexPerson.bytes > previousBytes;
      const completion = codexPerson?.dispatchCompletion;
      const completed =
        codexPerson?.bytes === revision.size &&
        codexPerson.fragment.length === 0 &&
        completion?.terminal !== null &&
        !!completion?.terminal &&
        !completion.invalid &&
        !completion.skipping;
      const activity =
        reference.agent === 'codex'
          ? { activeUntil: completed ? 0 : revision.mtimeMs + TURN_QUIET_MS, unfinished: !completed }
          : dispatchActivity(reference.file, reference.sessionId, revision, now, reference.agent);
      const activityCovered =
        reference.agent === 'claude' && claudeRepeatedMap(reference.file, Number.MAX_SAFE_INTEGER, 0)?.covered === true;
      const refreshAt = activity.activeUntil;
      const active = now < refreshAt;
      if (active && reference.agent === 'codex') releaseCodexDispatchSpend(reference.file);
      let spendPending = false;
      let spendRestarted = false;
      const spendBefore = dispatchReads.bytes;
      const spend: AgentSpend = active
        ? { models: [], found: false, partial: false, effort: null }
        : reference.agent === 'codex'
          ? (() => {
              const result = readCodexDispatchedSpendQuantum(
                reference.file,
                request.codexChildren ?? [],
                now,
                dispatchBudget,
                (files) => {
                  codexDependencies = files;
                },
                (file, entry) => parentPort?.postMessage({ dispatchSpend: [file, entry] }),
                (event) => {
                  charges[event]++;
                  if (event === 'dispatchSpendRootWaits') root.rootWaits++;
                  if (event.startsWith('dispatchSpendAggregateExhausted')) {
                    charges.dispatchAggregateRemainingBytes += dispatchBudget.bytes;
                    charges.dispatchAggregateRemainingMs += dispatchBudget.ms;
                    root.remainingBytes += dispatchBudget.bytes;
                  }
                },
              );
              spendPending = result.pending;
              spendRestarted = result.restarted;
              continuation ||= result.pending;
              return result.spend;
            })()
          : readClaudeAgentSpend(reference.file, request.repositoryRoots, false, subagentMetas);
      const spendBytes = dispatchReads.bytes - spendBefore;
      charges[reference.agent === 'codex' ? 'dispatchAggregateBytes' : 'dispatchClaudeSpendBytes'] += spendBytes;
      if (reference.agent === 'claude' && spendBytes > 0) {
        spendRestarted = (claudeSpendEnds.get(reference.sessionId) ?? 0) > 0;
        rememberRestartEvidence(claudeSpendEnds, reference.sessionId, spendBytes);
      }
      if (spendRestarted) {
        charges.dispatchSpendRootRestarts++;
        root.restarts++;
      }
      const activityRead: DispatchActivityRead | undefined =
        reference.agent === 'claude' && !active
          ? { covered: activityCovered, artifactsComplete: spend.artifacts?.complete ?? null }
          : undefined;
      if (!active && activity.unfinished) {
        spend.unfinished = true;
        if (spend.artifacts) {
          spend.artifacts.complete = false;
        }
      }
      // Claude scans active appends. Codex retains its bounded prompt cursor across quiet
      // reads because a cached spend can precede delayed copied-turn context.
      const scanBefore = dispatchReads.bytes;
      const scan =
        active && reference.agent === 'claude'
          ? scanForPerson(reference.file, revision.size, held?.person, held ? held.revision.size : revision.size)
          : undefined;
      charges.dispatchPersonBytes += dispatchReads.bytes - scanBefore;
      const person =
        reference.agent === 'codex'
          ? codexPerson && codexPerson.bytes >= revision.size
            ? codexPerson.person
            : spend.person === true || codexPerson?.person === true
          : held?.facts.person === true || (scan ? scan.person : spend.person === true);
      if (!sameRevision(revision, revisionOf(reference.file))) {
        charges.dispatchRetries++;
        continuation = true;
        const compatible = held && onlyGrew(held.revision, revisionOf(reference.file));
        dispatched.push(
          compatible
            ? { ...held.facts, spend: { ...held.facts.spend, partial: true } }
            : {
                sessionId: reference.sessionId,
                revision,
                refreshAt: now,
                startedAt: null,
                endedAt: null,
                toolUses: 0,
                person: false,
                ...(reference.agent === 'codex' ? { personPending: true as const } : {}),
                spend: { models: [], found: false, partial: true, effort: null },
              },
        );
        dispatchFacts.delete(reference.file);
        continue;
      }
      const collectedTree =
        reference.agent === 'codex'
          ? childSpendRevisionKey('completed', codexVersion(), now)
          : claudeAgentSpendVersion(reference.file, false, subagentMetas);
      if (collectedTree !== tree) {
        charges.dispatchRetries++;
        continuation = true;
        spend.partial = true;
        if (spend.artifacts) spend.artifacts.complete = false;
      }
      const facts: DispatchSessionFacts = {
        sessionId: reference.sessionId,
        refreshAt: active ? refreshAt : null,
        revision,
        spend,
        startedAt: spend.startedAt ?? null,
        endedAt: spend.endedAt ?? null,
        toolUses: spend.toolUses ?? 0,
        person,
        // A Codex person scan that has not reached the end of the file can still find reader input.
        ...(reference.agent === 'codex' && !person && (!codexPerson || codexPerson.bytes < revision.size)
          ? { personPending: true as const }
          : {}),
      };
      dispatchFacts.set(reference.file, {
        sourceGeneration,
        spendPending,
        revision,
        // The tree the read started from. When the tree moved during the read, the next pass reads again.
        tree,
        codexDependencies,
        facts,
        refreshAt: active ? refreshAt : Number.POSITIVE_INFINITY,
        person: scan,
        codexPerson,
        settled:
          !active && !spendPending && collectedTree === tree && (!codexPerson || codexPerson.bytes >= revision.size),
        activity: activityRead,
      });
      dispatched.push(facts);
    }
    if (spendOnly) nextDispatchSpendRoot = reachedAfterSlice ?? order[0]?.sessionId ?? null;
  } finally {
    closeRoot();
    const dispatchTally = closeReadWindow(dispatchReads);
    charges.dispatchSpendFiles += dispatchTally.files;
    charges.dispatchSpendBytes += dispatchTally.bytes;
    charges.dispatchSpendMs += dispatchTally.ms;
  }
  // A rotated pass returns its facts in reference order.
  if (start) {
    const position = new Map(roots.map((reference, index) => [reference.sessionId, index]));
    dispatched.sort((left, right) => (position.get(left.sessionId) ?? 0) - (position.get(right.sessionId) ?? 0));
  }
  const currentFiles = new Set(
    references.flatMap((reference) => (reference.kind === 'dispatch' && reference.file ? [reference.file] : [])),
  );
  for (const file of dispatchFacts.keys()) {
    if (!currentFiles.has(file)) {
      dispatchFacts.delete(file);
    }
  }
  const previousSaved = savedDispatchFacts;
  savedDispatchFacts = new Map();
  for (const [file, held] of dispatchFacts) {
    if (!held.settled) continue;
    held.saved ??= {
      version: DISPATCH_FACTS_VERSION,
      revision: held.revision,
      tree: held.tree,
      sourceGeneration: held.sourceGeneration,
      codexDependencies: held.codexDependencies,
      ...(held.activity ? { activity: held.activity } : {}),
      facts: held.facts,
    };
    savedDispatchFacts.set(normalizeFsPath(file), held.saved);
  }
  const savedChanges: Array<[string, SavedDispatchFacts | null]> = [];
  for (const [file, saved] of savedDispatchFacts)
    if (previousSaved?.get(file) !== saved) savedChanges.push([file, saved]);
  for (const file of previousSaved?.keys() ?? []) if (!savedDispatchFacts.has(file)) savedChanges.push([file, null]);
  return { dispatched, dispatchRoots, continuation, savedChanges };
}

type RequestKind = ProgressiveRequest['kind'];
const activeKinds: Partial<Record<RequestKind, number>> = {};
const windowReads = new Map<
  number,
  {
    receivedAt: number;
    enteredAt: number | null;
    completedAt: number | null;
    report: Omit<WorkerWindowRead, 'enterMs' | 'readMs' | 'replyMs'>;
  }
>();
function countKind(counts: Partial<Record<RequestKind, number>>, kind: RequestKind): void {
  counts[kind] = (counts[kind] ?? 0) + 1;
}
function noteBackground(field: 'discoveryProgress' | 'repeatedCoverage'): void {
  for (const read of windowReads.values()) read.report.during[field]++;
}
function windowReadReport(id: number): WorkerWindowRead | undefined {
  const read = windowReads.get(id);
  if (!read) return undefined;
  const now = performance.now();
  return {
    ...read.report,
    enterMs: read.enteredAt === null ? null : read.enteredAt - read.receivedAt,
    readMs: read.enteredAt === null || read.completedAt === null ? null : read.completedAt - read.enteredAt,
    replyMs: now - (read.completedAt ?? read.enteredAt ?? read.receivedAt),
  };
}

function workerMemory(): import('./progressiveworker').WorkerMemory {
  const heap = getHeapStatistics();
  return {
    heapUsed: heap.used_heap_size,
    heapTotal: heap.total_heap_size,
    heapLimit: heap.heap_size_limit,
    external: heap.external_memory,
  };
}
let commitParentCursor: import('./codexhistory').CommitRepositoryCursor | null = null;
// Children of one parent share the parent cursor and keep their own child cursors. Visible sessions on sibling
// children therefore resume their own scans when their requests alternate. Map order is least recently used first.
const COMMIT_CHILD_CURSORS = 8;
const commitChildCursors = new Map<
  string,
  { cursor: import('./codexhistory').CommitRepositoryCursor; token: string }
>();
let commitCursorSequence = 0;

async function executeCommitRepositories(
  request: Extract<ProgressiveRequest, { kind: 'commit-repositories' }>,
  signal: AbortSignal,
): Promise<ProgressiveValue> {
  const {
    createCommitRepositoryCursor,
    scanCommitRepositorySource,
    commitRepositoryTargets,
    commitSourceRevision,
    COMMIT_REPOSITORY_PARSER_VERSION,
    COMMIT_REPOSITORY_REQUEST_BYTES,
  } = await import('./codexhistory.js');
  const { commitRepositorySourceKey } = await import('./progressiveworker.js');
  const key = commitRepositorySourceKey;
  // A copy holds only the bytes of each buffer view, not the read chunk behind the view.
  const clone = (
    cursor: import('./codexhistory').CommitRepositoryCursor,
  ): import('./codexhistory').CommitRepositoryCursor => {
    const { fragment, queue, head, anchor, ...rest } = cursor;
    return {
      ...structuredClone(rest),
      fragment: Buffer.from(fragment),
      queue: Buffer.from(queue),
      head: Buffer.from(head),
      anchor: Buffer.from(anchor),
    };
  };
  const parent =
    commitParentCursor && key(commitParentCursor.source) === key(request.parent)
      ? clone(commitParentCursor)
      : createCommitRepositoryCursor(request.parent, null);
  // One entry serves each child file and parent pair. It resumes only for its token and the same child revision.
  const childKey = JSON.stringify([request.child.file, request.child.sessionId, request.parent.sessionId]);
  const held = commitChildCursors.get(childKey);
  const child =
    held && request.token === held.token && key(held.cursor.source) === key(request.child)
      ? clone(held.cursor)
      : createCommitRepositoryCursor(
          request.child,
          request.parent.sessionId,
          request.commits.flatMap((commit) => commit.dirs),
        );
  let status: import('./codexhistory').CommitRepositoryReply['status'] = 'pending';
  const charges = { parent: 0, child: 0 };
  if (
    isCompressedRollout(request.parent.file) ||
    isCompressedRollout(request.child.file) ||
    request.parserVersion !== COMMIT_REPOSITORY_PARSER_VERSION ||
    request.parentBytes + request.childBytes > COMMIT_REPOSITORY_REQUEST_BYTES ||
    request.parentBytes < 0 ||
    request.childBytes < 0
  )
    status = 'stale';
  else {
    const scanParent = parent.complete
      ? { status: 'complete' as const, readBytes: 0 }
      : request.parentBytes > 0
        ? await scanCommitRepositorySource(parent, request.parentBytes, signal)
        : { status: 'exhausted' as const, readBytes: 0 };
    charges.parent = scanParent.readBytes;
    const scanChild =
      request.childBytes > 0
        ? await scanCommitRepositorySource(child, request.childBytes, signal)
        : { status: 'exhausted' as const, readBytes: 0 };
    charges.child = scanChild.readBytes;
    status = signal.aborted
      ? 'cancelled'
      : [scanParent.status, scanChild.status].includes('stale')
        ? 'stale'
        : [scanParent.status, scanChild.status].includes('exhausted')
          ? 'exhausted'
          : parent.complete && child.complete
            ? 'complete'
            : 'pending';
  }
  if (!commitSourceRevision(request.parent) || !commitSourceRevision(request.child)) status = 'stale';
  const targets = status === 'complete' ? commitRepositoryTargets(parent, child, request.commits) : [];
  const token = status === 'pending' || status === 'complete' ? `${++commitCursorSequence}` : null;
  if (status === 'pending' || status === 'complete') commitParentCursor = parent;
  // A cancelled request keeps the entry, so the retry with the same token resumes where the last pending reply stopped.
  if (status !== 'cancelled') commitChildCursors.delete(childKey);
  if (status === 'pending' && token) {
    commitChildCursors.set(childKey, { cursor: clone(child), token });
    for (const oldest of commitChildCursors.keys()) {
      if (commitChildCursors.size <= COMMIT_CHILD_CURSORS) break;
      commitChildCursors.delete(oldest);
    }
  }
  return {
    kind: 'commit-repositories',
    status,
    token,
    parent: request.parent,
    child: request.child,
    parserVersion: request.parserVersion,
    readBytes: charges,
    covered: { parent: [0, parent.through], child: [0, child.through] },
    targets,
  };
}
// Read the recorded edits of the requested files from one child transcript, with the reader its summary figures use.
// Only the requested files' edits leave the worker. A changed revision before or after the read answers stale.
// Size and modification time cannot tell a replaced Codex record apart, so its opening record must name the requested thread,
// and any parent it names must be the requested parent, as `codexAgentSpendScan` requires of a catalog entry.
async function executeChildFileEdits(
  request: Extract<ProgressiveRequest, { kind: 'child-file-edits' }>,
  signal: AbortSignal,
): Promise<ProgressiveValue> {
  const { source } = request;
  const reply = (status: 'stale' | 'too-large' | 'unreadable' | 'cancelled') =>
    ({ kind: 'child-file-edits', status, source, files: [] }) as ProgressiveValue;
  const owned = (meta: import('./codex').CodexSessionMeta | null) =>
    source.agent !== 'codex' ||
    (!!meta &&
      meta.sessionId === source.threadId &&
      (meta.parentThreadId === null || meta.parentThreadId === source.parentThreadId));
  if (isCompressedRollout(source.file)) return reply('unreadable');
  const before = revisionOf(source.file);
  if (!before || spendFileVersion(source.file) !== source.revision) return reply('stale');
  if (before.size > CHILD_EDIT_READ_BYTES) return reply('too-large');
  const meta = source.agent === 'codex' ? readCodexSessionMeta(source.file) : null;
  const claude =
    source.agent === 'claude'
      ? createClaudeSessionReducer(path.basename(source.file, path.extname(source.file)), {
          childTranscript: true,
          folders: request.folders,
          maxTurns: Number.MAX_SAFE_INTEGER,
        })
      : null;
  const codex =
    source.agent === 'codex'
      ? createCodexSessionReducer(
          meta?.sessionId ?? path.basename(source.file, path.extname(source.file)),
          { maxTurns: Number.MAX_SAFE_INTEGER },
          meta,
        )
      : null;
  const repeated = createClaudeRepeatedFilter();
  // The opening record of the bytes this read reduced, which proves whose edits they are.
  let opening: string | null = null;
  const scan = scanLinesIncremental(source.file, (line) => {
    opening ??= line;
    if (claude) {
      if (!repeated(line)) claude.pushLine(line);
    } else codex?.pushLine(line);
  });
  // Yield between chunks so a cancel message can arrive during a long read.
  let next = scan.next();
  for (; !next.done; next = scan.next()) {
    await new Promise((resolve) => setImmediate(resolve));
    if (signal.aborted) {
      scan.return(false);
      return reply('cancelled');
    }
  }
  // The scan reports a failed read only through its completion value. Partial edits would pass for the whole record.
  if (!next.value) return reply('unreadable');
  if (!sameRevision(before, revisionOf(source.file)) || spendFileVersion(source.file) !== source.revision)
    return reply('stale');
  if (codex && !owned(openingRecordOf(opening))) return reply('stale');
  const turns = claude ? claude.finish().turns : codex!.finish(0).turns;
  const wanted = new Set(request.keys);
  const found = new Map<string, import('./progressiveworker').ChildFileEdits>();
  for (const turn of turns) {
    for (const file of turn.files) {
      const key = file.identity ?? normalizeFsPath(file.path);
      if (!wanted.has(key)) continue;
      const held = found.get(key) ?? { key, edits: [] };
      held.edits.push(...file.edits);
      if (turn.startedAt) held.startedAt = Math.min(held.startedAt ?? turn.startedAt, turn.startedAt);
      const end = turn.processEndedAt ?? turn.endedAt;
      if (end) held.endedAt = Math.max(held.endedAt ?? end, end);
      found.set(key, held);
    }
  }
  return { kind: 'child-file-edits', status: 'complete', source, files: [...found.values()] };
}

async function handleMessage(message: WorkerMessage): Promise<void> {
  if (message.cancel !== undefined) {
    requests.get(message.cancel)?.abort();
    return;
  }
  const controller = new AbortController();
  requests.set(message.id, controller);
  arrivalReleases.set(controller.signal, releaseSequence);
  const kind = message.request.kind === 'staged-claude' ? 'claude-children' : message.request.kind;
  for (const read of windowReads.values()) countKind(read.report.during.received, kind);
  if (kind === 'window' && windowReads.size < WINDOW_READS) {
    windowReads.set(message.id, {
      receivedAt: performance.now(),
      enteredAt: null,
      completedAt: null,
      report: {
        atReceipt: { ...activeKinds },
        discoveryWaiting: discovery.hasWaiting,
        during: { received: {}, finished: {}, discoveryProgress: 0, repeatedCoverage: 0 },
      },
    });
  }
  countKind(activeKinds, kind);
  let bodyEntered = false;
  try {
    let request: ProgressiveRequest;
    if (message.request.kind === 'staged-claude') {
      const sealed = sealedDiscovery;
      if (sealed?.id === message.id) sealedDiscovery = undefined;
      if (
        sealed?.id !== message.id ||
        sealed.generation !== message.generation ||
        olderCompressedScope(compressedStoresKey(sealed.stores), sealed.scope)
      ) {
        parentPort?.postMessage({ id: message.id });
        return;
      }
      request = {
        ...message.request,
        kind: 'claude-children',
        compressed: sealed.files,
        compressedMemberships: sealed.memberships,
        compressedInventory: sealed.inventory,
        compressedStores: sealed.stores,
        compressedRevision: sealed.revision,
        compressedScope: sealed.scope,
      };
    } else request = message.request;
    if (request.kind === 'child-file-edits') {
      const value = await executeChildFileEdits(request, controller.signal);
      if (!controller.signal.aborted)
        parentPort?.postMessage({ id: message.id, result: { generation: message.generation, revision: null, value } });
      return;
    }
    if (request.kind === 'commit-repositories') {
      const value = await executeCommitRepositories(request, controller.signal);
      if (!controller.signal.aborted)
        parentPort?.postMessage({
          id: message.id,
          result: { generation: message.generation, revision: request.parent.revision, value },
        });
      return;
    }
    if (
      request.kind === 'claude-children' ||
      request.kind === 'compressed-adopt' ||
      request.kind === 'compressed-load'
    ) {
      // A cancelled request keeps the receipt scan, so the next request resumes it where this one stopped.
      const value = await execute(request, controller.signal, (value) => {
        noteBackground('discoveryProgress');
        if (!controller.signal.aborted)
          parentPort?.postMessage({
            id: message.id,
            progress: true,
            result: { generation: message.generation, revision: null, value, workerMemory: workerMemory() },
          });
      });
      // A discovery slice can acknowledge its list. A cancelled request commits no list.
      if (
        !controller.signal.aborted &&
        request.kind === 'claude-children' &&
        (value.kind === 'claude-children' ||
          value.kind === 'claude-children-progress' ||
          value.kind === 'claude-children-delta') &&
        request.compressed &&
        request.compressedStores
      )
        value.compressedNames = acceptCompressedNames(
          request.compressed,
          request.compressedRevision,
          request.compressedScope,
          request.compressedStores,
          request.compressedMemberships,
          undefined,
          request.compressedInventory,
        );
      if (!controller.signal.aborted) {
        if (request.kind === 'claude-children') discovery.noteReply(value);
        parentPort?.postMessage({
          id: message.id,
          result: { generation: message.generation, revision: null, value, workerMemory: workerMemory() },
        });
      }
      return;
    }
    const file = 'session' in request ? request.session.file : request.input.session.file;
    const requested = 'session' in request ? request.session : request.input.session;
    const before = revisionOf(file);
    if (!before) {
      if (request.kind === 'metadata-recovery' && metadataRecovery?.sessionId === requested.sessionId) {
        metadataRecovery = null;
      }
      parentPort?.postMessage({
        id: message.id,
        result: {
          generation: message.generation,
          revision: before,
          value: { kind: 'stale', unread: true },
        },
        windowRead: windowReadReport(message.id),
      });
      return;
    }
    // Read catalog metadata against the revision present when the worker starts.
    // An active session can append after listing.
    // History windows and pages require the exact requested revision.
    const metadataRequest =
      request.kind === 'metadata' ? { ...request, session: { ...request.session, ...before } } : null;
    if (
      (!metadataRequest || requested.agent === 'agy') &&
      (before.size !== requested.size ||
        before.mtimeMs !== requested.mtimeMs ||
        ('dev' in requested && requested.dev !== before.dev) ||
        ('ino' in requested && requested.ino !== before.ino))
    ) {
      if (request.kind === 'metadata-recovery' && metadataRecovery?.sessionId === requested.sessionId) {
        metadataRecovery = null;
      }
      parentPort?.postMessage({
        id: message.id,
        result: {
          generation: message.generation,
          revision: before,
          value: { kind: 'stale', unread: true },
        },
        windowRead: windowReadReport(message.id),
      });
      return;
    }
    const read = windowReads.get(message.id);
    if (read) read.enteredAt = performance.now();
    // Every window read signals its start, including one past the lifecycle bound.
    if (kind === 'window') parentPort?.postMessage({ id: message.id, windowEntered: true });
    // A window or page of a compressed rollout reads one body, so it waits while requests read another path.
    const bodyRead = (kind === 'window' || kind === 'page') && isCompressedRollout(file);
    if (bodyRead && !(await enterBodyPath(file, controller.signal))) return;
    bodyEntered = bodyRead;
    const value = await execute(metadataRequest ?? request, controller.signal);
    if (read) read.completedAt = performance.now();
    const after = revisionOf(file);
    const stable = sameRevision(before, after);
    // A compressed window compares its checkpoint with `before` at the held length of the body that it read from
    // `before`.
    const requestBody = requestBodies.get(controller.signal);
    const released = requestBody !== undefined && requestBody.releases !== bodyReleases;
    const body = released ? undefined : requestBody?.body;
    const windowRevision = !isCompressedRollout(file)
      ? before
      : body?.file === file && sameRevision(body.stat, before)
        ? { ...before, size: body.length }
        : null;
    const stableWindow = value.kind !== 'window' || sameRevision(value.checkpoint.revision, windowRevision);
    const kept = stable ? undefined : scanKeptThroughGrowth(value, before, after);
    const metadataPrefix = value.kind === 'metadata' && after && after.size > before.size && onlyGrew(before, after);
    const result: ProgressiveResult = {
      generation: message.generation,
      revision: metadataPrefix ? before : after,
      value:
        (stable && stableWindow) || metadataPrefix
          ? value
          : kept
            ? {
                kind: 'stale',
                agentRunScan: kept,
                recoveryBytes: 'recoveryBytes' in value ? value.recoveryBytes : undefined,
              }
            : {
                kind: 'stale',
                recoveryBytes: 'recoveryBytes' in value ? value.recoveryBytes : undefined,
                // A window whose own body the host released reads again like a stopped decode.
                ...(released && value.kind === 'window' ? { interrupted: true as const } : {}),
              },
    };
    if (!controller.signal.aborted) {
      if (request.kind === 'metadata-recovery' && result.value.kind === 'stale') metadataRecovery = null;
      parentPort?.postMessage({
        id: message.id,
        result,
        hidden: {
          turns: progressiveTurns(result.value).map(hiddenTurnFields),
          redefinesDetail: requested.agent === 'codex',
        },
        windowRead: windowReadReport(message.id),
      });
    }
  } catch (error) {
    if (
      message.request.kind === 'metadata-recovery' &&
      metadataRecovery?.sessionId === message.request.session.sessionId
    ) {
      metadataRecovery = null;
    }
    if (!controller.signal.aborted)
      parentPort?.postMessage({
        id: message.id,
        error: workerErrorIdentity(error),
        windowRead: windowReadReport(message.id),
      });
  } finally {
    // A yield that arrives before a discovery request starts holds for that request. One that arrives after the request it
    // asked for costs the next request one early reply.
    if (kind === 'claude-children') discoveryYield = false;
    if (bodyEntered) leaveBodyPath();
    requests.delete(message.id);
    windowReads.delete(message.id);
    if (activeKinds[kind]! > 1) activeKinds[kind]!--;
    else delete activeKinds[kind];
    for (const read of windowReads.values()) countKind(read.report.during.finished, kind);
  }
}

type WorkerMessage = {
  id: number;
  generation: number;
  request: ProgressiveWireRequest;
  cancel?: number;
  metadataEligible?: string[];
};
const discovery = new DiscoveryQueue<WorkerMessage>({
  execute: handleMessage,
  drop: (message) => parentPort?.postMessage({ id: message.id }),
  backfills: () => compressedBackfills.values(),
});
// Bounded reads skip the records that the repeated-record map does not reach yet, and request background
// completion of the map. When a map reaches the end of its file, the host reads that file again and draws once.
onClaudeRepeatedCoverage((file) => {
  // A covered map gives an unchanged file the same activity answer again. Settled facts read without
  // one read their activity again, and other facts read again whole.
  const held = dispatchFacts.get(file);
  if (held?.settled && held.activity) held.activityStale ||= !held.activity.covered;
  else dispatchFacts.delete(file);
  noteBackground('repeatedCoverage');
  parentPort?.postMessage({ repeatedCoverage: file });
});
parentPort?.on(
  'message',
  (message: {
    id: number;
    generation: number;
    request: ProgressiveWireRequest;
    cancel?: number;
    metadataEligible?: string[];
    dispatchSpendEntries?: Array<[string, CodexDispatchSpendEntry]>;
    repeated?: { file: string; map: ClaudeRepeatedHeldMap };
    releaseBody?: string;
    releaseStores?: boolean;
    compressedDecodeAck?: number;
    compressedSpendReply?: { id: number; entry: import('./compressedstore').CompressedFactEntry | null };
    yieldDiscovery?: boolean;
    discardCompressedTransfer?: CompressedTransferCancellation;
    confirmCompressedMemberships?: {
      stores: CompressedStorePaths;
      scope: number;
      checks: import('./compressedrollouts').CompressedMembershipAcknowledgment[];
    };
  }) => {
    if (message.yieldDiscovery) {
      discoveryYield = true;
      return;
    }
    if (message.compressedSpendReply) {
      const { id, entry } = message.compressedSpendReply;
      compressedSpendRequests.get(id)?.(entry);
      return;
    }
    if (message.compressedDecodeAck !== undefined) {
      compressedDecodeAcks.get(message.compressedDecodeAck)?.();
      compressedDecodeAcks.delete(message.compressedDecodeAck);
      return;
    }
    if (message.dispatchSpendEntries) {
      for (const [file, entry] of message.dispatchSpendEntries) retainCodexDispatchSpend(file, entry);
      return;
    }
    if (message.confirmCompressedMemberships) {
      const { stores, scope, checks } = message.confirmCompressedMemberships;
      compressedBackfills.get(compressedStoresKey(stores))?.confirmMemberships(scope, checks);
      return;
    }
    if (message.discardCompressedTransfer) {
      const { stores, scope, purpose, id } = message.discardCompressedTransfer;
      const key = compressedStoresKey(stores);
      if (
        purpose === 'discovery' &&
        sealedDiscovery?.id === id &&
        sealedDiscovery.scope === scope &&
        compressedStoresKey(sealedDiscovery.stores) === key
      )
        sealedDiscovery = undefined;
      const pending = compressedTransfers.get(compressedTransferKey(key, purpose));
      if (pending?.id === id && pending.scope === scope) {
        pending.parts = undefined;
        pending.committed = undefined;
      }
      return;
    }
    if (message.releaseStores) {
      for (const settle of compressedSpendRequests.values()) settle();
      for (const holder of compressedHolders.values()) holder.dispose();
      compressedHolders.clear();
      compressedFollowers.clear();
      for (const backfill of compressedBackfills.values()) backfill.dispose();
      compressedBackfills.clear();
      compressedNames.clear();
      compressedTransfers.clear();
      sealedDiscovery = undefined;
      compressedRequesters = null;
      discoveryCompressedStores = undefined;
      parentPort?.postMessage({ storesReleased: true });
      return;
    }
    if (message.releaseBody) {
      releaseHostBody(message.releaseBody);
      return;
    }
    if (message.repeated) adoptClaudeRepeatedMap(message.repeated.file, message.repeated.map);
    if (message.metadataEligible) {
      if (metadataRecovery && !message.metadataEligible.includes(metadataRecovery.sessionId)) metadataRecovery = null;
      return;
    }
    if (message.cancel !== undefined) {
      discovery.cancel(message.cancel);
      void handleMessage({ ...message });
      return;
    }
    if (message.request.kind === 'claude-children' || message.request.kind === 'staged-claude') {
      if (discovery.busy) discoveryYield = true;
      discovery.submit(message);
      return;
    }
    void handleMessage(message);
  },
);
