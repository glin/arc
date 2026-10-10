# Prompt box and controls

Use this guide when changing prompts, drafts, queued submissions, pending cards, model controls, account usage, completion, or MCP controls. [`agent-protocols.md`](agent-protocols.md) owns delivery over each CLI wire.

## State boundary

`composerview.ts` prepares the prompt box state and every word the browser draws. Preact in `webview/composer.ts` owns the stable shell, keyed completion options, and live prompt text field. `webview/attachments.ts` owns attachment chips, token-scoped browser reads, paste and drop handling, and attachment notices. `webview/queue-live.ts` owns queued submissions and live cards. The provider resolves each action's session id before it reads or changes a draft, queue, setting, or child session.

Each Prompt box action targets its session id. Drafts, queued submissions, pending cards, and selected settings use that same key.

The Preact Prompt box owner builds the prompt text field once and moves the rest of the prompt box around it. Background updates change stable child slots without replacing the root or prompt text field. The session list filter follows the same rule.

VS Code can replay focus to its outer webview frame after a primary click activates the editor window. The Prompt box retains that prompt click through the replay and restores its caret or selection once. Opening the native context menu cancels the restore, including after a Control-click or a keyboard menu chord. Another pointer press or an expired activation window also cancels the restore.

Draft text is mirrored into normalized extension state so a hidden or restored panel can recover it. The live DOM remains the source while the reader types. A draft that cannot be stored safely is dropped rather than cut into a different prompt.

Draft storage retains the newest whole prompts within 10,000,000 total characters. Each session's queued submissions fit within 1,280,000 total characters. A queued submission that exceeds its remaining storage capacity stays in the prompt box.

## Starting the first session

Available remembered setups use the shared setup-value checks.

When a project has no recorded session or local draft, a remembered setup can create a provisional draft through the ordinary draft path. The draft is selected, editable, and shown in the session list. If the reader abandons it untouched, the provider does not offer it again during that panel lifetime. Opening Servers can start a provisional Claude child. It creates no transcript or durable session record before the first prompt.

After the first prompt is accepted, the provisional shell stays interactive until one complete render introduces the durable session id. That render identifies the exact provisional-to-durable adoption. Interim updates retain the prompt box, heading, labels, pending prompt, and session actions. A delayed queued edit targets the durable prompt box. Delayed refusals restore the submitted text there only when no newer edit changed its revision.

With no remembered setup, New remains enabled and opens the New session menu with focus on the Agent field. No agent is chosen at first, so the panel does not rank an agent for the reader. After the agent is chosen, the Model and Effort fields use that agent's defaults. The Permissions field preselects `Auto` for Claude and `Approve for me` for Codex. `Claude default` and `Codex default` remain the first Permissions choice. Create draft stays disabled until the complete setup is valid.

The primary New action inherits the selected session when one exists. Current setup launches and handoffs wait for pending model evidence before they freeze the inherited setup. Explicit model picks, recent setups, and pinned setups start without waiting. The initiating session and panel remain its owners. It keeps the session's stored permission, including `Claude default` or `Codex default`. A session with no stored permission gets `Auto` for Claude and `Approve for me` for Codex. With no selection, it uses the latest available recent setup, including an older setup when a newer one is unavailable. A pin hiding its recent row does not change that choice. An unavailable current setup opens the New with... form. The inherited setup keeps effort only when its model offers it. Otherwise it omits the effort override. A fresh draft says that it is ready for its first prompt. An existing empty record says that it has not produced a response.

The New session menu opens beside New in the session list and in the narrow panel bar. It lists the "Same setup as current" row first when a session is selected. A list of pinned setups and recent setups follows. The custom fields and Create draft come last, on the same page. The menu grows with the panel up to a fixed cap. The list takes the room the other rows leave and scrolls on its own, so the fields and Create draft stay on screen at every pin count. Pinned setups come first, in the order the reader pinned them, and nothing removes a pin except Unpin. Recent setups show up to eight of the ten remembered setups. A recent setup equal to a pinned setup or to the current session's setup gets no row. Each list row has an Edit button and a pin button. A press on a recent row's pin pins that setup, and a press on a pinned row's pin unpins it. A list row lights as one row under the pointer, pin included, the way a session list session row does. A pinned row's pin uses the tone of a pinned session list session's pin. A pin press never starts a session and leaves the menu open. A pinned setup can name an agent, model, effort or permission mode that left the catalog. That setup stays in the list. Its row shows the stored value and the reason it cannot start a session, and it stays unlit under the pointer and keyboard focus. Its pin still unpins it. Pins never change what the primary New action starts. Opening the menu, Edit, a pin press, Escape and a press outside it create no draft.

The custom fields show Agent, Effort and Permissions as rows of choices and Model as a list. Each opening fills them from the setup the primary New action starts, or leaves Agent unchosen when there is none. Edit loads a row's setup into the fields, unavailable pinned rows included. A Model change keeps the Effort when the new model offers it, else it takes the model's first effort. A field whose value left the catalog shows the value that stands in for it, and a caution under the fields names the stored value. A pin button beside Create draft pins the setup the fields show. It reads pressed while a pinned setup holds those values, and a press then unpins that setup. Pinning edited values adds a new pinned setup and leaves the one Edit loaded in place. The field pin and Create draft stay disabled until an agent is chosen.

Pinned and recent setups belong to the project where ordinary New launches, using the first open folder in a multi-root workspace. Handoffs keep their source folder. A successful draft submission adds its setup to that destination project's recent history, even after the reader selects another project. Changing the launch project closes the menu and clears its retained custom fields. Running-session settings remain independent of these lists.

A response-link handoff creates an editable draft with the rendered local address and one blank line. It keeps the source session and turn as origin metadata. It inherits the source agent, model, effort, permission mode, and recorded working directory. A handoff that preserves labels snapshots them before the draft first appears. A handoff that makes no draft names its cause: a source response that is no longer available, a session outside this window's session list, a setup the catalog no longer offers, or a session with no recorded folder.

File attachments are staged under extension global storage and scoped by session id. Saved panel state contains normalized descriptors with a SHA-256 digest. The reader's source file is never changed or deleted. A missing, changed, or non-regular staged copy stays visible by filename and blocks the whole prompt until the reader removes or replaces it. The staging root is shared by workspace state records, so the extension does not sweep unreferenced files globally. A staged copy whose descriptor is lost can remain until extension storage is cleared.

## Submitted prompt memory

Arc saves the latest five workspace submissions before Enter clears the prompt box or sends to the extension host. Prompts, drafts, and queued submissions accept up to 1,048,576 characters each. Each saved submission keeps exact whitespace and line breaks. Repeated text remains a separate submission. A longer prompt or failed browser save remains visible and sends nothing. The prompt box shows the refusal and clears it when the reader edits the text.

Up in the prompt box recalls retained submissions before the selected session's recorded history. Down moves forward and restores the draft present before recall. Choose a session or create a draft before recalling text. Enter explicitly submits recalled text.

Recovery keeps full text independently of the recorded history's 4,000-character limit. Workspace storage confirms retention before agent dispatch. A confirmed destination identifies routing. Agent acceptance is recorded separately after successful delivery.

## Sending, queueing, and stopping

Enter sends and Shift with Enter inserts a line break. Command and Enter on macOS, or Ctrl and Enter elsewhere, sends from anywhere in the panel. A reader sends comments that way without leaving the card they wrote them on. An open comment editor refuses the chord, and Enter inside it saves the comment. One prompt usually carries several comments, so saving and sending stay separate presses. The send decision comes from `composerview.ts`: blank text sends only when unsent comments are attached.

An attachment-only prompt is sendable. A send snapshots the files currently attached. Rejection keeps them with the draft, while acceptance removes their descriptors. Each accepted copy remains staged until its own turn ends so later pending prompts retain their thumbnails. Completion can arrive while Codex is still returning prompt acceptance. The active handoff holds that completion and removes the staged copy as soon as acceptance finishes. A new session moves attachment state when its provisional id becomes the agent's session id.

A prompt sent to an idle session starts or reuses its child. A busy session takes a new submission directly only when the local queue is empty. Otherwise the submission waits in the queue behind the records already there, so delivery keeps first in, first out order. A Claude answer to an open request is the exception, because it joins the running turn that comes before every queued record. Work that the panel holds locally uses one persisted queue record. The record stores stable identity, text, comment claims, attachment descriptors, creation time, and a discriminated delivery state. That state names the current owner, reset barrier, active attempt, and recovery reason. Its waiting card appears at the top of the session. It offers Edit, Copy, and Drop without claiming that an agent turn exists. The card follows the output turn hierarchy. Its header shows age and agent, while its actions show the concise queue state. Editing swaps the complete waiting record with the complete active draft. Existing text, comments, and files on either side remain separate. Editing reset recovery leaves a hidden durable marker in the record's place. The marker blocks swapped content and dependent prompts until the edited draft is accepted. The host validates and reserves the waiting record before the browser changes the prompt text field. A newer browser edit refuses a delayed success and releases the reservation. Comment claims returned to the prompt text field remain persisted until that edited prompt is queued or accepted.

The main button follows the prompt text field. With text ready it sends. With an empty prompt text field during active work it stops the current turn. Escape takes the same Stop action for the selected active session. An open menu, dialog, hint, or popover closes first, and an editable field other than the Prompt box keeps the key. A stop is always scoped to the session named by the message.

Prompt assembly places the reader's typed text first and comments beneath it. Agent settings are applied through their control path, not embedded in the prompt. A send that the agent rejects clears neither the prompt's comments nor its failed pending card.

Paste and drop attach files to the prompt box. The prompt box has no Attach files control. The whole prompt box foot accepts a drop and gives the prompt text field a dashed outline while it is ready. Pasted and dropped browser files are captured during their event, read with `File.arrayBuffer()`, and sent to the host as metadata plus `ArrayBuffer` values. Known filename extensions determine the media type so browser MIME differences do not change agent compatibility. Ordinary text paste is unchanged. VS Code delivers a drop into a webview only while Shift is held, and the editor can consume a drag before the webview sees it. Drop support is an additional path for that reason.

A file or folder dragged from the Explorer or an editor tab inserts its path into the prompt text field at the caret. The drop event reads every drag value before any wait, because the data is gone afterward. A drag that lists file URIs takes this route even when it also lists Files. An OS file manager drag lists Files only and keeps the staged-bytes route. A drag of a web link, which lists no `file:` URI, keeps the normal text drop. Only `file:` URIs count, and the inline notice says how many other items Arc skipped. Path text has the form that path completion writes. It is relative to the session working directory when the item sits inside it and absolute otherwise. It takes double quotes when it contains whitespace, and a folder ends with a path separator. Several paths join with a space, and Arc adds no `@` prefix. An image file (JPEG, PNG, GIF, or WebP) becomes an attachment instead. The host checks the file count and the file sizes against the attachment limits before it reads any image from disk, then stages the images the way it stages pasted images. When logging is on, the diagnostics log records the drag types each such drop reported.

Add to Arc appears in the Explorer menu and in the editor tab menu. It applies the same rules to the clicked item, or to the whole Explorer selection when the clicked item belongs to it. It writes into the prompt box that the panel shows and reveals the panel. It has no keybinding and no command palette entry.

A staged file whose extension has no known media type counts as plain text when its bytes are valid UTF-8 and hold no NUL byte. Claude therefore accepts source files such as `.py` that an OS file manager drop or the clipboard supplies. Known extensions keep their media type.

While a file is being read or staged, Send and Enter wait, and a dashed chip says how many files are attaching. The one exception is a Codex `/rename` draft, which the Prompt box sends at once because it carries no attachment. A second paste or drop is rejected with an inline notice. Each staged file chip shows a thumbnail for an image or a kind word for another file, its name with a preserved extension, its size, and a keyboard-reachable Remove button. A refusal names the file beside the prompt box and clears with the next edit, attach, or removal. Pending and failed prompt cards retain the same chips without Remove. Recorded transcript cards remain text-only because the transcript readers do not currently retain vendor attachment records.

A new-session draft cannot switch to an agent that does not accept one of its attached files. The file remains attached, the agent stays unchanged, and the inline notice explains which file must be removed. Compatibility and staged contents are checked again when Send is pressed and after any session-opening wait.

Only one attachment-bearing prompt per session can wait for agent acceptance. An overlapping send is refused and its browser draft is restored only if no newer edit has replaced it. Active staging keeps an otherwise untouched new-session draft on the session list. A file read that finishes after a new session receives its agent id follows that identity change before it merges descriptors. The selected agent is checked again at that merge point. Stop also cancels a Claude attachment prompt whose files are still being prepared, before its user message reaches the wire.

Compaction has its own action. It does not call prompt assembly, attach comments, or use the ordinary prompt callback. Pressing Compact in Context detail leaves the draft alone. Submitting an exact `/compact` uses the same action and clears those submitted characters. Either request waits in the local queue when the agent is busy. Codex rejects `turn/start` during native compaction, so prompts submitted during that control turn also wait locally.

Clear uses a hidden transition because it starts no turn. Codex `/new` uses that transition and passes its optional name to the successor. The `/new` queue record owns its comment claims and files before the reset starts. A queued exact `/clear` with comments or files keeps that payload under the same reset ownership. It never turns the command into model input. The record captures any unclaimed source comments immediately before the control request. The transition ends after the agent accepts the request and names the successor session. Claude reports acceptance first. Codex reports the successor first. Reset success moves the reset payload and its dependent prompts to the successor before that queue drains. The source keeps its transcript, comments, labels, and list row. Reset refusal or failure keeps the complete reset payload as source recovery. Its dependent prompts remain blocked until Edit or Drop resolves that record. A restored in-flight reset becomes unknown and starts no agent work. A recorded successor remains the owner through delivery refusal, failure, Edit, Drop, and reload. The host routes stale panel submissions to the successor until that panel paints the new session. The source becomes independently selectable after that paint. A successful reset draws no temporary card.

Sending during Codex compaction transfers the complete submission only when the local queue can persist it without truncation or eviction. Attachment-only submissions follow the same path. A waiting record owns its staged files across repaint, session changes, and window reload. Reload restores the queue before attempting to drain it. Before a drain crosses the agent boundary, it persists the delivery state. A restored active attempt becomes recovery and is not submitted again automatically. Edit is the explicit retry path. Drop removes staged data only after no active draft, waiting record, or handoff refers to it. Delivery refusal retains the record, its owner, its files, and the reason. Delivery acceptance transfers file cleanup to the accepted turn. That exact turn releases the files when it ends.

## Pending cards

A press creates a temporary card immediately so the reader can see what the panel is waiting on before the record catches up. The card carries the exact prompt sent, its session, and its state.

Streaming response text attaches to that card. Its head opens the complete response with paragraph breaks while the recorded turn is being read. Each new submission starts collapsed. The card stays through stale, aborted, and superseded reads. A prompt card leaves when the accepted selected window contains its recorded turn or when the CLI answers `/model` or `/context` itself without a turn. A prompt card with no recorded turn stays visible.

A failed prompt stays until the reader dismisses it or restores its text. A locally queued submission uses a dashed waiting card whose activity row says it is waiting to send. A failed delivery and an uncertain handoff restored after reload use their own concise states, while the complete explanation remains in the card's accessible name. The uncertain state does not suggest retrying because the agent might already have received the prompt. When the agent accepts the submission, the protocol live card replaces the waiting card until the accepted selected window supplies the recorded turn.

A manual compaction is the running action, so its pending card says the session is being compacted. Only a prompt accepted behind that action says it is waiting for earlier work.

A failed compaction card displays the outcome and the agent's cause. It offers another compaction attempt. The Prompt box owns both lines, and the editor notice repeats the cause. A refused prompt instead offers text recovery and another send attempt.

Recovery from a Codex writer lock moves an accepted continuation prompt to the forked session returned by the server. Declining leaves the failure on the source session.

A later prompt can replace an earlier prompt card, and it draws its own card when the earlier recorded turn has not arrived. Direct agent activity remains on the newest recorded turn while parsing catches up. A continuation handoff moves the press to its new session. A queued handoff failure returns the prompt to its waiting card.

A compaction card leaves at its recorded compaction boundary, when its work stops, after its five-minute limit, or when the CLI answers without a record.

## Agent requests

A live Claude or Codex child can stop on a permission request or a question. The host keeps the normalized request until the reader answers it or the turn ends. A Codex async question stays after its turn ends and closes as the `delivery: async` paragraph in `docs/agent-protocols.md` describes. The selected session draws those requests above its prompt text field. The reader answers a request from that session's prompt box.

A request card uses the turn card's frame, background, and corners. Its left border uses the session list's Needs input tone. The heading shows the title and `needs you`. After submission, controls disable and the state reads `sending your answer` until the host removes the card.

The request heading controls disclosure and names its action. A collapsed request shows only that heading. Question headings also show answered-question counts. Permission headings omit counts. The collapsed body is `hidden`, so its controls leave the Tab order. Requests start expanded and retain independent folds only for the browser lifetime.

Permission cards offer immediate Allow and Deny actions. A shell command is shown in a code block, while other request details remain prose.

A question card displays one question at a time. Each tab uses the agent's short label or the question number. Answered tabs show the chosen answer. A single-choice answer advances to the next unanswered question and announces the move in a polite region. Multi-select answers never advance automatically. Pressing a tab selects its question. Arrow keys move between tabs. Home and End reach the strip boundaries. The strip has one Tab stop.

The strip wraps and never scrolls sideways, because a horizontal scroller inside a scrolling panel hides what it holds. Past two rows every tab drops its value and marks only whether its question is answered. The mark never carries the meaning alone: the tab's accessible name still reads the whole answer, including a value the strip cut short or dropped.

The action button says `Next` until every question has an answer, and `Answer` after that. The line beside it says which question the reader is on. The reason the button is off is written beside it in the same words its accessible name carries.

Every question offers `Other` last. Taking it opens a multiline field under the row, and the action button stays off until the reader types. Shift+Enter inserts a line break. Enter activates the visible primary action, which advances to the next unanswered question or sends the completed answer. A question takes offered labels or a written answer, never both, so taking `Other` clears the checked boxes and checking a box clears `Other`. A written answer reaches the agent as the reader typed it. Claude joins it to the labels in one string, and Codex sends it in the same list. Codex asks the client to add the choice: its own tool schema tells the model to leave `Other` out, because the client adds it.

A question that asks for a secret takes its answer in a single-line password box, and its tab reports that it is answered without reporting what it says. Enter sends a complete secret answer.

Question text renders block Markdown in the fieldset's named content area. Reference links use the timeline's navigation routes. Choice labels and descriptions render inline Markdown without links, images, or buttons. Answers retain the agent's original choice labels. Raw HTML stays escaped except for validated disclosures, whose rules belong to [Timeline rendering](timeline.md#markdown-disclosures). Permission explanations retain their text or command treatment.

The agent's short question label also appears before the question when the card has no tabs. A line below the question says whether the reader can take one choice or several. A taken choice row keeps a ground of its own. Question cards also offer Decline, so an unreadable request does not leave the child blocked. The browser retains unfinished selections, written answers, the question on screen, the fold, and nested scroll position across unrelated updates. A changed session or ordered request identity resets only the nested scroll position. The browser sends nothing until the reader presses an action. The extension validates every submitted label against the current request and refuses a label nobody offered.

Send answers the open requests before it delivers the prompt. A reader who wants none of the offered choices types their own answer and presses Send. Without this the request stays open, the child stays blocked on it, and the prompt waits behind a question that nobody answered. The requests are told that the reader took none of the choices and answered in their next message, which is a different thing from a refusal. A sentence beside Send says so before the press, it joins the send control's own name, and its arrival is announced in a polite region of its own.

Radios and checkboxes are the browser's own controls. The panel keys their colour scheme off the theme class the editor puts on the body, because the editor publishes no colour for them. Only the real panel carries that class, so these colours can be confirmed only there.

An arriving request is announced in a polite region and does not take focus or scroll the page. Three polite regions stay apart, one for an arriving request, one for the move to the next question, and one for the sentence beside Send, because a region that mixed two subjects would read as one. The controls disable after submission while the host resolves the answer. A successful answer, an agent-side resolution, a stopped turn, or a child exit removes the card from live state.

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

## Session controls

The picker row describes the next turn in the selected session. It contains model, effort, ask mode, context usage, optional MCP state, and the send action. Each control has a complete accessible name.

The New session fields and Prompt box setting pickers use select-only comboboxes. Arrow keys move a tentative choice while focus stays on the field. Enter, Space, pointer selection, and Tab accept it. Escape cancels it. Tab moves to the adjacent control, and options add no Tab stops. MCP actions and toggles keep menu roles. Open Model and Effort option rows carry `(default)` only when the CLI reports their defaults. Closed fields and setup summaries show concrete names without generated annotations. Loading and unavailable metadata appear on the closed fields. They never become choices. Opening, cancelling, or accepting the selected row preserves saved launch values. Choosing a different default Model row restores omitted model and effort overrides for a draft. Choosing a different default Effort row restores only omitted effort. Live sessions send supported switch values.

Model catalogs belong to an agent. Selected and pending values belong to a session. Transcript facts settle pending values after a turn records them. Both agents change model under the child that is already running. Every effort menu offers the chosen model's own levels and ticks the level this session stores. A pick stays pending until a turn records it. A Claude pick made while the session is working reaches the child once it has nothing running.

Ask modes use each agent's own language. A Codex choice maps to approval policy, approval reviewer, and sandbox policy. With no Arc choice, Codex resolves these values from its configuration and folder trust. The permission control marks the matching Codex preset. It marks no row and says `Codex settings` when the effective values match no preset. New and a handoff from a session with no Arc choice preselect `Approve for me` for the new session. Codex auto-review can approve, deny, or forward a potentially unsafe action to the reader. Other modes route surfaced requests to the reader. Thread starts and turn starts use different sandbox spellings. The wire adapter owns that translation.

Context usage belongs here because it describes the selected session. Account rate limits belong in the status bar because they span sessions. The turn card retains its own historical context figure. When a newer compaction has no recorded resulting level, the prompt box omits its context meter until a later request records the current level.

A newer failed turn with no runtime facts keeps the last recorded model, effort, context, and next-turn estimate. A newer compaction with no recorded resulting level still removes context and price.

A stopped Codex turn without a reported model displays the session's last reported model. This identity supplies no effort, context, or next-turn estimate. A newer reported model takes precedence, including a recorded settings change. Selected and pending choices retain their existing precedence.

The line directly above the prompt text field says what the next turn costs before the reader types. The selected next-turn model drives that estimate as soon as the picker accepts it. A genuine model change starts uncached because the previous model's cache does not belong to the selected model. A selected choice without an exact public price removes the estimate until a later recorded turn supplies priced runtime facts. A muted comma clause says whether the cache is uncached or cached for another span. `composerview.ts` sends the warm and cold faces, with a conservative cold boundary before the nominal lifetime ends. The browser picks one face from its own clock. A compaction is cold from the moment it lands because nothing has cached the session it wrote. An open turn can hold tool results that no later request measured, so the line waits until the turn closes. The faces share one grid cell, so the line holds the height of the longest of them. The prompt text field under it never moves when the state changes.

The next-turn estimate uses chip-height text in the muted foreground. Spacing separates it from the prompt text field.

Only the price is pressable. The words around it are ordinary text, kept out of the accessibility tree because the price's own name carries the whole sentence: a listening reader hears it once instead of hearing it cut in half by the control inside it. Each face carries its own price, so a face change moves an open popover and the reader's focus to the price that arrived. Only the visible face carries the name used for focus restoration in the Prompt box footer. Restoration selects the first control with that name, so it must exclude hidden prices. A press opens the same popover every figure chip opens. It repeats the visible price and cache status, then shows an alternate cache estimate when one exists. A compact disclaimer under `About these figures` states that these are conservative API list-price estimates.

The remaining warm cache lifetime has its own node on the shared age ticker. Its updates require no repaint and preserve text selection. Only that duration carries the dotted lifetime affordance. The cache status retains its model lifetime as a native title without exposing a request timestamp. The figure uses whole minutes, with a minimum of two minutes. The bands on either side of the boundary cover shorter durations. `docs/timeline.md` holds the pricing and the reason.

The panel measures the status bar and Prompt box heights whenever either changes size. A narrow status bar can wrap without a render.

A draft carries the same row plus an agent picker, and no context figure, because a draft holds no window yet. Its four setup values come from the draft profile alone, so a draft ignores the stored per-session picks and the per-agent ask mode. A changed value marks the profile custom. The tag above the prompt text field names the draft and says nothing about the setup, because the row under it draws all four setup values already. Changing the agent resets model and effort because each catalog belongs to one agent. It sets the permission to `Auto` for Claude and `Approve for me` for Codex. The optional MCP control shows the servers reported for that draft.

A draft rejects setup changes while a submission is pending or after one succeeds. A failed first submission leaves setup changes available for retry. The child starts from the captured setup. Typed text or changes through draft controls retain the draft after session selection changes. The launcher's custom form alone does not retain an otherwise untouched draft.

## Usage status bar

`usageview.ts` normalizes the limits and money caps reported by each CLI. The panel does not derive an account limit from transcript token totals.

The collapsed bar shows current figures. Hover or focus opens a temporary detail view. A press pins it until another press or Escape. The detail view is a popover so opening it does not move the timeline.

The shared age describes the oldest displayed reading. The popover shows this age in its bottom refresh control. Each agent's detail includes its full local reading time in its accessible name. Unchanged utilization still receives a new age when the agent admits a new reading.

Read again discovers Codex account eligibility and requests supported usage from both agents. Only the bottom refresh control shows changing progress. Each detail group reports failed or empty outcomes. Missing and expired figures retain these groups and the retry control without inventing percentages or reading times. The collapsed bar says Account usage when no figures remain. A newer admitted reading removes that agent's terminal feedback without changing the expired attempt's outcome. Hidden Codex discovery keeps refresh pending until eligibility resolves or the attempt expires. The button keeps focus while either agent remains active. Its accessible name includes its visible label and supported agents' states. One announcement summarizes newly observed terminal outcomes. Reopening the panel does not announce retained completed attempts.

Bedrock Codex accounts contribute no subscription figures, plan, detail group, refresh outcome, or announcement, including after a busy-wait timeout. Discovery removes retained Codex limits from workspace state and leaves Claude readings and historical usage files intact. A later supported account reading restores Codex usage. Unknown accounts, signed-out accounts, and discovery failures retain retryable errors.

Fresh values can arrive from live wire events, a read after a child finishes, a transcript refresh that detects finished work, or an idle child started only to answer controls. Failed or fresh reads are not repeated until the reader explicitly refreshes or the freshness rule allows another read.

An expired limit is omitted. Complete readings replace account state, while partial live events update only the limit they name. A complete answer with no rate windows retains live windows because a money-cap answer says nothing about their clocks.

The account answer gives the credit cap no reset clock. Its row uses the next month boundary at midnight UTC and marks that moment as expected. A reported credit clock from a live rate-limit event replaces the expected moment.

A Codex live update can describe a named model bucket instead of the account aggregate. Its model name remains the bucket's scope, so it cannot replace an account figure. The usage bar omits named Codex buckets from both faces. The complete per-limit inventory remains unread until a bucket is actively published.

Claude's `seven_day_overage_included` window is a weekly bucket for one model, and live events carry no model name for it. The panel omits it. Claude Code omits it too, and draws the account answer's model-scoped weekly limits instead.

Claude Max is presented as `Max plan`. The account answer names no tier modifier, so none is drawn. Codex `pro` is presented as `Pro plan`. Every other reported name keeps its own spelling with `plan` after it, so `prolite` reads `prolite plan`. The rate-limit payload supplies no multiplier or display name.

## Skill and file opening

Opening a skill file is its own host route, not the card's file route. `openFile` uses the card's session for its own file rows and the dispatched child's session for that child's file rows. A dispatched file action names the child and a path listed under its row before the host reads its snapshot. `openSkill` accepts a path only when the card's recorded skill list holds it, then confirms that the path is still a regular file. A path that fails either check opens nothing and reports nothing.

## Prompt entries

Command catalogs arrive during agent initialization. Quiet Codex state can also obtain its skill list through an idle child. A connected Codex child refreshes the catalog after Codex reports a local skill-file change, so added, edited, and removed skills reach the Prompt box without a reload. Codex identifies commands and skills in its own catalog. Claude publishes one command list with no ownership metadata, so which of its entries are real skills comes from a separate list: the Claude skill names last reported for that session's working directory. The panel highlights and makes inspectable a Claude command, other than a panel control such as `/mcp`, when that working directory's skill list names it. `/compact` and `/model` are never highlighted, because the prompt box already draws its own control for each, regardless of whether a reported skill list also names them. Before a working directory has ever reported a skill list, every other Claude command gets the highlight, including a built-in that is not a real skill, such as `/context`, `/help`, or `/review`. A Claude entry's popover shows a definition path when Arc finds that skill's `SKILL.md` on disk, in the session's project skills folder first and then the reader's own Claude skills folder, and shows no path line when neither folder has the file. Command catalogs live in memory only, filed by agent, so a window reload starts autocomplete empty until a session answers again. The Claude skill list persists in workspace state, filed by working directory, and survives a window reload.

Claude commands use `/`. Codex commands use `/`. Codex skills use `$` and also accept `/`. The completion menu preserves the prefix the reader typed. Dollar text opens a menu only when it matches a listed Codex skill.

The prompt text field marks a complete slash-form Codex skill or a highlighted Claude command without replacing its native control. Pointer drags and modified clicks select through the mark without opening details. A click or keyboard press opens a read-only detail popover. The popover follows a visible mark when text scrolls or the session list moves. A hovered or pinned popover hides while its mark is clipped and returns when the mark comes back. A pinned popover keeps the same logical token across edits. It closes when that token disappears. The popover shows the catalog description. It also shows the definition path when the Codex catalog supplies one or Arc finds the Claude skill's file on disk, and shows no path line and no blank space in its place when neither does. Closing the popover returns focus without changing the prompt, selection, or editing history. Removing the focused mark returns focus to the prompt text field.

`composerview.ts` owns prompt-entry wording and completion text. Browser-safe token detection and matching live under `domain/`, where the Prompt box and host import the same rules. The next keypress acts on the text currently in the prompt text field without waiting for a host response.

## Local path completion

The Prompt box completes a path at a collapsed caret that ends a path token. A token can start with `~/`, `./`, `../`, `/`, a Windows drive, a UNC root, or contain a separator. Matching quotes keep spaces in one token. The Prompt box preserves the root, quotes, and separator style.

The provider uses the selected session's recorded working directory. A new session uses the directory frozen in its draft. The webview never supplies a directory. The provider reads one named parent directory and returns no row when it cannot read that directory.

The shared completion list gives a matching prompt entry priority. Otherwise it shows matching files and directories. Directories appear first and add the typed separator. Hidden entries appear only after the unfinished name starts with a period.

The Prompt box keeps focus in the prompt text field. Arrow keys move the active row. Tab accepts a path row. Enter keeps its send behavior. Escape closes path completion until the token changes. A pointer press accepts its row without moving focus.

The prompt text field exposes the active row through `aria-activedescendant`. Each row states whether it names a file or directory. A path completion writes one undo step, updates the draft, grows the field, and ends a prompt-history walk.

The browser delays a request and rejects a result when its session, token, caret, or request identifier changed. A late reply never changes the draft.

The menu is a listbox controlled by the prompt text field. Focus stays in the prompt text field, the active option is exposed through `aria-activedescendant`, and pointer presses do not steal focus. Completion ends the command name, so the following Enter sends.

Background prompt box refreshes preserve the reader's scroll position in an open command menu. Typing, moving the caret, and changing the active option still bring that option into view.

Exact `/compact` and `/clear` commands ignore case and surrounding whitespace. Codex `/new` also accepts an optional same-line session name. Codex `/rename` takes the rest of its line as the session name and renames the session the way the session list's rename control does. It starts no turn, waits for no running turn or staging file, and answers no open request. Attached files and comments stay in the Prompt box for the next prompt. When the rename fails, or the line names nothing, an editor error message gives the reason. The line then goes back into the Prompt box, unless the reader changed the Prompt box text after Send. Claude runs its own `/rename`, so a Claude session sends it as a prompt. The timeline draws no card for a command the Claude CLI runs by itself, and the Prompt box shows no message for its reply. The panel recognizes these controls before prompt assembly. Codex receives native app-server controls, not a `turn/start` containing literal slash-command text. A sentence that mentions a command, an argument after `/clear`, and `/safe-compact` remain ordinary agent input.

## MCP controls

`mcpview.ts` converts each agent's server report into status rows and supported actions. No control is drawn when the agent reports no configured servers. A missing initial idle answer is retried when the reader opens a draft for that agent or returns to the panel.

Opening Servers on a Claude draft starts or reuses that draft's child. Arc retains it while pending servers settle and reuses it for the first prompt. Each draft and recorded session keeps its own server reading. The Servers menu uses action and checkbox roles. Arrow keys, Home, End, and typed names move focus between actions. Tab closes the menu and continues through the Prompt box. Escape closes it and returns focus to Servers.

Claude supports status, toggle, and reconnect through its control channel. Codex currently supplies status only. A reported `disabled` state means off. Unknown states are shown as the agent reported them and are not treated as disabled.

Claude writes some MCP setting changes only during orderly child shutdown. `agenthost.ts` closes a child through its input before it kills an unresponsive process. A status refresh begun before a toggle cannot overwrite the result of the toggle.

Authentication and server configuration have no panel workflow. A server that needs authentication reports that state without offering an action the panel cannot complete.

## Verification

`composerview.test.ts`, `usageview.test.ts`, `mcpview.test.ts`, and `agenthost.test.ts` own the host decisions. `composer.browser.test.ts` exercises the shipped page, stable prompt text field, editing state, draft authority, prompt history, and slash behavior. `panel.webview.test.ts` checks control wiring, pending cards, agent request answers, and accessible markup. The `panel.layout*.test.ts` files check that the Prompt box, request cards, menus, popovers, and status bar stay inside the Panel.

## Context detail

Hover or focus on the context bar opens context detail. Clicking the bar or pressing Enter or Space pins it open through pointer and focus departure. Tab reaches Measurement details and Compact, which compacts the selected session. Escape or pressing the expanded bar dismisses detail and returns focus to the bar. An outside press or session change also dismisses detail.

Claude summary categories show provider estimates from the selected connected child. The heading shows percent used, the accounting-window capacity, and occupied tokens. Category rows show shares of used context in separate horizontal meters only when their sum equals the reported total. Native titles and screen-reader text retain reported token counts and the accounting-window capacity. Native free space supplies Remaining. The compaction reserve appears as a shorthand note above the footer and stays separate from Remaining. Mismatched totals retain their warning and percentage-only table without meters. Codex category estimates and unavailable states follow [Cost and context](timeline.md#cost-and-context). Disconnected Claude sessions retain recorded figures and show unavailable category detail.

Inspection starts no child or model turn. Context changes invalidate only the affected session's detail, and obsolete replies cannot replace it. Refreshing an open detail preserves its disclosure choice and selected text. Focus stays on a surviving control or falls back to Compact or the dialog. Pointer or focus inside the detail keeps it open. A positive category with a zero reported total shows an unavailable percentage.
