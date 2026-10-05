import { costRows } from './turncard.mjs';
export const categoryOrder=['own','delegated','tool'];
export function turnCostDetail(costs) {
  return costRows(costs).map(row=>({id:row.kind,label:row.kind+' cost',amount:row.dollars}));
}
