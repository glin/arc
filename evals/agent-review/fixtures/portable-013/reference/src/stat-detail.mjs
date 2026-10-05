export function usageDetail(usage) {
  const total = usage.inputTokens + usage.outputTokens;
  return total.toLocaleString() + ' tokens across ' + usage.requests + ' requests';
}
