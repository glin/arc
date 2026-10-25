# Snapshots and diffs

Read this guide when changing first-touch capture, snapshot publication, or recorded diff selection. [Data sources](data-sources.md#snapshot-storage) owns storage paths and retention. [Development](development.md#snapshot-installation) owns hook installation. [Session list and navigation](rail-and-navigation.md#files-commits-and-editor-groups) owns editor placement and ordinary file links.

## Diff selection

Turn attribution comes from the transcript or rollout. A snapshot holds the file before the session's first edit and never advances between turns. It therefore covers later turns' changes too. `manifest.json` is overwritten cumulative state and cannot attribute a file to a turn.

`pendingIn` matches normalized paths and checks that the live file still differs from its snapshot. A matching file row opens the snapshot against the live file. An existing file without that match opens as a file. The turn-diff action builds recorded diffs separately. Missing live files use that turn's recorded changes when one unambiguous diff exists. The title says `recorded turn changes` and identifies hunk-only content. Missing or ambiguous recorded text produces an unavailable-file message. Dispatched rows identify a session without a turn, so they cannot supply this fallback. Arc never substitutes another checkout's live file.

`patchview.ts` builds both per-turn sides from recorded text. It prefers whole files and otherwise shows changed regions. Titles identify hunk-only limits. It never reads the live file as a per-turn after side. Claude Edit results supply `originalFile` for small files. Write results supply `content`. The parser keeps the first recorded edit's `originalFile` per file per turn and every edit's `content`. `sidesFor` replays ordered edits when the diff opens. Recorded whole-file text stays with parsed turns in memory. Neither spend nor derived-session caches store it.

Normalize snapshot and transcript paths before matching. Windows drive paths compare without case or separator differences on every host. Other paths compare without case differences on Windows and retain case on macOS and Linux. Hook and reader scratch-root handling share `ephemeral-paths` fixtures. The hook normalizer removes a trailing slash and folds whole paths on Windows. Do not assume identical normalization implementations on every host.

Claude `bashEditDiff` and edit-tool patches reduce into the same normalized file map. Shell results detail at most five files with hunks and can name additional paths without hunks. Scratch paths leave both lists. Paths without detail establish changed files without line totals. They never erase counts supplied by another parent or child record. File records retain counted lines and explain unknown or partial totals as a floor. Commands without captured file evidence do not establish that nothing changed.

## Snapshot and diff contracts

`pretooluse-snapshot.cjs` records the first-touch baseline through `recordBaseline`. A created file receives an empty baseline. `stop-manifest.cjs` rewrites the manifest for sessions with snapshot history and renews `trigger`, including when their files no longer differ. Read-only sessions and ignored paths create no store without existing history. Index entries, published changes, baseline filenames, and pending transaction names establish history without reading baseline content. Transcript polling supplies the panel without a snapshot trigger.

First-touch index updates and Stop publication queue per session. Stop holds the index lock across transaction recovery, comparison, manifest replacement, and trigger renewal. Baseline bytes and the new-file fact publish together when the transaction directory receives its stable hash name. Recovery leaves temporary transaction directories untouched. Missing indexes recover paths and new-file facts only from published transactions. An orphan hashed baseline retains its original bytes until another touch supplies its path. That path recovery cannot reconstruct a lost new-file fact.

Atomic replacement gives index, manifest, and trigger readers either the old file or a complete replacement. Windows `EPERM` replacement failures receive at most ten attempts, twenty milliseconds apart. Other failures receive no replacement retry. Terminal failure preserves the old target. Hook failures never block the edit tool or agent completion.
