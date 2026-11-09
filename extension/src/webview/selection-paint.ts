import type { PanelToHost } from './protocol.ts';

// Times one selection from the render's receipt to its settled paint and replies to the host once.
export function createSelectionPaint(
  send: (message: Extract<PanelToHost, { type: 'selectionPainted' }>) => void,
  afterPaint: (callback: () => void) => void,
  settled: () => boolean,
  now = () => performance.timeOrigin + performance.now(),
) {
  let pending: { id: number; sessionId: string; receivedAt: number; scheduled: boolean } | null = null;
  let lastId = 0;
  function abandon(reason: Extract<PanelToHost, { type: 'selectionPainted' }>['reason']) {
    if (!pending) return;
    const { id, sessionId, receivedAt } = pending;
    pending = null;
    send({ type: 'selectionPainted', id, sessionId, receivedAt, reason });
  }
  function schedule() {
    const stamp = pending;
    if (!stamp || stamp.scheduled) return;
    stamp.scheduled = true;
    afterPaint(() => {
      if (pending !== stamp) return;
      stamp.scheduled = false;
      if (!settled()) {
        schedule();
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
    receive(
      message: { showing: string | null; selectionTiming?: { id: number; sessionId: string } },
      receivedAt: number,
    ) {
      if (
        pending &&
        (pending.sessionId !== message.showing ||
          (message.selectionTiming && pending.id !== message.selectionTiming.id))
      )
        abandon('replaced');
      const stamp = message.selectionTiming;
      if (stamp && Number.isSafeInteger(stamp.id) && stamp.id > lastId && stamp.sessionId === message.showing) {
        lastId = stamp.id;
        pending = { ...stamp, receivedAt, scheduled: false };
      }
    },
    schedule,
    abandon,
  };
}
