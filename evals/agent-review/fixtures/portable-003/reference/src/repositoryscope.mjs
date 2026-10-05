export function uniqueRoots(folders) {
  const keys = folders.map((folder) => folder === '/' ? '/' : folder.replace(/\/$/, ''));
  return [...new Set(keys.filter(Boolean))];
}
export function repositoryRoots(folders, worktrees) {
  return uniqueRoots([...folders, ...worktrees]);
}
