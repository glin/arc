export class RepositoryScope {
  constructor() { this.roots = []; this.ready = false; this.folderKey = null; }
  async refresh(folders, lookup) {
    const key = folders.join('|');
    if (key === this.folderKey) return this.roots;
    this.folderKey = key;
    this.roots = (await Promise.all(folders.map(lookup))).flat();
    this.ready = true;
    return this.roots;
  }
  snapshot() { return { ready: this.ready, roots: this.roots }; }
}
