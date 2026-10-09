# Project glossary

Use these terms in product copy, documentation, plans, tests, and new code. Keep vendor terms at the protocol boundary. The product term is **session**.

## Interface regions

The panel has a session list beside one selected session view. Use the region names below when describing its controls.

| Term | Meaning | Usage notes |
| --- | --- | --- |
| **Panel** | The complete Arc webview. It contains the session list, session view, prompt box, and status surfaces. | Use for the complete extension surface, not only the transcript area. |
| **Session list** | The navigation region that lists sessions. | Its heading and accessible landmark remain **Sessions**. Do not use **sidebar** unless referring to a VS Code sidebar. |
| **Session view** | The main region for the selected session. It contains the session heading, timeline, and prompt box. | This is the preferred term for the area also called the **session column** in layout code. Avoid **convo view** in code and documentation. |
| **Timeline** | The review-oriented list of turns and related records inside the session view. | Do not use **timeline** for the session list, prompt box, or complete panel. |
| **Chip** | One figure on a turn card or a session heading, such as its cost, its context, its files or its commits. | Use **chip** for the pill itself in code, tests and developer documentation. Name the figure it carries when the sentence is about the number. Reader-facing copy never says chip. It says **Compact** for the Card layout value, or it names the figure. |
| **Chip row** | The line of chips under a turn card's head row. | Use it for the line as a whole. Do not call it a stat row or a figure row. |
| **Chip popover** | The panel drawn under a chip that carries the detail behind its figure, including the record rows for files, subagents and commits. | Use **chip popover** in code, tests and documentation. In reader-facing copy the region has no name: write what it shows. |
| **Timeline layout** | The reader's choice of where an open turn card draws its record and its prompt. It combines Card layout and Prompt position. The gear on the session heading opens a dialog for both settings. | Use it for the pair of settings and for the dialog's title. The settings are `arc.timeline.cardLayout` and `arc.timeline.promptPosition`. |
| **Card layout** | The Timeline layout setting for the record: Compact, One column, or Two columns. Compact keeps the files, subagents and commits in the chip popovers. | Name its values the way the dialog does. Two columns stacks as One column on a card too narrow for both. |
| **Prompt position** | The Timeline layout setting for where the prompt sits: Above the response or Below the response. The dialog heads its section Prompt. | Use **prompt** for what the reader typed, and **the Prompt position setting** when the sentence is about the setting. |
| **Prompt box** | The input region for writing prompts, answering requests, attaching files, and choosing prompt settings. | Use for the complete input region. |
| **Prompt text field** | The editable text area inside the prompt box. | Use when describing typing, selection, history, or text-only sizing. |

## Work and records

| Term | Meaning | Usage notes |
| --- | --- | --- |
| **Session** | One resumable interaction with an agent. It is a row in the list, the subject of every card, and the holder of the stable identity, the saved record and the running agent context. | The product word. Use it in copy, identifiers, tests and documentation. **Sessions** is the accessible name of the session list that lists them, and the session list header shows it as a read-only heading where the action row has room. |
| **Chat** | A vendor term for a session. | Use only when quoting or describing a vendor surface. It is not the project term. |
| **Thread** | Codex's protocol term for a session in interfaces that expose `threadId` or thread operations. | Keep it at the Codex boundary. It is not the project term and does not name a group. |
| **Group** | A run of session cards under one heading in the session list. | A saved view, a time bucket, and each group the Group by row chooses draw one. Unlabelled holds the sessions that carry no label. Do not call a group a folder, a space, or a workspace. |
| **View** | A named query that files matching sessions under its own session list section. | A view never changes the parse cut. It carries its section order and whether it keeps archived sessions. A status query updates its membership as session state changes. |
| **Saved filter** | A named snapshot of the session list query and sort order. | A saved filter narrows every existing session list section. It never creates a section or claims a session. |
| **Session list header** | The region above the session list. The action row holds Sessions, the magnifying glass, funnel, and New split. Filter buttons occupy the next row in Running, Active, Unread, and Needs input order. Each button shows its scoped session count and selects or clears a status lens. Quick filters configures their visibility. Configured buttons appear with a positive count or while selected. A selected button shows zero when no sessions match. | Active adds a cache indication. The filter box replaces Sessions at wide widths and takes a separate line at narrow widths. |
| **View menu** | The dialog the funnel on the session list header opens. It holds a find box, then Filter with its Quick filters line, Group by, Sort by, Rows, Show, the label chips, and the saved filters. | The menu's head reads View. It is not a **View**: it changes how the session list filters, sorts, and draws its buckets, and it files no session. It holds no control that opens the filter box: the magnifying glass on the session list header does that. |
| **Turn** | One user submission and the agent work and response that follow it. | A session contains turns. |
| **Turn card** | The timeline card that presents a turn for later review. | It can include the prompt, response, activity, files, diffs, commits, cost, context, and comments. |
| **Commit** | A commit a turn wrote in a repository the session touched. | The Commits section and the commits chip hold a turn's commits and its landings together, grouped by branch within a repository and in the order they happened inside a group. A commit a subagent wrote counts on the commit figure, and the accessible name says how many. |
| **Landing** | A fast-forward merge that brings a commit the turn did not write onto the branch the turn moved. | A landing never enters the commit figure. The chip and the Commits heading each name it as its own figure, `1 merged`. A landing whose branch holds a commit of the turn rides that branch's group heading as the word `merged`. A merge no branch explains is a row under the branch that moved, and the row reads `merged in`. No region is headed **Landings**, and a turn that only landed still reads **Commits** over its rows. |
| **Partial** (files figure) | The status of a files figure whose counted total is a known floor rather than the whole change, such as a file a Write overwrote whole. | The figure's face and its spoken name carry no sign of this status. The record the figure opens says why, in one sentence for each cause and each way a count ended, with no count at all or with some lines kept. A file with no count ends in what is unknown, such as "1 file was written whole, so its old lines are unknown." A file that kept some lines ends in the word itself, such as "1 file was written whole, so its line counts are partial." A file with no recorded cause gets one sentence for how its count ended, such as "1 file carries partial line counts." Use this sense in code, tests and documentation for the files figure specifically. It is a different sense from **Estimated total**'s partial total, which is a lower-bound cost figure. |
| **Draft** | Unsent prompt box content saved for one session or provisional new session. | A draft is reader-owned state. It is not a turn and has not reached an agent. |
| **Queued submission** | A complete prompt held locally until it can be delivered to an agent. | It can appear as a waiting card, but it is not an agent turn until the transcript records it. |
| **Live card** | A temporary timeline card for delivery or running state that is not yet present in the transcript or rollout. | The recorded turn replaces it when the on-disk record catches up. |
| **Compaction** | An agent operation that reduces or replaces the session context so work can continue. | It appears on the timeline as a boundary between turns, not as a turn. |
| **Repeated record** | A Claude transcript record whose top-level `uuid` and `timestamp` match an earlier record in the same file. | It adds nothing. Say replay only for the inherited history at the start of a forked Codex rollout. |
| **Agent run** | A session an agent started as a subagent or delegated work, rather than one the reader started or asked for. A dispatched session the reader asked for, or whose transcript shows a sign of a person, is not an agent run. | The session list can fold these into their own section without removing them from transcript discovery. |
| **Main agent** | The agent working in the session that owns a turn and any work launched from it. | Cost detail separates its usage from delegated work. |
| **Subagent** | An agent started by another agent to do a bounded part of the work. | **Child agent** is an accepted technical synonym. Use **subagent** in UI copy. A subagent that opens as its own session ends its heading figures with `from` and the name of the session that started it. That name opens the session. |
| **Reader-started parent** | The session from whose menu the reader chose New session with the same labels. | The relationship supports navigation and carries no delegated ownership or cost. |
| **Dispatched session** | A separate Claude or Codex session started from a parent session's shell command. | The parent turn card lists it under **Dispatched**. Its name opens the child session. The child's heading ends its figures with `from` and the parent's name, which opens the parent. |
| **Carried subagent** | A background subagent launched in an earlier turn that still runs while a later turn is newest. | Use **carried subagent** in code, tests and documentation. Reader-facing copy says `1 subagent started before this turn` or `2 subagents started before this turn`. The newest turn card's subagents figure counts children, not their launching turns. |
| **Delegation** | The act of assigning work to a subagent. | This names the relationship or action. Use **delegated work** for its attributable result and usage. |
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
| **Needs input** | A session list card state where an agent holds a question or permission request. | It is the visible word for `is:input`. The Needs input lens, set from the View menu's Filter row, keeps these sessions. Its typed form is `is:input -is:archived -is:agentrun`. A session the reader answers stays under the lens until the query changes. |
| **Subagents** (session list state) | A session list card state where the main agent is idle while its background subagents still run. | The card says `2 subagents` or `1 subagent` in the running tone. `is:running` matches it. The reader can send a prompt in this state. |
| **Background command** (session list state) | A session list card state where a Claude agent is idle while a command it started in the background still runs. The agent continues by itself when the command ends. | The card says `1 background command` or `2 background commands` in the running tone. `is:running` matches it. The reader can send a prompt in this state. Use `background` for the status value in code. |
| **Full rows** | The default session list card density, chosen by the View menu's `Rows` row. | Use **comfortable** in code and tests for the density value. |
| **Compact rows** | The other session list card density, chosen by the View menu's `Rows` row. | Use **compact** in code and tests for the density value. This differs from the Card layout value **Compact**, which sets the turn record layout, not session list density. |
| **Running** (lens) | The session list lens that keeps the sessions whose agent is working now. | A session list lens, set from its filter button on the session list header or the View menu's Filter row. It keeps the Running, Subagents and Background card states. Its typed form is `is:running -is:archived -is:agentrun`. A session that stops running leaves the lens on the next update. |
| **Active** | A session whose prompt cache is live or which recorded activity within the last hour. It is the working set the reader keeps in mind. | A session list lens, not a card state. It excludes archived sessions and agent runs, so its typed form, the words its filter button writes, is `is:active -is:archived -is:agentrun`. `is:active` alone keeps both. |
| **Needs you** | A session that waits on the reader, as the status word on a card and in the prompt box names it. The `Needs you first` sort ranks these sessions first. | Its query term is `is:needsyou`, which keeps sessions matching `is:active` that need input or are unread. No filter button writes it. |
| **Comment** | A reader-authored note attached to a turn or a quoted part of a response and sent back with a later prompt. | Do not call it a **note** in new product copy or domain code. |

## Cost, context, and caching

[`agent-cost-guide.md`](agent-cost-guide.md) owns the detailed provider behavior and rates. [`lowering-agent-costs.md`](lowering-agent-costs.md) owns the decision guidance. The terms below are the stable project vocabulary.

| Term | Meaning | Usage notes |
| --- | --- | --- |
| **Context** | The input carried forward so an agent can continue a session. | Do not use it as a synonym for the transcript, prompt, or remaining work. |
| **Context window** | The model's input capacity for a request. | **Context percentage** is the recorded current context as a share of that capacity. It is a level, not a quality score. |
| **Prompt cache** | Provider-managed storage that can reuse an unchanged prefix of request input. | This is unrelated to the extension's local derived-data caches. |
| **Cached input read** | Input tokens that a request records as served from the provider's prompt cache. | Prefer the full term in UI copy. **Cache read** is acceptable in technical prose. |
| **Cache write** | Input tokens stored in the provider's prompt cache for possible reuse. | A cache write is input, not model output. |
| **Cache lifetime** | The recorded or provider-specified period during which a cached prefix may remain reusable. | Reuse can refresh it. It is not proof of cache identity or an expiry deadline. |
| **Cache hit** | A request that records cached input reads. | When no read is recorded, say **no recorded cached read** unless the evidence establishes a miss. |
| **Warm cache** | Shorthand for a cache that recent request timing suggests may still be reusable. | This is an inference, not a promise that the next request will hit the cache. |
| **Cold cache** | Shorthand for a cache that request timing suggests may need to be written again. | This is an inference, not proof that the provider discarded it. |
| **Cached-input share** | The share of recorded input tokens served from the prompt cache. | State the denominator in UI copy, for example **input tokens from cache**. Do not confuse it with the share of cost attributed to cached reads. |
| **Next-turn starting price** | The estimated minimum price of the next request's existing context before new prompt text or output. | Its cached and uncached bounds depend on what the record can establish about cache reuse. Never say **floor** to the reader. |
| **Estimated total** | A list-price estimate for supported recorded usage, Claude compaction estimates, and supported supplemental Claude usage. | It is not an invoice. A partial total is a lower bound. |

## Code alignment

New domain names follow this glossary unless they mirror a vendor field, operation, or retained compatibility key. Product wording and shared identifiers say session. Codex boundary code says thread.

Existing `composer` and `rail` identifiers, filenames, command IDs, context values, and saved-state keys remain for compatibility. Product copy and explanatory prose use prompt box and session list.
