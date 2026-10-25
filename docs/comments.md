# Turn comments

[Timeline](timeline.md) owns turn identity. [Turn cards](turn-cards.md) owns rendering.

## Data model

`view/comments.ts` defines stored parts and comment fields. `turncomments.ts` owns normalization and limits.

Card parts identify the opening prompt, later prompts, summary, answer blocks, and agent messages during the turn. Message parts use message ids. Renaming stored parts requires compatibility with existing workspace comments. The opening-input heading before the response is not a part and never shifts stored response offsets. Comments on the `You asked` or `Assigned task` heading after the response use summary. Moving the input before the response draws those comments on the corresponding input. Without a first prompt, they draw on the first ask and unfold the asks. Quotes matching summary or answer text draw there instead of on the heading. Without a first prompt, the first ask becomes the prompt block and stores its comments under prompt.

Shared panel state keeps comments through repaints, hidden panels, and restored tabs.

## Anchoring a selection

`quoteOf` in `webview/comments.ts` serializes selection quotes as Markdown, with fenced code and a plain-text fallback. `offsetOf` supplies the saved offset. `selectionHere` checks endpoints, not intervening nodes. It rejects endpoints in comments, opening-input headings, and ineligible Activity rows.

Quote matching lives in `view/comments.ts`. Saved offsets break ties between repeated text. Saving and drawing must count the same card-heading lines. Matches respect word boundaries when a quote starts or ends with a word character.

Prompt, summary, answer blocks, and messages have separate initial search pools. Activity log comments use message ids because filtering changes row positions. If the original part has no match, summary and answer parts search each other, and message parts search other message parts. A comment anchored to an earlier answer stays there while its quote matches, even when the summary repeats it. Unmatched comments remain in the turn's comment list without a text tint.

Overlapping comments use flat highlights to keep text offsets independent of drawing order.

## Editing and navigation

The selection action opens a labelled comment box beside the selected text. The box stays between the sticky heading and the fixed prompt box, choosing the side of the selected text that has room for it. Save writes a non-empty note. Cancel and Escape close the box and return focus to the control or text that opened it.

Session setup stays in the Prompt box.

A line mark opens its comments for editing or deletion without changing neighboring comments. Pointer hover can preview the list. Keyboard focus and a press provide the same access.

Card repainting waits while the reader writes a comment, presses inside its open comment list, or selects card text. A list opened by a press reopens on the redrawn mark. Focus returns to the same list control. Selecting another session closes the previous session's comment list.

`sweepSource` and `drawnMarks` in `webview/comments.ts` own annotation invalidation. List interactions defer redraws until they end. Active card text selection continues that deferral. Escape, Save, Cancel, and Delete update marks before returning focus. Focus returns to a visible mark on the same line, then the nearest visible mark, then the nearest visible control. Focus restoration never scrolls the panel.

## Sending comments

`emitComments` groups unsent comments for the selected session and formats them as ordinary reader text beneath the prompt. Queue and draft claims keep stable comment ids. Prompt assembly creates temporary delivery copies when a reset moved the payload to a successor session.

An empty prompt with comments is still a sendable prompt. A prompt without comments is sent unchanged. A queued reset snapshots late unclaimed comments before its control request starts. Accepted delivery removes only comments whose captured values still match. Edited comments remain available for the next prompt. A rejected reset or prompt leaves them on the source cards.

Delivery copies can name a successor session without changing the source comment. That session change does not retain an otherwise unchanged comment.

Compaction does not use prompt assembly and cannot consume comments. Any new non-prompt control must keep that separation.

## Redirecting selected text

[New sessions from existing work](panel-navigation.md#new-sessions-from-existing-work) owns draft setup, labels, and source-turn navigation. The draft adds one blank line after the selection.

A clicked line without a selection keeps Add a comment and shows neither redirect action. A stale, changed, or already-used selection cannot create a draft.

## Copying and markdown

`copySummary` in `panelhost.ts` copies the card's stored Markdown.

Quote extraction and offset calculation must agree after markup changes, including visually unchanged wrappers.

## Verification

`turncomments.test.ts` covers normalization, matching, grouping, and prompt emission. `panel.webview.test.ts` covers DOM selection, word boundaries, overlapping highlights, editor controls, focus, and browser messages. `panel.layout.comments.test.ts` checks that marks and editors fit at supported widths. It also checks that edits and deletes in a comment list take the first press, keep the scroll position and focus, redraw the card once, and leave the prompt box unchanged.
