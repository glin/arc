import { obj, str, num, type Json } from './agentwire';

export interface OutputRate {
  output: number;
  milliseconds: number;
}

export interface ResponseRate extends OutputRate {
  sessionId: string;
  responseId: string;
  model: string;
}

export const RESPONSE_RATE_LIMIT = 512;

function validRate(value: OutputRate): boolean {
  return (
    Number.isSafeInteger(value.output) &&
    value.output >= 0 &&
    Number.isFinite(value.milliseconds) &&
    value.milliseconds > 0
  );
}

function identity(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

export function savedResponseRates(value: unknown): ResponseRate[] {
  if (!Array.isArray(value)) return [];
  const rates: ResponseRate[] = [];
  for (const entry of value.slice(-RESPONSE_RATE_LIMIT)) {
    const rate = obj(entry);
    if (
      rate &&
      identity(rate.sessionId) &&
      identity(rate.responseId) &&
      identity(rate.model) &&
      validRate(rate as unknown as OutputRate)
    ) {
      rates.push({
        sessionId: rate.sessionId as string,
        responseId: rate.responseId as string,
        model: rate.model as string,
        output: rate.output as number,
        milliseconds: rate.milliseconds as number,
      });
    }
  }
  return rates;
}

export function retainResponseRate(rates: readonly ResponseRate[], rate: ResponseRate): ResponseRate[] {
  if (!validRate(rate)) return [...rates];
  return [
    ...rates.filter((held) => held.sessionId !== rate.sessionId || held.responseId !== rate.responseId),
    rate,
  ].slice(-RESPONSE_RATE_LIMIT);
}

export function responseRateForTurn(
  turn: { sessionId: string; model: string | null; responseIds?: readonly string[]; interrupted: boolean },
  rates: readonly ResponseRate[],
): OutputRate | undefined {
  if (turn.interrupted || !turn.model || !turn.responseIds?.length) return undefined;
  const ids = new Set(turn.responseIds);
  const matching = rates.filter(
    (rate) => rate.sessionId === turn.sessionId && rate.model === turn.model && ids.has(rate.responseId),
  );
  if (!matching.length || matching.some((rate) => !validRate(rate))) return undefined;
  return matching.reduce(
    (total, rate) => ({ output: total.output + rate.output, milliseconds: total.milliseconds + rate.milliseconds }),
    { output: 0, milliseconds: 0 },
  );
}

export function outputRateText(rate: OutputRate | undefined): string | null {
  return rate && validRate(rate) ? `${((rate.output * 1000) / rate.milliseconds).toFixed(1)} tok/s` : null;
}

// A single main response retains final cumulative usage until its terminal event.
export class ClaudeResponseClock {
  private pending: {
    responseId: string;
    model: string;
    sessionId: string;
    started: number;
    ended: number | null;
    output: number | null;
  } | null = null;
  private readonly completed: string[] = [];

  reset(): void {
    this.pending = null;
  }

  observe(wrapper: Json, now: number): { started?: string; completed?: ResponseRate } {
    if (wrapper.parent_tool_use_id !== null) {
      if (wrapper.parent_tool_use_id === undefined) this.reset();
      return {};
    }
    if (!identity(wrapper.session_id)) {
      this.reset();
      return {};
    }
    const event = obj(wrapper.event);
    if (!event) {
      this.reset();
      return {};
    }
    if (event.type === 'message_start') {
      this.reset();
      const message = obj(event.message);
      const responseId = identity(message?.id);
      const model = identity(message?.model);
      if (
        !responseId ||
        !model ||
        model === '<synthetic>' ||
        this.completed.includes(responseId) ||
        !Number.isFinite(now)
      )
        return {};
      this.pending = {
        responseId,
        model,
        sessionId: str(wrapper.session_id)!,
        started: now,
        ended: null,
        output: null,
      };
      return { started: responseId };
    }
    const pending = this.pending;
    if (!pending || pending.sessionId !== wrapper.session_id) {
      this.reset();
      return {};
    }
    if (event.type === 'message_delta' && str(obj(event.delta)?.stop_reason)) {
      const output = num(obj(event.usage)?.output_tokens);
      if (output === null || !Number.isSafeInteger(output) || output < 0) {
        this.reset();
        return {};
      }
      pending.output = output;
      pending.ended ??= now;
    }
    if (event.type !== 'message_stop') return {};
    this.reset();
    if (pending.output === null || pending.ended === null) return {};
    const rate: ResponseRate = {
      sessionId: pending.sessionId,
      responseId: pending.responseId,
      model: pending.model,
      output: pending.output,
      milliseconds: pending.ended - pending.started,
    };
    if (!validRate(rate)) return {};
    this.completed.push(pending.responseId);
    if (this.completed.length > RESPONSE_RATE_LIMIT) this.completed.shift();
    return { completed: rate };
  }
}

export interface CodexResponseClock {
  turnId: string | null;
  model: string | null;
  boundary: number | null;
  calls: string[];
  blocking: string[];
  seen: string[];
  rates: Array<OutputRate & { responseId: string }>;
  contaminated: boolean;
}

export function emptyCodexResponseClock(): CodexResponseClock {
  return {
    turnId: null,
    model: null,
    boundary: null,
    calls: [],
    blocking: [],
    seen: [],
    rates: [],
    contaminated: false,
  };
}

export function reduceCodexResponseClock(
  state: CodexResponseClock,
  record: { kind: string; at: number; payload: Json },
  owner: { sessionId: string | null; turnId: string | null; model: string | null; eligible: boolean },
): OutputRate | null {
  const { kind, payload, at } = record;
  if (kind === 'task_started') {
    Object.assign(state, emptyCodexResponseClock(), { turnId: owner.turnId });
    return null;
  }
  if (!owner.eligible || !owner.turnId || state.turnId !== owner.turnId || !Number.isFinite(at) || at <= 0) {
    state.boundary = null;
    state.contaminated = true;
    return null;
  }
  if (kind === 'compacted' || kind === 'turn_aborted' || kind === 'task_complete') {
    if (kind === 'compacted')
      state.rates = state.rates.filter((rate) => rate.responseId !== payload.compaction_response_id);
    if (kind === 'turn_aborted') state.rates = [];
    state.boundary = null;
    state.calls = [];
    state.blocking = [];
    return null;
  }
  if (kind === 'user_message' || (kind === 'message' && payload.role === 'user')) state.contaminated = true;
  if (kind === 'function_call' || kind === 'custom_tool_call') {
    const id = identity(payload.call_id);
    if (!id || state.calls.includes(id) || state.blocking.includes(id) || state.calls.length >= 256)
      state.contaminated = true;
    else state.calls.push(id);
  }
  if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
    const id = identity(payload.call_id);
    if (id && state.blocking.includes(id)) {
      state.blocking = state.blocking.filter((call) => call !== id);
      if (state.boundary !== null) state.boundary = Math.max(state.boundary, at);
    } else if (id && state.calls.includes(id)) state.calls = state.calls.filter((call) => call !== id);
    else state.contaminated = true;
  }
  if (kind !== 'token_usage_record') return null;
  const id = identity(payload.response_id);
  if (id && state.seen.includes(id)) return null;
  const usage = obj(payload.usage);
  const output = num(usage?.output_tokens);
  const reasoning = num(usage?.reasoning_output_tokens);
  if (
    !id ||
    payload.thread_id !== owner.sessionId ||
    payload.turn_id !== owner.turnId ||
    !owner.model ||
    output === null ||
    !Number.isSafeInteger(output) ||
    output < 0 ||
    reasoning === null ||
    !Number.isSafeInteger(reasoning) ||
    reasoning < 0 ||
    reasoning > output
  ) {
    state.boundary = null;
    state.contaminated = true;
    return null;
  }
  if (state.boundary !== null && at <= state.boundary) {
    state.boundary = null;
    state.contaminated = true;
    return null;
  }
  const rate =
    state.boundary !== null && state.model === owner.model && !state.contaminated && !state.blocking.length
      ? { output, milliseconds: at - state.boundary }
      : null;
  state.boundary = at;
  state.model = owner.model;
  state.blocking = state.calls;
  state.calls = [];
  state.contaminated = false;
  state.seen.push(id);
  if (state.seen.length > RESPONSE_RATE_LIMIT) state.seen.shift();
  if (rate && validRate(rate)) {
    state.rates.push({ ...rate, responseId: id });
    if (state.rates.length > RESPONSE_RATE_LIMIT) state.rates.shift();
  }
  return rate && validRate(rate) ? rate : null;
}
