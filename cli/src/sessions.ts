import { requestWindow, SESSION_CURSOR } from '../../extension/src/sessionrequests.ts';

export async function runSessions(command: 'sessions' | 'session', args: string[]): Promise<string> {
  let window: string | undefined;
  let sessionId: string | undefined;
  let turns = 5;
  let turnsSeen = false;
  let jsonSeen = false;
  let cursor: string | undefined;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--window' && window === undefined) {
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
    } else if (!arg.startsWith('-') && command === 'session' && sessionId === undefined) {
      sessionId = arg;
    } else throw new Error(`Unknown or repeated argument: ${arg}`);
  }
  if (command === 'session' && !sessionId)
    throw new Error('Usage: arc session ID [--turns 1-20] [--window ID] [--json]');
  const params = command === 'session' ? { sessionId, turns } : { ...(cursor && { cursor }), ...(limit && { limit }) };
  return JSON.stringify(await requestWindow(command, params, window));
}
