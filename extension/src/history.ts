import * as fs from 'node:fs';

import {
  AgentKind,
  BackwardLineCursor,
  BackwardRangeReader,
  Compaction,
  FileRevision,
  SessionRead,
  Turn,
  readPreviousLines,
} from './transcript';
import { cloneParserState, ParserLine, BACKGROUND_SCAN_BYTES, BACKGROUND_SCAN_MILLISECONDS } from './parserstate';
import { OversizedRecordReducer } from './oversizedrecord';

export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface ContentAnchor {
  start: number;
  bytes: Buffer;
}

export interface ForwardParserCheckpoint<State> {
  source: AgentKind;
  sessionId: string;
  parserKey: string;
  fileIdentity: FileIdentity;
  revision: FileRevision;
  coveredFrom: number;
  skippedFragment?: Buffer;
  reducedFrom?: number;
  appliedThrough: number;
  lineFragment: Buffer;
  discardUntilNewline: boolean;
  contentAnchor: ContentAnchor;
  parserState: State;
}

export interface ForwardSessionReducer<State> {
  retainedBytes?(): number;
  retainedPayloadScan?(): Generator<void, number>;
  pushLine(line: string | ParserLine): void;
  trimBefore?(offset: number): boolean | void;
  // Invalidate state affected by bytes omitted before the resumed read.
  skipped?(): void;
  snapshot(): State;
  read(readBytes?: number): SessionRead;
  finish(readBytes?: number): SessionRead;
}

export type IncrementalSessionResult<State> =
  | {
      kind: 'reset' | 'appended' | 'reused';
      read: SessionRead;
      checkpoint: ForwardParserCheckpoint<State>;
      readBytes: number;
      appendFrom: FileRevision | null;
    }
  | { kind: 'missing' | 'stale' | 'cancelled'; read: null; checkpoint: null; readBytes: number };

export interface ForwardReadOptions {
  chunkBytes?: number;
  signal?: AbortSignal;
  pause?: () => Promise<void>;
  recovery?: ForwardRecoveryControl;
}

export interface ForwardRecoveryControl {
  through: number;
  readBytes: number;
  retainedCharge: number;
  retainedLimit: number;
  recordLimit: number;
  // An unfinished record larger than this is reduced while it is read, and the record limit applies to the reduced bytes.
  reduceAbove: number;
  accepts(text: string): boolean;
  fragments: Buffer[];
  // Source bytes of the unfinished record, whether held whole or reduced.
  fragmentBytes: number;
  oversized?: OversizedRecordReducer | null;
}

export class ForwardRecoveryLimit extends Error {}

function* frameRecovery<State>(
  reducer: ForwardSessionReducer<State>,
  body: Buffer,
  baseOffset: number,
  control: ForwardRecoveryControl,
): Generator<void, ReturnType<typeof frame>> {
  let start = 0;
  let appliedThrough = baseOffset - control.fragmentBytes;
  function* reconcile(): Generator<void> {
    control.retainedCharge = reducer.retainedPayloadScan
      ? yield* reducer.retainedPayloadScan()
      : (reducer.retainedBytes?.() ?? control.retainedCharge);
  }
  function* reserve(bytes: number): Generator<void> {
    if (control.retainedCharge + bytes > control.retainedLimit) yield* reconcile();
    if (control.retainedCharge + bytes > control.retainedLimit) {
      throw new ForwardRecoveryLimit('Metadata recovery payload limit');
    }
  }
  const consume = function* (end: number, complete: boolean): Generator<void> {
    const length = end - start;
    const total = control.fragmentBytes + length;
    if (!control.oversized && total > control.reduceAbove) {
      control.oversized = new OversizedRecordReducer();
      for (const fragment of control.fragments) control.oversized.push(fragment);
      control.fragments = [];
    }
    const oversized = control.oversized;
    if (oversized && length) oversized.push(body.subarray(start, end));
    const held = oversized ? oversized.bytes : total;
    if (held > control.recordLimit) {
      throw new ForwardRecoveryLimit('Metadata recovery payload limit');
    }
    yield* reserve(held);
    if (!complete) {
      if (length && !oversized) control.fragments.push(Buffer.from(body.subarray(start, end)));
      control.fragmentBytes = total;
      return;
    }
    let bytes: Buffer;
    if (oversized) {
      control.oversized = null;
      // A record that reduces to incomplete JSON passes on, and the parser drops it as it drops any unparseable line.
      bytes = oversized.finish().bytes;
      yield* reserve(bytes.length * 4);
    } else {
      yield* reserve(total * 4);
      bytes = control.fragments.length
        ? Buffer.concat([...control.fragments, body.subarray(start, end)], total)
        : body.subarray(start, end);
    }
    const text = bytes.toString('utf8');
    if (control.accepts(text)) {
      // Charge retained source text conservatively for strings and reducer associations.
      const charge = bytes.length * 8 + 256;
      yield* reserve(charge);
      control.retainedCharge += charge;
      reducer.pushLine({ text, start: appliedThrough, end: baseOffset + end });
    }
    control.fragments = [];
    control.fragmentBytes = 0;
    appliedThrough = baseOffset + end + 1;
    start = end + 1;
  };
  for (let newline = body.indexOf(0x0a); newline >= 0; newline = body.indexOf(0x0a, start)) {
    yield* consume(newline, true);
  }
  yield* consume(body.length, false);
  return { appliedThrough, lineFragment: Buffer.alloc(0), discardUntilNewline: false };
}

export interface BufferedHistoryRecord extends ParserLine {
  start: number;
  end: number;
}

export interface SourceHistoryCursor<State = unknown> {
  source: AgentKind;
  sessionId: string;
  revision: FileRevision;
  end: number;
  fragment: Buffer;
  pageEnd: number;
  heldRecords: BufferedHistoryRecord[];
  adapterState: State;
}

export interface SemanticHistoryPage<State = unknown> {
  source: AgentKind;
  sessionId: string;
  revision: FileRevision;
  ownedRange: { start: number; end: number };
  turns: Turn[];
  compactions: Compaction[];
  recoveryBytes?: number;
  nextOlderCursor: SourceHistoryCursor<State> | null;
}

export type SemanticHistoryResult<State = unknown> =
  | { kind: 'page'; page: SemanticHistoryPage<State>; openRange: { start: number; end: number } | null }
  | { kind: 'missing' | 'stale' | 'cancelled'; page: null; openRange: null };

export interface SemanticParse<State> {
  turns: Array<{ turn: Turn; start: number; end: number }>;
  compactions: Array<{ compaction: Compaction; start: number; end: number }>;
  openRange: { start: number; end: number } | null;
  adapterState: State;
  olderEvidence?: SemanticEvidenceClaim[];
  deferOlderEvidence?: boolean;
}

export interface SemanticEvidenceClaim {
  key: string;
  value: string;
}

export interface SemanticEvidenceScan<State> {
  adapterState: State;
  remaining: SemanticEvidenceClaim[];
}

export interface SemanticSourceAdapter<State> {
  source: AgentKind;
  initialState(file: string, revision: FileRevision): State;
  accepts(record: BufferedHistoryRecord): boolean;
  parse(records: readonly BufferedHistoryRecord[], state: State): SemanticParse<State>;
  scanOlderEvidence?(
    records: readonly BufferedHistoryRecord[],
    claims: readonly SemanticEvidenceClaim[],
    state: State,
    atBeginning: boolean,
  ): SemanticEvidenceScan<State>;
  stateForOlder?(parsed: SemanticParse<State>, pageStart: number): State;
}

export interface SemanticHistoryOptions {
  chunkBytes?: number;
  targetTurns?: number;
  readRange?: BackwardRangeReader;
  evidenceReadRange?: BackwardRangeReader;
  signal?: AbortSignal;
  pause?: () => Promise<void>;
}

const CONTENT_ANCHOR_BYTES = 4096;
const DEFAULT_FORWARD_BYTES = 4 * 1024 * 1024;

function revisionOf(stat: fs.Stats): FileRevision {
  return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
}

function sameRevision(a: FileRevision, b: FileRevision): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino;
}

function sameIdentity(identity: FileIdentity, revision: FileRevision): boolean {
  return identity.dev === revision.dev && identity.ino === revision.ino;
}

function revisionFor(file: string): FileRevision | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    return revisionOf(fs.fstatSync(fd));
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function readStableRange(file: string, start: number, length: number, revision: FileRevision): Buffer | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    if (!sameRevision(revisionOf(fs.fstatSync(fd)), revision)) {
      return null;
    }
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(fd, buffer, read, length - read, start + read);
      if (count <= 0) {
        return null;
      }
      read += count;
    }
    if (!sameRevision(revisionOf(fs.fstatSync(fd)), revision)) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function anchorFor(
  file: string,
  revision: FileRevision,
  appliedThrough: number,
  readRange: BackwardRangeReader,
): ContentAnchor | null {
  const start = Math.max(0, appliedThrough - CONTENT_ANCHOR_BYTES);
  const bytes = readRange(file, start, appliedThrough - start, revision);
  return bytes ? { start, bytes } : null;
}

function frame<State>(
  reducer: ForwardSessionReducer<State>,
  body: Buffer,
  baseOffset: number,
  discardUntilNewline = false,
): { appliedThrough: number; lineFragment: Buffer; discardUntilNewline: boolean } {
  let lineStart = 0;
  if (discardUntilNewline) {
    const firstNewline = body.indexOf(0x0a);
    if (firstNewline < 0) {
      return {
        appliedThrough: baseOffset + body.length,
        lineFragment: Buffer.alloc(0),
        discardUntilNewline: true,
      };
    }
    lineStart = firstNewline + 1;
    discardUntilNewline = false;
  }
  let newline = body.indexOf(0x0a);
  if (newline >= 0 && newline < lineStart) {
    newline = body.indexOf(0x0a, lineStart);
  }
  while (newline >= 0) {
    reducer.pushLine({
      text: body.subarray(lineStart, newline).toString('utf8'),
      start: baseOffset + lineStart,
      end: baseOffset + newline,
    });
    lineStart = newline + 1;
    newline = body.indexOf(0x0a, lineStart);
  }
  return {
    appliedThrough: baseOffset + lineStart,
    lineFragment: Buffer.from(body.subarray(lineStart)),
    discardUntilNewline,
  };
}

function materialize<State>(
  reducer: ForwardSessionReducer<State>,
  checkpoint: ForwardParserCheckpoint<State>,
  coveredBytes: number,
): SessionRead {
  if (checkpoint.lineFragment.length) {
    reducer.pushLine({
      text: checkpoint.lineFragment.toString('utf8'),
      start: checkpoint.appliedThrough,
      end: checkpoint.appliedThrough + checkpoint.lineFragment.length,
    });
  }
  return reducer.finish(coveredBytes);
}

function firstRetainedRecordOffset(coveredFrom: number): number {
  // A tail beginning inside a file discards its first line even when the requested byte is
  // exactly that line's start. Byte zero is different because a whole-file read keeps it.
  return coveredFrom > 0 ? coveredFrom + 1 : 0;
}

function* scanForwardSession<State>(
  file: string,
  source: AgentKind,
  sessionId: string,
  factory: (restored?: State) => ForwardSessionReducer<State>,
  checkpoint?: ForwardParserCheckpoint<State>,
  readRange: BackwardRangeReader = readStableRange,
  parserKey = '',
  maxReadBytes = DEFAULT_FORWARD_BYTES,
  work: ForwardReadOptions = {},
): Generator<void, IncrementalSessionResult<State>> {
  let revision = revisionFor(file);
  if (!revision) {
    return { kind: 'missing', read: null, checkpoint: null, readBytes: 0 };
  }
  const compatible =
    checkpoint &&
    checkpoint.source === source &&
    checkpoint.sessionId === sessionId &&
    checkpoint.parserKey === parserKey &&
    sameIdentity(checkpoint.fileIdentity, revision) &&
    checkpoint.revision.size <= revision.size &&
    checkpoint.appliedThrough <= checkpoint.revision.size;
  let dormantAppend = false;
  if (compatible && checkpoint && revision.size - checkpoint.appliedThrough > maxReadBytes) {
    try {
      dormantAppend = factory(checkpoint.parserState)
        .read()
        .turns.every((turn) => turn.finished);
    } catch {
      dormantAppend = false;
    }
  }
  if (compatible && checkpoint && sameRevision(checkpoint.revision, revision)) {
    try {
      const reducer = factory(checkpoint.parserState);
      return {
        kind: 'reused',
        read: materialize(reducer, checkpoint, checkpoint.revision.size - checkpoint.coveredFrom),
        checkpoint,
        readBytes: 0,
        appendFrom: null,
      };
    } catch {
      return yield* scanForwardSession(
        file,
        source,
        sessionId,
        factory,
        undefined,
        readRange,
        parserKey,
        maxReadBytes,
        work,
      );
    }
  }

  const savedAnchor =
    compatible && checkpoint
      ? readRange(file, checkpoint.contentAnchor.start, checkpoint.contentAnchor.bytes.length, revision)
      : null;
  const anchorMatches = checkpoint && savedAnchor?.equals(checkpoint.contentAnchor.bytes) === true;
  let kind: 'reset' | 'appended' = 'reset';
  let start = Math.max(0, revision.size - Math.max(0, Math.floor(maxReadBytes)));
  let coveredFrom = start;
  let discardUntilNewline = start > 0;
  let reducer: ForwardSessionReducer<State>;
  if (compatible && checkpoint && revision.size > checkpoint.revision.size && anchorMatches) {
    try {
      reducer = factory(checkpoint.parserState);
      kind = 'appended';
      start = checkpoint.appliedThrough;
      coveredFrom = checkpoint.coveredFrom;
      discardUntilNewline = checkpoint.discardUntilNewline;
      if (dormantAppend) {
        start = Math.max(checkpoint.appliedThrough, revision.size - maxReadBytes);
        coveredFrom = start;
        discardUntilNewline = start > 0;
        reducer.skipped?.();
      }
    } catch {
      reducer = factory();
    }
  } else {
    reducer = factory();
  }

  if (kind === 'appended' && checkpoint && start === checkpoint.appliedThrough && checkpoint.lineFragment.length) {
    const held = readRange(file, start, checkpoint.lineFragment.length, revision);
    if (!held?.equals(checkpoint.lineFragment)) {
      return yield* scanForwardSession(
        file,
        source,
        sessionId,
        factory,
        undefined,
        readRange,
        parserKey,
        maxReadBytes,
        work,
      );
    }
  }
  const chunkBytes = Math.max(1, Math.floor(work.chunkBytes ?? Number.MAX_SAFE_INTEGER));
  let framed: ReturnType<typeof frame> = { appliedThrough: start, lineFragment: Buffer.alloc(0), discardUntilNewline };
  let readBytes = 0;
  let skippedFragment =
    kind === 'appended' && start === checkpoint?.appliedThrough ? checkpoint.skippedFragment : Buffer.alloc(0);
  let collectingSkipped = discardUntilNewline;
  let recoveryAnchor: ContentAnchor = { start: 0, bytes: Buffer.alloc(0) };
  for (let offset = start; ;) {
    if (work.recovery && offset > 0) {
      const current = revisionFor(file);
      if (!current || !sameRevision(current, revision)) {
        const anchorStart = Math.max(0, offset - CONTENT_ANCHOR_BYTES);
        const prior = readRange(file, anchorStart, offset - anchorStart, current ?? revision);
        if (
          !current ||
          !sameIdentity(revision, current) ||
          current.size <= revision.size ||
          !prior?.equals(recoveryAnchor.bytes)
        ) {
          return { kind: 'stale', read: null, checkpoint: null, readBytes };
        }
        revision = current;
      }
    }
    if (offset >= revision.size) break;
    if (work.signal?.aborted) {
      return { kind: 'cancelled', read: null, checkpoint: null, readBytes };
    }
    const length = Math.min(work.recovery ? (work.chunkBytes ?? chunkBytes) : chunkBytes, revision.size - offset);
    const body = readRange(file, offset, length, revision);
    if (!body) {
      return { kind: 'stale', read: null, checkpoint: null, readBytes };
    }
    if (collectingSkipped) {
      const newline = body.indexOf(0x0a);
      skippedFragment = Buffer.concat([
        skippedFragment ?? Buffer.alloc(0),
        newline < 0 ? body : body.subarray(0, newline),
      ]);
      collectingSkipped = newline < 0;
    }
    if (work.recovery) {
      framed = yield* frameRecovery(reducer, body, offset, work.recovery);
    } else {
      const input = framed.lineFragment.length ? Buffer.concat([framed.lineFragment, body]) : body;
      framed = frame(reducer, input, framed.appliedThrough, framed.discardUntilNewline);
    }
    offset += length;
    readBytes += length;
    if (work.recovery) {
      work.recovery.through = offset;
      work.recovery.readBytes = readBytes;
      recoveryAnchor = {
        start: Math.max(0, offset - CONTENT_ANCHOR_BYTES),
        bytes:
          body.length >= CONTENT_ANCHOR_BYTES
            ? Buffer.from(body.subarray(body.length - CONTENT_ANCHOR_BYTES))
            : Buffer.concat([recoveryAnchor.bytes, body]).subarray(-CONTENT_ANCHOR_BYTES),
      };
    }
    yield;
  }
  if (work.signal?.aborted) {
    return { kind: 'cancelled', read: null, checkpoint: null, readBytes };
  }
  if (work.recovery?.fragmentBytes) {
    const control = work.recovery;
    yield* frameRecovery(reducer, Buffer.from('\n'), revision.size, control);
    framed.appliedThrough = revision.size;
  }
  if (kind === 'appended') {
    coveredFrom = Math.max(coveredFrom, revision.size - Math.max(0, Math.floor(maxReadBytes)));
  }
  const resetForWindow = reducer.trimBefore?.(firstRetainedRecordOffset(coveredFrom)) === true;
  if (kind === 'appended' && resetForWindow) {
    const reset = yield* scanForwardSession(
      file,
      source,
      sessionId,
      factory,
      undefined,
      readRange,
      parserKey,
      maxReadBytes,
      work,
    );
    return reset.read && reset.checkpoint && checkpoint && sameRevision(reset.checkpoint.revision, revision)
      ? { ...reset, appendFrom: checkpoint.revision }
      : reset;
  }
  const anchor = anchorFor(file, revision, framed.appliedThrough, readRange);
  if (!anchor) {
    return { kind: 'stale', read: null, checkpoint: null, readBytes };
  }
  const next: ForwardParserCheckpoint<State> = {
    source,
    sessionId,
    parserKey,
    fileIdentity: { dev: revision.dev, ino: revision.ino },
    revision,
    coveredFrom,
    skippedFragment,
    reducedFrom:
      kind === 'appended' && start === checkpoint?.appliedThrough
        ? (checkpoint.reducedFrom ?? checkpoint.coveredFrom)
        : start,
    appliedThrough: framed.appliedThrough,
    lineFragment: framed.lineFragment,
    discardUntilNewline: framed.discardUntilNewline,
    contentAnchor: anchor,
    parserState: reducer.snapshot(),
  };
  return {
    kind,
    read: materialize(reducer, next, revision.size - coveredFrom),
    checkpoint: next,
    readBytes,
    appendFrom: kind === 'appended' && checkpoint ? checkpoint.revision : null,
  };
}

export function readForwardSession<State>(
  file: string,
  source: AgentKind,
  sessionId: string,
  factory: (restored?: State) => ForwardSessionReducer<State>,
  checkpoint?: ForwardParserCheckpoint<State>,
  readRange?: BackwardRangeReader,
  parserKey = '',
  maxReadBytes = DEFAULT_FORWARD_BYTES,
): IncrementalSessionResult<State> {
  const scan = scanForwardSession(file, source, sessionId, factory, checkpoint, readRange, parserKey, maxReadBytes);
  let next = scan.next();
  while (!next.done) {
    next = scan.next();
  }
  return next.value;
}

export function beginForwardSessionRecovery<State>(
  file: string,
  source: AgentKind,
  sessionId: string,
  factory: () => ForwardSessionReducer<State>,
  work: ForwardReadOptions & { recovery: ForwardRecoveryControl },
): Generator<void, IncrementalSessionResult<State>> {
  return scanForwardSession(file, source, sessionId, factory, undefined, undefined, '', Number.MAX_SAFE_INTEGER, work);
}

export async function readForwardSessionAsync<State>(
  file: string,
  source: AgentKind,
  sessionId: string,
  factory: (restored?: State) => ForwardSessionReducer<State>,
  checkpoint?: ForwardParserCheckpoint<State>,
  readRange?: BackwardRangeReader,
  parserKey = '',
  maxReadBytes = DEFAULT_FORWARD_BYTES,
  work: ForwardReadOptions = {},
): Promise<IncrementalSessionResult<State>> {
  const scan = scanForwardSession(file, source, sessionId, factory, checkpoint, readRange, parserKey, maxReadBytes, {
    ...work,
    chunkBytes: work.chunkBytes ?? 256 * 1024,
  });
  let next = scan.next();
  while (!next.done) {
    if (work.pause) {
      await work.pause();
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    next = scan.next();
  }
  return next.value;
}

function startHistoryCursor<State>(
  revision: FileRevision,
  source: AgentKind,
  sessionId: string,
  adapterState: State,
): SourceHistoryCursor<State> {
  return {
    source,
    sessionId,
    revision,
    end: revision.size,
    fragment: Buffer.alloc(0),
    pageEnd: revision.size,
    heldRecords: [],
    adapterState: cloneParserState(adapterState),
  };
}

function initialHistoryCursor<State>(
  file: string,
  sessionId: string,
  adapter: SemanticSourceAdapter<State>,
): { kind: 'ready'; cursor: SourceHistoryCursor<State> } | { kind: 'missing' | 'stale' } {
  const revision = revisionFor(file);
  if (!revision) {
    return { kind: 'missing' };
  }
  const state = adapter.initialState(file, revision);
  const confirmed = revisionFor(file);
  if (!confirmed) {
    return { kind: 'missing' };
  }
  if (!sameRevision(revision, confirmed)) {
    return { kind: 'stale' };
  }
  return { kind: 'ready', cursor: startHistoryCursor(revision, adapter.source, sessionId, state) };
}

function* scanSemanticHistoryPage<State>(
  file: string,
  sessionId: string,
  adapter: SemanticSourceAdapter<State>,
  initial: SourceHistoryCursor<State> | null,
  options: SemanticHistoryOptions = {},
): Generator<void, SemanticHistoryResult<State>, void> {
  const started = initial ? null : initialHistoryCursor(file, sessionId, adapter);
  if (started && started.kind !== 'ready') {
    return { kind: started.kind, page: null, openRange: null };
  }
  let cursor = initial ?? (started as { kind: 'ready'; cursor: SourceHistoryCursor<State> }).cursor;
  if (cursor.source !== adapter.source || cursor.sessionId !== sessionId) {
    const reset = initialHistoryCursor(file, sessionId, adapter);
    if (reset.kind !== 'ready') {
      return { kind: reset.kind, page: null, openRange: null };
    }
    cursor = reset.cursor;
  }
  const current = revisionFor(file);
  if (!current) {
    return { kind: 'missing', page: null, openRange: null };
  }
  if (!sameRevision(current, cursor.revision)) {
    return { kind: 'stale', page: null, openRange: null };
  }

  const targetTurns = Math.max(1, options.targetTurns ?? 20);
  const chunkBytes = Math.max(1, options.chunkBytes ?? 1024 * 1024);
  let held = cloneParserState(cursor.heldRecords);
  let heldBytes = held.reduce((total, record) => total + Math.max(1, record.end - record.start), 0);
  let parsedBytes = 0;
  let parseState = cloneParserState(cursor.adapterState);
  let byteCursor: BackwardLineCursor = {
    revision: cursor.revision,
    end: cursor.end,
    fragment: Buffer.from(cursor.fragment),
  };
  let parsed: SemanticParse<State> | null = null;
  let olderEvidenceExhausted = false;
  let recoveryBytes = 0;
  while (true) {
    if (options.signal?.aborted) {
      return { kind: 'cancelled', page: null, openRange: null };
    }
    if (byteCursor.end > 0) {
      const batch = readPreviousLines(file, byteCursor, chunkBytes, options.readRange);
      if (!batch) {
        return { kind: 'stale', page: null, openRange: null };
      }
      const older = [...batch.lines]
        .reverse()
        .map((line): BufferedHistoryRecord => ({
          text: line.text,
          start: line.offset,
          end: line.offset + Buffer.byteLength(line.text),
        }))
        .filter((record) => adapter.accepts(record));
      if (older.length) {
        held = [...older, ...held];
        heldBytes += older.reduce((total, record) => total + Math.max(1, record.end - record.start), 0);
        parsed = null;
      }
      byteCursor = batch.cursor;
      yield;
    }

    // Rebuild the reducer when the first relevant older batch arrives, retained input doubles, or the scan reaches byte zero.
    // Doubling limits repeated parsing while allowing an early stop at a nearby page boundary.
    const atBeginning = byteCursor.end === 0;
    if (parsed === null && !atBeginning && parsedBytes > 0 && heldBytes < parsedBytes * 2) {
      continue;
    }
    parsed ??= adapter.parse(held, parseState);
    parsedBytes = heldBytes;
    if (parsed.deferOlderEvidence && !atBeginning) {
      continue;
    }
    if (!olderEvidenceExhausted && parsed.olderEvidence?.length && adapter.scanOlderEvidence) {
      let evidenceCursor: BackwardLineCursor = {
        revision: byteCursor.revision,
        end: byteCursor.end,
        fragment: Buffer.from(byteCursor.fragment),
      };
      let evidenceState = parsed.adapterState;
      let remaining = parsed.olderEvidence;
      let evidenceSliceBytes = 0;
      let evidenceDeadline = performance.now() + BACKGROUND_SCAN_MILLISECONDS;
      while (remaining.length) {
        if (options.signal?.aborted) {
          return { kind: 'cancelled', page: null, openRange: null };
        }
        if (evidenceCursor.end === 0) {
          const scanned = adapter.scanOlderEvidence([], remaining, evidenceState, true);
          evidenceState = scanned.adapterState;
          remaining = scanned.remaining;
          olderEvidenceExhausted = true;
          break;
        }
        const batch = readPreviousLines(
          file,
          evidenceCursor,
          Math.min(chunkBytes, BACKGROUND_SCAN_BYTES - evidenceSliceBytes),
          options.evidenceReadRange,
        );
        if (!batch) {
          return { kind: 'stale', page: null, openRange: null };
        }
        const evidenceBytes = evidenceCursor.end - batch.cursor.end;
        recoveryBytes += evidenceBytes;
        evidenceSliceBytes += evidenceBytes;
        const records = [...batch.lines]
          .reverse()
          .map((line): BufferedHistoryRecord => ({
            text: line.text,
            start: line.offset,
            end: line.offset + Buffer.byteLength(line.text),
          }))
          .filter((record) => adapter.accepts(record));
        evidenceCursor = batch.cursor;
        const scanned = adapter.scanOlderEvidence(records, remaining, evidenceState, evidenceCursor.end === 0);
        evidenceState = scanned.adapterState;
        remaining = scanned.remaining;
        if (evidenceCursor.end === 0) {
          olderEvidenceExhausted = true;
        }
        if (
          remaining.length === 0 ||
          evidenceSliceBytes >= BACKGROUND_SCAN_BYTES ||
          performance.now() >= evidenceDeadline
        ) {
          yield;
          evidenceSliceBytes = 0;
          evidenceDeadline = performance.now() + BACKGROUND_SCAN_MILLISECONDS;
        }
      }
      parseState = evidenceState;
      parsed = adapter.parse(held, parseState);
      parsedBytes = heldBytes;
      if (!olderEvidenceExhausted) {
        continue;
      }
    }
    const semanticEnd = Math.min(cursor.pageEnd, parsed.openRange?.start ?? cursor.pageEnd);
    const complete = parsed.turns.filter((entry) => entry.end <= semanticEnd);
    // Read one additional complete turn before publishing a page.
    // Its records establish the older boundary, including preceding turn_context and queued associations.
    if (complete.length < targetTurns + 1 && !atBeginning) {
      continue;
    }

    const selected = complete.slice(-targetTurns);
    const pageStart = atBeginning && complete.length <= targetTurns ? 0 : (selected[0]?.start ?? semanticEnd);
    const selectedRanges = new Set(selected.map(({ start, end }) => `${start}:${end}`));
    const turns = selected.map(({ turn }) => turn);
    const compactions = parsed.compactions
      .filter((entry) => entry.start >= pageStart && entry.end <= semanticEnd)
      .map(({ compaction }) => compaction);
    const nextHeld = held.filter((record) => record.end <= pageStart || record.start === pageStart);
    const nextAdapterState = adapter.stateForOlder ? adapter.stateForOlder(parsed, pageStart) : parsed.adapterState;
    const hasOlder = pageStart > 0 && (byteCursor.end > 0 || nextHeld.length > 0);
    const nextOlderCursor: SourceHistoryCursor<State> | null = hasOlder
      ? {
          source: adapter.source,
          sessionId,
          revision: cursor.revision,
          end: byteCursor.end,
          fragment: Buffer.from(byteCursor.fragment),
          pageEnd: pageStart,
          heldRecords: nextHeld,
          adapterState: cloneParserState(nextAdapterState),
        }
      : null;
    // Reject duplicate source ranges within the selected page.
    if (selectedRanges.size !== turns.length) {
      throw new Error('A semantic page contained a duplicate source range');
    }
    return {
      kind: 'page',
      page: {
        source: adapter.source,
        sessionId,
        revision: cursor.revision,
        ownedRange: { start: pageStart, end: semanticEnd },
        turns,
        compactions,
        recoveryBytes,
        nextOlderCursor,
      },
      openRange: parsed.openRange,
    };
  }
}

export function readSemanticHistoryPage<State>(
  file: string,
  sessionId: string,
  adapter: SemanticSourceAdapter<State>,
  initial: SourceHistoryCursor<State> | null,
  options: SemanticHistoryOptions = {},
): SemanticHistoryResult<State> {
  const scan = scanSemanticHistoryPage(file, sessionId, adapter, initial, options);
  let next = scan.next();
  while (!next.done) {
    next = scan.next();
  }
  return next.value;
}

export async function readSemanticHistoryPageAsync<State>(
  file: string,
  sessionId: string,
  adapter: SemanticSourceAdapter<State>,
  initial: SourceHistoryCursor<State> | null,
  options: SemanticHistoryOptions = {},
): Promise<SemanticHistoryResult<State>> {
  const scan = scanSemanticHistoryPage(file, sessionId, adapter, initial, options);
  let next = scan.next();
  while (!next.done) {
    if (options.signal?.aborted) {
      return { kind: 'cancelled', page: null, openRange: null };
    }
    if (options.pause) {
      await options.pause();
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    next = scan.next();
  }
  return next.value;
}
