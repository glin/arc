# Session compaction

[`compactrequest.ts`](../extension/src/compactrequest.ts) owns admission and delivery. [`compactstore.ts`](../extension/src/compactstore.ts) owns saved receipts.

## Provider operations

Claude uses its initialized `/compact` command. Book a local command turn before writing, without attached comments or prompt text. [Prompt delivery](prompt-delivery.md#compaction-and-reset) owns queued submissions with comments or files. `/effort` also owns a local result. A command result must not close unrelated model work.

Codex uses `thread/compact/start` on the established thread. Literal `/compact` through `turn/start` reaches the model or a similarly named skill. The empty RPC response acknowledges acceptance alone. Remain busy until native turn completion or failure. Hold prompts and further compaction until termination.

Track active compaction items separately from roots containing them. Completed automatic compaction preserves ordinary root-ending attribution and permits live input in that root. Manual and unresolved compaction block live input.

Codex rollout compaction usage comes only from `latest_token_usage_record.usage`, with optional model and billing route from the following `thread_settings_applied`. Never derive it from cumulative counters. Codex records no trigger. Non-replayed ordinary work before the boundary indicates automatic compaction. A known empty dedicated turn indicates manual compaction. Incomplete starts stay unknown. Context size supplies no trigger evidence.

## Codex compaction receipts

Each request retains its generation and RPC ID independently of native turn identity. Acknowledgment alone supplies no completion. Unattributed accepted operations release their caller after 60 seconds as unknown. Known running turns retain busy state and Stop targets until native termination, including after timeout or before acknowledgment.

Late refusals release matching unbound unanswered receipts. Bound turns survive caller errors. Conflicting refusal and turn evidence stays unknown. Isolated unanswered requests retain late turn evidence. Overlapping unbound requests cannot attribute a new turn because native events carry no request ID. Exact refusals release ambiguity only without remaining candidate or unidentified active turns.

Retain at most eight unanswered receipts. At capacity, refuse deferred input before writing. Reader compaction still writes while preserving deferred and bound receipts. Dropping an unbound reader receipt, or having no room, withholds new attribution until thread replacement. Existing bound turns retain completion evidence. Unresolved identity blocks deferred delivery until replacement. Run the synchronous compaction callback before provider input.

## Native turn and compaction contracts

Native evidence retains session, tool, literal command, and successful settlement separately from display Activity. Claude also retains submission generations, root tool envelopes, direct callers, result UUIDs, and result indexes. Codex requires exact thread and turn identities.

Claude live prompts join shared model work rather than receiving independent results. Native `session_state_changed` events establish running, requires-action, and idle state. Model completion and idle settle joined submissions, release settled attachments, and drain the queue. Preparing prompts stay open. Background tasks do not hold `/compact`. Accepted Stop establishes idle before its aborted result. That result supplies no model completion for a subsequently sent command. Without state reports, results remain the turn-ending evidence.

Earlier idle reports cannot close newer agent-started work. Subagent text never creates a root owner. `AgentSession` in [`agenthost.ts`](../extension/src/agenthost.ts) owns creation, transfer, and settlement of agent-started work. [Claude receipts](agent-protocols.md#guarded-receipts) defines replay settlement.

Codex root evidence without a pending submission creates a provider-originated owner under its exact thread and turn. Preserve early events in arrival order until pending starts settle. Accepted starts retain their reader owner. Unrelated turns retain their reader revision and child generation. Dispatch ownership remains separate from panel response ownership.

Accepted Claude Stop retains submission identity for qualified interrupted dispatch endings. `aborted_streaming` and `aborted_tools` identify abandoned work. Later prompts end with `completed`. Cancelled queued prompts have no result. Bound the owed ending with `STOP_ENDING_GRACE_MS`. Idle or expiry clears retained identity. Recorded turns ending after the child became busy also bound its session-list authority.

## Agent-requested compaction

Keep self-compaction outside queued prompts. Freeze session, turn, tool, child generation, source, activation, and reader revision when observing the command. Initiating evidence supplies intent independently of reader submissions or notification ancestry.

Codex admits live agent commands without PTY identity and unified-exec startup commands with process identity. Execution mode alone establishes no caller. Exclude user-shell commands, unified-exec interactions, unknown sources, and settled commands. Require the literal command and exact session and turn.

Admit one pending request per exact turn within active capacity. Repeated requests consume no assignment allowance. Activation-wide native-call and request-ID tombstones prevent replay and grow until disposal. Evict terminal entries before refusing active capacity. Active operations have no execution deadline. Retain active native bindings across later requests in the same child.

Require successful tool settlement, exact-turn success, and a retained final response independently. A running call can retain completion and response before admission. Claude background acknowledgments bind task IDs without settling commands. Only matching terminal notices settle them. Parse user-form notices with the shared strict task-tag parser. System notices use structured fields. Retain root tool owners across later turns. Synchronous endings follow the current shared response owner. Retain direct Bash starts because results can establish background execution.

### Reader actions and delivery

Stop, compact, answers, setting picks, and slash commands cancel unsubmitted work and suppress continuation. Reader sends and queued delivery carry pending work instead. Answers keep the reader revision because they can approve the initiating tool. `readerAction` in [`compactrequest.ts`](../extension/src/compactrequest.ts) owns revision changes and carry rebinding.

Retained and delivered reader sends hold compaction. Unknown membership defers release until row refresh. Dropping the final undelivered send releases its hold and schedules delivery checks. Claude prompt writes advance native generation, including prompts joining running work. `readerPrompt()` appends the request-identifying carry line to delivered text only. Saved drafts and queues retain original text.

`arc compact cancel` requires the requesting session's exact observed cancel command in a live root tool call. Answers can approve that tool before admission. Scope changes pause delivery until refreshed rows confirm membership. Confirmed scope loss cancels pending work.

Continuation waits for positive idle evidence and no unresolved native compaction on the retained child. Hold its activity lease, save preparation and possible input, and recheck authority synchronously beside writing. Deliver only the saved agent-authored text through ordinary submission bookkeeping. Never enqueue it as `QueuedSubmission`. Exit or replacement makes submitted unresolved work uncertain, releases active capacity, and rejects late old-child evidence. Never retry possible input automatically. Accepted continuation confirms exact prompt acknowledgment, without establishing task completion.

### Recorded response recovery

Provider-originated turns have no reader card. `RecordedReplies` in [`sessionreads.ts`](../extension/src/sessionreads.ts) waits for their responses to appear in recorded turns. It matches exact native turn and assistant source ID independently of callback lifetime.

Freeze each source extent. Forward reads, anchors, and Claude duplicate lookup share one read allowance. Duplicate lookup trades repeated prefix reads for bounded storage. `RECORDED_REPLY_LIMITS` and `RecordedReplies.read` own read quanta and parser limits.

Recovery uses provider answer reducers, including their Claude handback and repeated-notice rules. Codex explicit reads retain final text and assistant IDs. Only current wanted-generation and catalog-revision jobs establish complete coverage. Payload-limit failures leave callbacks pending for that revision. Source and scope still guard delivery. Successful turns wait for responses while their retained child stays live.

## Continuation storage

Version-1 receipts use opaque `assignmentId` values for child generation and native turn, without reader permission meaning. Serialize filesystem and activation-lease checks. Pressure evicts eligible terminal receipts from current or conclusively ended owners. Protect active receipts, possible writes, unfamiliar files, and live foreign owners. Terminal retention starts at settlement and sets a maximum lifetime.

Publish complete fsynced staging files through exclusive hard links. Unsupported hard links refuse writes. Unknown or malformed authoritative leases block ownership. Release or proven process death permits a successor writer, without execution authority. Nonholders only read. Count and byte bounds limit cleanup. Unfinished or unfamiliar files refuse admission. Pathname checks supply no sandbox against external concurrent replacement.

Reload cancels unattempted continuation and preserves possible input as uncertain, including write exceptions before written bookkeeping. Never resume saved work automatically. Status computes restart outcomes without writes and exposes saved text only under current exact-source authority.

[`agenthost.ts`](../extension/src/agenthost.ts) retains unresolved background work through root launches and identified terminal notices. Accepted matching metadata adds holds. [Child retirement](agent-protocols.md#child-ownership-and-shutdown) owns their lifetime consequences. Use `compactrequest.test.ts` and `agenthost.test.ts` for admission, carry, cancellation, and recovery races.
