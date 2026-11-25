import { hunksFromUnifiedDiff } from './codex';
import {
  readForwardSession,
  readForwardSessionAsync,
  readSemanticHistoryPageAsync,
  type BufferedHistoryRecord,
  type ForwardParserCheckpoint,
  type ForwardReadOptions,
  type ForwardSessionReducer,
  type SemanticHistoryOptions,
  type SourceHistoryCursor,
} from './history';
import {
  patchMarkersAreValid,
  setTurnStepStatus,
  tallyToolName,
  TURN_STEP_LIMIT,
  type AgyRecordedUsage,
  type EditRecord,
  type PatchHunk,
  type SessionRead,
  type Turn,
  type TurnStep,
  type ToolCounts,
  type UsageEvent,
} from './transcript';

export const AGY_COST_UNAVAILABLE = 'Cost unavailable';
export const AGY_USAGE_INCOMPLETE = 'Antigravity did not report enough usage to estimate this cost.';
export const AGY_PRICE_UNAVAILABLE = 'Arc has no verified price for this Antigravity usage.';

export function agyTokenLines(usage: AgyRecordedUsage | undefined): string[] {
  const lines = [
    ['Input tokens', usage?.input],
    ['Cached input tokens', usage?.cacheRead],
    ['Output tokens', usage?.output],
  ].flatMap(([name, count]) => (count === undefined ? [] : [String(name) + ' ' + count]));
  return lines.length ? lines : ['Token usage unavailable'];
}

interface AgyCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AgyStep {
  index: number;
  type: string;
  status: string;
  at: number;
  content: string;
  thinking: string;
  error: string;
  model: string | null;
  input?: number;
  cacheRead?: number;
  output?: number;
  calls: AgyCall[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function agyHasEncodedArgs(file: string): boolean {
  return /(?:^|[\\/])transcript\.jsonl$/.test(file);
}

export function parseAgyStep(line: string, encodedArgs = false): AgyStep | null {
  try {
    const row = object(JSON.parse(line));
    if (!row) return null;
    const index = count(row.step_index);
    const at = Date.parse(string(row.created_at));
    if (index === undefined || !Number.isFinite(at) || !string(row.type)) return null;
    const calls: AgyCall[] = [];
    for (const candidate of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      const call = object(candidate);
      const name = string(call?.name);
      if (!name) continue;
      let args = object(call?.args);
      if (!args && typeof call?.args === 'string') {
        try {
          args = object(JSON.parse(call.args));
        } catch {
          // The tool remains visible when the arguments are incomplete.
        }
      }
      if (encodedArgs && args) {
        args = Object.fromEntries(
          Object.entries(args).map(([key, value]) => {
            if (typeof value !== 'string') return [key, value];
            try {
              return [key, JSON.parse(value) as unknown];
            } catch {
              return [key, value];
            }
          }),
        );
      }
      calls.push({ name, args: args ?? {} });
    }
    return {
      index,
      at,
      calls,
      type: string(row.type),
      status: string(row.status),
      content: string(row.content),
      thinking: string(row.thinking),
      error: string(row.error),
      model: string(row.model) || null,
      input: count(row.input_tokens),
      cacheRead: count(row.cache_read_tokens),
      output: count(row.output_tokens),
    };
  } catch {
    return null;
  }
}

export function agyRetainedLine(line: string): string | null {
  const step = parseAgyStep(line);
  if (!step) return null;
  return step.type === 'SYSTEM_MESSAGE'
    ? JSON.stringify({ type: step.type, step_index: step.index, created_at: new Date(step.at).toISOString() })
    : line;
}

export function agyUsageDetail(counts: AgyRecordedUsage | undefined): string {
  return counts &&
    !counts.incomplete &&
    counts.input !== undefined &&
    counts.cacheRead !== undefined &&
    counts.output !== undefined
    ? AGY_PRICE_UNAVAILABLE
    : AGY_USAGE_INCOMPLETE;
}

export function validAgyRecordedUsage(value: unknown): value is AgyRecordedUsage {
  const usage = object(value);
  return (
    usage !== null &&
    [usage.input, usage.cacheRead, usage.output].every((value) => value === undefined || count(value) !== undefined) &&
    (usage.incomplete === undefined || usage.incomplete === true)
  );
}

export function agyUsageFromTotals(
  { input, cacheRead, output }: Pick<Turn['usage'], 'input' | 'cacheRead' | 'output'>,
  complete: boolean,
): AgyRecordedUsage {
  return {
    ...(complete || input > 0 ? { input } : {}),
    ...(complete || cacheRead > 0 ? { cacheRead } : {}),
    ...(complete || output > 0 ? { output } : {}),
    ...(complete ? {} : { incomplete: true as const }),
  };
}

export function mergeAgyUsage(target: AgyRecordedUsage, row: AgyRecordedUsage | undefined): AgyRecordedUsage {
  for (const key of ['input', 'cacheRead', 'output'] as const) {
    const value = row?.[key];
    if (value === undefined) target.incomplete = true;
    else target[key] = (target[key] ?? 0) + value;
  }
  if (row?.incomplete) target.incomplete = true;
  return target;
}

export function agyUsageEvent(row: AgyStep): UsageEvent & { agyUsage: AgyRecordedUsage; toolCalls: number } {
  return {
    agent: 'agy',
    provider: 'agy',
    agyUsage: mergeAgyUsage({}, row),
    toolCalls: row.calls.length,
    model: row.model,
    contextWindow: null,
    contextBand: null,
    timestamp: row.at,
    billingClass: 'unknown',
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    incomplete: true,
    requestKey: 'agy:' + row.index,
    usage: {
      requests: 1,
      input: row.input ?? 0,
      cacheRead: row.cacheRead ?? 0,
      output: row.output ?? 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      thinking: 0,
    },
    ...(row.input === undefined || row.cacheRead === undefined || row.output === undefined
      ? { requestCountExact: false as const }
      : {}),
  };
}

export function createAgyUsageReducer(state: unknown) {
  let last = typeof state === 'number' ? state : -1;
  return {
    parserKind: 'agy' as const,
    snapshot: () => last,
    pushLine(line: string): ReturnType<typeof agyUsageEvent>[] {
      const row = parseAgyStep(line);
      if (!row || row.index <= last || row.type !== 'PLANNER_RESPONSE') return [];
      last = row.index;
      return [agyUsageEvent(row)];
    },
  };
}

export function agyPrompt(content: string): string {
  return (
    /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)?.[1] ??
    content.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g, '')
  ).trim();
}

const EDITS = new Set([
  'edit_file',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file',
]);

export function agyToolKind(name: string): keyof ToolCounts {
  if (EDITS.has(name)) return 'edits';
  if (name === 'run_command') return 'commands';
  if (name === 'read_file' || name === 'view_file') return 'reads';
  return 'other';
}

function newTurn(sessionId: string, row: AgyStep): Turn {
  const settings = /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/.exec(row.content)?.[1];
  return {
    agent: 'agy',
    provider: 'agy',
    sessionId,
    sessionTitle: null,
    promptId: `agy:${row.index}`,
    startedAt: row.at,
    endedAt: row.at,
    prompt: agyPrompt(row.content),
    summary: '',
    answers: [],
    model: /Model Selection` from .+? to (.+?)\. No need to comment/.exec(settings ?? '')?.[1] ?? null,
    effort: null,
    files: [],
    agents: [],
    commits: [],
    usage: { input: 0, cacheRead: 0, output: 0, thinking: 0, cacheWrite1h: 0, cacheWrite5m: 0 },
    contextTokens: 0,
    contextWindow: null,
    toolCounts: { edits: 0, reads: 0, searches: 0, commands: 0, agents: 0, coordination: 0, web: 0, other: 0 },
    toolUses: 0,
    toolTally: {},
    laterPrompts: [],
    steps: [],
    updates: [],
    stepCount: 0,
    stepKinds: [],
    failedOrdinals: [],
    skillUses: [],
    skillUseCount: 0,
    failures: [],
    interrupted: false,
    finished: false,
    error: null,
  };
}

function recordedEdit(call: AgyCall, result: string): EditRecord | null {
  const args = call.args;
  const diff = /\[diff_block_start\](?:\r?\n)?([\s\S]*?)(?:\r?\n)?\[diff_block_end\]/.exec(result)?.[1];
  if (diff) {
    const hunks = hunksFromUnifiedDiff(diff.replace(/\r\n/g, '\n'));
    if (hunks.length && patchMarkersAreValid(hunks))
      return { hunks, originalFile: null, content: null, isCreate: false };
  }
  const created = /(?:^|\n)Created file\.(?:\r?\n|$)/.test(result);
  if (call.name === 'write_file' || call.name === 'write_to_file') {
    const content = args.Content ?? args.FileContent;
    return typeof content === 'string'
      ? { hunks: [], originalFile: created ? '' : null, content, isCreate: created }
      : null;
  }
  const before = args.Target ?? args.TargetContent;
  const after = args.Replacement ?? args.ReplacementContent;
  const location = /^Made 1 replacement in .+ starting at line (\d+) \(\+\d+\/-\d+ lines\)\./m.exec(result);
  if (!location || typeof before !== 'string' || typeof after !== 'string') return null;
  const textLines = (text: string) => (text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []);
  const old = textLines(before);
  const next = textLines(after);
  const start = Number(location[1]);
  const hunk: PatchHunk = {
    oldStart: start,
    newStart: start,
    oldLines: old.length,
    newLines: next.length,
    lines: [...old.map((line) => '-' + line), ...next.map((line) => '+' + line)],
  };
  return { hunks: [hunk], originalFile: null, content: null, isCreate: false };
}

function addFile(turn: Turn, call: AgyCall, output: string): void {
  const file = string(call.args.Path ?? call.args.TargetFile);
  if (!file || !EDITS.has(call.name)) return;
  const edit = recordedEdit(call, output);
  if (!edit) return;
  let change = turn.files.find((candidate) => candidate.path === file);
  if (!change) {
    change = { path: file, added: 0, removed: 0, isNew: edit.isCreate, edits: [] };
    turn.files.push(change);
  }
  change.edits.push(edit);
  if (edit.isCreate && edit.content) change.added += edit.content.replace(/\r?\n$/, '').split('\n').length;
  for (const hunk of edit.hunks) {
    change.added += hunk.lines.filter((line) => line.startsWith('+')).length;
    change.removed += hunk.lines.filter((line) => line.startsWith('-')).length;
  }
  if (!edit.isCreate && !edit.hunks.length) {
    change.countsUnknown = true;
    change.unknownReason = 'write';
  }
}

interface Building {
  turn: Turn;
  pending: Array<{ call: AgyCall; step: TurnStep }>;
  index: number;
  start: number;
  end: number;
}

interface AgyState {
  active: Building | null;
  closed: Building[];
  trimmed: boolean;
}

export type AgyCheckpoint = ForwardParserCheckpoint<AgyState>;
export type AgyHistoryCursor = SourceHistoryCursor<null>;

function update(turn: Turn, row: AgyStep, text: string, kind: 'reasoning' | 'commentary', offset: number): void {
  if (!text) return;
  turn.updates.push({
    sourceId: `agy:${row.index}:${kind}`,
    sourceOrder: offset,
    stepsBefore: turn.toolUses,
    text,
    kind,
    at: row.at,
    status: row.error || row.status === 'ERROR' ? 'failed' : 'done',
  });
}

function interruptCalls(active: Building): void {
  for (const { step } of active.pending) setTurnStepStatus(active.turn, step, 'interrupted');
  if (active.pending.length) {
    active.turn.interrupted = true;
    active.turn.finished = false;
  }
  active.pending = [];
}

function apply(active: Building, row: AgyStep, offset: number, end: number): void {
  const { turn } = active;
  if (row.index <= active.index) return;
  if (row.index !== active.index + 1) (turn.agyUsage ??= {}).incomplete = true;
  active.index = row.index;
  active.end = end;
  turn.endedAt = Math.max(turn.endedAt, row.at);
  if (row.type === 'PLANNER_RESPONSE') {
    interruptCalls(active);
    turn.model = row.model ?? turn.model;
    const usage = turn.usage;
    mergeAgyUsage((turn.agyUsage ??= {}), row);
    const hasUsage = row.input !== undefined || row.cacheRead !== undefined || row.output !== undefined;
    if (hasUsage) {
      usage.requests = (usage.requests ?? 0) + 1;
      usage.input += row.input ?? 0;
      usage.cacheRead += row.cacheRead ?? 0;
      usage.output += row.output ?? 0;
    }
    update(turn, row, row.thinking, 'reasoning', offset);
    for (const [index, call] of row.calls.entries()) {
      const detail = string(call.args.CommandLine ?? call.args.Path ?? call.args.TargetFile ?? call.args.Cwd);
      const step: TurnStep = {
        ordinal: ++turn.stepCount,
        name: call.name,
        sourceId: `agy:${row.index}:${index}`,
        detail: detail.replace(/\s+/g, ' ').slice(0, 200),
        at: row.at,
        status: 'running',
      };
      if (detail !== step.detail) step.fullDetail = detail;
      turn.steps.push(step);
      turn.toolUses++;
      tallyToolName(turn.toolTally, call.name);
      const kind = agyToolKind(call.name);
      turn.toolCounts[kind]++;
      turn.stepKinds.push(kind);
      active.pending.push({ call, step });
    }
    turn.steps = turn.steps.slice(-TURN_STEP_LIMIT);
    if (row.calls.length) {
      update(turn, row, row.content, 'commentary', offset);
      turn.finished = false;
    } else if (row.status === 'DONE' && row.content) {
      turn.summary = row.content;
      turn.answers.push({ text: row.content, at: row.at, stepsBefore: turn.toolUses, sourceOrder: offset });
      turn.finished = true;
      turn.interrupted = false;
    }
    if (row.error || row.status === 'ERROR') turn.error = row.error || row.content || 'Antigravity reported an error.';
    return;
  }
  if (row.type === 'SYSTEM_MESSAGE') return;
  if (row.type === 'GENERIC' && active.pending.length === 1 && ['DONE', 'ERROR'].includes(row.status)) {
    const { call, step } = active.pending[0];
    setTurnStepStatus(turn, step, row.status === 'ERROR' || row.error ? 'failed' : 'done');
    if (step.status === 'done') addFile(turn, call, row.content);
    active.pending = [];
  }
  const output = row.error || row.content.replace(/^(?:(?:Created|Completed) At: [^\r\n]*\r?\n)+/, '');
  update(turn, row, output || row.type, 'commentary', offset);
}

function start(state: AgyState, sessionId: string, row: AgyStep, offset: number, end: number, maxTurns: number): void {
  if (state.active) {
    if (row.index <= state.active.index) return;
    interruptCalls(state.active);
    state.closed.push(state.active);
    if (state.closed.length >= maxTurns) {
      state.closed.shift();
      state.trimmed = true;
    }
  }
  state.active = { turn: newTurn(sessionId, row), pending: [], index: row.index, start: offset, end };
}

function push(state: AgyState, sessionId: string, row: AgyStep, offset: number, end: number, maxTurns: number): void {
  if (row.type === 'USER_INPUT') start(state, sessionId, row, offset, end, maxTurns);
  else if (state.active) apply(state.active, row, offset, end);
}

export function createAgySessionReducer(
  file: string,
  sessionId: string,
  maxTurns: number,
  restored?: AgyState,
): ForwardSessionReducer<AgyState> {
  const state: AgyState = restored ?? { active: null, closed: [], trimmed: false };
  const encodedArgs = agyHasEncodedArgs(file);
  const read = (readBytes = 0): SessionRead => {
    const active = state.active ? structuredClone(state.active) : null;
    if (active) interruptCalls(active);
    return {
      turns: [...state.closed, ...(active ? [active] : [])].map(({ turn }) => turn),
      compactions: [],
      readBytes,
      turnLimitReached: state.trimmed,
    };
  };
  return {
    pushLine(line) {
      const source = typeof line === 'string' ? { text: line } : line;
      const row = parseAgyStep(source.text, encodedArgs);
      if (row) push(state, sessionId, row, source.start ?? 0, source.end ?? 0, maxTurns);
    },
    snapshot: () => state,
    read,
    finish: read,
  };
}

export function readAgySession(
  file: string,
  sessionId: string,
  options: { tailBytes?: number; maxTurns?: number } = {},
) {
  const turns = options.maxTurns ?? 20;
  return readForwardSession(
    file,
    'agy',
    sessionId,
    () => createAgySessionReducer(file, sessionId, turns),
    undefined,
    undefined,
    '',
    options.tailBytes,
  );
}

export function readAgySessionAsync(
  file: string,
  sessionId: string,
  maxTurns: number,
  tailBytes: number,
  checkpoint: AgyCheckpoint | undefined,
  work: ForwardReadOptions,
) {
  return readForwardSessionAsync(
    file,
    'agy',
    sessionId,
    (state) => createAgySessionReducer(file, sessionId, maxTurns, state),
    checkpoint,
    undefined,
    String(maxTurns),
    tailBytes,
    work,
  );
}

export function readAgyHistoryPage(
  file: string,
  sessionId: string,
  cursor: AgyHistoryCursor | null,
  options: SemanticHistoryOptions = {},
) {
  return readSemanticHistoryPageAsync(
    file,
    sessionId,
    {
      source: 'agy',
      initialState: (): null => null,
      accepts: () => true,
      parse(records: readonly BufferedHistoryRecord[]) {
        const encodedArgs = agyHasEncodedArgs(file);
        const state: AgyState = { active: null, closed: [], trimmed: false };
        for (const record of records) {
          const row = parseAgyStep(record.text, encodedArgs);
          if (row) push(state, sessionId, row, record.start, record.end, Infinity);
        }
        if (state.active) {
          interruptCalls(state.active);
          state.closed.push(state.active);
        }
        return { turns: state.closed, compactions: [], openRange: null, adapterState: null };
      },
    },
    cursor,
    options,
  );
}
