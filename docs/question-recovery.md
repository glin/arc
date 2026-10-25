# Questions and recovery

Use this guide for live asynchronous questions, saved questions, and answers after child loss. [`questionrecovery.ts`](../extension/src/questionrecovery.ts) owns persistence. Wire adapters own current requests.

## Recovery and delivery

Capture questions in workspace storage independently of children. Permissions have no restart recovery. Failed capture leaves the live question answerable and reports the save failure. Attempt and outcome saves can both fail during live answering. Saved state can then remain unanswered even after delivery. Never retry automatically. Readers must check the session before answering saved questions again.

A saved Codex question can return after child exit without editor restart. Restored Arc tabs also expose saved questions. Preserve the recovery origin in webview state. Without a restored tab, restart leaves those questions unavailable. Immutable lease successors grant one replacement activation delivery ownership after predecessor release or proven process death. Another origin cannot acquire an absent activation's questions. Unknown process liveness blocks recovered delivery. Live answering remains independent of recovery ownership.

Preserve source identity and original question indexes separately from transport IDs. Match fresh native requests by source identity and answer through their current transport. Repeated wording with another identity is a separate request. Unmatched current requests block contextual answers to older questions. Transcript-only questions never become actionable.

A reader answer explicitly resumes a stopped session. Recovered Codex async answers use their original envelope in a new prompt. Other nonsecret questions use identified contextual answers without a fresh native request. Secret answers require fresh native requests and never enter saved answers or recovery prompts.

Persist recovered attempts before provider input. Confirmed acceptance settles delivery. Unknown delivery blocks another submission. Completed live answers stay hidden in their capturing activation. Replacement exposes remaining unknown delivery. Exact source evidence reconciles captured identities, including another client's Codex answers. Claude shutdown interruptions leave captured questions unresolved. Clear and Codex `/new` durably close predecessor questions before resetting.

## Codex asynchronous questions

`delivery: async` identifies messages returned without ending the model's turn, including items with `phase: final_answer`. Exclude them from response text and turn outcomes. At least one titled `questions` entry creates an ask and completes the streamed Activity row. Without titled questions, create one Activity row. Retain that row while the turn's live Activity remains.

Question IDs are JSON text of `["request_user_input_async", itemId, index]`. Keep original indexes when answering only part of an ask. Async questions survive turn completion because no server request waits for their answer. [`codexreply.ts`](../extension/src/codexreply.ts) owns the reply envelope:

```text
<send_user_message_question_reply>
[{"questionItemId":"QUESTION_ID","question":"QUESTION","answer":"ANSWER"}]
</send_user_message_question_reply>
```

Each answer joins picked labels and written text with commas. Send through `turn/steer` while the question's turn runs. After completion or definite steer refusal, send the same text as a new prompt on the original thread. Both paths wait for skill admission. Stop cancels unsent answers through admission, steer refusal, and fallback preparation. Stopped unsent answers, admission failure before input, and prompt refusal offer the question again and release delivery state. Unknown steer or prompt delivery never retries.

A new thread closes earlier-thread questions. Dismissal sends nothing. An envelope-only user message answers named questions, including replies from another client. Close an ask only when all its questions settle. Surrounding text makes a message ordinary prompt text.

Saved async items use `event_msg` / `item_completed` with `AgentMessage`, `delivery: "async"`, `phase: "final_answer"`, and `questions`. The adjacent `function_call` is not a repeated response. No `response_item` repeats the text, and `task_complete.last_agent_message` excludes it. `codex.ts` projects the item as Activity under its item ID. Envelope-only user records display question/answer text in prompts, later prompts, and titles.

## Synchronous questions

The panel omits `collaborationMode` on `turn/start`. Codex refuses synchronous `request_user_input` in default mode and uses prose instead. Synchronous question cards therefore come from another client's thread. Async questions also work on panel-started threads. The server accepts answers outside offered options unchanged. The tool schema excludes Other because the client supplies free text.

Codex questions carry `isSecret` and `isOther`. Read `isSecret` to hide secret answers on answer tabs. Ignore `isOther` and offer written answers on every question.

## Question recovery contracts

Store captured payloads, dispositions, settled identity barriers, and activation leases beneath the workspace partition. Claims stay exclusive across windows. Unresolved and unknown entries never enter age or history eviction. Separate evidence cursors from ordinary transcript reads.

Each waiting publication checks ownership once and indexes captured tool identities. Reuse provider/exact-raw-session source lookups, including misses, only within one synchronous publication. Resolve them again for later publications and answer-time checks. Keep store snapshots and ownership checks independent of this reuse.

Identified Claude context replies have a 2 MiB frame limit and five-second deadline. Check complete reordered envelopes before parsing. Framing buffers and unrelated stdout remain unbounded.

Question Markdown preparation caps combined request text at 64 KiB before parsing. Larger requests retain complete escaped text. Its process-local cache retains at most 16 entries and 1 MiB of keys and rendered content. Keep answer identity outside that cache.

Use `agenthost.test.ts` for saved identity, leases, unknown delivery, secrets, and reset closure. Use `codexwire.test.ts` and `codex.test.ts` for async wire and disk behavior.
