# Project glossary

Use these terms in product copy, documentation, plans, tests, and new code. Keep vendor terms at the protocol boundary. The product term is **session**.

A **read-only launch policy** retains launch restrictions through session continuation. It remains separate from reader ownership and agent-run classification.

## Interface regions

| Term | Meaning | Usage notes |
| --- | --- | --- |
| **Panel** | The complete Arc webview, containing the session list, session view, prompt box, and status surfaces. | Use for the complete extension surface, not only the transcript area. |
| **Session list** | The navigation region that lists sessions. | Its heading and accessible landmark remain **Sessions**. Do not use **sidebar** unless referring to a VS Code sidebar. |
| **Session view** | The selected session's main region, containing its heading, timeline, and prompt box. | Layout code also calls it the **session column**. Do not use **convo view** in code or documentation. |
| **Timeline** | The review-oriented list of turns and related records inside the session view. | Do not use **timeline** for the session list, prompt box, or complete panel. |
| **Chip** | A cost, context, files, commits, or other figure on a turn card or session heading. | Use **chip** for the pill in code, tests, and developer documentation. Name the figure when discussing its number. Reader-facing copy names the figure or the Card layout value **Compact**. |
| **Chip row** | The line of chips under a turn card's head row. | Use it for the line as a whole. Do not call it a stat row or a figure row. |
| **Chip popover** | The detail under a chip, including file, subagent, and commit rows. | Use **chip popover** in code, tests, and documentation. Reader-facing copy names its content. |
| **About these figures** | The closed disclosure of standing explanations at a chip popover's foot. | Code calls its lines **notes**. A line that changes how the figure reads stays in the visible footer. |
| **Timeline layout** | The Card layout and Prompt position settings for an open turn card's record and prompt. | Use it for the pair of settings and for the dialog's title. The settings are `arc.timeline.cardLayout` and `arc.timeline.promptPosition`. |
| **Card layout** | The Timeline layout setting for records: Compact, One column, or Two columns. | Name its values the way the dialog does. Two columns stacks as One column on a card too narrow for both. |
| **Prompt position** | The Timeline layout setting for prompt placement: Above the response or Below the response. | Use **prompt** for what the reader typed, and **the Prompt position setting** when the sentence is about the setting. |
| **Prompt box** | The input region for writing prompts, answering requests, attaching files, and choosing prompt settings. | Use for the complete input region. |
| **Prompt text field** | The editable text area inside the prompt box. | Use when describing typing, selection, history, or text-only sizing. |

## Work and records

| Term | Meaning | Usage notes |
| --- | --- | --- |
| **Session** | A resumable agent interaction with a stable identity, saved record, running context, session list row, and turn cards. | Use in copy, identifiers, tests, and documentation. **Sessions** is the list's accessible name and its read-only heading when the action row has room. |
| **Chat** | A vendor term for a session. | Use only when quoting or describing a vendor surface. |
| **Thread** | Codex's protocol term for a session in interfaces that expose `threadId` or thread operations. | Use only at the Codex boundary, never for a group. |
| **Group** | Session cards under one session list heading. | Saved views, time buckets, and Group by choices create groups. Unlabelled holds sessions without labels. Do not call a group a folder, space, or workspace. |
| **View** | A named query that files matching sessions under its own session list section. | Views preserve the parse cut and specify section order and archived-session inclusion. Status queries update membership with session state. |
| **Saved filter** | A named snapshot of the session list query and sort order. | Narrows existing session list sections without creating one or claiming sessions. |
| **Session list header** | The controls above the session list. | Active adds a cache indication. The filter box replaces Sessions at wide widths and takes a separate line at narrow widths. |
| **View menu** | The dialog opened by the session list header's funnel. | The heading reads View. It changes filtering, sorting, and grouping without filing sessions as a **View** does. The header's magnifying glass opens the filter box. |
| **Turn** | One user submission and the agent work and response that follow it. | A session contains turns. |
| **Turn card** | A timeline card for reviewing a turn. | It can include the prompt, response, activity, files, diffs, commits, cost, context, and comments. |
| **Commit** | A commit a turn wrote in a repository the session touched. | The Commits section and commits chip group commits and landings by repository and branch, chronologically within each group. Subagent commits count toward the commit figure. Its accessible name gives their count. |
| **Landing** | A fast-forward merge that brings a commit the turn did not write onto the branch the turn moved. | Landings never increase the commit figure. The chip and Commits heading show a separate `1 merged` figure. The first landing for a branch with a turn commit appears as `merged` on that branch's group heading. Other landings draw `merged in` rows under the moved branch. The section always reads **Commits**, including turns with only landings, never **Landings**. |
| **Partial** (files figure) | A files figure whose count is a lower bound, including whole-file Writes. | The figure and accessible name omit this status. Its record explains each cause separately for unknown and partial counts. A file with no count ends in what is unknown, such as "1 file was written whole, so its old lines are unknown." A file that kept some lines ends in the word itself, such as "1 file was written whole, so its line counts are partial." A file with no recorded cause gets one sentence for how its count ended, such as "1 file carries partial line counts." Use this sense only for files figures in code, tests, and documentation. **Estimated total** uses partial for a lower-bound cost. |
| **Draft** | Unsent prompt box content saved for one session or provisional new session. | Reader-owned and unsent, separate from turns. |
| **Queued submission** | A complete prompt held locally until it can be delivered to an agent. | It can appear as a waiting card, but it is not an agent turn until the transcript records it. |
| **Live card** | A temporary timeline card for delivery or running state that is not yet present in the transcript or rollout. | The recorded turn replaces it when the on-disk record catches up. |
| **Compaction** | An agent operation that reduces or replaces session context to continue work. | It appears on the timeline as a boundary between turns, not as a turn. |
| **Repeated record** | A Claude transcript record whose top-level `uuid` and `timestamp` match an earlier record in the same file. | It adds nothing. Say replay only for the inherited history at the start of a forked Codex rollout. |
| **Agent run** | An agent-launched subagent or delegated session, excluding reader-started or reader-requested sessions and dispatches with reader participation. | The session list can fold these into their own section without removing them from transcript discovery. |
| **Main agent** | The agent working in the session that owns a turn and any work launched from it. | Cost detail separates its usage from delegated work. |
| **Subagent** | An agent another agent starts for bounded work. | **Child agent** is an accepted technical synonym. Use **subagent** in UI copy. A subagent that opens as its own session ends its heading figures with `from` and the name of the session that started it. That name opens the session. |
| **Reader-started parent** | The session from whose menu the reader chose New session with the same labels. | The relationship supports navigation and carries no delegated ownership or cost. |
| **Dispatched session** | A separate Claude or Codex session started from a parent session's shell command. | The parent turn card lists it under **Dispatched**. Its name opens the child session. The child's heading ends its figures with `from` and the parent's name, which opens the parent. |
| **Dispatch receipt** | A private durable identity for one dispatched launch and its immutable report events. | Claims and consumption bind an exact event. A receipt supplies no billing evidence or input authority. |
| **Carried subagent** | A background subagent launched in an earlier turn that still runs while a later turn is newest. | Use **carried subagent** in code, tests and documentation. Reader-facing copy says `1 subagent started before this turn` or `2 subagents started before this turn`. The newest turn card's subagents figure counts children, not their launching turns. |
| **Delegation** | The act of assigning work to a subagent. | Use **delegated work** for attributable results and usage. |
| **Delegated work** | Work or usage from subagents or linked agent activity attributed to the main session. | Delegated cost can increase a session's total without increasing its own turn count. |
| **Transcript** | A Claude Code record read from disk. | Use **record** when the source does not matter. |
| **Rollout** | A Codex record read from disk. | Use **record** when the source does not matter. |
| **Reader** | The person reviewing and directing agent work in the panel. | This is the standard actor name in design and behavior documentation. |

## Organization and state

| Term | Meaning | Usage notes |
| --- | --- | --- |
| **Pin** | Keep a session at the top of the active session list. | **Pinned** is presentation state. Pinning does not change or duplicate its transcript. |
| **Pinned setup** | A saved choice of agent, model, effort, and permissions for a new session. | It keeps setup values in the New session menu. It does not pin a session in the session list. |
| **Label** | A reader-defined name applied to a session for filing, filtering, and grouping work. | A label is the reader's opinion, not a fact inferred from a transcript. Use **apply** and **remove** for the actions. |
| **Archive** | Move a session out of the active session list into the archived section without deleting its transcript. | Use **archived** for the state. Archiving also removes the session's pin. |
| **Unarchive** | Return an archived session to the active session list. | Use this as one word in commands, UI copy, and code. Do not use **restore** for this action. |
| **Read / unread** | Whether the reader has reviewed a turn or caught up through a session's activity boundary. | These are reader-owned attention states. They are separate from agent run status. The Unread lens, set from the View menu's Filter row, keeps unread sessions. Its typed form is `is:unread -is:archived -is:agentrun`. A session the reader reads stays under the lens until the query changes. |
| **Needs input** | A session list card state for a current permission request, a current question, or an unanswered recovered question. | It is the visible word for `is:input`. The Needs input lens, set from the View menu's Filter row, keeps these sessions. Its typed form is `is:input -is:archived -is:agentrun`. A session the reader answers stays under the lens until the query changes. |
| **Subagents** (session list state) | A session list card state where the main agent is idle while its background subagents still run. | The card says `2 subagents` or `1 subagent` in the running tone. `is:running` matches it. The reader can send a prompt in this state. |
| **Background command** (session list state) | A session list state while an idle Claude agent awaits its background command, whose completion resumes the agent. | The card says `1 background command` or `2 background commands` in the running tone. `is:running` matches it. The reader can send a prompt in this state. Use `background` for the status value in code. |
| **Full rows** | The default session list card density, chosen by the View menu's `Rows` row. | Use **comfortable** in code and tests for the density value. |
| **Compact rows** | The other session list card density, chosen by the View menu's `Rows` row. | Use **compact** in code and tests for the density value. This differs from the Card layout value **Compact**, which sets the turn record layout, not session list density. |
| **Running** (lens) | The session list lens that keeps the sessions whose agent is working now. | Set from its session list header button or the View menu's Filter row. It keeps Running, Subagents, and Background card states. Its typed form is `is:running -is:archived -is:agentrun`. A session that stops running leaves the lens on the next update. |
| **Active** | A session whose prompt cache is live or which recorded activity within the last hour. | A session list lens, separate from card state. Its button writes `is:active -is:archived -is:agentrun` to exclude archives and agent runs. `is:active` alone keeps both. |
| **Needs you** | A session waiting for the reader, named on its card and prompt box and ranked first by `Needs you first`. | Its query term is `is:needsyou`, which keeps sessions matching `is:active` that need input or are unread. No filter button writes it. |
| **Comment** | A reader-authored note attached to a turn or a quoted part of a response and sent back with a later prompt. | Do not call it a **note** in new product copy or domain code. |

## Cost, context, and caching

[`agent-cost-guide.md`](agent-cost-guide.md) owns Arc's supported pricing and the meaning of its cost figures. [`lowering-agent-costs.md`](lowering-agent-costs.md) owns the decision guidance and the client-neutral explanation of how requests and the prompt cache set the bill.

| Term | Meaning | Usage notes |
| --- | --- | --- |
| **Context** | The input carried forward so an agent can continue a session. | Do not use it as a synonym for the transcript, prompt, or remaining work. |
| **Context window** | The model's input capacity for a request. | **Context percentage** is the recorded current context as a share of that capacity. It is a level, not a quality score. |
| **Prompt cache** | Provider-managed storage that can reuse an unchanged prefix of request input. | This is unrelated to the extension's local derived-data caches. |
| **Cached input read** | Input tokens that a request records as served from the provider's prompt cache. | Prefer the full term in UI copy. **Cache read** is acceptable in technical prose. |
| **Cache write** | Input tokens stored in the provider's prompt cache for possible reuse. | A cache write is input, not model output. |
| **Cache lifetime** | The recorded or provider-specified period of possible cached-prefix reuse. | Reuse can refresh it. It is not proof of cache identity or an expiry deadline. |
| **Cache hit** | A request that records cached input reads. | When no read is recorded, say **no recorded cached read** unless the evidence establishes a miss. |
| **Warm cache** | A cache that recent request timing suggests remains reusable. | This is an inference, not a promise that the next request will hit the cache. |
| **Cold cache** | A cache that request timing suggests needs another write. | This is an inference, not proof that the provider discarded it. |
| **Cost added** (cache expiry) | What returns to an expired cache paid to resend context that a warm cache would have read, above the cache-read price for the same tokens. | New prompt text is not counted. It is smaller than the input cost of the return requests, which includes that text. |
| **Wait share** | The share of the main agent's cost that went to requests reading a Codex wait return: `wait_agent`, `wait`, or `write_stdin`. | It is attributed request cost, not pure waiting, because a return with a message or completion also carries the parent's reply. Claude records no waits. It never adds to a cache expiry's **Cost added**. |
| **Included above** | The cost-detail group for compactions and cache expiries already counted in the total. | Its rows are part of the total and are never added to it again. Each row leads with its count, and its value is money. |
| **Cached-input share** | The share of recorded input tokens served from the prompt cache. | State the denominator in UI copy, for example **input tokens from cache**. Do not confuse it with the share of cost attributed to cached reads. |
| **Next-turn starting price** | The estimated minimum price of the next request's existing context before new prompt text or output. | Its cached and uncached bounds depend on what the record can establish about cache reuse. Never say **floor** to the reader. |
| **Estimated total** | A list-price estimate for supported recorded usage, Claude compaction estimates, identified Codex compaction usage, and supported supplemental Claude usage. | It is not an invoice. A partial total is a lower bound. |
| **Cost hero** | The split bar under the warnings of a cost popover. It sets the main agent's cost against delegated work, each side with its models. | A turn that delegated nothing shows the main agent's model with no bar. |
| **Usage**, **Tools**, **Subagents** (cost tabs) | The tabs of a pinned cost popover: the main agent's cost by usage category, by the tool result each request read, and delegated work by child session. | A hover shows Usage alone. The turn popover has no Subagents tab. A popover whose records hold no tool results has no Tools tab. |

## Code alignment

New domain names follow this glossary unless they mirror a vendor field, operation, or retained compatibility key. Product wording and shared identifiers say session. Codex boundary code says thread.

Existing `composer` and `rail` identifiers, filenames, command IDs, context values, and saved-state keys remain for compatibility. Product copy and explanatory prose use prompt box and session list.
