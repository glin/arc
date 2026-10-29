# Agent protocols and runtime

[`agentwire.ts`](../extension/src/agentwire.ts) defines the shared host and prompt box types. [`claudewire.ts`](../extension/src/claudewire.ts) and [`codexwire.ts`](../extension/src/codexwire.ts) translate provider protocols. The [reading guide](architecture.md#reading-guide) routes changes across launch, skill and snapshot hook, question, compaction, and standalone contracts.

## Runtime shape

Each session's child belongs to its launching window and communicates over stdio. Other windows read its disk record. Session identity survives child exit. The next prompt resumes that identity from disk.

Control-only children start no session. Opening Servers on a Claude draft retains its provisional child through status refreshes and the first prompt. [`agenthost.ts`](../extension/src/agenthost.ts) owns control-child reuse and cleanup.

Resumes, compactions, and handoffs use the session's recorded working directory, including sessions discovered in another worktree. Unrelated new work uses the editor's open folder. A new child can announce identity before its disk record exists. Retain the selected synthetic row until discovery replaces it.

## Shared vocabulary

Prompt assets name staged files, never reader-selected originals. [`agentwire.ts`](../extension/src/agentwire.ts) owns prompt normalization.

Retain stable source identities so recorded activity replaces live activity. Unknown tool inputs contribute only safe subject fields through `activitydetail.ts`. Unknown protocol messages must not block the line reader.

## Claude stream-json

[`claudewire.ts`](../extension/src/claudewire.ts) uses the [launch flags](agent-launches.md#agent-launch-commands). Control replies share stdout with turn events. Match replies by request ID and expire unanswered controls. Seed resumed session identity before output arrives.

Claude permission and `AskUserQuestion` requests require stdio permission routing. Question answers allow the tool request with an answers map keyed by question text. Denials include the reader's reason.

Classify completed assistant messages, not partial deltas. [`claudewire.ts`](../extension/src/claudewire.ts) owns response and Activity projection. JPEG, PNG, GIF, and WebP become base64 image blocks. PDFs become document blocks, and text media types become UTF-8 documents. Reject other binary types before acceptance. Base64 stays inside the wire envelope, outside saved prompt box state and webview messages.

Local command results carry `num_turns: 0` and null `stop_reason`. Model work reports positive turns. Keep local command settlement separate from model completion. [Timeline parsing](timeline.md#shared-turn-model) owns whether recorded command scaffolding opens or withdraws a turn.

### Clear identity

`/clear` keeps the child and switches to a new transcript. The old transcript stays resumable. The CLI emits `conversation_reset`, followed by `system/init`. Read successor identity from that init. The reset's `new_conversation_id` does not name the transcript. `system/init` repeats for local commands, so only a changed session ID establishes a successor.

### Guarded receipts

Every hosted child uses `--replay-user-messages`. Guarded follow-ups and continuations carry a client UUID and start native submissions. Acceptance requires a root replay with that UUID, the same session, and exact text. Replay frames never enter display.

An idle follow-up without its replay remains unknown after a result or idle report. Live input retains its receipt window across both. Exit or 120 seconds without a matching replay leaves delivery unknown. A slash replay transfers model ownership only after root model output names that input UUID.

Positive model turns establish participating model completion. A zero-model result with usable retained participant generations settles only those inputs. Preserve unnamed inputs and unrelated model work. Without usable correlation or local command identity, apply generic completion. Local results settle their matching command and preserve a valid delayed replay. [Native ownership](session-compaction.md#native-turn-and-compaction-contracts) defines host attribution.

## Claude Remote Control

`remote_control` sends an `enabled` boolean and starts no turn. Require `remote_control_available: true` in initialize. Ignore auto-enable fields. The toggle uses only this window's live Claude child. Refuse drafts and absent children. Send the toggle to agent runs and to children with fixed read-only permissions like any other child. Start no child for a toggle.

Enable replies carry `session_url`, `connect_url`, `bridge_epoch`, and `bridge_session_id`. Retain the epoch for failure matching. Bridge identity never replaces local identity. Disable replies carry no fields. Errors retain prior state. [Prompt delivery](prompt-delivery.md#local-controls) owns link presentation.

A control timeout retains the request ID and becomes uncertain. A late reply settles it. Refuse further toggles while pending or uncertain. Never retry automatically.

`bridge_state` failures `failed` and `policy_disabled` disconnect unless both epochs exist and differ. Retain failures received during pending or uncertain toggles. Apply that epoch check against a later successful enable reply. Ignore other bridge states. Close sets off and ignores late replies. Remote prompts and permission answers use ordinary stream events.

## Codex app-server

[`codexwire.ts`](../extension/src/codexwire.ts) translates JSON-RPC over stdio. Server requests contain a method and `id`. ID `0` is valid. Notifications have no request ID.

Start or resume establishes the thread. `turn/start` acceptance establishes prompt delivery and supplies the authoritative active turn ID. Stop waits for a pending start response, then interrupts the owning thread and oldest unfinished turn. Submissions with one server turn ID finish together. Late completions cannot disarm newer turns.

Clear and `/new` start a thread with current settings. `/new` passes its optional same-line name to `thread/name/set`. The session event carries the predecessor ID for reset ownership. Another client's exclusive rollout writer requires continuation through a fork. Send subsequent input to the returned thread.

File approvals name an item ID, without paths. Join the active `fileChange` item and republish an ask when details arrive later. Answer with the original server request ID. Live changes are arrays, while saved rollout changes are object maps.

[`codexwire.ts`](../extension/src/codexwire.ts) owns text, Activity, and reasoning-summary projection. [Asynchronous messages](question-recovery.md#codex-asynchronous-questions) follow separate answer rules.

Images use `localImage`. Other files use `mention` with display name and staged path. Requests contain paths and metadata, never file bytes. Check the saved SHA-256 digest before delivery. Retain staged files until the turn ends.

### Explicit Codex service tiers

An explicit tier travels through thread start, resume, fork, and subsequent turns. Arc checks the live model catalog from that child. `serviceTiers` takes precedence over the legacy `additionalSpeedTiers` list. Legacy `fast` means `priority`. Standard `default` needs no catalog entry. Missing nonstandard support refuses input. Opening replies must report the requested canonical `serviceTier`. Missing, null, or different acceptance refuses before any prompt. Model changes trigger another capability check before input. Each prompt keeps one model through its capability check, submission, and acceptance. Selections made during that check apply to later prompts. Clearing the selection retains the model from the latest accepted submission in send order. A rejected submission does not replace that model. Omitted tiers require neither catalog support nor acceptance metadata.

### Guarded input

Live input uses `turn/steer` with exactly one eligible running root and its expected turn ID. Acceptance requires the same returned ID. It creates no submission or completion owner. Ambiguous roots block it, and so do the compaction states in [Session compaction](session-compaction.md). Uncertain writes stay unknown and never enter the queue automatically.

A guarded follow-up requires its own `turn/start` acceptance. A returned ID known before writing, or held by another pending start, identifies shared work. Its outcome stays unknown and its assignment becomes stale. Post-write errors also stay unknown. Unanswered compaction withholds idle evidence until its late turn ends.

## Session rename

Each provider persists names. Arc never edits transcript records, title files, or indexes. Serialize renames per session through [`agenthost.ts`](../extension/src/agenthost.ts). Renames start no model turn. A Claude control rename applies while a turn runs. Typed `/rename` waits because the CLI reads it after the turn ends.

Claude uses `rename_session` with the resolved session ID and `source: host`. A different current session, unanswered control, or provider refusal fails the rename. Late replies settle nothing. An existing rename also requires the whole saved `<transcript directory>/<session id>/custom-title.json` value to match. Claude can report success without saving it.

Read at most 4 KiB of that sidecar. Initial naming also accepts the newest complete matching `custom-title` in a 16 KiB transcript tail, ahead of the sidecar. Check at most six times, 50 ms apart, only during renaming. Initial confirmation requires the accepted transcript. Its cwd establishes membership, or an exact project slug when cwd is missing. Multiple matches refuse confirmation.

Codex uses `thread/name/set`, including typed `/rename`, and returns provider refusals. Initial naming persists an activation-owned operation before launch acknowledgment. Only an exact-session empty-rollout refusal permits recovery. Qualified metadata changes wake at most 40 requests, independently of panel visibility and catalog admission. Each keeps its provider control deadline. Other naming failures retain launch acceptance.

Persist requested and confirmed initial-name states separately, outside browser state. Save a possible-write marker before provider submission. Reload cancels proven-unsent operations and retains possible writes as uncertain, without replay. Reader renames synchronously supersede pending initial names. `InitialNameOperation` in [`sessionrename.ts`](../extension/src/sessionrename.ts) owns title comparisons. [`PanelHost`](../extension/src/panelhost.ts) cancels an initial name when the session is archived, leaves the panel scope, or the panel is disposed. [`AgentHost`](../extension/src/agenthost.ts) orders initial and explicit renames.

Without a live child, Claude resumes in the recorded directory and sends only the rename control. Codex handshakes and sends only `thread/name/set`, without opening the thread. Both rename-only children close afterward, including on failure.

## Child ownership and shutdown

[`AgentHost`](../extension/src/agenthost.ts) serializes openings by host key and provider session ID. Replacement and rename-only writers wait for confirmed prior exit, including IDs adopted under fresh keys. Termination requests do not release that barrier. Disposal refuses pending and later openings.

Arc publishes restored archive membership at startup, every later change, and an empty set after a workspace clears. `AgentHost` acts only on complete sets. Idle and archive retirement wait for the latest turn-end usage and MCP reads from [`extension.ts`](../extension/src/extension.ts). Prompt and control activity must hold a lease before work. [`AgentHost`](../extension/src/agenthost.ts) owns eligibility, generations, and the `arc.agentIdleMinutes` timer.

Identified background launches hold idle, archive, and targeted retirement until identified terminal completion. Missing reads, source replacement, later turns, display expiry, Stop, and unknown notices never release those holds. Unresolved work retains its child indefinitely.

Remote Control states except off prevent unarchived idle retirement. Returning off starts a fresh idle window. Archive, targeted retirement, and shutdown ignore that Remote Control hold. Closing input precedes termination after the grace period. Arc never signals processes the child started.

Abandoning a draft or closing the last panel retires retained draft MCP children. Retirement preserves saved identity and accepted settings for resume.

Agent-wide permission and MCP changes lease every target before the first await. MCP leases last through the final status read. Build replacement settings after prior exit. Preserve provisional draft settings during publication. A fork stores its accepted profile under the returned identity. [Catalogs and applied defaults](session-setup.md#catalogs-and-applied-defaults) owns draft profile acceptance.

## Settings and control reads

Claude changes models through controls, but effort uses `/effort <level>`. Book its local command turn before writing. Hold effort picks during work and deliver the latest pick before the next reader prompt, including after accepted Stop. Drop unavailable levels and clear the child's held pick. The previous applied level stays until another command applies. Read applied effort from the next assistant record. Codex sends model and effort with the next turn and confirms them through its rollout.

Codex approval policy, reviewer, and sandbox are separate fields. `on-request` still asks the reader without the automatic reviewer. Match all three fields before displaying a preset. Translate thread-start and turn-start sandbox spellings. Custom combinations retain both approval behavior and access boundary.

An empty permission value means no Arc override. A live selection retires every child for that agent before subsequent input. Claude then omits `--permission-mode`. Codex omits `approvalPolicy`, `approvalsReviewer`, and `sandbox` on starts and turns. Each provider applies its configuration and policy. Configuration reads for [session tools](native-skills.md#checks-before-startup-and-input) and [metadata discovery](session-setup.md#catalogs-and-applied-defaults) remain separate from permission overrides.

[`composerview.ts`](../extension/src/composerview.ts) owns permission-control projection and setup inheritance.

### Account reads

Usage and rate limits are provider snapshots, separate from local turn totals. Claude account resets use ISO timestamps. Live rate-limit resets use Unix seconds. The monthly money cap has no reset. Idle children cannot read another process's response headers. Claude reports Max without its multiplier, because Arc does not read the local auth profile. Persist live reset windows in workspace state until their reset times pass. Codex model-bucket names remain part of limit identity, separate from account aggregates.

Serialize account reads per agent. Share requests only for the same session or draft MCP owner. Start selected-owner reads in its recorded directory. Codex caches account eligibility per process. Explicit Read again rediscovers eligibility before supported managed-auth renewal. Fresh idle children also renew on supported explicit reads. Long-lived children retain their opening credentials.

When all children work, account reads wait without interrupting them or changing active authentication. Discovery revisions reject obsolete replies. Source identities reject obsolete notifications. Rejected usage admission does not invalidate model catalogs. [`extension.ts`](../extension/src/extension.ts) owns idle-source selection.

Explicit attempts have a 120-second deadline from acceptance, including queue and busy waits. Expired attempts cannot dispatch unsent reads. Sent reads retain ownership until settlement. Retry joins them without another authentication renewal. Late supported readings update figures without changing expired outcomes.

Account-read ownership and deadlines remain independent of catalogs, commands, and MCP reads. Older catalog completions cannot release newer reads. `UsageReadQueue` in [`agenthost.ts`](../extension/src/agenthost.ts) owns attempt settlement. Model catalogs must follow every `nextCursor` under `data`.

## Hosted read-only launches

[`launchpolicy.ts`](../extension/src/launchpolicy.ts) defines restrictions. [`launchpolicystore.ts`](../extension/src/launchpolicystore.ts) persists them per session in shared Arc storage, without eviction. Editor windows sharing an Arc home share policies. Unreadable restrictions block continuation. Apply live restrictions during opening and persist successor restrictions before moving panel ownership. Clear, fork, replacement, follow-ups, and permission changes must retain them. Agent-wide permission picks refuse before changing defaults or retiring a restricted child.

Codex starts, resumes, forks, and turns with approval `never`, reviewer `user`, and a read-only sandbox. Threads use `read-only`, while turns use `readOnly`. Provider rejection prevents input. The sandbox denies filesystem writes and establishes no denial of external MCP effects.

Claude disables permission prompts, user/project/local setting sources, and hooks. It isolates MCP configuration and allows Read, Grep, and Glob. [`claudeReadOnlyArgs`](../extension/src/launchpolicy.ts) owns the complete denied tool and git-command lists. Plain read-only launches deny PowerShell. Bash uses auto mode on supported models and `dontAsk` otherwise. Auto mode can approve shell writes, so Claude provides no filesystem immutability guarantee. A Remote Control client can change the permission mode of a running child. Claude refuses `bypassPermissions` because the launch omits `--dangerously-skip-permissions`. A switch from `dontAsk` to `acceptEdits` lets Bash write files. Claude reports the new mode in a `status` message and in the `init` message of the next turn.

Git denials cover exact verbs and arguments, optional `-C` directories, argument-bearing branch/notes/remote/tag operations, and `--output`. Keep the generated rules with their source lists. [Policy tests](../extension/src/launchpolicy.test.ts) cover isolated permissions and exact MCP reads.

Exact MCP launches use `dontAsk`, deny both shells, and accept exact tool names without wildcards. Copy selected definitions from user, project, and local configurations, with local then project then user precedence. Project `.mcp.json` comes from the enclosing Git root, or launch directory outside Git. User/local `.claude.json` comes from `CLAUDE_CONFIG_DIR`, or the home directory. Each file has a four MiB limit. Oversized files or missing definitions prevent launch. Exclude inherited grants, hooks, plugin servers, and claude.ai connectors.

## Restricted successor contracts

Restricted clear and Codex fork exclusively create `launch-policies/pending-clear.json` at the transport's pre-write boundary. Admit one operation per Arc home. Only positive refusal before attempted input cancels a matching reservation while its child stays current and live. Unknown attempted input retains the marker. Generic Codex RPC errors retain it because they do not prove noncreation.

The marker blocks continuation without saved policies across windows and restarts. It also blocks further restricted clears and Codex forks. Saved-policy sessions, fresh launches, held children, ordinary live events, and permission inspection retain their existing policies or behavior.

Confirmation requires the owning child's token and instance, a distinct successor, and identical saved policies. Claude confirms through `init`, excluding intermediate reset identity. Codex confirms its session event after policy persistence. Save or confirmation failure retains the marker without expiry. A later Claude `init` from the same child retries. Successful recovery replays its deferred panel transition.

Child exit removes local confirmation authority and the deferred transition, preserving durable refusal. Stale output and replacement children cannot confirm. Resume the saved source with its exact policy, or start fresh. Saving that policy under a successor permits only that successor's continuation. It does not unblock unrelated identities. Transcript absence and timestamps never establish non-delivery. Policy lookup reads one bounded file. Continuation checks the marker only without a saved policy and scans no other sessions.

## Failure interpretation

Both adapters recognize interruption before classifying provider failure records. A nonzero command exit is failed activity, without necessarily failing its turn. Preserve Codex causes supplied as strings, message objects, or turn errors. Launch, handshake, control, and prompt deadlines remain separate so failures identify the relevant action.

Claude Code's background host runs each `claude --bg` session. A second Claude process that resumes one of those sessions exits with code 1 before it answers the opening exchange. Its stderr says that the session is running in the background. Arc therefore cannot open its own child for such a session. When Arc's Claude child closes before the operation that opened it, `AgentHost.withSessionActivity` names `claude attach` and `claude stop` if that stderr says so. Otherwise it reads the first 1 MiB of the session's transcript through the `recoverySource` port. A top-level `sessionKind: 'bg'` record there adds the same commands as a condition. `PanelProvider.sendAgentMessage` and `PanelProvider.queueAgentMessage` add the conditional commands to their refusal when such a session has no Arc child. The commands take the 8-character short id that `claude --bg` prints, and `claude stop` refuses the full session id. A session stopped with `claude stop` keeps `sessionKind: 'bg'` in its transcript, so that record alone does not show that the background host holds the session.

## Verification

Use `claudewire.test.ts` and `codexwire.test.ts` for translation, and `agenthost.test.ts` for child ownership and races. Use `transcript.test.ts` and `codex.test.ts` for disk interpretation.
