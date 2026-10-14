import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomically } from './atomicfile';
import type { AskAnswer, QuestionAsk, WireEvent } from './agentwire';
import { asyncQuestionItem, buildQuestionReply, parseQuestionReply } from './codexreply';

export type QuestionDisposition = 'unresolved' | 'unknown' | 'answered' | 'declined' | 'cancelled';
export interface RecoveredQuestion {
  identity: string;
  agent: 'claude' | 'codex';
  session: string;
  cwd: string;
  source: string | null;
  turn: string | null;
  kind: 'claude' | 'codex-sync' | 'codex-async';
  ask: QuestionAsk;
  at: number;
  activation: string;
  disposition: QuestionDisposition;
  attempt?: { id: string; digest: string | null };
  settledQuestions?: string[];
  deliverySession?: string;
}
interface RecoveryData {
  version: 1;
  questions: RecoveredQuestion[];
  closed: string[];
}
interface RecoveryLease {
  activation: string;
  pid: number;
}
export interface RecoveryOptions {
  root: string;
  origin: string;
  activation: string;
  pid?: number;
  dead?: (pid: number) => boolean;
  write?: (file: string, text: string) => void;
  outstandingLimit?: number;
  payloadLimit?: number;
}
const empty = (): RecoveryData => ({ version: 1, questions: [], closed: [] });
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const outstanding = (entry: RecoveredQuestion): boolean =>
  entry.disposition === 'unresolved' || entry.disposition === 'unknown';
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
function exclusive(file: string, value: unknown): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function read(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function questionIdentity(agent: string, session: string, cwd: string, ask: QuestionAsk): string {
  const absolute = path.resolve(cwd).replace(/\\/g, '/');
  const binding = /^[a-z]:\//i.test(absolute) || process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  return digest(JSON.stringify([agent, session, binding, ask.toolUseId]));
}
export function questionContinuation(entry: RecoveredQuestion, answer: AskAnswer): string | null {
  if (answer.decision !== 'answer' || entry.ask.questions.some((q) => q.secret)) return null;
  const replies = entry.ask.questions.map((q) => ({
    questionItemId: q.id,
    question: q.question,
    answer: [...(answer.answers[q.id]?.labels ?? []), answer.answers[q.id]?.written ?? ''].filter(Boolean).join(', '),
  }));
  if (entry.kind === 'codex-async') return buildQuestionReply(replies);
  return (
    'Answer to an earlier question from this session. Continue with this answer.\n' +
    replies.map((reply) => `Question: ${reply.question}\nAnswer: ${reply.answer}`).join('\n\n')
  );
}

// Immutable lease successors allow one replacement activation without deleting another window's claim.
// Another origin never takes ownership through an absent activation.
export class QuestionRecovery {
  private data = empty();
  private readonly directory: string;
  private readonly file: string;
  private readonly leases: string;
  private released = false;
  private acquired = false;
  private readonly write: (file: string, text: string) => void;
  constructor(readonly options: RecoveryOptions) {
    if (!/^[a-f0-9-]{16,64}$/.test(options.origin) || !/^[a-f0-9-]{16,64}$/.test(options.activation))
      throw new Error('Question recovery ownership is unavailable.');
    this.directory = path.join(options.root, options.origin);
    this.file = path.join(this.directory, 'questions.json');
    this.leases = path.join(this.directory, 'leases');
    this.write = options.write ?? ((file, text) => writeFileAtomically(file, text, undefined, 0o600));
    try {
      const saved = read(this.file) as RecoveryData;
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.questions) ||
        !Array.isArray(saved.closed) ||
        saved.questions.length > 768 ||
        saved.closed.some((identity) => typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)) ||
        saved.questions.some(
          (entry) =>
            !entry ||
            !/^[a-f0-9]{64}$/.test(entry.identity) ||
            !['claude', 'codex'].includes(entry.agent) ||
            typeof entry.session !== 'string' ||
            typeof entry.cwd !== 'string' ||
            !['unresolved', 'unknown', 'answered', 'declined', 'cancelled'].includes(entry.disposition) ||
            entry.ask?.kind !== 'question' ||
            entry.ask.id !== `recovered:${entry.identity}` ||
            !Array.isArray(entry.ask.questions) ||
            entry.ask.questions.some(
              (question) =>
                typeof question.id !== 'string' ||
                typeof question.question !== 'string' ||
                typeof question.secret !== 'boolean' ||
                !Array.isArray(question.options),
            ),
        )
      )
        throw new Error();
      this.data = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Saved questions cannot be read.', { cause: error });
    }
  }
  private current(): RecoveryLease | null {
    let name = 'initial';
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(name)) throw new Error('Question recovery ownership is unavailable.');
      seen.add(name);
      let lease: RecoveryLease;
      try {
        lease = read(path.join(this.leases, name)) as RecoveryLease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      if (!/^[a-f0-9-]{16,64}$/.test(lease.activation) || !Number.isSafeInteger(lease.pid) || lease.pid <= 0)
        throw new Error();
      const successor = `${lease.activation}.next`;
      if (!fs.existsSync(path.join(this.leases, successor))) return lease;
      name = successor;
    }
  }
  owns(): boolean {
    if (this.released) return false;
    try {
      fs.mkdirSync(this.leases, { recursive: true });
      let previous = this.current();
      if (previous?.activation === this.options.activation) {
        this.acquired = true;
        return true;
      }
      if (
        previous &&
        !fs.existsSync(path.join(this.leases, `${previous.activation}.released`)) &&
        !(this.options.dead ?? dead)(previous.pid)
      )
        return false;
      try {
        exclusive(path.join(this.leases, previous ? `${previous.activation}.next` : 'initial'), {
          activation: this.options.activation,
          pid: this.options.pid ?? process.pid,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      previous = this.current();
      if (previous?.activation !== this.options.activation) return false;
      // Read after acquiring ownership because the predecessor can have saved newer dispositions.
      if (fs.existsSync(this.file)) this.data = read(this.file) as RecoveryData;
      this.acquired = true;
      return true;
    } catch {
      return false;
    }
  }
  release(): void {
    if (this.acquired && this.owns()) {
      try {
        exclusive(path.join(this.leases, `${this.options.activation}.released`), true);
      } catch {
        /* An unavailable release keeps recovery blocked until process termination. */
      }
    }
    this.released = true;
  }
  private save(next: RecoveryData): void {
    if (!this.owns()) throw new Error('Another window owns these saved questions.');
    const settled = next.questions.filter((entry) => !outstanding(entry)).sort((a, b) => b.at - a.at);
    let bytes = 0;
    next.questions = [
      ...next.questions.filter(outstanding),
      ...settled.filter((entry, index) => {
        bytes += Buffer.byteLength(JSON.stringify(entry));
        return index < 512 && bytes <= 4 * 1024 * 1024;
      }),
    ];
    this.write(this.file, JSON.stringify(next));
    this.data = next;
  }
  capture(
    agent: 'claude' | 'codex',
    session: string,
    cwd: string,
    ask: QuestionAsk,
    source: string | null = null,
  ): boolean {
    if (!ask.toolUseId || !session) return false;
    const identity = questionIdentity(agent, session, cwd, ask);
    if (!this.owns()) return false;
    if (this.data.closed.includes(identity)) return true;
    const held = this.data.questions.find((entry) => entry.identity === identity);
    const kind =
      agent === 'claude'
        ? 'claude'
        : ask.questions.some((q) => asyncQuestionItem(q.id) === ask.toolUseId)
          ? 'codex-async'
          : 'codex-sync';
    const entry: RecoveredQuestion = held
      ? {
          ...held,
          source: held.source ?? source,
          ask: {
            ...held.ask,
            questions: ask.questions.filter((question) => !held.settledQuestions?.includes(question.id)),
          },
        }
      : {
          identity,
          agent,
          session,
          cwd,
          source,
          turn: typeof ask.input.turnId === 'string' ? ask.input.turnId : null,
          kind,
          ask: {
            kind: 'question',
            id: `recovered:${identity}`,
            questions: ask.questions,
            input: {},
            toolUseId: ask.toolUseId,
          },
          at: Date.now(),
          activation: this.options.activation,
          disposition: 'unresolved',
        };
    const questions = [...this.data.questions.filter((q) => q.identity !== identity), entry];
    const pending = questions.filter(outstanding);
    if (
      pending.length > (this.options.outstandingLimit ?? 256) ||
      Buffer.byteLength(JSON.stringify(pending)) > (this.options.payloadLimit ?? 4 * 1024 * 1024)
    )
      return false;
    try {
      const claims = path.join(this.options.root, 'claims');
      fs.mkdirSync(claims, { recursive: true });
      const claim = path.join(claims, identity);
      try {
        exclusive(claim, this.options.origin);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (read(claim) !== this.options.origin) return false;
      this.save({ ...this.data, questions });
      return true;
    } catch {
      return false;
    }
  }
  entries(): RecoveredQuestion[] {
    return this.data.questions.filter(outstanding).map((entry) => structuredClone(entry));
  }
  bindSource(identity: string, source: string): void {
    const entry = this.data.questions.find((q) => q.identity === identity);
    if (!entry || entry.source) return;
    this.save({
      ...this.data,
      questions: this.data.questions.map((q) => (q.identity === identity ? { ...q, source } : q)),
    });
  }
  find(id: string): RecoveredQuestion | null {
    return this.entries().find((entry) => entry.ask.id === id) ?? null;
  }
  settle(identity: string, disposition: QuestionDisposition, deliverySession?: string): void {
    if (!this.data.questions.some((entry) => entry.identity === identity)) return;
    const closed = outstanding({ disposition } as RecoveredQuestion)
      ? this.data.closed
      : [...new Set([...this.data.closed, identity])];
    this.save({
      ...this.data,
      closed,
      questions: this.data.questions.map((entry) =>
        entry.identity === identity
          ? {
              ...entry,
              disposition,
              ...(deliverySession ? { deliverySession } : {}),
            }
          : entry,
      ),
    });
  }
  begin(identity: string, text: string | null, attemptId: string = randomUUID()): void {
    const entry = this.data.questions.find((q) => q.identity === identity);
    if (!entry || entry.disposition !== 'unresolved')
      throw new Error('This answer has already been sent. Its delivery is unknown.');
    this.save({
      ...this.data,
      questions: this.data.questions.map((q) =>
        q.identity === identity
          ? {
              ...q,
              disposition: 'unknown',
              attempt: { id: attemptId, digest: text === null ? null : digest(text) },
            }
          : q,
      ),
    });
  }
  closeSession(session: string): void {
    const identities = this.entries()
      .filter((entry) => entry.session === session)
      .map((entry) => entry.identity);
    if (!identities.length) return;
    this.save({
      ...this.data,
      closed: [...new Set([...this.data.closed, ...identities])],
      questions: this.data.questions.map((entry) =>
        identities.includes(entry.identity) ? { ...entry, disposition: 'cancelled' } : entry,
      ),
    });
  }
  resolved(
    agent: string,
    session: string,
    cwd: string,
    ask: QuestionAsk,
    event: Extract<WireEvent, { kind: 'askResolved' }>,
  ): void {
    const identity = questionIdentity(agent, session, cwd, ask);
    if (!event.outcome) return;
    this.settle(identity, event.outcome === 'failed' ? 'unresolved' : event.outcome);
  }
  reconcile(session: string, source: string, text: string, identities?: ReadonlySet<string>): void {
    const replies = parseQuestionReply(text);
    if (!replies) return;
    for (const entry of this.data.questions.filter(outstanding)) {
      if (
        (identities && !identities.has(entry.identity)) ||
        entry.agent !== 'codex' ||
        entry.session !== session ||
        entry.source !== source ||
        entry.kind !== 'codex-async'
      )
        continue;
      const answered = new Set(replies.map((reply) => reply.questionItemId));
      const questions = entry.ask.questions.filter((question) => !answered.has(question.id));
      if (questions.length === entry.ask.questions.length) continue;
      if (!questions.length) this.settle(entry.identity, 'answered');
      else
        this.save({
          ...this.data,
          questions: this.data.questions.map((q) =>
            q.identity === entry.identity
              ? {
                  ...q,
                  settledQuestions: [...new Set([...(q.settledQuestions ?? []), ...answered])],
                  ask: { ...q.ask, questions },
                }
              : q,
          ),
        });
    }
  }
}
