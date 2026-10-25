# Prompt box and controls

Read this guide for prompt text, draft recovery, editing, or sizing. Source paths are relative to `extension/src/`.

Use [delivery](prompt-delivery.md), [attachments](prompt-attachments.md), [setup and controls](session-setup.md), [account usage](account-usage.md), [requests](agent-requests.md), or [completion](prompt-entries.md) for those changes.

## State boundary

`composerview.ts` supplies prompt box presentation. `webview/composer.ts` owns the stable shell and prompt text field. Each action resolves its session before changing drafts, queues, settings, or children.

Background updates must retain the prompt text field and root. Replacing them loses editing state.

VS Code can replay focus to its outer webview after a window-activation click. The prompt text field restores that click’s caret or selection once. Native context menus, Control-click, keyboard menu chords, another pointer press, and activation expiry cancel restoration.

The live DOM supplies text while the reader types. Normalized extension state recovers drafts after hiding or restoring the panel. Unsafe drafts are dropped whole, never truncated.

Draft storage retains the newest whole prompts within 10,000,000 total characters. Each session’s queue fits within 1,280,000 total characters. A submission that exceeds remaining queue capacity stays in the prompt box.

## Submitted prompt memory

Before clearing or dispatching a submission, the browser saves the latest five workspace submissions with exact whitespace and line breaks. Repeated text remains separate. Prompts, drafts, and queued submissions each accept up to 1,048,576 characters. Excess length or browser-save failure leaves text visible and sends nothing. Editing clears the refusal.

Recovery retains full text independently of the recorded-history recall limit of 4,000 characters. Workspace storage confirms retention before dispatch. Successful agent delivery records acceptance separately.

Browser and workspace recovery join by immutable attempt identity. Host receipts preserve order. Confirmed destinations survive stale browser imports.

Restoration imports submitted text before replacing a tab. Failed storage retains both incoming and previous tabs and publishes retained text. Recovery never dispatches work.

## Text editing

Arc owns per-session undo and redo because moving or assigning the text field invalidates native history. Successful sends reset that history.

Word typing groups into one undo step. Paste, completion, and larger edits form separate steps. Steps retain text and caret positions.

Up recalls saved workspace submissions before the selected session’s recorded prompts. Down returns toward the draft. Recall starts only at text offset zero with no selection. During recall, both arrows continue the walk anywhere in the field. Otherwise they move the caret.

Recall saves the draft it starts from. Down past the newest prompt restores it with the caret at zero. The walk never wraps. Choose a session or draft before recalling. Enter explicitly submits the displayed text.

Typing, completion, undo, redo, sending, queued editing, or session changes end recall. Sending also clears its saved recall draft.

End recall on the edit event, even when subsequent edits restore identical text. Text comparison alone cannot identify reader changes.

Use `promptParts` for recorded recall. A turn can join a prompt without a response to the following prompt. Recalling that combined string resends both.

Recall changes displayed text separately from the retained draft. Displayed text controls Send. The retained draft survives session changes and reloads.

Recall hides completion until the walk ends. Ending recall restores the menu unless the reader dismissed it with Escape.

At offset zero, recall takes priority over command completion. Elsewhere an open command menu retains both arrow keys.

Confirmed destinations own browser submissions. Before confirmation, source sessions own them. Provisional identities follow adoption. Each arrow press excludes submissions moved to another session.

Recorded history survives reloads and includes terminal submissions. Panel submissions fill recording delays and survive host restarts. `promptHistory` matches oldest entries first using lossy `cleanPrompt` keys. Saved panel copies exclude recorded matches. The sending window’s memory still supplies the reader’s typed text.

Preserve recorded order. Unmatched newer panel submissions precede it.

Matching accepts the prompt alone or its generated comments-appended form. It never accepts only a shared opening. After reload, recorded prompts can include their comments.

Comments-only history detection requires a bold turn heading and parenthesized time before the first blank line. A generated heading containing only time remains recallable.

Skip oversized entries before applying history limits, so smaller prompts remain recallable. `promptsAcross` also removes blank and repeated prompts.

Recall uses its own polite region, separate from agent requests. Text-field updates alone announce nothing.

Clear the region before deferred recall announcements. Held arrow keys announce only the final position. Announcement truncation is independent of visual wrapping.

Cut or copy without a selection expands to the current line. On the last line, cut removes the orphaned line break. Copy adds no unselected break. Native context menus retain selected-text highlighting.

## Box height

The prompt box grows through ten text lines or the room above the active session heading, whichever is less. The top sash sets a larger minimum without shrinking below text height.

Mouse, pen, and touch resizing use Pointer Events. Downward drags stop at the effective minimum. The ceiling reserves body top padding and ends at the prompt box’s bottom boundary.

Collapse hides requests, attachments, settings, and the text field. Restore stays reachable. Both actions appear in the context menu. Drafts and saved expanded height survive collapse. Waiting cards and account usage remain visible. The collapsed sash cannot resize.

On a focused visible sash, Home selects minimum height. End selects the largest height that retains the session heading. Up and Down change height by one line.

Collapsed prompt boxes keep completion and settings closed through startup, updates, and delayed replies. Visible comment editors retain completion. Collapse moves hidden-control focus to Restore. Restore reveals the box before focusing its field.

Accepted prompt recovery and queue editing reveal only the selected target. Offscreen recovery preserves text without changing visibility or focus.

The saved minimum uses em units. Short windows clamp drawn height without changing the saved value.
