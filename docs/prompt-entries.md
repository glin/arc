# Prompt entries and path completion

Read this guide for command and skill completion, inline inspection, or local path completion. [`composer.ts`](../extension/src/webview/composer.ts) owns browser editing. [`commandcatalog.ts`](../extension/src/commandcatalog.ts) owns catalogs. [Local controls](prompt-delivery.md#local-controls) owns commands intercepted before delivery.

## Opening recorded skills

Skill opening uses `openSkill`, separately from card file opening. It accepts only paths published in that card’s recorded skill list and still naming regular files. Failed checks open nothing and report nothing.

## Prompt entries

Initialization publishes commands. Idle Codex children can supply skills. Connected Codex children refresh after local skill-file notifications, including additions, edits, and removals. Codex catalogs distinguish commands from skills.

Claude commands lack ownership metadata. Classify them with the working directory’s latest skill-name list, persisted across reloads. Listed skills are inspectable except panel controls such as `/mcp`. `/compact` and `/model` never receive skill highlighting. Autocomplete offers `/remote-control` and `/rc` in every Claude session because Claude's published catalog omits them. Neither is ever highlighted. Before the first list, all other commands are highlighted, including `/context`, `/help`, and `/review`.

Keep supplied Claude definition paths. Otherwise search project skills before the reader’s Claude skills folder. Without a definition, omit the path.

Ordinary catalogs live in agent-keyed memory. Optional supplied entries belong to one child generation and immutable release. Idle or sibling children supply no optional entry to another session. Retirement or replacement removes only affected child entries. Provisional drafts use their retained child. Reload starts completion empty until a session answers.

Claude and Codex commands use `/`. Codex skills use `$` or `/`. Completion preserves the typed prefix. Dollar text opens completion only when it matches a listed Codex skill.

Only complete leading Codex skill invocations select native skills, allowing preceding whitespace and following arguments. Typed and completed invocations match equally. Unknown, disabled, ambiguous, or removed skills remain text. Quoted examples, escaped tokens, fences, URLs, partial names, and incidental mentions select nothing. [Native attachment and freshness](native-skills.md#codex-skill-attachment) govern delivery.

Skill marks must retain the native text field. Drags and modified clicks select text without opening details. Inspection preserves prompt text, selection, and undo history.

Hovered and pinned popovers hide while their marks are clipped and return when visible. Pinned marks follow logical tokens through edits and close when those tokens disappear. Paths appear only when supplied or resolved. Closing restores focus. Removing a focused mark focuses the text field.

Host and browser share token and matching rules under `domain/`. Keypresses use live text without waiting for host replies.

## Local path completion

Path completion requires a collapsed caret at the token’s end. Tokens accept `~/`, `./`, `../`, `/`, Windows drives, UNC roots, or embedded separators. Matching quotes retain spaces. Preserve roots, quotes, and separator style.

The provider chooses the recorded working directory or the directory frozen in a draft. The browser never supplies it. Completion reads the named parent directory and returns no rows when unreadable.

Matching prompt entries take priority. Otherwise directories precede files and add the typed separator. Hidden entries appear only after a leading period.

Arrow keys move the active row. Tab accepts paths. Enter retains Send. Escape closes path completion until the token changes. Pointer acceptance never moves focus.

Use a listbox with text-field focus and `aria-activedescendant`. Each row names its file or directory kind. Path acceptance writes one undo step, updates the draft, grows the field, and ends recall.

Debounced replies must match session, token, caret, and request identity. Obsolete replies never change the draft.

Command acceptance completes the name. The following Enter sends.

Background refreshes preserve command-menu scrolling. Typing, caret moves, and active-option changes still reveal the active option.
