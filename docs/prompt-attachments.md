# Prompt attachments

[`promptassets.ts`](../extension/src/promptassets.ts) owns staging and validation. [`webview/attachments.ts`](../extension/src/webview/attachments.ts) captures browser files. [Prompt delivery](prompt-delivery.md) owns queue and reset transitions.

## Storage and acceptance

Attachments use session-scoped staged copies under extension global storage. Descriptors include a SHA-256 digest. Arc never changes or deletes source files. A missing, changed, or non-regular staged copy blocks the whole prompt until removed or replaced.

The shared staging root has no global unreferenced-file sweep. Copies with lost descriptors can remain until extension storage is cleared.

Refusal retains draft descriptors. Acceptance removes them and retains staged bytes until their accepted turn ends. Codex can finish before acceptance returns, so cleanup also checks completion when acceptance finishes. Provisional-to-durable adoption moves attachment state.

Drop deletes staged data only after drafts, queues, and handoffs release every reference.

## Size limits

[`domain/prompt-assets.ts`](../extension/src/domain/prompt-assets.ts) holds the count, size, and PDF limits. The webview checks count and size before it reads a pasted file. The host checks them again before it writes a staged copy, and checks saved descriptors when it loads them.

The panel shows sizes in MB, where 1 MB is 1,048,576 bytes. The limits use the same unit:

- One prompt carries at most 8 files.
- A JPEG, PNG, GIF, or WebP image can be up to 50 MB. Claude Code shrinks an image before it sends, echoes, or saves it. Codex reads each file from its staged path. The limit remains because a paste reads each file whole into the panel's memory.
- Every other file can be up to 7 MB. Claude Code keeps PDFs and text files at full size in the echoed prompt and the transcript.
- The files of one prompt total at most 100 MB. Arc reads and hashes every file of a prompt at send.
- The PDFs of one Claude prompt total at most 16 MB. Claude Code drops PDFs without an error once the PDFs in one prompt total more than about 16 MB.

Arc refuses a Claude prompt whose PDFs pass `MAX_CLAUDE_PDF_TOTAL_BYTES`. The host checks this budget at staging, agent change, send, and queued delivery, and `claudePromptContent` refuses such a prompt before it reads the files. Images do not count toward the budget. Codex prompts have no PDF budget.

A PDF in a later turn can push an earlier PDF out of Claude's context. A check of one prompt cannot see this, and Arc does not prevent it.

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
