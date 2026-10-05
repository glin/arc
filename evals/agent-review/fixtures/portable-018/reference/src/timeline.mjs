export function routeDraft(hosts, source, text) {
  const target = hosts.find(host => host.sessionId === source.sessionId && host.windowId === source.windowId);
  if (!target || !text.trim()) return false;
  target.createDraft(text);
  return true;
}
