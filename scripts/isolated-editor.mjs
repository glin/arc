#!/usr/bin/env node
// Launches installed VS Code with a fresh profile through Playwright, drives the Arc panel, and removes what the run created.
// Usage:
//   node scripts/isolated-editor.mjs run [<script.mjs>] [--screenshot <file>] [--timeout <seconds>] [options]
//   node scripts/isolated-editor.mjs open [options]
//   node scripts/isolated-editor.mjs cleanup [<run directory or run.json>]
// Options: --repository <checkout>, --editor <install directory>, --workspace <folder>, --scratch <parent directory>,
// --live-data, --allow-focus.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRepository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The editor inherits none of these. Arc sets ELECTRON_RUN_AS_NODE=1 for the agents it starts, and Code.exe then runs as Node.
export const SCRUBBED_VARIABLES = /^(VSCODE|ELECTRON|ARC_|CLAUDE|NODE_OPTIONS|GIT_)/i;
export const RUN_PREFIX = 'arc-isolated-editor-';
export const MANIFEST_NAME = 'run.json';
export const DEFAULT_RUN_SECONDS = 300;
export const CLEANUP_DEADLINE_MS = 30_000;
const LOCK_DEADLINE_MS = 10 * 60_000;
const CLOSE_DEADLINE_MS = 15_000;
const SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

// Settings that keep first-run prompts, updates, and AI sign-in out of the fresh profile.
export const PROFILE_SETTINGS = {
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'chat.disableAIFeatures': true,
  'security.workspace.trust.enabled': false,
};

export const realClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

// Polls until check returns a truthy value. A check that throws counts as not ready, and its last error joins the timeout message.
export async function waitFor(label, check, { deadlineMs, pollMs = 250, clock = realClock } = {}) {
  const deadline = clock.now() + deadlineMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      const cause = lastError ? ` Last error: ${String(lastError.message ?? lastError).split('\n')[0]}` : '';
      throw new Error(`Timed out after ${Math.round(deadlineMs / 1000)} s waiting for ${label}.${cause}`);
    }
    await clock.sleep(Math.min(pollMs, remaining));
  }
}

// Rejects with a labelled error when the promise does not settle before the deadline.
export function withDeadline(label, promise, deadlineMs) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${Math.round(deadlineMs / 1000)} s waiting for ${label}.`)),
      deadlineMs,
    );
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

export function runLayout(root) {
  const resolved = path.resolve(root);
  const at = (name) => path.join(resolved, name);
  return {
    root: resolved,
    manifest: at(MANIFEST_NAME),
    userData: at('user-data'),
    extensions: at('extensions'),
    arcHome: at('arc-home'),
    projects: at('claude-projects'),
    codexSessions: at('codex-sessions'),
    claudeConfig: at('claude-config'),
    codexHome: at('codex-home'),
    workspace: at('workspace'),
    state: at('state.json'),
  };
}

// The owner's transcript roots, which live data passes through after the scrub.
export const LIVE_DATA_VARIABLES = ['CLAUDE_CONFIG_DIR', 'ARC_PROJECTS_ROOT', 'ARC_CODEX_ROOT'];

// Copies the parent environment without editor, Arc, agent, Git, and Node option variables, in any letter case.
// Without liveData, transcript roots point at empty run directories and Arc starts no agent.
export function childEnvironment(parent, layout, { liveData = false } = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && !SCRUBBED_VARIABLES.test(name)) environment[name] = value;
  }
  environment.ARC_HOME = layout.arcHome;
  if (liveData) {
    for (const name of LIVE_DATA_VARIABLES) if (parent[name] !== undefined) environment[name] = parent[name];
  } else {
    Object.assign(environment, {
      ARC_PROJECTS_ROOT: layout.projects,
      ARC_CODEX_ROOT: layout.codexSessions,
      CLAUDE_CONFIG_DIR: layout.claudeConfig,
      CODEX_HOME: layout.codexHome,
      ARC_MEASURE_BLOCK_AGENTS: '1',
      ARC_MEASURE_STATE: layout.state,
    });
  }
  return environment;
}

// Each path is its own array entry, so a path with spaces reaches the editor as one argument.
export function editorArguments(layout, { extensionPath, workspace }) {
  return [
    '--user-data-dir',
    layout.userData,
    '--extensions-dir',
    layout.extensions,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--extensionDevelopmentPath',
    extensionPath,
    workspace,
  ];
}

function editorRoots(environment, platform) {
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return [path.join(local, 'Programs', 'Microsoft VS Code'), 'C:/Program Files/Microsoft VS Code'];
  }
  if (platform === 'darwin') {
    return ['/Applications/Visual Studio Code.app', path.join(os.homedir(), 'Applications/Visual Studio Code.app')];
  }
  return ['/usr/share/code', '/opt/visual-studio-code'];
}

function executablesIn(root, platform) {
  if (platform === 'win32') return [path.join(root, 'Code.exe')];
  if (platform === 'darwin') return ['Electron', 'Code'].map((name) => path.join(root, 'Contents', 'MacOS', name));
  return [path.join(root, 'code')];
}

// An explicit install directory wins over ARC_MEASURE_EDITOR, which wins over the default install locations.
export function editorExecutable({
  editor,
  environment = process.env,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const named = editor ?? environment.ARC_MEASURE_EDITOR;
  for (const root of named ? [named] : editorRoots(environment, platform)) {
    for (const candidate of executablesIn(root, platform)) if (exists(candidate)) return candidate;
  }
  throw new Error(
    named
      ? `No VS Code executable found in ${named}.`
      : 'No VS Code install found. Pass --editor <install directory> or set ARC_MEASURE_EDITOR.',
  );
}

export function extensionIdOf(extensionPath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
  return `${manifest.publisher}.${manifest.name}`;
}

const PROFILE_OPTION = '--user-data-dir';

// True when the command line passes the profile as the value of --user-data-dir, as `--user-data-dir X` or
// `--user-data-dir=X`, quoted or not. On Windows the comparison ignores letter case and slash direction.
// A path that only starts with the profile, or the profile as an ordinary argument, does not count.
export function namesProfile(commandLine, profile, platform = process.platform) {
  const windows = platform === 'win32';
  const fold = (text) => (windows ? text.toLowerCase().replaceAll('\\', '/') : text);
  const line = fold(commandLine ?? '');
  const target = fold(windows ? path.win32.resolve(profile) : path.posix.resolve(profile)).replace(/\/+$/, '');
  const space = (character) => character !== undefined && /\s/.test(character);
  for (let at = line.indexOf(PROFILE_OPTION); at !== -1; at = line.indexOf(PROFILE_OPTION, at + 1)) {
    if (at > 0 && !space(line[at - 1]) && line[at - 1] !== '"') continue;
    let index = at + PROFILE_OPTION.length;
    if (line[index] === '=') index++;
    else if (space(line[index])) while (space(line[index])) index++;
    else continue;
    if (line[index] === '"') index++;
    if (!line.startsWith(target, index)) continue;
    index += target.length;
    if (line[index] === '/') index++;
    if (line[index] === '"') index++;
    if (index === line.length || space(line[index])) return true;
  }
  return false;
}

// Processes that pass the run's profile to --user-data-dir or match a PID, start time and command line recorded in the manifest,
// plus their descendants, deepest first so that a cleanup stops descendants before ancestors.
// A descendant must start no earlier than its parent and both start times must be known, so a reused parent PID adopts nothing.
export function ownedProcesses(
  processes,
  profile,
  { platform = process.platform, selfPid = process.pid, known = [] } = {},
) {
  const recorded = new Set(
    (Array.isArray(known) ? known : []).filter((identity) => identity?.created && identity.command).map(identityKey),
  );
  const owned = new Map();
  for (const entry of processes) {
    if (entry.pid === selfPid) continue;
    const identified = entry.created && recorded.has(identityKey(identityOf(entry)));
    if (identified || namesProfile(entry.commandLine, profile, platform)) owned.set(entry.pid, entry);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of processes) {
      if (owned.has(entry.pid) || entry.pid === selfPid) continue;
      const parent = owned.get(entry.parentPid);
      if (parent && entry.created && parent.created && entry.created >= parent.created) {
        owned.set(entry.pid, entry);
        grew = true;
      }
    }
  }
  const depth = (entry, steps = 0) => {
    const parent = owned.get(entry.parentPid);
    return parent && parent !== entry && steps < owned.size ? 1 + depth(parent, steps + 1) : 0;
  };
  const depths = new Map([...owned.values()].map((entry) => [entry, depth(entry)]));
  return [...owned.values()].sort((a, b) => depths.get(b) - depths.get(a));
}

function identityKey({ pid, created, command }) {
  return `${pid}@${created}#${command}`;
}

// Unix start times have one-second precision, so a recorded identity also holds a digest of the command line.
// A process that reuses the PID within that second matches only when it runs the same command line.
export function commandDigest(commandLine) {
  return createHash('sha256')
    .update(commandLine ?? '')
    .digest('hex')
    .slice(0, 16);
}

function identityOf({ pid, created, commandLine }) {
  return { pid, created, command: commandDigest(commandLine) };
}

// True when current is the same process as the snapshot entry, not a later process that reuses its PID.
export function sameProcess(current, snapshot) {
  return Boolean(current) && current.created === snapshot.created && current.commandLine === snapshot.commandLine;
}

// Adds the PID, start time and command line digest of each entry to the manifest. Returns true when the manifest gained an identity.
export function rememberProcesses(manifest, entries) {
  if (!Array.isArray(manifest.processes)) manifest.processes = [];
  const recorded = new Set(manifest.processes.map(identityKey));
  let added = false;
  for (const entry of entries) {
    const identity = identityOf(entry);
    if (!identity.created || recorded.has(identityKey(identity))) continue;
    manifest.processes.push(identity);
    recorded.add(identityKey(identity));
    added = true;
  }
  return added;
}

const LIST_DEADLINE_MS = 15_000;
const FINAL_LIST_MS = 5_000;

function windowsProcessQuery(pids) {
  const filter = pids ? ` -Filter '${pids.map((pid) => `ProcessId=${Number(pid)}`).join(' OR ')}'` : '';
  return `Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}},CommandLine | ConvertTo-Json -Compress`;
}

export function parseWindowsProcesses(text) {
  if (!text.trim()) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: entry.ProcessId,
    parentPid: entry.ParentProcessId,
    created: entry.Created ?? null,
    commandLine: entry.CommandLine ?? '',
  }));
}

export function parseUnixProcesses(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const started = new Date(match[3]);
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      created: Number.isNaN(started.getTime()) ? null : started.toISOString(),
      commandLine: match[4],
    });
  }
  return rows;
}

// Lists every process, or only the named PIDs. The listing command blocks the event loop, so timeoutMs bounds it.
export function listProcesses({
  platform = process.platform,
  run = spawnSync,
  pids,
  timeoutMs = LIST_DEADLINE_MS,
} = {}) {
  if (pids?.length === 0) return [];
  if (!(timeoutMs > 0)) throw new Error('No time was left to list processes.');
  const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: timeoutMs };
  const result =
    platform === 'win32'
      ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsProcessQuery(pids)], options)
      : run(
          'ps',
          pids ? ['-o', 'pid=,ppid=,lstart=,args=', '-p', pids.join(',')] : ['-eo', 'pid=,ppid=,lstart=,args='],
          options,
        );
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`Could not list processes within ${Math.ceil(timeoutMs / 1000)} s.`);
  }
  // ps exits with 1 when none of the named PIDs exists.
  const noneLeft = platform !== 'win32' && pids && result.status === 1 && !result.stdout?.trim();
  if (noneLeft) return [];
  if (result.error || result.status !== 0) {
    throw new Error(`Could not list processes: ${result.error?.message ?? String(result.stderr ?? '').trim()}`);
  }
  return platform === 'win32' ? parseWindowsProcesses(result.stdout) : parseUnixProcesses(result.stdout);
}

function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export const STOP_TARGETS_VARIABLE = 'ARC_ISOLATED_EDITOR_STOP';

// Opens each target once and uses that handle for the start time check and the kill. An open handle keeps
// Windows from giving the PID to another process, so the process that passes the check is the one that stops.
// The process list reports start times in microseconds and StartTime has 100 ns ticks, so a match allows 10 ticks.
const WINDOWS_STOP_SCRIPT = [
  `$targets = ConvertFrom-Json $env:${STOP_TARGETS_VARIABLE}`,
  '$results = foreach ($target in $targets) {',
  '  $outcome = "stopped"; $detail = $null; $process = $null',
  '  try { $process = [System.Diagnostics.Process]::GetProcessById([int]$target.pid) } catch { $outcome = "gone" }',
  '  if ($process) {',
  '    try {',
  '      $null = $process.Handle',
  '      if (-not $target.created) { $outcome = "unknown" } else {',
  '        $styles = [Globalization.DateTimeStyles]::RoundtripKind',
  '        $expected = [DateTime]::Parse($target.created, [Globalization.CultureInfo]::InvariantCulture, $styles).ToUniversalTime().Ticks',
  '        $actual = $process.StartTime.ToUniversalTime().Ticks',
  '        if ([Math]::Abs($actual - $expected) -ge 10) { $outcome = "changed" } else { $process.Kill() }',
  '      }',
  '    } catch {',
  '      $message = $_.Exception.Message; $exited = $false',
  '      try { $exited = $process.HasExited } catch {}',
  '      if ($exited) { $outcome = "gone" } else { $outcome = "error"; $detail = $message }',
  '    } finally { $process.Dispose() }',
  '  }',
  '  [pscustomobject]@{ pid = [int]$target.pid; outcome = $outcome; detail = $detail }',
  '}',
  'ConvertTo-Json -Compress -InputObject @($results)',
].join('\n');

function note(values, value) {
  if (!values.includes(value)) values.push(value);
}

// Windows: one bounded PowerShell call checks and stops each process through its own handle.
function stopWindowsProcesses(entries, { run, timeoutMs, report }) {
  const targets = entries.map(({ pid, created }) => ({ pid, created }));
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_STOP_SCRIPT], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    env: { ...process.env, [STOP_TARGETS_VARIABLE]: JSON.stringify(targets) },
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`Could not stop processes within ${Math.ceil(timeoutMs / 1000)} s.`);
  }
  if (result.error || result.status !== 0) {
    throw new Error(`Could not stop processes: ${result.error?.message ?? String(result.stderr ?? '').trim()}`);
  }
  for (const { pid, outcome, detail } of JSON.parse(result.stdout)) {
    if (outcome === 'stopped') note(report.stopped, pid);
    else if (outcome === 'error') note(report.errors, `Could not stop PID ${pid}: ${detail}`);
    else note(report.skipped, pid);
  }
}

// Other platforms: each process is listed again just before its own stop.
function stopRechecked(entries, { list, stop, timeoutMs, clock, report }) {
  const deadline = clock.now() + timeoutMs;
  for (const entry of entries) {
    const [current] = list({ pids: [entry.pid], timeoutMs: Math.max(0, deadline - clock.now()) });
    if (!sameProcess(current, entry)) {
      note(report.skipped, entry.pid);
      continue;
    }
    try {
      stop(entry.pid);
      note(report.stopped, entry.pid);
    } catch (error) {
      note(report.errors, `Could not stop PID ${entry.pid}: ${error.message}`);
    }
  }
}

// Stops each entry in order, but only while its PID still belongs to the process in the snapshot.
// Adds each PID to report.stopped or report.skipped, and each failure to report.errors.
export function stopProcesses(
  entries,
  {
    platform = process.platform,
    list = (options) => listProcesses(options),
    stop = stopProcess,
    run = spawnSync,
    timeoutMs = LIST_DEADLINE_MS,
    clock = realClock,
    report = { stopped: [], skipped: [], errors: [] },
  } = {},
) {
  if (entries.length === 0) return report;
  if (!(timeoutMs > 0)) throw new Error('No time was left to stop processes.');
  if (platform === 'win32') stopWindowsProcesses(entries, { run, timeoutMs, report });
  else stopRechecked(entries, { list, stop, timeoutMs, clock, report });
  return report;
}

export function writeManifest(layout, manifest) {
  const temporary = `${layout.manifest}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2));
  fs.renameSync(temporary, layout.manifest);
}

// A manifest names only its own run. Its root must be the directory that holds it, and the profile must sit inside that root.
export function readManifest(location) {
  const resolved = path.resolve(location);
  const file =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? path.join(resolved, MANIFEST_NAME) : resolved;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = path.dirname(file);
  const sameRoot = path.relative(path.resolve(manifest.root ?? ''), root) === '';
  if (!sameRoot || !path.basename(root).startsWith(RUN_PREFIX) || manifest.profile !== runLayout(root).userData) {
    throw new Error(`${file} does not describe an isolated editor run in ${root}.`);
  }
  return manifest;
}

// Stops the run's processes, descendants first, and removes its directory once none remains.
// Lists processes again at the end to confirm that none remains.
export async function cleanupRun(
  manifest,
  {
    list = (options) => listProcesses(options),
    stop = stopProcess,
    run = spawnSync,
    record = (current) => writeManifest(runLayout(current.root), current),
    remove = (root) => fs.rmSync(root, { recursive: true, force: true }),
    exists = fs.existsSync,
    platform = process.platform,
    selfPid = process.pid,
    clock = realClock,
    deadlineMs = CLEANUP_DEADLINE_MS,
  } = {},
) {
  const report = { stopped: [], skipped: [], remaining: [], removed: false, errors: [] };
  const deadline = clock.now() + deadlineMs;
  const left = () => Math.max(0, deadline - clock.now());
  // Each new identity goes to the manifest, so a later cleanup still finds a helper after its ancestors exit.
  const owned = (timeoutMs) => {
    const entries = ownedProcesses(list({ timeoutMs }), manifest.profile, {
      platform,
      selfPid,
      known: manifest.processes,
    });
    if (rememberProcesses(manifest, entries)) {
      try {
        record(manifest);
      } catch (error) {
        report.errors.push(`Could not record the run processes: ${error.message}`);
      }
    }
    return entries;
  };
  let exited = false;
  try {
    await waitFor(
      'the run processes to exit',
      () => {
        const current = owned(left());
        if (current.length === 0) return true;
        // A stopped process frees its PID for reuse, so each process is identified again as part of its own stop.
        stopProcesses(current, { platform, list, stop, run, clock, timeoutMs: left(), report });
        return false;
      },
      { deadlineMs: left(), pollMs: 500, clock },
    );
    exited = true;
  } catch (error) {
    report.errors.push(error.message);
  }
  if (exited) {
    try {
      await waitFor(
        `removal of ${manifest.root}`,
        () => {
          remove(manifest.root);
          return !exists(manifest.root);
        },
        { deadlineMs: left(), pollMs: 500, clock },
      );
      report.removed = true;
    } catch (error) {
      report.errors.push(error.message);
    }
  } else {
    report.errors.push(
      `Kept ${manifest.root}, because cleanup did not confirm that every run process stopped. Run cleanup on it again.`,
    );
  }
  try {
    // The final check gets a short allowance of its own when the stop and removal used the whole deadline.
    report.remaining = owned(Math.max(left(), FINAL_LIST_MS)).map((entry) => entry.pid);
  } catch (error) {
    report.errors.push(error.message);
  }
  report.ok = report.removed && report.remaining.length === 0 && report.errors.length === 0;
  return report;
}

// Interrupted runs: manifests under the parent directory whose driver process no longer runs.
export function abandonedRuns(parent, isAlive) {
  let names;
  try {
    names = fs.readdirSync(parent);
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    try {
      const manifest = readManifest(path.join(parent, name, MANIFEST_NAME));
      if (!isAlive(manifest.driverPid)) runs.push(manifest);
    } catch {
      // A directory without a valid manifest is not a run this tool can prove it owns.
    }
  }
  return runs;
}

// Vscode-webview documents carry the owning extension in their query string.
function webviewExtension(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'vscode-webview:'
      ? (parsed.searchParams.get('extensionId')?.toLowerCase() ?? null)
      : null;
  } catch {
    return null;
  }
}

// The Arc panel content lives in a child frame of the webview document that names the Arc extension.
export function arcContentFrames(frames, extensionId) {
  const id = extensionId.toLowerCase();
  const outer = new Set(frames.filter((frame) => webviewExtension(frame.url()) === id));
  return frames.filter((frame) => outer.has(frame.parentFrame()));
}

export async function arcFrame(page, { extensionId, deadlineMs = 30_000, clock = realClock }) {
  return waitFor(
    `the ${extensionId} panel frame that holds textarea#prompt`,
    async () => {
      for (const frame of arcContentFrames(page.frames(), extensionId)) {
        if (await frame.locator('textarea#prompt').count()) return frame;
      }
      return null;
    },
    { deadlineMs, clock },
  );
}

// Opens Arc through the command palette. The isolated data mode opens the panel at activation instead.
export async function openArcPanel(page) {
  await page.keyboard.press('F1');
  await page.locator('.quick-input-widget input').fill('>Open Arc in Editor', { timeout: 10_000 });
  await page.keyboard.press('Enter');
}

// The prompt box stays hidden until a session or draft is selected. This creates a draft for the named agent.
export async function createDraft(frame, { agent = 'Claude', deadlineMs = 15_000, clock = realClock } = {}) {
  const prompt = frame.locator('textarea#prompt');
  if (await prompt.isVisible()) return prompt;
  // A press before the session list finishes loading can leave the setup closed, so press again until it shows.
  const picker = frame.getByRole('combobox', { name: /^Agent:/ });
  await waitFor(
    'the new session setup to show',
    async () => {
      if (await picker.isVisible()) return true;
      await frame.getByRole('button', { name: /^New session\. Choose a setup/ }).click({ timeout: 2_000 });
      return picker.isVisible();
    },
    { deadlineMs, pollMs: 1_000, clock },
  );
  await picker.click({ timeout: deadlineMs });
  await frame
    .getByRole('option')
    .filter({ hasText: new RegExp(agent, 'i') })
    .first()
    .click({ timeout: deadlineMs });
  await frame.getByRole('button', { name: 'Create draft' }).click({ timeout: deadlineMs });
  await waitFor('the prompt box to show', () => prompt.isVisible(), { deadlineMs, clock });
  return prompt;
}

// Evaluates in the editor's main process. An evaluation soon after launch can fail with
// "Resulting promise was garbage collected", so it retries a bounded number of times.
export async function evaluateInMain(app, callback, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await app.evaluate(callback);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`The editor's main process did not answer: ${lastError?.message ?? 'unknown error'}`);
}

// Replaces show with showInactive and makes app and window focus calls no-ops, on open windows and later ones.
// The hook runs after launch, so a window that VS Code showed before it keeps any foreground it took.
export async function quietWindows(app) {
  return evaluateInMain(app, ({ app: electronApp, BrowserWindow }) => {
    const quiet = (window) => {
      window.show = () => window.showInactive();
      window.focus = () => {};
      window.moveTop = () => {};
    };
    electronApp.focus = () => {};
    electronApp.on('browser-window-created', (_event, window) => quiet(window));
    const open = BrowserWindow.getAllWindows();
    open.forEach(quiet);
    return open.length;
  });
}

function prepareRun(layout) {
  for (const directory of [
    layout.userData,
    layout.extensions,
    layout.arcHome,
    layout.projects,
    layout.codexSessions,
    layout.claudeConfig,
    layout.codexHome,
    layout.workspace,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(path.join(layout.userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(layout.userData, 'User', 'settings.json'), JSON.stringify(PROFILE_SETTINGS, null, 2));
  fs.writeFileSync(layout.state, '{}');
}

export function loadPlaywright(repository) {
  const require = createRequire(path.join(repository, 'extension', 'package.json'));
  return require('playwright-core');
}

// Starts an isolated editor and fills session as it goes. The manifest is on disk before the editor starts,
// so a caller that holds session can clean up after a failure at any later point.
export async function launchIsolatedEditor(
  {
    repository = ownRepository,
    editor,
    workspace,
    scratch = os.tmpdir(),
    liveData = false,
    allowFocus = false,
    deadlineMs = 90_000,
    list = listProcesses,
  } = {},
  session = {},
) {
  const repositoryPath = path.resolve(repository);
  const extensionPath = path.join(repositoryPath, 'extension');
  if (!fs.existsSync(path.join(extensionPath, 'dist', 'extension.js'))) {
    throw new Error(`No Arc build in ${extensionPath}. Run npm --prefix extension run build first.`);
  }
  const executablePath = editorExecutable({ editor });
  const layout = runLayout(path.join(scratch, RUN_PREFIX + randomUUID()));
  fs.mkdirSync(layout.root, { recursive: true });
  const manifest = {
    root: layout.root,
    profile: layout.userData,
    driverPid: process.pid,
    startedAt: new Date().toISOString(),
    executablePath,
    extensionPath,
    liveData,
    launcherPid: null,
    mainPid: null,
    mainCreated: null,
    processes: [],
  };
  writeManifest(layout, manifest);
  Object.assign(session, { layout, manifest, extensionId: extensionIdOf(extensionPath), app: null, page: null, list });
  prepareRun(layout);
  const { _electron } = loadPlaywright(repositoryPath);
  session.app = await _electron.launch({
    executablePath,
    args: editorArguments(layout, { extensionPath, workspace: path.resolve(workspace ?? layout.workspace) }),
    env: childEnvironment(process.env, layout, { liveData }),
    cwd: layout.root,
    timeout: deadlineMs,
  });
  if (!allowFocus) session.windowsBeforeHook = await quietWindows(session.app);
  // On Windows, Playwright starts the editor through cmd.exe, so the spawned process is not the editor's main process.
  manifest.launcherPid = session.app.process().pid ?? null;
  const mainPid = await evaluateInMain(session.app, () => process.pid);
  manifest.mainPid = mainPid;
  recordRunProcesses(session);
  session.page = await session.app.firstWindow({ timeout: deadlineMs });
  await session.page.waitForSelector('.monaco-workbench', { timeout: deadlineMs });
  recordRunProcesses(session);
  return session;
}

// Writes the PID and start time of each run process to the manifest. A helper that passes no profile is found
// through its ancestors, and this record still finds it after they exit.
export function recordRunProcesses(session) {
  const { manifest } = session;
  try {
    const entries = ownedProcesses((session.list ?? listProcesses)({ timeoutMs: LIST_DEADLINE_MS }), manifest.profile, {
      known: manifest.processes,
    });
    manifest.mainCreated ??= entries.find((entry) => entry.pid === manifest.mainPid)?.created ?? null;
    rememberProcesses(manifest, entries);
  } catch {
    // The run goes on without this record. Cleanup still finds each process that passes the profile.
  }
  writeManifest(session.layout, manifest);
}

// Closes the editor through Playwright, then stops whatever the profile still owns and removes the run directory.
export async function closeIsolatedEditor(session, cleanupOptions = {}) {
  const errors = [];
  if (session.app) {
    // A failed record goes to the report, and the editor still closes and the cleanup still runs.
    try {
      recordRunProcesses(session);
    } catch (error) {
      errors.push(`Could not record the run processes: ${error.message}`);
    }
    try {
      await withDeadline('the editor to close', session.app.close(), CLOSE_DEADLINE_MS);
    } catch (error) {
      errors.push(error.message);
    }
  }
  const report = await cleanupRun(session.manifest, cleanupOptions);
  report.errors.unshift(...errors);
  report.ok &&= errors.length === 0;
  return report;
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['run', 'open', 'cleanup'].includes(command)) {
    throw new Error('Choose a command: run, open, or cleanup.');
  }
  const options = { command, timeoutSeconds: DEFAULT_RUN_SECONDS, liveData: false, allowFocus: false };
  const valued = {
    '--screenshot': 'screenshot',
    '--timeout': 'timeout',
    '--repository': 'repository',
    '--editor': 'editor',
    '--workspace': 'workspace',
    '--scratch': 'scratch',
  };
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === '--live-data') options.liveData = true;
    else if (argument === '--allow-focus') options.allowFocus = true;
    else if (valued[argument]) {
      const value = rest[++index];
      if (value === undefined) throw new Error(`${argument} needs a value.`);
      options[valued[argument]] = value;
    } else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    else if (options.target === undefined) options.target = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (options.timeout !== undefined) options.timeoutSeconds = Number(options.timeout);
  delete options.timeout;
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error('--timeout needs a positive number of seconds.');
  }
  if (command === 'open' && options.target !== undefined) throw new Error('open takes no script.');
  return options;
}

// Runs cleanup once, from whichever of completion, error, timeout, or signal reaches it first.
function onceCleanup(session, cleanupOptions) {
  let pending = null;
  return () => (pending ??= closeIsolatedEditor(session, cleanupOptions));
}

function handleSignals(finish) {
  const handlers = Object.entries(SIGNALS).map(([signal, code]) => {
    const handler = () => {
      void finish(`Stopped by ${signal}.`).finally(() => process.exit(code));
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  return () => handlers.forEach(([signal, handler]) => process.off(signal, handler));
}

// The browser lane lock is released and the outcome line is written even when cleanup fails.
export async function runCommand(
  options,
  {
    launch = launchIsolatedEditor,
    acquireLock,
    cleanupOptions = {},
    write = (text) => process.stdout.write(text),
  } = {},
) {
  acquireLock ??= (await import(pathToFileURL(path.join(ownRepository, 'extension', 'test', 'browserlock.mjs')).href))
    .acquireBrowserLock;
  const result = { ok: false, run: null, mainPid: null, value: null, screenshot: null, errors: [], cleanup: null };
  let lock = null;
  const session = { manifest: null, app: null };
  const cleanup = onceCleanup(session, cleanupOptions);
  let finished = null;
  const finish = (reason) =>
    (finished ??= (async () => {
      if (reason) result.errors.push(reason);
      try {
        if (session.manifest) result.cleanup = await cleanup();
      } catch (error) {
        result.errors.push(String(error?.message ?? error));
      } finally {
        lock?.release();
      }
      result.ok = result.errors.length === 0 && (result.cleanup?.ok ?? true);
      write(`${JSON.stringify(result)}\n`);
    })());
  const detach = handleSignals(finish);
  const work = async () => {
    await launch({ ...options, deadlineMs: options.timeoutSeconds * 1000 }, session);
    result.run = session.layout.root;
    if (options.liveData) await openArcPanel(session.page);
    const arc = await arcFrame(session.page, { extensionId: session.extensionId });
    if (options.target) {
      const script = await import(pathToFileURL(path.resolve(options.target)).href);
      if (typeof script.default !== 'function') throw new Error(`${options.target} has no default export function.`);
      result.value =
        (await script.default({
          app: session.app,
          page: session.page,
          arc,
          createDraft: (draftOptions) => createDraft(arc, draftOptions),
          run: session.layout,
        })) ?? null;
    }
    if (options.screenshot) {
      result.screenshot = path.resolve(options.screenshot);
      await session.page.screenshot({ path: result.screenshot });
    }
  };
  try {
    lock = await acquireLock({ deadlineMs: LOCK_DEADLINE_MS });
    const running = work();
    // After a timeout, cleanup closes the editor and the abandoned work rejects. Its error is already reported.
    running.catch(() => {});
    await withDeadline('the run to finish', running, options.timeoutSeconds * 1000);
  } catch (error) {
    result.errors.push(String(error?.message ?? error));
    // A screenshot of the failure shows what the driver saw.
    if (options.screenshot && session.page) {
      result.screenshot = path.resolve(options.screenshot);
      await withDeadline('the failure screenshot', session.page.screenshot({ path: result.screenshot }), 10_000).catch(
        () => (result.screenshot = null),
      );
    }
  } finally {
    detach();
    result.mainPid = session.manifest?.mainPid ?? null;
    result.windowsBeforeFocusHook = session.windowsBeforeHook ?? null;
    await finish(null);
  }
  return result.ok ? 0 : 1;
}

// Cleans up after the window closes or the launch fails, and writes the outcome as one JSON line either way.
export async function openCommand(
  options,
  { launch = launchIsolatedEditor, cleanupOptions = {}, write = (text) => process.stdout.write(text) } = {},
) {
  const session = { manifest: null, app: null };
  const result = { ok: false, run: null, errors: [], cleanup: null };
  let finished = null;
  const finish = (reason) =>
    (finished ??= (async () => {
      if (reason) result.errors.push(reason);
      result.run = session.manifest?.root ?? null;
      try {
        if (session.manifest) result.cleanup = await closeIsolatedEditor(session, cleanupOptions);
      } catch (error) {
        result.errors.push(String(error?.message ?? error));
      }
      result.ok = result.errors.length === 0 && (result.cleanup?.ok ?? true);
      write(`${JSON.stringify(result)}\n`);
    })());
  const detach = handleSignals(finish);
  try {
    await launch({ ...options, allowFocus: true, deadlineMs: 90_000 }, session);
    write(`Isolated editor run directory: ${session.layout.root}\n`);
    if (options.liveData) await openArcPanel(session.page);
    await new Promise((resolve) => session.app.once('close', resolve));
  } catch (error) {
    result.errors.push(String(error?.message ?? error));
  } finally {
    detach();
    await finish(null);
  }
  return result.ok ? 0 : 1;
}

// A named run directory that is already gone holds nothing to clean up, so it adds no run to the report.
export async function cleanupCommand(options, { write = (text) => process.stdout.write(text) } = {}) {
  let manifests;
  if (options.target !== undefined) {
    manifests = fs.existsSync(path.resolve(options.target)) ? [readManifest(options.target)] : [];
  } else {
    const { processExists } = await import(
      pathToFileURL(path.join(ownRepository, 'extension', 'test', 'browserchannels.mjs')).href
    );
    manifests = abandonedRuns(path.resolve(options.scratch ?? os.tmpdir()), processExists);
  }
  const reports = [];
  for (const manifest of manifests) reports.push({ run: manifest.root, ...(await cleanupRun(manifest)) });
  write(`${JSON.stringify(reports)}\n`);
  return reports.every((report) => report.ok) ? 0 : 1;
}

export async function main(argv) {
  const options = parseArguments(argv);
  if (options.command === 'run') return runCommand(options);
  if (options.command === 'open') return openCommand(options);
  return cleanupCommand(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    },
  );
}
