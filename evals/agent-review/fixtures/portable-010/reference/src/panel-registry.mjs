import { sendSelectedText } from './timeline.mjs';
export class PanelRegistry {
  constructor() { this.hosts = []; }
  open(id) { const host={id,drafts:[],createDraft(text){this.drafts.push(text)}}; this.hosts.push(host); return host; }
  handoff(selection) {
    if (!selection.text.trim()) return;
    sendSelectedText(this.hosts, selection.hostId, selection.text);
  }
}
