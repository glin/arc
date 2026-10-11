import { meterRead, meterReadWork, readPhase } from './readmeter';
import * as fs from 'node:fs/promises';
import type { Dir } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  projectsRoot,
  normalizeFsPath,
  scanClaudeRelationshipQuantum,
  claudeSubagentMetaOf,
  createClaudeUsageLineReducer,
  readSessionCwd,
  type ClaudeRelationshipCursor,
  type ClaudeUsageReducerState,
  type AgentKind,
  type SessionFile,
  type Turn,
  type Compaction,
  type TurnUsage,
  type ClaudeChildSessionReference,
  normalizeSessionTitle,
  cleanPrompt,
} from './transcript';
import {
  codexSessionsRoot,
  openingRecordOf,
  structuralAgentStatus,
  isHiddenThread,
  scanCodexDispatchReferencesAsync,
  createCodexUsageLineReducer,
  readThreadNames,
  codexTitleFor,
  readCodexSessionTitlePair,
  type CodexDispatchCursor,
  type CodexSessionMeta,
} from './codex';
import { readClaudeHistoryPageAsync, type ClaudeHistoryCursor } from './claudehistory';
import { readCodexHistoryPageAsync, type CodexHistoryCursor } from './codexhistory';
import type { SemanticHistoryResult, SemanticHistoryPage } from './history';
import { EXPORT_LIMITS, ExportLimitError } from './exportlimits';
import { checkExportCancellation, type ExportTransaction } from './exportwriter';
import { sessionParentIndex } from './turnrail';
import { sessionCostProjection, sessionCostUsageOf, type SessionCostUsage } from './turncard';
import {
  indexSpendFile,
  sessionSpendPartsBySession,
  claudeCostStateDependencies,
  withDispatchedSpendSources,
  type SpendFileIndex,
  type SessionSpendSource,
  type SessionSpendCoverage,
  type UsageLineReducer,
} from './projectspend';
import { reconcileClaudeCostState, type ClaudeCostProgress } from './claudecoststate';
import { recordedCostBasis } from './pricing';

export type ExportLimits = { [K in keyof typeof EXPORT_LIMITS]: number };
export type {
  ExportIdentity,
  ExportReaderLink,
  ExportOmissionReason,
  ExportOmission,
  ExportRelationship,
  ExportUsage,
  ExportCostPart,
  ExportCost,
  ExportNumbers,
  ExportBlock,
  ExportTurn,
  ExportCompaction,
  ExportPage,
  ExportSession,
  SessionExport,
} from './domain/export-model';
import type {
  ExportIdentity,
  ExportReaderLink,
  ExportOmissionReason,
  ExportOmission,
  ExportRelationship,
  ExportUsage,
  ExportCostPart,
  ExportNumbers,
  ExportBlock,
  ExportTurn,
  ExportCompaction,
  ExportSession,
  SessionExport,
} from './domain/export-model';
export interface ExportCaptureOptions {
  root: SessionFile & { parentSessionId?: string };
  roots?: { claude?: string; codex?: string };
  readerLinks?: readonly ExportReaderLink[];
  readerParents?: Readonly<Record<string, string>>;
  capturedAt?: number;
  signal?: AbortSignal;
  limits?: Partial<ExportLimits>;
  progress?: (
    phase: 'inventory' | 'relationships' | 'text' | 'numbers' | 'checking',
    sessions: number,
    work?: ExportProgress,
  ) => void;
  diagnostics?: (metrics: import('./readmeter').ReadMetrics) => void;
}
export interface ExportProgress {
  discovered: number;
  completed: number;
  bytes: number;
}
export interface ExportCapture {
  model: SessionExport;
  recheck: () => Promise<void>;
}

interface Stamp {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
interface Entry extends SessionFile {
  parentSessionId?: string;
  opening?: CodexSessionMeta | null;
  openingHash?: string;
  stamp: Stamp;
  qualified?: string;
  launchIds?: string[];
}
interface Inventory {
  entries: Entry[];
  partial: boolean;
  signature: string;
  issues: ExportOmissionReason[];
  paths: number;
  bytes: number;
}
interface FrozenSource {
  file: string;
  stamp: Stamp;
  digest: string;
}
class SourceChanged extends Error {
  constructor() {
    super('The session changed during export.');
  }
}
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const stampOf = (stat: Stamp): Stamp => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});
const sameStamp = (a: Stamp, b: Stamp) => JSON.stringify(stampOf(a)) === JSON.stringify(stampOf(b));
const identityKey = (entry: ExportIdentity) =>
  `${entry.agent}:${entry.parentSessionId ?? ''}:${entry.sessionId.toLowerCase()}`;
const entryKey = (entry: Entry) => entry.qualified ?? identityKey(entry);

async function fileEntry(agent: AgentKind, file: string, sessionId: string, parentSessionId?: string): Promise<Entry> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The session file is unavailable.');
  return {
    agent,
    file,
    sessionId,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
    stamp: stampOf(stat),
    ...(parentSessionId ? { parentSessionId, childTranscript: true } : {}),
  };
}

async function openingOf(
  file: string,
  limits: ExportLimits,
  signal?: AbortSignal,
): Promise<{ text: string; digest: string }> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(limits.sliceBytes, 4096));
    const fragments: Buffer[] = [];
    let length = 0;
    for (let offset = 0; ;) {
      checkExportCancellation(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      meterRead(file, bytesRead, offset);
      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      const used = newline < 0 ? bytesRead : newline;
      if (length + used > limits.recordBytes) throw new ExportLimitError('record', limits.recordBytes);
      if (used) fragments.push(Buffer.from(buffer.subarray(0, used)));
      length += used;
      offset += bytesRead;
      if (newline >= 0 || !bytesRead) break;
    }
    const bytes = Buffer.concat(fragments, length);
    return { text: bytes.toString('utf8'), digest: hash(bytes) };
  } finally {
    await handle.close();
  }
}

async function sourceDigest(entry: Entry, limits: ExportLimits, signal?: AbortSignal): Promise<FrozenSource> {
  checkExportCancellation(signal);
  const before = await fs.lstat(entry.file);
  if (!before.isFile() || before.isSymbolicLink() || !sameStamp(before, entry.stamp)) throw new SourceChanged();
  const handle = await fs.open(entry.file, 'r');
  try {
    if (!sameStamp(await handle.stat(), before)) throw new SourceChanged();
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(limits.sliceBytes);
    for (let at = 0; at < before.size;) {
      checkExportCancellation(signal);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - at), at);
      meterRead(entry.file, bytesRead, at);
      if (!bytesRead) throw new SourceChanged();
      digest.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
    if (!sameStamp(await handle.stat(), before) || !sameStamp(await fs.lstat(entry.file), before))
      throw new SourceChanged();
    return { file: entry.file, stamp: stampOf(before), digest: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** Inventory metadata establishes identity only. Unreachable text bodies stay unread. */
async function inventoryOf(options: ExportCaptureOptions, limits: ExportLimits): Promise<Inventory> {
  const inventory: Inventory = { entries: [], partial: false, signature: '', issues: [], paths: 0, bytes: 0 };
  const identities: string[] = [];
  const candidates: { agent: AgentKind; file: string; name: string }[] = [];
  const issue = (reason: ExportOmissionReason) => {
    inventory.partial = true;
    if (!inventory.issues.includes(reason)) inventory.issues.push(reason);
  };
  const charge = (value: string): boolean => {
    const bytes = Buffer.byteLength(value);
    if (inventory.paths + 1 > limits.inventoryPaths || inventory.bytes + bytes > limits.inventoryBytes) {
      issue('inventory-incomplete');
      return false;
    }
    inventory.paths++;
    inventory.bytes += bytes;
    return true;
  };
  const walk = async (directory: string, agent: AgentKind, depth: number): Promise<void> => {
    checkExportCancellation(options.signal);
    let stream: Dir;
    try {
      stream = await fs.opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue('unreadable');
      return;
    }
    for await (const child of stream) {
      checkExportCancellation(options.signal);
      const file = path.join(directory, child.name);
      if (!charge(normalizeFsPath(file))) break;
      if (child.isSymbolicLink()) {
        issue('unsupported');
        continue;
      }
      if (child.isDirectory()) {
        if (depth > 0) await walk(file, agent, depth - 1);
        continue;
      }
      if (!child.isFile() || !child.name.endsWith('.jsonl')) continue;
      candidates.push({ agent, file, name: child.name });
    }
  };
  await walk(options.roots?.claude ?? projectsRoot(), 'claude', 1);
  await walk(options.roots?.codex ?? codexSessionsRoot(), 'codex', 3);
  const results: Array<{ entry?: Entry; metadata: string; reason?: ExportOmissionReason }> = [];
  let next = 0;
  // Metadata reads share a bounded worker pool. Results retain inventory order for admission.
  await Promise.all(
    Array.from({ length: Math.min(16, candidates.length) }, async () => {
      while (next < candidates.length) {
        checkExportCancellation(options.signal);
        const index = next++;
        const { agent, file, name } = candidates[index];
        try {
          let entry = await fileEntry(agent, file, name.slice(0, -6));
          if (agent === 'codex') {
            const opening = await openingOf(file, limits, options.signal);
            const meta = openingRecordOf(opening.text);
            if (!meta?.sessionId) {
              results[index] = { metadata: '', reason: 'unresolved' };
              continue;
            }
            entry = {
              ...entry,
              sessionId: meta.sessionId,
              ...(meta.cwd ? { cwd: meta.cwd } : {}),
              opening: meta,
              openingHash: opening.digest,
            };
          } else {
            const readable = await fs.open(file, 'r');
            await readable.close();
          }
          results[index] = {
            entry,
            metadata: JSON.stringify({
              key: entryKey(entry),
              file: normalizeFsPath(file),
              identity: { dev: entry.stamp.dev, ino: entry.stamp.ino },
              opening: entry.openingHash ?? null,
            }),
          };
        } catch (error) {
          if (options.signal?.aborted || error instanceof ExportLimitError) throw error;
          results[index] = {
            metadata: JSON.stringify({ agent, file: normalizeFsPath(file), unavailable: true }),
            reason: 'unreadable',
          };
        }
      }
    }),
  );
  for (const result of results) {
    if (result.reason) issue(result.reason);
    if (inventory.bytes + Buffer.byteLength(result.metadata) > limits.inventoryBytes) {
      issue('inventory-incomplete');
      break;
    }
    inventory.bytes += Buffer.byteLength(result.metadata);
    if (result.metadata) identities.push(result.metadata);
    if (result.entry) inventory.entries.push(result.entry);
  }
  inventory.signature = hash(
    JSON.stringify({
      identities: identities.sort(),
      issues: inventory.issues.sort(),
      paths: inventory.paths,
      bytes: inventory.bytes,
    }),
  );
  return inventory;
}

function usageOf(usage: TurnUsage): ExportUsage {
  if (
    !(usage.requests && usage.requests > 0) &&
    ![
      usage.input,
      usage.cacheRead,
      usage.cacheWrite1h,
      usage.cacheWrite5m,
      usage.cacheWrite30m ?? 0,
      usage.output,
    ].some((value) => value > 0)
  )
    return {
      requests: null,
      input: null,
      cacheRead: null,
      cacheWrite1h: null,
      cacheWrite5m: null,
      cacheWrite30m: null,
      output: null,
      thinking: null,
    };
  return {
    requests: usage.requests ?? null,
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite1h: usage.cacheWrite1h,
    cacheWrite5m: usage.cacheWrite5m,
    cacheWrite30m: usage.cacheWrite30m ?? 0,
    output: usage.output,
    thinking: usage.thinking,
  };
}
export function costPartOf(part: SessionCostUsage, scope: string | null = null): ExportCostPart {
  return {
    role: part.role ?? 'main',
    scope:
      scope ??
      (part.linkedInvocationId
        ? `invocation:${part.linkedInvocationId}`
        : part.scopeId?.startsWith('invocation:')
          ? part.scopeId
          : null),
    model: part.model,
    provider: part.provider,
    contextWindow: part.contextWindow,
    contextBand: part.contextBand ?? null,
    inferenceClass: part.inferenceClass ?? null,
    serviceTier: part.serviceTier ?? null,
    recordedCost: part.recordedCost ?? null,
    costBasis: part.costBasis ?? null,
    unclassifiedCacheWrite: part.unclassifiedCacheWrite ?? 0,
    incomplete: part.incomplete === true,
    requestCountExact: part.requestCountExact !== false && part.usage.requests !== undefined,
    estimated: part.compactionEstimate === true,
    ...(part.compactionUsage ? { compactionUsage: true as const } : {}),
    origin: part.usageOrigin ?? 'recorded',
    usage: usageOf(part.usage),
  };
}
export function costPartsOf(part: SessionCostUsage, scope: string | null = null): ExportCostPart[] {
  const bands = part.usage.byContextBand;
  if (!bands || part.contextBand || (recordedCostBasis(part.costBasis) && part.recordedCost !== undefined))
    return [costPartOf(part, scope)];
  const counts = [
    'requests',
    'input',
    'cacheRead',
    'cacheWrite1h',
    'cacheWrite5m',
    'cacheWrite30m',
    'output',
    'thinking',
  ] as const;
  if (!counts.every((key) => (part.usage[key] ?? 0) === (bands.short?.[key] ?? 0) + (bands.long?.[key] ?? 0)))
    return [costPartOf(part, scope)];
  return (['short', 'long'] as const).flatMap((contextBand) =>
    bands[contextBand] ? [costPartOf({ ...part, contextBand, usage: bands[contextBand] }, scope)] : [],
  );
}
function blocksOf(turn: Turn, key: string): ExportBlock[] {
  const entries: Array<Omit<ExportBlock, 'key'> & { sequence: number }> = [];
  const add = (
    kind: ExportBlock['kind'],
    text: string,
    at: number,
    order?: number,
    notResponse?: ExportBlock['notResponse'],
    opening?: boolean,
  ) => {
    if (text)
      entries.push({
        kind,
        text,
        at,
        sourceOrder: order ?? null,
        notResponse: notResponse ?? null,
        ...(opening === undefined ? {} : { opening }),
        sequence: entries.length,
      });
  };
  if (turn.delegation) add('assignment', turn.delegation.text, turn.startedAt, -1);
  if (turn.promptParts?.length)
    for (const part of turn.promptParts) add('prompt', part.text, part.at, part.sourceOrder, undefined, true);
  else add('prompt', turn.prompt, turn.startedAt, -1, undefined, true);
  for (const part of turn.laterPrompts) add('prompt', part.text, part.at, part.sourceOrder, undefined, false);
  const answers = turn.agent === 'claude' ? (turn.recordedAnswers ?? turn.answers) : turn.answers;
  for (const answer of answers) add('answer', answer.text, answer.at, answer.sourceOrder, answer.notResponse);
  if (turn.agent !== 'claude' && turn.summary && !answers.some((answer) => answer.text === turn.summary))
    add('answer', turn.summary, turn.endedAt);
  for (const update of turn.updates)
    if (update.kind === 'commentary') add('commentary', update.text, update.at, update.sourceOrder);
  entries.sort((a, b) => {
    if (a.sourceOrder !== null && b.sourceOrder !== null)
      return a.sourceOrder - b.sourceOrder || a.sequence - b.sequence;
    return a.at - b.at || a.sequence - b.sequence;
  });
  return entries.map(({ sequence: _sequence, ...block }, index) => ({ key: `${key}-b${index + 1}`, ...block }));
}

function relativeFile(file: string, cwd: string | undefined): string | null {
  const normalized = file.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || normalized.startsWith('//');
  let relative = normalized;
  if (absolute) {
    if (!cwd) return null;
    const base = normalizeFsPath(cwd).replace(/\/$/, '');
    const canonical = normalizeFsPath(normalized);
    if (!canonical.startsWith(`${base}/`)) return null;
    relative = normalized.slice(base.length + 1);
  }
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '..') || /^[a-z]:/i.test(relative)) return null;
  return segments.filter((segment) => segment !== '.' && segment !== '').join('/') || null;
}

export function projectTurn(
  turn: Turn,
  key: string,
  entry: Pick<SessionFile, 'cwd'>,
  omissions: ExportOmission[],
  session: string,
  links: Map<string, string[]>,
): ExportTurn {
  let changes: ExportTurn['changes'] =
    turn.commitIntents?.length || turn.landingIntents?.length ? 'partial' : 'complete';
  const files: ExportTurn['files'] = [];
  for (const file of turn.files) {
    const relative = relativeFile(file.path, entry.cwd);
    if (!relative) {
      changes = 'partial';
      if (!omissions.some((omission) => omission.session === session && omission.reason === 'external-path'))
        omissions.push({ session, relationship: null, reason: 'external-path' });
      continue;
    }
    if (file.countsUnknown) changes = 'partial';
    files.push({
      path: relative,
      added: file.countsUnknown ? null : file.added,
      removed: file.countsUnknown ? null : file.removed,
      isNew: file.isNew,
      reason: file.unknownReason ?? null,
    });
  }
  return {
    key,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    finished: turn.finished,
    interrupted: turn.interrupted,
    model: turn.model,
    provider: turn.provider ?? null,
    effort: turn.effort,
    blocks: blocksOf(turn, key),
    usage: usageOf(turn.usage),
    relationships: [
      ...new Set(
        [...turn.agents.map((agent) => agent.toolUseId), ...(turn.dispatchToolUseIds ?? [])].flatMap((id) =>
          id ? (links.get(id) ?? []) : [],
        ),
      ),
    ],
    usageParts: (turn.usageParts ?? []).flatMap((part) => costPartsOf(part)),
    context: {
      tokens: turn.contextTokens > 0 ? turn.contextTokens : null,
      window: turn.contextWindow,
      request: turn.contextRequest
        ? {
            at: turn.contextRequest.at,
            lifetime: turn.contextRequest.lifetime,
            inferenceClass: turn.contextRequest.inferenceClass,
            serviceTier: turn.contextRequest.serviceTier,
            readBack: turn.contextRequest.readBack,
            outputTokens: turn.contextRequest.outputTokens,
            effort: turn.contextRequest.effort ?? null,
            bedrock: turn.contextRequest.bedrock === true,
          }
        : null,
    },
    outputRate: turn.outputRate ? { output: turn.outputRate.output, milliseconds: turn.outputRate.milliseconds } : null,
    error: turn.error,
    activity: {
      calls: turn.toolUses,
      failures: turn.failedOrdinals.length,
      categories: turn.stepKinds.filter((kind) => kind !== 'reasoning'),
      counts: {
        edits: turn.toolCounts.edits,
        reads: turn.toolCounts.reads,
        searches: turn.toolCounts.searches,
        commands: turn.toolCounts.commands,
        agents: turn.toolCounts.agents,
        coordination: turn.toolCounts.coordination,
        web: turn.toolCounts.web,
        other: turn.toolCounts.other,
      },
    },
    agents: turn.agents.map((agent, index) => ({
      relationships: agent.toolUseId ? (links.get(agent.toolUseId) ?? []) : [],
      spend: agent.spend.flatMap((part) => {
        const parts =
          part.usageParts?.length && !(recordedCostBasis(part.costBasis) && part.recordedCost !== undefined)
            ? part.usageParts
            : [part];
        return parts.flatMap((usagePart) =>
          costPartsOf({
            ...usagePart,
            provider: usagePart.provider ?? null,
            contextWindow: usagePart.contextWindow ?? null,
            role: 'delegated',
          }),
        );
      }),
      spendFound: agent.spendFound,
      key: `${key}-a${index + 1}`,
      description: agent.description,
      agentType: agent.agentType,
      model: agent.model,
      effort: agent.effort,
      status: agent.status,
      startedAt: agent.startedAt ?? null,
      durationMs: agent.durationMs,
      tokens: agent.tokens,
      toolUses: agent.toolUses,
      partial: agent.spendPartial || !agent.spendFound,
    })),
    files,
    commits: turn.commits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      at: commit.at,
      files: commit.files,
      added: commit.added,
      removed: commit.removed,
    })),
    changes,
  };
}
export function projectCompaction(compaction: Compaction, key: string): ExportCompaction {
  const previous = compaction.previousRequest;
  return {
    key,
    at: compaction.at,
    summary: compaction.summary,
    trigger: compaction.trigger,
    model: compaction.model,
    provider: compaction.provider ?? null,
    contextBefore: compaction.contextBefore || null,
    contextAfter: compaction.contextAfter || null,
    droppedTokens: compaction.droppedTokens || null,
    durationMs: compaction.durationMs || null,
    usage: compaction.usage ? usageOf(compaction.usage) : null,
    previousRequest: previous
      ? {
          tokens: previous.tokens,
          cacheRead: previous.cacheRead ?? null,
          cacheWrite: previous.cacheWrite ?? null,
          at: previous.at,
          lifetime: previous.lifetime,
          inferenceClass: previous.inferenceClass ?? null,
          serviceTier: previous.serviceTier ?? null,
        }
      : null,
    summaryChars: compaction.summaryChars ?? null,
    postCompactionCacheRead: compaction.postCompactionCacheRead ?? null,
    retainedContext: compaction.retainedContext
      ? { tokens: compaction.retainedContext.tokens, window: compaction.retainedContext.window }
      : null,
    contextWindow: compaction.contextWindow ?? null,
    inferenceClass: compaction.inferenceClass ?? null,
    serviceTier: compaction.serviceTier ?? null,
  };
}

async function referencesOf(
  entry: Entry,
  options: ExportCaptureOptions,
  limits: ExportLimits,
  progress: (bytes: number) => void,
): Promise<{ references: ClaudeChildSessionReference[]; complete: boolean; source: FrozenSource }> {
  const before = await fs.lstat(entry.file);
  if (!before.isFile() || before.isSymbolicLink() || !sameStamp(before, entry.stamp)) throw new SourceChanged();
  const digest = createHash('sha256');
  let through = 0;
  const meter = {
    readBytes: 0,
    size: entry.stamp.size,
    onRead(bytes: Buffer, offset: number) {
      if (offset !== through) throw new SourceChanged();
      digest.update(bytes);
      through += bytes.length;
    },
  };
  const check = async () => {
    checkExportCancellation(options.signal);
    if (!sameStamp(await fs.lstat(entry.file), before)) throw new SourceChanged();
    progress(through);
  };
  const source = (): FrozenSource => {
    if (through !== entry.stamp.size) throw new SourceChanged();
    return { file: entry.file, stamp: entry.stamp, digest: digest.digest('hex') };
  };
  const policy = {
    recordBytes: limits.recordBytes,
    dispatchIdentities: limits.dispatchIdentities,
    relationships: limits.relationships,
  };
  if (entry.agent === 'claude') {
    let cursor: ClaudeRelationshipCursor | undefined;
    for (;;) {
      checkExportCancellation(options.signal);
      const offset = cursor?.offset;
      const applied = cursor?.applied;
      const validation = cursor?.evidence?.validation?.digest.offset;
      const result = await scanClaudeRelationshipQuantum(
        entry,
        cursor,
        limits.sliceBytes,
        options.signal,
        meter,
        policy,
      );
      await check();
      if (result.reset && cursor) throw new SourceChanged();
      if (result.complete) return { references: result.references, complete: result.qualified, source: source() };
      if (
        cursor &&
        result.cursor.offset === offset &&
        result.cursor.applied === applied &&
        result.cursor.evidence?.validation?.digest.offset === validation
      )
        throw new SourceChanged();
      cursor = result.cursor;
    }
  }
  let cursor: CodexDispatchCursor | null = null;
  for (;;) {
    checkExportCancellation(options.signal);
    const result = await scanCodexDispatchReferencesAsync(
      entry.file,
      entry.sessionId,
      cursor,
      limits.sliceBytes,
      () => options.signal?.aborted === true,
      meter,
      policy,
    );
    await check();
    if (result.reset && cursor) throw new SourceChanged();
    if (result.traversed)
      return { references: result.references, complete: result.complete && result.qualified, source: source() };
    await pause();
    checkExportCancellation(options.signal);
    if (cursor && result.readBytes === 0 && result.cursor.offset === cursor.offset)
      throw new Error('The session ends with incomplete saved data.');
    cursor = result.cursor;
  }
}

async function nativeClaudeChildren(
  entry: Entry,
  options: ExportCaptureOptions,
  limits: ExportLimits,
  inventory: Inventory,
  metadata: Map<string, FrozenSource>,
  directories: Map<string, string>,
): Promise<{
  children: Entry[];
  missing: { identity: string; reason: ExportOmissionReason; evidence: string }[];
  partial: boolean;
}> {
  const directory = entry.childTranscript
    ? path.dirname(entry.file)
    : path.join(path.dirname(entry.file), entry.sessionId, 'subagents');
  const launcher = entry.childTranscript ? path.basename(entry.file, '.jsonl').replace(/^agent-/, '') : null;
  const children: Entry[] = [];
  const missing: { identity: string; reason: ExportOmissionReason; evidence: string }[] = [];
  const names: string[] = [];
  let partial = false;
  let stream: Dir;
  try {
    stream = await fs.opendir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') partial = true;
    directories.set(directory, partial ? 'partial' : 'missing');
    return { children, missing, partial };
  }
  for await (const child of stream) {
    checkExportCancellation(options.signal);
    if (inventory.paths + 1 > limits.inventoryPaths) {
      inventory.partial = partial = true;
      break;
    }
    inventory.paths++;
    names.push(child.name);
    const match = /^agent-([a-zA-Z0-9-]+)\.meta\.json$/.exec(child.name);
    if (!match) continue;
    const file = path.join(directory, child.name);
    try {
      const metaEntry = await fileEntry('claude', file, match[1]);
      if (metaEntry.size > limits.recordBytes) throw new ExportLimitError('record', limits.recordBytes);
      const frozen = await sourceDigest(metaEntry, limits, options.signal);
      const { text } = await openingOf(file, limits, options.signal);
      if (inventory.bytes + Buffer.byteLength(text) > limits.inventoryBytes) {
        inventory.partial = partial = true;
        break;
      }
      inventory.bytes += Buffer.byteLength(text);
      metadata.set(file, frozen);
      const meta = claudeSubagentMetaOf(text, match[1], path.join(directory, `agent-${match[1]}.jsonl`));
      if (!meta) {
        partial = true;
        continue;
      }
      if (meta.parentAgentId !== launcher) continue;
      let target: Entry;
      try {
        target = await fileEntry('claude', meta.file, meta.id, entry.sessionId);
      } catch (error) {
        missing.push({
          identity: meta.id,
          reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
          evidence: meta.toolUseId ?? `native-${meta.id}`,
        });
        partial = true;
        continue;
      }
      target.qualified = `${entry.qualified?.split('/')[0] ?? entryKey(entry)}/${meta.id}`;
      target.launchIds = meta.toolUseId ? [meta.toolUseId] : [];
      children.push(target);
      if (children.length > limits.relationships) throw new ExportLimitError('relationships', limits.relationships);
    } catch (error) {
      if (options.signal?.aborted || error instanceof ExportLimitError) throw error;
      partial = true;
    }
  }
  directories.set(directory, inventory.partial ? 'partial' : hash(JSON.stringify(names.sort())));
  return { children, missing, partial };
}

function emptyNumbers(): ExportNumbers {
  return {
    parts: [],
    main: { dollars: null, partial: false },
    delegated: { dollars: null, partial: false },
    combined: { dollars: null, partial: false },
    coverage: { usage: 'unavailable', cost: 'unpriced' },
  };
}
function resolvedEntry(
  identity: ExportIdentity,
  inventory: Inventory,
): { entry?: Entry; reason?: ExportOmissionReason } {
  const matching = inventory.entries.filter(
    (entry) =>
      entry.agent === identity.agent &&
      (identity.parentSessionId ? entry.parentSessionId === identity.parentSessionId : !entry.childTranscript) &&
      entry.sessionId.toLowerCase() === identity.sessionId.toLowerCase(),
  );
  if (matching.length === 1) return { entry: matching[0] };
  return { reason: matching.length ? 'ambiguous' : 'missing' };
}
function dispatchEntry(
  reference: ClaudeChildSessionReference,
  inventory: Inventory,
): { entry?: Entry; reason?: ExportOmissionReason } {
  if (reference.kind !== 'dispatch') return { reason: 'unsupported' };
  const exact = resolvedEntry({ agent: reference.agent, sessionId: reference.sessionId }, inventory);
  if (exact.entry || exact.reason === 'ambiguous' || reference.agent !== 'claude') return exact;
  if (inventory.partial) return { reason: 'inventory-incomplete' };
  const matching = inventory.entries.filter(
    (entry) =>
      entry.agent === 'claude' &&
      !entry.childTranscript &&
      entry.sessionId.toLowerCase().startsWith(reference.sessionId.toLowerCase()),
  );
  return matching.length === 1 ? { entry: matching[0] } : { reason: matching.length ? 'ambiguous' : 'missing' };
}

async function numericRecord(
  entry: Entry,
  options: ExportCaptureOptions,
  limits: ExportLimits,
): Promise<SpendFileIndex> {
  let record: SpendFileIndex | undefined;
  const factory = (state: unknown): UsageLineReducer =>
    entry.agent === 'claude'
      ? createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, {
          childTranscript: entry.childTranscript === true,
          retainAllRequests: true,
        })
      : createCodexUsageLineReducer(state as Parameters<typeof createCodexUsageLineReducer>[0]);
  for (;;) {
    checkExportCancellation(options.signal);
    const result = indexSpendFile(record, entry.file, entry.cwd ?? 'export', factory, {
      maxBytes: limits.sliceBytes,
      exportRecordBytes: limits.recordBytes,
    });
    if (!result.found || result.invalidated) throw new SourceChanged();
    record = result.record;
    if (result.complete) return record;
    await pause();
  }
}

export async function captureSessionExport(
  options: ExportCaptureOptions,
  writer: ExportTransaction,
): Promise<ExportCapture> {
  const limits: ExportLimits = { ...EXPORT_LIMITS, ...options.limits };
  for (const limit of Object.values(limits))
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('The export limit is invalid.');
  readPhase('inventory');
  options.progress?.('inventory', 0);
  const inventory = await inventoryOf(options, limits);
  const inventorySignature = inventory.signature;
  const rootMatches = options.root.childTranscript
    ? []
    : inventory.entries.filter((entry) => entryKey(entry) === identityKey(options.root));
  if (rootMatches.length > 1) throw new Error('The selected session identity is ambiguous.');
  let root =
    rootMatches[0] ??
    (await fileEntry(options.root.agent, options.root.file, options.root.sessionId, options.root.parentSessionId));
  if (normalizeFsPath(root.file) !== normalizeFsPath(options.root.file))
    throw new Error('The selected session identity is ambiguous.');
  root = {
    ...root,
    ...(options.root.cwd ? { cwd: options.root.cwd } : {}),
    ...(options.root.childTranscript ? { childTranscript: true } : {}),
  };
  if (
    root.agent === 'claude' &&
    path.basename(root.file) !== `${root.childTranscript ? 'agent-' : ''}${root.sessionId}.jsonl`
  )
    throw new Error('The selected session identity is unavailable.');
  if (root.agent === 'codex') {
    const opening = await openingOf(root.file, limits, options.signal);
    root.opening = openingRecordOf(opening.text);
    if (root.opening?.sessionId !== root.sessionId) throw new Error('The selected session identity is unavailable.');
  }
  const entries = new Map<string, Entry>();
  const keys = new Map<string, string>();
  const relationships: ExportRelationship[] = [];
  const omissions: ExportOmission[] = inventory.issues.map((reason) => ({ session: null, relationship: null, reason }));
  const frozen = new Map<string, FrozenSource>();
  const directories = new Map<string, string>();
  const metadata = new Map<string, FrozenSource>();
  const nameFile = path.join(path.dirname(options.roots?.codex ?? codexSessionsRoot()), 'session_index.jsonl');
  let threadNames: ReturnType<typeof readThreadNames> | undefined;
  let nameFileMissing = false;
  const queue: Entry[] = [];
  const discoveryPartial = new Set<string>();
  let bytes = 0;
  const admit = (entry: Entry): string => {
    const identity = entryKey(entry);
    const known = keys.get(identity);
    if (known) {
      if (normalizeFsPath(entries.get(known)!.file) !== normalizeFsPath(entry.file))
        throw new Error('The linked session identity is ambiguous.');
      return known;
    }
    if (entries.size + 1 > limits.sessions) throw new ExportLimitError('sessions', limits.sessions);
    if (entry.size > limits.sourceBytes) throw new ExportLimitError('source', limits.sourceBytes);
    if (bytes + entry.size > limits.totalSourceBytes)
      throw new ExportLimitError('graph bytes', limits.totalSourceBytes);
    bytes += entry.size;
    const key = `s${entries.size + 1}`;
    keys.set(identity, key);
    entries.set(key, entry);
    queue.push(entry);
    return key;
  };
  const rootKey = admit(root);
  const edgeSet = new Set<string>();
  const edgeEvidence = new Map<string, string>();
  const link = (
    from: string,
    kind: ExportRelationship['kind'],
    target?: Entry,
    reason?: ExportOmissionReason,
    ownership: ExportRelationship['ownership'] = kind === 'reader-started' ? 'navigation' : 'delegated',
    evidence = '',
    missingIdentity = '',
    requestedByReader = false,
    label = missingIdentity,
  ) => {
    const identity = `${from}:${kind}:${target ? entryKey(target) : `${reason}:${missingIdentity}`}:${evidence}`;
    if (edgeSet.has(identity)) return;
    if (relationships.length + 1 > limits.relationships)
      throw new ExportLimitError('relationships', limits.relationships);
    edgeSet.add(identity);
    const key = `r${relationships.length + 1}`;
    const to = target ? admit(target) : null;
    relationships.push({
      key,
      from,
      to,
      kind,
      ownership,
      requestedByReader: kind === 'reader-started' || requestedByReader,
      coverage: target ? 'complete' : 'partial',
      ...(reason ? { reason } : {}),
      ...(!target && label ? { label } : {}),
    });
    if (evidence) edgeEvidence.set(key, evidence);
    if (!target) {
      omissions.push({ session: from, relationship: key, reason: reason ?? 'unresolved' });
      discoveryPartial.add(from);
    }
  };
  for (let position = 0; position < queue.length; position++) {
    checkExportCancellation(options.signal);
    const entry = queue[position];
    if (entry.agent === 'claude' && !entry.cwd) entry.cwd = readSessionCwd(entry.file) ?? undefined;
    const key = keys.get(entryKey(entry))!;
    readPhase('relationships');
    const completedBytes = [...frozen.values()].reduce((total, source) => total + source.stamp.size, 0);
    const progress = (bytes: number) =>
      options.progress?.('relationships', position, {
        discovered: queue.length,
        completed: position,
        bytes: completedBytes + bytes,
      });
    progress(0);
    let references: ClaudeChildSessionReference[];
    try {
      const scan = await referencesOf(entry, options, limits, progress);
      frozen.set(entry.file, scan.source);
      references = scan.references;
      if (!scan.complete) {
        discoveryPartial.add(key);
        omissions.push({ session: key, relationship: null, reason: 'unresolved' });
      }
    } catch (error) {
      if (
        error instanceof ExportLimitError ||
        options.signal?.aborted ||
        error instanceof SourceChanged ||
        entry === root
      )
        throw error;
      frozen.set(entry.file, await sourceDigest(entry, limits, options.signal));
      discoveryPartial.add(key);
      references = [];
      omissions.push({ session: key, relationship: null, reason: 'unreadable' });
    }
    if (entry.agent === 'claude') {
      const native = await nativeClaudeChildren(entry, options, limits, inventory, metadata, directories);
      if (native.partial) {
        discoveryPartial.add(key);
        omissions.push({ session: key, relationship: null, reason: 'unresolved' });
      }
      for (const child of native.children) {
        const cwd = readSessionCwd(child.file);
        if (cwd) child.cwd = cwd;
        for (const id of child.launchIds?.length ? child.launchIds : [`native-${child.sessionId}`])
          link(key, 'subagent', child, undefined, 'delegated', id);
      }
      for (const missing of native.missing)
        link(key, 'subagent', undefined, missing.reason, 'delegated', missing.evidence, missing.identity);
      for (const reference of references.filter((reference) => reference.kind !== 'dispatch')) {
        const child = native.children.find(
          (child) =>
            child.sessionId === reference.sessionId && normalizeFsPath(child.file) === normalizeFsPath(reference.file),
        );
        if (child) {
          for (const id of reference.toolUseIds) link(key, 'subagent', child, undefined, 'delegated', id);
          continue;
        }
        // A paired parent launch establishes direct ownership where older records have no meta file.
        try {
          const target = await fileEntry('claude', reference.file, reference.sessionId, entry.sessionId);
          target.qualified = `${entry.qualified?.split('/')[0] ?? entryKey(entry)}/${target.sessionId}`;
          const metaFile = `${reference.file.slice(0, -6)}.meta.json`;
          if (metadata.has(metaFile)) {
            if (!native.missing.some((missing) => missing.identity === reference.sessionId))
              for (const id of reference.toolUseIds)
                link(key, 'subagent', undefined, 'conflicting', 'delegated', id, reference.sessionId);
            continue;
          }
          const cwd = readSessionCwd(target.file);
          if (cwd) target.cwd = cwd;
          for (const id of reference.toolUseIds) link(key, 'subagent', target, undefined, 'delegated', id);
        } catch (error) {
          if (error instanceof ExportLimitError || options.signal?.aborted) throw error;
          for (const id of reference.toolUseIds)
            link(
              key,
              'subagent',
              undefined,
              (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
              'delegated',
              id,
              reference.sessionId,
            );
        }
      }
    } else {
      for (const candidate of inventory.entries) {
        if (
          candidate.agent !== 'codex' ||
          !candidate.opening?.hasSubagentSource ||
          candidate.opening.parentThreadId !== entry.sessionId
        )
          continue;
        const owner = resolvedEntry({ agent: 'codex', sessionId: entry.sessionId }, inventory);
        if (owner.entry !== entry && entry !== root) {
          link(key, 'subagent', undefined, 'conflicting');
          continue;
        }
        link(key, 'subagent', candidate);
      }
    }
    for (const reference of references) {
      if (reference.kind !== 'dispatch') continue;
      const target = dispatchEntry(reference, inventory);
      for (const id of reference.toolUseIds)
        link(
          key,
          'dispatched',
          target.entry,
          target.reason,
          'delegated',
          id,
          reference.sessionId,
          reference.owned,
          reference.name ?? reference.sessionId,
        );
    }
    for (const reader of options.readerLinks ?? []) {
      if (identityKey(reader.parent) !== identityKey(entry)) continue;
      const target = resolvedEntry(reader.child, inventory);
      link(key, 'reader-started', target.entry, target.reason);
    }
    const readerParentSources = new Map(
      [...inventory.entries, ...entries.values()]
        .filter((candidate) => candidate.sessionId.toLowerCase() === entry.sessionId.toLowerCase())
        .map((candidate) => [normalizeFsPath(candidate.file), candidate]),
    );
    for (const [child, parent] of Object.entries(options.readerParents ?? {})) {
      if (parent.toLowerCase() !== entry.sessionId.toLowerCase()) continue;
      const children = inventory.entries.filter(
        (candidate) => !candidate.childTranscript && candidate.sessionId.toLowerCase() === child.toLowerCase(),
      );
      const target =
        !inventory.partial && readerParentSources.size === 1 && children.length === 1 ? children[0] : undefined;
      const reason = target
        ? undefined
        : readerParentSources.size > 1 || children.length > 1
          ? 'ambiguous'
          : inventory.partial
            ? 'inventory-incomplete'
            : 'missing';
      link(key, 'reader-started', target, reason, 'navigation', '', child);
    }
  }
  options.progress?.('relationships', queue.length, {
    discovered: queue.length,
    completed: queue.length,
    bytes: [...frozen.values()].reduce((total, source) => total + source.stamp.size, 0),
  });
  const claims = relationships.filter((edge) => edge.to !== null && edge.kind !== 'reader-started');
  const parentIndex = sessionParentIndex(
    claims
      .filter((edge) => edge.kind === 'dispatched')
      .map((edge) => ({
        kind: 'dispatch',
        sessionId: edge.to!,
        parentSessionId: edge.from,
        owned: edge.requestedByReader,
      })),
    claims
      .filter((edge) => edge.kind === 'subagent')
      .map((edge) => ({ sessionId: edge.to!, parentSessionId: edge.from })),
  );
  for (const edge of claims) {
    if (parentIndex.get(edge.to!)?.parent === edge.from && parentIndex.get(edge.to!)?.relation === edge.kind) continue;
    edge.coverage = 'partial';
    edge.reason = 'conflicting';
    edge.to = null;
    discoveryPartial.add(edge.from);
    omissions.push({ session: edge.from, relationship: edge.key, reason: 'conflicting' });
  }
  const reachable = new Set([rootKey]);
  const pending = [rootKey];
  for (let index = 0; index < pending.length; index++)
    for (const edge of relationships) {
      if (edge.from !== pending[index] || !edge.to || reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      pending.push(edge.to);
    }
  const sessions: ExportSession[] = [];
  const numeric = new Map<string, SpendFileIndex>();
  let turnCount = 0;
  let pageCount = 0;
  const childStatuses = new Map<string, ReturnType<typeof structuralAgentStatus>>();
  const structuralStatusOf: typeof structuralAgentStatus = (child) => {
    let status = childStatuses.get(child.file);
    if (!status) {
      status = structuralAgentStatus(child);
      childStatuses.set(child.file, status);
    }
    return status;
  };
  for (const [key, entry] of entries) {
    if (!reachable.has(key)) continue;
    readPhase('text');
    options.progress?.('text', sessions.length);
    if (entry.agent === 'codex' && !threadNames) {
      try {
        const nameSource = await fileEntry('codex', nameFile, 'names');
        if (nameSource.size > limits.inventoryBytes) throw new ExportLimitError('names', limits.inventoryBytes);
        metadata.set(nameFile, await sourceDigest(nameSource, limits, options.signal));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        nameFileMissing = true;
      }
      threadNames = readThreadNames(nameFile, null);
    }
    const title =
      entry.agent === 'codex'
        ? codexTitleFor(threadNames!.fullNames, entry.sessionId, readCodexSessionTitlePair(entry.file).full)
        : null;
    const session: ExportSession = {
      key,
      agent: entry.agent,
      title: title ?? 'Session',
      pages: [],
      turnCount: 0,
      compactionCount: 0,
      firstRequestCachedTokens: null,
      numbers: emptyNumbers(),
      parentOutsideExport:
        !parentIndex.has(key) &&
        Boolean(entry.childTranscript || entry.parentSessionId || entry.opening?.parentThreadId),
      provenance: { sourceBytes: entry.size, sha256: frozen.get(entry.file)!.digest },
      coverage: {
        text: 'complete',
        relationships: discoveryPartial.has(key) || inventory.partial ? 'partial' : 'complete',
        context: 'unavailable',
        changes: 'recorded',
      },
    };
    const seen = new Map<string, string>();
    const compactions = new Set<string>();
    readPhase('numbers');
    options.progress?.('numbers', sessions.length);
    const numericSource = await numericRecord(entry, options, limits);
    numeric.set(key, numericSource);
    readPhase('text');
    let cursor: SemanticHistoryPage['nextOlderCursor'] = null;
    const links = new Map<string, string[]>();
    for (const edge of relationships.filter((edge) => edge.from === key)) {
      const evidence = edgeEvidence.get(edge.key);
      if (evidence) links.set(evidence, [...(links.get(evidence) ?? []), edge.key]);
    }
    for (;;) {
      checkExportCancellation(options.signal);
      const history = { exportLimits: limits, targetTurns: 1, signal: options.signal };
      const result: SemanticHistoryResult =
        entry.agent === 'claude'
          ? await readClaudeHistoryPageAsync(
              entry.file,
              entry.sessionId,
              cursor as ClaudeHistoryCursor | null,
              history,
              {
                childTranscript: entry.childTranscript === true,
                captureRepeated: numericSource.claudeRepeated ?? undefined,
              },
            )
          : await readCodexHistoryPageAsync(entry.file, entry.sessionId, cursor as CodexHistoryCursor | null, history, {
              capturedOpening: entry.opening,
              structuralStatusOf,
              sessionTitle: title,
              structuralChildren: relationships
                .filter((edge) => edge.from === key && edge.kind === 'subagent' && edge.to)
                .map((edge) => {
                  const child = entries.get(edge.to!)!;
                  return {
                    file: child.file,
                    threadId: child.sessionId,
                    parentThreadId: child.opening!.parentThreadId,
                    agentPath: child.opening!.agentPath,
                    openedAt: child.opening!.openedAt,
                    startedAt: child.opening!.startedAt,
                    threadSource: child.opening!.threadSource,
                    backgroundReview: isHiddenThread(child.opening!),
                  };
                }),
            });
      if (result.kind !== 'page') throw new SourceChanged();
      const page: SemanticHistoryPage = result.page;
      const turns: ExportTurn[] = [];
      for (const turn of [...(page.unfinished ? [page.unfinished.turn] : []), ...page.turns.slice().reverse()]) {
        const semantic = `${page.unfinished?.turn === turn ? page.unfinished.start : page.ownedRange.start}:${turn.promptId}`;
        const digest = hash(JSON.stringify(blocksOf(turn, '')));
        const prior = seen.get(semantic);
        if (prior) {
          if (prior !== digest) throw new SourceChanged();
          continue;
        }
        if (turnCount + 1 > limits.turns) throw new ExportLimitError('turns', limits.turns);
        turnCount++;
        session.turnCount++;
        seen.set(semantic, digest);
        if (title) session.title = title;
        else if (turn.sessionFullTitle || turn.sessionTitle)
          session.title = turn.sessionFullTitle ?? turn.sessionTitle!;
        else if (!title)
          session.title = normalizeSessionTitle(cleanPrompt(turn.delegation?.text || turn.prompt)) ?? session.title;
        const projected = projectTurn(turn, `${key}-t${session.turnCount}`, entry, omissions, key, links);
        for (const edge of relationships) {
          if (edge.from !== key) continue;
          const child = edge.to ? entries.get(edge.to) : undefined;
          const agent = turn.agents.find((agent) => child && agent.id === child.sessionId);
          if (agent) {
            if (!projected.relationships.includes(edge.key)) projected.relationships.push(edge.key);
            const capturedAgent = projected.agents[turn.agents.indexOf(agent)];
            const agentLinks = (capturedAgent.relationships ??= []);
            if (!agentLinks.includes(edge.key)) agentLinks.push(edge.key);
          }
          if (projected.relationships.includes(edge.key)) {
            edge.turn = projected.key;
            if (!edge.to) {
              const evidence = edgeEvidence.get(edge.key);
              const assignment = turn.agents.find((agent) => agent.toolUseId === evidence)?.description;
              if (assignment) edge.label = assignment;
            }
          }
        }
        if (projected.context.tokens !== null) session.coverage.context = 'recorded';
        if (projected.changes === 'partial') session.coverage.changes = 'partial';
        turns.push(projected);
      }
      const projectedCompactions: ExportCompaction[] = [];
      for (const compaction of page.compactions) {
        const semantic = `${compaction.at}:${compaction.trigger}:${hash(compaction.summary)}`;
        if (compactions.has(semantic)) continue;
        compactions.add(semantic);
        session.compactionCount++;
        projectedCompactions.push(projectCompaction(compaction, `${key}-c${session.compactionCount}`));
      }
      if (turns.length || projectedCompactions.length) {
        const spool = await writer.spool({
          key: `p${++pageCount}`,
          session: key,
          turns,
          compactions: projectedCompactions,
        });
        session.pages.push(spool);
      }
      if (page.firstRequestCachedTokens !== undefined) session.firstRequestCachedTokens = page.firstRequestCachedTokens;
      if (!sameStamp(await fs.lstat(entry.file), entry.stamp)) throw new SourceChanged();
      if (!page.nextOlderCursor) {
        if (page.ownedRange.start !== 0) throw new Error('The session history is incomplete.');
        break;
      }
      if (cursor && page.nextOlderCursor.pageEnd >= cursor.pageEnd)
        throw new Error('The session history is incomplete.');
      cursor = page.nextOlderCursor;
    }
    sessions.push(session);
  }
  const validEdges = relationships.filter((edge) => reachable.has(edge.from));
  const nativeParents = new Map(
    [...parentIndex]
      .filter(([child, edge]) => reachable.has(child) && edge.relation === 'subagent')
      .map(([child, edge]) => [child, edge.parent]),
  );
  const dispatchedParents = new Map(
    [...parentIndex]
      .filter(([child, edge]) => reachable.has(child) && edge.relation === 'dispatched')
      .map(([child, edge]) => [child, edge.parent]),
  );
  readPhase('figures');
  let sources: SessionSpendSource[] = sessions.map((session) => ({
    sessionId: session.key,
    file: entries.get(session.key)!.file,
    primary: true,
    ...(nativeParents.has(session.key) ? { nativeParentFile: entries.get(nativeParents.get(session.key)!)!.file } : {}),
  }));
  for (const session of sessions) {
    for (const candidate of sessions) {
      const visited = new Set<string>();
      for (
        let owner = nativeParents.get(candidate.key);
        owner && !visited.has(owner);
        owner = nativeParents.get(owner)
      ) {
        visited.add(owner);
        if (owner === session.key && candidate.key !== session.key)
          sources.push({
            sessionId: session.key,
            file: entries.get(candidate.key)!.file,
            primary: false,
            nativeParentFile: entries.get(nativeParents.get(candidate.key)!)!.file,
          });
      }
    }
  }
  sources = withDispatchedSpendSources(sources, dispatchedParents, nativeParents);
  const records = [...numeric.values()];
  for (const session of sessions.filter((session) => session.agent === 'claude')) {
    const record = numeric.get(session.key)!;
    const capture = (record.parserState as ClaudeUsageReducerState | undefined)?.costState;
    if (!capture?.snapshots.length) continue;
    const dependencies = claudeCostStateDependencies(
      sources.find((source) => source.sessionId === session.key && source.primary)!,
      sources,
      records,
    );
    if (!dependencies) continue;
    let progress: ClaudeCostProgress | undefined;
    for (;;) {
      checkExportCancellation(options.signal);
      const result = reconcileClaudeCostState(
        capture,
        dependencies,
        (state) =>
          createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, {
            childTranscript: true,
            retainAllRequests: true,
          }),
        progress,
        {
          maxBytes: limits.sliceBytes,
          exportRecordBytes: limits.recordBytes,
          maxWorkingSetBytes: limits.pageBytes * 8,
        },
      );
      if (result.invalidated) throw new SourceChanged();
      progress = result.progress;
      if (result.complete) {
        record.costStateSupplement = result.supplement;
        break;
      }
      await pause();
    }
  }
  const coverage = new Map<string, SessionSpendCoverage>();
  const parts = sessionSpendPartsBySession(records, sources, undefined, () => false, coverage);
  const sourceKeys = new Map(sessions.map((session) => [normalizeFsPath(entries.get(session.key)!.file), session.key]));
  for (const session of sessions) {
    const all = (parts[session.key] ?? []).map(sessionCostUsageOf);
    const completeness = coverage.get(session.key)!;
    const ownRecord = numeric.get(session.key)!;
    const costCapture = (ownRecord.parserState as ClaudeUsageReducerState | undefined)?.costState;
    completeness.main ||=
      Boolean(costCapture?.snapshots.length && !ownRecord.costStateSupplement) || Boolean(costCapture?.reason);
    const linkedMissing = validEdges.some(
      (edge) => edge.from === session.key && edge.ownership === 'delegated' && edge.coverage === 'partial',
    );
    completeness.delegated ||= linkedMissing || session.coverage.relationships === 'partial';
    session.numbers = {
      parts: all.flatMap((part) =>
        costPartsOf(
          part,
          part.scopeId?.startsWith('source:')
            ? (sourceKeys.get(normalizeFsPath(part.scopeId.slice(7))) ?? null)
            : part.scopeId && reachable.has(part.scopeId)
              ? part.scopeId
              : null,
        ),
      ),
      main: sessionCostProjection(
        all.filter((part) => part.role !== 'delegated'),
        { main: completeness.main, delegated: false, delegatedScopeIds: new Set() },
      ).total,
      delegated: sessionCostProjection(
        all.filter((part) => part.role === 'delegated'),
        { main: false, delegated: completeness.delegated, delegatedScopeIds: completeness.delegatedScopeIds },
      ).total,
      combined: sessionCostProjection(all, completeness).total,
      coverage: {
        usage: completeness.main || completeness.delegated ? 'partial' : all.length ? 'complete' : 'unavailable',
        cost: 'complete',
      },
    };
    session.numbers.coverage.cost =
      session.numbers.combined.dollars === null
        ? 'unpriced'
        : session.numbers.combined.partial
          ? 'partial'
          : 'complete';
  }
  const model: SessionExport = {
    version: 1,
    root: rootKey,
    capturedAt: options.capturedAt ?? Date.now(),
    sessions,
    relationships: validEdges,
    omissions: omissions.filter((omission) => omission.session === null || reachable.has(omission.session)),
    coverage: {
      text: 'complete',
      relationships: inventory.partial || discoveryPartial.size ? 'partial' : 'complete',
      inventory: inventory.partial ? 'partial' : 'complete',
    },
    deliberatelyOmitted: [
      'reasoning',
      'raw-tools',
      'commands',
      'patches',
      'attachments',
      'comments',
      'drafts',
      'queued-submissions',
      'live-state',
      'absolute-metadata-paths',
      'resume-commands',
    ],
  };
  const recheck = async () => {
    readPhase('validation');
    options.progress?.('checking', sessions.length);
    checkExportCancellation(options.signal);
    if (nameFileMissing) {
      try {
        await fs.lstat(nameFile);
        throw new SourceChanged();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    for (const source of [...frozen.values(), ...metadata.values()]) {
      try {
        const entry = await fileEntry('claude', source.file, 'check');
        if (!sameStamp(entry.stamp, source.stamp)) throw new SourceChanged();
        if ((await sourceDigest(entry, limits, options.signal)).digest !== source.digest) throw new SourceChanged();
      } catch (error) {
        checkExportCancellation(options.signal);
        if (error instanceof ExportLimitError) throw error;
        throw new SourceChanged();
      }
    }
    for (const [directory, expected] of directories) {
      if (expected === 'partial') continue;
      const names: string[] = [];
      try {
        for await (const child of await fs.opendir(directory)) {
          checkExportCancellation(options.signal);
          names.push(child.name);
          if (names.length > limits.inventoryPaths) throw new SourceChanged();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && expected === 'missing') continue;
        throw new SourceChanged();
      }
      if (hash(JSON.stringify(names.sort())) !== expected) throw new SourceChanged();
    }
    readPhase('validation-inventory');
    if ((await inventoryOf(options, limits)).signature !== inventorySignature) throw new SourceChanged();
  };
  return { model, recheck };
}

/** A changed graph restarts capture and projection once before any directory is published. */
export async function completeSessionExport(
  writer: ExportTransaction,
  options: ExportCaptureOptions,
  project: (capture: ExportCapture, writer: ExportTransaction) => Promise<void>,
): Promise<{ model: SessionExport; directory: string; index: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const capture = await captureSessionExport(options, writer);
      readPhase('projection');
      await project(capture, writer);
      const result = await writer.publish(capture.recheck);
      return { ...result, model: capture.model };
    } catch (error) {
      if (!(error instanceof SourceChanged) || attempt === 1) throw error;
      meterReadWork('sourceChangeRetries');
      readPhase('cleanup');
      await writer.reset();
    }
  }
  throw new SourceChanged();
}
