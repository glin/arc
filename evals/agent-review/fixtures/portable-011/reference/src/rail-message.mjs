import { railRowsWithinLimit } from './payload.mjs';
export function prepareRailMessage(rows, limit) {
  const payload={type:'rail',rows};
  if (!railRowsWithinLimit(payload.rows,limit)) return {accepted:false,payload:null};
  return {accepted:true,payload:JSON.stringify(payload)};
}
