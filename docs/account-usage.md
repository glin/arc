# Account usage

## Usage status bar

`usageview.ts` normalizes the limits and money caps reported by each CLI. The panel does not derive an account limit from transcript token totals.

The collapsed bar shows current figures. Hover or focus opens a temporary detail view. A press pins it until another press or Escape. The detail view is a popover so opening it does not move the timeline.

The shared age describes the oldest displayed reading. The popover shows this age in its bottom refresh button when refresh is available. Each agent's detail includes its full local reading time in its accessible name. Unchanged utilization still receives a new age when the agent admits a new reading.

Read again discovers Codex account eligibility and requests supported usage from both agents. Only the bottom refresh area shows changing progress. Each detail group reports failed or empty outcomes. Missing and expired figures retain these groups and the retry control without inventing percentages or reading times. The collapsed bar says Account usage when no figures remain. A newer admitted reading removes that agent's terminal feedback without changing the expired attempt's outcome. Hidden Codex discovery keeps refresh pending until eligibility resolves or the attempt expires. Active progress appears as noninteractive status text. Focus moves from the removed refresh button to the popover. The refresh button returns when the attempt settles. The status and button names include their visible label and supported agents' states. One announcement summarizes newly observed terminal outcomes. Reopening the panel does not announce retained completed attempts.

Bedrock Codex accounts contribute no subscription figures, plan, detail group, refresh outcome, or announcement, including after a busy-wait timeout. Discovery removes retained Codex limits from workspace state and leaves Claude readings and historical usage files intact. A later supported account reading restores Codex usage. Unknown accounts, signed-out accounts, and discovery failures retain retryable errors.

Fresh values can arrive from live wire events, a read after a child finishes, a transcript refresh that detects finished work, or an idle child started only to answer controls. Failed or fresh reads are not repeated until the reader explicitly refreshes or the freshness rule allows another read.

Explicit unavailable Claude limits retain saved figures and their original reading age without a warning. Read again retries, and an admitted reading restores automatic refresh.

An expired limit is omitted. Complete readings replace account state, while partial live events update only the limit they name. A complete answer with no rate windows retains live windows because a money-cap answer says nothing about their clocks.

The account answer gives the credit cap no reset clock. Its row uses the next month boundary at midnight UTC and marks that moment as expected. A reported credit clock from a live rate-limit event replaces the expected moment.

A Codex live update can describe a named model bucket instead of the account aggregate. Its model name remains the bucket's scope, so it cannot replace an account figure. The usage bar omits named Codex buckets from both faces. The complete per-limit inventory remains unread until a bucket is actively published.

Claude's `seven_day_overage_included` window is a weekly bucket for one model, and live events carry no model name for it. The panel omits it. Claude Code omits it too, and draws the account answer's model-scoped weekly limits instead.

Claude Max is presented as `Max plan`. The account answer names no tier modifier, so none is drawn. Codex `pro` is presented as `Pro plan`. Every other reported name keeps its own spelling with `plan` after it, so `prolite` reads `prolite plan`. The rate-limit payload supplies no multiplier or display name.

## Refresh contracts

Claude's `rate_limits_available: false` becomes an unavailable result, separate from an empty or failed answer. Fresh and hosted children preserve this result through account-read completion.

Preact removes the focused usage refresh button when busy status replaces it. The removal emits focusout with no destination during rendering. Redrawing inside that event can retain stale busy content. The usage popover ignores null focus destinations and redundant focus entry. An outside press clears both hovered and pinned state, independently of focus events.
