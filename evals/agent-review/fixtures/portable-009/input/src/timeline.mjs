export class HistoryView {
  constructor() { this.children = []; this.page = []; this.revision = 0; }
  updateChildren(children) { this.children = children; this.revision++; }
  async loadPage(read) {
    const children = this.children;
    const page = await read();
    this.page = page.map(turn => ({...turn, children: children.filter(child => child.turnId === turn.id)}));
    return this.page;
  }
}
