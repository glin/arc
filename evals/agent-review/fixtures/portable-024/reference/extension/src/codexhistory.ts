import {
  CodexReadOptions,
  CodexSessionMeta,
  CodexSessionParserState,
  codexSessionLineMayAffectRead,
  createCodexSessionReducer,
  createCodexUsageLineReducer,
  emptyCodexUsageReducerState,
  readCodexSessionMeta,
} from './codex';
import { normalizeSessionTitle } from './transcript';
import {
  ForwardParserCheckpoint,
  IncrementalSessionResult,
  SemanticHistoryOptions,
  SemanticEvidenceClaim,
  SemanticHistoryResult,
  SemanticSourceAdapter,
  SourceHistoryCursor,
  readForwardSession,
  readForwardSessionAsync,
  ForwardReadOptions,
  readSemanticHistoryPage,
  readSemanticHistoryPageAsync,
} from './history';

interface CodexBackwardState {
  meta: CodexSessionMeta | null;
  copiedTurnIds: string[];
  copiedTurnRanges: Array<{ id: string; start: number; end: number } | null>;
  resolvedLegacyRanges: string[];
  evidenceTurnOffsets: Record<string, number>;
  evidenceReachedBeginning: boolean;
}

export type CodexForwardCheckpoint = ForwardParserCheckpoint<CodexSessionParserState>;
export type CodexHistoryCursor = SourceHistoryCursor<CodexBackwardState>;
export type CodexHistoryPageResult = SemanticHistoryResult<CodexBackwardState>;

const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;
const EVIDENCE_TURN_LIMIT = 64;

function codexParserKey(opts: CodexReadOptions): string {
  return JSON.stringify({
    version: 6,
    tailBytes: opts.tailBytes ?? DEFAULT_TAIL_BYTES,
    maxTurns: opts.maxTurns ?? 40,
    sessionTitle: normalizeSessionTitle(opts.sessionTitle),
  });
}

export function readCodexSessionIncremental(
  file: string,
  sessionId: string,
  checkpoint?: CodexForwardCheckpoint,
  opts: CodexReadOptions = {},
): IncrementalSessionResult<CodexSessionParserState> {
  let meta: CodexSessionMeta | null | undefined;
  const result = readForwardSession(
    file,
    'codex',
    sessionId,
    (restored) => {
      if (!restored && meta === undefined) {
        meta = readCodexSessionMeta(file);
      }
      return createCodexSessionReducer(sessionId, opts, restored ? null : (meta ?? null), restored);
    },
    checkpoint,
    undefined,
    codexParserKey(opts),
    opts.tailBytes ?? DEFAULT_TAIL_BYTES,
  );
  return result;
}

export function readCodexSessionIncrementalAsync(
  file: string,
  sessionId: string,
  checkpoint?: CodexForwardCheckpoint,
  opts: CodexReadOptions = {},
  work: ForwardReadOptions = {},
): Promise<IncrementalSessionResult<CodexSessionParserState>> {
  let meta: CodexSessionMeta | null | undefined;
  return readForwardSessionAsync(
    file,
    'codex',
    sessionId,
    (restored) => {
      if (!restored && meta === undefined) {
        meta = readCodexSessionMeta(file);
      }
      return createCodexSessionReducer(sessionId, opts, restored ? null : (meta ?? null), restored);
    },
    checkpoint,
    undefined,
    codexParserKey(opts),
    opts.tailBytes ?? DEFAULT_TAIL_BYTES,
    work,
  );
}

function codexAdapter(
  sessionId: string,
  opts: CodexReadOptions,
  initialMeta: CodexSessionMeta | null | undefined,
  targetTurns: number,
): SemanticSourceAdapter<CodexBackwardState> {
  return {
    source: 'codex',
    initialState: (file) => ({
      meta: initialMeta === undefined ? readCodexSessionMeta(file) : initialMeta,
      copiedTurnIds: [],
      copiedTurnRanges: [],
      resolvedLegacyRanges: [],
      evidenceTurnOffsets: {},
      evidenceReachedBeginning: false,
    }),
    accepts: (record) => codexSessionLineMayAffectRead(record.text),
    parse: (records, backward) => {
      const reducer = createCodexSessionReducer(
        sessionId,
        { ...opts, maxTurns: Number.MAX_SAFE_INTEGER },
        backward.meta,
      );
      const classifier = createCodexUsageLineReducer(
        emptyCodexUsageReducerState(
          backward.meta?.modelProvider ?? null,
          backward.meta?.replayBoundaryAt ?? null,
          backward.meta?.sessionId ?? null,
          backward.meta?.agentPath ?? null,
        ),
      );
      for (const record of records) {
        reducer.pushLine(record);
        classifier.pushLine(record.text);
      }
      const snapshot = reducer.snapshot();
      const localCopied = Object.keys(classifier.snapshot().datedCopiedTurnIds);
      const copied = backward.copiedTurnIds.map((id, index) => ({
        id,
        range: backward.copiedTurnRanges[index] ?? null,
      }));
      for (const id of localCopied) {
        if (!copied.some((entry) => entry.id === id)) {
          copied.push({ id, range: null });
        }
      }
      const turns = reducer.completedTurns();
      const removed = new Set<number>();
      const copiedTurnRanges: CodexBackwardState['copiedTurnRanges'] = [];
      for (const copiedTurn of copied) {
        let match = -1;
        if (copiedTurn.range) {
          match = turns.findIndex(
            (turn, index) =>
              !removed.has(index) && turn.start === copiedTurn.range!.start && turn.end === copiedTurn.range!.end,
          );
        } else {
          for (let index = turns.length - 1; index >= 0; index--) {
            if (!removed.has(index) && turns[index].turn.promptId === copiedTurn.id) {
              match = index;
              break;
            }
          }
        }
        if (match >= 0) {
          removed.add(match);
          copiedTurnRanges.push({ id: copiedTurn.id, start: turns[match].start, end: turns[match].end });
        } else {
          copiedTurnRanges.push(copiedTurn.range);
        }
      }
      const visibleTurns = turns.filter((_turn, index) => !removed.has(index));
      const remainingPending = new Map<string, number>();
      for (const id of snapshot.pendingClassification) {
        remainingPending.set(id, (remainingPending.get(id) ?? 0) + 1);
      }
      const pendingIndexes = new Set<number>();
      for (let index = visibleTurns.length - 1; index >= 0; index--) {
        const id = visibleTurns[index].turn.promptId;
        const remaining = remainingPending.get(id) ?? 0;
        if (remaining <= 0) {
          continue;
        }
        pendingIndexes.add(index);
        remainingPending.set(id, remaining - 1);
      }
      const resolved = new Set(backward.resolvedLegacyRanges);
      const olderEvidence: SemanticEvidenceClaim[] =
        visibleTurns.length >= targetTurns + 1
          ? [...pendingIndexes]
              .map((index) => ({
                key: `${visibleTurns[index].start}:${visibleTurns[index].end}`,
                value: visibleTurns[index].turn.promptId,
              }))
              .filter((claim) => claim.value.length > 0)
              .filter((claim) => !resolved.has(claim.key))
          : [];
      const oldestPendingIndex = pendingIndexes.size ? Math.min(...pendingIndexes) : -1;
      return {
        turns: visibleTurns,
        compactions: reducer.completedCompactions(),
        openRange: reducer.openRange(),
        adapterState: {
          meta: backward.meta,
          copiedTurnIds: copied.map((entry) => entry.id),
          copiedTurnRanges,
          resolvedLegacyRanges: backward.resolvedLegacyRanges,
          evidenceTurnOffsets: backward.evidenceTurnOffsets ?? {},
          evidenceReachedBeginning: backward.evidenceReachedBeginning ?? false,
        },
        olderEvidence,
        deferOlderEvidence:
          olderEvidence.length > 0 && oldestPendingIndex === 0 && olderEvidence.length < EVIDENCE_TURN_LIMIT,
      };
    },
    scanOlderEvidence: (records, claims, backward, atBeginning) => {
      const found = new Set<string>();
      const evidenceTurnOffsets = { ...(backward.evidenceTurnOffsets ?? {}) };
      let trackedTurns = Object.keys(evidenceTurnOffsets).length;
      for (const claim of claims) {
        if (Object.hasOwn(evidenceTurnOffsets, claim.value) || trackedTurns >= EVIDENCE_TURN_LIMIT) {
          continue;
        }
        evidenceTurnOffsets[claim.value] = Number.MAX_SAFE_INTEGER;
        trackedTurns++;
      }
      for (const record of records) {
        if (record.text.indexOf('task_started') < 0) {
          continue;
        }
        try {
          const parsed = JSON.parse(record.text) as { type?: unknown; payload?: Record<string, unknown> };
          const payload = parsed.payload;
          if (!payload || (parsed.type !== 'event_msg' && parsed.type !== 'task_started')) {
            continue;
          }
          const kind = parsed.type === 'event_msg' ? payload.type : parsed.type;
          if (kind === 'task_started' && typeof payload.turn_id === 'string' && payload.turn_id.length > 0) {
            const id = payload.turn_id;
            found.add(id);
            if (Object.hasOwn(evidenceTurnOffsets, id)) {
              evidenceTurnOffsets[id] = Math.min(evidenceTurnOffsets[id], record.start);
            } else if (trackedTurns < EVIDENCE_TURN_LIMIT) {
              evidenceTurnOffsets[id] = record.start;
              trackedTurns++;
            }
          }
        } catch {
          /* malformed records do not classify a turn */
        }
      }
      const copiedTurnIds = [...backward.copiedTurnIds];
      const copiedTurnRanges = [...backward.copiedTurnRanges];
      const resolvedLegacyRanges = [...backward.resolvedLegacyRanges];
      const remaining: SemanticEvidenceClaim[] = [];
      for (const claim of claims) {
        const separator = claim.key.indexOf(':');
        const start = Number(claim.key.slice(0, separator));
        const end = Number(claim.key.slice(separator + 1));
        const earlierOffset = evidenceTurnOffsets[claim.value];
        if (
          found.has(claim.value) ||
          (Number.isFinite(start) && earlierOffset !== undefined && earlierOffset < start)
        ) {
          copiedTurnIds.push(claim.value);
          copiedTurnRanges.push(
            Number.isFinite(start) && Number.isFinite(end) ? { id: claim.value, start, end } : null,
          );
          resolvedLegacyRanges.push(claim.key);
        } else if (atBeginning || (backward.evidenceReachedBeginning && earlierOffset === start)) {
          resolvedLegacyRanges.push(claim.key);
        } else {
          remaining.push(claim);
        }
      }
      return {
        adapterState: {
          meta: backward.meta,
          copiedTurnIds,
          copiedTurnRanges,
          resolvedLegacyRanges,
          evidenceTurnOffsets,
          evidenceReachedBeginning: backward.evidenceReachedBeginning || atBeginning,
        },
        remaining,
      };
    },
    stateForOlder: (parsed, pageStart) => {
      const copiedTurnIds: string[] = [];
      const copiedTurnRanges: CodexBackwardState['copiedTurnRanges'] = [];
      for (let index = 0; index < parsed.adapterState.copiedTurnIds.length; index++) {
        const range = parsed.adapterState.copiedTurnRanges[index] ?? null;
        if (range && range.start >= pageStart) {
          continue;
        }
        copiedTurnIds.push(parsed.adapterState.copiedTurnIds[index]);
        copiedTurnRanges.push(null);
      }
      const resolvedLegacyRanges = parsed.adapterState.resolvedLegacyRanges.filter((key) => {
        const start = Number(key.slice(0, key.indexOf(':')));
        return Number.isFinite(start) && start < pageStart;
      });
      const evidenceTurnOffsets = Object.fromEntries(
        Object.entries(parsed.adapterState.evidenceTurnOffsets ?? {}).filter(([, start]) => start < pageStart),
      );
      return {
        meta: parsed.adapterState.meta,
        copiedTurnIds,
        copiedTurnRanges,
        resolvedLegacyRanges,
        evidenceTurnOffsets,
        evidenceReachedBeginning: parsed.adapterState.evidenceReachedBeginning ?? false,
      };
    },
  };
}

function cursorMetaForSession(
  cursor: CodexHistoryCursor | null,
  sessionId: string,
): CodexSessionMeta | null | undefined {
  return cursor?.source === 'codex' && cursor.sessionId === sessionId ? cursor.adapterState.meta : undefined;
}

export function readCodexHistoryPage(
  file: string,
  sessionId: string,
  cursor: CodexHistoryCursor | null = null,
  options: SemanticHistoryOptions = {},
  readOptions: CodexReadOptions = {},
): CodexHistoryPageResult {
  return readSemanticHistoryPage(
    file,
    sessionId,
    codexAdapter(
      sessionId,
      readOptions,
      cursorMetaForSession(cursor, sessionId),
      Math.max(1, options.targetTurns ?? 20),
    ),
    cursor,
    options,
  );
}

export function readCodexHistoryPageAsync(
  file: string,
  sessionId: string,
  cursor: CodexHistoryCursor | null = null,
  options: SemanticHistoryOptions = {},
  readOptions: CodexReadOptions = {},
): Promise<CodexHistoryPageResult> {
  return readSemanticHistoryPageAsync(
    file,
    sessionId,
    codexAdapter(
      sessionId,
      readOptions,
      cursorMetaForSession(cursor, sessionId),
      Math.max(1, options.targetTurns ?? 20),
    ),
    cursor,
    options,
  );
}
