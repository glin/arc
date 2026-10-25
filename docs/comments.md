# Turn comments

Use this guide when changing comment storage, text anchoring, editing, or prompt delivery. [Timeline](timeline.md) owns turn identity. [Turn cards](turn-cards.md) owns rendering.

## Data model

`turncomments.ts` owns the durable comment model. A comment records the session, turn key, card part, selected quote, offset, note text, and creation order. Saved values are normalized before use, and invalid or oversized values are dropped.

The card parts are prompt, summary, individual answer blocks, and individual messages the agent wrote while the turn ran. A message part carries the message's own id. Their names are stored data. Renaming one requires a compatibility path for comments already in workspace state. The opening-input heading over input drawn before the response is no part, so it never shifts a stored response offset. A comment saved on the `You asked` or `Assigned task` heading drawn after the response is stored under summary. When the input moves before the response, that comment draws on the input the heading names. On a card with no first prompt, it draws on the first ask and unfolds the asks. A summary comment whose quote a summary line or an answer block holds draws on that line and never on the heading. A card with no first prompt draws its first ask as its first prompt block, so a comment on that ask is stored under prompt.

Comments live with the shared panel state rather than inside a webview tab. A repaint, hidden panel, or restored tab therefore sees the same comments. Removing a comment changes only that stored comment.

## Anchoring a selection

The browser starts with a DOM selection. It identifies the card and part, walks the rendered nodes into the plain text the reader saw, and records the selected quote and its start. Selection cannot cross into controls or another comment.

Rendering markdown changes the DOM shape, so the stored offset is a hint rather than a permanent address. On repaint, `turncomments.ts` searches the same card part for the quote. The saved offset breaks ties between repeated text. It counts the lines of the card heading ahead of the body, and saving and drawing count the same lines. Matches respect word boundaries when the quote begins or ends with a word character.

Prompt, summary, answer blocks, and each message are separate search pools. The Activity log removes rows when the reader changes its filter, so a message is searched by its own id and not by its place in the log. Text repeated in the closing summary must not relocate a comment anchored to an earlier answer. If the quote can no longer be found, the comment remains on the turn and is available in the comment list, but no text range is tinted.

Overlapping comments produce flat highlight runs. They are not nested because nested marks change the text walk and make later offsets depend on drawing order.

## Editing and navigation

The selection action opens a labelled comment box beside the selected text. The box stays between the sticky heading and the fixed prompt box, choosing the side of the selected text that has room for it. Save writes a non-empty note. Cancel and Escape close the box and return focus to the control or text that opened it.

The comment box edits comments. Session setup stays in the Prompt box.

A mark on a line opens the comments anchored there. The list supports editing and deletion without changing neighboring comments. Pointer hover may preview the list, but keyboard focus and a press provide the same access.

Card repainting waits while the reader writes a comment, presses inside its open comment list, or selects card text. A list opened by a press reopens on the redrawn mark. Focus returns to the same list control. Selecting another session closes the previous session's comment list.

Comment marks redraw when placement inputs change. Inputs include counted text lines, card parts, prompt labels, each comment's quote, offset, and text, and the drawn mark and tint counts. A redraw deferred by the comment list runs after the interaction ends. Active card text selection continues that deferral. Escape, Save, Cancel, and Delete update the card's marks before returning focus. Focus returns to a visible mark on the same line, then the nearest visible mark, then the nearest visible control. Focus restoration never scrolls the panel.

## Sending comments

`emitComments` groups unsent comments for the selected session and formats them as ordinary reader text beneath the prompt. Queue and draft claims keep stable comment ids. Prompt assembly creates temporary delivery copies when a reset moved the payload to a successor session.

An empty prompt with comments is still a sendable prompt. A prompt without comments is sent unchanged. A queued reset snapshots late unclaimed comments before its control request starts. Accepted delivery removes only comments whose captured values still match. Edited comments remain available for the next prompt. A rejected reset or prompt leaves them on the source cards.

Delivery copies can name a successor session without changing the source comment. That session change does not retain an otherwise unchanged comment.

Compaction does not use prompt assembly and cannot consume comments. Any new non-prompt control must keep that separation.

## Redirecting selected text

A valid response selection adds two actions to the native context menu. The first starts an editable draft with the source session's labels. The second starts an editable draft without labels. Both actions preserve the selected markdown, add one blank line, inherit the source setup and recorded working directory, and retain source-turn navigation as draft metadata.

A clicked line without a selection keeps Add a comment and shows neither redirect action. A stale, changed, or already-used selection cannot create a draft.

## Copying and markdown

Copying a turn or a selected range reconstructs readable markdown from the rendered content. Lists, code fences, quotes, and line breaks survive. Browser-only controls and existing comment text do not enter the copy.

The same plain-text walk supports quote location and copy. A change to rendered markup must verify both paths because a visually unchanged wrapper can alter the node walk.

## Verification

`turncomments.test.ts` covers normalization, matching, grouping, and prompt emission. `panel.webview.test.ts` covers DOM selection, word boundaries, overlapping highlights, editor controls, focus, and browser messages. `panel.layout.comments.test.ts` checks that marks and editors fit at supported widths. It also checks that edits and deletes in a comment list take the first press, keep the scroll position and focus, redraw the card once, and leave the prompt box unchanged.
