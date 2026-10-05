import { SpendRefresher } from './projectspend.mjs';
export function scanNotices(notices) {
  const scans=[];
  const refresh=new SpendRefresher(file=>scans.push(file.path));
  for (const notice of notices) refresh.notify(notice);
  return scans;
}
