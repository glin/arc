export class HistoryView {
  constructor() { this.children = []; this.page = []; this.revision = 0; }
  updateChildren(children) { this.children = children; this.revision++; }
  async loadPage(read) {
    const page = await read();
    this.page = page.map(turn => ({...turn, children: this.children.filter(child => child.turnId === turn.id)}));
    return this.page;
  }
}
