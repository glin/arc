# Practical tips for lowering agent costs

## Live session costs

Seeing live costs helps you understand model differences, caching, and which ways of working cost less. It also helps you catch runaway sessions early.

### Claude Code CLI

[ccstatusline](https://github.com/sirmalloc/ccstatusline) adds a live cost display and other stats to the status line. It does not show individual turn costs, but the session total still helps.

```sh
npx -y ccstatusline@latest
```

Useful widgets: Model, Context Length, Cache Read, Cache Timer, and Session Cost.

```text
Model: Sonnet 5 | Ctx: 69.1k | Cache Read: 63.5k (91.9%) | Cache: 54:48 | Cost: $0.28
```

The cache timer defaults to five minutes. Select the Cache Timer widget and press `t` to choose one hour for Claude subscriptions within plan usage. Match the timer to your billing route, using the cache lifetimes below.

Claude Code's dollar figure is a list-price estimate, not an invoice or a subscription-limit meter.

### Codex CLI

Codex's `/status` and status line show tokens and rate limits, without a dollar figure. Run `/statusline` to select useful fields, or set them in `~/.codex/config.toml`:

```toml
[tui]
status_line = ["model-with-reasoning", "context-used", "context-window-size", "used-tokens", "five-hour-limit", "weekly-limit"]
```

See the [Codex configuration reference](https://developers.openai.com/codex/config-reference/).

For cost estimates by session ID, use [AgentsView](https://www.agentsview.io/docs/session-intelligence/):

```sh
agentsview session usage <session-id> --json
```

It includes subagents unless you pass `--own-only`. Treat `has_cost: false` as unknown cost, not zero.

## Keep the cache warm

Cached context costs much less than normal input. When the cache expires, the next request pays to process the context again. The bigger the context, the more that costs.

Default cache lifetimes:

- Claude Code's main session on a Claude subscription within plan usage: one hour.
- Claude Code on usage credits, an API key, or a cloud provider: five minutes.
- Claude Code subagents: five minutes.
- Codex: no fixed lifetime. The cache often survives 45 minutes and usually expires within two hours.

Claude Code's [prompt-caching guide](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets) explains the billing routes and lifetime settings.

- Batch work if you keep returning to expired caches.
- Choose the model and effort at the start. Switching models or enabling fast mode invalidates Claude Code's cache.
- Send useful follow-ups while the cache is warm. Skip empty keepalive messages, which still cost money.
- Before a long break, save a handoff while the cache is warm. Resume from it in a fresh session.

Keep stable instructions and reference material before changing content. Append messages instead of rewriting earlier ones, so more of the input stays reusable.

## Compact or hand off at clear boundaries

Split long tasks into pieces. Decide at a finished step, before automatic compaction interrupts an investigation.

| Situation                                        | Action                                             |
| ------------------------------------------------ | -------------------------------------------------- |
| The remaining work needs the current details     | Continue.                                          |
| The same task continues, and a summary is enough | Use `/compact`.                                    |
| The task or phase changes                        | Write a handoff, then start a fresh session.       |
| The context is nearly full                       | Finish the current step, then compact or hand off. |

Ask the agent to suggest these boundaries, or ask directly:

```text
Continue, compact, or hand off? Name anything needed for the next step that exists only in this session.
```

Compaction pays for a pass over the history and loses detail. With a large expired Claude Code cache, it can cost less than continuing with the full history. A small history does not guarantee savings.

### Hand off

```text
Write a handoff for a fresh session to <project-handoff-file>.
Include the goal, decisions, current branch and commit, uncommitted files, tests, risks, and the exact next step.
Link to existing project files instead of copying them.
Tell me the path, then stop.
```

Commit or account for changed files before leaving. Start a new session, or use `/clear`, then ask the agent to read the handoff and continue.

## Audit your agent sessions

AgentsView has session stats and health metrics. You can also ask an agent to analyze its transcript, preferably in a fresh session:

```text
Audit session <claude|codex>:<session-id> from its transcript.
Report estimated total cost, request count, and usage you cannot price.
Separate uncached input, cache writes, cached input reads, and output.
Break out each subagent by model.
Find the three biggest cost causes, with evidence.
Suggest the smallest workflow change for each and estimate its savings.
Do not treat a high cache-read share as waste by itself.
```

Claude Code stores transcripts under `~/.claude/projects/`. Codex stores them under `~/.codex/sessions/`. Transcripts can omit billed operations, so ask the audit to state its limits.

### Keep transcripts long enough to audit

Claude Code deletes old local transcripts at startup, with a default retention period of 30 days. Set a longer period in `~/.claude/settings.json`:

```json
{
  "cleanupPeriodDays": 36500
}
```

Managed settings take precedence. Codex documents no age-based cleanup of session files.

## How the bill works

A single prompt often leads to many model requests, usually after rounds of tool calls. Each request processes retained context again: instructions, earlier messages, tool results, and attachments. Prompt caching lowers that context's price, not its size.

Independent tool calls returned together can share one follow-up request. Sequential calls often need one each. Ask the agent to batch independent reads and searches.

Uncached input costs the normal input price. Claude cache writes cost more, and cached input reads cost much less. Output, including thinking tokens, bills separately. Each subagent adds its own context and requests.

Exact rates depend on the model. See [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [OpenAI pricing](https://developers.openai.com/api/docs/pricing).

### Send messages while the agent works

Send a correction as soon as it changes the current work. Stop the agent if it uses the wrong target. Combine small additions that express one thought.

Claude Code queues messages while it works. During tool calls, it delivers them when those calls finish, within the same turn. Messages still queued at the end become later turns. Codex supports steering at a safe boundary during active work.

A correction delivered during work can use a tool continuation the agent already needs. A later turn reads the retained context again. Sending early has no special discount, and output generated before an interruption still bills.

See [Claude Code's queueing guide](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works).

## Other ways to cut cost

- Use a less expensive model that completes the task well. Lower the effort for simple work.
- Keep instructions short. Remove unused tool integrations and fix repeated tool failures.
- Ask subagents for short reports. Their replies stay in the main session's context, and later requests pay to read them again.
- Use a separate session when the main session needs only a file or commit. Independent reading, separate files, and reviews split well. Tightly coupled work repeats shared context and adds coordination.

For unattended work, set a dollar ceiling and a review-round limit before the run. Claude Code print mode supports `--max-budget-usd` and `--max-turns`. Leave headroom because a budget can overshoot by one response plus running subagents.

Codex's goal token budget is soft. It asks the model to wrap up and does not stop the run. An instruction to stay under a dollar ceiling depends on the agent following it.

For Arc's cost figures and status line, see [Arc cost figures](agent-cost-guide.md).
