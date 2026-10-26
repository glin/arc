# Turn cards

[Session list](rail-and-navigation.md) owns session headings and list behavior. [Panel rendering](panel-rendering.md) owns browser updates. [Panel navigation](panel-navigation.md) owns response links and navigation. [UI design](ui-design.md) owns shared visual patterns. [Comments](comments.md) owns selection offsets and comment recovery. [Prompt delivery](prompt-delivery.md) and [attachments](prompt-attachments.md) own submission state.

## Card sources

`turncard.ts` prepares the browser-facing card. `webview/card.ts` draws it without repeating decisions about wording, status, marks, cost, context, or file meaning. Keep presentation decisions in the host projection when adding a field.

`chipsOf` in [`turncard.ts`](../extension/src/turncard.ts) builds figures. The host resolves dispatched children through its catalog and appends their figure.

Card layouts and chip popovers share `DetailRowList` in [`webview/card-rows.ts`](../extension/src/webview/card-rows.ts). The host names the record collection. Popovers receive a row-rendering callback instead of importing row components.

`PromptLead`, `PromptSection`, and `PromptBlock` in [`webview/card.ts`](../extension/src/webview/card.ts) own prompt disclosures. Preserve their comment anchors when changing placement.

[Card sources](timeline.md#card-sources) owns live activity reconciliation. [Snapshots and diffs](snapshots.md#diff-selection) owns file evidence. Do not infer missing state from a figure's absence or an incomplete child record.

## Activity

`Activity` in [`webview/card.ts`](../extension/src/webview/card.ts) owns filters, disclosure choices, and focus retention across completion and repainting.

`logOf` in [`turncard.ts`](../extension/src/turncard.ts) projects chronology and bounded tool runs. Trimming calls must preserve message positions, original totals, tool mix, and failures.

Never put a native title on an Activity Markdown row, because that title replaces link-address hovers.

`snapCut` measures the last complete line box, table row, or image inside the message's height limit. The limit comes from its font size. Using the resized box as the limit creates a ResizeObserver feedback loop. Clipping updates interactive descendants' tab stops and measures again after expansion. CSS line clamping does not clip blocks containing `pre` correctly.

Marks summarize existing turn fields or the closing summary. They supply navigation, not another state source. Failed calls establish neither recovery nor a failed group outcome.

## Markdown disclosures

[`richtext.ts`](../extension/src/richtext.ts) owns disclosure grammar. It accepts balanced bare `<details>` with one nonempty `<summary>` first, to 32 levels. Attributes and other raw HTML stay escaped.

Pass Markdown to the renderer without pre-escaping it. Preserve recorded line breaks. Code, escaped tags, comments, and malformed disclosures must remain literal without truncation.

`richtext.ts` scans structure before Marked lexing, which otherwise consumes tight bodies as HTML. Marked supplies list and blockquote boundaries. Leading tabs expand before container recognition. Position maps return stripped lines and expanded tabs to original positions before literal masking. Fragments share reference definitions before inline lexing. Each render keeps its own configuration.

`Summary` in [`webview/card.ts`](../extension/src/webview/card.ts) retains disclosure state through [`webview/summary.ts`](../extension/src/webview/summary.ts). Create descendant controls before restoring focus. Preserve comment offsets and original source when selecting or copying disclosures.

## Card and disclosure contracts

`DetailRowList` uses explicit child file and commit collections first. Ordinary native rows without them use parent rows. Dispatched rows without them use empty collections. Explicit empty collections stay authoritative. A child figure's files record offers no whole-turn diff, because it contains only that child's share.

`attributedFiles` combines parent and child files by recorded identity or normalized path and sums recorded counts. A single child receives attribution only when no other child or parent changed that path. Browser membership uses recorded identity when available, otherwise the card's path spelling. Child commit membership accepts abbreviated and full hashes by prefix. Its commit record excludes landings.

File totals retain counted lines alongside unknown-count evidence. The footer explains each cause and whether counts are unknown or partial. Keep visible and spoken figures consistent. [`diffHalves`](../extension/src/view/stat-detail.ts) and [`webview/stat-chip.ts`](../extension/src/webview/stat-chip.ts) own zero-half rendering.

`FilesRows` in [`webview/card-rows.ts`](../extension/src/webview/card-rows.ts) owns file batching and expansion. Keep capped card sections and uncapped popovers on the same row component. The expansion button stays mounted to retain focus.

`groupCommitRows` groups commits by branch within repository. The wire array remains flat. Host headings carry branch facts. The browser supplies times through `writeCardClock`.

## Subagent and dispatched rows

A current Codex collaboration spawn supplies its recorded thread id and nickname. A machine-marked terminal notification takes precedence. Without one, a direct child rollout's terminal boundary can settle an open parent row as completed, failed, or interrupted. Terminal child usage attaches once. Project and lifetime spend discover child rollouts structurally.

[Card sources](timeline.md#card-sources) owns structural review attachment and parent-row precedence. The newest child outcome supplies state, and its transcript supplies model and usage. Descendants never flatten onto the root turn.

`agentFigures` and `agentDisplay` in [`turncard.ts`](../extension/src/turncard.ts) own child figure allocation and wording. An unfinished child without live evidence reports no recorded ending rather than claiming continued work.

Claude foreground tool counts come from Agent results. Background counts come from completion notices' `<tool_uses>`. Finished children without either count total their own calls. Codex children total their own calls. A Claude CLI row under a Codex parent supplies no tool count through that attachment path.

`AgentRow` in [`webview/card-rows.ts`](../extension/src/webview/card-rows.ts) owns child navigation and figure keyboard controls.

A Claude turn card lists every subagent that has a request in that turn and prices it by those requests alone. A subagent can run again in a later turn, for example after a `SendMessage` resume. It then shows on its launching card and on each later card that holds its requests. A later card's row carries no duration, tool count, commits, or files. The launching row keeps those figures. A launching row whose turn holds none of the subagent's requests reads as no billed usage. [Delegated attribution](accounting.md#delegated-attribution) owns the rule that places each request in a turn and the cases it leaves on the launching card.

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

Commit opening rechecks the repository through `commitTarget` and `openCommit` in [`panelhost.ts`](../extension/src/panelhost.ts). Saved proofs restrict opening to their proven root. Otherwise [`RepositoryCommits.navigable`](../extension/src/gitcommits.ts) uses the recorded directory or its nearest existing ancestor, within 64 levels. A removed directory requires exactly one matching commit object in that ancestor's repository. The card retains its recorded directory.

`git.viewCommit` can select another open repository when its target is unregistered and consumes the lookup error. `git.openRepository` completion does not prove registration. The host must confirm the exact root through `vscode.git` before opening. A containing repository does not qualify. `sameRepositoryRoot` resolves symbolic links and junctions, falling back to literal paths when resolution fails. Windows and drive paths compare without case. Other paths retain case on macOS and Linux.

## Webview rendering constraints

Keep clock fields outside card content fingerprints. The shared clock updates mounted text only when its wording changes, preserving selection. `writeCardClock` owns card-specific clock fields. Session list clocks and their separate cache rules belong to [retained rendering](panel-rendering.md#retained-rendering-contracts).

The `activity` message's single-card form updates mounted content. Its list form replaces matching cards and draws the timeline once, retaining focus and selected text. A list draw supersedes held single-card updates. Full timeline draws own structural and layout changes. Repaint deferral must preserve comment editing, comment-list interaction, and active selection through the interaction owner.

[`webview/stat-detail.ts`](../extension/src/webview/stat-detail.ts) owns popover pinning, dismissal, and keyboard routes. Popovers mount on `body`, outside the document Tab walk used to leave a record.

Outer and nested record popovers keep separate anchors. The outer instance treats the nested instance as internal for departure checks. Suspend focus-departure handling while replacing rows, because removing focused rows does not represent reader navigation.

Interpretation-changing lines stay in the visible footer. Standing explanations stay under About these figures. Notes select the dialog role. The figure's description names the breakdown rather than those notes.

Panel resource addresses belong to their receiving host. Do not reuse another host's addressed card. Parse every host and browser message at the protocol boundary. A new message needs its union variant, parser branch, and handler. Browser code receives narrow ports rather than the object returned by `acquireVsCodeApi`.
