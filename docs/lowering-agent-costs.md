# Practical tips for lowering agent costs

## Live session costs

Seeing live session costs has been the one most effective thing for understanding agent costs. Very useful for understanding model differences, how caching works, effective orchestration patterns, and identifying runaway sessions early.

Unfortunately most tools either make costs hard to see or aren't granular enough to show breakdown by turn/subagent/etc.

### Claude Code CLI

[ccstatusline](https://github.com/sirmalloc/ccstatusline) adds a live cost display and other stats to the status line. It doesn't show individual turn costs or everything from `/cost`, but it still helps a lot.

```sh
npx -y ccstatusline@latest
```

Useful fields to add: Model, Context Length, Cache Read, Cache Timer, and Session Cost.

```text
Model: Sonnet 5 | Ctx: 69.1k | Cache Read: 63.5k (91.9%) | Cache: 54:48 | Cost: $0.28
```

ccstatusline's cache timer defaults to 5 minutes, so make sure to bump it to one hour (select the Cache Timer widget in the ccstatusline editor and press `t`) to match the default cache timer on Claude subscriptions / Enterprise plans.

### Codex CLI

Codex has a very limited status line with only a few preset fields, no custom status lines. On Bedrock, it's not possible to see costs in either `/status` or the status line. Use Posit Assistant or a separate tool like AgentsView instead. `agentsview session usage <session-id> --json` prices one Claude or Codex session, subagents included.

The status line still has useful stats though, so run `/statusline` and select useful fields like: model, context used, context window, used tokens, and rate limits. Or set them in `~/.codex/config.toml`:

```toml
[tui]
status_line = ["model-with-reasoning", "context-used", "context-window-size", "used-tokens", "five-hour-limit", "weekly-limit"]
```

### Posit Assistant in Positron

[Posit Assistant](https://positron.posit.co/assistant.html) shows live costs with turn-level breakdowns and very detailed tables/charts. I also recommend enabling always-shown turn costs in `~/.posit/assistant/settings.json`:

```json
{
  "features": {
    "enablePersonaSelector": true,
    "showTurnCost": true
  }
}
```

We can't use Claude Enterprise plan with Posit Assistant, but OpenAI models work just fine with Bedrock.

## Keep the cache warm

Reusing cached context costs 1/10 the normal input price or less. Once the cache expires, the next request pays more than full price to cache the whole context again. The bigger the context, the more that costs.

### Default cache TTLs

| Agent and billing | Cache lifetime |
| --- | --- |
| Claude Code main session on a subscription/enterprise plan | 1h |
| OpenAI models in Codex | At least 30m usually, often over 1h. No fixed TTL |
| Claude Code on usage credits, API key, or cloud provider | 5m |
| Claude Code subagents | 5m |
| Claude coordinator that waits on workers, started by Arc | 1h with `--cache-lifetime 1h` on `arc run` or `arc start` |

A subagent cannot get the 1 hour lifetime from its caller. Without `--cache-lifetime`, a reader-owned session that Arc starts keeps `CLAUDE_CODE_PROMPT_CACHE_TTL` from its environment, which can name 5 minutes. When the environment does not set it, the session gets the lifetime of its billing row above. Use `--cache-lifetime 1h` when the session needs 1 hour.

Claude Code's [prompt-caching guide](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets) lists which requests get which lifetime and how to change it.

### Cache timer indicators

- `ccstatusline` in the Claude Code CLI
- Claude Code VS Code extension's cache timer
- Posit Assistant for OpenAI models (otherwise out of luck for Codex/ChatGPT)

### Cache tips

- Batch work and limit multitasking if you keep coming back to expired caches
- Beware of actions that invalidate the cache, like switching models or turning on fast mode: https://code.claude.com/docs/en/prompt-caching#actions-that-invalidate-the-cache
- Sending empty "keepalive" messages can help extend the cache (to an extent)
- If you won't be back before the cache expires, have the agent write a handoff note while the cache is still warm. Then start a fresh session from the handoff to resume the task

See Anthropic's [prompt-caching guide](https://code.claude.com/docs/en/prompt-caching) and OpenAI's [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

## Wait without repeated model requests

Codex's built-in guidance limits blocking waits and asks for frequent commentary. A parent can follow that guidance by repeatedly sleeping while its subagent runs. Each return creates another model request with the retained context.

For Codex's v2 subagents, combine a native timeout floor with additional developer instructions. Put the root setting before table headings in `~/.codex/config.toml`. Merge existing developer text into that setting, because configuration precedence selects one value.

```toml
# Select native waiting and exempt it from periodic commentary.
developer_instructions = "When only a native subagent remains active, wait through collaboration.wait_agent using its configured default timeout. Native waits return for subagent completion and messages. Do not use clock.sleep, shell sleeps, background reads, periodic status checks, or commentary-only wakeups to wait for that subagent. This native-wait rule is an exception to the general 60-second blocking-wait and commentary guidance. It does not restrict a child explicitly instructed to sleep. Tell native children to send only their final answer or one blocker."

# Clamp short requests after the model selects the v2 wait tool.
[features.multi_agent_v2]
min_wait_timeout_ms = 1500000
default_wait_timeout_ms = 1500000
max_wait_timeout_ms = 3600000
```

Keep the floor below your model's documented cache lifetime to reduce expiry risk. Set the default at or above the minimum.

The instruction adds guidance without replacing the built-in prompt. It depends on model compliance and reaches descendants. It leaves a child explicitly asked to sleep free to do so. Completion, messages, and steering still end a v2 wait early. The floor controls the requested timeout, not the minimum elapsed wait. It does not reach a parent that chooses a sleep or shell command.

Check a fresh process and session after installation. Confirm that its developer message contains the text and that its parent uses native waiting.

The table configures the v2 protocol only. [The versioned v1 handler](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/handlers/multi_agents/wait.rs) uses fixed timeout constants. [The v2 handler](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs) reads the configured floor.

### Native waiting with v1

A v1 session needs its exposed native wait tool and an explicit long timeout within that tool's limits. For a session exposing `multi_agent_v1.wait_agent` with required `targets`, use this root setting instead of the v2 instruction:

```toml
# Request long native waits despite the built-in minute guidance.
developer_instructions = """
For native subagents, use multi_agent_v1.wait_agent with their targets. Request timeout_ms=1500000 only when the tool schema accepts it. Otherwise use the schema's supported maximum. Native waiting is exempt from the built-in 60-second wait limit and commentary guidance. Do not shorten or interrupt a native wait to send progress. Do not substitute timer sleeps, shell sleeps, status queries, or background reads for native waiting. Preserve any explicitly requested child sleep. If the wait returns timed_out=true and work remains, repeat the native wait.
"""
```

Merge existing developer text into the same value. This instruction depends on model compliance and reaches descendants. It does not create an enforced v1 timeout floor. Check default loading in a fresh process and session, without per-run instruction overrides.

Check the effective model catalog and exposed tools before choosing either recipe. Provider identity and `features.multi_agent_v2=false` alone do not establish the active protocol. For Bedrock setups requiring v1, confirm that the selected model's effective `multi_agent_version` is `v1`.

When that catalog entry selects the wrong protocol, preserve the effective catalog and change only the required entry. Configure its absolute path through the root setting `model_catalog_json`. Preserve existing catalog overrides. A snapshot freezes provider metadata, so regenerate it and recheck the protocol after CLI upgrades. No catalog override is needed when the effective entry already selects the required protocol.

These instructions do not establish steering, cancellation, or resumed-session behavior for v1. Check those paths separately when your workflow needs them.

The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) defines the additive instruction setting. [A community experiment](https://github.com/openai/codex/issues/35108#issuecomment-5552457213) reports a similar developer-level exception. Check these version-sensitive wait settings after upgrading Codex.

## Compact or hand off at clear boundaries (split up long tasks)

To `/compact` or hand off?

| Situation                                        | Action                                            |
| ------------------------------------------------ | ------------------------------------------------- |
| The remaining work needs the current details     | Continue                                          |
| The same task continues, and a summary is enough | `/compact`                                        |
| The task or phase changed                        | Write a handoff, then start a fresh session       |
| The context is nearly full                       | Finish the current step, then compact or hand off |

You can also have the agent suggest when to compact or hand off. Example `CLAUDE.md` snippet:

```text
Recommend compacting or a fresh session only at a real boundary: a finished piece of work, a large new task ahead, or a nearly full context. Never in the middle of an investigation.
Compact when the next task shares this session's context. Start fresh when it does not.
Say the recommendation in one line, and name what exists only in this session.
Before either one, commit or hand off every changed file, and save findings, exact names, and open decisions to a file.
```

Or ask the agent:

```text
Should we continue, compact, or hand off?
```

### Hand off

To hand off to a fresh session, you can ask the agent to write a handoff doc or plan file for the next phase of work:

```text
Write a handoff doc for a fresh session to <project-handoff-file>.
Include the goal, decisions, current branch and commit, uncommitted files, how to test the work, risks, and the exact next step.
Link to existing project files instead of copying them.
Tell me the path, then stop.
```

(maybe write a `/handoff` skill for this)

Then start a new session or `/clear` the old one, and ask the agent to read the handoff doc/plan and continue working.

## Audit your agent sessions

AgentsView has session stats and some session health metrics: https://www.agentsview.io/docs/session-intelligence/

Agents are also good at analyzing their own transcripts and telling you about cost inefficient behaviors. Get your session ID with `/status` or similar, then (probably in a fresh session):

```text
Audit session <claude|codex>:<session-id> from its transcript.
Report the estimated total cost, the number of requests, and any usage you cannot price.
Separate uncached input, cache writes, cached input reads, output, and reasoning tokens.
Break out each subagent the same way.
Claude transcripts omit compaction requests, so treat the transcript total as a lower bound.
Find the three biggest reasons for the cost, with evidence for each.
For each one, suggest the smallest change in how I work, and estimate what it would save.
Do not treat a high cache-read share as waste by itself.
```

### Keep transcripts long enough to audit

Claude Code deletes local transcripts after 30 days. To compare spend across longer periods, set in `~/.claude/settings.json`:

```json
{
  "cleanupPeriodDays": 36500
}
```

There is no way to disable cleanup and `0` doesn't work, so you just have to set a really high value to keep transcripts around forever.

Codex transcripts have no default expiry.

## Appendix

Anthropic's [Manage costs effectively](https://code.claude.com/docs/en/costs) covers Claude Code billing and limits in full.

### What makes a turn expensive

A single prompt often leads to many model requests, one after each round of tool calls. Each request sends the whole context again: instructions, earlier messages, tool results, and attachments. Prompt caching lowers the price of that context, not its size.

Ten requests that start at 100,000 tokens and grow by 10,000 each process 1.45 million input tokens. Each subagent adds its own context, requests, and cache.

### Input categories

| Category          | Meaning                                      | Price effect                 |
| ----------------- | -------------------------------------------- | ---------------------------- |
| Uncached input    | Input that is not in the cache.              | Normal input price.          |
| Cache write       | Input saved to the cache for later requests. | More than normal input.      |
| Cached input read | Input read back from the cache.              | Much less than normal input. |

Exact prices depend on the model. See [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [OpenAI pricing](https://developers.openai.com/api/docs/pricing). Output is billed separately, at a higher rate than input for Claude and GPT models.

### Other ways to cut cost

- Use a less expensive model that can still complete the task. Delegate mechanical tasks to cheaper models if using subagents. Run A/B tests to learn what models are good at what task.
- Stop the agent or steer when it heads down the wrong path
- Claude `/doctor`, audit unnecessary `CLAUDE.md`, MCP servers, repeated tool call failures
- Ask subagents to keep their reports short. Everything a subagent returns stays in the main session's context, and every later request pays for it again.
- If the main session does not need a task's details, run the task in a separate session instead of a subagent (or you can have agents launch headless `claude -p` or `codex exec` runs). Give it a self-contained prompt and have it write its result to a file or a commit.
- Split a huge task into chunks instead of running it all in one session. A coordinating session hands each chunk to a subagent or a separate session and checks the results. Chunks can run in parallel, and each works in a small context. Tightly coupled work splits badly, because each chunk has to rebuild the shared context. Independent reading, separate files, and review work split well. The coordination still costs requests, so watch the coordinator's request count.
- Cap spend on unattended runs. Claude Code print mode takes `--max-budget-usd` and `--max-turns`. A Codex `/goal` token budget is soft: it asks the model to wrap up but doesn't stop the run.

For the cost figures Arc shows, see [Arc cost figures](agent-cost-guide.md).
