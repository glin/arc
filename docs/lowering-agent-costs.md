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
| You will leave a Claude Code session idle | Check the cache lifetime of your route. Claude Code requests one hour for the main session on a Claude subscription within plan usage. It requests five minutes on an API key, a cloud provider, or usage credits. Set `promptCacheTtl` to `1h` for a one-hour main session on an API key. |
| You will leave a Codex session idle | Plan for a cold cache after 45 minutes. Codex sends a cache key and no retention setting, so the server decides how long a prefix lives. In one sample of Codex requests, misses stayed at or under 13% below 45 idle minutes and passed half at about 90 minutes across models. A prefix often survives 45 minutes and usually expires within two hours. |
| The next task does not need the present context | Save the facts needed to resume and start a fresh session. |

## Choose a boundary

| Situation | Action |
| --- | --- |
| The next step needs the current details | Continue in this session. |
| The same task continues from a short summary | Compact at a completed step. |
| Auto-compaction would run in the middle of a task | Compact at the nearest completed step first. Pass focus instructions with `/compact <what to keep>` in Claude Code, or set `compact_prompt` in Codex. Compaction changes the prefix and reduces immediate cache reuse. |
| The cache expired, the history is large, and a short summary is enough | Compact before the next prompt. A cold compaction costs less than the cold next turn when the history is much larger than the summary. For a small history, the summary output can cost more than the write it avoids. [Compact after the cache expires](#compact-after-the-cache-expires) works through the numbers. |
| A Codex thread will sit idle for more than 45 minutes | Compact or hand off before you leave it. |
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

No client caps spend in an interactive session. Hard caps exist only for non-interactive runs, for one subagent, and on the account. Codex has no per-run turn, token, or dollar cap, and its goal token budget is a soft limit. `--max-budget-usd` counts subagent spend and can overshoot by one response plus running subagents, so leave headroom.

| Kind | Control |
| --- | --- |
| Hard cap | `claude -p --max-budget-usd` and `--max-turns`, which apply to print mode. The Agent SDK options `maxBudgetUsd` and `maxTurns`. A subagent's `maxTurns` frontmatter. Console workspace limits, and Team and Enterprise spend limits. OpenAI project and organization spend limits for API-key billing, which take effect with a short delay. |
| Soft limit | A Codex goal token budget, which the model's `create_goal` tool accepts. The `/goal` command in the terminal interface takes no budget, and `codex exec` has no goal flag. At the budget, Codex marks the goal `budget_limited` and tells the model to wrap up the turn. The run continues past the budget. |
| Report only | Claude Code `/usage` and the status line. Codex `/status` and `/usage`. A transcript meter such as AgentsView or `arc cost`. |

Without a hard cap, make the coordinator enforce a ceiling. It needs a transcript meter that prices both clients, because Codex `/status` reports no dollar figure. Two meters take a session ID: `arc cost SESSION_ID` and `agentsview session usage SESSION_ID --json`. AgentsView includes subagents unless you pass `--own-only`. It can report `has_cost: false`, so read a missing cost as unknown. The first call after an AgentsView upgrade can block for many minutes while it resyncs. Check `$CODEX_SESSION_ID` before `$CLAUDE_CODE_SESSION_ID`, because a Codex session started from a Claude Code shell inherits the Claude variable. At 1x the ceiling, the coordinator stops a round that does not converge. At 2x, counting spend carried across stops, it ends the run. The ceiling is an instruction, so it holds only as well as the coordinator obeys it.

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

## How the bill works

### Model requests and tool calls

A model request and a tool call are different events. One response can carry no tool calls, one call, or several. The harness runs the tools and sends their results in the next model request. Independent calls can share one follow-up request when the harness returns their results together. Dependent calls often need one follow-up request each.

A matching cached prefix is read at the cache-read rate. A tool call does not guarantee a cache read. For example, five sequential continuations over a cached 100,000-token prefix record 500,000 cached input tokens. One batched continuation records 100,000.

Server tools can run several internal iterations inside one external model request. Some hosted tools also charge per call.

### Compact after the cache expires

A Claude Code compaction request reads the whole history once to write its summary. With a warm cache, it reads the history at the cache-read rate. With an expired cache, it sends the history as uncached input at the base input rate. It writes only the shared prefix of system instructions and tools back to the cache, because the summary replaces the history. A cold next turn without compaction writes the whole history to the cache at the cache-write rate.

For example, take Opus 5.5 at 300,000 tokens with a one-hour cache. Input costs $4 per million tokens, a one-hour cache write costs $8 per million, and output costs $20 per million.

- Continuing writes all 300,000 tokens to the cache for about $2.40.
- Compacting sends about 281,000 tokens as uncached input for about $1.12. It writes a prefix of about 19,000 tokens for about $0.10 to $0.15, depending on the write lifetime. A 10,000-token summary adds about $0.20.
- The first turn after the compaction starts from about 30,000 tokens. It reads the 19,000-token prefix that the compaction wrote and writes about 11,000 tokens, for about $0.09.

Compacting and continuing costs about $1.55 against $2.40, and the next turns start from about 30,000 tokens instead of 300,000. The compaction still pays for one cold pass over the history, and the summary keeps less detail than the history it replaces.

### Send messages while the agent works

Queueing is where a client holds new input. Steering is how the agent applies that input to unfinished work. A queued message becomes steering when the client delivers it at a safe boundary inside the current turn. A message cannot enter a model request already in flight.

Neither has a special token price. Cost follows the model requests, retained context, output, and tool work that the messages cause. Submission count alone does not set the bill. Three separate messages that become three later Claude turns read 100,000 cached Sonnet 5 tokens three times for $0.06. One combined turn reads them once for $0.02. This example excludes new input, output, cache writes, and tools.

Assume the current request read 100,000 cached tokens, processed 1,000 uncached tokens, and generated 500 output tokens before a tool call. The tool result adds 2,000 tokens, and a correction adds 50 tokens. The counts below start after the correction.

| Delivery | Requests after the correction | Illustrative next input | Likely effect |
| --- | --: | --- | --- |
| Same-turn steering at the tool boundary | 1 | 100,000 cached read + 3,550 new input | The correction joins the continuation that the tool result already required. |
| Queue until the turn finishes | 2 | Normal continuation, then the retained context + 50 new input | The completed answer and correction create another request boundary. |
| Interrupt, then send | 1 | Retained completed context + 50 new input | Already generated output remains billed, and unfinished work stops. |

Same-turn steering often costs less because it reuses a continuation the agent already needs and stops wrong-path work. Sending the message before the turn ends does not create a discount by itself.

- **Claude Code.** Queueing is the default while Claude works. During tool calls, Claude Code passes queued messages after those calls within the same turn, which steers the unfinished task. If the turn ends first, it sends the oldest message as the next turn and keeps later messages queued. Escape interrupts the turn and sends queued messages at once. One final response after a mid-turn correction fits same-turn delivery, and two distinct responses mean the correction became a later turn. See [Claude Code's queueing guide](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works).
- **Codex.** Codex supports explicit steering during active work. The next safe model boundary can apply the correction before the turn finishes, and a required tool continuation can carry it. Server-turn grouping does not prove that the provider billed only one model request. See the [OpenAI steering reference](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses).

For a quick question that needs no tools, see [Keep useful context](#keep-useful-context).

## Arc

[`agent-cost-guide.md`](agent-cost-guide.md) explains Arc's cost figures, status line, and next-turn price.
