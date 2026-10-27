# Timeline turn model

[Components](components.md) identifies source owners.

## Shared turn model

`transcript.ts` and `codex.ts` return shared `SessionFile`, `Turn`, and `Compaction` values. Keep provider-specific interpretation inside the source readers. Discovery, pricing fallback, and named provider limitations retain their own branches.

A `Compaction` is a context boundary, separate from a turn and its response.

One-shot reads, append checkpoints, and semantic pages use the same forward reducers. Forward checkpoints own associations through their applied byte. Backward page state owns incomplete older edges separately. [Session history](session-history.md#selected-session-history) owns page admission and retention.

Keep each call's `ordinal` and each message's `stepsBefore` position when trimming steps. `stepKinds` and `failedOrdinals` preserve complete categories and failures beyond that trim. Live activity extends displayed totals without changing recorded totals. Pending prompts retain submission-time positions until a parsed successor owns them.

### Claude turn boundaries

A tool-use response does not close a Claude turn. A result marked `toolEndsTurn: true` closes it, including a `SubagentHandback` result. Preserve that result through line filters, including child tails without a prompt. Later model work or a coordinator or peer message resumes the turn. A later stop reason closes it again.

A plain `/compact` command closes without a turn when its manual boundary records finite positive input and summary sizes. The boundary's clock must equal or follow the command's clock and belong to the main chain. Model work after that boundary makes the command a turn again. Queued prompts remain independently reviewable, and the preceding turn keeps its outcome.

The CLI's answer withdraws an unanswered command only when its `parentUuid` matches the opening command. Admit both `local_command` system records and user records containing only a command stdout or stderr element. The withdrawn command creates no card or turn count. Later model work resumes the preceding turn, or belongs to no turn when none exists. It never restores that command as a turn.

Prompts queued around a withdrawn command keep an unanswered turn of their own. Later work answers that turn. A process end stops it, and later queued prompts join it. A local answer also stops an earlier unanswered prompt without extending its duration to the answer's clock. Later model work removes that inferred stop.

A validated `cost-state` record sets `processEndedAt` from `startTime + totalDuration`. It stops unfinished work without claiming completion or interruption. It does not advance session recency. A later typed prompt starts a new turn without inheriting that process boundary.

Claude records a queued prompt when the agent picks it up. Delivery owners must retain their own prompt until that record arrives. An unanswered queued prompt without a process boundary carries into the next turn. The unresolved final turn stays visible.

`claudeLocalAnswer`, `claudeCompactAnswer`, and `reduceClaudeSessionLine` carry the command edge cases. Keep full reads, metadata, newest-turn discovery, and usage reducers consistent with those rules.

### Codex turn boundaries

Codex records task starts and terminals directly. Copied parent history supplies no own turn, completion, or request. Delayed `turn_context` evidence can retract a turn after its apparent completion. Preserve that classification through append checkpoints and older-page reads.

`recordAnswer` in [`codex.ts`](../extension/src/codex.ts) joins final-answer envelopes. [Questions and recovery](question-recovery.md#codex-asynchronous-questions) owns asynchronous delivery, which supplies no final answer.

## Card sources

Recorded work remains available for sessions started in another window or terminal. Host-owned live activity temporarily overlays only the newest turn. Stable protocol identities let the transcript replace that overlay. Keep delivery and process authority separate from transcript identity.

An `exec` Codex dispatch keeps Run by agents filing across continuation prompts. Later `cli` or `vscode` metadata ends that exemption only with matching opening identity, a newer envelope, and no foreign or copied history. Multiple genuine prompts then establish reader ownership. Interactive and unknown-source openings apply that prompt rule immediately. Saved reader starts and reader-owned receipts retain their ownership. Input that the reader sends from the Prompt box to a session filed as an agent run, or not yet classified, makes the session the reader's own. Typed text, comments, files, typed `/compact` and `/clear`, and typed Codex `/new` count when they enter the waiting queue or when the agent accepts them. Typed Codex `/rename`, typed Claude `/remote-control` and `/rc`, and typed commands that open a panel control do not count. Successor sessions keep that ownership. An Arc agent-run launch keeps the prompt-cache request that [Claude attribution selection](agent-launches.md#claude-attribution-selection) defines. Native subagents retain agent-run classification.

Native child navigation uses recorded identities. Claude needs the paired launch-tool and child-agent identities, an existing transcript, and repository-qualified child cwd. That exact transcript still supplies parent-card spend when its cwd prevents navigation. Codex resolves a unique explicit child id when parent metadata names the selected parent or is absent. Without an id, it resolves a unique matching agent path or name among direct children. Conflicting thread, parent, or physical-source identities prevent resolution. Background reviews supply no child navigation target. Clocks, prompts, branches, and worktree paths establish none of these targets.

Codex collaboration rows retain their thread identity even when headers omit the agent path. Started `SubAgentActivity` items bind through the spawn call id. Completed activity item ids cannot identify the launch. Parent terminal notifications set row state before spend enrichment. Structural enrichment preserves recorded terminal status and recorded duration.

A background review without a parent collaboration item attaches through its direct parent and the unique parent turn covering its opening clock. A parent-recorded row for that child takes precedence. Child revisions remain refresh inputs when the parent source stays unchanged. [Session discovery](session-discovery.md#relationship-discovery-contracts) owns relationship admission.

Guardian metadata uses `thread_source: guardian_review`, or `thread_source: subagent` with structured `source.subagent.other` identifying the guardian. Keep that subtype through metadata transport. Prompt text never classifies internal automation.

The opening envelope assigns a background review to its parent turn. Its replay boundary uses valid payload creation time, allowing one second of rounded turn starts. Earlier starts remain copied. Unsupported guardians retain the envelope boundary.

A native spawn requires distinct child and parent identities agreeing with explicit parent metadata. Creation must not follow the envelope, and no fork applies. Qualifying spawns use creation time. Starts after creation establish own work. Starts at creation or within its preceding second require a bill naming that exact child `thread_id`. Older starts, repeated turns, copied dates, and foreign bills establish no own work. Missing confirmation leaves ownership unresolved and full cost unknown. Unsupported child sources retain the envelope boundary. Direct sessions use their separate creation-clock rules in `codexReplayBoundaryAt`.

Structural row duration runs from the child's start clock to its last turn's end. Guardians and verified native spawns use creation time. Other children use the opening envelope. Guardian duration detail uses that same start. Other child duration details use their own recorded turn starts and ends.

Encrypted `NEW_TASK` content establishes a task path without readable full instructions. Report that limit instead of presenting the path as the assignment.

[Turn cards](turn-cards.md#subagent-and-dispatched-rows) owns child presentation and navigation affordances. [Accounting](accounting.md#delegated-attribution) owns delegated usage, dispatch lifetime contributions, and incomplete cost. [Session discovery](session-discovery.md#dispatch-evidence) owns shell-launch receipt validation.

## Parsing and attribution constraints

Classify vendor records from structured fields before returning the shared model. Add source fixtures for accepted and refused shapes. Update each affected [cache generation](session-history.md#source-and-cache-contracts) when stored derivation changes.

### Messages and handbacks

Narration and clear reasoning summaries are ordered Activity messages, separate from tool steps. Claude contributes assistant text stopped for tool use. Codex contributes commentary-phase messages and clear reasoning summaries. Final answers remain responses.

`recordUpdate` in [`codex.ts`](../extension/src/codex.ts) joins commentary envelopes while retaining the first row's position and clock.

Claude background completion notices arrive as queued attachments while the parent works and as `task-notification` user records while it waits. Both must reach `applyClaudeTaskNotification`. Unknown launch ids create no row. A nested foreground result needs its own `agentId:` line followed by `<usage>` before it supplies child identity. An id quoted in the report cannot identify the child. A background result remains open until its completion notice.

Peer handbacks and coordinator messages wake existing turns. Keep handback ids across typed prompts because a completion notice can repeat an earlier turn's handback. A notice after a closed reply, without intervening tool work, marks a later reply as a repeated receipt. It does so only when that turn already has a response. Thinking and text with one message id remain one reply.

`SubagentHandback.message` supplies the child response. [`reduceClaudeSessionLine`](../extension/src/transcript.ts) owns handback and closing-reply deduplication.

Replies after the handback remain `notResponse: after-handback` until a prompt, peer message, or coordinator message wakes the child. Its own background completion notices and no-text harness nudges do not clear that state. Child reads skip sidechain peer and completion attachments. A reply containing only `No response requested.` never becomes the response. Marked replies stay in Activity. Preserve quote fallback when those marks change saved comment reply numbers.

### Skills

Skill records and their true count survive the bounded step list. They retain source identity, time, path, description when available, and evidence strength. Do not infer skill use or who selected it from prose.

Claude pairs native `Skill` directory records through `sourceToolUseID`, never adjacency. A typed command requires the next admitted meta user record's base-directory line on an open turn. [`transcript.ts`](../extension/src/transcript.ts) owns skill-use admission and failed-call withdrawal.

Codex skill evidence is best-effort successful catalog-path reading, not a prompt mention or catalog entry. [`recordCodexSkillUses`](../extension/src/codex.ts) owns command recognition. Preserve Windows path comparison and executable-name normalization when changing that fallback.

A Claude skill call has no tool category but retains its invocation and Activity row. A Codex skill read retains its run category because the command is both a run and a skill use. The skills explanation appears only when the list includes best-effort evidence.

### Claude repeated records

Within one file, the first top-level `uuid` and `timestamp` pair is genuine. Later records with that identity contribute no facts, including version, prompts, usage, titles, tools, or compactions. The same uuid with a new timestamp is genuine. Nested keys supply no identity. Either identity string longer than 1,024 bytes as written supplies none. A fork starts a separate file identity domain.

Repeated records can carry different process fields or content. Neither timestamp order alone nor `parentUuid` identifies them. The fresh record after a repeated run can name its repeated predecessor. Readers never follow that link as genuine lineage.

`clauderepeated.ts` owns detection, revision-bound maps, resumable lookups, and read budgets. Window readers must use whole-file evidence because an original can precede their window. Selected forward and history reads wait for covering evidence. Bounded metadata and search reads omit unclassified identities while coverage continues. Blank omitted lines without changing byte offsets, and retain accepted display facts until replacement facts arrive.

Map validation samples bytes and assumes append-only transcripts. It cannot detect a rewrite preserving identity, size, and modification time. Growth with unchanged sampled bytes also conceals edits between samples. Do not describe those checks as complete rewrite detection.

### Claude preserved segments

A kept compaction's first prompt can name `compactMetadata.preservedSegment.tailUuid` from before its boundary. After reading that boundary, the lineage check excludes both preserved segment endpoints from abandoned-compaction evidence. The first new typed prompt or billed request decides abandonment. A deciding record read before the boundary still revokes the compaction when it names that tail. Missing or unknown parents keep it counted. Revoking a compaction does not revoke its summary request's cost.

The timeline retains readable summaries independently of usage revocation. Compactions remain ordered boundaries among turns. Readable carried-over text stays collapsed. An encrypted replacement without a recorded size remains unreadable with unknown size. A boundary without a body stays visible without an expansion control.

Codex infers an automatic compaction only from normal work in an active non-replayed turn. A known empty dedicated turn implies manual compaction. A missing start or replay leaves the reason unknown. Context size establishes no trigger. [Accounting](accounting.md#accounting-contracts) owns compaction request usage and context figures.
