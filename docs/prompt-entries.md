# Prompt entries and path completion

## Skill and file opening

Opening a skill file is its own host route, not the card's file route. `openFile` uses the card's session for its own file rows and the dispatched child's session for that child's file rows. A dispatched file action names the child and a path listed under its row before the host reads its snapshot. `openSkill` accepts a path only when the card's recorded skill list holds it, then confirms that the path is still a regular file. A path that fails either check opens nothing and reports nothing.

## Prompt entries

Command catalogs arrive during agent initialization. Quiet Codex state can also request its skill list through an idle child. A connected Codex child refreshes its catalog after a local skill-file change notification. Added, edited, and removed skills reach the Prompt box without a reload. Codex identifies commands and skills in its catalog.

Claude publishes one command list without ownership metadata. Arc classifies ordinary Claude skills through the last skill-name list for the session's working directory. The panel highlights and makes inspectable listed skills other than panel controls such as `/mcp`. `/compact` and `/model` never receive skill highlighting because the Prompt box has controls for them. Before a directory reports its first list, every other Claude command receives highlighting, including built-ins such as `/context`, `/help`, and `/review`. The Claude skill-name list persists by working directory across window reloads.

A Claude entry retains a supplied definition path. Otherwise, Arc looks for its `SKILL.md` in the session's project skills folder, then the reader's Claude skills folder. If neither folder has the definition, the popover shows no path.

Ordinary command catalogs live in memory by agent and remain available during optional admission changes. Optional supplied entries belong to the supplying child generation and immutable release. Idle catalogs and sibling children supply no optional entry to a session. Replacement and retirement remove only the affected child entries. A provisional draft uses its own retained child. A window reload starts autocomplete empty until a session answers again.

Claude commands use `/`. Codex commands use `/`. Codex skills use `$` and also accept `/`. The completion menu preserves the prefix the reader typed. Dollar text opens a menu only when it matches a listed Codex skill.

A complete leading Codex skill invocation selects that skill, with optional whitespace before it and optional arguments after it. Typed and completed invocations behave alike. Unknown, disabled, ambiguous, or removed skills remain ordinary text. Quoted examples, escaped tokens, fenced code, URLs, partial names, and incidental mentions select no skill. [Agent protocols](agent-protocols.md#codex-app-server) owns native attachment and catalog freshness.

The prompt text field marks a complete slash-form Codex skill or a highlighted Claude command without replacing its native control. Pointer drags and modified clicks select through the mark without opening details. A click or keyboard press opens a read-only detail popover. The popover follows a visible mark when text scrolls or the session list moves. A hovered or pinned popover hides while its mark is clipped and returns when the mark comes back. A pinned popover keeps the same logical token across edits. It closes when that token disappears. The popover shows the catalog description. It also shows the definition path when the Codex catalog supplies one or Arc finds the Claude skill's file on disk, and shows no path line and no blank space in its place when neither does. Closing the popover returns focus without changing the prompt, selection, or editing history. Removing the focused mark returns focus to the prompt text field.

`composerview.ts` owns prompt-entry wording and completion text. Browser-safe token detection and matching live under `domain/`, where the Prompt box and host import the same rules. The next keypress acts on the text currently in the prompt text field without waiting for a host response.

## Local path completion

The Prompt box completes a path at a collapsed caret that ends a path token. A token can start with `~/`, `./`, `../`, `/`, a Windows drive, a UNC root, or contain a separator. Matching quotes keep spaces in one token. The Prompt box preserves the root, quotes, and separator style.

The provider uses the selected session's recorded working directory. A new session uses the directory frozen in its draft. The webview never supplies a directory. The provider reads one named parent directory and returns no row when it cannot read that directory.

The shared completion list gives a matching prompt entry priority. Otherwise it shows matching files and directories. Directories appear first and add the typed separator. Hidden entries appear only after the unfinished name starts with a period.

The Prompt box keeps focus in the prompt text field. Arrow keys move the active row. Tab accepts a path row. Enter keeps its send behavior. Escape closes path completion until the token changes. A pointer press accepts its row without moving focus.

The prompt text field exposes the active row through `aria-activedescendant`. Each row states whether it names a file or directory. A path completion writes one undo step, updates the draft, grows the field, and ends a prompt-history walk.

The browser delays a request and rejects a result when its session, token, caret, or request identifier changed. A late reply never changes the draft.

The menu is a listbox controlled by the prompt text field. Focus stays in the prompt text field, the active option is exposed through `aria-activedescendant`, and pointer presses do not steal focus. Completion ends the command name, so the following Enter sends.

Background prompt box refreshes preserve the reader's scroll position in an open command menu. Typing, moving the caret, and changing the active option still bring that option into view.
