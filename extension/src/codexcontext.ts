import * as fs from 'node:fs';
import { readPreviousLines, type BackwardLineCursor, type FileRevision } from './transcript';
import { contextNumber, type ContextCategory, type ContextUnavailableReason } from './domain/context-detail';
import { codexRetainedContextTokens } from './codex';

export const CODEX_CONTEXT_BYTES = 16 * 1024 * 1024;
export const CODEX_CONTEXT_ITEMS = 4096;
const RECORD_BYTES = 512 * 1024;
const RECORDS = 20_000;

export interface CodexContextEstimate {
  kind: 'codex-retained-context';
  session: string;
  model: string;
  used: number;
  capacity: number;
  basis: 'request' | 'retained-estimate';
  categories: ContextCategory[];
}

export interface CodexContextUnavailable {
  kind: 'codex-context-unavailable';
  session: string;
  model: string;
  reason: ContextUnavailableReason;
}

export type CodexContextResult = CodexContextEstimate | CodexContextUnavailable;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Ordinary outputs precede live-history truncation. Replacement history already holds retained outputs.
export function estimateCodexContext(records: readonly unknown[], session: string): CodexContextEstimate | null {
  const result = inspectCodexContext(records, session);
  return result?.kind === 'codex-retained-context' ? result : null;
}

export function inspectCodexContext(records: readonly unknown[], session: string): CodexContextResult | null {
  let items: Record<string, unknown>[] = [];
  let checkpointItems = new Set<Record<string, unknown>>();
  let abortedThrough = 0;
  let model = '';
  let used: number | null = null;
  let capacity: number | null = null;
  let measured = false;
  let measurementModel = '';
  let unmeasuredInput = false;
  let incomplete = false;
  let compacted = false;
  let signature = '';
  let basis: CodexContextEstimate['basis'] = 'request';
  let opening = true;
  let ancestor: string | null = null;
  const ancestry = new Set([session]);
  const add = (value: unknown): boolean => {
    const item = object(value);
    if (!item || typeof item.type !== 'string' || items.length >= CODEX_CONTEXT_ITEMS) return false;
    if (
      ![
        'message',
        'function_call',
        'custom_tool_call',
        'function_call_output',
        'custom_tool_call_output',
        'reasoning',
        'compaction',
        'context_compaction',
        'agent_message',
        'tool_search_call',
        'tool_search_output',
        'web_search_call',
        'image_generation_call',
        'local_shell_call',
        'additional_tools',
        'configuration_update',
        'compaction_trigger',
      ].includes(item.type)
    )
      return false;
    items.push(item);
    return true;
  };
  for (const value of records) {
    const record = object(value);
    const payload = object(record?.payload);
    if (!record || !payload) return null;
    if (record.type === 'session_meta') {
      if (typeof payload.id !== 'string' || !payload.id) return null;
      if (opening ? payload.id !== session : payload.id !== ancestor) return null;
      if (!opening && ancestry.has(payload.id)) return null;
      ancestry.add(payload.id);
      if (payload.forked_from_id !== undefined && payload.forked_from_id !== null) {
        if (typeof payload.forked_from_id !== 'string' || !payload.forked_from_id) return null;
        ancestor = payload.forked_from_id;
      } else ancestor = null;
      opening = false;
    } else if (record.type === 'compacted') {
      if (!Array.isArray(payload.replacement_history) || !contextNumber(payload.window_number)) return null;
      if (
        payload.replacement_history_metadata !== undefined &&
        (!Array.isArray(payload.replacement_history_metadata) ||
          payload.replacement_history_metadata.length !== payload.replacement_history.length)
      )
        return null;
      items = [];
      for (const item of payload.replacement_history) if (!add(item)) return null;
      checkpointItems = new Set(items);
      abortedThrough = 0;
      used = null;
      measured = false;
      unmeasuredInput = false;
      incomplete = false;
      compacted = true;
      signature = '';
      const settings = object(object(payload.resume_metadata)?.previous_turn_settings);
      if (typeof settings?.model === 'string') model = settings.model;
    } else if (record.type === 'turn_context') {
      if (typeof payload.model !== 'string' || !payload.model) return null;
      if (model && model !== payload.model) measured = false;
      model = payload.model;
    } else if (record.type === 'response_item') {
      if (!add(payload)) return null;
      const input =
        payload.type === 'agent_message' ||
        (payload.type === 'message' && payload.role !== 'assistant' && payload.role !== 'system') ||
        [
          'function_call_output',
          'custom_tool_call_output',
          'tool_search_output',
          'additional_tools',
          'configuration_update',
        ].includes(String(payload.type));
      if (input) {
        measured = false;
        unmeasuredInput = true;
      }
      if (payload.type === 'configuration_update') incomplete = true;
    } else if (record.type === 'event_msg') {
      if (payload.type === 'thread_rolled_back') return null;
      if (payload.type === 'turn_aborted') abortedThrough = items.length;
      if (payload.type === 'thread_settings_applied') {
        const settings = object(payload.thread_settings);
        if (typeof settings?.model === 'string') {
          if (model && model !== settings.model) measured = false;
          model = settings.model;
        }
      }
      if (payload.type === 'token_count') {
        const info = object(payload.info);
        const usage = object(info?.last_token_usage);
        if (usage) {
          if (
            !contextNumber(usage.input_tokens) ||
            !contextNumber(usage.output_tokens) ||
            !contextNumber(info?.model_context_window) ||
            info.model_context_window === 0
          )
            return null;
          const total = usage.input_tokens + usage.output_tokens;
          const estimated = compacted && codexRetainedContextTokens(usage) !== null;
          if (usage.total_tokens !== undefined && !estimated && usage.total_tokens !== total) return null;
          const nextSignature = JSON.stringify([
            usage.input_tokens,
            usage.output_tokens,
            usage.cached_input_tokens ?? 0,
            usage.cache_write_input_tokens ?? 0,
            usage.reasoning_output_tokens ?? 0,
            usage.total_tokens ?? total,
          ]);
          if (nextSignature === signature) continue;
          signature = nextSignature;
          used = estimated ? (usage.total_tokens as number) : total;
          basis = estimated ? 'retained-estimate' : 'request';
          capacity = info.model_context_window;
          measured = true;
          measurementModel = model;
          unmeasuredInput = false;
        }
      }
    } else if (
      ![
        'world_state',
        'retained_context',
        'token_usage_record',
        'security_risk_score',
        'inter_agent_communication_metadata',
      ].includes(String(record.type))
    ) {
      return null;
    }
  }
  if (incomplete || used === null || capacity === null || !model || !contextNumber(used)) return null;
  const tokens = new Map<string, number>();
  const text = (name: string, value: string) => {
    tokens.set(name, (tokens.get(name) ?? 0) + Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
  };
  const calls = new Map<string, number>();
  const outputs = new Set<string>();
  const serverOutputs = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (item.type === 'message' || item.type === 'agent_message') {
      if (item.role === 'system') continue;
      if (
        (item.type === 'message' && !['developer', 'user', 'assistant'].includes(String(item.role))) ||
        !Array.isArray(item.content)
      )
        return null;
      for (const part of item.content) {
        const content = object(part);
        if (!content) return null;
        if (content.type === 'input_text' || content.type === 'output_text') {
          if (typeof content.text !== 'string') return null;
          text(item.role === 'developer' ? 'Instructions' : 'Messages', content.text);
        }
      }
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const input = item.type === 'function_call' ? item.arguments : item.input;
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof input !== 'string') return null;
      calls.set(`${item.type}:${item.call_id}`, index);
      text('Tool calls', item.name + (typeof item.namespace === 'string' ? item.namespace : '') + input);
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (typeof item.call_id !== 'string') return null;
      outputs.add(`${item.type === 'function_call_output' ? 'function_call' : 'custom_tool_call'}:${item.call_id}`);
      if (checkpointItems.has(item)) {
        if (typeof item.output === 'string') text('Tool results', item.output);
        else if (Array.isArray(item.output)) {
          for (const part of item.output) {
            const content = object(part);
            if (content?.type === 'input_text' && typeof content.text === 'string') text('Tool results', content.text);
          }
        }
      }
    } else if (item.type === 'local_shell_call') {
      if (item.call_id !== undefined && item.call_id !== null) {
        if (typeof item.call_id !== 'string') return null;
        calls.set(`function_call:${item.call_id}`, index);
      }
    } else if (item.type === 'tool_search_call' || item.type === 'tool_search_output') {
      if (item.execution !== 'server' && item.execution !== 'client') return null;
      if (typeof item.call_id !== 'string') {
        if (item.execution !== 'server' || (item.call_id !== undefined && item.call_id !== null)) return null;
        continue;
      }
      const key = `tool_search_call:${item.call_id}`;
      if (item.type === 'tool_search_call') calls.set(key, index);
      else {
        outputs.add(key);
        if (item.execution === 'server') serverOutputs.add(key);
      }
    }
  }
  if ([...outputs].some((id) => !calls.has(id) && !serverOutputs.has(id))) return null;
  if (model !== measurementModel) return null;
  const pending = [...calls].filter(([id]) => !outputs.has(id));
  if (pending.some(([, index]) => index < abortedThrough)) return null;
  if (pending.length || !measured) {
    if (!pending.length && !unmeasuredInput) return null;
    return {
      kind: 'codex-context-unavailable',
      session,
      model,
      reason: pending.length ? 'pending-tools' : 'awaiting-measurement',
    };
  }
  const categories: ContextCategory[] = [...tokens]
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ key: name, name, tokens: count, relationship: 'used' }));
  const attributed = categories.reduce((sum, row) => sum + row.tokens, 0);
  if (!categories.length) return null;
  if (used > attributed)
    categories.push({
      key: 'unattributed',
      name: 'Unattributed context',
      tokens: used - attributed,
      relationship: 'used',
    });
  return { kind: 'codex-retained-context', session, model, used, capacity, basis, categories };
}

export async function readCodexContext(
  file: string,
  session: string,
  revision: FileRevision,
  signal: AbortSignal,
): Promise<CodexContextResult | null> {
  let descriptor = -1;
  try {
    descriptor = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(RECORD_BYTES, revision.size));
    if (fs.readSync(descriptor, head, 0, head.length, 0) !== head.length) return null;
    const newline = head.indexOf(10);
    if (newline < 0) return null;
    const opening = JSON.parse(head.subarray(0, newline).toString('utf8'));
    if (opening.type !== 'session_meta' || opening.payload?.id !== session) return null;
    const end = Buffer.alloc(1);
    if (fs.readSync(descriptor, end, 0, 1, revision.size - 1) !== 1 || end[0] !== 10) return null;
    let cursor: BackwardLineCursor = { revision, end: revision.size, fragment: Buffer.alloc(0) };
    const records: unknown[] = [];
    let read = head.length;
    let boundary = false;
    while (cursor.end > 0 && read < CODEX_CONTEXT_BYTES && !boundary) {
      if (signal.aborted) return null;
      const length = Math.min(256 * 1024, CODEX_CONTEXT_BYTES - read);
      const batch = readPreviousLines(file, cursor, length);
      if (!batch) return null;
      read += cursor.end - batch.cursor.end;
      cursor = batch.cursor;
      if (cursor.fragment.length > RECORD_BYTES) return null;
      for (const line of batch.lines) {
        if (!line.text.trim()) continue;
        if (Buffer.byteLength(line.text) > RECORD_BYTES || records.length >= RECORDS) return null;
        const record = JSON.parse(line.text);
        records.push(record);
        if (record.type === 'compacted') {
          if (!Array.isArray(record.payload?.replacement_history) || !contextNumber(record.payload?.window_number))
            return null;
          boundary = true;
          break;
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!boundary && cursor.end > 0) return null;
    records.reverse();
    if (boundary) records.unshift(opening);
    return inspectCodexContext(records, session);
  } catch {
    return null;
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}
