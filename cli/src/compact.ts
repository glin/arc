import { requestWindow } from '../../extension/src/sessionrequests.ts';
import { validCompactPayload } from '../../extension/src/compactrequest.ts';
import { readContinuationFile } from './manage.ts';

// Readiness spreads its reads across this window, so a tool start that reaches the host late can still be admitted.
const READINESS = { attempts: 4, intervalMs: 500, deadlineMs: 2_000 } as const;

export async function runCompact(args: string[]): Promise<string> {
  const command = args[0];
  if (command !== 'request' && command !== 'status') throw new Error('Use compact request or compact status.');
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (
      arg === '--request-id' ||
      arg === '--window' ||
      (command === 'request' && ['--continuation-file', '--continuation-sha256'].includes(arg))
    ) {
      const value = args[++index];
      if (!value || value.startsWith('-') || values.has(arg)) throw new Error(`Invalid or repeated argument: ${arg}`);
      values.set(arg, value);
    } else if (
      ['--json', ...(command === 'request' ? ['--self', '--after-turn'] : [])].includes(arg) &&
      !flags.has(arg)
    )
      flags.add(arg);
    else throw new Error(`Unknown or repeated argument: ${arg}`);
  }
  const payload = {
    requestId: values.get('--request-id') ?? '',
    window: values.get('--window') ?? '',
    self: true as const,
    afterTurn: true as const,
    ...(values.has('--continuation-file') || values.has('--continuation-sha256')
      ? {
          continuation: readContinuationFile(
            values.get('--continuation-file') ?? '',
            values.get('--continuation-sha256') ?? '',
          ),
        }
      : {}),
  };
  if (
    !(command === 'status'
      ? /^[a-f0-9]{24}$/.test(payload.window) &&
        /^[a-f0-9]{24}:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(payload.requestId)
      : validCompactPayload(payload)) ||
    !flags.has('--json') ||
    (command === 'request' && (!flags.has('--self') || !flags.has('--after-turn')))
  )
    throw new Error(
      'Supply --request-id WINDOW:UUID, --window WINDOW and --json. Request also requires --self --after-turn.',
    );
  // Local outcomes use the window's `state` field, so an agent reads one field for every outcome.
  const result = (state: string, reason: string) =>
    JSON.stringify({ version: 1, state, requestId: payload.requestId, window: payload.window, reason });
  if (command === 'status') {
    try {
      return JSON.stringify(await requestWindow('compact-status', { requestId: payload.requestId }, payload.window));
    } catch (error) {
      return result('unavailable', error instanceof Error ? error.message : 'The Arc window is unavailable.');
    }
  }
  try {
    let ready = false;
    let reason = 'Arc has not seen this command run in the session yet. No compaction was queued.';
    const deadline = Date.now() + READINESS.deadlineMs;
    for (let attempt = 0; attempt < READINESS.attempts && Date.now() < deadline; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, READINESS.intervalMs));
      if (Date.now() >= deadline) break;
      const observation = (await requestWindow('compact-ready', payload, payload.window)) as {
        ready?: boolean;
        code?: string;
        reason?: string;
      };
      if (observation.ready === true) {
        ready = true;
        break;
      }
      if (typeof observation.reason === 'string' && observation.reason) reason = observation.reason;
      // Only a command the window has not seen yet can still become ready.
      if (observation.code !== undefined && observation.code !== 'not-observed') break;
    }
    if (!ready) return result('refused', reason);
  } catch (error) {
    return result('refused', error instanceof Error ? error.message : 'The Arc window is unavailable.');
  }
  try {
    return JSON.stringify(
      await requestWindow('compact-request', payload, payload.window, undefined, payload.requestId),
    );
  } catch {
    return result(
      'uncertain',
      'Admission is uncertain. Observe this request without retrying or switching transports.',
    );
  }
}
