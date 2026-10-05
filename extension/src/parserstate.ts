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

// Parser snapshots must remain independent of the running reducer while retaining Maps,
// shared references, symbols, and hidden activity metadata.
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

// A Claude child response is written to the transcript again as it grows, so its usage reducer
// keeps the last event for each request and emits a removal when a later line revises it. Those
// retained events are the largest field in a saved project spend record.
//
// In a child read, one number bounds both halves of that memory. It bounds the queue of
// request keys the reducer counts as seen, and the map of events a revision removes. They
// stay equal on purpose.
// A shorter event map refuses a revision the queue still calls counted. The request then
// keeps the smaller figure its first record reported. A longer map holds events for
// requests the queue already forgot, which no revision can ever reach.
//
// A parent read keeps no events and bounds nothing. A repeat there is a duplicate to drop, and
// a queue that forgets a request bills the same response a second time.
export const RETAINED_REQUESTS = 64;

// The events a state must keep: the ones whose request keys are newest in the first-seen queue.
// Returns the same object when nothing needs removing, so a caller can compare by reference.
export function retainedRequestEvents<T>(
  seenRequestKeys: readonly string[],
  events: Record<string, T>,
  limit: number = RETAINED_REQUESTS,
): Record<string, T> {
  const held = Object.keys(events);
  // An empty queue names nothing to keep. Dropping every event would turn the next revision
  // into a second request, so the state is left as it is.
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

// Trims the retained event window inside a saved parser state. A record written under a larger
// limit is otherwise never rewritten, because a transcript that stopped growing never runs its
// reducer again. Returns the same value when nothing changed.
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

// How many compaction times a usage reducer keeps. A compaction is rare beside a request, so
// a small window still covers the whole of nearly every session. compactionCount() stays the
// exact total, and this list only dates the newest of them.
export const RETAINED_COMPACTIONS = 16;

// How many cache-expiry return requests the derived ledger keeps in full. The counts beside
// them stay exact, so a source past this limit reports its dollars as a lower bound and its
// counts as the whole answer.
export const RETAINED_CACHE_EXPIRY_RETURNS = 32;

// A parser snapshot crosses the progressive worker boundary through `postMessage`, which
// copies it with structured clone. Structured clone keeps only enumerable string-keyed
// properties, so a symbol key and a non-enumerable field are both gone on the far side. A
// reducer keeps the open turn's byte range on symbol keys, and its pairing metadata and exact
// call detail on non-enumerable fields, so that none of it rides in the card payload. It
// therefore lifts that state into the plain record below when it hands a snapshot out, and
// puts it back when it builds from a restored one.

// How one reducer holds the state it hides.
export interface HiddenStatePolicy {
  // The symbol keys it holds a building turn's byte range on.
  start: symbol;
  end: symbol;
  membershipStart: symbol;
  // Whether this reducer rewrites a step's exact detail after the call that opened the step.
  // Codex does, when a file-change record expands the call. Claude writes the field once.
  redefinesDetail: boolean;
}

// What one retained turn hides. A turn already emitted keeps its byte range in the reducer's
// own `turnRanges` and `turnMembershipStarts`, so its three range values stay null.
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

// The turns one snapshot hides state for: those already emitted, the one still being built,
// and the Claude turn held back for a successor prompt.
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

// Restores a field with the descriptor its own parser writes. A parser seals what it writes
// once, so a resumed read has to seal the same field: a later `defineProperty` throws on a
// sealed field and is taken silently by a configurable one, which would make a resumed read
// behave differently from a cold read of the same bytes.
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
  // Left absent rather than set to zero when the record names none. A range that starts at an
  // unknown byte and one that starts at byte zero widen differently on the next record. Both
  // range writers leave these keys configurable and writable, because the range widens.
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
