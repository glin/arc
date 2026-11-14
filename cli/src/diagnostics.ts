import { requestWindow } from '../../extension/src/sessionrequests.ts';

const USAGE = 'Usage: arc diagnostics performance --window ID [--json]';

interface PerformanceCapture {
  version: 1;
  file: string;
  bytes: number;
  capturedAt: number;
}

function capture(value: unknown): value is PerformanceCapture {
  if (value === null || typeof value !== 'object') return false;
  const reply = value as Record<string, unknown>;
  return (
    reply.version === 1 &&
    typeof reply.file === 'string' &&
    reply.file.length > 0 &&
    Number.isSafeInteger(reply.bytes) &&
    Number.isSafeInteger(reply.capturedAt)
  );
}

export async function runDiagnostics(action: string, args: string[]): Promise<string> {
  if (action !== 'performance') throw new Error(USAGE);
  let window: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--window' && window === undefined) {
      window = args[++index];
      if (!window || window.startsWith('-')) throw new Error(USAGE);
    } else throw new Error(USAGE);
  }
  if (!window) throw new Error(`--window is required. ${USAGE}`);
  const reply = await requestWindow('performance-capture', {}, window);
  if (!capture(reply)) throw new Error('The selected Arc window sent an unreadable capture reply.');
  const { version, file, bytes, capturedAt } = reply;
  if (json) return JSON.stringify({ version, file, bytes, capturedAt });
  return `Saved performance diagnostics to ${file} (${bytes} bytes).`;
}
