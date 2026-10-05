import { childState } from './claudehistory.mjs';
export function childRow(child,file) {
  const state=childState(child,file.modifiedAt);
  return {id:child.id,status:state,showRunning:state==='running'};
}
