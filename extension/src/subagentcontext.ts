// The estimated share of a session's context that holds text its subagents returned. Parsers
// record each returned text as it enters the main agent's context, and a compaction removes
// what it summarizes. The figure is an estimate from text size, never a tokenizer count.

// Tokens a text costs in context, estimated from its UTF-8 size at four bytes a token.
export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

// Median UTF-8 bytes per token of Claude subagent results with their frames, measured against recorded request usage.
export const CLAUDE_SUBAGENT_BYTES_PER_TOKEN = 2.79;

// Tokens a Claude subagent result costs in the main agent's context, estimated from its UTF-8
// size plus the size of a frame the request adds around it.
export function estimateClaudeSubagentTokens(text: string, frameBytes = 0): number {
  return Math.ceil((Buffer.byteLength(text, 'utf8') + frameBytes) / CLAUDE_SUBAGENT_BYTES_PER_TOKEN);
}

export interface SubagentContextLine {
  name: string;
  tokens: number;
}

export interface SubagentContextFigure {
  // Returned text still in context, including text no single subagent owns.
  tokens: number;
  // The read could not reach every result in context, so `tokens` covers less than the whole record.
  partial: boolean;
  // The newest compaction removed results and no result entered context after it.
  removed: boolean;
  // One line per subagent with text in context, largest first.
  agents: SubagentContextLine[];
}

interface SubagentContextAgent {
  name: string;
  tokens: number;
  // Fingerprints of the deliveries counted for this subagent, so a record read twice counts once.
  counted: string[];
}

// A result recorded after the newest request. It enters the figure when a request consumes it.
interface PendingSubagentResult {
  key: string | null;
  tokens: number;
  reduced: boolean;
  // The record form and a fingerprint of what the delivery carries, so one delivery written in
  // two forms counts once.
  form: string;
  match: string;
  // The source offset of the delivering record, or null when the read carries no offsets.
  at: number | null;
}

export interface SubagentContextState {
  // A result entered context at some point in the read.
  seen: boolean;
  tokens: number;
  agents: Array<[string, SubagentContextAgent]>;
  pending: PendingSubagentResult[];
  // The launch calls known to start a subagent, kept apart from row retention.
  launches: string[];
  // Whether the first line of the read started after the first byte of the record.
  begun: boolean;
  tail: boolean;
  headUnread: boolean;
  // A result in context came from a record cut before the parse, or from a launch the read missed.
  reduced: boolean;
  removed: boolean;
  // Whether the line being reduced was cut before the parse. Set for each line.
  lineReduced: boolean;
  // The source offset of the line being reduced, or null when the read carries no offsets.
  line: number | null;
  // The launch list dropped its oldest call, so a later completion notice can lack its launch.
  launchesDropped: boolean;
}

const COUNTED_LIMIT = 16;
const LAUNCH_LIMIT = 1024;
const PENDING_LIMIT = 1024;

export function emptySubagentContext(): SubagentContextState {
  return {
    seen: false,
    tokens: 0,
    agents: [],
    pending: [],
    launches: [],
    begun: false,
    tail: false,
    headUnread: false,
    reduced: false,
    removed: false,
    lineReduced: false,
    line: null,
    launchesDropped: false,
  };
}

// Notes where a read starts, where the current line starts, and whether it was cut before the
// parse. A null start means the read carries no offsets.
export function noteSubagentContextLine(state: SubagentContextState, start: number | null, reduced: boolean): void {
  if (!state.begun) {
    state.begun = true;
    state.tail = (start ?? 0) > 0;
    state.headUnread = state.tail;
  }
  state.lineReduced = reduced;
  state.line = start;
}

// The read resumed after bytes it never parsed. Those bytes can hold results, launches and
// compactions, so the figure starts again as a read that begins after the start of the record.
export function skipSubagentContext(state: SubagentContextState): void {
  state.seen = false;
  state.tokens = 0;
  state.agents = [];
  state.pending = [];
  state.begun = true;
  state.tail = true;
  state.headUnread = true;
  state.reduced = false;
  state.removed = false;
}

// Records a launch call that starts a subagent, so its later completion notice qualifies.
export function noteSubagentLaunch(state: SubagentContextState, id: string): void {
  if (!id || state.launches.includes(id)) {
    return;
  }
  state.launches.push(id);
  if (state.launches.length > LAUNCH_LIMIT) {
    state.launches.shift();
    state.launchesDropped = true;
  }
}

export function knownSubagentLaunch(state: SubagentContextState, id: string): boolean {
  return state.launches.includes(id);
}

// A finished result whose launch the read never reached or no longer holds. A read that started
// after the start of the record, or that dropped a launch, cannot tell it from other background
// work, so the figure becomes partial. A dropped launch also shows the figure when no other result
// counted, because the result the read cannot count is likely subagent text.
export function noteUnqualifiedSubagentResult(state: SubagentContextState): void {
  if (state.tail || state.launchesDropped) {
    state.reduced = true;
  }
  if (state.launchesDropped) {
    state.seen = true;
  }
}

function fingerprint(kind: string, text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `${kind}:${text.length}:${hash >>> 0}`;
}

// Adds one returned text, `tokens` as the caller's provider estimates it. A null key counts the
// text in the total and in no subagent line. `identity` names the delivery: the same record read
// twice counts once, and two deliveries with the same text count twice. `match` is what the
// delivery carries in every record form. The result waits until `commitSubagentContext` marks
// the request that consumed it.
export function addSubagentResult(
  state: SubagentContextState,
  key: string | null,
  name: string | null,
  tokens: number,
  kind: string,
  identity: string,
  match: string,
): void {
  const carried = fingerprint('match', match);
  if (key !== null) {
    // One delivery written in two record forms arrives in both before any request reads it.
    if (state.pending.some((item) => item.key === key && item.match === carried && item.form !== kind)) {
      return;
    }
    let entry = state.agents.find(([id]) => id === key)?.[1];
    const mark = fingerprint(kind, identity);
    if (entry?.counted.includes(mark)) {
      return;
    }
    if (!entry) {
      entry = { name: name ?? 'Subagent', tokens: 0, counted: [] };
      state.agents.push([key, entry]);
    } else if (name && entry.name === 'Subagent') {
      entry.name = name;
    }
    entry.counted.push(mark);
    if (entry.counted.length > COUNTED_LIMIT) {
      entry.counted.shift();
    }
  }
  state.pending.push({ key, tokens, reduced: state.lineReduced, form: kind, match: carried, at: state.line });
  // No request read the oldest waiting result, so it leaves the count and the figure is partial.
  if (state.pending.length > PENDING_LIMIT) {
    state.pending.shift();
    state.reduced = true;
  }
}

// A request read the pending results, so each one now counts in context. With `before`, the
// request read only the results recorded before that source offset.
export function commitSubagentContext(state: SubagentContextState, before?: number): void {
  const read =
    before === undefined ? state.pending : state.pending.filter((item) => item.at === null || item.at < before);
  if (read.length === 0) {
    return;
  }
  state.pending = read.length === state.pending.length ? [] : state.pending.filter((item) => !read.includes(item));
  for (const item of read) {
    const entry = item.key === null ? undefined : state.agents.find(([id]) => id === item.key)?.[1];
    if (entry) {
      entry.tokens += item.tokens;
    }
    state.tokens += item.tokens;
    state.seen = true;
    state.removed = false;
    if (item.reduced) {
      state.reduced = true;
    }
  }
}

// Gives a subagent line its name once the record names the subagent.
export function nameSubagentResult(state: SubagentContextState, key: string, name: string): void {
  const entry = state.agents.find(([id]) => id === key)?.[1];
  if (entry && name) {
    entry.name = name;
  }
}

// A compaction that summarizes earlier messages removes every result before it. Its request
// read the pending results, so they were in context until it. The read reaches everything after
// it, so an unread head no longer makes the figure partial.
export function clearSubagentContext(state: SubagentContextState): void {
  commitSubagentContext(state);
  state.removed = state.removed || state.tokens > 0;
  state.tokens = 0;
  state.agents = [];
  state.pending = [];
  state.headUnread = false;
  state.reduced = false;
}

export function subagentContextFigure(state: SubagentContextState): SubagentContextFigure | null {
  if (!state.seen) {
    return null;
  }
  return {
    tokens: state.tokens,
    partial: state.headUnread || state.reduced,
    removed: state.removed && state.tokens === 0,
    agents: state.agents
      .filter(([, entry]) => entry.tokens > 0)
      .map(([, entry]) => ({ name: entry.name, tokens: entry.tokens }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}
