# Prompt attachments

Read this guide for paste, drop, attachment validation, or staged-file lifetime. [`promptassets.ts`](../extension/src/promptassets.ts) owns staged copies. [`attachments.ts`](../extension/src/webview/attachments.ts) captures browser files. [Prompt delivery](prompt-delivery.md) owns queue and reset transitions.

## Storage and acceptance

Attachments use session-scoped staged copies under extension global storage. Saved descriptors include a SHA-256 digest. Arc never changes or deletes the source file. A missing, changed, or non-regular staged copy remains visible by filename and blocks the whole prompt until removed or replaced.

The shared staging root has no global unreferenced-file sweep. Copies with lost descriptors can remain until extension storage is cleared.

Attachment-only prompts are sendable. Sending snapshots the current files. Refusal retains descriptors in the draft. Acceptance removes them and retains staged bytes until their accepted turn ends. If Codex completes before acceptance returns, cleanup runs as acceptance finishes. Provisional-to-durable adoption moves attachment state.

## Paste, drop, and Add to Arc

Paste and drop attach files without an Attach files control. Capture browser files during the event before reading them with `File.arrayBuffer()`. Known filename extensions determine media type. Ordinary text paste remains unchanged.

VS Code delivers webview drops only while Shift is held and can consume drags first. Drop is therefore an additional attachment route.

Explorer and editor-tab drags insert paths at the caret. Read all drag values before waiting because event data disappears afterward. File-URI drags take priority even when Files is also present. OS file-manager drags containing only Files stage bytes. Web links without file URIs retain normal text-drop behavior. Only `file:` URIs count. The inline notice counts skipped items.

Paths are relative inside the session working directory and absolute outside it. Whitespace requires double quotes. Folders end with a separator. Multiple paths join with spaces and no `@` prefix. JPEG, PNG, GIF, and WebP files become attachments instead. The host checks count and size limits before reading any image.

Add to Arc uses these rules from Explorer and editor-tab menus. It uses the whole Explorer selection when the clicked item belongs to it. It targets the visible prompt box and reveals the panel. It has no keybinding or command-palette entry.

An unknown extension uses normalized browser MIME or `application/octet-stream`. Only `application/octet-stream` falls back to plain text when bytes are valid UTF-8 without NUL.

## Staging races and refusals

Send and Enter wait during staging, except for Codex `/rename` and Claude `/remote-control` or `/rc`. Those controls carry no attachment. A second paste or drop receives an inline refusal. Attachment notices clear on the next edit, attach, or removal.

Draft files offer keyboard-reachable Remove buttons. Pending and failed cards retain file chips without Remove. Recorded cards remain text-only because transcript readers retain no vendor attachment records.

An incompatible attachment blocks a draft’s agent change without removing the file. Send and session-opening continuations recheck compatibility and staged contents.

Only one attachment-bearing prompt per session can await acceptance. Overlapping sends restore text only if no newer edit replaced it. Staging retains an otherwise untouched draft in the session list. Completed reads follow provisional adoption and recheck the selected agent before merging descriptors. Stop cancels Claude attachment preparation before the user message reaches the wire.
