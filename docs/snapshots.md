# Snapshots and diffs

## Diff selection

The snapshot baseline represents the file before the session's first edit. It can cover work from later turns in the same session, so it is suitable for a current-file view but not for turn attribution.

`patchview.ts` builds a per-turn diff only from text the transcript recorded. Whole-file before and after values are preferred. When the source recorded only changed regions, the diff title states that limit. The live file is never used as the after side of a per-turn diff.

A file the snapshot manifest lists opens the current-file diff when the live file still differs from the snapshot. That diff compares the snapshot baseline with the live file. An existing file without that snapshot match opens as a file. A missing live file uses its turn's recorded fallback. The separate per-turn diff action takes both sides from recorded text and needs no Claude hooks. Claude Code records the file before an Edit as `originalFile`, only for small files, and records the file after a Write as `content`. The parser keeps `originalFile` from a file's first recorded edit in each turn and keeps each edit's `content`. `sidesFor` replays the turn's edits over that text when the diff opens. The text stays in memory with the parsed turn. The project spend index and the derived session cache do not store it.

Reader comparisons normalize snapshot and transcript paths. Windows drive paths compare without case on every host. Other paths compare without case on Windows and retain case on macOS and Linux. Hook normalization removes a trailing slash and folds the drive letter. It folds whole paths only on Windows. Hook and reader scratch-root handling share ephemeral-path fixtures. Those fixtures do not establish identical normalization for arbitrary foreign paths.

A file row whose live file is missing opens the recorded change for that path in its turn. The editor title says `recorded turn changes` and identifies hunk-only content. Missing or ambiguous recorded diffs produce an unavailable-file message. Dispatched rows identify a session without a specific turn, so they cannot supply this fallback. Arc never substitutes another checkout's current file.

## Transcript interpretation

A Claude `Bash` result can carry its own record of the files a shell command changed inside a git repository, alongside an edit tool's `structuredPatch`. Both read into the same `Turn.files` row for a file either one names. The record details at most five files with hunks. A wider change still names every changed path. A path without hunks produces a row without line counts, not a claim that nothing changed. A path under a scratch root is dropped from both lists, the same rule an edit tool's file follows. The reader accepts either drive-letter case in recorded Windows paths. Rows compare paths without case or separator differences. A record naming a path without hunks never removes line counts established by another record. That record can belong to the turn or a child. The row keeps those lines and the cause of the missing ones. The record opened by the files figure identifies its line totals as a floor.

## Parsing and attribution constraints

- `manifest.json` cannot attribute a file to a turn. It is overwritten cumulative state.

- Shell redirection, formatters, and code generators can have captured file evidence through Claude `bashEditDiff`. Commands without that evidence supply no complete file attribution. The panel reports potentially unrecorded changes instead of claiming that the turn changed nothing.

- Claude transcript paths and snapshot paths can differ in separator and drive-letter case. Compare normalized paths.

## Snapshot and diff contracts

The report for a turn comes from its transcript or rollout. A current-file diff may use a snapshot when the live file still differs from that snapshot. A per-turn diff never reads its after side from the live file because later work may already have changed it.

`plugins/arc-hooks/scripts/pretooluse-snapshot.cjs` stores the file before the session first edits it. A created file gets an empty baseline. The baseline does not advance between turns.

`plugins/arc-hooks/scripts/stop-manifest.cjs` rewrites `manifest.json` for sessions with snapshot history, then updates `trigger` even when their files no longer differ. Read-only sessions and ignored paths create no store without that history. Session-local index entries, published changes, baseline filenames, and pending transaction names establish history without reading baseline content. Turn attribution always comes from the transcript. Without a snapshot trigger, transcript polling still supplies the panel.

First-touch updates and Stop publication queue per session. Stop holds the index lock through transaction recovery, file comparison, manifest replacement, and trigger renewal. A baseline and its new-file fact publish together when their transaction directory takes its stable hash name. Recovery leaves temporary transaction directories untouched. Missing indexes recover paths and new-file facts only from published transactions. A hashed baseline alone retains original bytes until a later touch supplies its path, without reconstructing its lost new-file fact. Index, manifest, and trigger readers see either the old file or the complete replacement. Windows EPERM failures during replacement receive at most ten attempts, with twenty milliseconds between attempts. Terminal failures preserve the old file.
