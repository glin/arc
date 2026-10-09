// Claude Code can append a second copy of earlier transcript records to the same file. A copy
// keeps its original top-level `uuid` and `timestamp`. `docs/timeline.md` describes the shape and
// the rule under "Claude repeated records". A record is a copy when an earlier record in the same
// file has the same top-level `uuid` and `timestamp`. Every reader applies that rule through
// `ClaudeCopyDetector`, so a record classifies the same in a whole-file read and in resumed slices.
//
// The first record with an identity raises the newest timestamp to at least its own, so a copy is
// never newer than the newest record read before it. Only those records need a lookup. The
// detector keeps a checkpoint about once per MiB: a line start, the newest timestamp before that
// line, and the oldest timestamp of a first record inside the interval it opens. The original of a
// copy lies in an interval whose oldest first record is not newer than the copy, at or after the
// last checkpoint older than the copy. A lookup reads only those intervals.
//
// A copied run copies an earlier run of records in order. The detector saves the byte offset after
// the original of the last copy it found, and a lookup reads the next few records from there before
// it reads any interval. A slice that resumes inside a run then reads each original once, in order.

export const CLAUDE_COPY_CHECKPOINT_BYTES = 1024 * 1024;

// The oldest timestamp of an interval that holds no first record with an identity.
const NO_RECORD = Number.MAX_SAFE_INTEGER;

// The saved detector for one file, beside the byte offset its reader resumes from.
export interface ClaudeCopyState {
  // Byte offset after the last line the detector classified.
  through: number;
  // Newest record timestamp read, epoch milliseconds. Zero before the first record.
  newest: number;
  // Triples in file order: a line start, the newest timestamp read before that line, and the
  // oldest timestamp of a first record between that line and the next checkpoint.
  checkpoints: number[];
  // Pairs of the start and end byte of each run of copied records, in file order.
  copies: number[];
  // The byte offset after the original of the last copy found, or 0. A lookup reads forward from it.
  origin: number;
  // While the lookup for the line at `through` is paused: the offset before which the intervals it
  // reads hold no original of that line. Zero otherwise.
  searched: number;
}

export interface ClaudeRecordIdentity {
  uuid: string;
  timestamp: number;
}

// Reads up to `length` bytes at `position` into `buffer`, and returns the count read.
export type ClaudeCopyRead = (buffer: Buffer, position: number, length: number) => number;

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
  const raw = line.slice(open + 1, close);
  if (raw.indexOf('\\') < 0) return raw;
  try {
    return JSON.parse(line.slice(open, close + 1)) as string;
  } catch {
    return null;
  }
}

// The record's own `uuid` and `timestamp`, read from the top level of the JSON object only. A key
// inside nested content, such as a tool input, never supplies the identity. A line without both
// top-level fields as strings, or a line that is not one JSON object, has no identity.
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
          const value = field === 'other' ? null : stringValue(line, index, close);
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

function identityKey(identity: ClaudeRecordIdentity): string {
  return `${identity.uuid}\n${identity.timestamp}`;
}

// A filter for a reader that reads one file forward from byte 0. It returns true for a copy. The
// filter applies the same detector as a resumed reader. Its offsets count characters, which only
// place checkpoints that it never saves.
export function createClaudeCopyFilter(): (line: string) => boolean {
  const detector = new ClaudeCopyDetector();
  let offset = 0;
  return (line) => {
    const start = offset;
    offset += line.length + 1;
    return detector.copyAt(line, start, offset) === true;
  };
}

export function emptyClaudeCopyState(): ClaudeCopyState {
  return { through: 0, newest: 0, checkpoints: [], copies: [], origin: 0, searched: 0 };
}

// Whether the byte at `offset` lies inside a copied run of the saved map.
export function insideClaudeCopy(state: Pick<ClaudeCopyState, 'copies'> | undefined, offset: number): boolean {
  const copies = state?.copies ?? [];
  let low = 0;
  let high = copies.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (offset < copies[middle * 2]) high = middle - 1;
    else if (offset >= copies[middle * 2 + 1]) low = middle + 1;
    else return true;
  }
  return false;
}

export function validClaudeCopyState(value: unknown): value is ClaudeCopyState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  const integers = (list: unknown, group: number): list is number[] =>
    Array.isArray(list) && list.length % group === 0 && list.every((item) => Number.isSafeInteger(item) && item >= 0);
  const offset = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  const { through, newest, origin, searched } = state;
  if (!offset(through) || !offset(newest)) return false;
  if (!offset(origin) || !offset(searched) || origin > through || searched > through) return false;
  const checkpoints = state.checkpoints;
  const copies = state.copies;
  if (!integers(checkpoints, 3) || !integers(copies, 2)) return false;
  // Checkpoint offsets rise from byte 0, and their newest timestamps never fall.
  for (let index = 0; index < checkpoints.length; index += 3) {
    if (index === 0 ? checkpoints[0] !== 0 : checkpoints[index] <= checkpoints[index - 3]) return false;
    if (index > 0 && checkpoints[index + 1] < checkpoints[index - 2]) return false;
    if (checkpoints[index] > through || checkpoints[index + 1] > newest) return false;
  }
  // Copied runs are ordered, disjoint, and not empty.
  for (let index = 0; index < copies.length; index++) {
    if (index % 2 ? copies[index] <= copies[index - 1] : index > 0 && copies[index] < copies[index - 1]) return false;
  }
  return copies.length === 0 || copies[copies.length - 1] <= through;
}

// The intervals that lookups already read in one file revision, with the identities they hold.
export interface ClaudeCopyLookups {
  // Pairs of byte ranges, ordered and disjoint. Each range ends at a line start.
  loaded: number[];
  // Each identity key, with the byte offset after its first line.
  keys: Map<string, number>;
}

// Lookups survive between slices of one process, so the slices of a copied run rarely read an
// interval twice. The total key count bounds the memory, and the least recently used files go first.
// A detector never depends on them for progress: the saved origin and search position carry it.
const LOOKUP_KEYS = 200_000;
const FILE_LOOKUP_KEYS = 50_000;
const lookups = new Map<string, { revision: string; held: ClaudeCopyLookups }>();

// The saved lookups of `file`, valid for a slice of `revision` whose restored offset is `through`.
// A slice that starts at byte 0 rebuilds the file, so it starts with no lookups.
export function claudeCopyLookups(file: string, revision: string, through: number): ClaudeCopyLookups {
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
export function forgetClaudeCopyLookups(file: string): void {
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

export class ClaudeCopyDetector {
  private readonly state: ClaudeCopyState;
  private nextCheckpoint: number;
  // Identity keys of every first record from `windowStart` up to `state.through`, each with the byte
  // offset after its line. Memory only.
  private readonly keys = new Map<string, number>();
  private readonly windowStart: number;
  // Byte ranges before `windowStart` that a lookup already read, and the identities they hold.
  private readonly held: ClaudeCopyLookups;
  private confirming = 0;
  private lostRevision = false;
  // The last chunk a lookup read. Consecutive lookups in a copied run read the same chunk.
  private ahead: { start: number; bytes: Buffer } | null = null;
  // The budget of the running lookup.
  private limit: {
    allowance: number;
    before: number;
    progress: boolean;
    probing: boolean;
    lineRead: boolean;
  } | null = null;

  // `read` supplies the bytes before a restored offset when a lookup needs them. A reader passes
  // its own open file, so a lookup reads the revision the reader reads. `saved` holds the lookups of
  // earlier slices of the same revision, and must cover only bytes before the restored offset.
  // `expired` reports a spent time budget, which pauses a lookup the way a spent byte budget does.
  constructor(
    restored?: ClaudeCopyState,
    private readonly read?: ClaudeCopyRead,
    saved?: ClaudeCopyLookups,
    private readonly expired?: () => boolean,
  ) {
    this.held = saved ?? { loaded: [], keys: new Map() };
    this.state = restored
      ? { ...restored, checkpoints: [...restored.checkpoints], copies: [...restored.copies] }
      : emptyClaudeCopyState();
    this.windowStart = this.state.through;
    const last = this.state.checkpoints.length - 3;
    this.nextCheckpoint = last >= 0 ? this.state.checkpoints[last] + CLAUDE_COPY_CHECKPOINT_BYTES : 0;
  }

  // Classifies the line at bytes [start, end). Returns true for a copy. A lookup reads new bytes
  // only while it has read fewer than `allowance` bytes and the time budget lasts. A lookup with a
  // positive allowance always reads at least one line of the intervals it searches. When the budget
  // runs out first, `copyAt` returns 'pending' and leaves the line unclassified. Only a lookup with
  // `progress` set reads past a spent time budget, so a slice gives that allowance to its first line
  // alone. A detector restored from the snapshot resumes the lookup where it stopped. Returns null
  // when a lookup cannot read the bytes before the restored offset. The detector then classifies
  // nothing more.
  copyAt(line: string, start: number, end: number, allowance = Infinity, progress = true): boolean | 'pending' | null {
    if (this.lostRevision) return null;
    if (start < this.state.through) return insideClaudeCopy(this.state, start);
    const points = this.state.checkpoints;
    if (start >= this.nextCheckpoint) {
      points.push(start, this.state.newest, NO_RECORD);
      this.nextCheckpoint = start + CLAUDE_COPY_CHECKPOINT_BYTES;
    }
    const identity = claudeRecordIdentity(line);
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
        if (original !== 'absent') {
          this.state.origin = original;
          this.state.through = end;
          const copies = this.state.copies;
          if (copies.length && copies[copies.length - 1] === start) copies[copies.length - 1] = end;
          else copies.push(start, end);
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

  snapshot(): ClaudeCopyState {
    return { ...this.state, checkpoints: [...this.state.checkpoints], copies: [...this.state.copies] };
  }

  // Finds the original of a record before `windowStart`. A copied run copies an earlier run in
  // order, so the lookup first reads the records after the last original found. Otherwise it reads
  // the checkpoint intervals that can hold the original.
  private lookUp(key: string, timestamp: number, start: number, allowance: number, progress: boolean): LookupResult {
    const limit = { allowance, before: this.confirming, progress, probing: true, lineRead: false };
    this.limit = limit;
    try {
      const { origin, searched } = this.state;
      if (searched === 0 && origin > 0 && origin < this.windowStart) {
        const probed = this.probe(key, origin);
        if (probed !== 'absent') return probed;
      }
      limit.probing = false;
      limit.lineRead = false;
      return this.confirm(key, timestamp, start);
    } finally {
      this.limit = null;
    }
  }

  // Whether the running lookup can read new bytes. A lookup without `progress` reads nothing once
  // the time budget is spent. Otherwise a probe reads a bounded stretch, so it only needs a positive
  // allowance, and an interval search reads one line before it checks the budget.
  private mayRead(): boolean {
    const limit = this.limit;
    if (!limit) return true;
    if (limit.allowance <= 0) return false;
    if (!limit.progress && this.expired?.() === true) return false;
    if (limit.probing || !limit.lineRead) return true;
    return this.confirming - limit.before < limit.allowance && this.expired?.() !== true;
  }

  private probe(key: string, origin: number): LookupResult {
    let records = 0;
    let found: number | undefined;
    const scanned = this.scan(origin, this.windowStart, (text, lineEnd) => {
      const identity = claudeRecordIdentity(text);
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
          const scanned = this.scan(position, gapEnd, (text, lineEnd) => {
            const identity = claudeRecordIdentity(text);
            const name = identity ? identityKey(identity) : null;
            if (name !== null && !found.has(name)) found.set(name, lineEnd);
            return false;
          });
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

  // Reads the lines of [from, to) in order, and passes each to `visit` with the byte offset after
  // it. `visit` returns true to stop after its line. Returns the offset where reading stopped, and
  // whether the lookup budget stopped it at that line start. Returns null when the file ends before
  // `to`. `from` and `to` are line starts.
  private scan(
    from: number,
    to: number,
    visit: (text: string, lineEnd: number) => boolean,
  ): { at: number; paused: boolean } | null {
    if (!this.read) return null;
    // A forward reader drops NUL bytes before a line after byte 0, so a lookup does too.
    const text = (bytes: Buffer, lineStart: number) => {
      let first = 0;
      if (lineStart > 0) while (bytes[first] === 0) first++;
      return bytes.toString('utf8', first);
    };
    let parts: Buffer[] = [];
    let lineStart = from;
    let position = from;
    while (position < to) {
      const bytes = this.readAhead(position, to);
      if (bytes === null) return null;
      if (bytes === 'pause') return { at: lineStart, paused: true };
      let at = 0;
      for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, at)) {
        const piece = bytes.subarray(at, newline);
        const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
        parts = [];
        const lineEnd = position + newline + 1;
        if (this.limit) this.limit.lineRead = true;
        if (visit(text(line, lineStart), lineEnd)) return { at: lineEnd, paused: false };
        lineStart = lineEnd;
        at = newline + 1;
      }
      if (at < bytes.length) parts.push(Buffer.from(bytes.subarray(at)));
      position += bytes.length;
    }
    if (parts.length) visit(text(Buffer.concat(parts), lineStart), to);
    return { at: to, paused: false };
  }

  // The bytes from `position` up to at most `to`, from the last chunk read when it holds them.
  // Returns 'pause' when the bytes need a new read that the lookup budget does not allow.
  private readAhead(position: number, to: number): Buffer | 'pause' | null {
    const ahead = this.ahead;
    if (ahead && position >= ahead.start && position < ahead.start + ahead.bytes.length) {
      return ahead.bytes.subarray(position - ahead.start, Math.min(ahead.bytes.length, to - ahead.start));
    }
    if (!this.mayRead()) return 'pause';
    const buffer = Buffer.allocUnsafe(Math.min(LOOKUP_CHUNK_BYTES, to - position));
    const read = this.read!(buffer, position, buffer.length);
    if (read <= 0) return null;
    this.confirming += read;
    this.ahead = { start: position, bytes: buffer.subarray(0, read) };
    return this.ahead.bytes;
  }
}
