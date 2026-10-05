function cloneParserState(value) {
  const seen = /* @__PURE__ */ new Map();
  const copy = (input) => {
    if (input === null || typeof input !== "object") {
      return input;
    }
    const prior = seen.get(input);
    if (prior !== void 0) {
      return prior;
    }
    if (Buffer.isBuffer(input)) {
      const buffer = Buffer.from(input);
      seen.set(input, buffer);
      return buffer;
    }
    if (input instanceof Set) {
      const set = /* @__PURE__ */ new Set();
      seen.set(input, set);
      for (const item of input) {
        set.add(copy(item));
      }
      return set;
    }
    if (input instanceof Map) {
      const map = /* @__PURE__ */ new Map();
      seen.set(input, map);
      for (const [key, item] of input) {
        map.set(copy(key), copy(item));
      }
      return map;
    }
    if (Array.isArray(input)) {
      const array = [];
      seen.set(input, array);
      for (const item of input) {
        array.push(copy(item));
      }
      return array;
    }
    const output = Object.create(Object.getPrototypeOf(input));
    seen.set(input, output);
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor) {
        continue;
      }
      if ("value" in descriptor) {
        descriptor.value = copy(descriptor.value);
      }
      Object.defineProperty(output, key, descriptor);
    }
    return output;
  };
  return copy(value);
}
const RETAINED_REQUESTS = 64;
function retainedRequestEvents(seenRequestKeys, events, limit = RETAINED_REQUESTS) {
  const held = Object.keys(events);
  if (held.length <= limit || seenRequestKeys.length === 0) {
    return events;
  }
  const retained = new Set(seenRequestKeys.slice(-limit));
  const kept = {};
  for (const key of held) {
    if (retained.has(key)) {
      kept[key] = events[key];
    }
  }
  return kept;
}
function withRetainedRequestEvents(state, limit = RETAINED_REQUESTS) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return state;
  }
  const held = state;
  const events = held.requestEvents;
  if (!events || typeof events !== "object" || Array.isArray(events)) {
    return state;
  }
  const keys = Array.isArray(held.seenRequestKeys) ? held.seenRequestKeys.filter((key) => typeof key === "string") : [];
  const kept = retainedRequestEvents(keys, events, limit);
  return kept === events ? state : { ...held, requestEvents: kept };
}
const RETAINED_COMPACTIONS = 16;
const RETAINED_CACHE_EXPIRY_RETURNS = 32;
function hiddenNumber(value, key) {
  const held = value[key];
  return typeof held === "number" ? held : null;
}
function hide(value, key, held, rewritable) {
  if (held === void 0) {
    return;
  }
  Object.defineProperty(value, key, {
    value: held,
    enumerable: false,
    configurable: rewritable,
    writable: rewritable
  });
}
function hiddenTurnState(turn, policy) {
  return {
    start: hiddenNumber(turn, policy.start),
    end: hiddenNumber(turn, policy.end),
    membershipStart: hiddenNumber(turn, policy.membershipStart),
    steps: turn.steps.map((step) => ({
      ...step.id === void 0 ? {} : { id: step.id },
      ...step.fullDetail === void 0 ? {} : { fullDetail: step.fullDetail }
    })),
    agents: turn.agents.map((agent) => agent.toolUseId === void 0 ? {} : { toolUseId: agent.toolUseId })
  };
}
function applyHiddenTurnState(turn, hidden, policy) {
  if (!hidden) {
    return;
  }
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
    if (step.id === void 0) {
      hide(step, "id", fields.id, false);
    }
    if (step.fullDetail === void 0) {
      hide(step, "fullDetail", fields.fullDetail, policy.redefinesDetail);
    }
  });
  hidden.agents.forEach((fields, index) => {
    const agent = turn.agents[index];
    if (!agent) {
      return;
    }
    if (agent.toolUseId === void 0) {
      hide(agent, "toolUseId", fields.toolUseId, false);
    }
  });
}
function hiddenParserState(slots, policy) {
  return {
    turns: slots.turns.map((turn) => hiddenTurnState(turn, policy)),
    open: slots.open ? hiddenTurnState(slots.open, policy) : null,
    pending: slots.pending ? hiddenTurnState(slots.pending, policy) : null
  };
}
function applyHiddenParserState(slots, hidden, policy) {
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
export {
  RETAINED_CACHE_EXPIRY_RETURNS,
  RETAINED_COMPACTIONS,
  RETAINED_REQUESTS,
  applyHiddenParserState,
  cloneParserState,
  hiddenParserState,
  retainedRequestEvents,
  withRetainedRequestEvents
};
