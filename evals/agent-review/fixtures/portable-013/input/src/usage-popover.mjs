import { usageDetail } from './stat-detail.mjs';
export function usagePopover(usage) {
  return {heading:'Request usage',detail:usageDetail(usage),total:usage.inputTokens+usage.outputTokens};
}
