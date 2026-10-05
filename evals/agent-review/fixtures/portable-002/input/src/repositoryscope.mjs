export class RepositoryScope {
  constructor() { this.byFolder = new Map(); }
  async refresh(folders, lookup) {
    const results = await Promise.allSettled(folders.map(lookup));
    if (results.some((result) => result.status === 'rejected')) return [...this.byFolder.values()].flat();
    for (let i = 0; i < folders.length; i++) {
      if (results[i].status === 'fulfilled') this.byFolder.set(folders[i], results[i].value);
    }
    return [...this.byFolder.values()].flat();
  }
}
