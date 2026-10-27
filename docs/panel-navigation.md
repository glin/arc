# Panel navigation

Use this guide when changing navigation history, destination opening, native menus, or response links. [Panel accessibility](panel-accessibility.md) owns keyboard and screen-reader behavior.

## Back and forward

A history place is a session, without a search query. Content search uses the timeline rather than a separate view.

The provider shares history across panel tabs, but each panel keeps its own visible session. Back and Forward move only the invoking panel. A window reload starts history at the restored session. Record destinations after `pickShowing` resolves selection. History navigation follows selection's draft-abandonment rules.

`domain/places.ts` owns trail pruning and provisional-ID replacement.

Mouse buttons four and five, the editor's Go Back and Go Forward chords, and the Arc tab toolbar use the panel trail first. At a boundary, Back delegates to the editor's Go Back and Forward delegates to Go Forward. Either command does nothing when the editor also reaches its boundary.

The webview cancels both mouse press and release events because workbench listeners do not receive them. Honor `workbench.editor.mouseBackForwardToNavigate`. Navigation presses also close open menus and pinned floats.

## Files, commits, and editor groups

### File destinations

Display paths use forward slashes. Actions send the recorded path. File rows open through the extension, and diff rows use read-only URI providers in `uris.ts`.

Normal opening prefers the active text-editor group outside the panel, then the leftmost visible text-editor group outside it. With neither, it reuses the panel group, or group one without a panel. Explicit split actions request another group. Whole-turn diff split actions reuse their previous group while it remains open and differs from the panel.

`openLink` in `panelhost.ts` owns local response-link routing. `linkTargetIsHtml`, `linkTargetIsMarkdown`, and `linkTargetIsVideo` in `transcript.ts` own extension matching.

Video extensions match regardless of case on Windows, macOS, and Linux. Video opening needs a default application and uses no editor group. Successful opening does not establish playback or codec support. Integrated-browser placement follows `workbench.browser.newTabPlacement`, and VS Code applies workspace trust to local HTML. HTTP and HTTPS links open in the configured external browser.

Clicked local links can leave workspace folders. Absolute paths need no open folder. Relative paths try open folders in order, including `..`, and have no base in a folderless window. Ordinary Markdown links separate heading fragments from file paths and pass the heading to Markdown Preview. Percent-encoded headings decode once. Malformed escapes remain unchanged. Copy Path excludes the heading. Literal file citations retain hash suffixes as part of the filename. `#L42-L51` and `:42` select text-file lines. `:42:7` ignores the column. Other URI schemes become filesystem paths and never execute as schemes.

### Opening failures

Only `FileNotFound` establishes absence. Other file-check errors and Explorer, picture, default-application, or text-editor failures retain the target and error. Relative paths continue through later workspace folders. A successful candidate ends opening without a failure notice. Exhausted candidates report the first access or opening failure before absence. HTML and Markdown failures stop with their dedicated notice and never open raw text.

### Commit destinations

A commit hash becomes a button only with a known repository directory. An unresolved repository leaves text. Opening uses the repository that [Recorded command and commit contracts](turn-cards.md#recorded-command-and-commit-contracts) describes. An unavailable command or missing commit produces an information message. Commits outside the workspace name their repository.

Commit rows retain their recorded branch or detached HEAD. Equal subjects and statistics do not identify the same commit. `CommitRow` and `commitRowTitle` in `webview/card-rows.ts` own row content and hovers.

`icontheme.ts` resolves theme icons. `fileicons.ts` supplies fallback text badges. Icons remain decorative, and file-row text supplies accessible names.

## Context menus and copy

Keyboard copy of selected timeline text runs in the panel before VS Code restores its last focused control. The browser supplies native clipboard formats. Editable controls and empty selections retain native command routing. A refused panel copy also retains native command routing.

### Native context and menu order

Menu enablement reads the invoking turn card, session heading, session list row, file link, or summary link's context. Editor selection elsewhere supplies no target. Route commands to the panel that opened the menu.

Session menus order their groups as follows:

1. Pin, read, and archive toggles.
2. Expand every shown turn and Collapse every shown turn, on headings only.
3. Rename and Edit labels, with trailing ellipses.
4. New session with the same labels.
5. Copy session ID and Show session details.
6. Export session as HTML, on saved headings only, with a trailing ellipsis.

Use short verb phrases without “this session”. Put the most-used entry first within a group.

Offer only the applicable toggle direction. Heading `sessionRead` uses explicit words and stays absent when nothing is markable. Session list sections determine their read entries. Plain `arcRail` rows offer neither read direction. Rename requires `sessionPersisted`. Bulk turn entries require a shown turn with a body that their direction changes. Opening turns marks them read. Each panel owns its own open turns.

Read, pin, and archive actions update shared extension state and the affected surfaces together. Every menu action needs a keyboard route.

### New sessions from existing work

Ordinary turn and response summary file links offer Send to a new session with the same labels before Send to a new session. Selected response text offers the same entries. Both create editable drafts, retain source-turn navigation, and inherit the source setup and recorded working directory. Only the first snapshots every source label from extension state. Without selected text, a line offers neither selected-text action.

Turn cards, compaction cards, headings, and session list cards offer New session with the same labels, even without source labels. It needs no selection. Selection hides it only on finished turn cards while Send entries apply. Changed-file rows and rendered links retain their own menus.

This action creates an empty draft with the source setup, recorded directory, and all source labels. A draft source supplies its own directory. The new draft has no source turn and names the source session as its reader-started parent. A missing directory or current setup creates nothing and shows a message.

During `/clear`, resolve the source through the invoking panel. Copy that panel's successor until its render is painted. Turn-card right-clicks must arm the same host ownership as heading right-clicks.

### Link menus and copy paths

Named session links suppress inherited turn, selection, comment, and copy actions. Compaction links retain Copy Path without source identity. HTTP and HTTPS links keep the browser menu outside Markdown tables. Inside tables, Arc supplies Copy Link.

Copy-path actions use one extension-prepared spelling. Ordinary Markdown links receive native Copy Path context without target resolution or a workspace-containment check. [Literal citations](#response-link-and-citation-contracts) keep separate native actions.

### Session details

Headings open the same native menu through right-click, `Shift+F10`, or the always-visible three-dots button. Session list cards use right-click or `Shift+F10`. The button supplies a route for Mac readers without that chord.

Show session details resolves its named session from every session the panel knows, including sessions outside the timeline. The dialog preserves copy actions during redraws, returns focus to its opener, and closes safely when its session leaves.

## Hosting the panel

The Arc tab is an editor tab backed by a webview panel. Shared extension state lets another or restored tab open the same session. Obsolete restored options require a replacement in the same column.

Hosting changes require checks of new and restored tabs in the [isolated editor](isolated-editor.md#isolated-extension-host). Browser tests check requested groups but cannot read options stored for an existing tab.

## Response link and citation contracts

### Literal file citations

File citations carry typed literal destinations through response links and native copy actions. Reader presses open native absolute files, including files outside workspace folders. Preserve percent signs and location-like filename suffixes. Ordinary Markdown links retain path candidates and optional line selection.

`domain/file-citation.ts` gives directive scanning one shared allowance of four code units per source code unit across candidates and quotation modes. `richtext.ts` consumes Markdown protection in source order before masking eligible directives. Preserve literal code, links, images, definitions, tags, and comments. Malformed or incomplete enclosing candidates keep nested citations literal. Container traversal lies outside the scanner allowance.

Masked interiors must precede table splitting and emphasis matching. Marked's exposed breaks grammar supplies mask boundaries without changing URL or email rules. Nonactionable masks restore escaped original source. Export renders full citation paths without local actions. Transcript text stays unchanged.

### Named session links

`arc-session:` links navigate inside the invoking panel. Resolve against the current scoped authoritative catalog and hosted pending starts. Provider collisions refuse navigation. Missing catalog publication reports loading unless a unique scoped pending start resolves.

Successful navigation releases only the invoking panel's clear redirect for the destination. Invalid links preserve selection and redirects. Pending starts stay hosted until the current scoped catalog admits their provider and raw session ID. Exports retain inert labels.

Collapsed headlines explicitly enable session anchors. Ordinary headline links and disclosure headings retain link text alone. Headline extraction preserves literal code-block examples inside lists and blockquotes. Headline HTML uses response enhancement for navigation and native context masking.
