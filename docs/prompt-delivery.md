# Prompt delivery and recovery

Read this guide for Send, Stop, queued submissions, reset, or live-card recovery. [`panelhost.ts`](../extension/src/panelhost.ts) owns admission and persistence. [`composerview.ts`](../extension/src/composerview.ts) projects delivery state. [Agent protocols](agent-protocols.md) owns native wire contracts.

## Sending, queueing, and stopping

Enter sends and Shift+Enter inserts a line break. Command+Enter on macOS, or Ctrl+Enter on Windows and Linux, sends from anywhere in the panel. Other editable controls and open comment editors retain their keys. Enter in a comment editor saves its comment. Blank text sends only with unsent comments or attachments.

Idle delivery starts or reuses the child. Busy delivery bypasses local queueing only when the queue is empty. A Claude answer to an open request instead joins the running turn before queued work.

Each local waiting entry owns its identity, text, comment claims, files, creation time, and delivery state. Its Edit action swaps the complete entry with the complete active draft. Text, comments, and files remain separate on each side. Reset-recovery edits leave a hidden durable barrier until the edited draft is accepted.

The host reserves an entry before the browser replaces text. A newer browser edit rejects delayed success and releases the reservation. Returned comment claims stay persisted until the edited prompt is queued or accepted.

The main button sends ready content and stops active work when the prompt text field is empty. Escape stops the selected active session after transient menus, dialogs, hints, and popovers close. Other editable fields retain Escape. Every Stop targets the message’s session.

Prompt assembly places typed text before comments. Codex retains surrounding whitespace through queueing and delivery. Claude receives trimmed text. Settings travel through controls, never inside prompt text. Rejection retains comments and the failed pending card.

## Compaction and reset

Native compaction bypasses prompt assembly, comments, and ordinary prompt callbacks. Context detail’s Compact leaves the draft unchanged. Exact `/compact` invokes compaction immediately when idle and clears the submitted characters. Busy sessions queue either request. A queued `/compact` with comment claims or files uses ordinary prompt delivery to retain that payload. Without either, it invokes compaction. Codex rejects `turn/start` during native compaction, so new prompts wait locally too.

Clear starts no turn. A successful reset draws no temporary card. Codex `/new` uses the same hidden transition and passes its optional name to the successor. Before resetting, the queue owns the command’s files and comment claims, including a queued exact `/clear` payload. Unclaimed source comments are captured immediately before the control request. These commands never become model input.

The transition needs acceptance and a successor identity. Claude reports acceptance first. Codex reports the successor first. Success moves the payload and dependent prompts before draining the successor queue. The source retains its transcript, comments, labels, and session list row.

Failure or refusal draws a failure card. A queued Codex `/new`, or a queued reset that carries comments or files, keeps its payload as source recovery and blocks dependent prompts until Edit or Drop resolves it. Any other failed reset releases the source queue. Reload converts an in-flight reset to unknown and starts no work. A recorded successor retains ownership through refusal, failure, Edit, Drop, and reload. Stale panel submissions follow that successor until the panel paints it. Afterward the source is independently selectable.

Codex-compaction queueing requires durable capacity for the whole submission, including attachment-only prompts, without truncation or eviction. Waiting entries retain staged files through repaint, selection changes, and reload. Reload restores the queue before draining it.

Persist an attempt before crossing the agent boundary. Reload converts active attempts to recovery and never resubmits them automatically. Edit explicitly retries. Refusal retains the entry, owner, files, and reason. Drop removes staged data only after drafts, queue entries, and handoffs release every reference. Accepted turns release their own files at completion.

## Agent messages

Deferred agent messages share the queue and preserve exact text. They carry no comments or files and change neither drafts nor prompt history. Edit returns their text to the reader draft. Drop removes them. Stop retains waiting entries. Reset and reload retain agent messages in recovery on the original session.

## Pending cards

Temporary cards show submission state before recorded turns arrive. They carry the assembled prompt, or an attachment summary for attachment-only submissions, and session.

New submissions start collapsed. Streaming responses remain readable through stale, aborted, and superseded reads. Prompt cards leave only when an accepted selected window contains their recorded turn or the CLI answers `/model` or `/context` without a turn. Without either event, they remain visible.

Failed prompts remain until dismissed or restored. Local entries use waiting cards until agent acceptance replaces them with protocol live cards. Unknown-delivery recovery states must not suggest retrying because the agent can already have received the prompt. Accessible names retain the complete explanation.

Manual compaction is running work. Only prompts accepted behind it say they are waiting for earlier work.

Failed compaction retains its outcome and cause until Dismiss. The editor notice repeats the cause. Refused prompts additionally offer Restore.

Accepting Codex writer-lock recovery moves the continuation prompt to the server’s forked session. Declining retains the source failure.

Later prompts draw independently while earlier recorded turns are absent. Direct agent activity remains on the newest recorded turn during parsing. Continuation handoffs move the submission to the new session. Queued handoff failures return it to its waiting card.

An unfailed compaction card leaves at its recorded boundary, after started work stops, or after a CLI answer without a record. The five-minute expiry applies only while idle. Running controls retain their cards past that limit.

## Local controls

Exact `/compact` and `/clear` ignore case and surrounding whitespace. Codex `/new` also accepts an optional same-line name. Arguments after `/clear`, mentions inside sentences, and `/safe-compact` remain ordinary input. Codex controls use native app-server requests, never literal slash-command `turn/start` input. The exception is a queued `/compact` that carries comment claims or files.

Codex `/rename` uses the rest of its line as the name. It starts no turn, answers no request, and bypasses running work and staging. Files and comments stay in the prompt box. Failure or an empty name reports an editor error and restores the line only if no newer text edit occurred. Claude sends `/rename` to its CLI. Commands that Claude answers without turns draw no timeline card or prompt-box reply.

Claude `/remote-control` and `/rc` toggle Remote Control, ignoring case and surrounding whitespace. They bypass running work, queueing, and staging without answering requests or carrying files and comments. Notifications report outcomes. When Remote Control turns on, the notification shows the session link as a link that opens in a browser when pressed. Arc links only an `https:` URL with no whitespace, brackets, parentheses, or angle brackets. It shows any other value as plain text with its square brackets percent-encoded, so the notification draws no link from it, and draws the Remote Control item without a link. [Remote Control](agent-protocols.md#claude-remote-control) owns eligibility refusals.

Queued or restored toggles run when reached and return comments and files to the prompt box. Files that do not fit leave the entry queued and block later entries until Edit or Drop. Text after either command, including newlines, is refused. Fresh refusal restores the line. Queued refusal retains the entry and blocks later entries until Edit or Drop.

## Delivery and recovery contracts

Agent input uses `sendAgentMessage` for guarded idle or live delivery and `queueAgentMessage` for explicit queueing or temporary blockers. Reservations serialize ordinary input, observed follow-ups, and queue drains through native receipts. Bindings name one activation-local child. Agent queue heads drain before reader prompt assembly.

Wait for temporary panel work before persisting agent attempts. Ordered deletion must follow concurrent saves before refusal is confirmed. Uncertain deletion retains recovery. Reload never restores child authority, so saved agent messages become recovery. Unknown-delivery blocks apply to both input forms.

Queue edits and live recovery advance draft ownership before replacing text. Live recovery advances beyond typing and pending submissions. Adoption carries ownership forward. Suspended submissions reserve text, comments, and files against swaps while later drafts remain independent.

Host draft replacements cancel pending rename restoration. Delayed rename registration respects current ownership. Submission continuations refresh running and control state without changing captured prompt inputs.
