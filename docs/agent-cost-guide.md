# Arc cost figures

Arc estimates costs in the panel, CLI, and Claude status line from recorded usage and supported list prices.

[Lower agent costs](lowering-agent-costs.md) owns the decisions about work boundaries and cache reuse. Its [What makes a turn expensive](lowering-agent-costs.md#what-makes-a-turn-expensive) section explains requests and the prompt cache.

## Supported pricing

Claude Code and Codex write usage records. The billing provider and route select the published rates.

| Billing route | Supported model identities |
| --- | --- |
| Claude API estimates from Claude Code records | `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-5-5`, `claude-haiku-4-5` |
| Direct OpenAI estimates from Codex records | `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-2026-04-23`, `gpt-5.4`, `gpt-5.4-2026-03-05` |
| Claude on Amazon Bedrock | The recognized Claude identities above, with recorded Bedrock request evidence. This estimate does not establish AWS availability for each model. |
| OpenAI on Amazon Bedrock | `openai.gpt-6-astra`, `openai.gpt-6.1-sol`, `openai.gpt-6-sol`, `openai.gpt-6-luna`, `openai.gpt-5.6-sol`, `openai.gpt-5.6-terra`, `openai.gpt-5.6-luna`, with the accepted prefixes below |
| Codex automatic review | `codex-auto-review`, priced from the OpenAI Codex rate card |
| OpenRouter, Azure, Vertex, and other providers | No built-in provider pricing support |

Recognized Claude identities accept dated snapshots with an eight-digit date suffix and bracketed context suffixes. Direct OpenAI support accepts only the identities listed here.

GPT-6 Astra and GPT-6.1 Sol pricing on Bedrock recognize the bare `openai.` identity and the `us.` or `global.` prefix. The [GPT-6.1 Sol AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html) describes launch routes separately from pricing references. A recognized billing identity does not establish current execution availability. Other supported Bedrock OpenAI identities accept bare, `global.`, and lowercase two-letter prefixes. Bedrock OpenAI pricing requires the recorded provider `amazon-bedrock`.

Claude transcript requests identify Bedrock through a `msg_bdrk_` message identifier. The latest model attachment identifies a global inference profile. A missing profile uses the regional estimate. Completed Claude results use their recorded model identity to identify Bedrock.

Claude records without a provider use recognized Claude list prices. A missing provider cannot establish whether a request used the direct API or a router. Arc does not infer router-specific rates from the model name.

Support requires enough recorded usage to identify the applicable request band and service tier. Unknown combinations remain unpriced. Claude Haiku 5.5 prices a whole request at five times every rate when its total input, cache reads and writes included, passes 100,000 tokens. A recorded cost or a configured Project cost rate supplies a separate pricing source when available.

Subscription limits and recorded request costs use separate sources. [Usage status bar](composer.md#usage-status-bar) describes account eligibility and refresh behavior.

## Read the estimate

| Display | Meaning |
| --- | --- |
| Estimated total | A list-price estimate for the recorded usage Arc can price and for the Claude compaction requests it can estimate. |
| `+` after a total | Some recorded usage has no supported price. The displayed total is a lower bound. |
| Context percentage | The recorded current context as a share of the model context window. It does not measure value or remaining work. |
| Main agent | Usage from the selected session. |
| Delegated work | Usage from child agents or linked work attributed to the selected session. |

Main-agent and delegated-work figures identify who used tokens. Token categories identify how the provider billed them.

CLI reconciliation describes saved usage, separately from missing or unresolved coverage. It does not establish that the provider logged every request. See [CLI quantities and missing coverage](cli-reference.md#quantities-and-missing-coverage) for field meanings and unavailable totals.

### Token categories

| Category          | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| Uncached input    | Prompt tokens processed without a cache-read discount.                         |
| Cached input read | An eligible unchanged prompt prefix reused from the provider cache.            |
| Cache write       | An eligible prompt prefix stored for later reuse.                              |
| Output            | Tokens generated by the model. A later request can carry this output as input. |

Uncached input, cache reads, and cache writes are input categories. A request assigns each input token to one category, while output receives a separate charge. Rates depend on the provider, model, billing route, cache duration, and service tier. Do not treat one multiplier as universal.

### Match Claude Code terminology

| Arc | Claude Code `/usage` | Claude usage field |
| --- | --- | --- |
| Uncached input | Input | `input_tokens` |
| Cached input reads | Cache read | `cache_read_input_tokens` |
| 5-minute or 1-hour cache writes | Cache write | `cache_creation_input_tokens`, split by `cache_creation` when available |
| Output | Output | `output_tokens` |

`input_tokens` excludes cache reads and writes. Claude Code shortens the labels in its Session block.

Cost details keep the cache facts on one line: `Cached input reads: $3 (94% cached · 8 requests · 200k avg input)`. Turn and session details use the same format. They omit the request facts when the record cannot establish an exact count.

Repeated input processing can cost more than output when retained context is large.

Claude Code's [`Prompt cache (main)` line](https://code.claude.com/docs/en/costs#prompt-cache-statistics) adds the request count and the share of input served from cache. It also shows cache misses, expected rebuilds, likely miss cause, tokens re-cached, and current warm or cold state. It covers the current main-agent session and excludes subagents. Use it to diagnose lost cache reuse. Arc uses the same response token fields to price main and delegated work across turns.

The [Skills, Subagents, Plugins, and MCP sections](https://code.claude.com/docs/en/costs#plan-usage-breakdown) in `/usage` answer a different question. They attribute recent plan-limit usage over the last day or week from local session history. `Subagents` is closest to Arc's `Delegated work`. `/usage` reports a recent usage share. Arc reports transcript-derived tokens and list-price cost for the selected scope. Arc has no per-skill usage view.

`extension/src/pricing.ts` calculates the multipliers below for supported model rows. `pricing.test.ts` checks them. Rates and supported models can change. A missing exact model, route, tier, or request band leaves the cost unpriced.

| API route | Cache read | Cache write | Cache duration |
| --- | --: | --: | --- |
| [Claude Fable 5.1](https://platform.claude.com/docs/en/about-claude/pricing) | 0.025x the base input rate | 1.25x for five minutes or 2x for one hour | The request selects five minutes or one hour. |
| [Claude Opus 5.5 and Claude Sonnet 5.5](https://platform.claude.com/docs/en/about-claude/pricing) | 0.05x the base input rate | 1.25x for five minutes or 2x for one hour | The request selects five minutes or one hour. |
| [Claude Sonnet 5 and Claude Opus 5](https://platform.claude.com/docs/en/about-claude/pricing) | 0.1x the base input rate | 1.25x for five minutes or 2x for one hour | The request selects five minutes or one hour. |
| [Claude on Amazon Bedrock](https://aws.amazon.com/bedrock/pricing/) | The Claude API multiple of the Bedrock base input rate, which is 1.1x list on every profile except `global.` | The Claude API multiples of the Bedrock base input rate | The request selects five minutes or one hour. |
| [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | 0.05x the base input rate | 1.25x the base input rate | The minimum is thirty minutes. |
| [GPT-6.1 Sol on Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html) | 0.05x the route's base input rate | 1.25x the route's base input rate | Thirty minutes is the default and only supported lifetime. |
| [GPT-6 Astra on Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html) | 0.1x the route's base input rate | 1.25x the route's base input rate | The rate card prices thirty-minute writes. Fallback cache duration is unknown. |
| [Other priced direct OpenAI GPT-5.6 and GPT-6 models](https://developers.openai.com/api/docs/guides/prompt-caching) | 0.1x the base input rate | 1.25x the base input rate | The minimum is thirty minutes. |

GPT-5.5 and `gpt-5.5-2026-04-23` support only `24h` retention. Arc uses thirty minutes for estimated cache timing, from the [OpenAI prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime). This estimate establishes no configured TTL, minimum lifetime, or guaranteed expiry deadline.

## Read the next-turn starting price

`Next turn starts at` estimates the minimum input-side list-price cost of existing context, before new prompt text or output.

For the Claude status command, a warm cache prices `context_window.total_input_tokens` at the model's cache-read rate. A cold cache prices Claude Code's `prompt_cache.recache_tokens_if_cold` at the applicable cache-write rate. When that native re-cache count is absent, the command prices the recorded input context at the cold rate. Native cache state selects the displayed amount.

Claude Code supplies `prompt_cache.warm`, `expires_at`, `hit_ratio`, and `recache_tokens_if_cold` directly to the status command. These native fields set the timer and warm or cold estimate without transcript inference. The panel does not receive the status-command payload. It derives cache state from transcript request timing and token categories, then changes to the cold face 90 seconds before the inferred expiry. Near that switch, the warm face says `under 2m`. The detail shows the other price when it differs.

Changing the model prices the next turn uncached. Changing Claude effort does the same when the recorded request effort differs and the detectable route rebuilds the cache. The effort estimate retains the recorded write lifetime. Google Cloud, the Claude apps gateway, HIPAA, and disabled experimental betas have no separate route signal. Their cache behavior remains undetected.

In simplified form:

```text
warm starting price = recorded input context × cache-read rate + latest answer × input rate
cold starting price = (tokens to re-cache + latest answer) × cache-write rate
```

The shared pricing function also applies provider routing, service tier, and long-context pricing. A provider without a separate cache-write product uses its ordinary input rate for the cold side.

The status figure includes the latest response's output tokens because the next request sends that answer back as input. It excludes the new prompt, future output, tool fees, and later model requests. Both displays round a nonzero starting price upward so the displayed minimum never understates its calculation.

For example, 240,000 warm Opus 5 input tokens at a $0.50-per-million cache-read rate cost $0.12 to re-read. A latest answer of 1,000 tokens adds $0.005 at the input rate. The $0.125 result displays as `$0.13` after conservative rounding. If the cache is cold, writing all 241,000 tokens for one hour starts near $2.41 instead.

Session cost sums recorded work. The next-turn starting price estimates the next request's context charge.

The estimate is closest when the next request preserves the cached prefix and stays in the same pricing band. It will remain below the whole request because the user prompt and generated output are unknown. A cache miss can make a warm estimate materially low. Multiple model requests can make the whole turn much more expensive.

### Respond to low cache reuse

`Low cache reuse in this session` means one completed main session made at least five requests, spent more than $5 on cache writes, and wrote more than half its recorded input tokens into cache. `Low cache reuse in delegated work` applies the same check to one delegated agent. The line carries cache-write cost against that scope's total, and the cached-input share sits on the line below it.

The warning does not assign a cause.

Check whether the provider changed cache keys, cache duration, routing, or request prefixes. Compare recent provider status and client releases. Inspect whether stable instructions moved or changed between requests. Start a fresh session when unrelated retained context causes repeated writes. Report the evidence to the provider when the same stable workload suddenly stops reusing cache.

The warning stays absent until the scope is complete and every required cache-write category has a supported price. A normal high cached-input share does not trigger it.

### Respond to a high wait share

`Waiting on subagents took 27% of the main agent's cost` means requests reading `wait_agent` returns cost at least a fifth of its estimated cost. At least five such requests must cost at least $1 in total. Delegated work does not enter the share. The line gives wait cost, main-agent cost, wait count, and timeout count. A turn's line reads `this turn's main agent cost` and applies the same numbers to that turn alone. The turn, session heading, and Session list cost figures carry the warning sign.

A timed-out wait is a request that brought back no news. [Lower agent costs](lowering-agent-costs.md#wait-without-repeated-model-requests) explains native wait configuration and its limits. A request after a subagent message or completion also carries the parent's reasoning and reply, so the share overstates pure waiting.

The line stays absent until the main agent's usage is complete and every main-agent request has a supported price. Claude records no waits, so a Claude session never shows the line.

## Lower the cost of waiting on subagents

Each parent wake during subagent work costs one model request.

Claude Code's `Agent` tool launches a subagent in the foreground or the background. A foreground launch blocks until the subagent returns. A background launch returns immediately, then a completion notice wakes the parent. In both modes the parent makes no request while it waits, and its prompt cache lifetime runs from its last request. A wait longer than the prompt cache lifetime costs one cache write on the next request, which the next-turn starting price shows as the cold price.

A Claude parent that waits on an Arc dispatch makes no request until its wait command returns. A coordinator that waits on long workers needs a cache lifetime longer than each wait. Pass `--cache-lifetime 1h` to `arc run` or `arc start` when it needs 1 hour. [Default cache TTLs](lowering-agent-costs.md#default-cache-ttls) lists the lifetime of a launch without the flag.

Codex has no foreground launch. `spawn_agent` returns at once, and the parent waits through `wait_agent`, where each return is a model request. Codex native waits return on child completion or timeout. Its v2 wait also returns on child messages. The parent also receives pending results through other tool returns, including timer returns. Repeated short waits or sleeps create extra model requests. [Lower agent costs](lowering-agent-costs.md#wait-without-repeated-model-requests) owns the configuration guidance.

`arc cost <path> --by-tool` shows requests that read each tool's results. Its `wait` row includes `wait_agent`, `wait`, and `write_stdin` returns. A `clock.sleep` call belongs to `other`. Check that category and the transcript when the parent uses timers.

## Arc message delivery

Arc forwards each busy-time message to the selected agent's protocol. It preserves separate submissions and does not combine a rapid burst. For Claude, it writes each message to Claude Code immediately. Claude Code queues the message, then chooses a same-turn tool boundary or a later turn. Arc's Stop action differs from Claude Code's Escape key because Stop clears messages that Claude Code still holds.

For Codex, Arc sends ordinary prompts through `turn/start`, which can steer an active steerable turn. Guarded live input uses `turn/steer` and requires exactly one eligible running root turn. Arc also uses `turn/steer` to answer an async question in its originating turn.

Arc uses its local queue during Codex compaction or when an agent cannot accept input. Waiting consumes no model tokens. Delivery can create a normal model request with the retained context.

## Check cost outside the panel

The [CLI guide](cli.md) provides cost and status-line examples. The [CLI reference](cli-reference.md#cost-reports) defines output fields and coverage.

A native Codex status line can show model, context, token counts, limits, Git state, and thread cost, depending on client and account. The panel's transcript-derived estimate remains a separate list-price figure with its own supported routes and missing-data limits.

## Limits

- An estimate is not a personal subscription charge, plan-limit meter, or invoice.
- A high cached-input share can reflect useful reuse. It does not indicate poor work.
- A context warning asks for a boundary decision. It does not prove that a fresh session costs less.
- Tool fees remain absent when the provider record does not include a billable count.

## Reading the cache percentage

The cost detail shows the share of input served from cache. Amber requires a rate below 80%, at least five model requests, and at least $0.50 of estimated input cost. Input includes uncached tokens, cache reads, and cache writes. Output does not contribute to this minimum. Incomplete pricing keeps the percentage muted.

Short subagents often finish before reusing much context. The cost minimum keeps cheap runs from triggering amber. The percentage and separate low-cache-reuse warning remain available. Amber does not prove avoidable waste.
