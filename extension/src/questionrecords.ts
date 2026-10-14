import * as fs from 'node:fs';
import { readCompleteLines } from './transcript';
import { arr, obj, str } from './agentwire';
import { QuestionRecovery, type RecoveredQuestion } from './questionrecovery';

// Source scans retain their own byte cursors and never alter shared transcript checkpoints.
export class QuestionEvidenceReader {
  private readonly cursors = new Map<string, { offset: number; size: number; mtime: number }>();
  reconcile(recovery: QuestionRecovery, sourceFor: (agent: string, session: string) => string | null): void {
    if (!recovery.entries().length || !recovery.owns()) return;
    let budget = 2 * 1024 * 1024;
    const sources = new Map<string, Map<string, { items: Map<string, RecoveredQuestion>; identities: Set<string> }>>();
    for (const entry of recovery.entries()) {
      const source = sourceFor(entry.agent, entry.session);
      if (!source || source !== entry.source) continue;
      let sessions = sources.get(source);
      if (!sessions) sources.set(source, (sessions = new Map()));
      let index = sessions.get(entry.session);
      if (!index) sessions.set(entry.session, (index = { items: new Map(), identities: new Set() }));
      index.items.set(entry.ask.toolUseId, entry);
      index.identities.add(entry.identity);
    }
    for (const [source, sessions] of sources) {
      if (budget <= 0) break;
      try {
        const stat = fs.statSync(source);
        const previous = this.cursors.get(source);
        const offset =
          previous && stat.size >= previous.size && (stat.size !== previous.size || stat.mtimeMs === previous.mtime)
            ? previous.offset
            : 0;
        const end = Math.min(stat.size, offset + budget);
        const result = readCompleteLines(source, offset, end, (chunk) => {
          for (const line of chunk.split('\n'))
            for (const [session, index] of sessions)
              this.line(recovery, session, source, index.items, index.identities, line);
          return false;
        });
        budget -= end - offset;
        this.cursors.set(source, { offset: result.bytes, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        /* Missing or incomplete source evidence leaves saved questions unresolved. */
      }
    }
  }
  private line(
    recovery: QuestionRecovery,
    session: string,
    source: string,
    items: ReadonlyMap<string, RecoveredQuestion>,
    identities: ReadonlySet<string>,
    line: string,
  ): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const record = obj(value);
    if (!record) return;
    const recordedSession = str(record.session_id) ?? str(record.sessionId);
    if (recordedSession && recordedSession !== session) return;
    const payload = obj(record.payload);
    const message = obj(record.message);
    const content = message?.content ?? payload?.content;
    if (record.type === 'user' || (payload?.type === 'message' && payload.role === 'user')) {
      const text =
        typeof content === 'string'
          ? content
          : arr(content)
              .flatMap((block) => {
                const item = obj(block);
                return item && (item.type === 'input_text' || item.type === 'text') && typeof item.text === 'string'
                  ? [item.text]
                  : [];
              })
              .join('\n');
      recovery.reconcile(session, source, text, identities);
    }
    for (const block of arr(content)) {
      const result = obj(block);
      if (result?.type !== 'tool_result' || typeof result.tool_use_id !== 'string') continue;
      const entry = items.get(result.tool_use_id);
      if (!entry) continue;
      if (result.is_error === true) {
        if (
          record.interruptedByShutdown !== true &&
          (record.toolDenialKind === 'user-rejected' || record.toolDenialKind === 'permission-rule')
        )
          recovery.settle(entry.identity, 'cancelled');
        continue;
      }
      this.result(recovery, entry, result.content, record.toolUseResult);
    }
    if (payload?.type === 'function_call_output' && typeof payload.call_id === 'string') {
      const entry = items.get(payload.call_id);
      if (entry) this.result(recovery, entry, payload.output);
    }
  }
  private result(
    recovery: QuestionRecovery,
    entry: RecoveredQuestion,
    content: unknown,
    toolUseResult?: unknown,
  ): void {
    let value = obj(content);
    if (typeof content === 'string') {
      try {
        value = obj(JSON.parse(content));
      } catch {
        value = null;
      }
    }
    const answers = obj(value?.answers) ?? (entry.agent === 'claude' ? obj(obj(toolUseResult)?.answers) : null);
    const structured = answers && entry.ask.questions.every((question) => Object.hasOwn(answers, question.id));
    const textChoice =
      entry.agent === 'claude' &&
      entry.ask.questions.length === 1 &&
      typeof content === 'string' &&
      entry.ask.questions[0].options.some((option) => option.label === content);
    if (structured || textChoice) recovery.settle(entry.identity, 'answered');
  }
}
