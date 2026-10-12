import * as fs from 'node:fs';
import { requestWindow, requesterIdentity } from '../../extension/src/sessionrequests.ts';
import {
  SESSION_OBSERVATION,
  READ_OBSERVATION,
  guardedPromptRefusal,
  payloadSha256,
  type SessionWriteParams,
} from '../../extension/src/sessionwrites.ts';

// Reads at most 48 KiB from a regular file and drops a leading byte-order mark. The decoded text is the payload.
export function readPromptFile(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('The prompt file must be a regular file.');
    const buffer = Buffer.alloc(48 * 1024 + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > 48 * 1024) throw new Error('The prompt file exceeds 48 KiB.');
    return buffer
      .subarray(0, count)
      .toString('utf8')
      .replace(/^\uFEFF/, '');
  } finally {
    fs.closeSync(fd);
  }
}

export async function runManagement(command: string, args: string[]): Promise<string> {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const sessions: string[] = [];
  const labels: string[] = [];
  const values = new Set([
    '--window',
    '--request-id',
    '--setup',
    '--provider',
    '--model',
    '--effort',
    '--permissions',
    '--prompt-file',
    '--name',
    '--label',
    '--observation',
  ]);
  const switches = new Set(['--json', '--pinned', '--arc-dispatch', '--dry-run', '--force']);
  let agentRun = false;
  let agentRunSeen = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === '--agent-run' || arg.startsWith('--agent-run=')) {
      if (agentRunSeen) throw new Error('Repeated argument: --agent-run');
      const value = arg === '--agent-run' ? 'true' : arg.slice('--agent-run='.length);
      if (value !== 'true' && value !== 'false') throw new Error('--agent-run accepts only true or false.');
      agentRun = value === 'true';
      agentRunSeen = true;
      flags.add('--agent-run');
    } else if (values.has(arg)) {
      const value = args[++at];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--label') labels.push(value);
      else if (options.has(arg)) throw new Error(`Repeated argument: ${arg}`);
      else options.set(arg, value);
    } else if (switches.has(arg) && !flags.has(arg)) flags.add(arg);
    else if (!arg.startsWith('-')) sessions.push(arg);
    else throw new Error(`Unknown or repeated argument: ${arg}`);
  }
  const allowed =
    command === 'setups'
      ? ['--window', '--json']
      : command === 'send'
        ? ['--window', '--request-id', '--prompt-file', '--observation', '--json']
        : command === 'read'
          ? ['--window', '--request-id', '--observation', '--dry-run', '--json']
        : command === 'start'
          ? [
              '--window',
              '--request-id',
              '--setup',
              '--provider',
              '--model',
              '--effort',
              '--permissions',
              '--prompt-file',
              '--name',
              '--label',
              '--json',
              '--agent-run',
              '--pinned',
              '--arc-dispatch',
            ]
          : [
              '--window',
              '--request-id',
              '--label',
              '--json',
              '--dry-run',
              ...(command === 'archive' ? ['--force'] : []),
            ];
||||||| parent of d1d8ba61 (feat(read): add observation-bound session acknowledgments)
        : command === 'start'
          ? [
              '--window',
              '--request-id',
              '--setup',
              '--provider',
              '--model',
              '--effort',
              '--permissions',
              '--prompt-file',
              '--name',
              '--label',
              '--json',
              '--agent-run',
              '--untagged',
              '--pinned',
              '--arc-dispatch',
            ]
          : [
              '--window',
              '--request-id',
              '--label',
              '--json',
              '--dry-run',
              ...(command === 'archive' ? ['--force'] : []),
            ];
  for (const arg of [...options.keys(), ...flags, ...(labels.length ? ['--label'] : [])]) {
    if (!allowed.includes(arg)) throw new Error(`${arg} is unavailable for ${command}.`);
  }
  const window = options.get('--window');
  const requestId = options.get('--request-id');
  if (command === 'setups') {
    if (sessions.length) throw new Error('Usage: arc setups [--window ID] [--json]');
    return JSON.stringify(await requestWindow('setups', {}, window));
  }
  if (command === 'read') {
    if (sessions.length !== 1 || !options.has('--observation') || !requestId)
      throw new Error(
        'Usage: arc read ID --observation TOKEN --request-id WINDOW:REQUEST [--dry-run] [--window WINDOW] [--json]',
      );
    if (!READ_OBSERVATION.test(options.get('--observation')!))
      throw new Error('The read observation is invalid. Copy readObservation from arc session --json.');
    const identity = requesterIdentity();
    if (identity.ambiguous || !identity.provider) throw new Error('Run read from one Claude Code or Codex session.');
    return JSON.stringify(
      await requestWindow(
        'read',
        {
          sessionId: sessions[0],
          observation: options.get('--observation')!,
          dryRun: flags.has('--dry-run'),
        },
        window,
        undefined,
        requestId,
      ),
    );
  }
  if (command === 'send') {
    if (sessions.length !== 1 || !options.has('--prompt-file') || !options.has('--observation') || !requestId)
      throw new Error(
        'Usage: arc send ID --prompt-file FILE --observation OBSERVATION --request-id WINDOW:REQUEST [--window WINDOW] [--json]',
      );
    if (!SESSION_OBSERVATION.test(options.get('--observation')!))
      throw new Error('The observation is invalid. Copy it from arc session --json.');
    const identity = requesterIdentity();
    if (identity.ambiguous)
      throw new Error(
        'Both CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID are set, so Arc cannot tell which session is asking. No prompt was sent.',
      );
    if (!identity.provider) throw new Error('Run send from a Claude Code or Codex session. No prompt was sent.');
    const prompt = readPromptFile(options.get('--prompt-file')!);
    if (guardedPromptRefusal(prompt)) throw new Error('Supply a nonempty prompt without a prompt-box command.');
    const params: SessionWriteParams = { sessionId: sessions[0], prompt, observation: options.get('--observation')! };
    const result = (await requestWindow('send', params, window, undefined, requestId)) as {
      status: string;
      reason: string;
    };
    // A client-side unknown still names the exact payload, so a retry can be matched to it.
    const reply = { payloadSha256: payloadSha256(prompt), nativeTurnId: null, ...result };
    if (flags.has('--json')) return JSON.stringify(reply);
    return reply.status === 'refused' ? reply.reason : `${reply.reason} Request ID: ${requestId}.`;
  }
  if (command === 'start') {
    if (sessions.length || !options.has('--prompt-file')) throw new Error('Start requires --prompt-file PATH.');
    const key = options.get('--setup');
    if (key && ['--provider', '--model', '--effort', '--permissions'].some((arg) => options.has(arg)))
      throw new Error('A setup key cannot combine with explicit setup values.');
    if (!key && !['claude', 'codex'].includes(options.get('--provider') ?? ''))
      throw new Error('Choose --provider claude or codex, or --setup KEY.');
    // `--arc-dispatch` makes a guarded start, which records the requesting session as the worker's owner.
    const guarded = flags.has('--arc-dispatch');
    if (guarded && requesterIdentity().ambiguous)
      throw new Error(
        'Both CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID are set, so Arc cannot tell which session is asking. No session was started.',
      );
    const prompt = readPromptFile(options.get('--prompt-file')!);
    if (guardedPromptRefusal(prompt)) throw new Error('Supply a nonempty prompt without a prompt-box command.');
    const params: SessionWriteParams = {
      setup: key
        ? { kind: 'row', key }
        : {
            kind: 'custom',
            agent: options.get('--provider')!,
            model: options.get('--model') ?? '',
            effort: options.get('--effort') ?? '',
            permissionMode: options.get('--permissions') ?? '',
          },
      prompt,
      agentRun,
      pinned: flags.has('--pinned'),
      labels,
      ...(options.has('--name') ? { name: options.get('--name')! } : {}),
    };
    const result = (await requestWindow('start', params, window, undefined, requestId, guarded)) as {
      status: string;
      sessionId?: string;
      provider?: string;
    };
    const json = JSON.stringify(result);
    if (!guarded || !result.sessionId || !result.status.startsWith('accepted')) return json;

    return `${json}\nARC_DISPATCH_SESSION=${JSON.stringify({ agent: result.provider, session_id: result.sessionId, ...(options.has('--name') ? { name: options.get('--name') } : {}), ...(params.agentRun ? {} : { owned: true }) })}`;
  }
  if (sessions.length !== 1) throw new Error(`${command} requires one session ID.`);
  const action = command as SessionWriteParams['action'];
  if ((action === 'label-add' || action === 'label-remove') && !labels.length)
    throw new Error('Label changes require --label NAME.');
  if (labels.length && action !== 'label-add' && action !== 'label-remove')
    throw new Error('--label requires label add or label remove.');
  return JSON.stringify(
    await requestWindow(
      'curate',
      { sessionId: sessions[0], action, labels, dryRun: flags.has('--dry-run'), force: flags.has('--force') },
      window,
      undefined,
      requestId,
    ),
  );
}
