import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { RateLimit, UsageReading } from '../../extension/src/agentwire.ts';
import { tempDir } from '../../extension/src/temproot.ts';
import { UsageRecorder, USAGE_STORE_DIRECTORY } from '../../extension/src/usagerecord.ts';
import { runUsage } from '../src/usage.ts';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const RESETS = NOW / 1000 + 2 * 86_400 + 3 * 3_600;
const MINUTE = 60_000;

function limit(window: string, utilization: number, scope = ''): RateLimit {
  return { window, utilization, resetsAtSeconds: RESETS, status: '', group: 'weekly', scope };
}

function reading(readAt: number, complete: boolean, limits: RateLimit[]): UsageReading {
  return { plan: 'max', limits, complete, spend: null, readAt };
}

// Each drain appends its own gzip member, so the store holds several members per day.
async function home(entries: [agent: string, reading: UsageReading][]): Promise<string> {
  const root = tempDir('cli-usage-');
  for (const [agent, value] of entries) {
    const recorder = new UsageRecorder(path.join(root, 'usage', USAGE_STORE_DIRECTORY), { now: () => NOW });
    recorder.record(agent, value);
    await recorder.drain();
  }
  return root;
}

const usage = (root: string, ...args: string[]) => runUsage(['--home', root, ...args], () => NOW);

test('usage prefers the newest complete reading over a newer incomplete one', async () => {
  const root = await home([
    ['claude', reading(NOW - 30 * MINUTE, true, [limit('seven_day', 0.4)])],
    ['claude', reading(NOW - 20 * MINUTE, true, [limit('seven_day', 0.5)])],
    ['claude', reading(NOW - 5 * MINUTE, false, [limit('seven_day', 0.9)])],
  ]);
  const { readings } = JSON.parse(await usage(root, '--json'));
  assert.equal(readings.length, 1);
  assert.equal(readings[0].utilization, 0.5);
  assert.equal(readings[0].complete, true);
  assert.equal(readings[0].readAt, NOW - 20 * MINUTE);
  assert.doesNotMatch(await usage(root), /incomplete/);
});

test('usage falls back to the newest incomplete reading and marks it', async () => {
  const root = await home([
    ['codex', reading(NOW - 30 * MINUTE, false, [limit('seven_day', 0.2)])],
    ['codex', reading(NOW - 10 * MINUTE, false, [limit('seven_day', 0.25)])],
  ]);
  const { readings } = JSON.parse(await usage(root, '--json'));
  assert.deepEqual(
    readings.map((value: { utilization: number; complete: boolean }) => [value.utilization, value.complete]),
    [[0.25, false]],
  );
  assert.match(await usage(root), /^codex +seven_day +25% .* \(10m ago\) incomplete$/m);
});

test('usage prints one line for each agent and window, and filters by agent', async () => {
  const root = await home([
    ['codex', reading(NOW - 90 * MINUTE, true, [limit('seven_day', 0.125), limit('five_hour', 1)])],
    ['claude', reading(NOW - 5 * MINUTE, true, [limit('weekly_all', 0.53), limit('weekly_scoped', 0.071, 'Fable')])],
  ]);
  assert.equal(
    await usage(root),
    [
      'Agent   Window                Used  Resets                           Read',
      'claude  weekly_all             53%  2026-11-08T15:00:00Z (in 2d 3h)  2026-11-06T11:55:00Z (5m ago)',
      'claude  weekly_scoped Fable   7.1%  2026-11-08T15:00:00Z (in 2d 3h)  2026-11-06T11:55:00Z (5m ago)',
      'codex   five_hour             100%  2026-11-08T15:00:00Z (in 2d 3h)  2026-11-06T10:30:00Z (1h 30m ago)',
      'codex   seven_day            12.5%  2026-11-08T15:00:00Z (in 2d 3h)  2026-11-06T10:30:00Z (1h 30m ago)',
    ].join('\n'),
  );
  const codex = JSON.parse(await usage(root, '--agent', 'codex', '--json')).readings;
  assert.deepEqual(
    codex.map((value: { agent: string; window: string }) => `${value.agent} ${value.window}`),
    ['codex five_hour', 'codex seven_day'],
  );
  await assert.rejects(usage(root, '--agent', 'gemini'), /--agent must be claude or codex/);
});

test('usage reports an empty or missing store and fails on an unsupported one', async () => {
  const missing = tempDir('cli-usage-');
  const directory = path.join(path.resolve(missing), 'usage', USAGE_STORE_DIRECTORY);
  assert.equal(await usage(missing), `No saved usage exists in ${directory}, where Arc saves usage readings.`);
  assert.deepEqual(JSON.parse(await usage(missing, '--json')).readings, []);
  fs.mkdirSync(directory, { recursive: true });
  assert.match(await usage(missing, '--agent', 'claude'), /^No saved claude usage exists in /);
  fs.writeFileSync(path.join(directory, 'format'), 'arc-usage-gzip-v9\n');
  await assert.rejects(usage(missing), /Unsupported usage format/);
});

test('usage JSON keeps the saved record fields with a schema version and build commit', async () => {
  const root = await home([['claude', reading(NOW - MINUTE, true, [limit('seven_day', 0.5)])]]);
  const output = JSON.parse(await usage(root, '--json'));
  assert.deepEqual(Object.keys(output), ['schemaVersion', 'buildCommit', 'directory', 'readings']);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.buildCommit, 'unknown');
  assert.equal(output.directory, path.join(path.resolve(root), 'usage', USAGE_STORE_DIRECTORY));
  assert.deepEqual(output.readings, [
    {
      agent: 'claude',
      readAt: NOW - MINUTE,
      complete: true,
      plan: 'max',
      window: 'seven_day',
      group: 'weekly',
      scope: '',
      utilization: 0.5,
      resetsAt: RESETS,
      creditResetsAt: null,
      status: '',
    },
  ]);
});
