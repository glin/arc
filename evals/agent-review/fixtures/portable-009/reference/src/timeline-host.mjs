import { HistoryView } from './timeline.mjs';
export class TimelineHost {
  constructor() { this.history = new HistoryView(); this.selected = []; }
  childRecordsChanged(children) { this.history.updateChildren(children); }
  async openOlderPage(read) {
    this.selected = await this.history.loadPage(read);
    return this.selected.map(turn => ({id:turn.id, childCount:turn.children.length}));
  }
}
