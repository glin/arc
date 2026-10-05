import { SpendIndex } from './projectspend.mjs';
export function watchSpend(notices) {
  const scanned=[];
  const index=new SpendIndex(file=>scanned.push(file.path));
  for (const notice of notices) index.onFile(notice);
  return scanned;
}
