import * as fs from 'node:fs';
import { revisionOf } from './transcript';
import {
  COMPACT_META_WINDOW_MS,
  ClaudeSessionParserState,
  ReadOptions,
  claudeSessionLineMayAffectRead,
  claudeRetainedLine,
  RecordedTitleSource,
  createClaudeSessionReducer,
  normalizeFullSessionTitle,
  readSessionRecordedTitlePair,
  taskNotificationText,
  withClaudeFirstRequest,
  claudeModelEvidence,
  readPreviousLines,
  withClaudeRepeated,
  type BackwardLineCursor,
  type FileRevision,
} from './transcript';
import { BACKGROUND_SCAN_BYTES, BACKGROUND_SCAN_MILLISECONDS } from './parserstate';
import { sameModelIdentity } from './domain/model-identity';
import { insideClaudeRepeated } from './clauderepeated';
import {
  ForwardParserCheckpoint,
  IncrementalSessionResult,
  SemanticHistoryOptions,
  SemanticHistoryResult,
  SemanticSourceAdapter,
  SourceHistoryCursor,
  readForwardSession,
  readForwardSessionAsync,
  ForwardReadOptions,
  readSemanticHistoryPage,
  readSemanticHistoryPageAsync,
} from './history';

export type ClaudeForwardCheckpoint = ForwardParserCheckpoint<ClaudeSessionParserState> & {
  attachmentRecovery?: ClaudeAttachmentRecovery;
};
export interface ClaudeAttachmentRecovery {
  boundary: number;
  cursor: BackwardLineCursor;
  status: 'pending' | 'complete';
  identity: string | null;
  model: string | null;
  incompatible: boolean;
}
export interface AttachmentRecoveryBudget {
  maxBytes?: number;
  maxMilliseconds?: number;
  clock?: () => number;
  signal?: AbortSignal;
}

function inspectAttachmentEvidence(state: ClaudeAttachmentRecovery, text: string, childTranscript: boolean): void {
  if (
    !text.includes('"modelId"') &&
    !text.includes('"assistant"') &&
    !(text.includes('"attachment"') && text.includes('"model"'))
  )
    return;
  try {
    const evidence = claudeModelEvidence(JSON.parse(text), childTranscript);
    if (!evidence) return;
    if (evidence.kind === 'assistant') {
      if (state.model && !sameModelIdentity(state.model, evidence.identity)) state.incompatible = true;
      state.model ??= evidence.identity;
    } else {
      state.identity =
        !state.incompatible && (!state.model || sameModelIdentity(evidence.identity, state.model))
          ? evidence.identity
          : null;
      state.status = 'complete';
    }
  } catch {
    /* malformed source records provide no identity */
  }
}

export function recoverClaudeAttachmentSlice(
  file: string,
  state: ClaudeAttachmentRecovery,
  childTranscript = false,
  budget: AttachmentRecoveryBudget = {},
  // Returns true for a repeated record, which holds no evidence.
  repeatedRecord?: (start: number, text: string) => boolean,
): { kind: 'pending' | 'complete' | 'stale' | 'cancelled'; readBytes: number } {
  if (budget.signal?.aborted) return { kind: 'cancelled', readBytes: 0 };
  try {
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    const revision = state.cursor.revision;
    if (
      stat.size !== revision.size ||
      stat.mtimeMs !== revision.mtimeMs ||
      stat.dev !== revision.dev ||
      stat.ino !== revision.ino
    )
      return { kind: 'stale', readBytes: 0 };
  } catch {
    return { kind: 'stale', readBytes: 0 };
  }
  const clock = budget.clock ?? (() => performance.now());
  const deadline = clock() + (budget.maxMilliseconds ?? BACKGROUND_SCAN_MILLISECONDS);
  const maxBytes = Math.max(1, budget.maxBytes ?? BACKGROUND_SCAN_BYTES);
  let readBytes = 0;
  while (state.status === 'pending' && state.cursor.end > 0 && readBytes < maxBytes && clock() < deadline) {
    if (budget.signal?.aborted) return { kind: 'cancelled', readBytes };
    const before = state.cursor.end;
    const batch = readPreviousLines(file, state.cursor, Math.min(256 * 1024, maxBytes - readBytes));
    if (!batch) return { kind: 'stale', readBytes };
    readBytes += before - batch.cursor.end;
    state.cursor = batch.cursor;
    for (const line of batch.lines) {
      if (repeatedRecord?.(line.offset, line.text)) continue;
      inspectAttachmentEvidence(state, line.text, childTranscript);
      if ((state.status as string) === 'complete') break;
    }
  }
  if (budget.signal?.aborted) return { kind: 'cancelled', readBytes };
  if (state.cursor.end === 0) state.status = 'complete';
  return { kind: state.status, readBytes };
}

function attachmentRecovery(
  boundary: number,
  revision: FileRevision,
  fragment: Buffer = Buffer.alloc(0),
): ClaudeAttachmentRecovery {
  return {
    boundary,
    cursor: { revision, end: boundary, fragment: Buffer.from(fragment) },
    status: boundary === 0 ? 'complete' : 'pending',
    identity: null,
    model: null,
    incompatible: false,
  };
}
export interface ClaudeBackwardState {
  revision: FileRevision;
  titleRecord: ClaudeSessionParserState['titleRecord'];
  compactMeta: ClaudeSessionParserState['compactMeta'];
  terminalChildren: ClaudeTerminalChildEvidence[];
  attachmentEvidence?: ClaudeAttachmentRecovery;
}

interface ClaudeTerminalChildEvidence {
  toolUseId: string;
  agentId: string | null;
  status: string;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  closedAt: number;
  start: number;
  end: number;
  ownerStart: number | null;
  turnsRemaining: number;
}
export type ClaudeHistoryCursor = SourceHistoryCursor<ClaudeBackwardState>;
export type ClaudeHistoryPageResult = SemanticHistoryResult<ClaudeBackwardState>;

const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;

function terminalChildEvidence(
  record: { text: string; start: number; end: number },
  turnsRemaining: number,
): ClaudeTerminalChildEvidence | null {
  if (record.text.indexOf('task-notification') < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(record.text) as Record<string, unknown>;
    const content = taskNotificationText(parsed);
    if (content === null) {
      return null;
    }
    const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(content)?.[1] ?? '';
    const status = /<status>([^<]+)<\/status>/.exec(content)?.[1] ?? '';
    if (!toolUseId || !status || status === 'running') {
      return null;
    }
    const figure = (name: string): number | null => {
      const value = new RegExp(`<${name}>(\\d+)</${name}>`).exec(content)?.[1];
      return value === undefined ? null : Number(value);
    };
    const attachment = parsed.attachment as { timestamp?: unknown } | undefined;
    const recordedAt = parsed.type === 'attachment' && attachment?.timestamp ? attachment.timestamp : parsed.timestamp;
    const closedAt = Date.parse(String(recordedAt ?? ''));
    return {
      toolUseId,
      agentId: /<task-id>([^<]+)<\/task-id>/.exec(content)?.[1] ?? null,
      status,
      tokens: figure('subagent_tokens'),
      toolUses: figure('tool_uses'),
      durationMs: figure('duration_ms'),
      closedAt: Number.isNaN(closedAt) ? 0 : closedAt,
      start: record.start,
      end: record.end,
      ownerStart: null,
      turnsRemaining,
    };
  } catch {
    return null;
  }
}

function titleRank(source: RecordedTitleSource | undefined): number {
  return source === 'custom' ? 2 : source === 'generated' ? 1 : 0;
}

function claudeParserKey(opts: ReadOptions): string {
  return JSON.stringify({
    version: 14,
    recoveredModelAttachment: opts.recoveredModelAttachment ?? null,
    tailBytes: opts.tailBytes ?? DEFAULT_TAIL_BYTES,
    maxTurns: opts.maxTurns ?? 40,
    sessionTitle: normalizeFullSessionTitle(opts.sessionTitle),
    folders: opts.folders ?? [],
    childTranscript: opts.childTranscript === true,
  });
}

export function readClaudeSessionIncremental(
  file: string,
  sessionId: string,
  checkpoint?: ClaudeForwardCheckpoint,
  opts: ReadOptions = {},
): IncrementalSessionResult<ClaudeSessionParserState> {
  const repeated = withClaudeRepeated(file, opts);
  const result = readForwardSession(
    file,
    'claude',
    sessionId,
    (restored) => createClaudeSessionReducer(sessionId, repeated, restored),
    checkpoint,
    undefined,
    claudeParserKey(opts),
    opts.tailBytes ?? DEFAULT_TAIL_BYTES,
  );
  if (result.read) {
    withClaudeFirstRequest(file, result.read.compactions, opts.childTranscript === true);
  }
  return result;
}

export async function readClaudeSessionIncrementalAsync(
  file: string,
  sessionId: string,
  checkpoint?: ClaudeForwardCheckpoint,
  opts: ReadOptions = {},
  work: ForwardReadOptions & { attachmentBudget?: AttachmentRecoveryBudget } = {},
): Promise<IncrementalSessionResult<ClaudeSessionParserState> & { recoveryBytes?: number; recoveryPending?: boolean }> {
  const repeated = withClaudeRepeated(file, opts);
  const result = await readForwardSessionAsync(
    file,
    'claude',
    sessionId,
    (restored) => createClaudeSessionReducer(sessionId, repeated, restored),
    checkpoint,
    undefined,
    claudeParserKey(opts),
    opts.tailBytes ?? DEFAULT_TAIL_BYTES,
    work,
  );
  if (!result.read) return result;
  const next = result.checkpoint as ClaudeForwardCheckpoint;
  const previous = checkpoint?.attachmentRecovery;
  const recovery =
    previous &&
    result.kind !== 'reset' &&
    previous.cursor.revision.size === next.revision.size &&
    previous.cursor.revision.mtimeMs === next.revision.mtimeMs &&
    previous.cursor.revision.dev === next.revision.dev &&
    previous.cursor.revision.ino === next.revision.ino
      ? { ...previous, cursor: { ...previous.cursor, fragment: Buffer.from(previous.cursor.fragment) } }
      : previous &&
          result.kind === 'appended' &&
          next.reducedFrom === previous.boundary &&
          result.appendFrom?.size === previous.cursor.revision.size &&
          result.appendFrom?.mtimeMs === previous.cursor.revision.mtimeMs &&
          next.revision.dev === previous.cursor.revision.dev &&
          next.revision.ino === previous.cursor.revision.ino
        ? {
            ...previous,
            cursor: { ...previous.cursor, revision: next.revision, fragment: Buffer.from(previous.cursor.fragment) },
          }
        : attachmentRecovery(next.reducedFrom ?? next.coveredFrom, next.revision, next.skippedFragment);
  const slice = recoverClaudeAttachmentSlice(
    file,
    recovery,
    opts.childTranscript === true,
    { ...work.attachmentBudget, signal: work.signal },
    repeated.repeatedRecord,
  );
  if (slice.kind === 'stale' || slice.kind === 'cancelled')
    return {
      kind: slice.kind,
      read: null,
      checkpoint: null,
      readBytes: result.readBytes,
      recoveryBytes: slice.readBytes,
    };
  next.attachmentRecovery = recovery;
  if (slice.kind === 'complete') {
    recovery.cursor.fragment = Buffer.alloc(0);
    next.skippedFragment = Buffer.alloc(0);
    const reducer = createClaudeSessionReducer(sessionId, repeated, next.parserState);
    reducer.recoverAttachment(recovery.identity);
    next.parserState = reducer.snapshot();
    if (next.lineFragment.length)
      reducer.pushLine({
        text: next.lineFragment.toString('utf8'),
        start: next.appliedThrough,
        end: next.revision.size,
      });
    result.read = reducer.finish(next.revision.size - next.coveredFrom);
  }
  withClaudeFirstRequest(file, result.read.compactions, opts.childTranscript === true);
  return { ...result, recoveryBytes: slice.readBytes, recoveryPending: slice.kind === 'pending' };
}

function claudeAdapter(sessionId: string, opts: ReadOptions): SemanticSourceAdapter<ClaudeBackwardState> {
  const terminalChildHorizon = Math.max(0, Math.floor(opts.maxTurns ?? 40));
  return {
    source: 'claude',
    initialState: (file, revision) => {
      const title = opts.captureSessionText
        ? { short: null, full: null, source: null, at: null }
        : readSessionRecordedTitlePair(file, opts.tailBytes ?? DEFAULT_TAIL_BYTES);
      return {
        revision,
        titleRecord:
          title.short && title.source
            ? {
                title: title.short,
                fullTitle: title.full,
                start: title.at ?? revision.size,
                end: revision.size,
                source: title.source,
              }
            : null,
        compactMeta: [],
        terminalChildren: [],
      };
    },
    accepts: (record) => claudeSessionLineMayAffectRead(record.text),
    retain: claudeRetainedLine,
    parse: (input, backward) => {
      const captured = opts.captureRepeated
        ? input.filter((record) => !insideClaudeRepeated(opts.captureRepeated, record.start))
        : input;
      const boundary = captured[0]?.start ?? 0;
      // Every loop below reads only genuine records, so the reducer classifies nothing again.
      const classify = opts.repeatedRecord;
      const records = classify ? captured.filter((record) => !classify(record.start, record.text)) : captured;
      const evidence = backward.attachmentEvidence?.boundary === boundary ? backward.attachmentEvidence : undefined;
      const reducer = createClaudeSessionReducer(sessionId, {
        ...opts,
        ...(classify ? { repeatedRecord: () => false } : {}),
        maxTurns: Number.MAX_SAFE_INTEGER,
        recoveredModelAttachment: evidence?.status === 'complete' ? evidence.identity : null,
      });
      for (const record of records) {
        reducer.pushLine(record);
      }
      const snapshot = reducer.snapshot();
      const terminalChildren = new Map<string, ClaudeTerminalChildEvidence>();
      for (const evidence of backward.terminalChildren) {
        terminalChildren.set(`${evidence.start}:${evidence.end}`, { ...evidence, ownerStart: null });
      }
      for (const record of records) {
        const evidence = terminalChildEvidence(record, terminalChildHorizon);
        if (evidence) {
          terminalChildren.set(`${evidence.start}:${evidence.end}`, evidence);
        }
      }
      for (const evidence of terminalChildren.values()) {
        let owner: { start: number; agent: ClaudeSessionParserState['turns'][number]['agents'][number] } | null = null;
        for (let index = 0; index < snapshot.turns.length; index += 1) {
          const range = snapshot.turnRanges[index];
          if (!range || range.start >= evidence.start) {
            continue;
          }
          const agent = snapshot.turns[index].agents.find((candidate) => candidate.toolUseId === evidence.toolUseId);
          if (agent && (!owner || range.start > owner.start)) {
            owner = { start: range.start, agent };
          }
        }
        if (!owner) {
          continue;
        }
        evidence.ownerStart = owner.start;
        owner.agent.id = evidence.agentId ?? owner.agent.id;
        owner.agent.status = evidence.status;
        owner.agent.tokens = evidence.tokens ?? owner.agent.tokens;
        if (evidence.toolUses !== null) {
          owner.agent.toolUses = evidence.toolUses;
          delete owner.agent.toolUsesFromArtifacts;
        }
        owner.agent.durationMs = evidence.durationMs ?? owner.agent.durationMs;
        owner.agent.closedAt = evidence.closedAt;
        if (snapshot.launched.get(evidence.toolUseId) === owner.agent) {
          snapshot.launched.delete(evidence.toolUseId);
        }
      }
      const compactMeta = new Map<string, ClaudeSessionParserState['compactMeta'][number]>();
      const pageMeta: ClaudeSessionParserState['compactMeta'] = [];
      for (const record of records) {
        if (record.text.indexOf('"compactMetadata"') < 0) {
          continue;
        }
        try {
          const parsed = JSON.parse(record.text) as {
            timestamp?: unknown;
            compactMetadata?: ClaudeSessionParserState['compactMeta'][number]['data'];
          };
          if (!parsed.compactMetadata) {
            continue;
          }
          const at = Date.parse(String(parsed.timestamp ?? ''));
          pageMeta.push({
            at: Number.isNaN(at) ? 0 : at,
            data: parsed.compactMetadata,
            start: record.start,
            end: record.end,
          });
        } catch {
          /* malformed source records do not carry metadata */
        }
      }
      for (const item of [...pageMeta, ...snapshot.compactMeta, ...backward.compactMeta]) {
        compactMeta.set(`${item.start}:${item.end}`, item);
      }
      snapshot.compactMeta = [...compactMeta.values()];
      // A custom name outranks a generated title wherever each was found. Within one rank
      // the record further into the file is the newer one.
      const titleRecord =
        [snapshot.titleRecord, backward.titleRecord]
          .filter((item): item is NonNullable<typeof item> => item !== null)
          .sort((a, b) => titleRank(b.source) - titleRank(a.source) || b.start - a.start)[0] ?? null;
      if (titleRecord) {
        snapshot.title = titleRecord.title;
        snapshot.fullTitle = titleRecord.fullTitle;
        snapshot.titleSource = titleRecord.source ?? null;
        snapshot.titleAt = titleRecord.source ? titleRecord.start : null;
        snapshot.titleRecord = titleRecord;
      }
      const merged = createClaudeSessionReducer(sessionId, { ...opts, maxTurns: Number.MAX_SAFE_INTEGER }, snapshot);
      const openRange = merged.openRange();
      const unfinished = opts.captureSessionText && openRange ? (merged.read().turns.at(-1) ?? null) : null;
      return {
        turns: merged.completedTurns(),
        compactions: merged.completedCompactions(),
        openRange,
        ...(opts.captureSessionText
          ? { firstRequestCachedTokens: snapshot.usageState.firstRequestCachedTokens ?? null }
          : {}),
        ...(opts.captureSessionText
          ? { unfinished: unfinished && openRange ? { turn: unfinished, ...openRange } : null }
          : {}),
        adapterState: {
          revision: backward.revision,
          titleRecord,
          compactMeta: snapshot.compactMeta,
          terminalChildren: [...terminalChildren.values()],
          attachmentEvidence: evidence,
        },
        olderEvidence:
          boundary > 0 && evidence?.status !== 'complete' ? [{ key: 'model-attachment', value: String(boundary) }] : [],
      };
    },
    scanOlderEvidence: (records, claims, backward, atBeginning) => {
      const boundary = Number(claims[0]?.value ?? 0);
      const evidence =
        backward.attachmentEvidence?.boundary === boundary
          ? backward.attachmentEvidence
          : attachmentRecovery(boundary, backward.revision);
      evidence.status = 'pending';
      for (const record of [...records].reverse()) {
        if (insideClaudeRepeated(opts.captureRepeated, record.start)) continue;
        if (opts.repeatedRecord?.(record.start, record.text)) continue;
        inspectAttachmentEvidence(evidence, record.text, opts.childTranscript === true);
        if ((evidence.status as string) === 'complete') break;
      }
      if (atBeginning) evidence.status = 'complete';
      return {
        adapterState: { ...backward, attachmentEvidence: evidence },
        remaining: evidence.status === 'complete' ? [] : [...claims],
      };
    },
    stateForOlder: (parsed, pageStart) => {
      const crossedTurns = parsed.turns.filter((entry) => entry.start >= pageStart).length;
      const terminalChildren: ClaudeTerminalChildEvidence[] = [];
      for (const evidence of parsed.adapterState.terminalChildren) {
        if (evidence.start < pageStart) {
          continue;
        }
        if (evidence.ownerStart !== null) {
          if (evidence.ownerStart >= pageStart) {
            continue;
          }
          terminalChildren.push({
            ...evidence,
            ownerStart: null,
            turnsRemaining: Math.max(1, evidence.turnsRemaining),
          });
          continue;
        }
        const turnsRemaining = evidence.turnsRemaining - crossedTurns;
        if (turnsRemaining > 0) {
          terminalChildren.push({ ...evidence, turnsRemaining });
        }
      }
      return {
        revision: parsed.adapterState.revision,
        titleRecord: parsed.adapterState.titleRecord,
        compactMeta: parsed.adapterState.compactMeta.filter((meta) => {
          if (meta.start < pageStart) {
            return false;
          }
          let closest: (typeof parsed.compactions)[number] | null = null;
          let closestGap = COMPACT_META_WINDOW_MS;
          for (const compaction of parsed.compactions) {
            const gap = Math.abs(compaction.compaction.at - meta.at);
            if (gap <= closestGap) {
              closest = compaction;
              closestGap = gap;
            }
          }
          return !closest || closest.start < pageStart;
        }),
        terminalChildren,
      };
    },
  };
}

export function readClaudeHistoryPage(
  file: string,
  sessionId: string,
  cursor: ClaudeHistoryCursor | null = null,
  options: SemanticHistoryOptions = {},
  readOptions: ReadOptions = {},
): ClaudeHistoryPageResult {
  const capture = options.exportLimits
    ? { ...readOptions, captureSessionText: true, exportTurnBytes: options.exportLimits.turnBytes }
    : readOptions;
  const result = readSemanticHistoryPage(
    file,
    sessionId,
    claudeAdapter(sessionId, withClaudeRepeated(file, capture)),
    cursor,
    options,
  );
  if (result.page && !options.exportLimits) {
    withClaudeFirstRequest(file, result.page.compactions, readOptions.childTranscript === true);
  }
  return result;
}

export function readClaudeHistoryPageAsync(
  file: string,
  sessionId: string,
  cursor: ClaudeHistoryCursor | null = null,
  options: SemanticHistoryOptions = {},
  readOptions: ReadOptions = {},
): Promise<ClaudeHistoryPageResult> {
  const capture = options.exportLimits
    ? { ...readOptions, captureSessionText: true, exportTurnBytes: options.exportLimits.turnBytes }
    : readOptions;
  return readSemanticHistoryPageAsync(
    file,
    sessionId,
    claudeAdapter(sessionId, withClaudeRepeated(file, capture)),
    cursor,
    options,
  ).then((result) => {
    if (result.page && !options.exportLimits) {
      withClaudeFirstRequest(file, result.page.compactions, readOptions.childTranscript === true);
    }
    return result;
  });
}
