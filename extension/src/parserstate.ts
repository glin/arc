export const BACKGROUND_SCAN_BYTES = 1024 * 1024;
export const BACKGROUND_SCAN_MILLISECONDS = 15;

export interface ParserLine {
  text: string;
  start?: number;
  end?: number;
}

export function retainedParserPayload(value: unknown): number {
  const scan = retainedParserPayloadScan(value);
  for (;;) {
    const next = scan.next();
    if (next.done) return next.value;
  }
}

export function* retainedParserPayloadScan(value: unknown, limit = Number.POSITIVE_INFINITY): Generator<void, number> {
  const seen = new Set<object>();
  let bytes = 0;
  let visits = 0;
  function* children(item: object): Generator {
    if (Buffer.isBuffer(item)) {
      bytes += item.length;
    } else if (item instanceof Map) {
      bytes += item.size * 16;
      for (const [key, entry] of item) {
        yield key;
        yield entry;
      }
    } else if (item instanceof Set) {
      bytes += item.size * 16;
      yield* item;
    } else {
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        bytes += 16 + (typeof key === 'string' ? key.length * 2 : 8);
        yield descriptor && 'value' in descriptor ? descriptor.value : undefined;
      }
    }
  }
  const pending: Iterator<unknown>[] = [[value][Symbol.iterator]()];
  while (pending.length) {
    const next = pending[pending.length - 1].next();
    if (next.done) {
      pending.pop();
      continue;
    }
    const item = next.value;
    if (typeof item === 'string') {
      bytes += item.length * 2;
    } else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item);
      bytes += 32;
      pending.push(children(item));
    } else {
      bytes += 8;
    }
    if (bytes > limit) return bytes;
    if (++visits === 512) {
      visits = 0;
      yield;
    }
  }
  return bytes;
}

// Clone parser snapshots independently of the running reducer.
// Preserve Maps, shared references, symbols, and hidden activity metadata.
export function cloneParserState<T>(value: T): T {
  const seen = new Map<object, unknown>();
  const copy = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return input;
    }
    const prior = seen.get(input);
    if (prior !== undefined) {
      return prior;
    }
    if (Buffer.isBuffer(input)) {
      const buffer = Buffer.from(input);
      seen.set(input, buffer);
      return buffer;
    }
    if (input instanceof Set) {
      const set = new Set<unknown>();
      seen.set(input, set);
      for (const item of input) {
        set.add(copy(item));
      }
      return set;
    }
    if (input instanceof Map) {
      const map = new Map<unknown, unknown>();
      seen.set(input, map);
      for (const [key, item] of input) {
        map.set(copy(key), copy(item));
      }
      return map;
    }
    if (Array.isArray(input)) {
      const array: unknown[] = [];
      seen.set(input, array);
      for (const item of input) {
        array.push(copy(item));
      }
      return array;
    }
    const output = Object.create(Object.getPrototypeOf(input)) as Record<PropertyKey, unknown>;
    seen.set(input, output);
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor) {
        continue;
      }
      if ('value' in descriptor) {
        descriptor.value = copy(descriptor.value);
      }
      Object.defineProperty(output, key, descriptor);
    }
    return output;
  };
  return copy(value) as T;
}

// Claude child responses repeat in the transcript as they grow.
// The child usage reducer retains each request's latest event to replace revised usage.
// The request-key queue and event map must share this limit.
// A shorter map loses revisions. A longer map retains events the queue cannot reach.
// Parent reads keep every request key to avoid counting duplicate responses twice.
export const RETAINED_REQUESTS = 64;

// Trim events to the request keys at the end of the first-seen queue.
// Return the original object when it fits the limit or the queue is empty.
export function retainedRequestEvents<T>(
  seenRequestKeys: readonly string[],
  events: Record<string, T>,
  limit: number = RETAINED_REQUESTS,
): Record<string, T> {
  const held = Object.keys(events);
  // Preserve events when the queue is empty to avoid counting a revision as a new request.
  if (held.length <= limit || seenRequestKeys.length === 0) {
    return events;
  }
  const retained = new Set(seenRequestKeys.slice(-limit));
  const kept: Record<string, T> = {};
  for (const key of held) {
    if (retained.has(key)) {
      kept[key] = events[key];
    }
  }
  return kept;
}

// Trim retained request events in a saved parser state, including states whose transcript has stopped growing.
// Return the original state when its event map is unchanged.
export function withRetainedRequestEvents<T>(state: T, limit: number = RETAINED_REQUESTS): T {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return state;
  }
  const held = state as { seenRequestKeys?: unknown; requestEvents?: unknown };
  const events = held.requestEvents;
  if (!events || typeof events !== 'object' || Array.isArray(events)) {
    return state;
  }
  const keys = Array.isArray(held.seenRequestKeys)
    ? held.seenRequestKeys.filter((key): key is string => typeof key === 'string')
    : [];
  const kept = retainedRequestEvents(keys, events as Record<string, unknown>, limit);
  return kept === events ? state : ({ ...held, requestEvents: kept } as unknown as T);
}

// Retain the newest compaction timestamps. compactionCount() keeps the exact total.
export const RETAINED_COMPACTIONS = 16;

// Retain the newest main-chain Claude record ids. A prompt that names one of the ids read before
// a compaction proves the session abandoned that compaction.
export const RETAINED_COMPACTION_PARENTS = 8;

// Retain full detail for the newest cache-expiry return requests.
// Counts remain exact beyond this limit. Retained dollar totals become lower bounds.
export const RETAINED_CACHE_EXPIRY_RETURNS = 32;

// Worker postMessage uses structured clone, which drops symbol keys and non-enumerable fields.
// Reducers store open-turn byte ranges on symbols and pairing and call details on non-enumerable fields.
// Snapshots carry these fields in plain records and restore them when parsing resumes.

// Keys and field rules for hidden reducer state.
export interface HiddenStatePolicy {
  // Symbol keys for the building turn's byte range.
  start: symbol;
  end: symbol;
  membershipStart: symbol;
  // Codex rewrites exact step details when file-change records expand a call. Claude writes each detail once.
  redefinesDetail: boolean;
}

// Hidden fields for one retained turn.
// Emitted turns keep their ranges in turnRanges and turnMembershipStarts, so these three range values remain null.
export interface HiddenTurnState {
  start: number | null;
  end: number | null;
  membershipStart: number | null;
  steps: Array<{ id?: string; fullDetail?: string }>;
  agents: Array<{ toolUseId?: string }>;
}

export interface HiddenParserState {
  turns: HiddenTurnState[];
  open: HiddenTurnState | null;
  pending: HiddenTurnState | null;
}

// Snapshot slots for emitted turns, the building turn, and the Claude turn waiting for a successor prompt.
export interface HiddenTurnSlots {
  turns: readonly HiddenTurnHolder[];
  open: HiddenTurnHolder | null;
  pending: HiddenTurnHolder | null;
}

export interface HiddenTurnHolder {
  steps: ReadonlyArray<{ id?: string; fullDetail?: string }>;
  agents: ReadonlyArray<{ toolUseId?: string }>;
}

function hiddenNumber(value: object, key: symbol): number | null {
  const held = (value as { [index: symbol]: unknown })[key];
  return typeof held === 'number' ? held : null;
}

// Restore fields with the descriptors their parser uses.
// Non-configurable fields reject incompatible redefinitions. Configurable fields permit them.
// Matching descriptors keeps resumed reads consistent with cold reads.
function hide(value: object, key: PropertyKey, held: unknown, rewritable: boolean): void {
  if (held === undefined) {
    return;
  }
  Object.defineProperty(value, key, {
    value: held,
    enumerable: false,
    configurable: rewritable,
    writable: rewritable,
  });
}

function hiddenTurnState(turn: HiddenTurnHolder, policy: HiddenStatePolicy): HiddenTurnState {
  return {
    start: hiddenNumber(turn, policy.start),
    end: hiddenNumber(turn, policy.end),
    membershipStart: hiddenNumber(turn, policy.membershipStart),
    steps: turn.steps.map((step) => ({
      ...(step.id === undefined ? {} : { id: step.id }),
      ...(step.fullDetail === undefined ? {} : { fullDetail: step.fullDetail }),
    })),
    agents: turn.agents.map((agent) => (agent.toolUseId === undefined ? {} : { toolUseId: agent.toolUseId })),
  };
}

function applyHiddenTurnState(
  turn: HiddenTurnHolder,
  hidden: HiddenTurnState | null | undefined,
  policy: HiddenStatePolicy,
): void {
  if (!hidden) {
    return;
  }
  // Leave missing range values absent. An unknown start and byte zero expand differently on later records.
  // Range fields remain configurable and writable because subsequent records expand them.
  if (hidden.start !== null) {
    hide(turn, policy.start, hidden.start, true);
  }
  if (hidden.end !== null) {
    hide(turn, policy.end, hidden.end, true);
  }
  if (hidden.membershipStart !== null) {
    hide(turn, policy.membershipStart, hidden.membershipStart, true);
  }
  hidden.steps.forEach((fields, index) => {
    const step = turn.steps[index];
    if (!step) {
      return;
    }
    if (step.id === undefined) {
      hide(step, 'id', fields.id, false);
    }
    if (step.fullDetail === undefined) {
      hide(step, 'fullDetail', fields.fullDetail, policy.redefinesDetail);
    }
  });
  hidden.agents.forEach((fields, index) => {
    const agent = turn.agents[index];
    if (!agent) {
      return;
    }
    if (agent.toolUseId === undefined) {
      hide(agent, 'toolUseId', fields.toolUseId, false);
    }
  });
}

export function hiddenParserState(slots: HiddenTurnSlots, policy: HiddenStatePolicy): HiddenParserState {
  return {
    turns: slots.turns.map((turn) => hiddenTurnState(turn, policy)),
    open: slots.open ? hiddenTurnState(slots.open, policy) : null,
    pending: slots.pending ? hiddenTurnState(slots.pending, policy) : null,
  };
}

export function applyHiddenParserState(
  slots: HiddenTurnSlots,
  hidden: HiddenParserState | undefined,
  policy: HiddenStatePolicy,
): void {
  if (!hidden) {
    return;
  }
  slots.turns.forEach((turn, index) => applyHiddenTurnState(turn, hidden.turns[index], policy));
  if (slots.open) {
    applyHiddenTurnState(slots.open, hidden.open, policy);
  }
  if (slots.pending) {
    applyHiddenTurnState(slots.pending, hidden.pending, policy);
  }
}
