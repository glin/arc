# Prompt box and controls

Related guides: [delivery](prompt-delivery.md), [attachments](prompt-attachments.md), [setup and controls](session-setup.md), [account usage](account-usage.md), [requests](agent-requests.md), and [completion](prompt-entries.md).

Use this guide when changing prompts, drafts, queued submissions, pending cards, model controls, account usage, completion, or MCP controls. [`agent-protocols.md`](agent-protocols.md) owns delivery over each CLI wire.

## State boundary

`composerview.ts` prepares the prompt box state and every word the browser draws. Preact in `webview/composer.ts` owns the stable shell, keyed completion options, and live prompt text field. `webview/attachments.ts` owns attachment chips, token-scoped browser reads, paste and drop handling, and attachment notices. `webview/queue-live.ts` owns queued submissions and live cards. The provider resolves each action's session id before it reads or changes a draft, queue, setting, or child session.

Each Prompt box action targets its session id. Drafts, queued submissions, pending cards, and selected settings use that same key.

The Preact Prompt box owner builds the prompt text field once and moves the rest of the prompt box around it. Background updates change stable child slots without replacing the root or prompt text field. The session list filter follows the same rule.

VS Code can replay focus to its outer webview frame after a primary click activates the editor window. The Prompt box retains that prompt click through the replay and restores its caret or selection once. Opening the native context menu cancels the restore, including after a Control-click or a keyboard menu chord. Another pointer press or an expired activation window also cancels the restore.

Draft text is mirrored into normalized extension state so a hidden or restored panel can recover it. The live DOM remains the source while the reader types. A draft that cannot be stored safely is dropped rather than cut into a different prompt.

Draft storage retains the newest whole prompts within 10,000,000 total characters. Each session's queued submissions fit within 1,280,000 total characters. A queued submission that exceeds its remaining storage capacity stays in the prompt box.

## Submitted prompt memory

Arc saves the latest five workspace submissions before Enter clears the prompt box or sends to the extension host. Prompts, drafts, and queued submissions accept up to 1,048,576 characters each. Each saved submission keeps exact whitespace and line breaks. Repeated text remains a separate submission. A longer prompt or failed browser save remains visible and sends nothing. The prompt box shows the refusal and clears it when the reader edits the text.

Up in the prompt box recalls retained submissions before the selected session's recorded history. Down moves forward and restores the draft present before recall. Choose a session or create a draft before recalling text. Enter explicitly submits recalled text.

Recovery keeps full text independently of the recorded history's 4,000-character limit. Workspace storage confirms retention before agent dispatch. A confirmed destination identifies routing. Agent acceptance is recorded separately after successful delivery.

Submitted prompt recovery joins browser and workspace copies by immutable attempt identity before retaining the newest five. Host receipts preserve submission order. Confirmed delivery destinations survive stale browser imports. Keyboard recall uses that destination, or the source before confirmation, and resolves provisional adoption within the page. Active walks retain submission identities for later ownership checks. Routing and agent acceptance remain separate. Panel restoration imports submitted text before replacement disposes a tab. Failed storage publishes the retained text and retains both incoming and previous tabs. Recovery never dispatches agent work.

## Text editing

The Prompt box owner keeps undo and redo history because moving or assigning the prompt text field invalidates the browser history that VS Code would otherwise invoke. History is kept per session and resets after a successful send.

Typing that belongs to the same word is grouped. Paste, command completion, and larger edits become their own steps. Each step stores text and caret position so restoration does not infer an edit from two equal-looking strings.

The Up arrow recalls recent workspace submissions before the selected session's recorded prompts. Down comes forward again. The walk starts only when the caret is at the start of the prompt text field. A press anywhere else moves the caret. While the prompt text field holds a recalled prompt, both keys belong to the walk wherever the caret stands. Once it has come forward to the reader's own words, the caret rules again.

Prompt recall uses the text offset because wrapped display rows do not correspond to newline-delimited lines.

What the prompt text field held when the walk began is kept aside. It returns when the walk comes forward past the newest prompt, with the caret back at the start. The walk does not wrap.

The walk ends wherever the prompt text field changes for another reason. Typing, a completion, an undo, a redo, a send, a queued prompt taken back, and a change of session all end it. The next walk starts from what the prompt text field then holds. A send takes the words held aside with it, the way it takes the undo steps.

The walk ends on the change itself rather than on a later comparison of the text. A reader who types a character into a recalled prompt and deletes it again is back at their own words. The text alone cannot tell that from the recall.

A turn can record two prompts in one string. A prompt with no response joins the next turn's prompt. `promptParts` separates them for recall. Without that separation, Up recalls both prompts and Enter sends them together.

Recall changes the displayed text without replacing the draft retained for that session. The panel publishes displayed text and retained draft separately. Displayed text determines the send action. The retained draft survives session changes and reloads.

Recall hides the command completion menu because both features use arrow keys. Ending recall restores the menu unless the reader dismissed it with Escape.

At text offset zero, prompt recall takes priority over command completion. At other offsets, an open command menu retains both arrow keys.

Saved browser submissions join the selected session's history. A confirmed destination owns a submission. Otherwise its source owns it, with provisional identities following session adoption. Each arrow key excludes submissions whose destination has moved to another session.

The prompts come from two sources, merged by `promptHistory`. The transcript supplies what each session recorded. That source outlives a reload and carries work started in a terminal. The provider supplies what this panel submitted, which the transcript can record slowly. The provider's own copy is saved beside the unsent draft, so it survives a window reload and an extension host restart, and it recalls a prompt no agent process lived long enough to write down. The saved copy excludes a prompt once the transcript records it, because the transcript is then the durable copy, and within the same window the provider's in-memory copy still returns the reader's typed words to Up. The two are compared through `cleanPrompt`, because that rule wrote the recorded copy and it is lossy. A prompt sent twice takes the older record for its first send, matched from the oldest end of both lists, because the record catches up in the order the prompts went.

Recorded prompts keep transcript order, including prompts sent from a terminal. Panel submissions not yet recorded appear ahead of them.

A record carrying the reader's comments beneath a sent prompt is offered as the prompt they typed. The comparison is the prompt alone, or the prompt with a comments block under it, and nothing looser. What this panel sent lives in the window that sent it. So after a reload a prompt that went with comments comes back with them.

Prompt history excludes submissions containing comments alone. `looksLikeComments` requires a bold turn heading with a parenthesized time before the first blank line. Both conditions must match. A generated heading containing only a time does not match, so that submission remains in history.

The Prompt box payload includes prompt history before the reader presses Up. Refreshes update that list without replacing the text field or its editing state.

`promptsAcross` removes blank, repeated, and oversized prompts before building the history payload. `promptHistory` also excludes oversized prompts. Oversized entries must not consume the history limit and leave recall empty.

Prompt recall announces its position in a separate polite live region. Updating the focused text field alone produces no screen-reader announcement. Recall must not replace an agent-request announcement.

Recall clears its live region before publishing a delayed announcement. Holding an arrow key announces only the final position. Repeated announcements remain readable. The announcement truncates prompt text independently of visual wrapping.

Cut or copy with no selection expands to the current line. The last-line case treats cut and copy differently so cut removes an orphaned line break while copy does not add a break the reader did not select. A right-click on selected text keeps that text highlighted while the native menu takes focus.

## Box height

The prompt box grows with its text through ten lines or the room above the active session heading, whichever is less. The sash on its top edge sets a larger minimum height without making the box shorter than its text.

Drag the sash to resize the box. A downward drag stops at the effective minimum. The sash uses the same Pointer Events path for mouse, pen, and touch input. The resize ceiling reserves the body's top padding and ends at the prompt box's bottom boundary.

Collapse prompt box hides requests, attachments, prompt settings, and the prompt text field. Restore prompt box remains reachable. The context menu offers both actions. Collapse preserves draft content and the saved expanded height. Waiting cards remain in the timeline. The account status bar remains available. The collapsed sash does not resize the prompt text field. When the visible sash has keyboard focus, Home uses the smallest height. End uses the largest height that keeps the session heading visible. The arrow keys change the height by one line.

Collapsed prompt boxes keep their completion and settings popovers closed through startup, payload updates, and delayed replies. Visible comment editors retain completion. Collapse transfers focus from hidden controls to Restore prompt box. Restore reveals the prompt box before focusing its text field. Accepted failed-prompt recovery and queued editing reveal only the selected target. Offscreen recovery and background draft restoration preserve text without changing visibility or focus.

The panel saves the chosen minimum in em units with its layout state. A shorter window clamps the drawn height without replacing the saved value.

## Verification

`composerview.test.ts`, `usageview.test.ts`, `mcpview.test.ts`, and `agenthost.test.ts` own the host decisions. `composer.browser.test.ts` exercises the shipped page, stable prompt text field, editing state, draft authority, prompt history, and slash behavior. `panel.webview.test.ts` checks control wiring, pending cards, agent request answers, and accessible markup. The `panel.layout*.test.ts` files check that the Prompt box, request cards, menus, popovers, and status bar stay inside the Panel.
