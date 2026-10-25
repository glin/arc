# Discovering sessions

[Session history](session-history.md) owns selected reads, metadata recovery, and cache migration. [Accepted catalog reads](window-channel.md#accepted-catalog-reads) owns channel qualification and delivery authority.

## Session discovery

`allSessions` combines Claude transcripts and Codex rollouts in activity order. Listing establishes membership separately from parsing selected turns. Persisted bounded metadata and turn starts supply unread, status, and context facts independently of selection. Completed primary spend sources recover the newest start and outcome when bounded reads miss them. The incremental spend index supplies session lifetime cost. Pins change placement alone.

Claude admission requires an eligible typed human prompt. A command answered locally by the CLI supplies no evidence, even when model work follows. Model work after manual compaction makes `/compact` eligible again. A command without a recorded CLI answer remains eligible. Refresh rechecks pending command evidence and preserves reader state when admission changes.

Admission shares read and filesystem-check allowances across Claude sources and yields between batches. It completes before catalog publication. Cancellation retains complete lines and unfinished UTF-8 bytes. Compatible appends preserve progress and confirmed human evidence. Unscanned appended bytes remain unknown without that evidence. Replacement, shrinkage, or changed same-size revisions restart admission. Unavailable evidence remains unknown.

Agent runs remain discoverable but fold away unless pinned or selected. Classification must preserve visibility for sessions that edit workspace files or whose opening turn remains active. Unknown classification matches neither polarity of an agent-run predicate. Malformed small transcripts remain unknown. Complete records before an unfinished final fragment still supply classification evidence.

## Repository scope

Repository scope includes recorded working directories inside open folders or registered worktrees of those folders' repositories. Claude directory slugs and Codex date directories supply hints, not membership. Without a readable Claude working directory, only an exact open-folder fallback applies. Added worktree roots receive no fallback.

`RepositoryScope` reads `git worktree list --porcelain -z` in the background. The first listing waits for its answer before changing reader state. Failed initial reads settle on the open folders. Later failures retain each folder's last successful roots.

Scope reads ask Git again after 15 seconds. Additions apply immediately. A removal waits for another answer after 5 seconds. Each root leaves only when both answers omit it. A failed answer neither confirms nor discards that folder's held removals. Failed confirmation reads retry after 5 seconds at most three times, then use the 15-second interval.

Open folders always remain. Published roots omit registered worktrees inside another root, while removal confirmation uses unfiltered per-folder answers. A hidden nested root becomes published when its containing root leaves. Opening a subfolder retains its enclosing repository root. Nested-only changes move no scope revision and cancel no selection.

Registered checkout identities retain nested worktrees independently of discovery roots. Identity changes alone refresh heading metadata without moving discovery revision or cancelling selection. Each panel compares its selected session's opening folder with its first workspace folder through the most specific registered checkout. Unknown identities omit the starting worktree.

Containment requires a path boundary. Windows drive paths compare without case on every host. Other paths ignore case on Windows and retain case on macOS and Linux. Removed worktree registration and a removed worktree leave an old working directory without repository evidence.

Continuing a session, compacting it, and handing off responses or selected text use its recorded working directory. The ordinary New launcher uses the editor's open folder. Queued submissions and pending rows wait outside scope and resume when scope returns. Workspace changes revoke scope even with every panel closed.

## Relationship discovery contracts

Keep physical presence, admitted membership, scope, and accepted revision separate. `sessionPresence` answers present, absent, or unknown only within the matching domain, scope, and revision. Physical coverage reaches visited directories within the provider's supported depth. Unvisited directories, failed candidates, and unread admission remain unknown. A missing provider root establishes empty enumeration. Published rows supply no absence proof.

Same-ID collisions revoke recorded-source delivery before publication. Competing sources remain quarantined through incomplete walks until qualified openings or relevant pathname absence resolve them. Descriptor and pathname revisions must agree. Hidden Codex openings reserve competition independently of displayed membership, including changed IDs that collide with visible sources. Cached metadata alone cannot establish replacement or scope exclusion.

Incomplete enumeration retains omitted accepted sources and blocks their source-bound delivery through prompt recovery. Proven absence removes derived history, navigation, caches, and exit evidence. Drafts, queued submissions, aliases, comments, and pending recovery remain recoverable. Deferred compaction waits on unknown membership and cancels on proven absence. Hosted Stop and question answers retain their process callbacks.

Claude discovery scans parent transcripts in the cancellable worker. Reuse requires matching normalized path, parser generation, physical identity, size, modification time, catalog membership, and child working directory. Appends resume a captured byte target with record fragments and unmatched launches. Replacement, shrinkage, or changed evidence rebuilds the source. Each child receives its own stat and scope check. Verified parent-child paths remain usable for spend even when navigation excludes the child.

Native child census also reserves unreferenced Claude descendants. Codex child replays retain parent identity and original turn clocks despite new envelope times. Readers exclude inherited cards, turns, and requests. Actual child requests remain attributable to the parent. [Card sources](timeline.md#card-sources) owns opening and interactive-resume classification.

### Dispatch evidence

A fresh `codex exec --json` launch requires exactly one top-level `thread.started` event in its paired stdout. Resumes, nested or quoted events, ambiguous starts, mixed opted-in launches, and stderr-only evidence establish no link. Direct Claude launches require their paired background line or foreground JSON result. Claude `--resume`, `-r`, `--continue`, and `-c` reject the entire Bash call unless `--fork-session` establishes a new session.

Wrappers opt in with standalone `--arc-dispatch` and return exact `ARC_DISPATCH_SESSION` JSON lines. Chained opted-in launches link their named sessions. Mixing a wrapper with direct Claude launch rejects every link. `owned` is absent or `true`. Only `true` establishes reader ownership. Direct launches remain unowned.

Malformed receipts, lines over 4096 characters, excess launch receipts, or more than 16 receipts reject the entire result. Claude IDs sharing eight leading characters conflict. Repeated full Codex IDs conflict. Providers retain separate identities. A Claude prefix resolves only against one existing scoped catalog session. Output from another command supplies no evidence.

The shared lexer excludes prompt bodies, heredocs, here-strings, comments, quoted expressions, and opaque grouped arguments from launch flags. Codex command grammar requires a matching recorded shell invocation. Unknown grammar admits only launches whose kind and position agree under Bash and PowerShell. Extglob-dependent Bash syntax supplies no receipt ownership. `claudeLaunchKind`, `commandWords`, and `maskQuoted` in `transcript.ts` own the grammar rules.

`DispatchReceipts.relationships` reads durable standalone evidence without granting billing or delivery authority. It requires committed receipt and binding witnesses plus durable provider startup evidence. Each iterator starts a fresh evidence epoch. Grants bound the next entries, bytes, and checks while retaining partial buffers, digests, and directory position. Cancellation closes descriptors. Unexpected filesystem failures return refusal status with charges.

Transcript and receipt claims reach shared conflict admission together. Worker receipt state survives refresh generations within its discovery epoch. Refusal holds new dispatch publication when qualified receipts or resolved transcript dispatches exist. The next ordinary request starts a fresh receipt scan. Initially unopened storage without qualified receipts preserves transcript fallback. No qualified receipts or resolved dispatches preserves native discovery.

Session-cost reads first discover the selected native tree. Source-only reads skip catalogs and receipts. A qualified touching receipt requires complete catalogs, receipt competition, and captured competing bodies before descendant admission. An unresolved requester first requires native-child enumeration and repeated qualification. Empty Claude bodies require an explicit zero-size check. Bounded null openings establish no admitted identity. `ENOENT` and `ENOTDIR` establish absence only at permitted boundaries. Other filesystem failures refuse affected admission.

A dispatch-bearing tree also refuses unknown receipt competition without a qualified touch. Catalog refusal then requires an unresolved requester. Native descendants and linked print usage alone do not make a tree dispatch-bearing. Missing or non-directory storage preserves native fallback. Later failures cannot erase an earlier applicable receipt. Unrelated endpoints require no unrelated body scans. Native children take precedence. Canonical deduplication combines tool IDs and rejects competing paths.

### Progress and limits

Each parent retains its first 4096 references. The derived cache retains a deterministic subset of at most 10,000 parent files. Appends preserve existing links. Launch call IDs survive the Activity step bound. Relationship generation changes invalidate both providers, including unchanged positive and negative entries. Metadata and Codex opening generations remain independent.

Discovery freezes source targets within an epoch. Charged quanta acknowledge source progress and completion changes. Restart admission rechecks saved completions. Finished sources keep their captured cuts until the next epoch. Unfinished Claude sources withhold complete catalog replies. Codex sources permit complete replies with their own coverage false and continuation requested. Cursor retention uses a soft 64 MiB allowance. It preserves one protected Claude source, oversized fragments, unmatched launches, and finished evidence headers. Partial replies alone release no worker memory. Skipped oversized Codex records keep coverage incomplete through later appends and EOF.

Both scanners retain SHA-256 chain evidence over 4 KiB blocks and one tail. Changed stamps require comparison of the entire consumed prefix before append parsing resumes. Stamps include exact modification and change times, physical identity, and size. Readers check descriptor and pathname stamps at opening, after reads, and before acceptance. Unknown validity clears completeness while accepted display facts retain their revision. Compatible pending Codex entries retain updated dispatch references and figures with incomplete coverage. Dispatch references establish no recursive ownership edge. Mismatch advances source generation and ends the attempt without immediate retry.

Claude quanta receive at most 1 MiB. Codex receives remaining request bytes. Both use a 16 KiB reserve, 256 KiB read ceiling, and 15 ms cooperative slice. Each slice makes its first advancing read even past deadline. Every returned byte counts, including validation, replay, and abandoned reads. Serialized evidence receives at most 16 KiB per source within cursor accounting. Requests permit eight charged quanta within 8 MiB and at most ten replies. Discovery admits one active request and one latest waiter. Selected reads remain independent.

Changed revisions require O(consumed prefix) validation. Total work has no aggregate bound. Continuous writes can prevent qualification. Stamps and digests establish observed agreement, not an atomic snapshot. Metadata-preserving rewrites remain undetectable in some cases. Synchronous reads, oversized-record parsing, copying, and serialization have no hard latency bound.
