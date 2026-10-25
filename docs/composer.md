# Prompt box and controls

[`webview/composer.ts`](../extension/src/webview/composer.ts) owns editing. Use [delivery](prompt-delivery.md), [attachments](prompt-attachments.md), [setup](session-setup.md), [account usage](account-usage.md), [requests](agent-requests.md), and [completion](prompt-entries.md) for their contracts.

## State boundary

[`composerview.ts`](../extension/src/composerview.ts) supplies presentation. Background updates must retain the prompt text field and root because replacement loses editing state. Each action resolves its session before changing drafts, queues, settings, or children.

VS Code can replay focus to its outer webview after a window-activation click. The prompt text field restores that click's caret or selection once. Native context menus, Control-click, keyboard menu chords, another pointer press, and activation expiry cancel restoration.

The live DOM supplies text during typing. Normalized extension state recovers drafts after panel restoration. Unsafe drafts are dropped whole, never truncated.

[`turnview.ts`](../extension/src/turnview.ts) bounds draft storage at 10,000,000 total characters and each session's queue at 1,280,000. A submission that exceeds remaining queue capacity stays in the prompt box.

## Submitted prompt memory

The browser saves the latest five workspace submissions before clearing or dispatching them. Prompts, drafts, and queued submissions each accept up to 1,048,576 characters. Excess length or browser-save failure leaves text visible and sends nothing.

Full-text recovery is independent of the 4,000-character recorded-history recall limit. Workspace storage confirms retention before dispatch. Successful agent delivery records acceptance separately.

[`webview/state.ts`](../extension/src/webview/state.ts) joins browser and workspace recovery by immutable attempt identity. Host receipts preserve order and confirmed destinations through stale browser imports.

[`panelhost.ts`](../extension/src/panelhost.ts) imports submitted text before replacing a tab. Failed storage retains incoming and previous tabs and publishes retained text. Recovery never dispatches work.

## Text editing

Arc owns per-session undo and redo because moving or assigning the text field invalidates native history. [`domain/composer-editing.ts`](../extension/src/domain/composer-editing.ts) owns edit grouping, history keys, and line cut/copy rules.

Recall changes displayed text separately from the retained draft. Displayed text controls Send. The retained draft survives session changes and reloads. End recall on the edit event, even when subsequent edits restore identical text. Text comparison alone cannot identify reader changes.

Use `promptParts` for recorded recall. A turn can join a prompt without a response to the following prompt. Recalling that combined string resends both.

Confirmed destinations own browser submissions. Before confirmation, source sessions own them. Provisional identities follow adoption. Each arrow press excludes submissions moved to another session.

[`composerview.ts`](../extension/src/composerview.ts)'s `promptHistory` reconciles panel submissions with recorded prompts using lossy `cleanPrompt` keys. Preserve recorded order and match oldest entries first. Match complete prompts or generated comments-appended forms, never shared openings. The sending window retains typed text after saved panel copies exclude recorded matches.

Comments-only detection in [`turncomments.ts`](../extension/src/turncomments.ts) requires a bold turn heading and parenthesized time before the first blank line. A heading containing only time remains recallable. Skip oversized entries before applying history limits so smaller prompts remain recallable.

Recall uses a separate polite region from agent requests because text-field updates announce nothing. Clear it before deferred announcements. Held arrow keys announce only the final position. Announcement truncation is independent of visual wrapping.

## Box height

[`webview/composer-presentation.ts`](../extension/src/webview/composer-presentation.ts) owns sizing and sash input. [`webview/panel.ts`](../extension/src/webview/panel.ts) owns collapse and restoration. [`webview/composer.browser.test.ts`](../extension/src/webview/composer.browser.test.ts) covers collapsed startup, delayed replies, and recovery.

Collapse must keep completion and settings closed while retaining completion for visible comment editors. Accepted recovery and queue editing reveal only the selected target. Offscreen recovery preserves text without changing visibility or focus.

The saved minimum uses em units. Short windows clamp drawn height without changing the saved value. The ceiling reserves the active session heading and body top padding.
