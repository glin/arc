import assert from 'node:assert/strict';
import { test } from 'vitest';
import { measureRailPublication } from './railpublication-measure.ts';

// The measurement is only evidence when its fixture exercises the publication path the host runs:
// every tick changes one running session, the gate passes for it, and the delta path stays a delta.

test('one running session change per tick passes the gate and posts a delta of that session', () => {
  const report = measureRailPublication({ rows: 300, running: 3, ticks: 25, tickMs: 3_000 });

  assert.equal(report.gatePassed, 25, 'a changed cost did not reach the payload build');
  assert.equal(report.gateSkipped, 0);
  assert.equal(report.whole.count, 1, 'a later tick posted the complete list again');
  assert.deepEqual(report.wholeReasons, { first: 1 });
  assert.equal(report.delta.count, 24);
  assert.ok(report.snapshotBytes > 0);
  assert.ok(
    report.delta.maximumBytes * 20 < report.snapshotBytes,
    `a delta of one session cost ${report.delta.maximumBytes} bytes against a ${report.snapshotBytes}-byte list`,
  );
  // The first post carries every row. Each later post carries the changed session's row.
  assert.equal(report.rowsSent, 300 + 24);
  assert.equal(report.bytesPerMinute, Math.round((report.whole.bytes + report.delta.bytes) / 1.25));
});

test('an unchanged tick is skipped by the gate before any payload is built', () => {
  const report = measureRailPublication({ rows: 40, running: 1, ticks: 1, tickMs: 1_000 });
  assert.equal(report.gatePassed, 1);
  const again = measureRailPublication({ rows: 40, running: 0, ticks: 3, tickMs: 1_000 });
  assert.equal(again.gatePassed, 1, 'a tick with no running session rebuilt the list');
  assert.equal(again.gateSkipped, 2);
});
