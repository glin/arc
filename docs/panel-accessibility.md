# Panel accessibility

Read the section for the control you change. Session list controls and timeline controls use separate keyboard models.

## Keyboard and screen-reader contract

Every visible action must be keyboard reachable. Its accessible name must include its visible information. Use native controls where the layout permits. Inline prompt box skill marks use spans with the button role so they wrap with text. Disclosure controls carry `aria-expanded` and name what they open. Visible focus and words carry meaning independently of glyphs and color.

The Timeline landmark contains labelled session sections. Turn articles and compaction sections use their card heading as the accessible name. Turn body sections use visible subheadings. A session heading wraps buttons without becoming a control itself.

## Keyboard model

### Session list focus

The Sessions navigation landmark retains an accessible heading when the visible title does not fit. Groups have native headings and labelled lists. Each mounted session occurrence has one list item. Disclosure headings report total matches. Their `aria-controls` names the list only while it exists. Folded and empty groups omit that relation. Show more follows the list as a separate button. Its accessible name includes the section. [Header and scrolling](rail-and-navigation.md#header-and-scrolling) owns placement and scrolling.

Session selectors, sibling actions, disclosures, saved-view menus, and Show more retain native Tab stops. Up and Down move between disclosures, selectors, and Show more. Home and End reach their boundaries. Arrows from a sibling action start at its selector. Movement never selects a session. Modified, prevented, composing, and editable-field keys retain their behavior.

Shift+Tab from the first timeline stop reaches the separator, then the last session list control. Home returns to the first local navigation control. Shift+Tab then crosses header controls to Search. Native Tab reaches matching selectors and their actions. Enter or Space activates a focused native button.

Every displayed occurrence of the selected session carries `aria-current="true"`. Both densities retain the complete accessible name and full local activity timestamp. Figures and labels remain read-only. Clock updates do not announce changes.

Reconciliation preserves focus by session identity, group occurrence, and action. Removed occurrences fall back to a surviving occurrence, their disclosure, a nearby selector, then a visible header control. Folding a focused group returns focus to its disclosure. Show more retains focus while rows remain undrawn. Its final press focuses the last newly drawn selector. Either target scrolls into view after expansion. Unrelated updates preserve focus. Hiding the session list transfers focus from its controls or separator to compact navigation or the session view.

Session list cards accept `l`, `p`, and Delete for their own session. macOS also accepts Backspace and names only Backspace in the hint. Windows and Linux name Delete. Archived cards reject these keys.

### Session list width

The focusable vertical separator controls width. Left and Right change it by 10 CSS pixels. Home selects 160 pixels. End selects the viewport width minus the rendered separator width, floored and bounded below by 160 pixels. Its accessible range and value use those bounds. Keyboard changes save immediately. Pointer changes save on release or cancellation. A smaller viewport caps drawn width without replacing the saved preference. Available space restores it. A deliberate resize updates it.

### Timeline navigation

The timeline has one independent roving Tab stop. Controls outside its navigation scope keep ordinary Tab stops. The navigation owner marks matching controls with `data-roving`, caches its walk until page changes, and disconnects its observer on disposal.

Draw width-dependent actions as controls only where they work. Session heading labels are buttons while the session list fits. At narrower widths they are spans with native titles. Button labels use panel hints. The roving selector names the button tag so read-only labels never enter its walk. Session list labels stay inside their selector button and cannot contain buttons. Responsive replacement transfers focus and the navigation stop.

The session heading contains sibling name, pin, menu, and layout buttons in that order. The name button contains only the title. Its press pins the selectable full name open and exposes `aria-pressed`. The other buttons follow it in the roving walk. An `.sr-only` span supplies the full local activity time.

Tab enters a pinned name's first Tab stop. Down enters its first action. Without Tab stops, either key enters the box only when its content overflows. Arrow, Page, Home, and End keys then scroll it. Escape, another name press, or an outside press closes it. Escape returns focus to the heading. Removing a focused worktree link keeps focus inside the popover.

Local heading changes preserve the keyboard stop. Normalize the shared walk only when controls or their stop change. Removing a focused pin chooses a surviving heading control. Removing a focused label chooses that heading's Labels action. Full draws own final normalization.

Open popovers must rebuild only for their own content changes. Replacing a focused native control closes its option list even if focus returns. Activity command disclosures follow step identity when grouping changes. If retention removes the focused log row, the log restores focus locally while the card survives.

The Activity word controls disclosure. Message counts filter, and tool-category counts open raw-tool details. These controls keep ordinary Tab stops. Run and command controls share a separate roving stop inside the log. Shift+press on the Activity word changes every visible message together. Its hint describes that action through `aria-describedby` while focused. The bulk action returns focus to the word.

### Hints

Pressable controls use panel hints when they need information beyond visible text. Read-only text and rows inside open popovers use native titles. A hint gives the action and optional key, followed by its effect when available. Only an available detail receives `aria-describedby`. Session-specific controls include the session title in their accessible names.

Plain pointer hints wait 300 ms. Compact card hints wait 500 ms on Windows and Linux, or 1500 ms on macOS. Moving between open plain hints opens the next immediately. Entering a compact card closes any open hint, including a keyboard hint, and waits its full delay. Keyboard focus opens hints immediately. Pointer leave, focus leave, Escape, a press, session list scrolling, resizing, or control removal closes them.

The session name hint gives the full name, then the full local activity time when available. Another registered starting checkout adds `Started in`. Its hover shows plain worktree text. Its pinned name links the worktree and shows the complete selectable destination. The default checkout, ordinary subfolders, and unknown opening identities add no line. Name hints retain closing parentheses and break paths after internal slashes or backslashes. Their regular-weight name stops at eight lines.

Turn head hints give the plain action, status, then describe Shift+click or Shift+Enter for every shown turn. Shift+Space performs that same action.

### Label editor

The label popover owns navigation outside the session list and timeline scopes. Arrows move between the find box, its clear button, the create row, and checkboxes. Home and End reach the boundaries outside the find box. Inside the box, they retain native caret movement. Clearing text returns focus to the box. Space and Enter toggle a focused checkbox. Enter in the box applies an exact existing label or takes the create offer.

Plain Tab with matching text applies the first visible unapplied existing label, clears the box, and retains focus. That row displays a Tab key before its count. The box describes the key for screen readers. Empty text or no matching unapplied label retains native Tab movement and displays no row key. Escape closes the editor and returns focus to its opener.

Keep the native find box mounted and uncontrolled during reconciliation. Its caret, undo history, and input-method composition survive row changes. Only explicit resets clear it.

### New session menu

The New session menu is a dialog of native buttons. Both triggers expose `aria-haspopup`. Pinned and recent setups share one independent Tab stop. Each row contains sibling apply, Edit, and pin buttons. Tab enters from Same setup as current and leaves for Agent.

Up and Down wrap between rows, retaining button kind or falling back to the pin. Home and End reach boundary rows. Left and Right stay within a row. Unavailable pinned setups disable apply. Refreshes move a disabled stop to its pin. Removed rows use the same button in the next surviving row, then the previous row. Focus never remains disabled.

Opening focuses Same setup as current, then the list stop, then Agent. Edit and custom openings focus Agent. A confirmed pin moves focus to the new pinned row's pin. A confirmed unpin selects the next pin, then the previous pin. Before confirmation, focus stays on the pressed pin or its nearest surviving neighbor. Leaving that pin cancels pending focus movement. The field pin retains focus and follows refreshed pressed state. A hint on Edit or a pin consumes the first Escape. The next closes the menu.

Agent, Model, Effort, and Permissions use shared select-only comboboxes. Each field retains DOM focus and one Tab stop. Arrows open options and move tentative selection without wrapping. Home and End reach boundaries. Page Up and Page Down move ten choices. Printable keys search names. Enter, Space, Alt+Up, Tab, or leaving accepts. Tab retains native movement. Escape or pressing the expanded trigger cancels. Hover never selects. Pressing an option accepts it. Disabling the focused field transfers focus forward to an enabled visible control, then backward if none follows.

### Agent request focus

The question tab strip stays outside the timeline walk. Tabs and the fold precede request actions. Focus movement after resolution excludes both. [Agent requests](agent-requests.md) owns question tabs and announcements. [Text editing](composer.md#text-editing) owns prompt recall.
