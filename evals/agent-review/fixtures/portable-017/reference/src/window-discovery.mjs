import { workspaceRoots } from './repositoryscope.mjs';
export async function discoverWindows(windows, lookup) {
  const result=[];
  for (const window of windows) result.push({id:window.id,roots:await workspaceRoots(window.folders,lookup)});
  return result;
}
