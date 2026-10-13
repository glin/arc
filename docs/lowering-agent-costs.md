# Lower agent costs

Use this guide to decide when to continue, compact, hand off, or change the way a task runs. It applies to Claude Code and Codex. Model names appear only as examples.

## Read the cost before choosing an action

Check the cost with the client's own meters. Claude Code has `/usage` and the status line. Codex has `/status`, which reports token use and no dollar figure, and `/usage`, which shows account usage and limit resets. Claude Code computes its dollar figure locally at list price, so it is an estimate and not an invoice or a subscription-limit meter.

A single prompt can cause several model requests. Each request processes retained context again, and a cache read still has a price. For example, ten requests starting at 100,000 input tokens and growing by 10,000 process 1.45 million input tokens in total.

A high cached-input share shows reuse, not waste. A low share can result from short work, changed context, or a changed cache key. Compare the dollar amount and request count before changing a workflow.

## Keep useful context

Keep stable instructions and reference material before changing content, and append new messages instead of rewriting earlier ones. Batch independent tool work when the result does not depend on earlier calls. Choose the model and effort at the start of a session. A model change rebuilds the cache, and so does an effort change on [some models](https://code.claude.com/docs/en/prompt-caching#changing-effort-level).

| Situation | Action |
| --- | --- |
| The active work uses the wrong target or risks an unsafe effect | Interrupt or steer immediately. |
| One missing constraint changes the current result | Send one complete correction now. |
| Several small additions express one thought | Hold them briefly and send one combined message. |
| A self-contained next task can wait | Queue one complete follow-up. |
| A side question needs no tools or follow-up | Use [`/btw`](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw) in Claude Code or `/side` in Codex. It never enters the main session history in Claude Code. |
| The work followed a path you will abandon | Use `/rewind` in Claude Code to return to an earlier turn. The earlier prefix is still cached. |
| The task is simple | Lower the effort level. Thinking tokens bill as output. |
| You would send a message only to refresh the cache | Do not. A relevant request before expiry refreshes an eligible cache entry, but it incurs its own read charge and any output. |
| You will certainly resume a large context before its cache expires | Send one short relevant message. At 200,000 tokens on Opus 5.5, it costs about 0.04 USD plus the reply, and a rebuild at the one-hour write rate costs about 1.6 USD. |
| You will leave a session idle | Check the cache lifetime of your route. Claude Code requests one hour for the main session on a Claude subscription within plan usage. It requests five minutes on an API key, a cloud provider, or usage credits. Set `promptCacheTtl` to `1h` for a one-hour main session on an API key. Current OpenAI models typically cache for about thirty minutes, and retention can reach twenty-four hours. |
| The next task does not need the present context | Save the facts needed to resume and start a fresh session. |

## Choose a boundary

| Situation | Action |
| --- | --- |
| The next step needs the current details | Continue in this session. |
| The same task continues from a short summary | Compact at a completed step. |
| Auto-compaction would run in the middle of a task | Compact at the nearest completed step first. Pass focus instructions with `/compact <what to keep>` in Claude Code, or set `compact_prompt` in Codex. Compaction changes the prefix and reduces immediate cache reuse. |
| The cache expired, the history is large, and a short summary is enough | Compact before the next prompt. A cold compaction costs less than the cold next turn when the history is much larger than the summary. For a small history, the summary output can cost more than the write it avoids. [Compact after the cache expires](agent-cost-guide.md#compact-after-the-cache-expires) works through the numbers. |
| A Codex thread will sit idle past the OpenAI cache lifetime | Compact or hand off before you leave it. |
| A new task or phase needs little of this context | Write a handoff and start a fresh session. |
| Context is nearly full | Finish the current step, then compact or hand off. |

Before a handoff, commit or account for changed files. Record the goal, decisions, branch, test command, open risks, and exact next step. Link to project files instead of copying them.

```text
Write a handoff for a fresh session to <project-handoff-file>.
Include the goal, decisions, current branch and commit, uncommitted files, tests, risks, and exact next step.
Link to existing files rather than copying them. Tell me the path, then stop.
```

## Compare work shapes

A subagent gets its own context and requests. A short report keeps the main session's later context smaller. Independent reading, separate files, and review tasks split well. Tightly coupled work adds coordination requests and repeats shared context.

Use a separate session when the main session needs only a file or commit as the result. Choose a less expensive model only when it completes the task to the same standard. Compare runs with the same task, input, tools, and pricing route before treating a cost difference as evidence.

| Situation | Action |
| --- | --- |
| A subagent idles past its cache lifetime | A subagent does not read the parent's cache and, in Claude Code, gets a five-minute cache. A fork reuses the parent's cache. Resume a finished subagent within its cache lifetime, or start a fresh one. |
| A subagent must wait or will get follow-ups | Do not let it block on a long shell wait. In Claude Code 2.1.248 or later, set `cacheTtl: 1h` under `experimental:` in its frontmatter. Claude Code ignores it while a subscription draws on usage credits. A one-hour write costs 2x the base input rate against 1.25x for five minutes, so skip it for short subagents. |
| A coordinator runs for a long time | Keep its context small, because cache reads often make up most of its cost (49% to 81% in one sample) and grow with context size times request count. Delegate big reads, compact at a step boundary, and hand off at the first compaction. |
| A long-running coordinator needs a model | Compare models by cache-read rate. In one sample, 41 GPT-6 Astra coordinators cost 1,590 USD, and the same tokens at GPT-6.1 Sol rates cost 211 USD. The figure compares prices only, because Sol's request count and quality were not measured. |
| A review runs more than once | Use the premium reviewer for the first full review and a cheaper model for re-reviews. In one sample, a review cost 2.99 USD on Astra against 0.56 USD on Sol, with effort not always matched. |
| A design decision is still open | Use the most expensive model there and nowhere else. One brief cost 13.89 USD on Fable against 5.71 USD on Opus 5.5. It was a single pair, and result quality was not compared. |

## Limit spend for an agent run

No client caps spend in an interactive session. Hard caps exist only for non-interactive runs, for one subagent, and on the account. Codex has no per-run turn, token, or dollar cap. `--max-budget-usd` counts subagent spend and can overshoot by one response plus running subagents, so leave headroom.

| Kind | Control |
| --- | --- |
| Hard cap | `claude -p --max-budget-usd` and `--max-turns`, which apply to print mode. The Agent SDK options `maxBudgetUsd` and `maxTurns`. A subagent's `maxTurns` frontmatter. Console workspace limits, and Team and Enterprise spend limits. OpenAI project and organization spend limits for API-key billing, which take effect with a short delay. |
| Report only | Claude Code `/usage` and the status line. Codex `/status` and `/usage`. A transcript meter such as AgentsView or `arc cost`. |

Without a hard cap, make the coordinator enforce a ceiling. It needs a transcript meter that prices both clients, because Codex `/status` reports no dollar figure. Check `$CODEX_SESSION_ID` before `$CLAUDE_CODE_SESSION_ID`, because a Codex session started from a Claude Code shell inherits the Claude variable. At 1x the ceiling, the coordinator stops a round that does not converge. At 2x, counting spend carried across stops, it ends the run. The ceiling is an instruction, so it holds only as well as the coordinator obeys it.

```text
Keep this task under <amount> USD and <n> review rounds.
Read your session ID from $CODEX_SESSION_ID, or from $CLAUDE_CODE_SESSION_ID when the first is unset.
Before each fix round, price the run from its start with <meter command>, including subagents and spend from earlier stops.
Past the ceiling, stop any round that does not converge. At twice the ceiling, end the run and report the spend.
```

## Orchestrate for cost

Cost follows round trips times context size, not output size. A coordinator keeps its own context small and gives each job to one agent.

| Situation | Action |
| --- | --- |
| The task needs big reads or searches | Give each to a subagent with a numeric tool-call budget. Ask for a report near 150 words. Pass plans by path. |
| The task needs several independent reads | Batch them in one call. |
| A candidate needs implementing and checking | Use one implementer per round and fresh read-only reviewers. Use a cheap model for retrieval only and a balanced model to implement. |
| Review findings keep coming | Run two review rounds. Run a third only when findings fall. Otherwise stop and replan. |
| Work can run in parallel | Fan out read-only research, or writers whose shared choices are fixed. Split into phases instead of adding a second implementer. |
| The run passes its ceiling | Stop and replan. Do not ask for more budget. |

```text
You coordinate this task. Do not read large files yourself.
Give each read to a subagent with a tool-call budget of <n>, and ask for a report under 150 words.
Pass plans by path. Use one implementer per round and fresh read-only reviewers.
Run at most two review rounds, and a third only when findings fall.
Do not poll background work. Do not stop to ask about a round these limits allow.
Past the ceiling, stop and replan.
```

## Audit a session

```text
Audit the session transcript at <path>.
Report estimated total cost, request count, and usage that cannot be priced.
Separate uncached input, cache writes, cached input reads, and output.
Break out each subagent by model.
Identify the three largest cost causes with evidence.
Suggest the smallest workflow change for each and estimate its savings.
Do not treat a high cache-read share as waste by itself.
```

Claude Code stores transcripts at `~/.claude/projects/<project>/<session-id>.jsonl`. Codex stores them at `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`. A transcript can omit billed operations or use a route without published rates. State those limits in the audit. Keep transcripts long enough for the period being compared.

Claude Code removes transcripts older than `cleanupPeriodDays` at startup. The default is 30 days, and a value in managed settings takes precedence over `~/.claude/settings.json`. Codex documents no age-based sweep of its session files. Set `cleanupPeriodDays` to cover the period you need to audit. For example:

```json
{
  "cleanupPeriodDays": 36500
}
```

## Arc

[`agent-cost-guide.md`](agent-cost-guide.md) explains Arc's cost figures, status line, and next-turn price.
