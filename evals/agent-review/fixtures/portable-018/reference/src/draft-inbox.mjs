import { routeDraft } from './timeline.mjs';
export class DraftInbox {
  constructor(hosts) { this.hosts=hosts; }
  send(source,text) { return routeDraft(this.hosts,source,text); }
}
