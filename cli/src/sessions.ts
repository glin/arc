import { RAIL_FILTER_QUERY_LIMIT } from '../../extension/src/domain/rail-filters.ts';
import { listingQueryError, sessionQueryError } from '../../extension/src/domain/session-query.ts';
import { requestWindow, SESSION_CURSOR } from '../../extension/src/sessionrequests.ts';

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
  return JSON.stringify(await requestWindow(command, params, window));
}
