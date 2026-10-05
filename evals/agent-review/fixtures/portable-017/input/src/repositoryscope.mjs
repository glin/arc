export async function workspaceRoots(folders, lookup) {
  const found = await Promise.allSettled(folders.map(folder => Promise.resolve().then(() => lookup(folder))));
  const roots = new Set(folders);
  for (const result of found) {
    if (result.status === 'fulfilled') for (const path of result.value) roots.add(path);
  }
  return [...roots];
}
