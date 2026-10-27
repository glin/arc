// extension/src/diagnosticslog.test.ts
import { test, vi } from 'vitest';

vi.mock('node:fs', { spy: true });
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
  HostHealth,
  HOST_HEALTH_EVENT_BYTES,
  HOST_HEALTH_KEPT_RUNS,
  HOST_HEALTH_IN_FLIGHT,
  HOST_HEALTH_SLOW_MS,
} from './diagnosticslog.ts';

test('health evidence precedes an abrupt stop and a replacement preserves unknown termination', () => {
  const directory = tempDir('host-health-restart');
  vi.useFakeTimers();
  const options = { directory, workspace: 'private-path', build: { sourceCommit: null, dirty: true, builtAt: 1 } };
  const first = new HostHealth(options);
  const work = first.begin('retention');
  first.sample();
  const prior = fs.readFileSync(first.file, 'utf8');
  assert.equal(JSON.parse(prior).termination, 'unknown');
  assert.equal(JSON.parse(prior).active[0].request, work);
  const second = new HostHealth(options);
  try {
    assert.notEqual(first.provider, second.provider);
    second.dispose();
    assert.equal(JSON.parse(fs.readFileSync(second.file, 'utf8')).termination, 'clean');
    assert.equal(fs.readFileSync(first.file, 'utf8'), prior);
    assert.ok(readLines(first.file.replace('.json', '.jsonl')).some((line) => line.phase === 'retention'));
  } finally {
    first.dispose();
    second.dispose();
    vi.useRealTimers();
  }
});

test('health caps samples, work, event rate, segment bytes and retained activations', () => {
  const directory = tempDir('host-health-bounds');
  vi.useFakeTimers();
  let clock = 0;
  const options = {
    directory,
    workspace: 'test',
    build: { sourceCommit: null, dirty: null, builtAt: 1 },
    now: () => clock,
  };
  const health = new HostHealth(options);
  try {
    for (let i = 0; i < HOST_HEALTH_IN_FLIGHT; i++) assert.ok(health.begin('send'));
    assert.equal(health.begin('send'), 0);
    for (let i = 0; i < 100; i++) health.event('parseRejected');
    assert.ok(readLines(health.file.replace('.json', '.jsonl')).length <= 8);
    for (let i = 0; i < 1200; i++) {
      clock += 1000;
      health.event('attached', 1);
    }
    for (let i = 0; i < 20; i++) {
      clock += 10_000;
      health.sample();
    }
    const record = JSON.parse(fs.readFileSync(health.file, 'utf8'));
    assert.equal(record.samples.length, 12);
    assert.equal(record.samples.at(-1).lagMs, 5000);
    assert.equal(record.active.length, HOST_HEALTH_IN_FLIGHT);
    assert.ok(record.suppressed > 0);
    assert.equal(record.dropped, 1);
    const segments = fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl'));
    assert.equal(segments.length, 2);
    for (const segment of segments)
      assert.ok(fs.statSync(path.join(directory, segment)).size <= HOST_HEALTH_EVENT_BYTES);
    health.dispose();
    for (let i = 0; i < HOST_HEALTH_KEPT_RUNS + 2; i++) new HostHealth(options).dispose();
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.json')).length, HOST_HEALTH_KEPT_RUNS);
    assert.ok(fs.readdirSync(directory).length <= HOST_HEALTH_KEPT_RUNS * 3);
  } finally {
    health.dispose();
    vi.useRealTimers();
  }
});

test('health recovers after transient writes and observation exceptions on later pulses', async () => {
  vi.useFakeTimers();
  const directory = tempDir('host-health-retry');
  let clock = 0;
  let observationFails = false;
  let pulseFails = false;
  const health = new HostHealth({
    directory,
    workspace: 'test',
    build: { sourceCommit: null, dirty: null, builtAt: 1 },
    now: () => clock,
    counts: () => {
      if (observationFails) throw new Error('secret observation');
      return { attached: 1, ready: 1, retainedTabs: 1, panels: [] };
    },
    pulse: () => {
      if (pulseFails) throw new Error('secret pulse');
    },
  });
  const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('busy');
  });
  try {
    clock = 5000;
    vi.advanceTimersByTime(5000);
    assert.equal(health.status().failed, true);
    rename.mockImplementation(original);
    observationFails = true;
    pulseFails = true;
    clock = 10000;
    assert.doesNotThrow(() => vi.advanceTimersByTime(5000));
    assert.equal(health.status().failed, false);
    let record = JSON.parse(fs.readFileSync(health.file, 'utf8'));
    assert.equal(record.elapsedMs, 10000);
    assert.equal(record.panels.attached, null);
    assert.equal(record.ioFailures, 1);
    observationFails = false;
    pulseFails = false;
    clock = 15000;
    vi.advanceTimersByTime(5000);
    record = JSON.parse(fs.readFileSync(health.file, 'utf8'));
    assert.equal(record.panels.attached, 1);
    assert.equal(record.observationFailures, 2);
    assert.equal(fs.readFileSync(health.file, 'utf8').includes('secret'), false);
    health.dispose();
    assert.equal(JSON.parse(fs.readFileSync(health.file, 'utf8')).termination, 'clean');
  } finally {
    rename.mockRestore();
    health.dispose();
    vi.useRealTimers();
  }
});

test('health survives shared retention entries disappearing before stat or deletion', async () => {
  for (const step of ['stat', 'remove']) {
    const directory = tempDir('host-health-prune-race');
    for (let i = 0; i < HOST_HEALTH_KEPT_RUNS + 1; i++) {
      const id = i.toString(16).padStart(8, '0') + '-0000-0000-0000-000000000000';
      fs.writeFileSync(path.join(directory, `health-${id}.json`), '{}');
    }
    const operation = step === 'stat' ? 'statSync' : 'rmSync';
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs'))[operation];
    let disappeared = false;
    const race = vi.spyOn(fs, operation).mockImplementation((...args: any[]) => {
      if (!disappeared && String(args[0]).includes('health-')) {
        disappeared = true;
        fs.unlinkSync(String(args[0]));
        if (step === 'stat') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }
      return (original as any)(...args);
    });
    let health: HostHealth | undefined;
    try {
      health = new HostHealth({ directory, workspace: 'test', build: { sourceCommit: null, dirty: null, builtAt: 1 } });
      assert.equal(disappeared, true);
      assert.equal(health.status().failed, false);
      assert.equal(JSON.parse(fs.readFileSync(health.file, 'utf8')).logging, 'active');
      assert.equal(readLines(health.file.replace('.json', '.jsonl'))[0].event, 'activated');
    } finally {
      race.mockRestore();
      health?.dispose();
    }
  }

  const directory = tempDir('host-health-pruned-writer');
  let clock = 0;
  const health = new HostHealth({
    directory,
    workspace: 'test',
    build: { sourceCommit: null, dirty: null, builtAt: 1 },
    now: () => clock,
    wall: () => 1000,
  });
  const events = health.file.replace('.json', '.jsonl');
  try {
    let remaining = HOST_HEALTH_EVENT_BYTES;
    for (let i = 0; i < 2000 && remaining >= 80; i++) {
      clock += 1000;
      health.event('attached');
      remaining = HOST_HEALTH_EVENT_BYTES - fs.statSync(events).size;
    }
    assert.ok(remaining > 0 && remaining < 80);
    fs.unlinkSync(events);
    clock += 1000;
    health.event('attached');
    assert.equal(readLines(events).at(-1)?.event, 'attached');
    assert.equal(health.status().failed, false);
    health.sample();
    assert.equal(health.status().failed, false);
    clock += 1000;
    health.event('ready');
    assert.deepEqual(
      readLines(events).map((line) => line.event),
      ['attached', 'ready'],
    );
    assert.ok(fs.statSync(events).size <= HOST_HEALTH_EVENT_BYTES);
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).appendFileSync;
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
      throw new Error('busy');
    });
    try {
      clock += 1000;
      health.event('attached');
      assert.equal(health.status().failed, true);
      health.sample();
      assert.equal(health.status().failed, true);
      assert.equal(JSON.parse(fs.readFileSync(health.file, 'utf8')).logging, 'failed');
      append.mockImplementation(original);
      clock += 1000;
      health.event('ready');
      assert.equal(health.status().failed, false);
      assert.equal(readLines(events).at(-1)?.event, 'ready');
    } finally {
      append.mockRestore();
    }
  } finally {
    health.dispose();
  }
});

test('health retains bounded settled outcomes when unrelated events exhaust admission', () => {
  const directory = tempDir('host-health-outcomes');
  let clock = 0;
  const health = new HostHealth({
    directory,
    workspace: 'test',
    build: { sourceCommit: null, dirty: null, builtAt: 1 },
    now: () => clock,
  });
  try {
    for (let i = 0; i < 100; i++) health.event('parseRejected');
    clock = 500;
    const send = health.begin('send', 1);
    health.settle(send, 'failed');
    const first = JSON.parse(fs.readFileSync(health.file, 'utf8'));
    assert.equal(first.outcomes.at(-1).request, send);
    assert.equal(first.outcomes.at(-1).outcome, 'failed');
    assert.equal(first.samples.at(-1).lagMs, null);
    for (let i = 0; i < 100; i++) {
      const request = health.begin('new', 1);
      health.settle(request, 'rejected');
    }
    clock = 15000;
    health.sample();
    const record = JSON.parse(fs.readFileSync(health.file, 'utf8'));
    assert.equal(record.outcomes.length, 16);
    assert.equal(record.samples.at(-1).lagMs, 10000);
    assert.equal(record.outcomes.at(-1).outcome, 'rejected');
    assert.equal(record.outcomeCounts.send.failed, 1);
    assert.equal(record.outcomeCounts.new.rejected, 100);
    assert.equal(record.active.length, 0);
    assert.ok(fs.statSync(health.file).size <= 16 * 1024);
    assert.ok(readLines(health.file.replace('.json', '.jsonl')).length <= 8);
    clock = 5000;
  } finally {
    health.dispose();
  }
});

test('health records work without a begin only when it is slow or does not return', () => {
  const directory = tempDir('host-health-observed');
  let clock = 0;
  const health = new HostHealth({
    directory,
    workspace: 'test',
    build: { sourceCommit: null, dirty: null, builtAt: 1 },
    now: () => clock,
  });
  try {
    health.observe('refresh', HOST_HEALTH_SLOW_MS - 1);
    health.observe('sessionIndex', HOST_HEALTH_SLOW_MS);
    health.observe('hostSave', 0, 'rejected');
    clock = 5000;
    health.sample();
    const record = JSON.parse(fs.readFileSync(health.file, 'utf8'));
    assert.deepEqual(
      record.outcomes.map(({ phase, outcome, durationMs }: any) => [phase, outcome, durationMs]),
      [
        ['sessionIndex', 'returned', HOST_HEALTH_SLOW_MS],
        ['hostSave', 'rejected', 0],
      ],
    );
    assert.equal(record.outcomeCounts.refresh, undefined);
    const lines = readLines(health.file.replace('.json', '.jsonl'));
    assert.deepEqual(
      lines.filter((line) => line.event === 'settled').map((line) => line.phase),
      ['sessionIndex', 'hostSave'],
    );
  } finally {
    health.dispose();
  }
});

test('health settlement events keep the panel that began the request', () => {
  const directory = tempDir('host-health-panel-settlement');
  const health = new HostHealth({
    directory,
    workspace: 'test',
    build: { sourceCommit: null, dirty: null, builtAt: 1 },
  });
  try {
    const request = health.begin('new', 7);
    health.settle(request, 'returned');
    const lines = readLines(health.file.replace('.json', '.jsonl'));
    assert.equal(lines.find((line) => line.event === 'begin' && line.request === request)?.panel, 7);
    assert.equal(lines.find((line) => line.event === 'settled' && line.request === request)?.panel, 7);
  } finally {
    health.dispose();
  }
});

test('health preserves the loaded build identity when the disk bundle changes', () => {
  const directory = tempDir('host-health-build');
  const bundle = path.join(directory, 'extension.js');
  fs.writeFileSync(bundle, 'loaded');
  const build = { sourceCommit: 'a'.repeat(40), dirty: true, builtAt: 1234 };
  const health = new HostHealth({ directory, workspace: 'test', build, bundle });
  try {
    assert.deepEqual(JSON.parse(fs.readFileSync(health.file, 'utf8')).build, { ...build, diskChanged: false });
    fs.writeFileSync(bundle, 'replacement bundle');
    health.sample();
    assert.deepEqual(JSON.parse(fs.readFileSync(health.file, 'utf8')).build, { ...build, diskChanged: true });
  } finally {
    health.dispose();
  }
});

test('health excludes arbitrary strings and retains failed work without changing the caller', () => {
  const directory = tempDir('host-health-redaction');
  const health = new HostHealth({
    directory,
    workspace: 'secret workspace',
    build: { sourceCommit: 'secret token', dirty: null, builtAt: 1 },
  });
  try {
    const work = health.begin('send');
    health.event(
      'attached',
      'secret prompt' as unknown as number,
      'secret session' as never,
      'secret request' as unknown as number,
      'secret error' as never,
    );
    health.event('secret event' as never);
    health.settle(work, 'failed');
    health.sample();
    const text = fs
      .readdirSync(directory)
      .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
      .join('');
    assert.equal(text.includes('secret'), false);
    const failed = readLines(health.file.replace('.json', '.jsonl')).find((line) => line.outcome === 'failed');
    assert.equal(failed?.request, work);
    assert.equal(typeof failed?.durationMs, 'number');
  } finally {
    health.dispose();
  }
  const blocked = path.join(directory, 'blocked');
  fs.writeFileSync(blocked, 'file');
  const failed = new HostHealth({
    directory: blocked,
    workspace: 'test',
    build: { sourceCommit: null, dirty: null, builtAt: 1 },
  });
  const action = () => {
    const request = failed.begin('send');
    failed.settle(request);
    return 'delivered';
  };
  assert.equal(action(), 'delivered');
  assert.equal(failed.status().failed, true);
  failed.dispose();
});

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

test('unfinished startup keeps fresh durable work after the pending deadline with detailed logging disabled', async () => {
  const directory = tempDir('startup-health-progress');
  vi.useFakeTimers();
  let clock = 0;
  let readBytes = 0;
  const log = createDiagnosticsLog({ enabled: false, directory, workspace: 'private', pid: 1, startedAt: 0 });
  const discovery = {
    readBytes: 0,
    hits: 0,
    resets: 0,
    quanta: 0,
    dispatchRetries: 0,
    parentChecks: 0,
    parentCheckMs: 0,
    childHeadFiles: 0,
    childHeadBytes: 0,
    childHeadMs: 0,
    dispatchSpendVisits: 0,
    dispatchSpendRereads: 0,
    dispatchSpendFiles: 0,
    dispatchSpendBytes: 0,
    dispatchSpendMs: 0,
    dispatchSpendAggregateStarts: 0,
    dispatchSpendAggregateCompletions: 0,
    dispatchSpendRelationshipInvalidations: 0,
    dispatchSpendConsumedSourceInvalidations: 0,
    dispatchSpendSourceRestarts: 0,
    dispatchSpendParserAdvancements: 0,
    dispatchSpendRootWaits: 0,
    dispatchSpendAggregateExhaustedBytes: 0,
    dispatchSpendAggregateExhaustedTime: 0,
    dispatchSpendAggregateExhaustedSource: 0,
    dispatchPersonBytes: 0,
    dispatchAggregateBytes: 0,
    dispatchClaudeSpendBytes: 0,
    dispatchAggregateRemainingBytes: 0,
    dispatchAggregateRemainingMs: 0,
    dispatchSpendRootRestarts: 0,
    passMs: 0,
    transcriptPassEnds: 0,
    receiptPassEnds: 0,
    otherPassEnds: 0,
    continuations: 0,
    publications: 0,
  };
  const health = new HostHealth({
    directory,
    workspace: 'private',
    build: { sourceCommit: null, dirty: false, builtAt: 1 },
    now: () => clock,
    work: () => ({
      worker: {
        role: 'session-reader',
        threadId: 2,
        state: 'running',
        pendingCount: 1,
        waitingDiscovery: false,
        active: [{ id: 7, kind: 'claude-children', generation: 2, ageMs: clock, status: 'pending' }],
        recentWindows: [],
        lastFailure: null,
        memory: {
          scope: 'session-reader worker thread',
          threadId: null,
          requestId: null,
          observed: null,
          ageSinceReceiptMs: null,
        },
      },
      discovery: { ...discovery, readBytes },
      discoveryObservation: {
        hostRequest: 7,
        generation: 2,
        sequence: 3,
        ageSinceReceiptMs: 0,
        charges: {
          ...discovery,
          dispatchSpendAggregateStarts: 1,
          dispatchSpendAggregateCompletions: 2,
          dispatchSpendRelationshipInvalidations: 3,
          dispatchSpendConsumedSourceInvalidations: 4,
          dispatchSpendSourceRestarts: 5,
          dispatchSpendParserAdvancements: 6,
          dispatchSpendRootWaits: 7,
        },
      },
      generation: 2,
      discoveryPending: true,
      loadingFailed: false,
      checkpoint: { position: 1, sequence: 3, sources: 5, completed: 1 },
    }),
  });
  const history = new StartupHistory(
    path.join(directory, 'startup'),
    () => ({}),
    () => clock,
    0,
  );
  try {
    assert.equal(log.enabled(), false);
    history.stage('panelOpened');
    clock = 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    readBytes = 65_536;
    clock = 180_000;
    await vi.advanceTimersByTimeAsync(150_000);
    const record = JSON.parse(fs.readFileSync(health.file, 'utf8'));
    assert.equal(record.elapsedMs, 180_000);
    assert.equal(record.work.discovery.readBytes, 65_536);
    assert.deepEqual(
      Object.entries(record.work.discoveryObservation.charges).filter(
        ([key]) =>
          key.startsWith('dispatchSpend') &&
          ![
            'dispatchSpendVisits',
            'dispatchSpendRereads',
            'dispatchSpendFiles',
            'dispatchSpendBytes',
            'dispatchSpendMs',
          ].includes(key),
      ),
      [
        ['dispatchSpendAggregateStarts', 1],
        ['dispatchSpendAggregateCompletions', 2],
        ['dispatchSpendRelationshipInvalidations', 3],
        ['dispatchSpendConsumedSourceInvalidations', 4],
        ['dispatchSpendSourceRestarts', 5],
        ['dispatchSpendParserAdvancements', 6],
        ['dispatchSpendRootWaits', 7],
        ['dispatchSpendAggregateExhaustedBytes', 0],
        ['dispatchSpendAggregateExhaustedTime', 0],
        ['dispatchSpendAggregateExhaustedSource', 0],
        ['dispatchSpendRootRestarts', 0],
      ],
    );
    assert.equal(record.work.worker.active[0].ageMs, 180_000);
    assert.equal(record.work.worker.active[0].kind, 'claude-children');
    assert.equal(record.work.discoveryPending, true);
    assert.ok(fs.statSync(health.file).size < 16 * 1024);
  } finally {
    history.dispose();
    health.dispose();
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

test('startup history counts the time with no visible panel after the first panel opened', async () => {
  const directory = tempDir('startup-hidden-history');
  vi.useFakeTimers();
  let clock = 0;
  const history = new StartupHistory(
    directory,
    () => ({}),
    () => clock,
    0,
  );
  try {
    // A change before the panel opens is not startup time.
    history.visibility(false);
    clock = 5;
    history.stage('panelOpened');
    history.visibility(true);
    clock = 10;
    history.visibility(false);
    clock = 25;
    history.visibility(true);
    clock = 30;
    history.visibility(false);
    history.visibility(false);
    clock = 40;
    history.stage('completeRender');
    await vi.waitFor(() => {
      const lines = fs.readdirSync(directory).flatMap((file) => readLines(path.join(directory, file)));
      // The record counts the closed interval and the open one up to the record. A repeated hide adds nothing.
      assert.deepEqual(lines.find((line) => line.outcome === 'background-complete')?.hidden, { count: 2, ms: 25 });
    });
  } finally {
    history.dispose();
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
