import { requestWindow } from '../../extension/src/sessionrequests.ts';
import {
  COMPACT_CANCEL_REFUSALS,
  COMPACT_REJECTIONS,
  validCompactCancel,
  validCompactPayload,
} from '../../extension/src/compactrequest.ts';
import { readContinuationFile } from './manage.ts';

// Readiness spreads its reads across this window, so a tool start that reaches a busy host late can still be admitted.
const READINESS = { attempts: 30, intervalMs: 1000, deadlineMs: 30_000 } as const;

// Repeats a window read until `done` accepts an answer or the readiness window ends. Returns the last
// answer, or null when no read started before the deadline.
async function untilObserved<T>(read: () => Promise<T>, done: (answer: T) => boolean): Promise<T | null> {
  let last: T | null = null;
  const deadline = Date.now() + READINESS.deadlineMs;
  for (let attempt = 0; attempt < READINESS.attempts && Date.now() < deadline; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, READINESS.intervalMs));
    if (Date.now() >= deadline) break;
    last = await read();
    if (done(last)) break;
  }
  return last;
}

export async function runCompact(args: string[]): Promise<string> {
  const command = args[0];
  if (command !== 'request' && command !== 'status' && command !== 'cancel')
    throw new Error('Use compact request, compact status or compact cancel.');
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const allowed = [
    '--json',
    ...(command === 'request' ? ['--self', '--after-turn'] : command === 'cancel' ? ['--self'] : []),
  ];
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
    } else if (allowed.includes(arg) && !flags.has(arg)) flags.add(arg);
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
  const cancel = { requestId: payload.requestId, window: payload.window, self: true as const };
  if (
    !(command === 'status'
      ? /^[a-f0-9]{24}$/.test(payload.window) &&
        /^[a-f0-9]{24}:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(payload.requestId)
      : command === 'cancel'
        ? validCompactCancel(cancel)
        : validCompactPayload(payload)) ||
    allowed.some((flag) => !flags.has(flag))
  )
    throw new Error(
      'Supply --request-id WINDOW:UUID, --window WINDOW and --json. Request also requires --self --after-turn. Cancel also requires --self.',
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
  if (command === 'cancel') {
    try {
      const answer = await untilObserved(
        async () => (await requestWindow('compact-cancel', cancel, payload.window)) as { code?: string },
        // Only a command the window has not seen yet can still change.
        (answer) => answer.code !== 'not-observed',
      );
      return answer ? JSON.stringify(answer) : result('refused', COMPACT_CANCEL_REFUSALS['not-observed']);
    } catch (error) {
      return result('unavailable', error instanceof Error ? error.message : 'The Arc window is unavailable.');
    }
  }
  // Arc writes a launch token into each agent process it starts. The token names the session, so the window
  // admits the request without first seeing the command run.
  const token = process.env.ARC_SESSION_NONCE;
  const request = token && /^[a-f0-9]{32}$/.test(token) ? { ...payload, token } : payload;
  if (!('token' in request)) {
    let reason = COMPACT_REJECTIONS['not-observed'];
    try {
      const observation = await untilObserved(
        async () => {
          const answer = (await requestWindow('compact-ready', payload, payload.window)) as {
            ready?: boolean;
            code?: string;
            reason?: string;
          };
          if (typeof answer.reason === 'string' && answer.reason) reason = answer.reason;
          return answer;
        },
        // Only a command the window has not seen yet can still become ready.
        (answer) => answer.ready === true || (answer.code !== undefined && answer.code !== 'not-observed'),
      );
      if (observation?.ready !== true) return result('refused', reason);
    } catch (error) {
      return result('refused', error instanceof Error ? error.message : 'The Arc window is unavailable.');
    }
  }
  try {
    return JSON.stringify(
      await requestWindow('compact-request', request, payload.window, undefined, payload.requestId),
    );
  } catch {
    return result(
      'uncertain',
      'Admission is uncertain. Observe this request without retrying or switching transports.',
    );
  }
}
