import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readPromptFile } from './manage.ts';
import { guardedPromptRefusal, payloadSha256 } from '../../extension/src/sessionwrites.ts';
import { requesterIdentity } from '../../extension/src/sessionrequests.ts';
import {
  canonicalServiceTier,
  serviceTierRefusal,
  type RequestedServiceTier,
  launchPolicy,
  claudeReadOnlyArgs,
  claudeReadOnlyMcp,
  standaloneModel,
  cacheLifetimeRefusal,
  claudeCacheLifetime,
  CACHE_TTL_ENV,
  type RequestedCacheLifetime,
} from '../../extension/src/launchpolicy.ts';
import { claudeLaunch, codexLaunch, type Machine } from '../../extension/src/composerview.ts';
import { DispatchReceipts, type StandaloneOptions } from '../../extension/src/dispatchreceipts.ts';
import { LAUNCH_ENV_NAMES, checkCodexServiceTier, childEnv, unstartable } from '../../extension/src/agenthost.ts';
import {
  waitStandalone,
  waitStandaloneIdentity,
  superviseStandalone,
  terminalPlan,
  terminalLauncher,
  standaloneContext,
  standaloneEnvironment,
} from './standalone.ts';

export function parseRun(args: string[], env = process.env, platform = process.platform) {
  const [provider, ...remaining] = args;
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Choose arc run claude or arc run codex.');
  args = remaining;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const dirs: string[] = [];
  const tools: string[] = [];
  let agentRun = false;
  let classification = false;
  const scalars = [
    '--model',
    '--effort',
    '--permissions',
    '--cwd',
    '--prompt-file',
    '--name',
    '--completion',
    '--report-file',
    '--output',
    '--log',
    '--notify-thread',
    '--cache-lifetime',
    '--service-tier',
  ];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--agent-run' || arg.startsWith('--agent-run=')) {
      const value = arg === '--agent-run' ? 'true' : arg.slice(12);
      if (classification || !['true', 'false'].includes(value))
        throw new Error('--agent-run accepts one true or false value.');
      classification = true;
      agentRun = value === 'true';
    } else if (scalars.includes(arg) || arg === '--add-dir' || arg === '--read-tool') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || value.includes('\0'))
        throw new Error(`${arg} requires a value.`);
      if (arg === '--add-dir') dirs.push(value);
      else if (arg === '--read-tool') tools.push(value);
      else {
        if (values.has(arg)) throw new Error(`Repeated argument: ${arg}`);
        values.set(arg, value);
      }
    } else if (['--read-only', '--attach', '--json', '--arc-dispatch'].includes(arg) && !flags.has(arg)) flags.add(arg);
    else throw new Error(`Unknown or repeated argument: ${arg}`);
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`Standalone run requires ${key}.`);
    return value;
  };
  const requestedTier = values.get('--service-tier') as RequestedServiceTier | undefined;
  const tierRefusal = requestedTier === undefined ? null : serviceTierRefusal(requestedTier, provider);
  if (tierRefusal) throw new Error(tierRefusal);
  const serviceTier = requestedTier === undefined ? undefined : canonicalServiceTier(requestedTier);
  const tierArgs = serviceTier === undefined ? [] : ['-c', `service_tier="${serviceTier}"`];
  const cacheLifetime = values.get('--cache-lifetime') as RequestedCacheLifetime | undefined;
  const lifetimeRefusal = cacheLifetime === undefined ? null : cacheLifetimeRefusal(cacheLifetime, provider);
  if (lifetimeRefusal) throw new Error(lifetimeRefusal);
  const cwd = path.resolve(required('--cwd'));
  const context = standaloneContext(env, cwd);
  const selectedEnv = { ...env };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ARC_PROJECTS_ROOT', 'ARC_CODEX_ROOT']) {
    for (const name of Object.keys(selectedEnv)) if (name.toUpperCase() === key) delete selectedEnv[name];
    if (context[key] !== null) selectedEnv[key] = context[key];
  }
  const model = standaloneModel(provider, required('--model'), selectedEnv);
  const effort = required('--effort');
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort))
    throw new Error('The reasoning effort is unavailable.');
  const completion = values.get('--completion') ?? 'manual';
  if (completion === 'callback' || values.has('--notify-thread'))
    throw new Error(
      'Standalone callback requires a proven original Codex parent on a supported daemon. That route is unavailable. Choose manual or wait.',
    );
  if (!['manual', 'wait'].includes(completion)) throw new Error('Choose --completion manual or wait.');
  if (flags.has('--attach') && completion === 'wait')
    throw new Error('--completion wait is unsupported with --attach. Watch the opened terminal.');
  if (flags.has('--attach') && provider === 'claude' && flags.has('--read-only'))
    throw new Error('--attach is unsupported with Claude --read-only. Print output stays in the result log.');
  if (values.has('--output') && values.has('--report-file')) throw new Error('Choose --output or --report-file.');
  if (
    flags.has('--attach') &&
    provider === 'codex' &&
    ['--log', '--output', '--report-file'].some((key) => values.has(key))
  )
    throw new Error('Attended Codex cannot save logs or reports. Omit output paths or run without --attach.');
  const addDirs = dirs.map((dir) => path.resolve(cwd, dir));
  for (const dir of [cwd, ...addDirs])
    if (!fs.statSync(dir).isDirectory()) throw new Error(`The launch directory is unavailable: ${dir}`);
  const prompt = readPromptFile(required('--prompt-file'));
  if (guardedPromptRefusal(prompt)) throw new Error('Supply a nonempty prompt without a prompt-box command.');
  const permission = values.get('--permissions') ?? '';
  const policy = launchPolicy(provider, flags.has('--read-only'), tools, permission);
  if (
    provider === 'claude' &&
    permission &&
    !['auto', 'default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan'].includes(permission)
  )
    throw new Error('The Claude permission mode is unavailable.');
  if (provider === 'codex' && permission && !['workspace-write', 'danger-full-access'].includes(permission))
    throw new Error('Choose Codex permissions workspace-write or danger-full-access.');
  const machine: Machine = {
    homeDir: os.homedir(),
    appData: env.APPDATA ?? '',
    pathEnv: env.PATH ?? env.Path ?? '',
    claudeExtensionDir: '',
    codexExtensionDir: '',
    platform,
    arch: process.arch,
    node: process.execPath,
    exists: fs.existsSync,
    // Keep this regular-file and POSIX permission check aligned with extension.ts and bundledsetup.ts.
    canExecute: (file) => {
      try {
        if (!fs.statSync(file).isFile()) return false;
        if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
  const launch =
    provider === 'claude' ? claudeLaunch(env.CLAUDE_BIN ?? '', machine) : codexLaunch(env.CODEX_BIN ?? '', machine);
  if (launch.problem) throw new Error(launch.problem);
  let command = launch.command;
  let leading = launch.leadingArgs;
  if (
    platform === 'win32' &&
    env.DISPATCH_CLI_BASH &&
    fs.existsSync(command) &&
    /^#!.*\b(?:bash|sh)\s*$/m.test(fs.readFileSync(command, 'utf8').slice(0, 256))
  ) {
    leading = [path.resolve(command).replaceAll('\\', '/'), ...leading];
    command = env.DISPATCH_CLI_BASH;
  }
  const refusal = unstartable(command, platform);
  if (refusal) throw new Error(refusal);
  const name = values.get('--name') ?? `arc-${randomUUID()}`;
  if (name.length > 200 || /[\u0000-\u001f]/.test(name)) throw new Error('The session name is invalid.');
  const background = provider === 'claude' && !policy;
  const sessionHint = provider === 'claude' && !background ? randomUUID() : null;
  const argv =
    provider === 'claude'
      ? [
          ...(background
            ? [
                '--bg',
                '-n',
                name,
                '--permission-mode',
                permission || 'auto',
                '--allowedTools',
                'Bash Edit Write Read Grep Glob MultiEdit',
              ]
            : [
                '-p',
                ...claudeReadOnlyArgs(policy!, model, claudeReadOnlyMcp(policy!, cwd, selectedEnv)),
                '--output-format',
                'json',
                '--session-id',
                sessionHint!,
              ]),
          '--model',
          model,
          '--effort',
          effort,
        ]
      : [
          'exec',
          '-C',
          cwd,
          '-s',
          policy ? 'read-only' : permission || 'workspace-write',
          '--json',
          '-c',
          'approval_policy="never"',
          '-c',
          'approvals_reviewer="user"',
          '-m',
          model,
          '-c',
          `model_reasoning_effort=${effort}`,
          ...tierArgs,
        ];
  const options: StandaloneOptions = {
    provider,
    command,
    args: [...leading, ...argv, ...addDirs.flatMap((dir) => ['--add-dir', dir])],
    cwd,
    model,
    effort,
    name,
    agentRun: flags.has('--attach') ? false : agentRun,
    background,
    sessionHint,
    logAlias: values.has('--log') ? path.resolve(values.get('--log')!) : null,
    deadlineMs: 86_400_000,
  };
  const launchEnv = childEnv(selectedEnv, launch.env, provider, cwd);
  if (flags.has('--attach') && provider === 'codex') {
    options.args = [
      ...leading,
      '-C',
      cwd,
      '-m',
      model,
      '-c',
      `model_reasoning_effort=${effort}`,
      ...tierArgs,
      '-s',
      policy ? 'read-only' : permission || 'workspace-write',
      ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    ];
  }
  for (const key of Object.keys(launchEnv)) if (LAUNCH_ENV_NAMES.includes(key.toUpperCase())) delete launchEnv[key];
  const lifetime = provider === 'claude' ? claudeCacheLifetime(launchEnv, cacheLifetime, options.agentRun) : null;
  if (lifetime) {
    for (const key of Object.keys(launchEnv)) if (key.toUpperCase() === CACHE_TTL_ENV) delete launchEnv[key];
    launchEnv[CACHE_TTL_ENV] = lifetime;
  }
  options.env = standaloneContext(launchEnv, cwd);
  return {
    options,
    tierCheck:
      serviceTier === undefined ? undefined : { launch: { ...launch, command, leadingArgs: leading }, serviceTier },
    prompt,
    policy: policy ?? null,
    completion: completion as 'manual' | 'wait',
    alias:
      values.has('--report-file') || values.has('--output')
        ? path.resolve((values.get('--report-file') ?? values.get('--output'))!)
        : options.provider === 'codex' && options.logAlias
          ? path.join(path.dirname(options.logAlias), `${path.parse(options.logAlias).name}.last.md`)
          : null,
    attach: flags.has('--attach'),
    arcDispatch: flags.has('--arc-dispatch'),
    env: launchEnv,
  };
}

export async function runStandalone(
  args: string[],
  entry = process.argv[1],
  runtime: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    receipts?: DispatchReceipts;
    signal?: AbortSignal;
    tierCheck?: typeof checkCodexServiceTier;
    exists?: typeof fs.existsSync;
  } = {},
): Promise<string> {
  const env = runtime.env ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const parsed = parseRun(args, env, platform);
  const terminal = parsed.attach ? terminalLauncher(parsed.options.cwd, platform, env, runtime.exists) : null;
  const receipts = runtime.receipts ?? new DispatchReceipts(env.ARC_HOME ? path.resolve(env.ARC_HOME) : undefined);
  parsed.options.env!.ARC_HOME = path.resolve(path.dirname(receipts.root));
  const attribution = requesterIdentity(env);
  if (attribution.ambiguous)
    throw new Error('Both provider session identities are set. Clear the unrelated identity before starting.');
  // Attribution retains a parent reference. It grants no delivery authority.
  const requester =
    attribution.provider && attribution.requester
      ? { provider: attribution.provider, id: attribution.requester }
      : null;
  if (parsed.tierCheck) {
    await (runtime.tierCheck ?? checkCodexServiceTier)(
      parsed.tierCheck.launch,
      {
        cwd: parsed.options.cwd,
        model: parsed.options.model,
        serviceTier: parsed.tierCheck.serviceTier,
        clientInfo: { name: 'arc', title: 'Arc', version: '1' },
      },
      standaloneEnvironment(parsed.options, parsed.env),
      { signal: runtime.signal },
    );
  }
  const launch = receipts.reserve({
    origin: randomBytes(12).toString('hex'),
    requester,
    policy: parsed.policy,
    promptSha256: payloadSha256(parsed.prompt),
    completion: parsed.completion,
    alias: parsed.alias,
    transport: 'standalone',
    standalone: parsed.options,
  });
  receipts.input(launch.launchId, parsed.prompt);
  const superviseArgs = [
    platform === 'win32' ? entry.replaceAll('\\', '/') : entry,
    '__standalone-supervise',
    launch.launchId,
    ...(parsed.attach ? ['--attended'] : []),
  ];
  const plan =
    terminal && parsed.options.provider === 'codex'
      ? terminalPlan(
          process.execPath,
          superviseArgs,
          parsed.options.cwd,
          receipts.artifact(launch.launchId, 'attend.sh'),
          platform,
          standaloneEnvironment(parsed.options, parsed.env),
          runtime.exists,
          terminal,
        )
      : { command: process.execPath, args: superviseArgs };
  const output = fs.openSync(receipts.artifact(launch.launchId, 'stderr.log'), 'a', 0o600);
  try {
    const child = spawn(plan.command, plan.args, {
      cwd: parsed.options.cwd,
      env: standaloneEnvironment(parsed.options, parsed.env),
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'ignore', output],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } catch {
    receipts.publish(
      launch.launchId,
      { outcome: 'unknown', availability: 'unavailable', nativeEnding: null, askId: null },
      null,
    );
    return JSON.stringify({
      launchId: launch.launchId,
      transport: launch.transport,
      state: 'accepted-with-errors',
      completion: launch.completion,
      origin: launch.origin,
      error: 'The launch did not open. Read its status before starting another session.',
    });
  } finally {
    fs.closeSync(output);
  }
  const deadline = Date.now() + 110_000;
  const sessionId =
    parsed.arcDispatch && !(parsed.attach && parsed.options.provider === 'codex')
      ? await waitStandaloneIdentity(receipts, launch.launchId, deadline - Date.now())
      : null;
  const json = JSON.stringify(
    parsed.completion === 'wait'
      ? await waitStandalone(receipts, launch.launchId, Math.max(0, deadline - Date.now()))
      : {
          launchId: launch.launchId,
          transport: launch.transport,
          state: 'starting',
          completion: launch.completion,
          origin: launch.origin,
        },
  );
  if (!parsed.arcDispatch || !sessionId) return json;
  return `${json}\nARC_DISPATCH_SESSION=${JSON.stringify({
    agent: parsed.options.provider,
    session_id: sessionId,
    name: parsed.options.name,
    ...(parsed.options.agentRun ? {} : { owned: true }),
  })}`;
}

export async function runSupervisor(
  id: string,
  attended = false,
  receipts = new DispatchReceipts(),
  entry = process.argv[1],
): Promise<void> {
  const options = receipts.launch(id).standalone;
  await superviseStandalone(
    receipts,
    id,
    false,
    undefined,
    undefined,
    attended
      ? async () => {
          const plan = terminalPlan(
            process.execPath,
            [process.platform === 'win32' ? entry.replaceAll('\\', '/') : entry, 'dispatch', 'attach', id],
            options!.cwd,
            receipts.artifact(id, 'attend.sh'),
            process.platform,
            { ...standaloneEnvironment(options!), ARC_HOME: path.resolve(path.dirname(receipts.root)) },
          );
          await new Promise<void>((resolve, reject) => {
            const child = spawn(plan.command, plan.args, {
              cwd: options!.cwd,
              env: { ...standaloneEnvironment(options!), ARC_HOME: path.resolve(path.dirname(receipts.root)) },
              windowsHide: true,
              detached: true,
              stdio: 'ignore',
            });
            child.once('spawn', () => {
              child.unref();
              resolve();
            });
            child.once('error', reject);
          });
        }
      : undefined,
    attended,
    entry,
  );
}
