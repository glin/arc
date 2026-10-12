# UI design

This guide helps UI contributors extend Arc without inventing a separate visual language. Use it when choosing a treatment, component, or review method.

## Character and hierarchy

Arc belongs beside the editor: compact controls, quiet surfaces, inherited typography, and restrained borders. Its cards support the reading jobs in [Design goals](design-goals.md), rather than copying a native tree view.

Choose emphasis by the region's job. The session list directs attention across sessions. The timeline presents the agent's claim beside the record. The prompt box supports the reader's next action. Cost, context, and usage remain first-class information. A figure earns its place through a useful action or a useful glance.

Use spacing, alignment, and existing text roles before adding another enclosure or accent. Preserve meaningful names and complete figures at narrow widths. A new priority order that hides information is a design decision, not a styling cleanup.

## Theme, type, and surfaces

[panel.css](../extension/src/webview/panel.css) owns exact colors, dimensions, and text roles. Reuse its semantic variables and component rules. Inherit VS Code typography and use editor theme tokens for new surfaces, controls, focus, and selection.

Do not introduce another palette. Derive a new tint from the theme's foreground or focus color, as `--chipbg` does. Existing status tones include explicit dark and light values. Those values limit palette inheritance and do not establish permission for unrelated literal colors.

Target at least 4.5:1 for text against every ground it occupies. Do not color both a figure's text and its tinted ground from the same tone. Use theme foreground for one side of that pair.

Use tabular numbers and right alignment for comparable numerical figures. Never ellipsize a figure. Give its label the available space without losing the value.

Follow the [project UI rules](../CLAUDE.md#ui-work) for text ownership, relative sizing, and shared treatments. Apply scaling at the element that owns the text, rather than compensating through surrounding wrappers. Read the corresponding production markup before reusing a CSS class.

## Choose the pattern by its job

| Reader job | Pattern and production reference |
| --- | --- |
| Run an action | Use the existing button treatment for that region. See [composer.ts](../extension/src/webview/composer.ts). |
| Open or close a section | Use that region's disclosure. See the section rendering in [card.ts](../extension/src/webview/card.ts). |
| Read a figure, with detail when available | Use `StatChip` for turn-card chips and session-heading figures. Use `StaticStatChip` for session list figures and inline figures in record rows. Both live in [stat-chip.ts](../extension/src/webview/stat-chip.ts). |
| Inspect detail near its source | Use [stat-detail.ts](../extension/src/webview/stat-detail.ts). Preserve its distinction between read-only detail and actionable content. |
| Filter or select a view | Follow the session list patterns in [rail.ts](../extension/src/webview/rail.ts) and [Session list and navigation](rail-and-navigation.md). |
| Change related settings | Follow the grouped controls in [layout-dialog.ts](../extension/src/webview/layout-dialog.ts). |

Links serve navigation. Compact in context detail uses `cpick`, without link colors or underlines.

A shared rounded treatment does not imply a shared action. A read-only session list figure must not acquire an independent press target inside its row's button. A figure with available detail must retain its keyboard behavior and accessible state. [Session list and navigation](rail-and-navigation.md#keyboard-and-screen-reader-contract) owns those contracts.

Use recognizable icons for common actions. Familiar examples include an X for Close, a magnifying glass for Search, and a gear for settings. Use words when no familiar icon clearly communicates the action. Keep words for choices that need their own names, such as periods and settings values. Give icon buttons accessible names and panel hints through the [keyboard and screen-reader contract](rail-and-navigation.md#keyboard-and-screen-reader-contract). Hide decorative icon content from the accessible name.

Use carets consistently within their region: the prompt box's downward caret opens a menu, while the session list's twisting caret folds a group. Do not add a caret as decoration.

## Transient popovers

Dismiss a transient popover on Escape, an outside press, or its expanded trigger. Dismiss it when focus moves outside the popover and its trigger. Escape and trigger dismissal return focus to the visible trigger. When no trigger exists, focus an existing surrounding control. Outside presses and focus departure leave focus on the reader's destination. Tab and Shift+Tab leave at the popover's boundaries without trapping focus. Ignore a null focus destination when the window loses focus. Keep internal focus movement, selection, and updates from dismissing the popover.

Focus the selected available control on opening. Otherwise, focus another usable control or the named dialog with `tabindex="-1"`. Preserve the focused element through updates. If an update removes it, focus a remaining control or the dialog. Move focus only while the popover still owns it.

Omit a redundant Close button when these dismissal routes suffice. When an explicit Close action is necessary, use a recognizable X icon with an accessible name.

## State and language

Use [Glossary](glossary.md) terms for regions, actions, records, and states. [Session list and navigation](rail-and-navigation.md#context-menus-and-copy) owns menu ordering and copy. The [project UI rules](../CLAUDE.md#ui-work) own hints, timestamps, compound text, and platform labels.

Keep focus, selection, unread state, and agent state distinguishable. A color alone must not communicate a new state or action. Preserve the visible text or other recognizable cue, together with its accessible name and state. Follow [Session list and navigation](rail-and-navigation.md#keyboard-and-screen-reader-contract) for keyboard reachability and focus behavior.

## Review and enforcement

For implementation, follow [Development](development.md#fast-iteration) and its build and screenshot workflow. For a proposal or panel review, use [panel-mockup](../.claude/skills/panel-mockup/SKILL.md), including its production markup and data cases.

Compare the changed component with its rendered peers at wide and narrow widths. Inspect both default themes. For color changes, also inspect dark and light high-contrast themes and a representative installed custom theme. The [isolated editor](development.md#isolated-extension-host) offers only the built-in themes, so the owner checks the custom theme in their own window. Do not treat a missing theme check as a pass.

The [screenshot driver](../extension/scripts/panel-shots.ts) clears focus and marks cards read. Check focus and unread states separately when a change affects them. Static captures do not establish keyboard or screen-reader behavior.

The [tone-sheet generator](../.claude/skills/panel-mockup/tone-sheet.ts) and contrast tests share [tones.ts](../extension/src/tones.ts). Their agreement is not independent evidence. The contrast test in [panel.webview.test.ts](../extension/src/panel.webview.test.ts) models default themes and names known failures. `EXCLUDED_TONES` in `tones.ts` defines additional exclusions. Neither establishes contrast across every theme or rendered state.

Shared components and CSS enforce repeated treatments. Visual review checks appearance. Follow the [test rules](../CLAUDE.md#tests) for automated guards. Do not add browser tests that freeze spacing, color, font, width, or wording.

Name the reader need when proposing an exception. Do not turn a known implementation deviation into a design rule. An approved mockup carries the fidelity and approval requirements in the mockup workflow.
