# Account usage

Read this guide for account eligibility, displayed limits, or refresh behavior. [`usageview.ts`](../extension/src/usageview.ts) normalizes readings. [`composer-controls.ts`](../extension/src/webview/composer-controls.ts) renders usage detail. [Context evidence](accounting.md#context-evidence) owns session context and pricing.

## Usage status bar

Account limits come from CLI account readings and live events, never transcript token totals.

Hover or focus opens usage detail. A press pins it. Another press or Escape dismisses it. The popover never moves the timeline.

The shared age belongs to the oldest displayed reading. Refresh detail carries that age and each agent’s full local reading time in its accessible name. An admitted reading refreshes age even when utilization is unchanged.

Read again discovers Codex eligibility and reads supported agents. Only the bottom refresh area changes progress. Discovery keeps refresh pending until eligibility resolves or the attempt expires. Busy text is noninteractive. Focus moves from the removed refresh button to the popover. The button returns at settlement.

Failures and empty results retain detail groups and retry without invented percentages or reading times. With no figures, the bar says Account usage. A newer admitted reading clears that agent’s feedback without changing the expired attempt’s outcome. Names include visible labels and supported-agent states. Announce newly observed terminal outcomes once. Reopening never announces retained completions.

Bedrock Codex accounts contribute no subscription figures, plans, groups, refresh outcomes, or announcements, including after busy-wait expiry. Discovery removes retained Codex limits from workspace state. Claude readings and historical usage files remain. Supported later readings restore Codex usage. Unknown accounts, signed-out accounts, and discovery failures retain retryable errors.

Fresh values arrive through live events, child completion, transcript discovery of finished work, or idle control reads. Failed or fresh reads wait for explicit refresh or the freshness rule before repeating.

Explicitly unavailable Claude limits retain saved figures and their original age without warning. Read again retries. An admitted reading restores automatic refresh.

Expired windows disappear. Complete readings replace account state. Partial events update only named windows. Complete answers without rate windows retain live windows because money caps supply no window clocks.

Without a reported credit reset, the cap uses the next month boundary at midnight UTC and marks it expected. A valid live-event credit clock replaces that estimate.

Named Codex model buckets never replace account figures. Both usage faces omit them. The complete per-limit inventory remains unread until a bucket is actively published.

Claude’s unnamed `seven_day_overage_included` model bucket is omitted. Named account-response model limits remain available.

Plan labels use `Max plan` for Claude Max and `Pro plan` for Codex `pro`. Other names retain their spelling followed by `plan`, including `prolite plan`. No tier modifier or multiplier is inferred.

## Refresh contracts

The usage popover ignores null focus destinations and redundant focus entry. Preact can remove the focused refresh button during rendering. Redrawing in that focusout handler can retain stale busy content. Outside presses clear both hovered and pinned state.
