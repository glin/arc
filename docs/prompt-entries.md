# Prompt entries and path completion

[`webview/composer.ts`](../extension/src/webview/composer.ts) owns completion and inline inspection. [Local controls](prompt-delivery.md#local-controls) owns commands intercepted before delivery.

## Opening recorded skills

[`panelhost.ts`](../extension/src/panelhost.ts)'s `openSkill` accepts only paths published in that card's recorded skill list and still naming regular files. This check is separate from card file opening.

## Prompt entries

Claude commands lack ownership metadata. Classify them with the working directory's latest skill-name list, persisted across reloads. Before the first list, all commands receive skill highlighting except panel controls, `/compact`, `/model`, `/remote-control`, and `/rc`.

[`composerview.ts`](../extension/src/composerview.ts)'s `availableCommands` adds `/remote-control` and `/rc` because Claude's published catalog omits them. [`claudeskillpath.ts`](../extension/src/claudeskillpath.ts) resolves missing definition paths, with project skills before the reader's Claude skills folder.

[`commandcatalog.ts`](../extension/src/commandcatalog.ts) separates agent-wide ordinary catalogs from optional entries bound to one child generation and immutable release. Idle or sibling children supply no optional entry to another session. Provisional drafts use their retained child. Reload starts completion empty until a session answers.

Only complete leading Codex skill invocations select native skills. Unknown, disabled, ambiguous, or removed skills remain text. Quoted examples, escaped tokens, fences, URLs, partial names, and incidental mentions select nothing. [Native attachment and freshness](native-skills.md#codex-skill-attachment) owns delivery.

Skill marks must retain the native text field so inspection preserves selection and undo history. Host and browser share token and matching rules under [`domain/composer-editing.ts`](../extension/src/domain/composer-editing.ts). Keypresses use live text without waiting for host replies.

## Local path completion

[`pathcompletion.ts`](../extension/src/pathcompletion.ts) owns path resolution, matching, and directory reads. [`webview/composer.ts`](../extension/src/webview/composer.ts) owns acceptance and menu keys.

The host chooses the recorded working directory or the directory frozen in a draft. The browser never supplies it. Preserve roots, quotes, and separator style, including Windows drives and UNC roots.

Debounced replies must match session, token, caret, and request identity. Obsolete replies never change the draft. Matching prompt entries take priority. Tab accepts paths, while Enter retains Send.
