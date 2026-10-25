# Account usage

[`usageview.ts`](../extension/src/usageview.ts) normalizes readings. [`webview/composer-controls.ts`](../extension/src/webview/composer-controls.ts) renders detail. [Context evidence](accounting.md#context-evidence) owns session context and pricing.

## Usage status bar

Account limits come from CLI account readings and live events, never transcript token totals.

The shared age belongs to the oldest displayed reading so a fresh event cannot make an older cap appear fresh. An admitted reading refreshes age even when utilization is unchanged.

Read again discovers Codex eligibility before settling refresh. Bedrock Codex accounts contribute no subscription figures, plans, groups, refresh outcomes, or announcements, including after busy-wait expiry. Discovery removes retained Codex limits from workspace state. Claude readings and historical usage files remain. Unknown accounts, signed-out accounts, and discovery failures retain retryable errors.

Fresh values arrive through live events, child completion, transcript discovery of finished work, or idle control reads. [`agenthost.ts`](../extension/src/agenthost.ts)'s `UsageReadQueue` owns refresh attempts. Newer admitted readings clear feedback without changing expired attempts' outcomes.

Explicitly unavailable Claude limits retain saved figures and their original age without warning. Read again retries. An admitted reading restores automatic refresh.

[`usageview.ts`](../extension/src/usageview.ts)'s `foldUsage` combines complete readings and partial events. Complete readings preserve model-scoped live windows absent from the answer. Cap-only answers retain live windows because money caps supply no window clocks.

Without a reported credit reset, the cap uses the next month boundary at midnight UTC and marks it expected. A valid live-event credit clock replaces that estimate.

Named Codex model buckets never replace account figures. Both usage faces omit them. The complete per-limit inventory remains unread until the server actively publishes a bucket.

Claude's unnamed `seven_day_overage_included` bucket is omitted. Named account-response model limits remain available. Arc adds no tier modifier or multiplier. `usagePlanLabel` owns plan spelling.

## Refresh contracts

The usage popover ignores null focus destinations and redundant focus entry. Preact can remove the focused refresh button during rendering. Redrawing in that focusout handler can retain stale busy content. Outside presses clear both hovered and pinned state.

Announce newly observed terminal outcomes once. Reopening must not announce retained completions.
