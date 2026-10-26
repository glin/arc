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
  assert.equal(
    report.bytesPerMinute,
    Math.round((report.whole.bytes + report.delta.bytes + report.queryContext.bytes) / 1.25),
  );
});

// The query context holds every scoped identity and file, so it outweighs the rows of a delta many times over.
test('a tick that changes one running session posts under 2 percent of the complete list, every message included', () => {
  const report = measureRailPublication({ rows: 1000, running: 3, ticks: 10, tickMs: 3_000 });

  assert.equal(report.queryContext.count, 1, 'an unchanged query context was posted again');
  assert.equal(report.fields.queryContext, undefined, 'a session list message carried the query context');
  assert.ok(
    report.tickShare < 0.02,
    `one changed session posted ${(report.tickShare * 100).toFixed(1)} percent of a ${report.snapshotBytes}-byte list`,
  );
});

// A refresh that walks the catalog posts the context twice, once as discovery starts and once as it completes.
test('the query context stays under 400,000 bytes at 3,675 sessions, and a coverage flip posts it twice', () => {
  const report = measureRailPublication({ rows: 3675, running: 1, ticks: 2, tickMs: 3_000 });

  assert.equal(report.queryContext.count, 1);
  assert.ok(
    report.queryContext.maximumBytes < 400_000,
    `the query context cost ${report.queryContext.maximumBytes} bytes for 3,675 sessions`,
  );
  assert.equal(report.coverageFlip.count, 2, 'a coverage change did not post the context');
  assert.ok(
    report.coverageFlip.bytes < 800_000,
    `one coverage flip posted ${report.coverageFlip.bytes} bytes for 3,675 sessions`,
  );
});

test('an unchanged tick is skipped by the gate before any payload is built', () => {
  const report = measureRailPublication({ rows: 40, running: 1, ticks: 1, tickMs: 1_000 });
  assert.equal(report.gatePassed, 1);
  const again = measureRailPublication({ rows: 40, running: 0, ticks: 3, tickMs: 1_000 });
  assert.equal(again.gatePassed, 1, 'a tick with no running session rebuilt the list');
  assert.equal(again.gateSkipped, 2);
});
