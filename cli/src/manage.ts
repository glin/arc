import { runBackgroundManagement } from './standalone.ts';
import { resolve } from 'node:path';
import { validContinuation, validContinuationPath, CONTINUATION_LIMITS } from '../../extension/src/compactrequest.ts';
import {
  canonicalServiceTier,
  serviceTierRefusal,
  type RequestedServiceTier,
  cacheLifetimeRefusal,
  launchPolicy,
  type RequestedCacheLifetime,
} from '../../extension/src/launchpolicy.ts';
import type { SetupListing } from '../../extension/src/view/launcher.ts';
import * as fs from 'node:fs';
import { requestWindow, requesterIdentity } from '../../extension/src/sessionrequests.ts';
import { ARC_IDENTITY } from '../../extension/src/domain/identity.ts';
import { formatNamedSessionLink } from '../../extension/src/domain/session-link.ts';
import { NAME_STATES_WITHOUT_NAME, sessionRenameTitle } from '../../extension/src/sessionrename.ts';
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
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)).replace(/^\uFEFF/, '');
    } catch {
      throw new Error('The prompt file is not valid UTF-8.');
    }
  } finally {
    fs.closeSync(fd);
  }
}

// The link names the session by its requested name. It is null unless all of these hold.
// The selected window is the invoking window, which ARC_WINDOW in this process establishes.
// The name shows visible text on one line.
// The name state is not failed, uncertain, or cancelled, and carries no error.
// The session ID is a valid link target.
function startLink(
  sessionId: string,
  metadata: { name?: { state?: string; error?: unknown } } | undefined,
  name: string | undefined,
  window: string | undefined,
): string | null {
  const invoking = process.env[`${ARC_IDENTITY.environmentPrefix}WINDOW`];
  const selected = window === undefined ? invoking : window;
  if (!invoking || selected !== invoking || name === undefined || sessionRenameTitle(name) === null) return null;
  const state = metadata?.name;
  if (state && (NAME_STATES_WITHOUT_NAME.some((blocked) => blocked === state.state) || state.error)) return null;
  return formatNamedSessionLink(name, sessionId);
}

export function readContinuationFile(file: string, sha256: string): { text: string; sha256: string } {
  if (!validContinuationPath(file)) throw new Error('Supply an absolute continuation file path with forward slashes.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('The continuation file must be a regular file.');
    const bytes = Buffer.alloc(CONTINUATION_LIMITS.bytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    const input = bytes.subarray(0, count);
    if (input.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
      throw new Error('The continuation file must not begin with a byte-order mark.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    if (!validContinuation(text, sha256))
      throw new Error('The continuation file is invalid or its SHA-256 does not match.');
    return { text, sha256 };
  } finally {
    fs.closeSync(fd);
  }
}

function renderSetups(listing: SetupListing): string {
  const choice = (value: string | undefined) => value || '(default)';
  const lines = [`Project: ${listing.project}`];
  if (listing.setups.length) {
    lines.push('Setups');
    for (const setup of listing.setups) {
      lines.push(
        `  ${setup.key}  ${setup.provider}  ${choice(setup.model)}  ${choice(setup.effort)}  ${choice(setup.permissions)}` +
          (setup.key === listing.primary ? '  (primary)' : '') +
          (setup.missingValue ? `  (unavailable: ${setup.missingValue})` : ''),
      );
    }
  } else lines.push('No reusable setups. Explicit provider settings remain available.');
  for (const agent of listing.agents) {
    lines.push('', agent.provider);
    if (agent.modelsPending) lines.push('  Models: loading');
    for (const model of agent.models) {
      lines.push(`  ${choice(model.value)}  Effort: ${model.efforts.map(choice).join(', ')}`);
    }
    lines.push(`  Permissions: ${agent.permissions.map(choice).join(', ')}`);
  }
  lines.push('', '(default) means omitting that flag.');
  return lines.join('\n');
}

export async function runManagement(command: string, args: string[]): Promise<string> {
  if (command.startsWith('standalone-'))
    return runBackgroundManagement(command.slice(11) as 'logs' | 'attach' | 'stop' | 'rm', args);
  const provider = command === 'start' && ['claude', 'codex'].includes(args[0]) ? args[0] : undefined;
  if (provider) args = args.slice(1);
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const sessions: string[] = [];
  const labels: string[] = [];
  const readTools: string[] = [];
  const values = new Set([
    '--window',
    '--request-id',
    '--setup',
    '--model',
    '--effort',
    '--permissions',
    '--cwd',
    '--read-tool',
    '--prompt-file',
    '--name',
    '--label',
    '--observation',
    '--completion',
    '--report-file',
    '--cache-lifetime',
    '--service-tier',
  ]);
  const switches = new Set([
    '--read-only',
    '--json',
    '--pinned',
    '--arc-dispatch',
    '--dry-run',
    '--force',
    '--queue',
    '-q',
  ]);
  let agentRun = false;
  let agentRunSeen = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] === '-q' ? '--queue' : args[at];
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
      else if (arg === '--read-tool') readTools.push(value);
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
        ? ['--window', '--request-id', '--prompt-file', '--observation', '--queue', '--json']
        : command === 'read'
          ? ['--window', '--request-id', '--observation', '--dry-run', '--json']
          : command === 'start'
            ? [
                '--window',
                '--request-id',
                '--setup',
                '--model',
                '--effort',
                '--permissions',
                '--cwd',
                '--read-only',
                '--read-tool',
                '--prompt-file',
                '--name',
                '--label',
                '--json',
                '--agent-run',
                '--pinned',
                '--arc-dispatch',
                '--completion',
                '--report-file',
                '--cache-lifetime',
                '--service-tier',
              ]
            : [
                '--window',
                '--request-id',
                '--label',
                '--json',
                '--dry-run',
                ...(command === 'archive' ? ['--force'] : []),
              ];
  for (const arg of [
    ...options.keys(),
    ...flags,
    ...(labels.length ? ['--label'] : []),
    ...(readTools.length ? ['--read-tool'] : []),
  ]) {
    if (!allowed.includes(arg)) throw new Error(`${arg} is unavailable for ${command}.`);
  }
  const window = options.get('--window');
  const requestId = options.get('--request-id');
  if (command === 'setups') {
    if (sessions.length) throw new Error('Usage: arc setups [--window ID] [--json]');
    const listing = (await requestWindow('setups', {}, window)) as SetupListing;
    return flags.has('--json') ? JSON.stringify(listing) : renderSetups(listing);
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
    if (sessions.length !== 1 || !options.has('--prompt-file') || !requestId)
      throw new Error(
        'Usage: arc send ID --prompt-file FILE [--queue | --observation OBSERVATION] --request-id WINDOW:REQUEST [--window WINDOW] [--json]',
      );
    if (flags.has('--queue') && options.has('--observation'))
      throw new Error('--queue cannot combine with --observation.');
    if (options.has('--observation') && !SESSION_OBSERVATION.test(options.get('--observation')!))
      throw new Error('The observation is invalid. Copy it from arc session --json.');
    const identity = requesterIdentity();
    if (identity.ambiguous)
      throw new Error(
        'Both CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID are set, so Arc cannot tell which session is asking. No prompt was sent.',
      );
    if (!identity.provider) throw new Error('Run send from a Claude Code or Codex session. No prompt was sent.');
    const prompt = readPromptFile(options.get('--prompt-file')!);
    if (guardedPromptRefusal(prompt)) throw new Error('Supply a nonempty prompt without a prompt-box command.');
    const params: SessionWriteParams = {
      sessionId: sessions[0],
      prompt,
      ...(options.has('--observation')
        ? { observation: options.get('--observation')! }
        : flags.has('--queue')
          ? {}
          : { delivery: 'auto' as const }),
    };
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
    if (sessions.length) throw new Error('Choose arc start claude, arc start codex, or arc start --setup KEY.');
    if (!options.has('--prompt-file')) throw new Error('Start requires --prompt-file PATH.');
    const key = options.get('--setup');
    if (options.has('--setup') && !key) throw new Error('--setup requires a nonempty key.');
    if (key && (provider || ['--model', '--effort', '--permissions'].some((arg) => options.has(arg))))
      throw new Error('A setup key cannot combine with explicit setup values.');
    if (!key && !provider) throw new Error('Choose arc start claude, arc start codex, or arc start --setup KEY.');
    const serviceTier = options.get('--service-tier') as RequestedServiceTier | undefined;
    const tierRefusal = serviceTier === undefined ? null : serviceTierRefusal(serviceTier, provider ?? 'codex');
    if (tierRefusal) throw new Error(tierRefusal);
    const cacheLifetime = options.get('--cache-lifetime');
    // A setup key names its provider only in the window, so the window refuses a Codex setup.
    const lifetimeRefusal =
      cacheLifetime === undefined ? null : cacheLifetimeRefusal(cacheLifetime, provider ?? 'claude');
    if (lifetimeRefusal) throw new Error(lifetimeRefusal);
    launchPolicy(provider ?? 'claude', flags.has('--read-only'), readTools, options.get('--permissions'));
    // `--arc-dispatch` makes a guarded start, which records the requesting session as the worker's owner.
    const guarded = flags.has('--arc-dispatch');
    if ((options.has('--completion') || options.has('--report-file')) && !guarded)
      throw new Error('Dispatch completion and report files require --arc-dispatch.');
    if (options.has('--completion') && !['manual', 'wait'].includes(options.get('--completion')!))
      throw new Error('Choose --completion manual or wait.');
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
            agent: provider!,
            model: options.get('--model') ?? '',
            effort: options.get('--effort') ?? '',
            permissionMode: options.get('--permissions') ?? '',
          },
      prompt,
      agentRun,
      ...(cacheLifetime ? { cacheLifetime: cacheLifetime as RequestedCacheLifetime } : {}),
      ...(serviceTier === undefined ? {} : { serviceTier: canonicalServiceTier(serviceTier) }),
      ...(guarded
        ? {
            dispatch: true,
            completion: (options.get('--completion') ?? 'manual') as 'manual' | 'wait',
            ...(options.has('--report-file') ? { reportPath: resolve(options.get('--report-file')!) } : {}),
          }
        : {}),
      ...(options.has('--cwd') ? { cwd: resolve(options.get('--cwd')!) } : {}),
      ...(flags.has('--read-only') ? { readOnly: true, readTools } : {}),
      pinned: flags.has('--pinned'),
      labels,
      ...(options.has('--name') ? { name: options.get('--name')! } : {}),
    };
    const result = (await requestWindow('start', params, window, undefined, requestId, guarded)) as {
      status: string;
      sessionId?: string;
      provider?: string;
      launchId?: string;
      metadata?: { name?: { state?: string; error?: unknown } };
    };
    const sessionId = result.sessionId;
    const accepted = !!sessionId && result.status.startsWith('accepted');
    const json = JSON.stringify(
      accepted ? { ...result, link: startLink(sessionId, result.metadata, options.get('--name'), window) } : result,
    );
    if (!guarded || !accepted) return json;

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
