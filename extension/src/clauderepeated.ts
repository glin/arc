import * as fs from 'node:fs';
import { meterRead } from './readmeter';

// Claude Code can append a repeat of earlier transcript records to the same file. A repeated
// record keeps its original top-level `uuid` and `timestamp`. `docs/timeline.md` describes the shape and
// the rule under "Claude repeated records". A record is a repeated record when an earlier record in the same
// file has the same top-level `uuid` and `timestamp`. Every reader applies that rule through
// `ClaudeRepeatedDetector`, so a record classifies the same in a whole-file read and in resumed slices.
//
// The first record with an identity raises the newest timestamp to at least its own, so a repeated
// record is never newer than the newest record read before it. Only those records need a lookup. The
// detector keeps a checkpoint about once per MiB: a line start, the newest timestamp before that
// line, and the oldest timestamp of a first record inside the interval it opens. The original of a
// repeated record lies in an interval whose oldest first record is not newer than the repeated record, at
// or after the last checkpoint older than it. A lookup reads only those intervals.
//
// A repeated run repeats an earlier run of records in order. The detector saves the byte offset after
// the original of the last repeated record it found, and a lookup reads the next few records from there before
// it reads any interval. A slice that resumes inside a run then reads each original once, in order.

export const CLAUDE_REPEATED_CHECKPOINT_BYTES = 1024 * 1024;

// The oldest timestamp of an interval that holds no first record with an identity.
const NO_RECORD = Number.MAX_SAFE_INTEGER;

// The saved detector for one file, beside the byte offset its reader resumes from.
export interface ClaudeRepeatedState {
  // Byte offset after the last line the detector classified.
  through: number;
  // Newest record timestamp read, epoch milliseconds. Zero before the first record.
  newest: number;
  // Triples in file order: a line start, the newest timestamp read before that line, and the
  // oldest timestamp of a first record between that line and the next checkpoint.
  checkpoints: number[];
  // Pairs of the start and end byte of each run of repeated records, in file order.
  runs: number[];
  // The byte offset after the original of the last repeated record found, or 0. A lookup reads forward from it.
  origin: number;
  // While the lookup for the line at `through` is paused: the offset before which the intervals it
  // reads hold no original of that line. Zero otherwise.
  searched: number;
  // Bytes of [0, through) as the detector read them. A detector restored from this state checks them
  // before it uses the state. Absent from a state that no detector with a file read produced.
  samples?: ClaudeRepeatedSample[];
}

export interface ClaudeRecordIdentity {
  uuid: string;
  timestamp: number;
}

// Reads up to `length` bytes at `position` into `buffer`, and returns the count read.
export type ClaudeRepeatedRead = (buffer: Buffer, position: number, length: number) => number;

// The bytes of a file at `at`, in base64, as a step read them. A later step checks them before it reuses
// state that it derived from the same bytes.
export interface ClaudeRepeatedSample {
  at: number;
  bytes: string;
}

// The bytes one sample holds, and the number of gaps between the samples of one range.
const SAMPLE_BYTES = 32;
const RANGE_SAMPLES = 8;
// The most bytes one revision check of a range reads.
export const CLAUDE_REPEATED_CHECK_BYTES = (RANGE_SAMPLES + 1) * SAMPLE_BYTES;

function sampleOf(bytes: Buffer, from: number, at: number, length: number): ClaudeRepeatedSample {
  return { at, bytes: bytes.toString('base64', at - from, at - from + length) };
}

// Sample offsets over [from, to): its first bytes, the bytes just before `to`, and evenly spaced points
// between them.
function rangeOffsets(from: number, to: number): number[] {
  const offsets: number[] = [];
  if (to <= from) return offsets;
  for (let index = 0; index <= RANGE_SAMPLES; index++) {
    const at = Math.max(from, Math.min(to - SAMPLE_BYTES, from + Math.floor(((to - from) * index) / RANGE_SAMPLES)));
    if (offsets[offsets.length - 1] !== at) offsets.push(at);
  }
  return offsets;
}

// Samples of the file bytes [from, to), read through `read`.
function rangeSamples(read: ClaudeRepeatedRead, from: number, to: number): ClaudeRepeatedSample[] {
  return rangeOffsets(from, to).map((at) => {
    const buffer = Buffer.alloc(Math.min(SAMPLE_BYTES, to - at));
    const count = Math.max(0, read(buffer, at, buffer.length));
    return sampleOf(buffer, at, at, count);
  });
}

// Samples of `bytes`, which hold the file bytes from `from`.
function heldSamples(bytes: Buffer, from: number): ClaudeRepeatedSample[] {
  return rangeOffsets(from, from + bytes.length).map((at) =>
    sampleOf(bytes, from, at, Math.min(SAMPLE_BYTES, from + bytes.length - at)),
  );
}

// The one revision check. Every reuse of state derived from file bytes passes through it: whether the
// file still holds every sample, with the bytes the check read. A file that no longer reaches a sample
// fails it. The caller charges the bytes to its budget.
function samplesHold(
  read: ClaudeRepeatedRead,
  samples: readonly ClaudeRepeatedSample[],
): { holds: boolean; readBytes: number } {
  let readBytes = 0;
  for (const sample of samples) {
    const expected = Buffer.from(sample.bytes, 'base64');
    if (!expected.length) continue;
    const buffer = Buffer.alloc(expected.length);
    const count = Math.max(0, read(buffer, sample.at, expected.length));
    readBytes += count;
    if (count !== expected.length || !buffer.equals(expected)) return { holds: false, readBytes };
  }
  return { holds: true, readBytes };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function validSamples(value: unknown, end: number): value is ClaudeRepeatedSample[] {
  return (
    Array.isArray(value) &&
    value.every((sample) => {
      if (!sample || typeof sample !== 'object') return false;
      const { at, bytes } = sample as Record<string, unknown>;
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return false;
      if (typeof bytes !== 'string' || bytes.length % 4 !== 0 || !BASE64.test(bytes)) return false;
      const length = Buffer.byteLength(bytes, 'base64');
      return length <= SAMPLE_BYTES && at + length <= end;
    })
  );
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

// The index of the quote that closes a string whose content starts at `from`, or -1.
function stringEnd(line: string, from: number): number {
  for (let quote = line.indexOf('"', from); quote >= 0; quote = line.indexOf('"', quote + 1)) {
    let slashes = 0;
    while (line.charCodeAt(quote - 1 - slashes) === 0x5c) slashes++;
    if (slashes % 2 === 0) return quote;
  }
  return -1;
}

function stringValue(line: string, open: number, close: number): string | null {
  return decodedString(line.slice(open + 1, close));
}

// The longest `uuid` or `timestamp` string, in bytes as written, that gives a record an identity.
const IDENTITY_FIELD_BYTES = 1024;

function fieldTooLong(line: string, open: number, close: number): boolean {
  const length = close - open - 1;
  if (length > IDENTITY_FIELD_BYTES) return true;
  return length * 3 > IDENTITY_FIELD_BYTES && Buffer.byteLength(line.slice(open + 1, close)) > IDENTITY_FIELD_BYTES;
}

// The record's own `uuid` and `timestamp`, read from the top level of the JSON object only. A key
// inside nested content, such as a tool input, never supplies the identity. A line without both
// top-level fields as strings, a field longer than `IDENTITY_FIELD_BYTES`, or a line that is not one
// JSON object has no identity.
export function claudeRecordIdentity(line: string): ClaudeRecordIdentity | null {
  if (line.indexOf('"uuid"') < 0) return null;
  let index = 0;
  while (index < line.length && isSpace(line.charCodeAt(index))) index++;
  if (line.charCodeAt(index) !== 0x7b) return null;
  let depth = 0;
  // At depth 1: whether the next string is a key, and the key whose value comes next.
  let expectKey = false;
  let field: 'uuid' | 'timestamp' | 'other' | null = null;
  let uuid: string | null = null;
  let timestamp: string | null = null;
  const clear = () => {
    if (field === 'uuid') uuid = null;
    else if (field === 'timestamp') timestamp = null;
    field = null;
  };
  for (; index < line.length; index++) {
    const code = line.charCodeAt(index);
    if (isSpace(code)) continue;
    if (code === 0x22) {
      const close = stringEnd(line, index + 1);
      if (close < 0) return null;
      if (depth === 1) {
        if (expectKey) {
          const length = close - index - 1;
          const key = length === 4 || length === 9 ? stringValue(line, index, close) : null;
          field = key === 'uuid' || key === 'timestamp' ? key : 'other';
          expectKey = false;
        } else if (field !== null) {
          const value = field === 'other' || fieldTooLong(line, index, close) ? null : stringValue(line, index, close);
          if (field === 'uuid') uuid = value;
          else if (field === 'timestamp') timestamp = value;
          field = null;
        }
      }
      index = close;
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      if (depth === 1) clear();
      depth++;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (code === 0x7d || code === 0x5d) {
      depth--;
      if (depth === 0) {
        for (index++; index < line.length; index++) if (!isSpace(line.charCodeAt(index))) return null;
        break;
      }
      continue;
    }
    if (depth !== 1) continue;
    if (code === 0x2c) {
      expectKey = true;
      field = null;
    } else if (code !== 0x3a) {
      // A number, `true`, `false`, or `null` value.
      clear();
    }
  }
  if (depth !== 0 || !uuid || timestamp === null) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? { uuid, timestamp: parsed } : null;
}

function decodedString(raw: string): string | null {
  if (raw.indexOf('\\') < 0) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return null;
  }
}

const UUID_LITERAL = Buffer.from('"uuid"');
const KEY_BYTES = 9;

// Reads the identity of one line that arrives in pieces, and gives the result `claudeRecordIdentity`
// gives for the whole line. It holds at most the field limits and a few bytes of state, so a record
// of any size reads in bounded memory. JSON structure is ASCII, so it reads the bytes undecoded.
class IdentityStream {
  private dead = false;
  private started = false;
  private closed = false;
  private depth = 0;
  private expectKey = false;
  private field: 'uuid' | 'timestamp' | 'other' | null = null;
  private uuid: string | null = null;
  private timestamp: string | null = null;
  private inString = false;
  // What the open string supplies, its bytes so far, whether it passed its limit, and the backslashes
  // that end the bytes read so far.
  private capture: 'key' | 'value' | null = null;
  private captured: Buffer[] = [];
  private capturedBytes = 0;
  private overflow = false;
  private slashes = 0;
  // Whether the line holds `"uuid"` anywhere, and the last bytes read while it does not.
  private literal = false;
  private recent = Buffer.alloc(0);
  // The line offset of the piece being fed, and the last bytes of the `uuid` and `timestamp` values read
  // so far with the line offset of each.
  private base = 0;
  private uuidSample: { at: number; bytes: Buffer } | null = null;
  private timestampSample: { at: number; bytes: Buffer } | null = null;

  constructor(private skipNul: boolean) {}

  // The identity values read so far, as samples of the line that starts at `lineStart`.
  fieldSamples(lineStart: number): ClaudeRepeatedSample[] {
    return [this.uuidSample, this.timestampSample]
      .filter((sample) => sample !== null)
      .map((sample) => sampleOf(sample.bytes, lineStart + sample.at, lineStart + sample.at, sample.bytes.length));
  }

  // `base` is the line offset of the first byte of `bytes`.
  feed(bytes: Buffer, base = 0): void {
    this.base = base;
    if (!this.literal) {
      const joined = Buffer.concat([this.recent, bytes.subarray(0, UUID_LITERAL.length - 1)]);
      if (joined.indexOf(UUID_LITERAL) >= 0 || bytes.indexOf(UUID_LITERAL) >= 0) this.literal = true;
      else {
        const kept = Buffer.concat([this.recent, bytes.subarray(Math.max(0, bytes.length - UUID_LITERAL.length + 1))]);
        this.recent = kept.subarray(Math.max(0, kept.length - UUID_LITERAL.length + 1));
      }
    }
    let index = 0;
    while (index < bytes.length && !this.dead) {
      if (this.inString) {
        index = this.stringBytes(bytes, index);
        continue;
      }
      const code = bytes[index++];
      if (!this.started) {
        // A forward reader drops NUL bytes before a line after byte 0.
        if (this.skipNul && code === 0) continue;
        this.skipNul = false;
        if (isSpace(code)) continue;
        if (code !== 0x7b) this.dead = true;
        this.started = true;
        this.depth = 1;
        this.expectKey = true;
        continue;
      }
      if (this.closed) {
        if (!isSpace(code)) this.dead = true;
        continue;
      }
      if (isSpace(code)) continue;
      if (code === 0x22) {
        this.inString = true;
        this.capture =
          this.depth !== 1
            ? null
            : this.expectKey
              ? 'key'
              : this.field === 'uuid' || this.field === 'timestamp'
                ? 'value'
                : null;
        this.captured = [];
        this.capturedBytes = 0;
        this.overflow = false;
        this.slashes = 0;
        continue;
      }
      if (code === 0x7b || code === 0x5b) {
        if (this.depth === 1) this.clear();
        this.depth++;
        continue;
      }
      if (code === 0x7d || code === 0x5d) {
        this.depth--;
        if (this.depth === 0) this.closed = true;
        continue;
      }
      if (this.depth !== 1) continue;
      if (code === 0x2c) {
        this.expectKey = true;
        this.field = null;
      } else if (code !== 0x3a) {
        // A number, `true`, `false`, or `null` value.
        this.clear();
      }
    }
  }

  finish(): ClaudeRecordIdentity | null {
    if (this.dead || !this.closed || !this.literal || !this.uuid || this.timestamp === null) return null;
    const parsed = Date.parse(this.timestamp);
    return Number.isFinite(parsed) ? { uuid: this.uuid, timestamp: parsed } : null;
  }

  private clear(): void {
    if (this.field === 'uuid') {
      this.uuid = null;
      this.uuidSample = null;
    } else if (this.field === 'timestamp') {
      this.timestamp = null;
      this.timestampSample = null;
    }
    this.field = null;
  }

  // Reads string content from `from`, and returns the index after the bytes it read.
  private stringBytes(bytes: Buffer, from: number): number {
    let index = from;
    while (index < bytes.length) {
      const quote = bytes.indexOf(0x22, index);
      const end = quote < 0 ? bytes.length : quote;
      let first = end;
      while (first > index && bytes[first - 1] === 0x5c) first--;
      const slashes = first === index ? this.slashes + (end - index) : end - first;
      if (quote < 0) {
        this.take(bytes, index, end);
        this.slashes = slashes;
        return end;
      }
      if (slashes % 2 === 0) {
        this.take(bytes, index, quote);
        this.closeString(this.base + quote);
        return quote + 1;
      }
      this.take(bytes, index, quote + 1);
      this.slashes = 0;
      index = quote + 1;
    }
    return index;
  }

  private take(bytes: Buffer, from: number, to: number): void {
    if (!this.capture || this.overflow || to <= from) return;
    const limit = this.capture === 'key' ? KEY_BYTES : IDENTITY_FIELD_BYTES;
    if (this.capturedBytes + to - from > limit) {
      this.overflow = true;
      this.captured = [];
      return;
    }
    this.captured.push(Buffer.from(bytes.subarray(from, to)));
    this.capturedBytes += to - from;
  }

  // `end` is the line offset of the closing quote.
  private closeString(end: number): void {
    this.inString = false;
    if (this.depth !== 1) return;
    const raw = () => Buffer.concat(this.captured).toString('utf8');
    if (this.expectKey) {
      // `claudeRecordIdentity` decodes keys of 4 or 9 characters. A key that can equal `uuid` or
      // `timestamp` is ASCII, so its bytes count its characters.
      const key =
        !this.overflow && (this.capturedBytes === 4 || this.capturedBytes === KEY_BYTES) ? decodedString(raw()) : null;
      this.field = key === 'uuid' || key === 'timestamp' ? key : 'other';
      this.expectKey = false;
    } else if (this.field !== null) {
      const value = this.capture === 'value' && !this.overflow ? decodedString(raw()) : null;
      const tail = value === null ? null : Buffer.concat(this.captured).subarray(-SAMPLE_BYTES);
      const sample = tail && tail.length ? { at: end - tail.length, bytes: tail } : null;
      if (this.field === 'uuid') {
        this.uuid = value;
        this.uuidSample = sample;
      } else if (this.field === 'timestamp') {
        this.timestamp = value;
        this.timestampSample = sample;
      }
      this.field = null;
    }
  }
}

// Lines up to this size are held whole and read with `claudeRecordIdentity`. A longer line is read
// through `IdentityStream`.
const LINE_HOLD_BYTES = 1024 * 1024;

// Collects the bytes of one line and gives its identity.
class LineIdentity {
  private parts: Buffer[] = [];
  private held = 0;
  private stream: IdentityStream | null = null;
  // For a line read through the stream: the bytes read, the first bytes, and the last bytes.
  private fed = 0;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  // The samples of the last finished line, relative to its start, built when a caller asks for them.
  private last: ((lineStart: number) => ClaudeRepeatedSample[]) | null = null;

  // `skipNul` drops NUL bytes before the line, as a forward reader does after byte 0.
  constructor(private skipNul: boolean) {}

  get pending(): boolean {
    return this.held > 0 || this.stream !== null;
  }

  // Samples of the bytes added so far, for a line that starts at `lineStart`: its first and last bytes,
  // and either evenly spaced bytes of a held line or the identity values a streamed line read.
  samples(lineStart: number): ClaudeRepeatedSample[] {
    if (!this.stream) return this.held ? heldSamples(Buffer.concat(this.parts), lineStart) : [];
    return [
      sampleOf(this.head, lineStart, lineStart, this.head.length),
      sampleOf(
        this.tail,
        lineStart + this.fed - this.tail.length,
        lineStart + this.fed - this.tail.length,
        this.tail.length,
      ),
      ...this.stream.fieldSamples(lineStart),
    ];
  }

  // Samples of the last finished line, which started at `lineStart`. A caller asks before it reads
  // again, because a held line can share the bytes of the caller's read buffer.
  finishedSamples(lineStart: number): ClaudeRepeatedSample[] {
    return this.last ? this.last(lineStart) : [];
  }

  // Adds bytes of the line before its end. The bytes are copied.
  add(piece: Buffer): void {
    if (this.stream) {
      this.feedStream(piece);
      return;
    }
    if (!piece.length) return;
    this.parts.push(Buffer.from(piece));
    this.held += piece.length;
    if (this.held <= LINE_HOLD_BYTES) return;
    this.stream = new IdentityStream(this.skipNul);
    const parts = this.parts;
    this.parts = [];
    this.held = 0;
    this.head = Buffer.from(parts[0].subarray(0, SAMPLE_BYTES));
    for (const part of parts) this.feedStream(part);
    if (this.head.length < SAMPLE_BYTES) this.head = Buffer.concat(parts).subarray(0, SAMPLE_BYTES);
  }

  private feedStream(piece: Buffer): void {
    this.stream!.feed(piece, this.fed);
    this.fed += piece.length;
    if (!piece.length) return;
    const joined = piece.length >= SAMPLE_BYTES ? piece : Buffer.concat([this.tail, piece]);
    this.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - SAMPLE_BYTES)));
  }

  // The identity of the line that ends with `piece`. The next line starts after byte 0.
  finish(piece: Buffer): ClaudeRecordIdentity | null {
    let identity: ClaudeRecordIdentity | null;
    if (this.stream) {
      this.feedStream(piece);
      identity = this.stream.finish();
      const kept = this.samples(0);
      this.last = (lineStart) => kept.map((sample) => ({ at: sample.at + lineStart, bytes: sample.bytes }));
    } else {
      const bytes = this.parts.length ? Buffer.concat([...this.parts, piece]) : piece;
      let first = 0;
      if (this.skipNul) while (bytes[first] === 0) first++;
      identity = claudeRecordIdentity(bytes.toString('utf8', first));
      this.last = (lineStart) => heldSamples(bytes, lineStart);
    }
    this.parts = [];
    this.held = 0;
    this.stream = null;
    this.fed = 0;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.skipNul = true;
    return identity;
  }
}

// The identity `claudeRecordIdentity` gives `line`, read in pieces of `pieceBytes`. Tests compare the two.
export function streamedClaudeRecordIdentity(line: Buffer, pieceBytes: number): ClaudeRecordIdentity | null {
  const stream = new IdentityStream(false);
  for (let at = 0; at < line.length; at += pieceBytes) stream.feed(line.subarray(at, at + pieceBytes));
  return stream.finish();
}

function identityKey(identity: ClaudeRecordIdentity): string {
  return `${identity.uuid}\n${identity.timestamp}`;
}

// A filter for a reader that reads one file forward from byte 0. It returns true for a repeated record. The
// filter applies the same detector as a resumed reader. Its offsets count characters, which only
// place checkpoints that it never saves.
export function createClaudeRepeatedFilter(): (line: string) => boolean {
  const detector = new ClaudeRepeatedDetector();
  let offset = 0;
  return (line) => {
    const start = offset;
    offset += line.length + 1;
    return detector.repeatedAt(line, start, offset) === true;
  };
}

export function emptyClaudeRepeatedState(): ClaudeRepeatedState {
  return { through: 0, newest: 0, checkpoints: [], runs: [], origin: 0, searched: 0 };
}

// A copy of `state` without its samples.
function withoutSamples(state: ClaudeRepeatedState): ClaudeRepeatedState {
  return {
    through: state.through,
    newest: state.newest,
    checkpoints: [...state.checkpoints],
    runs: [...state.runs],
    origin: state.origin,
    searched: state.searched,
  };
}

// Whether the byte at `offset` lies inside a repeated run of the saved map.
export function insideClaudeRepeated(state: Pick<ClaudeRepeatedState, 'runs'> | undefined, offset: number): boolean {
  const runs = state?.runs ?? [];
  let low = 0;
  let high = runs.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (offset < runs[middle * 2]) high = middle - 1;
    else if (offset >= runs[middle * 2 + 1]) low = middle + 1;
    else return true;
  }
  return false;
}

export function validClaudeRepeatedState(value: unknown): value is ClaudeRepeatedState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  const integers = (list: unknown, group: number): list is number[] =>
    Array.isArray(list) && list.length % group === 0 && list.every((item) => Number.isSafeInteger(item) && item >= 0);
  const offset = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  const { through, newest, origin, searched } = state;
  if (!offset(through) || !offset(newest)) return false;
  if (state.samples !== undefined && !validSamples(state.samples, through)) return false;
  if (!offset(origin) || !offset(searched) || origin > through || searched > through) return false;
  const checkpoints = state.checkpoints;
  const runs = state.runs;
  if (!integers(checkpoints, 3) || !integers(runs, 2)) return false;
  // Checkpoint offsets rise from byte 0, and their newest timestamps never fall.
  for (let index = 0; index < checkpoints.length; index += 3) {
    if (index === 0 ? checkpoints[0] !== 0 : checkpoints[index] <= checkpoints[index - 3]) return false;
    if (index > 0 && checkpoints[index + 1] < checkpoints[index - 2]) return false;
    if (checkpoints[index] > through || checkpoints[index + 1] > newest) return false;
  }
  // Repeated runs are ordered, disjoint, and not empty.
  for (let index = 0; index < runs.length; index++) {
    if (index % 2 ? runs[index] <= runs[index - 1] : index > 0 && runs[index] < runs[index - 1]) return false;
  }
  return runs.length === 0 || runs[runs.length - 1] <= through;
}

// The intervals that lookups already read in one file revision, with the identities they hold.
export interface ClaudeRepeatedLookups {
  // Pairs of byte ranges, ordered and disjoint. Each range ends at a line start.
  loaded: number[];
  // Each identity key, with the byte offset after its first line.
  keys: Map<string, number>;
  // Where a paused interval search stopped inside a line: the line start, the byte offset read up to, the
  // identity fields read so far, and samples of the bytes they came from. The next search that reaches
  // the line reads on from there when the samples hold.
  paused?: { lineStart: number; position: number; line: LineIdentity; samples: ClaudeRepeatedSample[] };
}

// Lookups survive between slices of one process, so the slices of a repeated run rarely read an
// interval twice. The total key count bounds the memory, and the least recently used files go first.
// The saved origin and search position carry a detector's progress between lines. Across a line longer
// than one read chunk, the paused search here carries it.
const LOOKUP_KEYS = 200_000;
const FILE_LOOKUP_KEYS = 50_000;
const lookups = new Map<string, { revision: string; held: ClaudeRepeatedLookups }>();

// The saved lookups of `file`, valid for a slice of `revision` whose restored offset is `through`.
// A slice that starts at byte 0 rebuilds the file, so it starts with no lookups. The lookups cover only
// bytes before `through`, so the detector that takes them checks them with the samples of its restored
// state, and checks a paused line with its own samples.
export function claudeRepeatedLookups(file: string, revision: string, through: number): ClaudeRepeatedLookups {
  const entry = lookups.get(file);
  lookups.delete(file);
  const held = entry?.held;
  const valid =
    !!held &&
    through > 0 &&
    entry.revision === revision &&
    held.keys.size <= FILE_LOOKUP_KEYS &&
    (held.loaded.length === 0 || held.loaded[held.loaded.length - 1] <= through);
  const kept = valid ? held : { loaded: [], keys: new Map<string, number>() };
  let total = kept.keys.size;
  for (const other of lookups.values()) total += other.held.keys.size;
  for (const [name, other] of lookups) {
    if (total <= LOOKUP_KEYS) break;
    total -= other.held.keys.size;
    lookups.delete(name);
  }
  lookups.set(file, { revision, held: kept });
  return kept;
}

// Drops the saved lookups of `file`. A reader calls it when the bytes behind its offset changed.
export function forgetClaudeRepeatedLookups(file: string): void {
  lookups.delete(file);
}

// Lookup reads use chunks of this size.
const LOOKUP_CHUNK_BYTES = 64 * 1024;
// A lookup first reads forward from the saved origin. It gives up after this many bytes of lines
// that do not match, or this many records that do not match.
const ORIGIN_PROBE_BYTES = 256 * 1024;
const ORIGIN_PROBE_RECORDS = 8;

// What a lookup found: the byte offset after the original's line, no original, a lookup that
// paused within its budget, or `null` when the file no longer holds the bytes.
type LookupResult = number | 'absent' | 'pending' | null;

export class ClaudeRepeatedDetector {
  private readonly state: ClaudeRepeatedState;
  private nextCheckpoint: number;
  // Identity keys of every first record from `windowStart` up to `state.through`, each with the byte
  // offset after its line. Memory only.
  private readonly keys = new Map<string, number>();
  private readonly windowStart: number;
  // Byte ranges before `windowStart` that a lookup already read, and the identities they hold.
  private readonly held: ClaudeRepeatedLookups;
  private confirming = 0;
  private lostRevision = false;
  // The samples of the restored state until the first classification checks them.
  private unchecked: ClaudeRepeatedSample[] | null;
  // The samples of `state` and the offset they cover.
  private samples: ClaudeRepeatedSample[] | undefined;
  private sampledThrough: number;
  // The last chunk a lookup read. Consecutive lookups in a repeated run read the same chunk.
  private ahead: { start: number; bytes: Buffer } | null = null;
  // The budget of the running lookup.
  private limit: {
    allowance: number;
    before: number;
    progress: boolean;
    probing: boolean;
    // Whether the lookup read its one chunk past both budgets.
    extra: boolean;
  } | null = null;

  // `read` supplies the bytes before a restored offset when a lookup needs them. A reader passes
  // its own open file, so a lookup reads the revision the reader reads. `saved` holds the lookups of
  // earlier slices of the same revision, and must cover only bytes before the restored offset.
  // `expired` reports a spent time budget, which pauses a lookup the way a spent byte budget does.
  constructor(
    restored?: ClaudeRepeatedState,
    private readonly read?: ClaudeRepeatedRead,
    saved?: ClaudeRepeatedLookups,
    private readonly expired?: () => boolean,
  ) {
    this.held = saved ?? { loaded: [], keys: new Map() };
    this.state = restored ? withoutSamples(restored) : emptyClaudeRepeatedState();
    this.samples = restored?.samples;
    this.sampledThrough = this.state.through;
    this.unchecked = restored?.samples && this.state.through > 0 ? restored.samples : null;
    this.windowStart = this.state.through;
    const last = this.state.checkpoints.length - 3;
    this.nextCheckpoint = last >= 0 ? this.state.checkpoints[last] + CLAUDE_REPEATED_CHECKPOINT_BYTES : 0;
  }

  // Classifies the line at bytes [start, end). Returns true for a repeated record. A lookup reads new bytes
  // only while it has read fewer than `allowance` bytes and the time budget lasts, and it never reads
  // past the allowance. A lookup with `progress` set and a positive allowance is the exception: when a
  // budget runs out, it reads one more chunk of the intervals it searches. So a slice gives that
  // allowance to its first line alone. A search that stops inside a line keeps its place, so the next
  // lookup reads on from there. When the budget runs out first, `repeatedAt`
  // returns 'pending' and leaves the line unclassified. A detector restored from the snapshot resumes
  // the lookup where it stopped. Returns null when a lookup cannot read the bytes before the restored
  // offset, or when they no longer hold the samples of the restored state. The detector then classifies
  // nothing more. The first call checks those samples, and the check counts as lookup bytes.
  repeatedAt(
    line: string,
    start: number,
    end: number,
    allowance = Infinity,
    progress = true,
  ): boolean | 'pending' | null {
    if (this.lostRevision || !this.restoredHolds()) return null;
    if (start < this.state.through) return insideClaudeRepeated(this.state, start);
    return this.classify(claudeRecordIdentity(line), start, end, allowance, progress);
  }

  // The same as `repeatedAt`, for a line whose identity the caller already read.
  repeatedIdentityAt(
    identity: ClaudeRecordIdentity | null,
    start: number,
    end: number,
    allowance = Infinity,
    progress = true,
  ): boolean | 'pending' | null {
    if (this.lostRevision || !this.restoredHolds()) return null;
    if (start < this.state.through) return insideClaudeRepeated(this.state, start);
    return this.classify(identity, start, end, allowance, progress);
  }

  // Checks the restored state against the file once. When the bytes changed, the detector and the saved
  // lookups it took describe another revision, so both are dropped.
  private restoredHolds(): boolean {
    const samples = this.unchecked;
    if (samples === null) return true;
    this.unchecked = null;
    if (!this.read) return true;
    const check = samplesHold(this.read, samples);
    this.confirming += check.readBytes;
    if (check.holds) return true;
    this.lostRevision = true;
    this.held.loaded.length = 0;
    this.held.keys.clear();
    this.held.paused = undefined;
    return false;
  }

  private classify(
    identity: ClaudeRecordIdentity | null,
    start: number,
    end: number,
    allowance: number,
    progress: boolean,
  ): boolean | 'pending' | null {
    const points = this.state.checkpoints;
    if (start >= this.nextCheckpoint) {
      points.push(start, this.state.newest, NO_RECORD);
      this.nextCheckpoint = start + CLAUDE_REPEATED_CHECKPOINT_BYTES;
    }
    if (identity) {
      const key = identityKey(identity);
      if (identity.timestamp <= this.state.newest) {
        const original =
          this.keys.get(key) ??
          this.held.keys.get(key) ??
          this.lookUp(key, identity.timestamp, start, allowance, progress);
        if (original === null) {
          this.lostRevision = true;
          return null;
        }
        if (original === 'pending') return 'pending';
        this.state.searched = 0;
        this.held.paused = undefined;
        if (original !== 'absent') {
          this.state.origin = original;
          this.state.through = end;
          const runs = this.state.runs;
          if (runs.length && runs[runs.length - 1] === start) runs[runs.length - 1] = end;
          else runs.push(start, end);
          return true;
        }
        this.state.origin = 0;
      }
      this.keys.set(key, end);
      if (identity.timestamp > this.state.newest) this.state.newest = identity.timestamp;
      const oldest = points.length - 1;
      if (identity.timestamp < points[oldest]) points[oldest] = identity.timestamp;
    }
    this.state.through = end;
    return false;
  }

  // Bytes read by lookups since the last call. A sliced reader charges them to its budget.
  takeConfirmingBytes(): number {
    const bytes = this.confirming;
    this.confirming = 0;
    return bytes;
  }

  // The detector state, with samples of [0, through) when the detector reads a file. Taking new samples
  // counts as lookup bytes.
  snapshot(): ClaudeRepeatedState {
    const state = withoutSamples(this.state);
    if (!this.read || state.through === 0) return state;
    if (this.samples === undefined || this.sampledThrough !== state.through) {
      const read = this.read;
      this.samples = rangeSamples(
        (buffer, position, length) => {
          const count = read(buffer, position, length);
          this.confirming += Math.max(0, count);
          return count;
        },
        0,
        state.through,
      );
      this.sampledThrough = state.through;
    }
    return { ...state, samples: this.samples };
  }

  // Finds the original of a record before `windowStart`. A repeated run repeats an earlier run in
  // order, so the lookup first reads the records after the last original found. Otherwise it reads
  // the checkpoint intervals that can hold the original.
  private lookUp(key: string, timestamp: number, start: number, allowance: number, progress: boolean): LookupResult {
    const limit = { allowance, before: this.confirming, progress, probing: true, extra: false };
    this.limit = limit;
    try {
      const { origin, searched } = this.state;
      // A paused interval search goes on without a probe.
      if (searched === 0 && origin > 0 && origin < this.windowStart && !this.held.paused) {
        const probed = this.probe(key, origin);
        // A lookup with `progress` leaves a probe that its budgets stop, and searches the intervals.
        if (probed !== 'absent' && !(probed === 'pending' && progress)) return probed;
      }
      limit.probing = false;
      return this.confirm(key, timestamp, start);
    } finally {
      this.limit = null;
    }
  }

  // How many bytes the running lookup can read next, or 0 when it must pause. Each read stops at the
  // allowance and the time budget. When either runs out, a lookup with `progress` reads one more chunk
  // of an interval search.
  private readable(): number {
    const limit = this.limit;
    if (!limit) return Infinity;
    if (limit.allowance <= 0) return 0;
    const left = this.expired?.() === true ? 0 : Math.max(0, limit.allowance - (this.confirming - limit.before));
    if (left > 0) return left;
    if (!limit.progress || limit.probing || limit.extra) return 0;
    limit.extra = true;
    return LOOKUP_CHUNK_BYTES;
  }

  private probe(key: string, origin: number): LookupResult {
    let records = 0;
    let found: number | undefined;
    const scanned = this.scan(origin, this.windowStart, (identity, lineEnd) => {
      if (identity && identityKey(identity) === key) {
        found = lineEnd;
        return true;
      }
      if (identity) records++;
      return records >= ORIGIN_PROBE_RECORDS || lineEnd - origin >= ORIGIN_PROBE_BYTES;
    });
    if (scanned === null) return null;
    if (found !== undefined) return found;
    return scanned.paused ? 'pending' : 'absent';
  }

  // Reads every interval before `windowStart` that can hold the original of a record with this
  // timestamp, in file order, and stops at the original. Bytes before `state.searched` hold no
  // original of the line at `state.through`.
  private confirm(key: string, timestamp: number, start: number): LookupResult {
    const points = this.state.checkpoints;
    // The last checkpoint whose newest timestamp is older than the record.
    let low = 0;
    let high = points.length / 3 - 1;
    let first = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (points[middle * 3 + 1] < timestamp) {
        first = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const loaded = this.held.loaded;
    try {
      for (let index = first * 3; index < points.length && points[index] < this.windowStart; index += 3) {
        if (points[index + 2] > timestamp) continue;
        const to = Math.min(index + 3 < points.length ? points[index + 3] : start, this.windowStart);
        let position = Math.max(points[index], this.state.searched);
        let at = 0;
        while (at < loaded.length && loaded[at + 1] <= position) at += 2;
        while (position < to) {
          if (at < loaded.length && loaded[at] <= position) {
            position = loaded[at + 1];
            at += 2;
            continue;
          }
          const gapEnd = Math.min(to, at < loaded.length ? loaded[at] : to);
          const found = new Map<string, number>();
          const paused = this.held.paused?.lineStart === position ? this.held.paused : undefined;
          if (paused) this.held.paused = undefined;
          // A paused line resumes only while the bytes its identity fields came from hold.
          const resume = paused && this.holds(paused.samples) ? paused : undefined;
          const scanned = this.scan(
            position,
            gapEnd,
            (identity, lineEnd) => {
              const name = identity ? identityKey(identity) : null;
              if (name !== null && !found.has(name)) found.set(name, lineEnd);
              return false;
            },
            resume,
          );
          if (scanned === null) return null;
          // Only a range read to its end publishes its identities.
          if (scanned.at > position) {
            for (const [name, lineEnd] of found) if (!this.held.keys.has(name)) this.held.keys.set(name, lineEnd);
            loaded.splice(at, 0, position, scanned.at);
            at += 2;
          }
          const original = found.get(key);
          if (original !== undefined) return original;
          if (scanned.paused) {
            this.state.searched = scanned.at;
            this.held.paused = {
              lineStart: scanned.at,
              position: scanned.position,
              line: scanned.line,
              samples: scanned.line.samples(scanned.at),
            };
            return 'pending';
          }
          position = gapEnd;
        }
      }
      return 'absent';
    } finally {
      for (let index = loaded.length - 2; index > 0; index -= 2) {
        if (loaded[index] === loaded[index - 1]) loaded.splice(index - 1, 2);
      }
    }
  }

  // Checks samples through the lookup's file read, and counts the bytes as lookup bytes.
  private holds(samples: readonly ClaudeRepeatedSample[]): boolean {
    if (!this.read) return false;
    const check = samplesHold(this.read, samples);
    this.confirming += check.readBytes;
    return check.holds;
  }

  // Reads the lines of [from, to) in order, and passes the identity of each to `visit` with the byte
  // offset after it. `visit` returns true to stop after its line. Returns the offset where reading
  // stopped, and whether the lookup budget stopped it at that line start. A paused scan also returns the
  // byte offset it read up to and the line read so far. `resume` continues a paused scan that stopped
  // at `from`. Returns null when the file ends before `to`. `from` and `to` are line starts.
  private scan(
    from: number,
    to: number,
    visit: (identity: ClaudeRecordIdentity | null, lineEnd: number) => boolean,
    resume?: { position: number; line: LineIdentity },
  ): { at: number; paused: boolean; position: number; line: LineIdentity } | null {
    if (!this.read) return null;
    const line = resume?.line ?? new LineIdentity(from > 0);
    let lineStart = from;
    let position = resume?.position ?? from;
    while (position < to) {
      const bytes = this.readAhead(position, to);
      if (bytes === null) return null;
      if (bytes === 'pause') return { at: lineStart, paused: true, position, line };
      let at = 0;
      for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, at)) {
        const identity = line.finish(bytes.subarray(at, newline));
        const lineEnd = position + newline + 1;
        if (visit(identity, lineEnd)) return { at: lineEnd, paused: false, position: lineEnd, line };
        lineStart = lineEnd;
        at = newline + 1;
      }
      if (at < bytes.length) line.add(bytes.subarray(at));
      position += bytes.length;
    }
    if (line.pending) visit(line.finish(Buffer.alloc(0)), to);
    return { at: to, paused: false, position: to, line };
  }

  // The bytes from `position` up to at most `to`, from the last chunk read when it holds them.
  // Returns 'pause' when the bytes need a new read that the lookup budget does not allow.
  private readAhead(position: number, to: number): Buffer | 'pause' | null {
    const ahead = this.ahead;
    if (ahead && position >= ahead.start && position < ahead.start + ahead.bytes.length) {
      return ahead.bytes.subarray(position - ahead.start, Math.min(ahead.bytes.length, to - ahead.start));
    }
    const readable = this.readable();
    if (readable <= 0) return 'pause';
    const buffer = Buffer.allocUnsafe(Math.min(LOOKUP_CHUNK_BYTES, to - position, readable));
    const read = this.read!(buffer, position, buffer.length);
    if (read <= 0) return null;
    this.confirming += read;
    this.ahead = { start: position, bytes: buffer.subarray(0, read) };
    return this.ahead.bytes;
  }
}

// The repeated-record maps this process holds, by file. Windowed and backward readers read a part of
// a file, so they cannot see the originals before their window. They classify each line through the
// map of the whole file instead. The project cost index publishes each saved map when its ledger
// loads and after each slice, and a reader extends the map over the bytes it does not cover yet. A
// file can hold more than one candidate map, such as its own and one that another process handed over.
// A reader uses the first candidate that passes the revision check, in the order `usableMap` ranks them.
interface HeldMap {
  // The file identity from `claudeFileRevision`, or null for a map the ledger supplied.
  identity: string | null;
  // The size and modification time of the file when the map was held.
  size: number;
  mtimeMs: number;
  // The map, with samples of the bytes before `through`.
  state: ClaudeRepeatedState;
}
const maps = new Map<string, HeldMap[]>();
const CANDIDATES_KEPT = 3;

// Where background completion stopped inside a line, so the next step reads on from there and crosses
// a record larger than one step.
interface CoverageCursor {
  revision: string;
  // The start of the unfinished line, where the held map stops.
  lineStart: number;
  // The byte offset read up to, and samples of the bytes the line identity or the waiting line came from.
  position: number;
  samples: ClaudeRepeatedSample[];
  line: LineIdentity;
  // A complete line whose lookup paused, with its identity and end.
  waiting?: { identity: ClaudeRecordIdentity | null; end: number };
}
const coverageCursors = new Map<string, CoverageCursor>();
const MAPS_KEPT = 1024;

function mapKey(file: string): string {
  const unified = file.replace(/\\/g, '/');
  return /^[a-zA-Z]:\//.test(unified) || process.platform === 'win32' ? unified.toLowerCase() : unified;
}

function lookupKey(file: string): string {
  return `reader:${mapKey(file)}`;
}

// The identity of one file: a rename keeps it, and a new file at the same path does not. The bytes of
// one identity can still change, so a held map also keeps the size, the modification time and samples.
export function claudeFileRevision(stat: Pick<fs.Stats, 'dev' | 'ino' | 'birthtimeMs'>): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function fileRead(file: string, fd: number, metered: boolean): ClaudeRepeatedRead {
  return (buffer, position, length) => {
    const count = fs.readSync(fd, buffer, 0, length, position);
    return metered ? meterRead(file, count) : count;
  };
}

// Whether a held map still describes the open file, with the bytes the check read. Claude Code appends
// to a transcript, so the file keeps its identity, never shrinks, and grows whenever its modification
// time changes. A file with the identity, size and modification time the map recorded is unchanged. Any
// other file must still hold every sample of the map. A ledger map that passes takes the file identity.
function heldValid(held: HeldMap, stat: fs.Stats, read: ClaudeRepeatedRead): { valid: boolean; readBytes: number } {
  const identity = claudeFileRevision(stat);
  const changed =
    (held.identity !== null && held.identity !== identity) ||
    stat.size < held.size ||
    stat.size < held.state.through ||
    (stat.size === held.size && stat.mtimeMs !== held.mtimeMs);
  if (changed) return { valid: false, readBytes: 0 };
  if (held.state.through === 0) return { valid: true, readBytes: 0 };
  if (held.identity !== null && stat.size === held.size) return { valid: true, readBytes: 0 };
  if (!held.state.samples) return { valid: false, readBytes: 0 };
  const check = samplesHold(read, held.state.samples);
  if (check.holds) held.identity = identity;
  return { valid: check.holds, readBytes: check.readBytes };
}

// Makes `first` the candidate map of `file`, ahead of `others`.
function keepMap(file: string, first: HeldMap, others: HeldMap[] = []): void {
  const key = mapKey(file);
  maps.delete(key);
  maps.set(key, [first, ...others].slice(0, CANDIDATES_KEPT));
  while (maps.size > MAPS_KEPT) maps.delete(maps.keys().next().value as string);
}

function holdMap(file: string, stat: fs.Stats, state: ClaudeRepeatedState): void {
  keepMap(file, { identity: claudeFileRevision(stat), size: stat.size, mtimeMs: stat.mtimeMs, state });
}

// Drops every map, lookup and paused step this process holds for `file`, so the next read of the file
// starts from byte 0.
function forgetFile(file: string): void {
  maps.delete(mapKey(file));
  forgetClaudeRepeatedLookups(lookupKey(file));
  coverageCursors.delete(lookupKey(file));
}

// The held map of `file` that still describes the open file, with the bytes the checks read. A map held
// at the current revision ranks first, then the one that reaches furthest. A candidate that fails takes
// the file's lookups and paused steps with it, because they can derive from the bytes that changed.
function usableMap(
  file: string,
  stat: fs.Stats,
  read: ClaudeRepeatedRead,
): { state: ClaudeRepeatedState | null; readBytes: number } {
  const candidates = maps.get(mapKey(file)) ?? [];
  let readBytes = 0;
  let failed = false;
  // A candidate held at the file's current identity, size and modification time comes first, so a map
  // that reaches further but was held at another revision never displaces one held at this revision.
  const identity = claudeFileRevision(stat);
  const current = (held: HeldMap) =>
    held.identity === identity && held.size === stat.size && held.mtimeMs === stat.mtimeMs ? 0 : 1;
  const ranked = [...candidates].sort(
    (left, right) => current(left) - current(right) || right.state.through - left.state.through,
  );
  for (const held of ranked) {
    const check = heldValid(held, stat, read);
    readBytes += check.readBytes;
    if (!check.valid) {
      failed = true;
      continue;
    }
    if (failed) {
      forgetClaudeRepeatedLookups(lookupKey(file));
      coverageCursors.delete(lookupKey(file));
    }
    keepMap(file, held);
    return { state: held.state, readBytes };
  }
  if (candidates.length) forgetFile(file);
  return { state: null, readBytes };
}

function copyState(state: ClaudeRepeatedState): ClaudeRepeatedState {
  return { ...withoutSamples(state), ...(state.samples ? { samples: [...state.samples] } : {}) };
}

// Publishes the detector of the project cost index after a slice that read the open file `fd`. A held
// map that still describes the file and reaches further stays. A rebuilt index replaces any other map.
export function publishClaudeRepeatedMap(file: string, fd: number, state: ClaudeRepeatedState): void {
  const stat = fs.fstatSync(fd);
  const read = fileRead(file, fd, true);
  const held = usableMap(file, stat, read).state;
  if (held && held.through > state.through) return;
  const copy = copyState(state);
  if (copy.through > 0 && !copy.samples) copy.samples = rangeSamples(read, 0, copy.through);
  holdMap(file, stat, copy);
}

// Publishes the saved maps of a loaded ledger, so readers start from them after a restart. A reader
// checks each against the file before it uses it. A saved map without samples cannot be checked, so
// it is not published.
export function publishClaudeRepeatedLedger(
  records: readonly { file: string; size: number; mtimeMs: number; claudeRepeated?: ClaudeRepeatedState }[],
): void {
  for (const record of records) {
    const state = record.claudeRepeated;
    if (!state || maps.has(mapKey(record.file)) || (state.through > 0 && !state.samples)) continue;
    keepMap(record.file, { identity: null, size: record.size, mtimeMs: record.mtimeMs, state: copyState(state) });
  }
}

// A held map as one process hands it to another, such as the extension host to the progressive worker.
export interface ClaudeRepeatedHeldMap {
  identity: string | null;
  size: number;
  mtimeMs: number;
  state: ClaudeRepeatedState;
}

// The map this process holds for `file`, or null. The receiving process checks it against the file
// before it reads with it, as it checks its own maps.
export function heldClaudeRepeatedMap(file: string): ClaudeRepeatedHeldMap | null {
  const held = maps.get(mapKey(file))?.[0];
  return held ? { ...held, state: copyState(held.state) } : null;
}

// Takes a map that another process holds for `file` as one more candidate. A reader checks the
// candidates against the file in the order `usableMap` ranks them, so a map that reaches further
// never displaces one held at the current revision.
export function adoptClaudeRepeatedMap(file: string, held: ClaudeRepeatedHeldMap): void {
  const state = held.state;
  if (!validClaudeRepeatedState(state) || (state.through > 0 && !state.samples)) return;
  if (!Number.isFinite(held.size) || !Number.isFinite(held.mtimeMs)) return;
  const own = maps.get(mapKey(file)) ?? [];
  const same = (candidate: HeldMap) =>
    candidate.identity === held.identity &&
    candidate.size === held.size &&
    candidate.mtimeMs === held.mtimeMs &&
    candidate.state.through === state.through;
  if (own.some(same)) return;
  const adopted = { identity: held.identity, size: held.size, mtimeMs: held.mtimeMs, state: copyState(state) };
  if (own.length) keepMap(file, own[0], [adopted, ...own.slice(1)]);
  else keepMap(file, adopted);
}

// Drops every map and coverage request this process holds. Tests call it to start from an empty process.
export function forgetClaudeRepeatedMaps(): void {
  maps.clear();
  coverageRequests.clear();
  coverageCursors.clear();
}

export interface ClaudeRepeatedMap {
  // Byte offset after the last line the map classified.
  through: number;
  // Newest record timestamp before `through`.
  newest: number;
  // Pairs of the start and end byte of each run of repeated records.
  runs: number[];
  // Whether the map reaches every complete line before the requested end.
  covered: boolean;
  // Bytes this call read, forward, in lookups, and in revision checks.
  readBytes: number;
}

// At most this many samples of the bytes a call read forward take part in its final revision check.
const FLIGHT_SAMPLES = RANGE_SAMPLES + 1;

function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, index) => items[Math.floor((index * (items.length - 1)) / (count - 1))]);
}

// The map of `file` over every complete line that starts before `end`. When the held map stops short
// of `end`, this call reads the uncovered bytes forward and looks up the originals they need. With no
// held map, that is every byte before `end`. Forward reads, lookups and revision checks share
// `allowance` bytes, and reads stop at `deadline` (a `performance.now()` value). A revision check reads
// at most a few hundred bytes, and runs even when the budget is spent. A call that stops early holds
// the map it reached and returns it as not covered. Returns null when the file changed during the read
// or is gone. Either drops every map, lookup and paused step of the file.
export function claudeRepeatedMap(
  file: string,
  end: number,
  allowance = Infinity,
  deadline = Infinity,
  // False lets the call stop partway through the uncovered bytes, as background completion does.
  whole = true,
): ClaudeRepeatedMap | null {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    // Background completion reads outside every reader's read window.
    const read = fileRead(file, fd, whole);
    const checked = usableMap(file, stat, read);
    const usable = checked.state;
    let spent = checked.readBytes;
    const stop = Math.min(end, stat.size);
    if (usable && usable.through >= stop) {
      return { through: usable.through, newest: usable.newest, runs: usable.runs, covered: true, readBytes: spent };
    }
    // A bounded reader extends the map only when the uncovered bytes fit its allowance.
    if (whole && stop - (usable?.through ?? 0) > allowance) {
      const held = usable ?? emptyClaudeRepeatedState();
      return { through: held.through, newest: held.newest, runs: held.runs, covered: false, readBytes: spent };
    }
    // The held map passed its check, so the detector starts from it without checking it again.
    const restored = usable ? withoutSamples(usable) : emptyClaudeRepeatedState();
    const key = lookupKey(file);
    const revision = claudeFileRevision(stat);
    const detector = new ClaudeRepeatedDetector(
      restored,
      read,
      claudeRepeatedLookups(key, revision, restored.through),
      deadline === Infinity ? undefined : () => performance.now() >= deadline,
    );
    // Background completion resumes inside the line where its last step stopped, while the bytes that
    // line's identity came from hold.
    const kept = whole ? undefined : coverageCursors.get(key);
    coverageCursors.delete(key);
    let resumed: CoverageCursor | undefined;
    if (kept && kept.revision === revision && kept.lineStart === restored.through && kept.position <= stat.size) {
      const check = samplesHold(read, kept.samples);
      spent += check.readBytes;
      if (check.holds) resumed = kept;
    }
    const chunk = Buffer.allocUnsafe(LOOKUP_CHUNK_BYTES);
    const line = resumed?.line ?? new LineIdentity(restored.through > 0);
    let lineStart = restored.through;
    let position = resumed?.position ?? restored.through;
    let waiting = undefined as CoverageCursor['waiting'];
    let waitingSamples: ClaudeRepeatedSample[] = [];
    // The first bytes of each chunk read forward, for the final revision check.
    const flight: ClaudeRepeatedSample[] = [];
    let stopped = false;
    let lost = false;
    // Classifies the line that ends at `lineEnd`, and returns false when reading stops. The lookup for the
    // first line of a background step always reads one chunk, so every step makes progress. `samples`
    // gives the samples of the line, which a paused lookup keeps.
    const classify = (
      identity: ClaudeRecordIdentity | null,
      lineEnd: number,
      samples: () => ClaudeRepeatedSample[],
    ): boolean => {
      const progress = !whole && lineStart === restored.through;
      const repeat = detector.repeatedIdentityAt(
        identity,
        lineStart,
        lineEnd,
        Math.max(progress ? 1 : 0, allowance - spent),
        progress,
      );
      spent += detector.takeConfirmingBytes();
      if (repeat === null) lost = true;
      else if (repeat === 'pending') {
        waiting = { identity, end: lineEnd };
        waitingSamples = samples();
        stopped = true;
      } else lineStart = lineEnd;
      return lineStart === lineEnd && lineStart < stop;
    };
    const resumedWaiting = resumed?.waiting;
    let reading = resumedWaiting
      ? classify(resumedWaiting.identity, resumedWaiting.end, () => resumed!.samples)
      : lineStart < stop;
    while (reading && position < stop) {
      if (spent >= allowance || performance.now() >= deadline) {
        stopped = true;
        break;
      }
      const count = read(chunk, position, Math.min(chunk.length, Math.max(1, allowance - spent)));
      if (count <= 0) break;
      spent += count;
      flight.push(sampleOf(chunk, position, position, Math.min(SAMPLE_BYTES, count)));
      let at = 0;
      for (
        let newline = chunk.indexOf(10);
        reading && newline >= 0 && newline < count;
        newline = chunk.indexOf(10, at)
      ) {
        const identity = line.finish(chunk.subarray(at, newline));
        at = newline + 1;
        reading = classify(identity, position + at, () => line.finishedSamples(lineStart));
      }
      if (!reading) break;
      if (at < count) line.add(chunk.subarray(at, count));
      position += count;
    }
    if (!lost) {
      // The final revision check before the map is held: the file kept its identity and did not shrink or
      // change in place while this call read it, and it still holds the restored map's samples and the
      // first bytes of the chunks read forward.
      const after = fs.fstatSync(fd);
      lost =
        claudeFileRevision(after) !== revision ||
        after.size < stat.size ||
        (after.size === stat.size && after.mtimeMs !== stat.mtimeMs);
      if (!lost) {
        const check = samplesHold(read, [...(usable?.samples ?? []), ...spread(flight, FLIGHT_SAMPLES)]);
        spent += check.readBytes;
        lost = !check.holds;
      }
    }
    if (lost) {
      forgetFile(file);
      return null;
    }
    const state = detector.snapshot();
    spent += detector.takeConfirmingBytes();
    holdMap(file, stat, state);
    if (!whole && stopped) {
      if (waiting) {
        coverageCursors.set(key, {
          revision,
          lineStart,
          position: waiting.end,
          samples: waitingSamples,
          line: new LineIdentity(true),
          waiting,
        });
      } else if (position > lineStart) {
        coverageCursors.set(key, { revision, lineStart, position, samples: line.samples(lineStart), line });
      }
    }
    return { through: state.through, newest: state.newest, runs: state.runs, covered: !stopped, readBytes: spent };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') forgetFile(file);
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

// Whether the unfinished line `text` at byte `start`, past a covering map, repeats an earlier record.
// It reads at most `allowance` bytes before `deadline`, revision checks included. The result is
// 'pending' when that is not enough, and null when the file changed.
function confirmRepeated(
  file: string,
  text: string,
  start: number,
  allowance: number,
  deadline: number,
): { repeat: boolean | 'pending' | null; readBytes: number } {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const read = fileRead(file, fd, true);
    const checked = usableMap(file, stat, read);
    const usable = checked.state;
    if (!usable || usable.through > start) return { repeat: null, readBytes: checked.readBytes };
    const detector = new ClaudeRepeatedDetector(
      withoutSamples(usable),
      read,
      claudeRepeatedLookups(lookupKey(file), claudeFileRevision(stat), usable.through),
      deadline === Infinity ? undefined : () => performance.now() >= deadline,
    );
    const left = Math.max(0, allowance - checked.readBytes);
    const repeat = detector.repeatedAt(text, start, start + Buffer.byteLength(text), left, false);
    return { repeat, readBytes: checked.readBytes + detector.takeConfirmingBytes() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') forgetFile(file);
    return { repeat: null, readBytes: 0 };
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

// Background map completion. A bounded reader that finds its window not covered requests it, and the
// process extends the map in short steps between other work. Listeners hear each file whose map
// reaches the end of the file, so a host can drop cached reads of that file and draw once.
const COVERAGE_STEP_BYTES = 4 * 1024 * 1024;
const COVERAGE_STEP_MILLISECONDS = 25;
const coverageRequests = new Map<string, string>();
const coverageListeners = new Set<(file: string) => void>();
let coverageTimer: ReturnType<typeof setTimeout> | null = null;

export function onClaudeRepeatedCoverage(listener: (file: string) => void): () => void {
  coverageListeners.add(listener);
  return () => coverageListeners.delete(listener);
}

function scheduleCoverage(): void {
  if (coverageTimer !== null || coverageRequests.size === 0) return;
  coverageTimer = setTimeout(coverageStep, 0);
  coverageTimer.unref?.();
}

// A process without a listener has nobody to redraw, so it completes maps only through the readers
// that wait.
export function requestClaudeRepeatedCoverage(file: string): void {
  if (coverageListeners.size === 0) return;
  if (!coverageRequests.has(mapKey(file))) coverageRequests.set(mapKey(file), file);
  scheduleCoverage();
}

function coverageStep(): void {
  coverageTimer = null;
  const next = coverageRequests.entries().next();
  if (next.done) return;
  const [key, file] = next.value;
  coverageRequests.delete(key);
  const map = claudeRepeatedMap(
    file,
    Number.MAX_SAFE_INTEGER,
    COVERAGE_STEP_BYTES,
    performance.now() + COVERAGE_STEP_MILLISECONDS,
    false,
  );
  if (map && !map.covered) coverageRequests.set(key, file);
  if (map?.covered) {
    for (const listener of [...coverageListeners]) {
      try {
        listener(file);
      } catch {
        /* a listener failure does not stop coverage of other files */
      }
    }
  }
  scheduleCoverage();
}

// The identity, size and modification time of `file`, or null when it is gone.
function fileState(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${claudeFileRevision(stat)}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

// A bounded reader stops extending the map after this long.
const BOUNDED_MILLISECONDS = 50;

// A classifier for the lines of one window of `file` that ends at byte `end`. It returns true for a
// line the window reader must skip. A line without a record identity is never a repeated record. A line
// inside the map is skipped when it lies in a repeated run. A line the map does not reach is skipped
// until the map reaches it, and the classifier requests background completion for it. A reader with
// an `allowance` extends the map and confirms lines with at most that many bytes. Lines past a covering
// map are the unfinished tail of the file. Such a line is skipped only when it is not newer than every
// record before it and a lookup does not confirm that it is a first record.
export function claudeRepeatedClassifier(
  file: string,
  end: number,
  allowance = Infinity,
): (start: number, text: string) => boolean {
  const deadline = allowance === Infinity ? Infinity : performance.now() + BOUNDED_MILLISECONDS;
  let map = claudeRepeatedMap(file, end, allowance, deadline);
  let left = allowance - (map?.readBytes ?? 0);
  // The file as the map call left it. When it changed before the first classification, the classifier
  // takes the map again, so the revision check runs on the bytes the window reader read.
  const seen = fileState(file);
  let checked = false;
  let requested = false;
  const request = () => {
    if (requested) return;
    requested = true;
    requestClaudeRepeatedCoverage(file);
  };
  if (!map?.covered) request();
  let newest = map ? map.newest : 0;
  return (start, text) => {
    if (!checked) {
      checked = true;
      if (fileState(file) !== seen) {
        map = claudeRepeatedMap(file, end, Math.max(0, left), deadline);
        left -= map?.readBytes ?? 0;
        newest = map ? map.newest : 0;
        if (!map?.covered) request();
      }
    }
    if (map && start < map.through) return insideClaudeRepeated(map, start);
    const identity = claudeRecordIdentity(text);
    if (!identity) return false;
    if (!map?.covered) return true;
    if (identity.timestamp > newest) {
      newest = identity.timestamp;
      return false;
    }
    const confirmed = confirmRepeated(file, text, start, left, deadline);
    left -= confirmed.readBytes;
    if (confirmed.repeat === false) return false;
    if (confirmed.repeat !== true) request();
    return true;
  };
}

// Replaces each skipped line of a window with spaces of the same byte length, so the byte offsets
// of later lines stay true and no reader takes a field from it. `offset` is the first line's start.
export function blankClaudeRepeated(
  file: string,
  lines: string[],
  offset: number,
  end: number,
  allowance = Infinity,
): string[] {
  const skip = claudeRepeatedClassifier(file, end, allowance);
  let start = offset;
  return lines.map((line) => {
    const length = Buffer.byteLength(line);
    const lineStart = start;
    start += length + 1;
    return skip(lineStart, line) ? ' '.repeat(length) : line;
  });
}
