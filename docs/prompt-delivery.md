# Prompt delivery and recovery

[`panelhost.ts`](../extension/src/panelhost.ts) owns admission and persistence. [`composerview.ts`](../extension/src/composerview.ts) projects delivery state. [Agent protocols](agent-protocols.md) owns native wire contracts.

## Sending, queueing, and stopping

[`webview/composer.ts`](../extension/src/webview/composer.ts) handles Send and Stop keys. The panel-wide send chord uses Command+Enter on macOS and Ctrl+Enter on Windows and Linux. Other editable controls and open comment editors retain their keys. Every Stop targets the message's session.

Busy delivery bypasses local queueing only when the queue is empty, preserving order. A Claude answer to an open request instead joins the running turn before queued work.

A waiting entry owns its text, comment claims, files, and delivery state. Edit swaps the complete entry with the complete active draft. The host reserves the entry before the browser replaces text. A newer browser edit rejects delayed success and releases the reservation. Returned comment claims stay persisted until the edited prompt is queued or accepted.

Prompt assembly places typed text before comments. Codex retains surrounding whitespace through queueing and delivery. Claude receives trimmed text. Settings travel through controls, never inside prompt text.

## Compaction and reset

Native compaction bypasses prompt assembly, comments, and ordinary prompt callbacks. Context detail's Compact leaves the draft unchanged. A queued `/compact` with comment claims or files uses ordinary prompt delivery to retain that payload. Codex rejects `turn/start` during native compaction, so new prompts wait locally too.

Clear starts no turn and draws no temporary card on success. Codex `/new` uses the same transition and passes its optional name to the successor. Before resetting, the queue owns the command's files and comment claims. Unclaimed source comments are captured immediately before the control request. These commands never become model input.

The transition needs acceptance and a successor identity. Claude reports acceptance first. Codex reports the successor first. Success moves the payload and dependent prompts before draining the successor queue. The source retains its transcript, comments, labels, and session list row.

A queued Codex `/new` failure keeps its payload as source recovery. A failed queued reset carrying comments or files does likewise. Both block dependent prompts until Edit or Drop resolves recovery. Other failed resets release the source queue.

Reload converts an in-flight reset to unknown and starts no work. A recorded successor retains ownership through refusal, failure, Edit, Drop, and reload. Stale panel submissions follow that successor until the panel paints it. Afterward the source is independently selectable.

Codex-compaction queueing requires durable capacity for the whole submission, including attachment-only prompts, without truncation or eviction. Reload restores the queue before draining it.

Persist an attempt before crossing the agent boundary. Reload converts active attempts to recovery and never resubmits them automatically because the agent can already have received them. Edit explicitly retries. Reset-recovery edits retain a hidden durable barrier until the edited draft is accepted. [Attachments](prompt-attachments.md#storage-and-acceptance) owns staged-file lifetime.

## Agent messages

Deferred agent messages share the queue but carry no comments or files and change neither drafts nor prompt history. Reset and reload retain them in recovery on the original session.

## Pending cards

[`webview/queue-live.ts`](../extension/src/webview/queue-live.ts) renders waiting and live cards. [`composerview.ts`](../extension/src/composerview.ts)'s `livePressOver` owns removal.

Prompt cards leave only when an accepted selected window contains their recorded turn or the CLI answers a command without a turn. Stale, aborted, and superseded reads must retain streamed responses. Unknown-delivery explanations must not suggest retrying because receipt remains uncertain.

Manual compaction is running work. Only prompts accepted behind it say they are waiting for earlier work. Failed compaction retains its cause until Dismiss. Unfailed compaction cards expire after five minutes only while idle. Running controls retain their cards past that limit.

Accepting Codex writer-lock recovery moves the continuation prompt to the server's forked session. Declining retains the source failure.

Continuation handoffs move submissions to the new session. Queued handoff failures return them to waiting cards.

## Local controls

[`composerview.ts`](../extension/src/composerview.ts) classifies `/compact`, `/clear`, and Codex `/new`. Exact controls ignore case and surrounding whitespace. Only `/new` accepts a same-line name. Mentions inside sentences and `/safe-compact` remain ordinary input. Codex controls use native app-server requests, except queued `/compact` submissions carrying comments or files.

[`domain/composer-editing.ts`](../extension/src/domain/composer-editing.ts) shares Codex `/rename` and Claude `/remote-control` or `/rc` recognition between browser and host. They bypass running work and staging without answering requests or carrying files and comments. Claude sends `/rename` to its CLI.

Remote Control refuses trailing text, including newlines. Fresh refusal restores the line. Queued refusal retains the entry and blocks later entries until Edit or Drop. Queued toggles return comments and files to the prompt box. Files that do not fit leave the entry queued and block later entries.

[`composerview.ts`](../extension/src/composerview.ts)'s `remoteControlLink` admits only HTTPS links without whitespace or Markdown link delimiters. Notifications percent-encode square brackets in rejected URLs because VS Code ignores Markdown escapes. [Remote Control](agent-protocols.md#claude-remote-control) owns eligibility refusals.

## Delivery and recovery contracts

Agent input uses `sendAgentMessage` for guarded idle or live delivery and `queueAgentMessage` for explicit queueing or temporary blockers. Reservations serialize ordinary input, observed follow-ups, and queue drains through native receipts. Bindings name one activation-local child. Agent queue heads drain before reader prompt assembly.

A Send that the host returns to the prompt box without delivery shows why in the prompt box notice. After a repository scope change, the accepted catalog keeps the previous roots until a walk under the new roots is accepted. During that walk, a prompt box Send still reaches a session that the previous catalog admitted when its recorded working directory is inside the current roots. Other unknown membership refuses the Send.

Wait for temporary panel work before persisting agent attempts. Ordered deletion must follow concurrent saves before refusal is confirmed. Uncertain deletion retains recovery. Reload never restores child authority, so saved agent messages become recovery. Unknown-delivery blocks apply to both input forms.

Queue edits and live recovery advance draft ownership before replacing text. Live recovery advances beyond typing and pending submissions. Adoption carries ownership forward. Suspended submissions reserve text, comments, and files against swaps while later drafts remain independent.

Host draft replacements cancel pending rename restoration. Delayed rename registration respects current ownership. Submission continuations refresh running and control state without changing captured prompt inputs.
