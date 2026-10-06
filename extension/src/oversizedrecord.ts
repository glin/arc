// Reduces one oversized JSON record while it is read, so metadata recovery never holds the whole record.
// Structure passes through unchanged. A string longer than the cut keeps its first bytes and its last bytes, at most
// the cut length each, and drops the bytes between them. Each kept part starts and ends at a character boundary outside
// any escape, so the reduced record stays valid JSON. A `data:` string longer than the cut keeps only its media header
// through the first comma. The array under a `replacement_history` key becomes `[]`.

export const REDUCED_STRING_BYTES = 64 * 1024;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const LOWER_U = 0x75;
const DATA_PREFIX = Buffer.from('data:');
const DROPPED_KEY = Buffer.from('replacement_history');
const EMPTY_ARRAY = Buffer.from('[]');

function whitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

export interface ReducedRecord {
  bytes: Buffer;
  // False when the input ended inside a string, a container, or a dropped value.
  complete: boolean;
}

export class OversizedRecordReducer {
  private parts: Buffer[] = [];
  private outputBytes = 0;
  private depth = 0;
  private started = false;
  private malformed = false;
  private inString = false;
  // -1 directly after a backslash, then the hex digits a `\u` escape still owes.
  private escape = 0;
  private stringBytes = 0;
  // Output offset of the current string's first byte.
  private stringStart = 0;
  private cutting = false;
  private dataMatch = 0;
  // String offset just after the first comma of a `data:` string, or -1.
  private dataComma = -1;
  private keyMatch = 0;
  private afterDroppedKey = false;
  private dropNextArray = false;
  private skipDepth = 0;
  private skipInString = false;
  private skipEscape = false;
  // The end of a cut string, held until the string closes.
  private tailing = false;
  private tailParts: Buffer[] = [];
  private tailBytes = 0;
  private tailBase = 0;
  // String offsets where the kept end can start, at most one per mark step.
  private marks: number[] = [];
  private readonly markStep: number;

  constructor(private readonly stringLimit = REDUCED_STRING_BYTES) {
    this.markStep = Math.max(1, Math.min(1024, Math.floor(stringLimit / 16)));
  }

  // Reduced bytes held so far, including the held end of a string that is still being cut.
  get bytes(): number {
    return this.outputBytes + this.tailBytes;
  }

  push(chunk: Buffer): void {
    let run = -1;
    let tailRun = -1;
    const keep = (index: number) => {
      if (run < 0) run = index;
    };
    const drop = (index: number) => {
      if (run >= 0) this.emit(chunk.subarray(run, index));
      run = -1;
    };
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (this.skipDepth > 0) {
        drop(index);
        if (this.skipInString) {
          if (this.skipEscape) this.skipEscape = false;
          else if (byte === BACKSLASH) this.skipEscape = true;
          else if (byte === QUOTE) this.skipInString = false;
        } else if (byte === QUOTE) this.skipInString = true;
        else if (byte === OPEN_ARRAY || byte === OPEN_OBJECT) this.skipDepth++;
        else if (byte === CLOSE_ARRAY || byte === CLOSE_OBJECT) this.skipDepth--;
        continue;
      }
      if (this.inString) {
        // A boundary byte starts a character outside any escape, so a kept part can start or end before it.
        const boundary = this.escape === 0 && (byte & 0xc0) !== 0x80;
        if (this.escape === 0 && byte === QUOTE) {
          if (this.tailing) {
            this.holdTail(chunk, tailRun < 0 ? index : tailRun, index);
            tailRun = -1;
            this.releaseTail();
          }
          this.inString = false;
          this.afterDroppedKey = this.keyMatch === DROPPED_KEY.length && this.stringBytes === DROPPED_KEY.length;
          this.cutting = false;
          keep(index);
          continue;
        }
        if (!this.cutting && boundary && this.stringBytes >= this.stringLimit) {
          drop(index);
          this.cutting = true;
          if (this.dataComma >= 0) this.truncate(this.stringStart + this.dataComma);
          else {
            this.tailing = true;
            this.tailBase = this.stringBytes;
            this.marks = [this.stringBytes];
          }
        }
        if (this.stringBytes < DATA_PREFIX.length) {
          this.dataMatch =
            this.dataMatch === this.stringBytes && DATA_PREFIX[this.stringBytes] === byte ? this.dataMatch + 1 : -1;
        } else if (!this.cutting && this.dataComma < 0 && this.dataMatch === DATA_PREFIX.length && byte === COMMA) {
          this.dataComma = this.stringBytes + 1;
        }
        if (this.stringBytes < DROPPED_KEY.length) {
          this.keyMatch =
            this.keyMatch === this.stringBytes && DROPPED_KEY[this.stringBytes] === byte ? this.keyMatch + 1 : -1;
        }
        if (this.tailing && boundary && this.stringBytes - this.marks[this.marks.length - 1] >= this.markStep) {
          this.mark(this.stringBytes);
        }
        if (this.escape !== 0) this.escape = this.escape < 0 ? (byte === LOWER_U ? 4 : 0) : this.escape - 1;
        else if (byte === BACKSLASH) this.escape = -1;
        this.stringBytes++;
        if (this.cutting) {
          drop(index);
          if (this.tailing && tailRun < 0) tailRun = index;
        } else keep(index);
        continue;
      }
      if (this.dropNextArray && !whitespace(byte)) {
        this.dropNextArray = false;
        if (byte === OPEN_ARRAY) {
          drop(index);
          this.emit(EMPTY_ARRAY);
          this.skipDepth = 1;
          this.skipInString = false;
          this.skipEscape = false;
          continue;
        }
      }
      keep(index);
      if (byte === QUOTE) {
        this.inString = true;
        this.escape = 0;
        this.stringBytes = 0;
        this.stringStart = this.outputBytes + index + 1 - run;
        this.cutting = false;
        this.dataMatch = 0;
        this.dataComma = -1;
        this.keyMatch = 0;
        this.afterDroppedKey = false;
      } else if (byte === COLON) {
        this.dropNextArray = this.afterDroppedKey;
        this.afterDroppedKey = false;
      } else if (byte === OPEN_ARRAY || byte === OPEN_OBJECT) {
        this.depth++;
        this.started = true;
      } else if (byte === CLOSE_ARRAY || byte === CLOSE_OBJECT) {
        this.depth--;
        if (this.depth < 0) this.malformed = true;
      } else if (!whitespace(byte)) {
        this.afterDroppedKey = false;
      }
    }
    drop(chunk.length);
    if (this.tailing && tailRun >= 0) this.holdTail(chunk, tailRun, chunk.length);
  }

  finish(): ReducedRecord {
    const bytes = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.outputBytes);
    const complete = this.started && !this.malformed && this.depth === 0 && !this.inString && this.skipDepth === 0;
    this.parts = [];
    this.tailParts = [];
    this.tailBytes = 0;
    this.tailing = false;
    this.marks = [];
    return { bytes, complete };
  }

  private emit(bytes: Buffer): void {
    if (!bytes.length) return;
    // Copy, so a kept part never holds the read chunk alive.
    this.parts.push(Buffer.from(bytes));
    this.outputBytes += bytes.length;
  }

  // Drops the output after the given length.
  private truncate(length: number): void {
    while (this.outputBytes > length) {
      const last = this.parts[this.parts.length - 1];
      const excess = this.outputBytes - length;
      if (last.length <= excess) {
        this.parts.pop();
        this.outputBytes -= last.length;
      } else {
        this.parts[this.parts.length - 1] = last.subarray(0, last.length - excess);
        this.outputBytes = length;
      }
    }
  }

  private mark(offset: number): void {
    this.marks.push(offset);
    // A mark more than the cut length behind the newest one can never start the kept end.
    while (this.marks[0] < offset - this.stringLimit) this.marks.shift();
  }

  // Holds the string bytes chunk[from, to), which end at the current string offset. Drops the held bytes before the
  // first mark within the cut length of that offset, because the kept end can no longer include them.
  private holdTail(chunk: Buffer, from: number, to: number): void {
    const end = this.stringBytes;
    const runStart = end - (to - from);
    let keepFrom = end;
    for (const mark of this.marks) {
      if (mark >= end - this.stringLimit) {
        keepFrom = mark;
        break;
      }
    }
    while (this.tailParts.length && this.tailBase < keepFrom) {
      const part = this.tailParts[0];
      const excess = keepFrom - this.tailBase;
      if (part.length <= excess) {
        this.tailParts.shift();
        this.tailBytes -= part.length;
        this.tailBase += part.length;
      } else {
        this.tailParts[0] = part.subarray(excess);
        this.tailBytes -= excess;
        this.tailBase = keepFrom;
      }
    }
    if (!this.tailParts.length) this.tailBase = Math.max(runStart, keepFrom);
    const copyFrom = from + Math.max(0, keepFrom - runStart);
    if (copyFrom < to) {
      const part = Buffer.from(chunk.subarray(copyFrom, to));
      this.tailParts.push(part);
      this.tailBytes += part.length;
    }
  }

  private releaseTail(): void {
    for (const part of this.tailParts) this.parts.push(part);
    this.outputBytes += this.tailBytes;
    this.tailParts = [];
    this.tailBytes = 0;
    this.tailing = false;
    this.marks = [];
  }
}
