export function sendSelectedText(hosts, source, text) {
  for (const host of hosts) host.createDraft(text);
}
