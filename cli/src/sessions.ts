import { RAIL_FILTER_QUERY_LIMIT } from '../../extension/src/domain/rail-filters.ts';
import { listingQueryError, sessionQueryError } from '../../extension/src/domain/session-query.ts';
import { requestWindow, SESSION_CURSOR } from '../../extension/src/sessionrequests.ts';
import type { SessionPage, SessionTurn } from '../../extension/src/sessionreads.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((one) => typeof one === 'string');
const oneOf = (value: unknown, choices: string[]) => typeof value === 'string' && choices.includes(value);
const metadata = (value: string) =>
  value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (char) => {
    const escaped = JSON.stringify(char).slice(1, -1);
    return escaped === char ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : escaped;
  });

function humanReplyError(): never {
  throw new Error(
    'This Arc reply cannot be displayed as text. Inspect it with --json and reload the matching Arc extension.',
  );
}

function renderSessions(reply: unknown): string {
  if (
    !object(reply) ||
    reply.version !== 1 ||
    !nullableText(reply.requester) ||
    !Array.isArray(reply.sessions) ||
    reply.sessions.length > 128 ||
    !texts(reply.notes) ||
    typeof reply.complete !== 'boolean' ||
    !nullableText(reply.next) ||
    (reply.next !== null && !SESSION_CURSOR.test(reply.next)) ||
    !oneOf(reply.coverage, ['complete', 'incomplete', 'unavailable']) ||
    !oneOf(reply.freshness, ['current', 'stale'])
  )
    humanReplyError();
  for (const row of reply.sessions) {
    if (
      !object(row) ||
      typeof row.source !== 'string' ||
      !nullableText(row.id) ||
      !nullableText(row.name) ||
      !nullableText(row.path) ||
      !object(row.setup) ||
      !nullableText(row.setup.model) ||
      !nullableText(row.setup.effort) ||
      !oneOf(row.setup.source, ['recorded', 'unavailable']) ||
      !(row.lastActivity === null || Number.isFinite(row.lastActivity)) ||
      !(
        row.parent === null ||
        (object(row.parent) &&
          nullableText(row.parent.id) &&
          oneOf(row.parent.relation, ['subagent', 'dispatched', 'reader']))
      ) ||
      !oneOf(row.provider, ['claude', 'codex']) ||
      typeof row.ambiguous !== 'boolean' ||
      !texts(row.truncated) ||
      typeof row.pinned !== 'boolean' ||
      typeof row.archived !== 'boolean' ||
      !(row.agentRun === null || typeof row.agentRun === 'boolean') ||
      !oneOf(row.facts, ['current', 'stale', 'unparsed']) ||
      !oneOf(row.runStatus, [
        'running',
        'waiting',
        'done',
        'failed',
        'interrupted',
        'stopped',
        'subagents',
        'background',
        'none',
        'unknown',
      ]) ||
      !oneOf(row.attention, ['input', 'unread', 'running', 'idle', 'unknown']) ||
      !(
        row.labels === null ||
        (Array.isArray(row.labels) &&
          row.labels.every((label) => object(label) && typeof label.name === 'string' && label.source === 'reader'))
      )
    )
      humanReplyError();
  }
  const page = reply as unknown as SessionPage;
  const lines = [`Sessions: coverage ${page.coverage}, freshness ${page.freshness}`];
  for (const row of page.sessions) {
    const facts: string[] = [];
    if (!row.id || row.ambiguous || row.truncated.includes('id')) facts.push(`source: ${row.source}`);
    if (row.labels === null) facts.push('labels unavailable');
    else if (row.labels.length) facts.push(`labels: ${row.labels.map((label) => label.name).join(', ')}`);
    if (row.pinned) facts.push('pinned');
    if (row.archived) facts.push('archived');
    if (row.agentRun === true) facts.push('agent run');
    if (row.agentRun === null) facts.push('classification unknown');
    if (row.ambiguous) facts.push('ambiguous ID');
    if (row.truncated.length) facts.push(`truncated: ${row.truncated.join(', ')}`);
    if (row.facts !== 'current') facts.push(`facts ${row.facts}`);
    lines.push(
      [
        row.truncated.includes('id') ? '(ID truncated)' : row.id || '(ID unavailable)',
        row.provider,
        row.name ?? '(name unavailable)',
        row.runStatus,
        row.attention,
        ...facts,
      ]
        .map(metadata)
        .join('  '),
    );
  }
  lines.push(...page.notes.map((note) => `Note: ${metadata(note)}`));
  if (page.next !== null)
    lines.push(`Next cursor: ${metadata(page.next)}`, 'Repeat the same window, query, and limit with --cursor.');
  else
    lines.push(
      `Traversal ended. Discovery ${page.coverage === 'complete' ? 'is complete' : `remains ${page.coverage}`}.`,
    );
  return lines.join('\n');
}

function renderSession(reply: unknown): string {
  if (
    !object(reply) ||
    reply.version !== 1 ||
    !nullableText(reply.requester) ||
    typeof reply.id !== 'string' ||
    !oneOf(reply.provider, ['claude', 'codex']) ||
    !oneOf(reply.state, ['current', 'stale', 'unparsed']) ||
    typeof reply.partial !== 'boolean' ||
    typeof reply.readByteLimit !== 'number' ||
    !texts(reply.notes) ||
    !Array.isArray(reply.turns) ||
    reply.turns.length > 20 ||
    (reply.observation !== undefined && typeof reply.observation !== 'string') ||
    (reply.readObservation !== undefined && typeof reply.readObservation !== 'string')
  )
    humanReplyError();
  for (const turn of reply.turns) {
    if (
      !object(turn) ||
      !nullableText(turn.promptId) ||
      typeof turn.prompt !== 'string' ||
      typeof turn.summary !== 'string' ||
      !nullableText(turn.model) ||
      !nullableText(turn.effort) ||
      !nullableText(turn.error) ||
      typeof turn.finished !== 'boolean' ||
      typeof turn.interrupted !== 'boolean' ||
      !Number.isFinite(turn.startedAt) ||
      !Number.isFinite(turn.endedAt)
    )
      humanReplyError();
  }
  const lines = [
    `Session ${metadata(reply.id)}  ${reply.provider}`,
    `State: ${reply.state}. History: ${reply.state !== 'current' ? 'unavailable' : reply.partial ? 'partial' : 'complete'}.`,
  ];
  if (!reply.turns.length)
    lines.push(
      reply.state === 'current'
        ? 'No turns returned.'
        : `History is ${reply.state}. No turns are available in this reply.`,
    );
  for (const turn of reply.turns as SessionTurn[]) {
    const outcome = turn.error ? 'error' : turn.interrupted ? 'interrupted' : turn.finished ? 'finished' : 'unfinished';
    lines.push(
      '',
      [
        `Turn ${turn.promptId ?? '(ID unavailable)'}`,
        outcome,
        turn.model ?? '(model unavailable)',
        turn.effort ?? '(effort unavailable)',
      ]
        .map(metadata)
        .join('  '),
    );
    for (const [label, time] of [
      ['Started', turn.startedAt],
      ['Ended', turn.endedAt],
    ] as const)
      if (time > 0 && Math.abs(time) <= 8640000000000000) lines.push(`${label}: ${new Date(time).toISOString()}`);
    if (turn.error) lines.push(`Error: ${metadata(turn.error)}`);
    lines.push('Prompt:', turn.prompt, '', 'Response:', turn.summary);
  }
  lines.push(...reply.notes.map((note) => `Note: ${metadata(note)}`));
  if (reply.observation || reply.readObservation)
    lines.push('Use --json for available follow-up or read acknowledgment receipts.');
  return lines.join('\n');
}

export async function runSessions(command: 'sessions' | 'session' | 'filter', args: string[]): Promise<string> {
  let window: string | undefined;
  let sessionId: string | undefined;
  let turns = 5;
  let turnsSeen = false;
  let jsonSeen = false;
  let cursor: string | undefined;
  let limit: number | undefined;
  let query: string | undefined;
  let clear = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--clear' && command === 'filter' && !clear) {
      clear = true;
    } else if (arg === '--query' && (command === 'sessions' || command === 'filter') && query === undefined) {
      query = args[++index];
      if (!query || query.startsWith('--')) throw new Error('--query requires a filter query.');
    } else if (arg === '--window' && window === undefined) {
      window = args[++index];
      if (!window || window.startsWith('--')) throw new Error('--window requires a window identifier.');
    } else if (arg === '--turns' && command === 'session' && !turnsSeen) {
      const raw = args[++index];
      if (!raw || !/^[0-9]+$/.test(raw)) throw new Error('Turns must be between 1 and 20.');
      turns = Number(raw);
      turnsSeen = true;
      if (!Number.isSafeInteger(turns) || turns < 1 || turns > 20) throw new Error('Turns must be between 1 and 20.');
    } else if (arg === '--limit' && command === 'sessions' && limit === undefined) {
      const raw = args[++index];
      limit = raw && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('Limit must be between 1 and 128.');
    } else if (arg === '--cursor' && command === 'sessions' && cursor === undefined) {
      cursor = args[++index];
      // The host validates the cursor. The CLI checks only its length and alphabet.
      if (!cursor || !SESSION_CURSOR.test(cursor))
        throw new Error('The session cursor is invalid or expired. Restart the listing without --cursor.');
    } else if (arg === '--json' && !jsonSeen) {
      jsonSeen = true;
    } else if (!arg.startsWith('--') && command === 'filter' && query === undefined) {
      query = arg;
    } else if (!arg.startsWith('-') && command === 'session' && sessionId === undefined) {
      sessionId = arg;
    } else throw new Error(`Unknown or repeated argument: ${arg}`);
  }
  if (command === 'session' && !sessionId)
    throw new Error('Usage: arc session ID [--turns 1-20] [--window ID] [--json]');
  if (command === 'filter') {
    if ((clear && query !== undefined) || (!clear && !query?.trim()))
      throw new Error('Usage: arc filter QUERY | arc filter --query QUERY | arc filter --clear [--window ID] [--json]');
    if (clear) query = '';
  }
  if (query !== undefined) {
    if (query.length > RAIL_FILTER_QUERY_LIMIT)
      throw new Error(`Filter queries accept at most ${RAIL_FILTER_QUERY_LIMIT} characters.`);
    const error = command === 'sessions' ? listingQueryError(query) : sessionQueryError(query);
    if (error) throw new Error(error);
  }
  const params =
    command === 'filter'
      ? { query }
      : command === 'session'
        ? { sessionId, turns }
        : { ...(cursor && { cursor }), ...(limit && { limit }), ...(query !== undefined && { query }) };
  const reply = await requestWindow(command, params, window);
  if (jsonSeen || command === 'filter') return JSON.stringify(reply);
  return command === 'sessions' ? renderSessions(reply) : renderSession(reply);
}
