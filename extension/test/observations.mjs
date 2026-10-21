// Plain Node keeps test launchers and import-only consumers independent of a TypeScript loader.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const TEMP_VARIABLES = ['ARC_TEST_MACHINE_TEMP', 'TEMP', 'TMP', 'TMPDIR'];
const MAX_EVENTS = 1024;
const MAX_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const identityCache = new Map();

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function digest(file) {
  const bytes = read(file);
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

function repositoryIdentity(cwd) {
  let root = resolve(cwd);
  while (true) {
    let git = join(root, '.git');
    const pointer = read(git);
    if (pointer?.startsWith('gitdir: ')) git = resolve(root, pointer.slice(8).trim());
    const head = read(join(git, 'HEAD'))?.trim();
    if (head) {
      const common = read(join(git, 'commondir'))?.trim();
      const shared = common ? resolve(git, common) : git;
      const ref = head.startsWith('ref: ') ? head.slice(5) : null;
      const packed =
        ref &&
        read(join(shared, 'packed-refs'))
          ?.split('\n')
          .find((line) => line.endsWith(` ${ref}`));
      const commit = ref ? ((read(join(git, ref)) ?? read(join(shared, ref)))?.trim() ?? packed?.split(' ')[0]) : head;
      return { root, commit: /^[a-f0-9]{40,64}$/.test(commit ?? '') ? commit : null };
    }
    const parent = dirname(root);
    if (parent === root) return { root: resolve(cwd), commit: null };
    root = parent;
  }
}

function identities(cwd) {
  const repository = repositoryIdentity(cwd);
  const key = `${repository.root}:${repository.commit}`;
  if (!identityCache.has(key)) {
    const hashes = (files) => Object.fromEntries(files.map((file) => [file, digest(join(repository.root, file))]));
    const browserRoot = join(repository.root, 'extension/node_modules/playwright-core');
    let browser = null;
    try {
      browser = {
        playwright: JSON.parse(read(join(browserRoot, 'package.json'))).version,
        registry: JSON.parse(read(join(browserRoot, 'browsers.json'))).browsers,
      };
    } catch {
      // Missing browser metadata remains unavailable.
    }
    identityCache.set(key, {
      ...repository,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      dependencies: hashes([
        'package-lock.json',
        'extension/package-lock.json',
        'cli/package-lock.json',
        'node_modules/.package-lock.json',
        'extension/node_modules/.package-lock.json',
        'cli/node_modules/.package-lock.json',
      ]),
      configuration: hashes([
        'package.json',
        'extension/package.json',
        'cli/package.json',
        'vitest.config.mts',
        'extension/vitest.config.ts',
        'cli/vitest.config.ts',
        'scripts/test-subprocess.mjs',
        'extension/test.mjs',
      ]),
      browser,
    });
  }
  return identityCache.get(key);
}

export function coordinationEnvironment(env = process.env, temporary = tmpdir()) {
  return { temporary, variables: Object.fromEntries(TEMP_VARIABLES.map((name) => [name, env[name] ?? null])) };
}

// Each process writes its own file. Parent identities connect runs without adding overlapping durations.
export function createTestObservation({
  lane,
  cwd = process.cwd(),
  command = process.argv,
  workerCap = null,
  capacity = null,
  env = process.env,
  outputDirectory = env.ARC_TEST_OBSERVATIONS_DIR ||
    join(env.ARC_TEST_MACHINE_TEMP || tmpdir(), 'arc-test-observations'),
  runId = randomUUID(),
  parentRunId = env.ARC_TEST_OBSERVATION_RUN_ID || null,
  monotonicNow = () => performance.now(),
  wallNow = () => new Date().toISOString(),
  identity = identities(cwd),
  append,
  announce = (line) => console.log(line),
  reportError = (line) => console.error(line),
  processEmitter = process,
  requiredPhases = ['queue', 'build', 'execution', 'cleanup'],
} = {}) {
  const started = monotonicNow();
  const path = join(outputDirectory, `${process.pid}-${runId}.jsonl`);
  const phases = new Map();
  let active = null;
  let terminal = false;
  let invalid = false;
  let recordingFailed = false;
  let limited = false;
  let bytes = 0;
  let count = 0;
  let cancellationSignal = null;
  const savedCommand = Buffer.byteLength(JSON.stringify(command)) <= 4096 ? command : null;
  let writer = append;
  try {
    if (!writer) {
      mkdirSync(outputDirectory, { recursive: true });
      // Preserve the artifact location when a nested Vitest run redirects its temporary directory.
      outputDirectory = realpathSync(outputDirectory);
      writer = (line) => appendFileSync(path, line);
    }
  } catch (error) {
    recordingFailed = true;
    reportError(`Test timing file unavailable: ${path}: ${error.message}`);
  }
  const write = (phase, event, detail = {}, final = false) => {
    if (recordingFailed) return;
    try {
      const base = {
        schemaVersion: 1,
        runId,
        parentRunId,
        commit: identity.commit ?? null,
        cwd,
        lane,
        phase,
        event,
        elapsedMs: Math.max(0, monotonicNow() - started),
        pid: process.pid,
        command: savedCommand,
        workerCap,
        capacity,
        exitCode: null,
      };
      let line = `${JSON.stringify({ ...base, ...detail })}\n`;
      let length = Buffer.byteLength(line);
      if (final && length > MAX_LINE_BYTES) {
        limited = true;
        line = `${JSON.stringify({ ...base, exitCode: detail.exitCode, signal: detail.signal, outcome: detail.outcome, complete: false, recordingComplete: false, intervals: null, unobserved: ['Terminal detail exceeded the recording byte limit.'], wholeCommandWallMs: detail.wholeCommandWallMs })}\n`;
        length = Buffer.byteLength(line);
      }
      if (
        !final &&
        (count >= MAX_EVENTS - 1 || bytes + length > MAX_BYTES - MAX_LINE_BYTES || length > MAX_LINE_BYTES)
      ) {
        limited = true;
        return;
      }
      writer(line);
      count++;
      bytes += length;
    } catch (error) {
      recordingFailed = true;
      reportError(`Test timing file incomplete: ${path}: ${error.message}`);
    }
  };
  const recorder = {
    runId,
    path,
    childEnvironment(parent = env) {
      return { ...parent, ARC_TEST_OBSERVATIONS_DIR: outputDirectory, ARC_TEST_OBSERVATION_RUN_ID: runId };
    },
    event(phase, event, detail) {
      if (detail?.signal) cancellationSignal = detail.signal;
      if (!terminal) write(phase, event, detail);
    },
    begin(phase, detail) {
      if (terminal) return;
      if (active || phases.has(phase)) {
        invalid = true;
        write(phase, 'invalid-stage', { activePhase: active?.phase ?? null });
        return;
      }
      active = { phase, at: monotonicNow() };
      write(phase, 'start', detail);
    },
    end(phase, detail) {
      if (terminal) return;
      if (detail?.signal) cancellationSignal = detail.signal;
      if (active?.phase !== phase) {
        invalid = true;
        write(phase, 'invalid-stage', { activePhase: active?.phase ?? null });
        return;
      }
      const durationMs = Math.max(0, monotonicNow() - active.at);
      phases.set(phase, { durationMs });
      active = null;
      write(phase, 'end', { durationMs, ...detail });
    },
    unavailable(phase, reason) {
      if (terminal) return;
      phases.set(phase, { durationMs: null, reason });
      write(phase, 'unavailable', { reason });
    },
    incomplete(phase, reason) {
      if (terminal) return;
      if (active?.phase === phase) active = null;
      invalid = true;
      phases.set(phase, { durationMs: null, reason });
      write(phase, 'incomplete', { reason });
    },
    finish({ exitCode = null, signal = null, outcome = 'incomplete', reason = null, ...detail } = {}) {
      if (terminal) return;
      signal ??= cancellationSignal;
      if (signal && outcome !== 'incomplete') outcome = 'cancelled';
      terminal = true;
      processEmitter.off('exit', onExit);
      const unobserved = requiredPhases.filter((phase) => !phases.has(phase));
      if (active) unobserved.push(`${active.phase} ending`);
      write(
        'run',
        'result',
        {
          exitCode,
          signal,
          outcome,
          reason,
          complete: !invalid && !limited && unobserved.length === 0 && outcome !== 'incomplete',
          recordingComplete: !limited && savedCommand !== null,
          intervals: Object.fromEntries(phases),
          unobserved,
          wholeCommandWallMs: Math.max(0, monotonicNow() - started),
          descendants: 'unobserved',
          ...detail,
        },
        true,
      );
      if (limited) reportError(`Test timing file incomplete: ${path}: event or byte limit reached.`);
      announce(`Test timings: ${path}${recordingFailed ? ' (unavailable)' : ''}`);
    },
  };
  function onExit(exitCode) {
    recorder.finish({
      exitCode,
      signal: cancellationSignal,
      outcome: 'incomplete',
      reason: 'Writer exited before the request settled.',
    });
  }
  processEmitter.once('exit', onExit);
  write('run', 'identity', {
    observedAt: wallNow(),
    identity,
    coordination: coordinationEnvironment(env),
    configurationEnvironment: { VITEST_MAX_WORKERS: env.VITEST_MAX_WORKERS ?? null },
    commandUnavailable: savedCommand === null ? 'Command exceeds 4096 bytes.' : null,
  });
  return recorder;
}
