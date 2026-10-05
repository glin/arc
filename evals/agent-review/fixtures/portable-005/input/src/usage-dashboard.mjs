import { applyLimit } from './codexwire.mjs';
export class UsageDashboard {
  constructor() { this.scopes = {}; }
  receive(notification) {
    const limits = notification.payload?.rateLimits;
    if (!limits || !Number.isFinite(limits.utilization)) return this.scopes;
    this.scopes = applyLimit(this.scopes, {
      kind: notification.scope,
      limitName: limits.limitName,
      percent: limits.utilization,
    });
    return this.scopes;
  }
  accountPercent() { return this.scopes.account ?? null; }
}
