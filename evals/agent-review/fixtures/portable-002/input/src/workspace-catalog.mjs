import { RepositoryScope } from './repositoryscope.mjs';
export class WorkspaceCatalog {
  constructor() { this.scope = new RepositoryScope(); this.visible = []; }
  async refresh(folders, lookup) {
    const roots = await this.scope.refresh(folders, lookup);
    this.visible = roots.map(path => ({path, discoverable: true}));
    return this.visible;
  }
}
