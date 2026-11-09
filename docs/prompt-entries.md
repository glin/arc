# Prompt entries and path completion

[`webview/composer.ts`](../extension/src/webview/composer.ts) owns completion and inline inspection. [Local controls](prompt-delivery.md#local-controls) owns commands intercepted before delivery.

## Opening recorded skills

[`panelhost.ts`](../extension/src/panelhost.ts)'s `openSkill` accepts only paths published in that card's recorded skill list and still naming regular files. This check is separate from card file opening.

## Prompt entries

Claude commands lack ownership metadata. Classify them with the working directory's latest skill-name list, persisted across reloads. A session under a read-only launch policy never changes that list. Its narrowed list would hide the reader's skills from ordinary sessions. Before the first list, all commands receive skill highlighting except panel controls, `/compact`, `/model`, `/remote-control`, and `/rc`.

[`composerview.ts`](../extension/src/composerview.ts)'s `availableCommands` adds `/remote-control` and `/rc` because Claude's published catalog omits them. [`claudeskillpath.ts`](../extension/src/claudeskillpath.ts) resolves missing definition paths, with project skills before the reader's Claude skills folder.

[`composerview.ts`](../extension/src/composerview.ts)'s `sessionCommands` adds a local `/fast` row to one Codex session when the next turn's model offers Fast, when the session's accepted selection is Fast, or when no selection exists and a qualified Codex reading reports Fast. A model without a reported speed list otherwise gets no row, and a speed that an earlier turn returned does not count. A native skill named `fast` keeps its `$fast` form, and the bare `/fast` spelling is the [local control](prompt-delivery.md#local-controls).

[`commandcatalog.ts`](../extension/src/commandcatalog.ts) scopes ordinary catalogs, revisions, active discovery, and retry budgets to the agent, resolved executable configuration, and working directory. The prompt box selects its host-owned working directory. Optional entries remain bound to one child generation and immutable release. Idle or sibling children supply no optional entry to another session. Provisional drafts use their retained child.

Codex built-in commands remain available before discovery answers or after it fails. Successful ordinary catalogs survive failed refreshes. Local and built-in slash commands take precedence over matching skill names. Those skills retain dollar-prefixed completion.

Discovery publishes ordinary commands before account usage or models answer. A failed disposable child receives one automatic retry, one second after its confirmed exit. Two failed attempts exhaust that scope's automatic cycle. The existing explicit refresh starts another cycle for the selected draft or session directory. A pending account read does not block this refresh. Cancellation, scope replacement, and closing the panel cancel unsent retries. A later request can restart a cancelled cycle after the aborted child exits. Successful same-scope live catalogs from unrestricted children satisfy discovery. At most two disposable command discovery children run concurrently across scopes.

Only complete leading Codex skill invocations select native skills. Unknown, disabled, ambiguous, or removed skills remain text. Quoted examples, escaped tokens, fences, URLs, partial names, and incidental mentions select nothing. [Native attachment and freshness](native-skills.md#codex-skill-attachment) owns delivery.

Skill marks must retain the native text field so inspection preserves selection and undo history. Host and browser share token and matching rules under [`domain/composer-editing.ts`](../extension/src/domain/composer-editing.ts). Keypresses use live text without waiting for host replies.

## Local path completion

[`pathcompletion.ts`](../extension/src/pathcompletion.ts) owns path resolution, matching, and directory reads. [`webview/composer.ts`](../extension/src/webview/composer.ts) owns acceptance and menu keys.

The host chooses the recorded working directory or the directory frozen in a draft. The browser never supplies it. Preserve roots, quotes, and separator style, including Windows drives and UNC roots.

Debounced replies must match session, token, caret, and request identity. Obsolete replies never change the draft. Matching prompt entries take priority. Tab accepts paths, while Enter retains Send.
