import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, encoded, sha } from './core.mjs';

const limitation =
  'Local exploratory run: read-only sandboxing does not deny every host read or network path. Ambient global instructions and tools are not independently attested. An active attempt can exceed the launch budget before it stops.';
export { limitation };

function executable() {
  const search = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8' });
  assert(search.status === 0, 'Codex executable missing');
  const found = search.stdout.split(/\r?\n/).filter(Boolean);
  return process.platform === 'win32' ? found.find((name) => /\.cmd$/i.test(name)) || found[0] : found[0];
}

function cmdArgs(exe, args) {
  assert(!/["&|<>%^!]/.test(exe), 'unsafe Codex path');
  return [
    '/d',
    '/s',
    '/c',
    `""${exe}" ${args
      .map((arg) => {
        assert(typeof arg === 'string' && !/["&|<>%^!\r\n]/.test(arg), 'unsafe Codex argument');
        return `"${arg}"`;
      })
      .join(' ')}"`,
  ];
}

function launch(exe, args, options = {}) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return spawn(exe, args, { ...options, shell: false });
  return spawn(process.env.ComSpec || 'cmd.exe', cmdArgs(exe, args), {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  });
}

function runCodexSync(exe, args, options, platform) {
  const batch = platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
  return spawnSync(batch ? process.env.ComSpec || 'cmd.exe' : exe, batch ? cmdArgs(exe, args) : args, {
    ...options,
    windowsVerbatimArguments: batch,
  });
}

export function sandboxSettings(platform = process.platform) {
  return { sandbox: 'read-only', windows_backend: platform === 'win32' ? 'elevated' : null };
}

export function preflightCodex({
  platform = process.platform,
  executablePath = executable(),
  runCommand = (exe, args, options) => runCodexSync(exe, args, options, platform),
} = {}) {
  const exe = executablePath;
  const invoke = (args) => runCommand(exe, args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const command = (args) => {
    const result = invoke(args);
    assert(result.status === 0, `Codex preflight failed: ${result.stderr || result.error?.message || ''}`);
    return result.stdout;
  };
  const version = command(['--version']).trim();
  const help = command(['exec', '--help']);
  for (const flag of [
    '--ignore-user-config',
    '--json',
    '--output-last-message',
    '--skip-git-repo-check',
    '--sandbox',
    '--config',
  ])
    assert(help.includes(flag), `Codex lacks ${flag}`);
  let sandboxPreflight = null;
  if (platform === 'win32') {
    const sandboxHelp = command(['sandbox', '--help']);
    for (const flag of ['-P', '-C', '--include-managed-config'])
      assert(sandboxHelp.includes(flag), `Codex sandbox helper lacks ${flag}`);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sandbox-preflight-'));
    try {
      const sentinel = `arc-sandbox-${process.pid}-${Date.now()}`;
      fs.writeFileSync(path.join(workspace, 'sentinel.txt'), sentinel);
      const prefix = [
        '-c',
        'windows.sandbox=elevated',
        'sandbox',
        '--include-managed-config',
        '-P',
        ':read-only',
        '-C',
        workspace,
      ];
      const powershell = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const read = invoke([
        ...prefix,
        powershell,
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Content -LiteralPath sentinel.txt',
      ]);
      assert(
        read.status === 0 && read.stdout.trim() === sentinel,
        `Codex sandbox read failed: ${read.stderr || read.error?.message || 'unexpected output'}`,
      );
      const write = invoke([
        ...prefix,
        powershell,
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Set-Content -LiteralPath denied.txt -Value forbidden -ErrorAction Stop',
      ]);
      assert(
        write.status !== 0 &&
          /access is denied|permission denied|unauthorizedaccessexception|access to the path .* is denied/i.test(
            write.stderr || '',
          ) &&
          !fs.existsSync(path.join(workspace, 'denied.txt')),
        `Codex sandbox write was not denied by read-only policy: ${write.stderr || write.error?.message || 'unexpected result'}`,
      );
      sandboxPreflight = { backend: 'elevated', permission_profile: ':read-only', read: 'passed', write: 'denied' };
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
  return { exe, version, helpHash: sha(help), sandboxPreflight };
}

function sessionPath(threadId) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId || '')) return null;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const folder = path.join(home, 'sessions');
  if (!fs.existsSync(folder)) return null;
  const stack = [folder];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) return path.join(current, entry.name);
    }
  }
  return null;
}

function usageCounters(value) {
  if (!value || typeof value !== 'object') return null;
  const counters = {
    input_tokens: value.input_tokens,
    cached_input_tokens: value.cached_input_tokens ?? 0,
    output_tokens: value.output_tokens,
  };
  if (
    !Object.values(counters).every((number) => Number.isSafeInteger(number) && number >= 0) ||
    counters.cached_input_tokens > counters.input_tokens
  )
    return null;
  return counters;
}

export function observedCondition(threadId, expectedModel, expectedEffort) {
  const file = sessionPath(threadId);
  if (!file)
    return { state: 'unverified', reason: 'exact session rollout missing', model: null, effort: null, usage: null };
  let model = null;
  let effort = null;
  let usage = null;
  let counters = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let maxRequestInputTokens = 0;
  let completeUsage = true;
  let requests = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      if (line.includes('token_count')) completeUsage = false;
      continue;
    }
    if (record.type === 'turn_context') {
      model = record.payload?.model || model;
      effort = record.payload?.effort || record.payload?.reasoning_effort || effort;
    }
    if (record.type === 'thread_settings_applied') {
      const settings = record.payload?.thread_settings;
      model = settings?.model || settings?.model_id || model;
      effort = settings?.reasoning_effort || effort;
    }
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') {
      const total = usageCounters(record.payload?.info?.total_token_usage);
      const last = usageCounters(record.payload?.info?.last_token_usage);
      if (!total && !last) continue;
      if (!total || !last) {
        completeUsage = false;
        if (total) usage = total;
        continue;
      }
      usage = total;
      const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
      const repeated = fields.every((field) => total[field] === counters[field]);
      if (repeated) {
        if (!fields.every((field) => last[field] === 0 || last[field] <= total[field])) completeUsage = false;
        continue;
      }
      if (!fields.every((field) => total[field] - counters[field] === last[field])) completeUsage = false;
      maxRequestInputTokens = Math.max(maxRequestInputTokens, last.input_tokens);
      counters = total;
      requests++;
    }
  }
  const maximum = completeUsage && requests ? maxRequestInputTokens : null;
  if (!model || !effort)
    return {
      state: 'unverified',
      reason: 'model or effort absent from exact rollout',
      model,
      effort,
      usage,
      maxRequestInputTokens: maximum,
      rollout: file,
    };
  return {
    state: model === expectedModel && effort === expectedEffort ? 'verified' : 'void',
    reason: model === expectedModel && effort === expectedEffort ? null : 'observed model or effort mismatch',
    model,
    effort,
    usage,
    maxRequestInputTokens: maximum,
    rollout: file,
  };
}

export function estimateCost(usage, rate, maxRequestInputTokens = null) {
  if (!usage || !rate) return null;
  const input = usage.input_tokens;
  const cached = usage.cached_input_tokens ?? 0;
  const output = usage.output_tokens;
  if (![input, cached, output].every((n) => Number.isFinite(n) && n >= 0) || cached > input) return null;
  if (
    Number.isFinite(rate.maxPricedContext) &&
    input > rate.maxPricedContext &&
    (!Number.isSafeInteger(maxRequestInputTokens) || maxRequestInputTokens > rate.maxPricedContext)
  )
    return null;
  return ((input - cached) * rate.input + cached * rate.cacheRead + output * rate.output) / 1_000_000;
}

export function canReserve(spent, reservation, budget) {
  return (
    [spent, reservation, budget].every(Number.isFinite) &&
    reservation > 0 &&
    budget > 0 &&
    spent + reservation <= budget
  );
}

export function eventFailures(event) {
  const failedCommand =
    event.item?.type === 'command_execution' &&
    (event.type === 'item.failed' ||
      event.item.status === 'failed' ||
      (Number.isInteger(event.item.exit_code) && event.item.exit_code !== 0));
  const diagnostics = failedCommand
    ? [event.item.error?.message, event.item.error]
    : event.type === 'error' || event.type === 'turn.failed'
      ? [event.message, event.error?.message, event.error]
      : [];
  return {
    policy:
      diagnostics
        .find(
          (detail) =>
            typeof detail === 'string' && /blocked by policy|rejected by policy|denied by policy/i.test(detail),
        )
        ?.trim() || null,
    authentication:
      ((event.type === 'error' || event.type === 'turn.failed') &&
        diagnostics
          .find((detail) => typeof detail === 'string' && /auth|login|credential|unauthorized|sign in/i.test(detail))
          ?.trim()) ||
      null,
  };
}

export async function executeCodex({
  cli,
  model,
  effort,
  workspace,
  prompt,
  out,
  timeoutMs,
  spawnFn = launch,
  platform = process.platform,
}) {
  assert(
    /^[a-zA-Z0-9._-]+$/.test(model) && /^(low|medium|high|xhigh|max|ultra)$/.test(effort),
    'invalid model or effort',
  );
  const eventsFile = path.join(out, 'events.jsonl');
  const replyFile = path.join(out, 'reply.txt');
  fs.mkdirSync(out, { recursive: true });
  const args = [
    'exec',
    '--ignore-user-config',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-m',
    model,
    '-c',
    `model_reasoning_effort=${effort}`,
    '-c',
    'project_doc_max_bytes=0',
    ...(platform === 'win32' ? ['-c', 'windows.sandbox=elevated'] : []),
    '--output-last-message',
    replyFile,
    '-',
  ];
  const stream = fs.createWriteStream(eventsFile, { flags: 'wx' });
  const started = Date.now();
  const child = spawnFn(cli.exe, args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform !== 'win32',
  });
  let output = '';
  let error = '';
  let threadId = null;
  let eventUsage = null;
  let eventPolicyDenial = null;
  let eventAuthentication = null;
  let validEvents = 0;
  let timedOut = false;
  let interrupted = false;
  let stdinError = null;
  const terminate = () => {
    const pid = child.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  };
  const onInterrupt = () => {
    interrupted = true;
    terminate();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  child.stdout.on('data', (chunk) => {
    stream.write(chunk);
    output += chunk.toString('utf8');
    const lines = output.split('\n');
    output = lines.pop();
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      validEvents++;
      if (event.type === 'thread.started') threadId = event.thread_id;
      if (event.type === 'turn.completed' && event.usage) eventUsage = event.usage;
      const failure = eventFailures(event);
      eventPolicyDenial ||= failure.policy;
      eventAuthentication ||= failure.authentication;
    }
  });
  child.stderr.on('data', (chunk) => {
    error += chunk.toString('utf8');
  });
  child.stdin.on('error', (err) => {
    stdinError = err;
  });
  child.stdin.end(prompt);
  const outcome = await new Promise((resolve) => {
    let launchError = null;
    child.once('error', (err) => {
      launchError = err.message;
    });
    child.once('close', (code) => resolve({ code, error: launchError }));
  });
  clearTimeout(timer);
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  await new Promise((resolve) => stream.end(resolve));
  fs.writeFileSync(path.join(out, 'stderr.txt'), error);
  const observed = observedCondition(threadId, model, effort);
  const usage = eventUsage || observed.usage;
  const observedCounters = usageCounters(observed.usage);
  const eventCounters = usageCounters(eventUsage);
  const maxRequestInputTokens =
    eventCounters &&
    observedCounters &&
    ['input_tokens', 'cached_input_tokens', 'output_tokens'].every(
      (field) => eventCounters[field] === observedCounters[field],
    )
      ? observed.maxRequestInputTokens
      : null;
  const policyDenied = /blocked by policy|rejected by policy|denied by policy/i.test(error) || !!eventPolicyDenial;
  const authenticationFailure =
    eventAuthentication ||
    (outcome.code !== 0 && /auth|login|credential|unauthorized|sign in/i.test(error) ? error.trim() : null);
  const failureKind = interrupted
    ? 'interrupted'
    : timedOut
      ? 'timeout'
      : outcome.error
        ? 'spawn-error'
        : stdinError
          ? 'stdin-error'
          : policyDenied
            ? 'sandbox-policy-denial'
            : authenticationFailure
              ? 'authentication'
              : outcome.code !== 0
                ? 'process-error'
                : !validEvents || !fs.existsSync(replyFile)
                  ? 'malformed-output'
                  : null;
  return {
    status: failureKind === 'sandbox-policy-denial' ? 'infrastructure-failure' : failureKind || 'completed',
    failure_kind: failureKind,
    condition_failures: {
      policy: eventPolicyDenial || (policyDenied ? error.trim() : null),
      authentication: authenticationFailure,
    },
    reason:
      outcome.error ||
      stdinError?.message ||
      (outcome.code !== 0 || policyDenied || eventAuthentication
        ? error.trim() || eventPolicyDenial || eventAuthentication || `Codex exited with code ${outcome.code}`
        : failureKind === 'malformed-output'
          ? 'missing valid JSON events or final reply'
          : null),
    threadId,
    elapsedMs: Date.now() - started,
    observed,
    usage,
    maxRequestInputTokens,
    reply: fs.existsSync(replyFile) ? fs.readFileSync(replyFile, 'utf8') : null,
  };
}

export function persist(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, encoded(value), { flag: 'wx' });
  fs.renameSync(tmp, file);
}
