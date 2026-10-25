# Turn cards

Read this guide when changing turn presentation, Activity, record rows, Markdown disclosures, or commit attribution. [Session list and navigation](rail-and-navigation.md) owns session headings, session list rendering, response links, and panel navigation. [UI design](ui-design.md) owns shared visual patterns. [Comments](comments.md) owns selection offsets and comment recovery. [Prompt box](composer.md) owns prompt delivery and attachment state.

## Card sources

`turncard.ts` prepares the browser-facing card. `webview/card.ts` draws it without repeating decisions about wording, status, marks, cost, context, or file meaning. Keep presentation decisions in the host projection when adding a field.

The chip row orders cost, context, files, tokens, commits, subagents, then dispatched work. `chipsOf` builds every figure except dispatched work. The host resolves dispatched children through its catalog and appends that figure. Missing figures stay absent. [Snapshots and diffs](snapshots.md#diff-selection) owns recorded file evidence.

The Card layout setting selects Compact, One column, or Two columns. The column layouts draw Subagents, Dispatched, Commits, then Files when those collections exist. Cost stays above the body. Both layouts and chip popovers draw the same `DetailRowList`. The host names the record collection. `withRecordRows` attaches the card's existing array before drawing a chip. The popover receives a row-rendering callback instead of importing row components.

Prompts start clamped. Above the response, the opening prompt uses two lines and later prompts have a separate toggle. Saved comments reveal later prompts until the reader changes that toggle. Below the response, the prompt follows its heading. Both positions use `You asked` for reader prompts and `Assigned task` for Codex assignments. An assignment with no readable payload reports unavailable full instructions. `PromptLead`, `PromptSection`, and `PromptBlock` own these disclosures. Preserve their comment anchors when changing placement.

Card facts originate in transcripts or rollouts. [Card sources](timeline.md#card-sources) owns live activity reconciliation with recorded work. Snapshot content supplies current-file diffs only. [Snapshots and diffs](snapshots.md#diff-selection) owns that boundary. [Data sources](data-sources.md#source-catalog) owns recorded-source locations and provenance. Do not infer missing state from a figure's absence or from an incomplete child record.

## Activity

Activity starts open. A done turn initially shows recorded agent messages, including earlier replies. Other statuses show the chronology of narration, replies, later prompts, reasoning, and tool-call runs. A reader's filter and disclosure choices survive card repainting. Filters last until reload. When completion changes the default filter, a focused non-message row remains until focus leaves Activity.

The Activity head orders message and reply counts before the tool mix, then the skill count. Message and reply counts toggle their filters and open a closed log. Messages keeps agent messages. Replies keeps replies alone. Tool-category counts open raw invocation detail. Skills opens the loaded skills. A skill load never becomes a tool category. A done turn with other activity and no agent message states that no messages were recorded and retains the full-activity action.

`logOf` keeps message chronology while the step cap removes calls only. An emptied run keeps its original total and tool mix. A partially retained run identifies missing calls above retained calls. Runs fold when their calls finish. Explicit choices survive repainting, and focus inside a run delays its automatic fold until focus leaves.

Messages offer Show all beyond their rendered bounds. Shift on Activity toggles every visible message's bound. Shortened command rows open their complete text on a press. Arrow keys move among run and command controls. Escape closes an open row. A message carries its time on its bubble. Never put a native title on its Markdown row, because that title replaces link-address hovers.

`snapCut` measures the last complete line box, table row, or image inside the message's height limit. The limit comes from its font size. Reading the resized box as the limit creates a ResizeObserver feedback loop. Clipping updates interactive descendants' tab stops and measures again after expansion. CSS line clamping does not clip blocks containing `pre` correctly.

Marks summarize existing turn fields or the closing summary. They supply navigation, not another state source. Failed calls stay in Activity without header marks or chips. A settled tool-call group uses a neutral disclosure marker. Failed calls retain their markers and the group retains its failed-call count. Literal text separates that count from the tool total. Those failures establish neither recovery nor a failed group outcome.

## Markdown disclosures

Responses and Activity messages accept balanced bare `<details>` sections with one nonempty `<summary>` first. Tags accept case differences and whitespace. Source attributes stay escaped, including `open`, `name`, styles, and event handlers. Summaries render inline Markdown without interactive descendants. Bodies render block Markdown, including tables, lists, fences, and routed links. Tight bodies and blank lines work. Nesting stops at 32 levels.

Code, escaped tags, and HTML comments never establish boundaries. Incomplete, orphaned, duplicate-summary, malformed, or deeper sections stay escaped without truncation. Other raw HTML stays escaped. Pass Markdown to the renderer without pre-escaping it. Preserve recorded line breaks.

`richtext.ts` scans structure before Marked lexing, which otherwise consumes tight bodies as HTML. Marked supplies list and blockquote boundaries. Leading tabs expand before container recognition. Position maps return stripped lines and expanded tabs to original positions before literal masking. Fragments share reference definitions before inline lexing. Each render keeps its own configuration.

Native summaries retain Tab, Enter, and Space behavior. Mounted Summary components capture disclosure state before replacing HTML. Unchanged headings and ancestry preserve open state and focus. Changed headings and ambiguous repeated headings receive no inherited state. Create descendant controls before restoring retained focus. Disclosure headings accept comments. Closing a section preserves stored text offsets. Selected Markdown preserves disclosure structure, lists, fences, and tables. Full response copy preserves original source.

## Card and disclosure contracts

`DetailRowList` uses explicit child file and commit collections first. Ordinary native rows without them use parent rows. Dispatched rows without them use empty collections. Explicit empty collections stay authoritative. A child figure's files record offers no whole-turn diff, because it contains only that child's share.

`attributedFiles` combines parent and child files by recorded identity or normalized path and sums recorded counts. A single child receives attribution only when no other child or parent changed that path. Browser membership uses recorded identity when available, otherwise the card's path spelling. Child commit membership accepts abbreviated and full hashes by prefix. Its commit record excludes landings.

File totals retain counted lines alongside unknown-count evidence. Their visible face and accessible name carry no partial mark. The record footer explains each cause and whether counts are unknown or partial. `diffHalves` omits zero-valued added or removed halves. When both halves are zero, callers omit empty wrappers and separators. Keep visible and spoken figures consistent.

The card body's Files section reveals `FILES_SECTION_CAP` rows per press. The cap is 20. The label names the next batch and the accessible name adds all remaining hidden files. `aria-expanded` becomes true after the first extra batch. `aria-controls` names a stable, card-specific rows container through `cardPartId`. The button stays mounted through full expansion, then collapses to the first batch without losing focus.

Expansion survives live redraws. Fully revealed lists stay revealed when they grow. A list that shrinks to the cap resets expansion, so later growth starts at the first batch. Chip popovers use no row cap and scroll within their own bounds. Keep capped and uncapped views on the same row component.

Each commit record groups rows by branch within repository through `groupCommitRows`. Group headings appear only when rows span groups. The wire array remains flat. `commitGrouping` caches by array identity, so the body, popovers, and clock share the grouping. Host headings carry branch facts without merge times. The browser supplies merged-word hovers and accessible times through `writeCardClock`.

## Subagent and dispatched rows

A current Codex collaboration spawn supplies its recorded thread id and nickname. A machine-marked terminal notification takes precedence. Without one, a direct child rollout's terminal boundary can settle an open parent row as completed, failed, or interrupted. Terminal child usage attaches once. Project and lifetime spend discover child rollouts structurally.

[Card sources](timeline.md#card-sources) owns structural review attachment and parent-row precedence. The newest child outcome supplies state, and its transcript supplies model and usage. Descendants never flatten onto the root turn.

Running children show cost so far, or tokens when no price applies, as a lower bound. An unfinished child without live evidence uses the idle tone and reports no recorded ending. It shows no commits, files, or duration figure until it ends. Its hover retains elapsed time and tool count while open. Finished figures carry duration, cost, commits, and paths in separate records. Priced usage closes the cost record. Unpriced rows retain a separate usage figure.

`agentFigures` and `agentDisplay` own record allocation and wording. Claude foreground counts come from Agent results. Background counts come from completion notices' `<tool_uses>`. Finished children without either count total their own calls. Codex children total their own calls. A Claude CLI row under a Codex parent supplies no tool count through that attachment path. Failed calls with unknown tools increase the failure total without adding a tool line. Duration records split tools by name without repeating the hover's total. Multi-turn Codex and dispatched children put Turns before Started and Ended. Claude subagents retain one turn. Local start and end times close the record.

`AgentRow` gives linked names the run hint and session action. A row without a session keeps its own run-detail stop. Its figures share one Tab stop. Left and Right move among record figures, closing the old record and opening the next unpinned. Record figures suppress the row hint. `StaticStatChip` supplies an accessible role and name together. Interactive figures take the button role and answer Enter and Space. Named figures without records take the group role.

Background children can outlive a completed, failed, or interrupted newest turn. The newest card includes carried subagents in the same live-child count used by the session list and popover heading. A running or stopped newest turn counts none through `childrenOutliveTurn`. Open-child and background-command expiry belong to the session outcome sources in `turnrail.ts`, rather than browser timers. Keep row state, card counts, and session status on those shared answers.

Dispatched rows use catalog status and open the child's full session id. Their explicit files and commits include editor-action paths and repository directories. An unfinished stopped child marks figures as lower bounds. The parent's own files, commits, and ordinary subagent attribution remain separate. `movedDispatchedCards` compares contribution prints. Ledger completion, hydration, source changes, pending-source changes, and discovery readiness redraw affected cards through one `activity` message without transcript reads or catalog refreshes.

## Recorded command and commit contracts

A printed hash needs activity capable of running Git before it becomes a commit row. Literal Bash and PowerShell inspection also supplies repository candidates. Unknown targets and exhausted inspection leave navigation unresolved. Complete candidates resolve through exact objects and common Git directory identities. Competing objects, independent repositories, and inconclusive reads keep the hash unavailable for navigation. Unproved rows remain readable text.

Quiet commits need command-scoped attribution. Claude uses the tool-call window. Codex uses a completed command's execution window. A turn-wide window includes unrelated parallel work. Recovery accepts exactly as many commits as the command's `git commit` count. Git timestamps use seconds, so selection widens the window to whole seconds. The repository count and head log also permit a quiet commit behind a trailing pipe.

Conditionals, generic or-else expressions, and command separators remain refused when success does not establish a commit. A guarded or-else qualifies only for one commit leading directly to `git log --oneline -1`. Final output must supply that log's hash. Its fixed `echo` fallback cannot print a log-shaped line. The repository candidate must match the witnessed hash.

Repository identity comes from `git rev-parse --git-common-dir`, rather than path containment. The branch is read with commits and retained, so later branch movement does not rename historical rows. A known hash with an unavailable command directory can resolve through open folders using `git log --no-walk`. Every answering folder must agree on the full hash. The answer cache follows the open-folder set. Unknown commits never borrow an open folder's time window.

Fast-forward landings require `merge <ref>: Fast-forward` head-log entries inside the merge-call window. Later checkout entries identify the branch moved. Commit time never selects a landing. Each invocation remains separate, including repeated landings on one hash. A landing stays outside `turn.commits` and the commit total. Shared rows and figures present commits and landings together, such as `1 commit · 1 merged` or `1 merged`.

Capture the merged branch with the landing. Use the named ref, or the first branch from `git for-each-ref --points-at` excluding the branch moved. A later lookup loses that answer after branches move or disappear. `attributedCommits` merges child commits by `sameCommitSha`. The child's row wins a duplicate, preserving its maker. Turn figures, accessible names, and session totals use that merged list.

Codex child navigation also requires verified direct-parent evidence. `codexhistory.ts` classifies both raw streams and rejects conflicting ownership operations through the commit and evidence commands. Creation must finish before the matched commit starts. Missing or inconsistent intervals refuse navigation. Each source retains at most 256 operation facts and 33 combined relationships, commit identities, and output pairs. The worker retains one parent cursor and at most eight child cursors, evicting the least recently used. Resume requires the last pending token on the same child revision.

The host reserves at most 1 MiB per request and 64 MiB per physical source revision before dispatch. Accepted pending, complete, or exhausted replies replace reservations with actual bytes read. Stale, cancelled, rejected, and lost replies retain full reservations. Shared parent or child revisions reserve sequentially. Aborting releases both revision admissions while retaining its full reservation. Unfunded head and anchor checks end exhausted. Complete replies require both revisions and complete classified coverage. Parent-only changes invalidate navigation independently of spend.

`CommitRepositories` binds saved direct observations to commit occurrence, accepted source stamp, full hash, surviving checkout, and common Git directory. Physical root and common-directory identities, Git identity, and the exact object must validate. Validation expires after thirty seconds. Repeated reads share bounded answers during that interval. Replacement directories and matching clones supply no replacement proof.

Rows retain repository grouping while validation runs and while the source only grows. Their directory stays unavailable until validation passes. A failed check removes grouping until a later successful check, including across revisions. Opening waits for expired or grown proof to pass. Quiet recovery requires a usable directory. Fresh capture requires the original command directory and saved identities to survive. Coverage-qualified pruning removes only sources proved absent. The optional derived cache owns persistence. Deleting it discards these observations.

## Webview rendering constraints

Keep clock fields outside card content fingerprints. The shared clock updates mounted text only when its wording changes, preserving selection. `writeCardClock` owns card-specific clock fields. Session list clocks and their separate cache rules belong to [retained rendering](rail-and-navigation.md#retained-rendering-contracts).

The `activity` message's single-card form updates mounted content. Its list form replaces matching cards and draws the timeline once, retaining focus and selected text. A list draw supersedes held single-card updates. Full timeline draws own structural and layout changes. Repaint deferral must preserve comment editing, comment-list interaction, and active selection through the interaction owner.

Chip popovers mount on `body`. Record popovers accept pointer input before pinning and retain a grace period across the anchor gap. Other popovers accept pointer input after pinning. Tab includes record-row figure stops and disclosures. Arrows visit action controls. Leaving the last stop closes the popover and resumes from its anchor. Closing a focused record returns focus to its figure.

The outer and nested record popovers share styling but keep separate anchors. The outer instance treats the nested instance as internal for pointer, press, and focus departure. Closing the outer closes the nested instance. Escape reaches the nested record first. Both remain outside the document Tab walk used to leave a record. Keep the shared body observer and suspend focus-departure handling while replacing popover rows.

Interpretation-changing lines stay in the visible record footer. Standing explanations stay under About these figures. Hover starts that disclosure closed. Pinning restores its document-wide in-memory state. Notes select the dialog role and a heading or figure name. The figure's description names the breakdown rather than those notes. Redrawing preserves focus on the disclosure summary.

Panel resource addresses belong to their receiving host. Do not reuse another host's addressed card. Parse every host and browser message at the protocol boundary. A new message needs its union variant, parser branch, and handler. Browser code receives narrow ports rather than the object returned by `acquireVsCodeApi`.
