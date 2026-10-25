# Snapshots and diffs

[Data sources](data-sources.md#snapshot-storage) owns storage paths and retention. [Development](installation.md#snapshot-installation) owns hook installation. [Session list and navigation](panel-navigation.md#files-commits-and-editor-groups) owns editor placement and ordinary file links.

## Diff selection

Turn attribution comes from the transcript or rollout. A snapshot holds the file before the session's first edit and never advances between turns. Diffs against it therefore include later turns' changes too. `manifest.json` is overwritten cumulative state and cannot attribute a file to a turn.

[`pendingIn`, `openFile`, and `openTurnDiff`](../extension/src/panelhost.ts) own snapshot selection and recorded-diff fallback. Missing live files require one unambiguous recorded diff. Dispatched rows name a session without a turn, so they cannot supply that fallback. Arc never substitutes another checkout's live file.

[`sidesFor`](../extension/src/patchview.ts) builds per-turn sides from recorded text, never live content. Whole-file reconstruction and hunk-only fallback belong there. The parser retains the first edit's `originalFile` and every edit's `content` per file per turn. Recorded whole-file text stays with parsed turns in memory. Neither spend nor derived-session caches store it.

Normalize snapshot and transcript paths before matching. Windows drive paths compare without case or separator differences on every host. Other paths compare without case differences on Windows and retain case on macOS and Linux. Hook and reader scratch-root handling share `ephemeral-paths` fixtures. The hook normalizer removes a trailing slash and folds whole paths on Windows. Do not assume identical normalization implementations on every host.

Claude `bashEditDiff` and edit-tool patches reduce into the same normalized file map. Shell results detail at most five files with hunks and can name additional paths without hunks. Scratch paths leave both lists. Paths without detail establish changed files without line totals. They never erase counts supplied by another parent or child record. File records retain counted lines and explain unknown or partial totals as a floor. Commands without captured file evidence do not establish that nothing changed.

## Snapshot and diff contracts

[`pretooluse-snapshot.cjs`](../plugins/arc-hooks/scripts/pretooluse-snapshot.cjs) calls `recordBaseline` in [`lib.js`](../plugins/arc-hooks/scripts/lib.js). Created files receive empty baselines. Stop publishes for sessions with snapshot history, even when files no longer differ. Read-only sessions and ignored paths create no store without existing history. History detection must not read baseline content. Transcript polling supplies the panel without a snapshot trigger.

First-touch index updates and Stop publication queue per session. Stop holds the index lock across transaction recovery, comparison, manifest replacement, and trigger renewal. Baseline bytes and the new-file fact publish together when the transaction directory receives its stable hash name. Recovery leaves temporary transaction directories untouched. Missing indexes recover paths and new-file facts only from published transactions. An orphan hashed baseline retains its original bytes until another touch supplies its path. That path recovery cannot reconstruct a lost new-file fact.

Atomic replacement gives index, manifest, and trigger readers either the old file or a complete replacement. Windows `EPERM` replacement failures receive at most ten attempts, twenty milliseconds apart. Other failures receive no replacement retry. Terminal failure preserves the old target. Hook failures never block the edit tool or agent completion.
