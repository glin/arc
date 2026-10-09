import * as fs from 'node:fs';
import { requestWindow } from '../../extension/src/sessionrequests.ts';
import type { SessionWriteParams } from '../../extension/src/sessionwrites.ts';

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
  ]);
  const switches = new Set([
    '--json',
    '--agent-run',
    '--untagged',
    '--pinned',
    '--arc-dispatch',
    '--dry-run',
    '--force',
  ]);
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (values.has(arg)) {
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
        : ['--window', '--request-id', '--label', '--json', '--dry-run', ...(command === 'archive' ? ['--force'] : [])];
  for (const arg of [...options.keys(), ...flags, ...(labels.length ? ['--label'] : [])]) {
    if (!allowed.includes(arg)) throw new Error(`${arg} is unavailable for ${command}.`);
  }
  const window = options.get('--window');
  const requestId = options.get('--request-id');
  if (command === 'setups') {
    if (sessions.length) throw new Error('Usage: arc setups [--window ID] [--json]');
    return JSON.stringify(await requestWindow('setups', {}, window));
  }
  if (command === 'start') {
    if (sessions.length || !options.has('--prompt-file')) throw new Error('Start requires --prompt-file PATH.');
    if (flags.has('--agent-run') === flags.has('--untagged')) throw new Error('Choose --agent-run or --untagged.');
    const key = options.get('--setup');
    if (key && ['--provider', '--model', '--effort', '--permissions'].some((arg) => options.has(arg)))
      throw new Error('A setup key cannot combine with explicit setup values.');
    if (!key && !['claude', 'codex'].includes(options.get('--provider') ?? ''))
      throw new Error('Choose --provider claude or codex, or --setup KEY.');
    const file = options.get('--prompt-file')!;
    const fd = fs.openSync(file, 'r');
    let prompt: string;
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
      prompt = buffer
        .subarray(0, count)
        .toString('utf8')
        .replace(/^\uFEFF/, '');
    } finally {
      fs.closeSync(fd);
    }
    if (!prompt.trim() || prompt.trimStart().startsWith('/'))
      throw new Error('Supply a nonempty prompt without a prompt-box command.');
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
      agentRun: flags.has('--agent-run'),
      pinned: flags.has('--pinned'),
      labels,
      ...(options.has('--name') ? { name: options.get('--name')! } : {}),
    };
    const result = (await requestWindow('start', params, window, undefined, requestId)) as {
      status: string;
      sessionId?: string;
      provider?: string;
    };
    const json = JSON.stringify(result);
    if (!flags.has('--arc-dispatch') || !result.sessionId || !result.status.startsWith('accepted')) return json;
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
