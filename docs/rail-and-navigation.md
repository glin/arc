# Session list

Use this guide for session rows, labels, saved filters, saved views, and read or status state. Source paths are relative to `extension/src/`.

Read [session queries](session-queries.md#session-query-syntax) for matching, [panel accessibility](panel-accessibility.md) for keyboard behavior, [panel navigation](panel-navigation.md) for menus and links, and [panel rendering](panel-rendering.md) for retained updates and loading.

## Session list

`turnrail.ts` projects session rows. Pinned sessions lead, and active work rises without reordering existing sessions on each activity event. Agent runs and archived sessions have separate buckets. Presentation changes do not determine transcript discovery.

Use session IDs for actions and saved state. Titles are mutable display text.

The shared responsive breakpoint selects the wide session list or compact navigation, independently of row count. The wide list remains available with zero or one session. Returning from narrow layout restores the selected draft. `webview/chrome.ts` owns compact controls. Its visibility must settle before the timeline measures its sticky heading offset. While the compact native picker has focus, defer option changes until blur.

### Figures and density

Full rows show cost, whole-session turn count, then current context. The session heading shares the same cost and turn count. Cost includes associated delegated work. Turn count covers the main session alone. Both require complete sources in the persisted incremental spend index. Selection must not change them.

Context uses parsed facts or the bounded metadata tail that also supplies title and status. A tail without the newest turn supplies no context. Do not add a transcript read for a session list figure. Omit missing figures, including their gaps.

Every added metric needs a selection-independent source covering its caption's scope. Store current or tail source facts in the derived entry, then calculate display values when building rows. The ordinary parser replaces metadata facts. Whole-session aggregates belong in the persisted incremental index. Omit values when neither source covers their scope.

A running row adds elapsed time after its first minute. Use the earliest active recorded turn start or busy-child start. Without either, omit duration. The hover gives start and last activity times. Needs input has no running duration.

The heading's turns hover includes session span, available compaction counts, and the number drawn when fewer than the whole-session count. Its bulk action opens or closes only drawn cards. Its wording must name that scope.

The View menu's Rows choice applies Full or Compact to every row. Save `railDensity` beside `railWidth`, outside saved filters and views. Full is the default. Compact removes visible figures, labels, and agent wording, while retaining state, unread, selection, and archive styling. Its controls cover metadata without moving the name.

[Session list focus](panel-accessibility.md#session-list-focus) owns accessible names and read-only figures and labels. Compact uses short visible ages without `ago`. Its hover restores the full name, metadata, figures, and labels. It shows at most eight labels before `+N more`. [Hints](panel-accessibility.md#hints) defines platform hover delays. Accessible descriptions must not repeat the name's metadata, but retain subagent or background-command explanations. `view/rail.ts` owns status slots, ages, hover contents, and figure order.

### Labels

`turnlabels.ts` owns reader-defined labels. Session rows carry all names in `labels` and the displayed subset in `labelChips`. Matching reads the complete list. Folding must not change stored names.

The session heading reads labels from authoritative session list rows, not its timeline session rows. It draws every label without folding. Pressing an available heading label writes its query term and focuses the filter box. The selected session stays open while its card follows the filter. [Timeline navigation](panel-accessibility.md#timeline-navigation) owns responsive controls and focus fallback.

Open the label editor from the card action, either session context menu, or the heading's label action. [Label editor](panel-accessibility.md#label-editor) defines its keyboard routes. Below the breakpoint, use the heading action or context menu. Filing requires no parsed turn. Label actions remain available when read actions lack a boundary.

Each opening requests fresh label rows. The popover offers workspace labels with session counts and a find-or-create field. A new name is created and applied together. Submit the complete name list for that session. The extension checks spelling and limits, writes it, and replies with fresh rows. Preserve an open editor's row order so a checked label does not move. A new opening leads with applied labels.

Every label write updates every panel. An editor open on another session requests its own fresh rows because workspace counts and membership change. Refind its anchor after redraw, preferring its initiating occurrence, then the card action, heading label action, and heading. A comma makes a name sound like multiple labels when read aloud. Names equal through the name ceiling identify one label. Show these notes while the triggering name is typed.

The extension owns labels. Panel state saves exclude them so an older tab cannot overwrite them. Initial renders and session list updates carry the workspace catalog, counts, and count wording. Catalog changes participate in update comparison, including removal of a label's final holder.

### Provisional identity and rename

Adopting a provisional session moves labels, pinning, and archive membership to the durable ID. A bounded alias routes delayed actions. Browser replies retain provisional identity until a complete render supplies the exact mapping. The prompt box, heading, and open label editor adopt together at that render. Delayed label actions and replies must still reach that editor.

An incremental list update projects the durable row onto its provisional shell only with the same mapping. Otherwise, retain the last coherent provisional row. The provider owns durable pinning and archive membership, including delayed saves and native menu changes. Call `sweepDraftLabels` only when loading stored state. Normalization must retain labels belonging to live drafts.

Saved sessions offer Rename in card and heading context menus, including while running. Provisional sessions and rows projected onto provisional IDs offer none. Preserve `sessionPersisted` in menu context. Only the invoking panel opens the editor, beside the opening control. Start from the full name, not shortened card text. [Session rename](agent-protocols.md#session-rename) defines provider behavior.

Match rename answers by session and request ID. A reloaded panel must not reuse request IDs. Ignore replies for closed editors or later requests. Sending disables edits, Cancel, and Save name, but Escape, outside presses, and another popover still dismiss the editor. Dismissal does not cancel delivery. Success closes it. Failure retains the submitted name and error. A removed session closes its editor. Move focus on an answer only while focus remains in the editor or has fallen to the page body. Return to the live opener, or the timeline when narrow layout hides the card.

### Header and scrolling

The header orders action controls before filter buttons. Sessions disappears below 14.8em. Above 22.5em, the filter box shares a line with New. Below that width, it occupies another line. Restored panels start with the box closed.

The magnifying glass opens the box. Its cross clears and closes it, returning focus to the magnifying glass. Escape first dismisses completion, then clears a nonempty query, then closes an empty box. Escape on a filter button changes neither query nor box. A filter press preserves box visibility.

Configured buttons appear during startup with unavailable counts and restored pressed state. After catalog publication, show configured buttons with positive scoped counts or while selected. Their order is Running, Active, Unread, Needs input. A selected zero stays enabled. Selecting a lens never adds an unchecked button. Counts belong in accessible names. Active describes warm or nearly expired caches in its icon, accessible name, and hint.

While naming a view, freeze button counts and cache information, and refuse their presses. Payloads and saved-filter updates preserve the typed name. Naming completion refreshes the buttons.

`#rail` owns scrolling. Bucket headings stick below the measured header, including Project cost when present. Set top scroll padding from that height so keyboard destinations remain visible. Ordinary structural updates preserve scroll. Pinning scrolls to the top once.

Project cost appears after wide-list controls and before sessions. Its agent breakdown requires indexed evidence. Recorded zero counts as evidence. An empty accumulator does not. Open its dialog below the button when at least a control or text line fits. Otherwise, use the viewport with scrolling. The compact face retains its own placement.

### Filter completion

Complete only the token under the caret. Partial axis names offer their colon form. `label:` offers exact matches, then prefixes, then substrings. Within each tier, preserve catalog order. Quote names containing spaces and preserve surrounding query words. An empty box offers nothing. Negated tokens offer the same choices with the mark restored and Filter out wording. A lone negation mark offers every axis.

Keep focus in the combobox. Expose `aria-expanded`, `aria-controls`, and `aria-activedescendant`, with `aria-selected` on options. Up and Down move the active option. Enter and Tab accept. Escape dismisses suggestions for that token without editing it. Another token or reopening restores suggestions. Leave input-method composition keys alone. Tooltips expose complete names when text is shortened.

Filtering narrows the session list alone. Content search has separate timeline results. Empty results must describe a nonmatching filter without implying missing transcripts. Coalesce input reconciliation to an animation frame.

## Saved filters

`domain/rail-filters.ts` owns named query and sort snapshots. Apply filters before `railSections` assigns views and groups. They create no section and change no saved view, section order, or remembered fold. All sessions is built in. It clears the query and restores the current default order.

The Filter row offers All, Running, Active, Unread, and Needs input even without matches. Each named lens writes its positive status term plus `-is:archived -is:agentrun`. The terms are `is:running`, `is:active`, `is:unread`, and `is:input`, respectively. The reader can edit them in the query box.

A button is pressed when the query contains that complete lens and no other complete lens, in any word order. Extra words do not unpress it. Removing a lens word does. Pressing the selected button removes its words. Another lens adds its words and removes words exclusive to competing complete lenses. Preserve unrelated words and sort order. A press over a saved filter selects Custom.

All removes every complete lens but preserves other query words, sort, and selected filter identity. A query with two complete lenses retains its typed meaning and checks All. The funnel names a query containing only one complete lens for that lens. Extra words name it Custom. Bare typed or saved `is:running` also names it Custom.

Unread and Needs input retain sessions after the reader reads or answers them. Retained sessions must satisfy other terms and remain neither archived nor agent runs. Query changes and panel reload clear retention. Group by Status uses their current state. Running and Active retain no departed sessions.

Quick filters configures header buttons without changing the query. Defaults are Running, Active, and Needs input. Save the choice as `railQuickFilters`. Loading `railHeadLenses` adds Running. Unchecking removes a button immediately, even when selected. Forget State restores defaults. A retained button keeps focus through clock and payload updates. After removal or a lens press, focus the selected button, first available button, then funnel.

The funnel's name and hint identify filter and order. It fills for named lenses, saved filters, and Custom. All sessions at the default order uses an outline. The View menu contains find, Filter, Quick filters, Group by, Sort by, Rows, Show, Labels, Saved filters, and actions. The magnifying glass separately owns opening the query box. Sort by changes the default on All sessions and the live order otherwise. Edits differing from a saved snapshot select Custom. Save changes explicitly replaces the snapshot.

The extension owns the workspace saved-filter list. The panel saves only its selected ID, query, and sort. Host state saves exclude the list. Missing selected IDs fall back to All sessions. `migrateStoredRailLens` preserves stored query words while adding missing supported lens terms. It maps retired Needs you IDs to All sessions, drops retired Needs you lens fields, and converts Warm words under All sessions to Active. Stored built-in names gain an available `(saved)` suffix. Keep these migrations in `domain/rail-filters.ts`.

Find narrows labels and saved filters. Label counts exclude sessions hidden by Show. Order chips by descending count, then name. Draw twelve before the expansion chip. Find text draws all matches without folding. Closing resets expansion. A chip toggles its quoted query term. Omit chips whose labels the query negates. `view/session-query.ts` owns chip selection and folding.

## Saved views

`domain/views.ts` owns named queries that create sections. Views include their archive choice and optional order override. Status, cost, and cache-expiry terms update membership as facts change. Views never determine transcript parsing.

`railSections` orders Pinned, saved views in saved order, unclaimed groups, Run by agents, then Archived. Every view matches independently. Matching several views repeats a session in each. A pinned match also appears in its view. A view with archived inclusion sees archived sessions only when Show archived permits them. Archived retains its own copy.

Group by saves `railGroupBy`. Time uses Today, Yesterday, Last 7 days, and Older. Label uses newest-session order, then folded Unlabelled. Agent uses agent-name order. Status uses Needs input, Running, Unread, Read. Waiting wins over unread. Subagents and Background join Running. None uses Sessions. Unclaimed, unpinned agent runs retain their separate bucket. Pinned agent runs stay in Pinned and matching views, without joining ordinary groups. Under Label, Agent, and Status, pinned ordinary sessions also appear in groups. Under Time and None they appear only in Pinned. Multiple labels repeat a session. Agent groups omit repeated agent wording on cards.

Filtering happens before sections claim sessions. Preserve matching section order, counts, sorting, and repeated copies. Effective queries hide empty sections and start matches open, including restored queries. Disclosure changes apply temporarily to that query. Query changes reset those folds. Payload and clock updates retain them. Clearing restores ordinary folds. Pinning opens temporary Pinned without changing its saved fold. Deleting a view removes both fold records. Search-only `find:` and `in:` words create no session list term.

Sections initially draw 200 rows. Pinned draws all. Draw through the current session, rounded up to 200. Show more adds 200, or the remaining count on its last press. [Session list focus](panel-accessibility.md#session-list-focus) owns its accessible name and focus after expansion. Headings count drawn and undrawn cards. New queries start at 200, while returning queries retain expansion. Changing a view query resets its expansion. `RAIL_ROW_STEP` owns the bound.

The default order is Latest update, Cost highest first, Cost lowest first, or Needs you first. Sort after membership. Views inherit or override it. Name explicit overrides in heading tooltips and accessible names, including overrides equal to the default. Unpriced sessions sort last in both cost orders. Needs you first ranks waiting, unread, running work, then other sessions. Running, Subagents, and Background share a rank. Within tied ranks, use newest activity, then ID.

Empty views without an effective filter retain folded headings for editing and deletion. Fold keys use view IDs so renaming preserves them. `normalizeRailFolds` accepts time-bucket names and `railgroup:` keys.

Saving requires an effective term. Search-only queries offer no Save as view. A sole positive label suggests its catalog name or parsed spelling. Other restrictions remain in the query. Multiple positive labels or none leave the name empty. Select suggested text so typing replaces it. Enter saves. Escape cancels. Duplicate names require another name.

The extension owns views and preserves them when accepting panel state saves. Save, rename, and delete publish complete normalized lists to every panel. View changes participate in list-update comparison even when no card moves. Saved headings offer Edit view and Delete this view through right-click, keyboard context menus, and their three-dot button. Time buckets offer neither. Save and Cancel return focus to the live opening control after redraw.

## Read and status state

`domain/read.ts` owns stable turn keys, explicit read marks, and session watermarks. `turnread.ts` projects unread counts. Cards alone receive the unread state. Session headings draw no unread count.

Status combines the newest parsed turn with active child state. Error, completion, and explicit interruption take precedence, in that order. A durable Claude process end stops every other unfinished turn. An unfinished nonlatest turn is stopped. Without an earlier outcome, an unfinished latest turn stops after more than one hour since a positive `endedAt`. Without an earlier outcome, a latest turn with nonpositive `endedAt` retains running status. Full parsing, metadata, and lifetime indexing must agree. Process shutdown must not change activity recency. Running belongs to each session.

Needs input includes current permission requests, current questions, and unanswered recovered questions. `AgentHost.waiting` supplies them through `setAsks` to `waitingSessions`. Waiting overrides running and remains in the stable active group. `NEEDS_INPUT` supplies the visible and accessible phrase. Request resolution and turn completion clear live requests. [Question recovery](question-recovery.md#question-recovery-contracts) owns recovered-question lifetime and async closure.

Running, Subagents, and Background use running styling. Their explanations say a new prompt is available for Subagents and Background. Needs input uses orange. Blue identifies unread alone. Unsent input uses the editor's modified-resource tone.

Marking a session read records its activity boundary. Later turns become unread. Marking a turn unread removes its explicit mark and lowers a covering session watermark to one millisecond before that turn. Explicit marks for other turns remain.

## Verification

Use `turnrail.test.ts` for projection and figures, `turnlabels.test.ts` for label ownership, and `turnread.test.ts` with `domain/read.test.ts` for attention state. Query grammar belongs to `domain/session-query.test.ts`.

Browser coverage lives in `rail.rows.browser.test.ts`, `rail.filter.browser.test.ts`, `rail.views.browser.test.ts`, and `rail.editors.browser.test.ts`. Use the subject's existing tests for identity, focus, responsive behavior, filters, views, and editors. `panel.webview.test.ts` covers host messages and page ownership. `panel.layout.test.ts` covers integrated layout.
