# Prompt attachments

[`promptassets.ts`](../extension/src/promptassets.ts) owns staging and validation. [`webview/attachments.ts`](../extension/src/webview/attachments.ts) captures browser files. [Prompt delivery](prompt-delivery.md) owns queue and reset transitions.

## Storage and acceptance

Attachments use session-scoped staged copies under extension global storage. Descriptors include a SHA-256 digest. Arc never changes or deletes source files. A missing, changed, or non-regular staged copy blocks the whole prompt until removed or replaced.

The shared staging root has no global unreferenced-file sweep. Copies with lost descriptors can remain until extension storage is cleared.

Refusal retains draft descriptors. Acceptance removes them and retains staged bytes until their accepted turn ends. Codex can finish before acceptance returns, so cleanup also checks completion when acceptance finishes. Provisional-to-durable adoption moves attachment state.

Drop deletes staged data only after drafts, queues, and handoffs release every reference.

## Paste, drop, and Add to Arc

Capture browser files and drag values during the event, before awaiting reads. Event data disappears afterward.

VS Code delivers webview drops only while Shift is held and can consume drags first. Drop is therefore an additional attachment route.

File-URI drags take priority even when Files is also present. OS file-manager drags containing only Files stage bytes. Web links without file URIs retain normal text-drop behavior.

[`droppeduris.ts`](../extension/src/droppeduris.ts) owns path insertion, quoting, image selection, and Add to Arc selection rules. [`panelhost.ts`](../extension/src/panelhost.ts)'s `stageImagePaths` checks count and size limits before reading image bytes.

Known filename extensions determine media type. Unknown extensions use normalized browser MIME or `application/octet-stream`. Only `application/octet-stream` falls back to plain text when bytes are valid UTF-8 without NUL.

## Staging races and refusals

Send waits during staging, except for Codex `/rename` and Claude `/remote-control` or `/rc`. Those controls carry no attachment. A second paste or drop receives an inline refusal.

An incompatible attachment blocks a draft's agent change without removing the file. Send and session-opening continuations recheck compatibility and staged contents.

Live cards build attachment chips from submission assets. Recorded cards show no attachment chips, because the transcript readers keep no vendor attachment records. Chips disappear when a recorded card replaces its live card.

Only one attachment-bearing prompt per session can await acceptance. Overlapping sends restore text only if no newer edit replaced it. Completed reads follow provisional adoption and recheck the selected agent before merging descriptors. Stop cancels Claude attachment preparation before the user message reaches the wire.
