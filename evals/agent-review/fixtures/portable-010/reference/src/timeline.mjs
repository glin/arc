export function sendSelectedText(hosts, source, text) {
  const host = hosts.find(host => host.id === source);
  if (host) host.createDraft(text);
}
