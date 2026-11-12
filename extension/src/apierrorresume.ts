import fs from 'node:fs';

// Automatic resume of a Claude session that stopped on a temporary API error.
// A turn that ends on a failed request leaves a synthetic assistant record with `isApiErrorMessage: true`.
// Arc resumes that same session with a short prompt, at most `RESUME_LIMIT` times in one run of failures.

export type ApiErrorKind = 'transient' | 'permanent';

// Error types that Claude Code writes in the record's `error` field.
// A quota, a login, a billing problem, or a refused request never clears by itself, so Arc never resumes it.
const PERMANENT_TYPES = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'rate_limit',
  'cloud_credential_error',
  'max_output_tokens',
]);
const TRANSIENT_TYPES = new Set(['server_error', 'overloaded']);
const PERMANENT_STATUS = new Set([400, 401, 402, 403, 404, 413, 429]);
const PERMANENT_TEXT =
  /authenticat|unauthori[sz]ed|forbidden|\blog ?in\b|oauth|credential|api key|invalid.request|billing|credit balance|quota|usage limit|session limit|weekly limit|usage credits|hit your|reached your|safeguards|can't help|cannot help|not_found|does not exist|permission/i;
const TRANSIENT_TEXT =
  /unable to connect|connection (?:lost|reset|refused|error|closed)|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|\bSSL\b|\bTLS\b|certificate|handshake|timed? ?out|stalled|stopped arriving|overloaded|server error|API Error: 5\d\d\b/i;

// The kind of a Claude API error record, or null when the record is not one or matches neither list.
// A permanent signal wins over a transient one. An unmatched error is never resumed.
export function classifyApiError(record: Record<string, unknown>): ApiErrorKind | null {
  if (record.isApiErrorMessage !== true) return null;
  const type = typeof record.error === 'string' ? record.error : null;
  const status = typeof record.apiErrorStatus === 'number' ? record.apiErrorStatus : null;
  const text = recordText(record);
  if ((type && PERMANENT_TYPES.has(type)) || (status !== null && PERMANENT_STATUS.has(status))) return 'permanent';
  if (PERMANENT_TEXT.test(text)) return 'permanent';
  if ((type && TRANSIENT_TYPES.has(type)) || (status !== null && (status === 408 || status >= 500))) return 'transient';
  if (TRANSIENT_TEXT.test(text)) return 'transient';
  return null;
}

function recordText(record: Record<string, unknown>): string {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const text = (block as { text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n')
    .trim();
}

export interface ApiErrorFact {
  // The error record's `uuid`. One error record gets at most one resume.
  record: string;
  at: number;
  text: string;
  kind: ApiErrorKind | null;
}

export interface SessionTail {
  // The final user or assistant record when it is an API error, else null.
  error: ApiErrorFact | null;
  // Distinct Arc resume prompts after the newest model answer. They count toward `RESUME_LIMIT`.
  resumes: number;
}

// The complete lines of a transcript tail. `cut` is true when the read started after the beginning of the file.
export interface TailRead {
  lines: string[];
  cut: boolean;
}

// The wait before each resume, measured from the error record's clock. Each wait is four times the one before.
export const RESUME_DELAYS_MS = [2, 8, 32].map((minutes) => minutes * 60_000);
export const RESUME_LIMIT = RESUME_DELAYS_MS.length;
// Arc leaves an error older than six hours alone.
export const RESUME_WINDOW_MS = 6 * 60 * 60_000;
const RESUME_TEXT =
  'Continue from where you left off. Your previous request failed with a temporary API error, and Arc resumed this session automatically';

export function resumePrompt(attempt: number): string {
  return `${RESUME_TEXT} (attempt ${attempt} of ${RESUME_LIMIT}).`;
}

const NO_ERROR: SessionTail = { error: null, resumes: 0 };

// Reads the final user or assistant record of a main session transcript, oldest line first.
// Title, cost, and queue records after an error leave it final. The transcript carries the resume count,
// so a reload or a second window counts the same resumes. A final line that does not parse is a record still
// being written, so the tail reports no error until it is complete. A tail cut before the newest model answer
// cannot show every resume, so it also reports no error.
export function sessionTail(lines: readonly string[], cut = false): SessionTail {
  let error: ApiErrorFact | null = null;
  const resumes = new Set<string>();
  let last = true;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].trim()) continue;
    const record = parseRecord(lines[index]);
    if (last && !record) return NO_ERROR;
    last = false;
    if (!record || record.isSidechain === true || (record.type !== 'user' && record.type !== 'assistant')) continue;
    if (error === null) {
      const at = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
      if (record.isApiErrorMessage !== true || typeof record.uuid !== 'string' || !Number.isFinite(at)) return NO_ERROR;
      error = {
        record: record.uuid,
        at,
        text: recordText(record),
        kind: classifyApiError(record),
      };
    } else if (record.type === 'user') {
      // Claude Code can write one record again, for example after a compaction. The uuid names the prompt.
      if (recordText(record).startsWith(RESUME_TEXT))
        resumes.add(typeof record.uuid === 'string' ? record.uuid : `line ${index}`);
    } else if (
      record.isApiErrorMessage !== true &&
      (record.message as { model?: unknown } | undefined)?.model !== '<synthetic>'
    ) {
      return { error, resumes: resumes.size };
    }
  }
  return cut ? NO_ERROR : { error, resumes: resumes.size };
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const TAIL_BYTES = 256 * 1024;

// The complete lines in the last `bytes` of a file. A cut first line is dropped.
export function readTailLines(file: string, bytes = TAIL_BYTES): TailRead {
  const handle = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return start > 0 ? { lines: lines.slice(1), cut: true } : { lines, cut: false };
  } finally {
    fs.closeSync(handle);
  }
}

function tailFromRead(read: TailRead): SessionTail {
  return sessionTail(read.lines, read.cut);
}

export type ResumeDecision =
  | { kind: 'none' }
  | { kind: 'wait'; due: number; attempt: number }
  | { kind: 'resume'; attempt: number }
  | { kind: 'stop' };

// Decides what to do for one session from its transcript tail.
export function planResume(tail: SessionTail, now: number): ResumeDecision {
  const error = tail.error;
  if (!error || error.kind !== 'transient' || now - error.at > RESUME_WINDOW_MS) return { kind: 'none' };
  if (tail.resumes >= RESUME_LIMIT) return { kind: 'stop' };
  const attempt = tail.resumes + 1;
  const due = error.at + RESUME_DELAYS_MS[tail.resumes];
  return now >= due ? { kind: 'resume', attempt } : { kind: 'wait', due, attempt };
}

export interface ResumeCandidate {
  session: string;
  cwd: string | null;
  file: string;
  name: string;
}

export interface ResumePorts {
  // Sessions that qualify for a resume now. `PanelProvider.apiErrorCandidates` lists the rules.
  candidates(): readonly ResumeCandidate[];
  // Sends the prompt to the same session and never starts a new one. A refusal carries the failure text and shows nothing.
  deliver(candidate: ResumeCandidate, text: string): Promise<{ delivered: boolean; reason: string }>;
  notify(candidate: ResumeCandidate, message: string): void;
  now(): number;
  schedule(callback: () => void, delayMs: number): { dispose(): void };
  readTail?(file: string): TailRead;
}

interface HeldTail {
  size: number;
  mtimeMs: number;
  tail: SessionTail;
}

// Checks candidate sessions, resumes the ones that are due, and wakes itself for the next due resume.
// It saves nothing. `handled` holds the error records this window already resumed or reported,
// so a check that runs before the resume prompt reaches the transcript sends nothing.
export class ApiErrorResumer {
  private timer: { dispose(): void } | null = null;
  // Tails by transcript file, reused while the file keeps its size and modification time.
  private tails = new Map<string, HeldTail>();
  private readonly handled = new Set<string>();
  private running: Promise<void> | null = null;
  private again = false;
  private disposed = false;

  constructor(private readonly ports: ResumePorts) {}

  // Runs one check. A request during a check runs one more check after it.
  check(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.disposed);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.timer?.dispose();
    this.timer = null;
  }

  private tailOf(file: string, next: Map<string, HeldTail>): SessionTail {
    const stat = fs.statSync(file);
    const held = this.tails.get(file);
    const tail =
      held && held.size === stat.size && held.mtimeMs === stat.mtimeMs
        ? held.tail
        : tailFromRead((this.ports.readTail ?? readTailLines)(file));
    next.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, tail });
    return tail;
  }

  private async pass(): Promise<void> {
    let nextDue = Infinity;
    const tails = new Map<string, HeldTail>();
    for (const candidate of this.ports.candidates()) {
      if (this.disposed) return;
      let tail: SessionTail;
      try {
        tail = this.tailOf(candidate.file, tails);
      } catch {
        continue;
      }
      const error = tail.error;
      if (!error || this.handled.has(error.record)) continue;
      const decision = planResume(tail, this.ports.now());
      if (decision.kind === 'wait') {
        nextDue = Math.min(nextDue, decision.due);
      } else if (decision.kind === 'stop') {
        this.handled.add(error.record);
        this.ports.notify(
          candidate,
          `"${candidate.name}" stopped on an API error after ${tail.resumes} automatic resumes: ${error.text}`,
        );
      } else if (decision.kind === 'resume') {
        // An earlier delivery in this pass awaited, so the session can have started, been archived, or taken a prompt.
        if (!this.ports.candidates().some((current) => current.session === candidate.session)) continue;
        this.handled.add(error.record);
        let result: { delivered: boolean; reason: string };
        try {
          result = await this.ports.deliver(candidate, resumePrompt(decision.attempt));
        } catch (failure) {
          result = { delivered: false, reason: (failure as Error).message };
        }
        if (!result.delivered) {
          this.ports.notify(
            candidate,
            `"${candidate.name}" stopped on an API error, and Arc could not resume it: ${result.reason}`,
          );
        }
      }
    }
    this.tails = tails;
    this.timer?.dispose();
    this.timer = null;
    if (Number.isFinite(nextDue) && !this.disposed) {
      this.timer = this.ports.schedule(() => void this.check(), Math.max(1_000, nextDue - this.ports.now()));
    }
  }
}
