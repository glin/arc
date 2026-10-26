# Saved-session HTML

Export a saved Claude or Codex session from its heading in the session view. Live and archived sessions qualify. Unsent new sessions have no export action. An unavailable or ambiguous saved source prevents export.

1. Open **Session actions** beside the session heading, or right-click the heading.
2. Choose **Export session as HTML...**.
3. Read the privacy warning, then choose **Export** to continue.
4. Choose a destination folder in **Choose an export folder**, then select **Export here**.
5. Wait for completion, then choose **Open** in the notification to open the saved page in your browser.

Dismiss the warning or folder picker to stop before capture. Use **Cancel** in the progress notification to stop capture. Cancellation publishes no partial export.

Arc creates an `arc-session-<random ID>/site` directory inside the chosen folder. Open its `index.html` directly to view the page later.

[`sessionexport.ts`](../extension/src/sessionexport.ts) owns confirmation, destination selection, progress, and cancellation. Selecting another session leaves export targeted at the session whose heading opened the menu.

The page embeds scripts and captured data but loads an adjacent stylesheet. Publish the whole `site` directory. Local files, HTTP roots, and nested HTTP directories use the same relative assets.

Relative ages use capture time and do not prove continued process activity. Missing or ambiguous linked evidence leaves relationship coverage partial.

The export starts no agent. [`webview/export-model.ts`](../extension/src/webview/export-model.ts)'s `EXPORT_HOST_POLICY` admits only local read-only actions. Markdown links and images remain inert. Recorded text can still contain private paths, addresses, or secrets. Review the complete directory before sharing it.

Capture excludes raw tool arguments and results, hidden reasoning, patches, attachments, comments, drafts, queues, resume data, and absolute metadata paths. It reads only verified reachable sessions from configured provider roots and saved reader-started links. A reader-started relationship adds navigation without adding delegated cost.

[`domain/export-limits.ts`](../extension/src/domain/export-limits.ts) owns admission limits. A capture admits at most 128 sessions, 20,000 turns, 4,096 relationships, and 1 GiB of source records. Per-source, record, and turn limits are 256 MiB, 8 MiB, and 16 MiB. Overflow stops publication without shortening recorded text. The stylesheet admits at most 2 MiB.

[`exportsite.ts`](../extension/src/exportsite.ts) streams encoded card blocks into HTML. [`webview/export-host.ts`](../extension/src/webview/export-host.ts) decodes only the selected page range. Initial selection and each Older turns request admit at most 20 cards. Loaded cards remain within a 32 MiB decoded-data target. A single admitted card exceeding that target occupies a page alone and retains its complete text.

Selecting another session releases preceding cards. Older turns replaces them when combined data exceeds the target. Browser history restores the selected session and bounded page position. Keyboard navigation follows the [web demo platform shortcuts](demo-assets.md#static-web-demo).

Encoded HTML nodes remain in the document, so total file size and browser memory still grow with capture size. The raw turn limit does not bound Markdown expansion, DOM storage, or browser heap use.

## Capture and projection contracts

[`exportdata.ts`](../extension/src/exportdata.ts) captures semantic pages at one graph revision. The host snapshots archive and retained launch membership before native export choices. Capture keeps provider and parent identities mapped to artifact keys through retries. Participating name sources remain frozen until publication.

Provider classifiers consume the numeric read to classify agent runs and reader participation. Retained launch ownership and provider evidence pass through reader overrides. A dispatch relationship alone supplies no run evidence. Both static render phases retain archive membership, including the selected root.

Relationship capture hashes the bytes supplied to parsing and retains admitted fragments in capture-owned cursors. Source digests, opening identities, child metadata, and directory listings establish the final publication revision. Incomplete Codex terminal framing stops publication. A changed graph restarts capture and projection once. Filesystem checks establish observed agreement, not an atomic snapshot.

[`exportsite.ts`](../extension/src/exportsite.ts) projects spooled pages through production card and compaction builders using an explicit allowlist. Shared cost builders retain captured amounts and qualifications even when category prices are unavailable. Captured usage and relationship coverage qualify affected delegated scopes. Unattributed missing usage qualifies every retained scope it can affect.

A dispatched contribution belongs to its first chronological launch across spooled pages. Opaque normalized file identities distinguish files during cross-session aggregation and child record selection. Display paths retain project-relative spelling. Omitted file identities qualify child artifacts separately from missing line counts.

Cost parts retain linked-command invocation scope regardless of request-count uncertainty. Optional `compactionUsage` distinguishes recorded compaction usage from `estimated` usage. Absence preserves ordinary usage classification.

[`exportwriter.ts`](../extension/src/exportwriter.ts) stages assets beside the destination and removes private page spools from system temporary storage before publication. Publication renames staging into an exclusive reservation's `site` directory because some platforms replace empty directories during rename. Cleanup checks owned filesystem identities without following directory links. Temporary filesystem locks receive bounded retries.

Export policies bound semantic history adapters and relationship scanners separately from panel reads. Raw turn and page budgets include omitted tool records. Codex capture policies never enter the panel's saved relationship cache. Panel cursors and the Codex opening reader retain independent limits.

[`exportdata.test.ts`](../extension/src/exportdata.test.ts), [`exportsite.test.ts`](../extension/src/exportsite.test.ts), and [`exportwriter.test.ts`](../extension/src/exportwriter.test.ts) cover capture, projection, and publication. [`exportsite.browser.test.ts`](../extension/src/exportsite.browser.test.ts) covers static navigation and decoding.
