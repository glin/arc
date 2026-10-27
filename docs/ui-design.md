# UI design

## Character and hierarchy

Use compact controls, quiet surfaces, inherited typography, and restrained borders. Cards serve the reading jobs in [Design goals](design-goals.md), without copying a native tree view.

The session list directs attention across sessions. The timeline presents the agent's claim beside the record. The prompt box supports the reader's next action. Keep cost, context, and usage prominent. Each figure must support an action or a useful glance.

Use spacing, alignment, and existing text roles before adding enclosures or accents. Preserve meaningful names and complete figures at narrow widths. Treat priority changes that hide information as design decisions.

## Theme, type, and surfaces

[panel.css](../extension/src/webview/panel.css) owns exact colors, dimensions, and text roles. Reuse its semantic variables and component rules. Inherit VS Code typography and use editor theme tokens for new surfaces, controls, focus, and selection.

Do not introduce another palette. Derive a new tint from the theme's foreground or focus color, as `--chipbg` does. Explicit dark and light status tones limit palette inheritance. They permit no unrelated literal colors.

Target at least 4.5:1 for text against every ground it occupies. Do not color both a figure's text and its tinted ground from the same tone. Use theme foreground for one side of that pair.

Use tabular numbers and right alignment for comparable figures. Never ellipsize a figure or let its label displace its value.

## Figures and breakdowns

A reader skims a breakdown before reading it. Each figure must be findable at a glance, without reading a sentence.

- Write a fact line as short fragments separated by middle dots, as in `728 requests · 98% cached input · 120k average input`. Do not join facts into a clause with commas.
- Keep two figures apart. When a line holds two figures, lead with the one the reader acts on and set the other in a quieter text role or its own column.
- Lay out repeated rows as a table. Each field of a row, such as name, count, cost, bar, and share, sits in its own column, so the field aligns from row to row. Give a count its own column with space between it and the name.
- Keep each row's fields close together. In a wide popover, the eye must not travel from a label at the left edge to its figures at the right edge. Cap the width of the row's columns instead of stretching them across the surface.
- Show the hierarchy. A section heading uses a stronger text role than its rows. A divider or spacing separates sections that describe different subjects.
- Place a fact line inside the section it describes. A line under a shared chart reads as a fact about every part of that chart.
- Omit a chart that has one part. A split bar at 100 percent shows nothing.

Follow the [project UI rules](../extension/CLAUDE.md#ui-work) for text ownership, relative sizing, and shared treatments. Read production markup before reusing a CSS class.

## Choose the pattern by its job

| Reader job | Pattern and production reference |
| --- | --- |
| Run an action | Use the existing button treatment for that region. See [composer.ts](../extension/src/webview/composer.ts). |
| Open or close a section | Use that region's disclosure. See the section rendering in [card.ts](../extension/src/webview/card.ts). |
| Read a figure, with detail when available | Use `StatChip` for turn-card chips and session-heading figures. Use `StaticStatChip` for session list figures and inline figures in record rows. Both live in [stat-chip.ts](../extension/src/webview/stat-chip.ts). |
| Inspect detail near its source | Use [stat-detail.ts](../extension/src/webview/stat-detail.ts). Preserve its distinction between read-only detail and actionable content. |
| Filter or select a view | Follow the session list patterns in [rail.ts](../extension/src/webview/rail.ts) and [Session list and navigation](rail-and-navigation.md). |
| Change related settings | Follow the grouped controls in [layout-dialog.ts](../extension/src/webview/layout-dialog.ts). |

Links serve navigation.

A read-only session list figure must not acquire an independent press target inside its row's button. A figure with available detail must retain its keyboard behavior and accessible state. [Session list and navigation](panel-accessibility.md#keyboard-and-screen-reader-contract) owns those contracts.

Use recognizable icons for common actions: X for Close, a magnifying glass for Search, and a gear for settings. Use words for unfamiliar actions and named choices, including periods and settings values. Give icon buttons accessible names and panel hints through the [keyboard and screen-reader contract](panel-accessibility.md#keyboard-and-screen-reader-contract). Hide decorative icon content from the accessible name.

The prompt box's downward caret opens a menu. The session list's twisting caret folds a group. Do not add a caret as decoration.

## Transient popovers

Dismiss a transient popover on Escape, an outside press, or its expanded trigger. Dismiss it when focus moves outside the popover and its trigger. Escape and trigger dismissal return focus to the visible trigger. When no trigger exists, focus an existing surrounding control. Outside presses and focus departure leave focus on the reader's destination. Tab and Shift+Tab leave at the popover's boundaries without trapping focus. Ignore a null focus destination when the window loses focus. Keep internal focus movement, selection, and updates from dismissing the popover.

Focus the selected available control on opening. Otherwise, focus another usable control or the named dialog with `tabindex="-1"`. Preserve the focused element through updates. If an update removes it, focus a remaining control or the dialog. Move focus only while the popover still owns it.

Omit a redundant Close button when these dismissal routes suffice. When an explicit Close action is necessary, use a recognizable X icon with an accessible name.

## State and language

Use [Glossary](glossary.md) terms for regions, actions, records, and states. [Panel navigation](panel-navigation.md#context-menus-and-copy) owns menu ordering and copy. The [project UI rules](../extension/CLAUDE.md#ui-work) own hints, timestamps, compound text, and platform labels.

Distinguish focus, selection, unread state, and agent state. Pair color with visible text or another recognizable cue, plus its accessible name and state. Follow [Session list and navigation](panel-accessibility.md#keyboard-and-screen-reader-contract) for keyboard reachability and focus behavior.

## Review and enforcement

For implementation, follow [Development](development.md#fast-iteration) and its build and screenshot workflow. For a proposal or panel review, use [panel-mockup](../.claude/skills/panel-mockup/SKILL.md), including its production markup and data cases.

Compare the changed component with its rendered peers at wide and narrow widths in both default themes. For color changes, include dark and light high-contrast themes and a representative installed custom theme. The [isolated editor](isolated-editor.md#isolated-extension-host) offers only the built-in themes, so the owner checks the custom theme in their own window. Do not treat a missing theme check as a pass.

The [screenshot driver](../extension/scripts/panel-shots.ts) clears focus and marks cards read. Check focus and unread states separately when a change affects them. Static captures do not establish keyboard or screen-reader behavior.

The [tone-sheet generator](../.claude/skills/panel-mockup/tone-sheet.ts) and contrast tests share [tones.ts](../extension/src/tones.ts), so their agreement is not independent evidence. The contrast test in [panel.webview.test.ts](../extension/src/panel.webview.test.ts) models default themes and names known failures. `EXCLUDED_TONES` in `tones.ts` defines additional exclusions. Neither establishes contrast across every theme or rendered state.

Follow the [test rules](../CLAUDE.md#tests) and [browser test limits](../extension/CLAUDE.md#browser-tests) for automated guards.

Name the reader need when proposing an exception. Do not turn a known implementation deviation into a design rule. An approved mockup carries the fidelity and approval requirements in the mockup workflow.
