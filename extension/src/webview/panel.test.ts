import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createSelectionPaint, SELECTION_PAINT_FRAME_LIMIT } from './selection-paint.ts';
import type { PanelToHost } from './protocol.ts';

type PaintMessage = Extract<PanelToHost, { type: 'selectionPainted' }>;

function paintFixture() {
  const frames: Array<() => void> = [];
  const messages: PaintMessage[] = [];
  let settled = true;
  let now = 120;
  const paint = createSelectionPaint(
    (message) => messages.push(message),
    (callback) => frames.push(() => frames.push(callback)),
    () => settled,
    () => now,
  );
  return {
    paint,
    frames,
    messages,
    settle(value: boolean) {
      settled = value;
    },
    time(value: number) {
      now = value;
    },
  };
}

test('a selection reports receipt and paint once after two frames and settled timeline content', () => {
  const f = paintFixture();
  const message = {
    showing: 'selected',
    selectionTiming: { id: 1, sessionId: 'selected' },
  };
  f.paint.receive(message, 100);
  f.paint.schedule();
  f.paint.schedule();
  assert.equal(f.frames.length, 1);
  f.frames.shift()!();
  assert.deepEqual(f.messages, []);
  f.settle(false);
  f.frames.shift()!();
  assert.deepEqual(f.messages, []);
  f.settle(true);
  f.frames.shift()!();
  f.frames.shift()!();
  assert.deepEqual(f.messages, [
    {
      type: 'selectionPainted',
      id: 1,
      sessionId: 'selected',
      receivedAt: 100,
      paintedAt: 120,
    },
  ]);
  f.paint.receive(message, 125);
  f.paint.schedule();
  assert.equal(f.frames.length, 0);
  f.paint.abandon('disposed');
  assert.equal(f.messages.length, 1);
});

test('replacement and disposal report reached receipt without a paint stamp', () => {
  for (const reason of ['disposed', 'hidden', 'replaced'] as const) {
    const f = paintFixture();
    f.paint.receive({ showing: 'old', selectionTiming: { id: 1, sessionId: 'old' } }, 100);
    f.paint.schedule();
    if (reason === 'replaced') f.paint.receive({ showing: 'new' }, 110);
    else f.paint.abandon(reason);
    f.frames.shift()!();
    f.frames.shift()!();
    assert.deepEqual(f.messages, [
      {
        type: 'selectionPainted',
        id: 1,
        sessionId: 'old',
        receivedAt: 100,
        reason,
      },
    ]);
  }
});

test('an unrelated render of the same session preserves the first receipt and pending paint', () => {
  const f = paintFixture();
  f.paint.receive({ showing: 'selected', selectionTiming: { id: 1, sessionId: 'selected' } }, 100);
  f.paint.schedule();
  f.paint.receive({ showing: 'selected' }, 110);
  f.frames.shift()!();
  f.frames.shift()!();
  assert.equal(f.messages[0].receivedAt, 100);
});

test('a timed render the panel cannot apply ends its measurement with the rows gap reason', () => {
  const f = paintFixture();
  f.paint.discard({ showing: 'selected', selectionTiming: { id: 1, sessionId: 'selected' } }, 100);
  assert.deepEqual(f.messages, [
    { type: 'selectionPainted', id: 1, sessionId: 'selected', receivedAt: 100, reason: 'rows-gap' },
  ]);
  f.paint.schedule();
  assert.equal(f.frames.length, 0, 'the discarded render scheduled a paint');
  f.paint.receive({ showing: 'selected' }, 110);
  assert.equal(f.messages.length, 1, 'the replacement snapshot reported the measurement again');
});

test('an untimed render the panel cannot apply leaves the pending measurement waiting', () => {
  const f = paintFixture();
  f.paint.receive({ showing: 'selected', selectionTiming: { id: 1, sessionId: 'selected' } }, 100);
  f.paint.discard({ showing: 'selected' }, 110);
  assert.deepEqual(f.messages, []);
});

test('a paint wait that never settles ends with one reason at the frame limit', () => {
  const f = paintFixture();
  f.settle(false);
  f.paint.receive({ showing: 'selected', selectionTiming: { id: 1, sessionId: 'selected' } }, 100);
  f.paint.schedule();
  for (let frame = 0; frame < SELECTION_PAINT_FRAME_LIMIT; frame++) {
    assert.deepEqual(f.messages, []);
    f.frames.shift()!();
  }
  assert.deepEqual(f.messages, [
    { type: 'selectionPainted', id: 1, sessionId: 'selected', receivedAt: 100, reason: 'unsettled' },
  ]);
  assert.equal(f.frames.length, 0, 'the wait scheduled another frame after it ended');
});
