const timingKinds = new Set(['render','message','layout']);
export function timingRecord(message) {
  if (!timingKinds.has(message.kind)) return null;
  if (!Number.isFinite(message.milliseconds)) return null;
  return { [message.kind]: message.milliseconds };
}
