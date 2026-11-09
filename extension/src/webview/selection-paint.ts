import type { PanelToHost } from './protocol.ts';

export const SELECTION_PAINT_FRAME_LIMIT = 240;

// Times one selection from the render's receipt to its settled paint and replies to the host once.
export function createSelectionPaint(
  send: (message: Extract<PanelToHost, { type: 'selectionPainted' }>) => void,
  afterPaint: (callback: () => void) => void,
  settled: () => boolean,
  now = () => performance.timeOrigin + performance.now(),
) {
  let pending: { id: number; sessionId: string; receivedAt: number; scheduled: boolean; frames: number } | null = null;
  let lastId = 0;
  function abandon(reason: Extract<PanelToHost, { type: 'selectionPainted' }>['reason']) {
    if (!pending) return;
    const { id, sessionId, receivedAt } = pending;
    pending = null;
    send({ type: 'selectionPainted', id, sessionId, receivedAt, reason });
  }
  function receive(
    message: { showing: string | null; selectionTiming?: { id: number; sessionId: string } },
    receivedAt: number,
  ) {
    if (
      pending &&
      (pending.sessionId !== message.showing || (message.selectionTiming && pending.id !== message.selectionTiming.id))
    )
      abandon('replaced');
    const stamp = message.selectionTiming;
    if (stamp && Number.isSafeInteger(stamp.id) && stamp.id > lastId && stamp.sessionId === message.showing) {
      lastId = stamp.id;
      pending = { ...stamp, receivedAt, scheduled: false, frames: 0 };
    }
  }
  function schedule() {
    const stamp = pending;
    if (!stamp || stamp.scheduled) return;
    stamp.scheduled = true;
    afterPaint(() => {
      if (pending !== stamp) return;
      stamp.scheduled = false;
      stamp.frames += 2;
      if (!settled()) {
        if (stamp.frames >= SELECTION_PAINT_FRAME_LIMIT) abandon('unsettled');
        else schedule();
        return;
      }
      pending = null;
      send({
        type: 'selectionPainted',
        id: stamp.id,
        sessionId: stamp.sessionId,
        receivedAt: stamp.receivedAt,
        paintedAt: now(),
      });
    });
  }
  return {
    receive,
    // Ends the measurement of a timed render that the panel could not apply. The replacement snapshot carries no identity.
    discard(
      message: { showing: string | null; selectionTiming?: { id: number; sessionId: string } },
      receivedAt: number,
    ) {
      if (!message.selectionTiming) return;
      receive(message, receivedAt);
      abandon('rows-gap');
    },
    schedule,
    abandon,
  };
}
