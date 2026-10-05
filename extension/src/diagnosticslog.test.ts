// extension/src/diagnosticslog.test.ts
import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { tempDir } from './temproot.ts';
import {
  createDiagnosticsLog,
  readStartupArtifact,
  diagnosticsInstanceIdentity,
  diagnosticsLogFileName,
  pruneDiagnosticsLogs,
  silentDiagnosticsLog,
  StartupThresholdWatch,
  StartupHistory,
  STARTUP_THRESHOLDS_MS,
} from './diagnosticslog.ts';

const STARTED_AT = Date.UTC(2026, 8, 19, 7, 4, 5);

test('startup rejects artifact identity from a different bundle', async () => {
  const root = tempDir('startup-artifact');
  const bundle = path.join(root, 'extension.js');
  fs.writeFileSync(bundle, 'original');
  const identity = { sourceCommit: 'original', extensionSha256: createHash('sha256').update('original').digest('hex') };
  fs.writeFileSync(path.join(root, 'build-identity.json'), JSON.stringify(identity));
  assert.deepEqual(await readStartupArtifact(root), identity);
  fs.writeFileSync(bundle, 'rebuilt');
  assert.deepEqual(await readStartupArtifact(root), { unavailable: true });
});

test('measurement diagnostics carry the launched run identity', () => {
  const directory = tempDir('startup-measurement-log');
  const log = createDiagnosticsLog({
    enabled: true,
    directory,
    workspace: 'frozen',
    pid: 42,
    startedAt: STARTED_AT,
    measurementRun: 'owned',
  });
  log.log('startup', { milestone: 'shellReady' });
  assert.equal(readLines(log.file()!)[0].measurementRun, 'owned');
});

test('startup history records a pending deadline without waiting for selected text', async () => {
  const directory = tempDir('startup-history');
  vi.useFakeTimers();
  const history = new StartupHistory(directory, () => ({ artifact: 'fixture', cache: { reason: 'missing' } }));
  try {
    history.stage('panelOpened');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      const lines = fs.readdirSync(directory).flatMap((file) => readLines(path.join(directory, file)));
      assert.ok(lines.some((line) => line.outcome === 'pending-deadline'));
      assert.equal(
        lines.some((line) => line.outcome === 'selected-text'),
        false,
      );
    });
    history.stage('firstCard');
    history.stage('completeRender');
    await vi.waitFor(() =>
      assert.ok(
        fs
          .readdirSync(directory)
          .flatMap((file) => readLines(path.join(directory, file)))
          .some((line) => line.outcome === 'background-complete'),
      ),
    );
  } finally {
    history.dispose();
    vi.useRealTimers();
  }
});

test('empty startup completion excludes a first card and samples from later activity', async () => {
  const directory = tempDir('startup-empty-history');
  vi.useFakeTimers();
  let clock = 0;
  const history = new StartupHistory(
    directory,
    () => ({}),
    () => clock,
    0,
  );
  const sample = vi.spyOn(process, 'memoryUsage');
  try {
    history.stage('panelOpened');
    clock = 20;
    history.stage('completeRender');
    await vi.waitFor(() => {
      const lines = fs.readdirSync(directory).flatMap((file) => readLines(path.join(directory, file)));
      assert.ok(lines.some((line) => line.outcome === 'background-complete'));
    });
    const before = fs.readdirSync(directory).map((file) => fs.readFileSync(path.join(directory, file), 'utf8'));
    const sampled = sample.mock.calls.length;
    clock += 3_600_000;
    await vi.advanceTimersByTimeAsync(3_600_000);
    history.stage('firstCard');
    history.stage('railReady');
    history.dispose();
    await vi.waitFor(() => {
      assert.deepEqual(
        fs.readdirSync(directory).map((file) => fs.readFileSync(path.join(directory, file), 'utf8')),
        before,
      );
      assert.equal(sample.mock.calls.length, sampled);
    });
    const completed = before
      .flatMap((text) =>
        text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      )
      .at(-1);
    assert.equal(completed.selectedTextElapsedMs, null);
    assert.equal(completed.stages.firstCard, undefined);
    assert.equal(completed.stages.railReady, undefined);
  } finally {
    history.dispose();
    sample.mockRestore();
    vi.useRealTimers();
  }
});

function readLines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Disabled logging must not read the clock or create its directory.
// The throwing clock catches timestamp reads while logging is disabled.
// The directory assertion catches filesystem creation.
test('a log nobody turned on formats nothing and touches no disk', () => {
  const directory = path.join(tempDir('diagnostics-off'), 'logs');
  const log = createDiagnosticsLog({
    enabled: false,
    directory,
    workspace: 'agent-diff-review',
    pid: 4242,
    startedAt: STARTED_AT,
    now: () => {
      throw new Error('the clock was read while the log was off');
    },
  });
  log.log('refresh', { reason: 'watcher', durationMs: 12 });
  log.log('message', { kind: 'render', bytes: 100 });
  assert.equal(log.file(), null, 'a log that is off named a file');
  assert.equal(fs.existsSync(directory), false, 'a log that is off made its directory');
  // Callers check enabled() before constructing diagnostic data.
  assert.equal(log.enabled(), false, 'a log that is off told a caller to build records');
  const silent = silentDiagnosticsLog();
  assert.equal(silent.enabled(), false);
  silent.log('refresh', {});
  silent.warn('startupThreshold', {});
  assert.equal(silent.file(), null);
});

test('every line carries the identity a reader merges two files by', () => {
  const directory = tempDir('diagnostics-line');
  let at = Date.UTC(2026, 8, 19, 7, 4, 6);
  const log = createDiagnosticsLog({
    enabled: true,
    directory,
    workspace: 'agent-diff-review',
    pid: 4242,
    startedAt: STARTED_AT,
    now: () => at,
  });
  log.log('startup', { milestone: 'firstCard', elapsedMs: 89_000 });
  at += 1000;
  log.log('refresh', { reason: 'watcher', durationMs: 12 });

  const file = log.file();
  assert.equal(file, path.join(directory, 'arc-20260919-070405-4242.jsonl'));
  assert.equal(diagnosticsLogFileName(STARTED_AT, 4242), 'arc-20260919-070405-4242.jsonl');
  const lines = readLines(file as string);
  assert.deepEqual(lines[0], {
    at: '2026-09-19T07:04:06.000Z',
    pid: 4242,
    instance: diagnosticsInstanceIdentity(STARTED_AT, 4242),
    workspace: 'agent-diff-review',
    event: 'startup',
    milestone: 'firstCard',
    elapsedMs: 89_000,
  });
  assert.equal(lines[1].at, '2026-09-19T07:04:07.000Z');
  assert.equal(lines[1].event, 'refresh');
});

// Each host process writes a separate file with its own identity.
// Separate files prevent uncoordinated appends to a shared log.
test('two hosts write two files under two identities', () => {
  const directory = tempDir('diagnostics-two');
  const one = createDiagnosticsLog({
    enabled: true,
    directory,
    workspace: 'one',
    pid: 11,
    startedAt: STARTED_AT,
    now: () => STARTED_AT,
  });
  const two = createDiagnosticsLog({
    enabled: true,
    directory,
    workspace: 'two',
    pid: 12,
    startedAt: STARTED_AT + 4000,
    now: () => STARTED_AT,
  });
  one.log('startup', { milestone: 'shellReady' });
  two.log('startup', { milestone: 'shellReady' });
  assert.notEqual(one.file(), two.file(), 'two hosts share one file');
  assert.notEqual(
    readLines(one.file() as string)[0].instance,
    readLines(two.file() as string)[0].instance,
    'two hosts stamp their lines with one identity',
  );
  assert.deepEqual(fs.readdirSync(directory).sort(), ['arc-20260919-070405-11.jsonl', 'arc-20260919-070409-12.jsonl']);
});

test('the writer stops at its cap and records that it stopped', () => {
  const directory = tempDir('diagnostics-cap');
  const log = createDiagnosticsLog({
    enabled: true,
    directory,
    workspace: 'agent-diff-review',
    pid: 7,
    startedAt: STARTED_AT,
    now: () => STARTED_AT,
    maximumBytes: 600,
  });
  for (let index = 0; index < 50; index++) {
    log.log('refresh', { index });
  }
  const lines = readLines(log.file() as string);
  assert.ok(lines.length < 50, 'the writer wrote past its cap');
  assert.equal(lines[lines.length - 1].event, 'logFull', 'a capped log does not say it is full');
  assert.equal(lines[lines.length - 1].maximumBytes, 600);
  const size = fs.statSync(log.file() as string).size;
  log.log('refresh', { index: 'after the cap' });
  assert.equal(fs.statSync(log.file() as string).size, size, 'the writer carried on past its cap');
});

// The prune deletes files. It matches the one name shape this module writes, inside the one
// directory it owns, and it never recurses and never removes a directory.
test('the prune keeps the newest files and leaves every other name alone', () => {
  const directory = tempDir('diagnostics-prune');
  const owned: string[] = [];
  for (let index = 0; index < 25; index++) {
    const name = diagnosticsLogFileName(STARTED_AT + index * 1000, 9);
    owned.push(name);
    fs.writeFileSync(path.join(directory, name), '{}\n', 'utf8');
  }
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'keep me', 'utf8');
  fs.writeFileSync(path.join(directory, 'arc-performance-2026.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(directory, 'arc-log.jsonl'), '{}', 'utf8');
  fs.mkdirSync(path.join(directory, 'arc-20260101-000000-1.jsonl'));

  const removed = pruneDiagnosticsLogs(directory, 20);

  assert.deepEqual(removed.sort(), owned.slice(0, 5).sort(), 'the prune removed other files than the oldest five');
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    [
      'arc-20260101-000000-1.jsonl',
      'arc-log.jsonl',
      'arc-performance-2026.json',
      'notes.txt',
      ...owned.slice(5),
    ].sort(),
    'the prune took a file it does not own',
  );
  assert.equal(fs.readFileSync(path.join(directory, 'notes.txt'), 'utf8'), 'keep me');
  assert.ok(fs.statSync(path.join(directory, 'arc-20260101-000000-1.jsonl')).isDirectory());
  assert.deepEqual(
    pruneDiagnosticsLogs(path.join(directory, 'nothing-here'), 20),
    [],
    'the prune reported work in a directory that does not exist',
  );
});

test('a new log prunes the directory it owns before it writes', () => {
  const directory = tempDir('diagnostics-prune-open');
  for (let index = 0; index < 4; index++) {
    fs.writeFileSync(path.join(directory, diagnosticsLogFileName(STARTED_AT - (index + 1) * 1000, 9)), '{}\n', 'utf8');
  }
  const log = createDiagnosticsLog({
    enabled: true,
    directory,
    workspace: 'w',
    pid: 5,
    startedAt: STARTED_AT,
    now: () => STARTED_AT,
    keptFiles: 2,
  });
  log.log('startup', {});
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    'arc-20260919-070403-9.jsonl',
    'arc-20260919-070404-9.jsonl',
    'arc-20260919-070405-5.jsonl',
  ]);
});

// Startup threshold warnings remain available when detailed logging is disabled.
// Each milestone reports its threshold breach once.
test('a slow milestone is reported once, whatever the setting says', () => {
  const directory = tempDir('diagnostics-threshold');
  const watch = new StartupThresholdWatch();
  assert.equal(watch.check('firstCard', 12_000), null, 'a fast start was reported');
  assert.equal(watch.check('railReady', 120_000), null, 'a milestone with no threshold was reported');
  const breach = watch.check('firstCard', 89_200);
  assert.deepEqual(breach, {
    milestone: 'firstCard',
    elapsedMs: 89_200,
    thresholdMs: STARTUP_THRESHOLDS_MS.firstCard,
    notice: 'Arc took 89.2 seconds to draw its first card. The expected time is under 30 seconds.',
  });
  assert.equal(watch.check('firstCard', 95_000), null, 'the same milestone was reported twice');

  const log = createDiagnosticsLog({
    enabled: false,
    directory,
    workspace: 'w',
    pid: 8,
    startedAt: STARTED_AT,
    now: () => STARTED_AT,
  });
  log.warn('startupThreshold', { milestone: 'firstCard', elapsedMs: 89_200 });
  assert.equal(readLines(log.file() as string).length, 1, 'a threshold line waits for the setting');
  assert.equal(readLines(log.file() as string)[0].event, 'startupThreshold');
});

// Circular references and BigInt values cannot be serialized as JSON.
// Invalid diagnostic data must not throw into the extension host.
test('a record with no JSON form loses its line and nothing else', () => {
  const directory = tempDir('diagnostics-unserializable');
  const log = createDiagnosticsLog({
    enabled: true,
    directory,
    workspace: 'w',
    pid: 3,
    startedAt: STARTED_AT,
    now: () => STARTED_AT,
  });
  assert.equal(log.enabled(), true);
  log.log('refresh', { reason: 'watcher', durationMs: 12 });
  const circular: { self?: unknown } = {};
  circular.self = circular;

  log.log('message', { kind: 'render', shape: circular });
  log.warn('startupThreshold', { milestone: 'firstCard', elapsedMs: BigInt(89_000) });

  log.log('refresh', { reason: 'poll', durationMs: 3 });
  const lines = readLines(log.file() as string);
  assert.deepEqual(
    lines.map((line) => line.event),
    ['refresh', 'refresh'],
    'a record with no JSON form reached the file or stopped the log',
  );
  assert.equal(lines[1].reason, 'poll');
});
