# Lower agent costs

Use this guide to decide when to continue, compact, hand off, or change the way a task runs. [`agent-cost-guide.md`](agent-cost-guide.md) explains Arc's cost figures and their limits.

## Read the cost before choosing an action

Check the turn cost, request count, input categories, and delegated work. A single prompt can cause several model requests. Each request processes retained context again, and a cache read still has a price. For example, ten requests starting at 100,000 input tokens and growing by 10,000 process 1.45 million input tokens in total.

A high cached-input share shows reuse, not waste. A low share can result from short work, changed context, or a changed cache key. Compare the dollar amount and request count before changing a workflow.

The Arc panel estimates list-price cost from recorded usage. The CLI status command shows Claude's native cache state and the estimated starting price of another turn. Neither estimate is an invoice or a subscription-limit meter.

## Keep useful context

Keep stable instructions before changing content. Batch independent tool work when the result does not depend on earlier calls. Send one complete correction when it can steer work already in progress. Stop work that is using the wrong target.

A relevant request can refresh an eligible prompt cache, but it incurs its own token cost. Do not send filler or empty messages only to refresh a timer. If the next task does not need the present context, save the facts needed to resume and start a fresh session.

## Choose a boundary

| Situation                                        | Action                                             |
| ------------------------------------------------ | -------------------------------------------------- |
| The next step needs the current details          | Continue in this session.                          |
| The same task continues from a short summary     | Compact at a completed step.                       |
| A new task or phase needs little of this context | Write a handoff and start a fresh session.         |
| Context is nearly full                           | Finish the current step, then compact or hand off. |

Before a handoff, commit or account for changed files. Record the goal, decisions, branch, test command, open risks, and exact next step. Link to project files instead of copying them.

```text
Write a handoff for a fresh session to <project-handoff-file>.
Include the goal, decisions, current branch and commit, uncommitted files, tests, risks, and exact next step.
Link to existing files rather than copying them. Tell me the path, then stop.
```

## Compare work shapes

A subagent gets its own context and requests. A short report keeps the main session's later context smaller. Independent reading, separate files, and review tasks split well. Tightly coupled work adds coordination requests and repeats shared context.

Use a separate session when the main session needs only a file or commit as the result. Choose a less expensive model only when it completes the task to the same standard. Compare runs with the same task, input, tools, and pricing route before treating a cost difference as evidence.

## Audit a session

```text
Audit session <claude|codex>:<session-id> from its transcript.
Report estimated total cost, request count, and usage that cannot be priced.
Separate uncached input, cache writes, cached input reads, and output.
Break out each subagent by model.
Identify the three largest cost causes with evidence.
Suggest the smallest workflow change for each and estimate its savings.
Do not treat a high cache-read share as waste by itself.
```

A transcript can omit billed operations or use a route Arc cannot price. State those limits in the audit. Keep transcripts long enough for the period being compared.

Claude Code removes old local transcripts after its retention period. Set `cleanupPeriodDays` in `~/.claude/settings.json` to cover the period you need to audit. For example:

```json
{
  "cleanupPeriodDays": 36500
}
```
