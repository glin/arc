import { repositoryRoots } from './repositoryscope.mjs';
export function sessionSources(folders, worktrees) {
  return repositoryRoots(folders, worktrees).map(path=>({path,scan:true}));
}
