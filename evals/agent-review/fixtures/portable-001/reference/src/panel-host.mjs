import { RepositoryScope } from './repositoryscope.mjs';
export class PanelStartup {
  constructor() { this.scope = new RepositoryScope(); }
  async begin(folders, lookup) {
    await this.scope.refresh(folders, lookup);
    const snapshot = this.scope.snapshot();
    return {loading: !snapshot.ready, rootCount: snapshot.roots.length};
  }
}
